/* 自绘下拉框：PickerChoice 与 Picker（圆角弹层、键盘可达） —— 自 main.ts 原样搬出（2026-10 模块化拆分），声明加 export，其余未改。 */

import { escapeHtml } from "./markup";
import { attachScrollThumb, type ScrollThumb } from "./scroll-thumb";

/** 行内小徽章：显示在选项文字右边（dist-tag / 已缓存 / 手动）。 */
export interface PickerBadge {
  text: string;
  /** 只决定配色，与语义绑死，不跟具体文案走（`other` 给自定义 tag 与「+N」用）。 */
  tone:
    | "latest"
    | "next"
    | "beta"
    | "alpha"
    | "canary"
    | "other"
    | "cached"
    | "manual";
  /**
   * 悬停气泡里摆出来的徽章：就是这一枚枚徽章本身，没有文字说明。
   * `data-tip` 只能塞纯文本、装不下徽章，所以这类气泡不走 `.has-tip` 的伪元素，
   * 改成 `.picker-tip` 真节点（见 Picker.badgeHtml）。
   */
  tip?: PickerTipBadge[];
}

/** 气泡里的一枚徽章：写完整标签名（行内那枚可能已截断），配色与行内一致。 */
export interface PickerTipBadge {
  text: string;
  tone: PickerBadge["tone"];
}

export interface PickerChoice {
  value: string;
  label: string;
  /** 行首的彩色圆点，值同时是 CSS 类名后缀。 */
  dot?: string;
  /** 占位提示项（如「正在读取…」）：可见但点不动，键盘也会跳过。 */
  disabled?: boolean;
  /** 行尾小徽章，按数组顺序排（调用方保证顺序固定，避免同一行两次渲染看起来不一样）。 */
  badges?: PickerBadge[];
  /**
   * 动作行（如列表末尾的「更多…」）：点一下执行这里的事，**不改选中值也不收起弹层**。
   * 「更多」要能被反复点，收起弹层就等于每次都得重新展开一遍。
   */
  action?: () => void;
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
  /** 列表藏了原生滚动条（style.css），滚动指示条开列表时懒挂：轨道挂在 root 上。 */
  private thumb: ScrollThumb | null = null;
  private choices: PickerChoice[] = [];
  private selected = "";
  private activeIndex = -1;
  private readonly onChange: (value: string) => void;
  private readonly onDocumentPointerDown: (event: PointerEvent) => void;
  /**
   * 每次展开弹层前调一次。版本下拉用它现扫一遍 npx 缓存，好把「已缓存」徽章
   * 挂到正确的行上；回调是异步的，扫完自己调 `relayout()` 让新徽章落到界面里。
   */
  onOpen: (() => void) | null = null;

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
      ? `${Picker.dotHtml(current)}<span class="picker-label-text">${escapeHtml(current.label)}</span>${Picker.badgesHtml(current, true)}`
      : "（未选择）";
  }

  /** 彩色圆点用 CSS 画：emoji 在 WebView2 里会变成黑白方块。 */
  private static dotHtml(choice: PickerChoice): string {
    return choice.dot ? `<span class="picker-dot picker-dot-${choice.dot}"></span>` : "";
  }

  /**
   * 行尾小徽章。`compact` 是收起状态（按钮里那一行），只留第一枚，免得框内挤成一团。
   * 调用方按「tag 徽章在前、已缓存 / 手动在后」排好序，所以收起态天然先显 tag，
   * 没有 tag 时才轮到「已缓存」「手动」。
   */
  private static badgesHtml(choice: PickerChoice, compact = false): string {
    const badges = choice.badges ?? [];
    const shown = compact ? badges.slice(0, 1) : badges;
    return shown.map((badge) => Picker.badgeHtml(badge, !compact)).join("");
  }

  /**
   * 一枚徽章；带 tip 的挂 `.picker-badge-tip` 与气泡节点。
   * `allowTip=false` 用于收起态（按钮里那一行）：`.picker-label` 是 `overflow: hidden`，
   * 气泡在那里会被裁掉边，索性不挂。
   */
  private static badgeHtml(badge: PickerBadge, allowTip = true): string {
    const chip = `<span class="picker-badge-text">${escapeHtml(badge.text)}</span>`;
    const tip = allowTip && badge.tip ? Picker.tipHtml(badge.tip) : "";
    const tipClass = tip ? " picker-badge-tip" : "";
    return `<span class="picker-badge picker-badge-${badge.tone}${tipClass}">${chip}${tip}</span>`;
  }

  /**
   * 气泡内容：只有徽章、没有文字。徽章写完整标签名、配色跟行内那几枚一致，
   * 所以「+N 里到底折叠了谁」「这枚被截断的徽章全名是什么」都能直接看出来。
   */
  private static tipHtml(tip: PickerTipBadge[]): string {
    const badges = tip
      .map((badge) => `<span class="picker-badge picker-badge-${badge.tone}">${escapeHtml(badge.text)}</span>`)
      .join("");
    return `<span class="picker-tip" role="tooltip">${badges}</span>`;
  }

  /**
   * 铺一遍候选。行数没变时**就地更新**已有的 `<li>`，不重建节点：
   * 「已缓存」徽章是异步扫回来的（`onOpen` → `refreshCachedVersions`），扫完要重铺一次，
   * 而整表重建会换掉用户正按着的那一行 —— 鼠标按下在旧节点、抬起时它已被移除，
   * 浏览器就不发 click 了，表现为「选版本要点两次」。就地更新保住了进行中的点击。
   */
  private renderOptions(): void {
    if (this.list.children.length === this.choices.length) {
      Array.from(this.list.children).forEach((node, index) => {
        this.paintRow(node as HTMLElement, this.choices[index]!, index);
      });
      return;
    }
    this.list.innerHTML = this.choices
      .map((_choice, index) => `<li data-index="${index}"></li>`)
      .join("");
    Array.from(this.list.children).forEach((node, index) => {
      const option = node as HTMLElement;
      this.paintRow(option, this.choices[index]!, index);
      option.addEventListener("click", () => {
        const target = Number.parseInt(option.dataset.index ?? "", 10);
        this.commit(target);
      });
    });
  }

  /**
   * 只改一行的属性与内容，且**连行内的节点也不替换**：
   * 鼠标可能正按在 `.text` 这个 `<span>` 上，换掉它同样会让 click 丢失
   * （按下和抬起不在同一个节点链上就不发 click）。所以 tick / 圆点 / 文字 / 徽章
   * 都就地改文本与 class，只有节点数量真的变了才增删。
   */
  private paintRow(option: HTMLElement, choice: PickerChoice, index: number): void {
    const selected = choice.value === this.selected;
    const isAction = choice.action !== undefined;
    const className = `picker-option${index === this.activeIndex ? " active" : ""}${choice.disabled ? " disabled" : ""}${isAction ? " is-action" : ""}`;
    if (option.className !== className) {
      option.className = className;
    }
    const ariaSelected = selected ? "true" : "false";
    if (option.getAttribute("aria-selected") !== ariaSelected) {
      option.setAttribute("aria-selected", ariaSelected);
    }
    const ariaDisabled = choice.disabled === true ? "true" : "false";
    if (option.getAttribute("aria-disabled") !== ariaDisabled) {
      option.setAttribute("aria-disabled", ariaDisabled);
    }
    option.setAttribute("role", "option");
    if (option.childElementCount === 0) {
      option.innerHTML =
        '<span class="tick"></span><span class="text"></span>';
    }
    const tick = option.querySelector<HTMLElement>(":scope > .tick");
    if (tick && tick.textContent !== (selected ? "✓" : "")) {
      tick.textContent = selected ? "✓" : "";
    }
    // 圆点（目前没有调用方在用，但 Picker 是通用组件，留着）按需增删。
    const wantedDot = choice.dot ? `picker-dot picker-dot-${choice.dot}` : null;
    const currentDot = option.querySelector<HTMLElement>(":scope > .picker-dot");
    if (wantedDot === null) {
      currentDot?.remove();
    } else if (!currentDot) {
      const dot = document.createElement("span");
      dot.className = wantedDot;
      option.insertBefore(dot, tick?.nextSibling ?? null);
    } else if (currentDot.className !== wantedDot) {
      currentDot.className = wantedDot;
    }
    const text = option.querySelector<HTMLElement>(":scope > .text");
    if (text && text.textContent !== choice.label) {
      text.textContent = choice.label;
    }
    // 徽章行尾才出现，指针一般不在上面，改它不会破坏进行中的点击。
    const badges = choice.badges ?? [];
    const badgeNodes = Array.from(option.querySelectorAll<HTMLElement>(":scope > .picker-badge"));
    while (badgeNodes.length > badges.length) {
      badgeNodes.pop()?.remove();
    }
    badges.forEach((badge, badgeIndex) => {
      let node = badgeNodes[badgeIndex];
      if (!node) {
        node = document.createElement("span");
        // 先建出文字层，后面的更新只改它，气泡节点才有位置可挂。
        node.innerHTML = '<span class="picker-badge-text"></span>';
        option.appendChild(node);
        badgeNodes.push(node);
      }
      const hasTip = badge.tip !== undefined;
      const badgeClass = `picker-badge picker-badge-${badge.tone}${hasTip ? " picker-badge-tip" : ""}`;
      if (node.className !== badgeClass) {
        node.className = badgeClass;
      }
      // 徽章文字放在 `.picker-badge-text` 里改，别用 textContent 整个覆盖 —— 那会把气泡节点一起抹掉。
      const label = node.querySelector<HTMLElement>(":scope > .picker-badge-text");
      if (label) {
        if (label.textContent !== badge.text) {
          label.textContent = badge.text;
        }
      } else if (node.textContent !== badge.text) {
        node.textContent = badge.text;
      }
      // 气泡内容跟着徽章一起就地更新：整行不重建，气泡节点也得自己同步（换内容才动节点）。
      const tipKey = badge.tip === undefined ? "" : JSON.stringify(badge.tip);
      if ((node.dataset.tipKey ?? "") !== tipKey) {
        node.querySelector(":scope > .picker-tip")?.remove();
        if (badge.tip !== undefined) {
          node.insertAdjacentHTML("beforeend", Picker.tipHtml(badge.tip));
        }
        node.dataset.tipKey = tipKey;
      }
    });
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
    this.applyGeometry(true);
    // 弹层几何落定后再挂/刷新指示条（z-index 要压过列表的 30，否则胶囊被盖住看不见）。
    this.thumb ??= attachScrollThumb({
      getScroller: () => this.list,
      getHolder: () => this.root,
      inset: () => 10,
      zIndex: 31,
    });
    this.thumb.update();
    this.onOpen?.();
  }

  /**
   * 候选变了以后重新铺一遍弹层（点过「更多…」、缓存徽章扫回来都走这里）。
   * 必须重算高度：旧的 max-height 是按旧行数算的，多出来的行会被直接裁掉。
   */
  relayout(): void {
    if (!this.isOpen()) {
      return;
    }
    // 重铺 innerHTML 会把弹层的滚动位置打回顶部：点「更多…」时刚加的行、缓存徽章扫回来时
    // 正在看的那几行都会跳走，所以先记下来再放回去。
    const scrollTop = this.list.scrollTop;
    this.renderOptions();
    this.applyGeometry(false);
    this.list.scrollTop = scrollTop;
    this.thumb?.update();
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

  /** 量一次可用空间并钉死弹层几何；`scrollToSelected` 只在刚展开时为真。 */
  private applyGeometry(scrollToSelected: boolean): void {
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
    if (scrollToSelected) {
      // 「更多…」是就地加行，这时候再把列表滚回当前值，用户刚点的那一行会跳走。
      this.list
        .querySelector<HTMLElement>('.picker-option[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    }
  }

  private close(): void {
    this.list.classList.add("hidden");
    // 轨道虽透明但那条 5px 会吃指针事件，弹层收起时连轨道一起藏，别挡住底下的按钮。
    this.thumb?.hide();
    this.button.setAttribute("aria-expanded", "false");
    this.activeIndex = -1;
  }

  private commit(index: number): void {
    const choice = this.choices[index];
    if (!choice || choice.disabled) {
      return;
    }
    // 动作行（「更多…」）：只做事，不动选中值也不收弹层——收起就得重新展开一遍才能接着点。
    if (choice.action) {
      choice.action();
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
