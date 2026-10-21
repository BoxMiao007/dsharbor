/* 自绘下拉框：PickerChoice 与 Picker（圆角弹层、键盘可达） —— 自 main.ts 原样搬出（2026-10 模块化拆分），声明加 export，其余未改。 */

import { escapeHtml } from "./markup";

export interface PickerChoice {
  value: string;
  label: string;
  /** 行首的彩色圆点（渠道用），值同时是 CSS 类名后缀。 */
  dot?: string;
  /** 占位提示项（如「正在读取…」）：可见但点不动，键盘也会跳过。 */
  disabled?: boolean;
}

/**
 * 自绘下拉框：原生 `<select>` 的弹出列表由系统绘制，圆角与配色都管不到，
 * 所以选择器改成「按钮 + 列表」自绘（维护者要求弹层也是圆角）。
 * 只实现用得到的部分：单选、键盘上下移动 + 回车选中、Esc 关闭、点外面关闭。
 */
export class Picker {
  private readonly root: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly label: HTMLElement;
  private readonly list: HTMLUListElement;
  private choices: PickerChoice[] = [];
  private selected = "";
  private activeIndex = -1;
  private readonly onChange: (value: string) => void;
  private readonly onDocumentPointerDown: (event: PointerEvent) => void;

  constructor(rootId: string, onChange: (value: string) => void) {
    this.onChange = onChange;
    this.root = document.querySelector<HTMLElement>(`#${rootId}`) ?? (() => { throw new Error(`缺少元素 #${rootId}`); })();
    this.root.classList.add("picker");
    this.root.innerHTML = `<button type="button" class="picker-btn" aria-haspopup="listbox" aria-expanded="false"><span class="picker-label"></span><span class="picker-chev">▾</span></button><ul class="picker-list hidden" role="listbox"></ul>`;
    this.button = this.root.querySelector<HTMLButtonElement>(".picker-btn")!;
    this.label = this.root.querySelector<HTMLElement>(".picker-label")!;
    this.list = this.root.querySelector<HTMLUListElement>(".picker-list")!;
    this.button.addEventListener("click", () => (this.isOpen() ? this.close() : this.open()));
    this.button.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.onDocumentPointerDown = (event: PointerEvent): void => {
      if (this.isOpen() && !this.root.contains(event.target as Node)) {
        this.close();
      }
    };
    document.addEventListener("pointerdown", this.onDocumentPointerDown);
  }

  /**
   * 摘掉挂在 document 上的监听。界面只在启动时生成一次，正常路径用不到；
   * 留着是给「同一页里重建 DOM」的场景兜底（否则旧实例的监听会越积越多、一起关弹层）。
   */
  dispose(): void {
    document.removeEventListener("pointerdown", this.onDocumentPointerDown);
    this.close();
  }

  get value(): string {
    return this.selected;
  }

  /** 程序化赋值（不触发 onChange，避免与自动保存互相回环）。 */
  setValue(value: string): void {
    this.selected = value;
    this.renderLabel();
    this.renderOptions();
  }

  /** 重设候选列表；当前选中项不在新列表里时退回第一个可选项。 */
  setChoices(choices: PickerChoice[]): void {
    this.choices = choices.slice();
    if (!this.choices.some((choice) => choice.value === this.selected)) {
      this.selected = (this.choices.find((choice) => !choice.disabled) ?? this.choices[0])?.value ?? "";
    }
    this.renderLabel();
    this.renderOptions();
  }

  private isOpen(): boolean {
    return !this.list.classList.contains("hidden");
  }

  private renderLabel(): void {
    const current = this.choices.find((choice) => choice.value === this.selected);
    this.label.innerHTML = current
      ? `${Picker.dotHtml(current)}<span class="picker-label-text">${escapeHtml(current.label)}</span>`
      : "（未选择）";
  }

  /** 彩色圆点用 CSS 画：emoji 在 WebView2 里会变成黑白方块。 */
  private static dotHtml(choice: PickerChoice): string {
    return choice.dot ? `<span class="picker-dot picker-dot-${choice.dot}"></span>` : "";
  }

  private renderOptions(): void {
    this.list.innerHTML = this.choices
      .map((choice, index) => {
        const selected = choice.value === this.selected;
        return `<li class="picker-option${index === this.activeIndex ? " active" : ""}${choice.disabled ? " disabled" : ""}" role="option" data-index="${index}" aria-selected="${selected}" aria-disabled="${choice.disabled === true}"><span class="tick">${selected ? "✓" : ""}</span>${Picker.dotHtml(choice)}<span class="text">${escapeHtml(choice.label)}</span></li>`;
      })
      .join("");
    for (const option of Array.from(this.list.querySelectorAll<HTMLElement>(".picker-option"))) {
      option.addEventListener("click", () => {
        const index = Number.parseInt(option.dataset.index ?? "", 10);
        this.commit(index);
      });
    }
  }

  /** 从 index 往 step 方向找下一个可选项；全都不可选时回到原位。 */
  private stepFrom(index: number, step: number): number {
    for (let next = index + step; next >= 0 && next < this.choices.length; next += step) {
      if (!this.choices[next]?.disabled) {
        return next;
      }
    }
    return index;
  }

  private open(): void {
    // 打开时先不放蓝底：蓝色只属于「正要选中的那一项」，鼠标点开时不该有任何一行被标上。
    // 当前值靠行首的 ✓ 认，长列表滚到它那里去。
    this.activeIndex = -1;
    this.renderOptions();
    this.list.classList.remove("hidden");
    this.button.setAttribute("aria-expanded", "true");
    // 绝对定位的弹层会把文档净高撑大，页面跟着上下跳（维护者要求下拉框展开不得撑大界面）：
    // 下方空间不够就向上翻转，并把高度压到翻转方向能放下的范围里，保证弹层始终在视口内。
    // 界面改版后面板本身是滚动容器（.panel { overflow-y: auto }），会比视口先剪掉弹层，
    // 所以可用空间要跟裁剪祖先取交集，不能只看窗口高度。
    const rect = this.button.getBoundingClientRect();
    const bounds = this.clipBounds();
    const gap = 6;
    const below = bounds.bottom - rect.bottom - gap - 8;
    const above = rect.top - bounds.top - gap - 8;
    const wanted = Math.min(this.list.scrollHeight, 260);
    const flipUp = below < wanted && above > below;
    this.list.classList.toggle("up", flipUp);
    this.list.style.maxHeight = `${Math.max(120, Math.round(Math.min(wanted, flipUp ? above : below)))}px`;
    this.list.querySelector<HTMLElement>('.picker-option[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  /** 弹层能占的上下边界：视口，再与最近的滚动/隐藏祖先求交。 */
  private clipBounds(): { top: number; bottom: number } {
    let top = 0;
    let bottom = window.innerHeight;
    for (let node = this.root.parentElement; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.overflowY === "visible") {
        continue;
      }
      const box = node.getBoundingClientRect();
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
    return { top, bottom };
  }

  private close(): void {
    this.list.classList.add("hidden");
    this.button.setAttribute("aria-expanded", "false");
    this.activeIndex = -1;
  }

  private commit(index: number): void {
    const choice = this.choices[index];
    if (!choice || choice.disabled) {
      return;
    }
    const changed = choice.value !== this.selected;
    this.selected = choice.value;
    this.renderLabel();
    this.close();
    if (changed) {
      this.onChange(choice.value);
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!this.isOpen()) {
        this.open();
        // 键盘打开是有意要移动光标，这时才把蓝底落在当前值上。
        this.activeIndex = Math.max(0, this.choices.findIndex((choice) => choice.value === this.selected));
        this.renderOptions();
        this.list.querySelector<HTMLElement>(".picker-option.active")?.scrollIntoView({ block: "nearest" });
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.activeIndex = this.stepFrom(this.activeIndex, step);
      this.renderOptions();
      this.list.querySelector<HTMLElement>(".picker-option.active")?.scrollIntoView({ block: "nearest" });
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && this.isOpen()) {
      event.preventDefault();
      this.commit(this.activeIndex);
    }
  }
}
