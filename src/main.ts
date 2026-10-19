import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import logoUrl from "./assets/logo.png";
import "./style.css";
// 主题样式放在独立文件里，用 ?inline 读成字符串：切换主题只是改 <style> 的内容，
// 不重载页面；样式文件本身保持独立成篇，与 design/ui-candidates/ 下的候选稿对得上。
import nativeDarkCss from "./themes/native-dark.css?inline";
import nativeLayoutCss from "./themes/native-layout.css?inline";

/** 标题栏三个窗口图标：10px 见方的细线 SVG，形状统一收在 9px 见方内、
    描边 1.2px（见 .win-btn svg），描边色跟 currentColor——改用矢量后
    不再依赖字体里的 – □ ✕ 字形（那三个字形粗细大小都不一致）。
    最大化与还原是两个图标，按窗口状态切换。 */
const ICON_MINIMIZE = `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 5h9" /></svg>`;
const ICON_MAXIMIZE = `<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0.6" y="0.6" width="8.8" height="8.8" rx="1.4" /></svg>`;
const ICON_RESTORE = `<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0.6" y="2.6" width="6.8" height="6.8" rx="1.3" /><path d="M3 2.6V1.6h5.4a1 1 0 0 1 1 1v5.4H8.4" /></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 9 9M9 1 1 9" /></svg>`;

/** 会话按钮的图标：默认描边风格跟随系统线条（描边参数在 style.css 的 .btn-ico 统一给）；
 *  例外：停止图标是实心方块（维护者要求），填充与几何尺寸见 ICON_STOP 自己的注释。 */
/* 方块几何尺寸比另外三颗的描边图标大一圈（11→16）：描边图标外沿约 19.8/24 单位，
   实心方块若同为 11 视觉只有约 12.8 单位（11 + 1.8 描边外扩），维护者要求大到与其它三颗一致。 */
const ICON_STOP = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>`;
const ICON_RESTART = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" /><path d="M21 3v5h-5" /></svg>`;
const ICON_OPEN_APP = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15" rx="2" /><path d="M2.5 9h19" /><path d="M6.5 4.5V9" /><path d="M10.5 4.5V9" /></svg>`;
const ICON_OPEN_BROWSER = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M2.5 12h19" /><path d="M12 2.5a14.7 14.7 0 0 1 3.8 9.5 14.7 14.7 0 0 1-3.8 9.5 14.7 14.7 0 0 1-3.8-9.5A14.7 14.7 0 0 1 12 2.5z" /></svg>`;

/** 与 Rust 侧 `app_info` 命令的返回结构一一对应。 */
interface AppInfo {
  name: string;
  version: string;
  core_version: string;
  /** 项目仓库地址（「关于」卡片展示与一键打开）。 */
  repository: string;
  /** DSH 官网地址。 */
  site_url: string;
  license: string;
  /** 壳配置目录（%APPDATA%\DSHarbor）。 */
  config_dir: string;
  /** DSH 日志目录（%USERPROFILE%\.dsh\logs）。 */
  logs_dir: string;
}

/** npm dist-tag 渠道。rc / alpha 不是标签而是版本范围，靠下面的版本下拉定具体版本。 */
type Channel = "latest" | "next" | "rc" | "alpha";

/** 运行环境：Windows 宿主，或某个 WSL 发行版里。与 Rust 侧 `launch::Runtime` 对应。 */
type LaunchRuntime = { kind: "default" } | { kind: "wsl"; distro: string };

/** 与 Rust 侧 `launch::LaunchMode`（serde tag = kind）一一对应。 */
type LaunchMode =
  | { kind: "npx"; channel: Channel; version: string | null }
  | { kind: "system" }
  | { kind: "binary"; path: string }
  | { kind: "custom"; command: string };

interface LaunchConfig {
  mode: LaunchMode;
  /** 在哪个环境里执行（只有官方 npx / 自定义命令两块用得到，其余两种固定 Windows）。 */
  runtime: LaunchRuntime;
  extraArgs: string[];
  /** 端口覆盖：null = 跟随 DSH 自身配置；数字 = 壳注入 launcher 层覆盖。 */
  port: number | null;
}

/** 与 Rust 侧 `registry::RegistryInfo` 对应：dist-tag 与按渠道分好组的版本（都从新到旧）。 */
interface RegistryInfo {
  distTags: { latest: string | null; next: string | null; alpha: string | null };
  rc: string[];
  alpha: string[];
}

/** 与 Rust 侧 `wsl::DistroInfo` 对应：发行版名 + 里面有没有 node/npm。 */
interface DistroInfo {
  distro: string;
  hasNode: boolean;
}

/** 与 Rust 侧 `settings::TrayClick` 对应：托盘单击打开哪个窗口。 */
type TrayClick = "launcher" | "dsh";

/** 可折叠的卡片：会话、启动方式、通用设置、桥接插件、环境、网络、集成、关于。 */
type CardKey = "session" | "modes" | "common" | "bridge" | "profiles" | "network" | "integrations" | "about";

/** 与 Rust 侧 `dsharbor_core::prefs::DownloadSource` 对应：从哪儿取 DSH 包。 */
type DownloadSource = "inherit" | "mirror" | "official";

/** 与 Rust 侧 `dsharbor_core::prefs::ProxyMode` 对应：网络代理怎么走。 */
type ProxyMode = "system" | "manual" | "off";

/** 与 Rust 侧 `dsharbor_core::prefs::ShellPrefs` 对应：三张新卡承载的六个字段。
    这一版只做承载（读写、往返、默认值），各字段的实际作用由后续版本逐个接管。 */
interface ShellPrefs {
  /** 当前环境名（DSH 的 profile 名），默认 `web`。 */
  profile: string;
  /** 下载源：沿用 npm 全局配置 / 镜像源 / 官方源。 */
  downloadSource: DownloadSource;
  /** 代理模式：跟随系统 / 手动填写 / 不走代理。 */
  proxyMode: ProxyMode;
  /** 代理地址（proxyMode 为 manual 时有意义），默认空串。 */
  proxyAddress: string;
  /** 命令行集成开关，默认关闭。 */
  cliIntegration: boolean;
  /** 缓存清理开关，默认关闭。 */
  cacheCleanup: boolean;
}

/** 六个新字段的默认值：与 Rust 侧 `ShellPrefs::default()` 保持一致。 */
const DEFAULT_PREFS: ShellPrefs = {
  profile: "web",
  downloadSource: "inherit",
  proxyMode: "system",
  proxyAddress: "",
  cliIntegration: false,
  cacheCleanup: false,
};

/** 后端返回的偏好可能缺字段或带未知枚举值（旧配置、手改坏了）：逐字段兜底，
    不让一个坏值毁掉整份配置。与 Rust 侧宽容读取的语义一致。 */
function normalizePrefs(raw: Partial<ShellPrefs> | undefined | null): ShellPrefs {
  const prefs = raw ?? {};
  const source = String(prefs.downloadSource);
  const proxy = String(prefs.proxyMode);
  return {
    profile: typeof prefs.profile === "string" && prefs.profile.trim() ? prefs.profile : DEFAULT_PREFS.profile,
    downloadSource:
      source === "mirror" || source === "official" ? (source as DownloadSource) : DEFAULT_PREFS.downloadSource,
    proxyMode: proxy === "manual" || proxy === "off" ? (proxy as ProxyMode) : DEFAULT_PREFS.proxyMode,
    proxyAddress: typeof prefs.proxyAddress === "string" ? prefs.proxyAddress : DEFAULT_PREFS.proxyAddress,
    cliIntegration: prefs.cliIntegration === true,
    cacheCleanup: prefs.cacheCleanup === true,
  };
}

/** 与 Rust 侧 `settings::ShellConfig` 对应（整份壳设置）。
    六个新字段在 Rust 侧是 `#[serde(flatten)]` 平铺的，JSON 里与 launch / trayClick 平级，
    所以这里也平铺；写成可选是因为旧配置里没有它们。 */
interface ShellConfig extends Partial<ShellPrefs> {
  launch: LaunchConfig;
  trayClick: TrayClick;
  /** 关闭窗口后延迟多少秒释放界面内存；0 = 立即。 */
  lightDelaySecs: number;
  /** 界面主题的 Rust 侧镜像（见 save_ui_theme：开窗前定窗口装饰用）。 */
  uiTheme: ThemeId;
}

/** 与 Rust 侧 `profile::PortHint` 对应。 */
interface PortHint {
  host: string | null;
  port: number | null;
  source: "managed" | "default";
}

interface SessionStatus {
  state: "stopped" | "running" | "failed";
  pid: number | null;
  port: number | null;
  error: string | null;
  logTail: string[];
  /** 是否已取到带 token 的登录链接。 */
  loginReady: boolean;
  /** 取链接的通道：bridge=桥接插件，log=日志解析兜底。 */
  loginChannel: "bridge" | "log" | null;
  /** 两条通道都失败时的说明（超时等）。 */
  loginError: string | null;
  /** 最近一次成功启动的 DSH 版本号；还没取到时为 null。 */
  dshVersion: string | null;
}

/** 与 Rust 侧 `plugin::BridgeState` 对应。 */
interface BridgeState {
  installed: boolean;
  target: string;
  profileDir: string;
  detail: string;
  latestBackup: string | null;
}

/** 与 Rust 侧 `plugin::BridgeOutcome` 对应。 */
interface BridgeOutcome {
  ok: boolean;
  message: string;
  backupDir: string;
}

/** 渠道候选：中文名在前、npm 标签在后；圆点靠 CSS 画（emoji 在 WebView2 里会渲染成黑白方块）。 */
const CHANNEL_CHOICES: PickerChoice[] = [
  { value: "latest", label: "稳定版（latest）", dot: "latest" },
  { value: "next", label: "最新尝鲜版（next）", dot: "next" },
  { value: "rc", label: "尝鲜版历史版本（rc）", dot: "rc" },
  { value: "alpha", label: "内测版（alpha）", dot: "alpha" },
];

/** 运行环境下拉的「默认」项：value 与 Rust 侧 Runtime::Default 的语义名一致。 */
const RUNTIME_DEFAULT = "default";

/** 渠道徽章：latest / next 显示 dist-tag 指的版本，rc / alpha 换成版本下拉。 */
const BADGE_CHANNELS: Channel[] = ["latest", "next"];

/**
 * 取某个渠道该给哪些版本：rc / alpha 由后端按后缀分好组，这里只做兜底排序后的原样展示。
 * 返回空数组表示「还没读到」（渠道本身合法，不是错误）。
 */
function channelVersions(registry: RegistryInfo | null, channel: Channel): string[] {
  if (!registry) {
    return [];
  }
  return channel === "rc" ? registry.rc : channel === "alpha" ? registry.alpha : [];
}

/** 徽章里的版本号：latest / next 读 dist-tag；没读到就显示 —。 */
function channelTagVersion(registry: RegistryInfo | null, channel: Channel): string | null {
  if (!registry || !BADGE_CHANNELS.includes(channel)) {
    return null;
  }
  return channel === "latest" ? registry.distTags.latest : registry.distTags.next;
}

/**
 * 官方 npx 命令的拼装（只用于界面上的实时预览；真正下发的命令由 Rust 侧 `build_spawn_plan` 拼）。
 * 保留 `--yes`：壳的子进程没有终端，npx 首次下载时的交互确认会直接把启动卡住。
 */
function npxCommandOf(channel: Channel, version: string | null): string {
  const suffix = channel === "latest" ? "" : channel === "next" ? "@next" : version ? `@${version}` : "@<版本>";
  return `npx --yes @deepseek-ai/dsh${suffix} web --no-open`;
}

/**
 * 「自定义命令」输入框的默认值：官方 next 标签，覆盖「想用别的版本 / 别的包管理器」的场景。
 * 保留 `--yes`：壳的子进程没有终端，npx 首次下载时的交互确认会直接把启动卡住。
 */
const CUSTOM_DEFAULT_COMMAND = "npx --yes @deepseek-ai/dsh@next web";

/** 版本徽章里的两个四角星图标（取自 DeepSeek Harness 官网，路径原样保留）。 */
const SPARKLE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
          <defs>
            <linearGradient id="harness-badge-sparkle" x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
              <stop stop-color="#D2E0FF" stop-opacity="0.6"></stop>
              <stop offset="1" stop-color="#A6C2FF" stop-opacity="0.38"></stop>
            </linearGradient>
          </defs>
          <path d="M9 6C10.53 9.82 13.68 12.97 17.5 14.5C13.68 16.03 10.53 19.18 9 23C7.47 19.18 4.32 16.03 0.5 14.5C4.32 12.97 7.47 9.82 9 6Z" fill="url(#harness-badge-sparkle)"></path>
          <path d="M19.5 1C20.22 2.8 21.7 4.28 23.5 5C21.7 5.72 20.22 7.2 19.5 9C18.78 7.2 17.3 5.72 15.5 5C17.3 4.28 18.78 2.8 19.5 1Z" fill="url(#harness-badge-sparkle)"></path>
        </svg>`;

/** 启动方式的界面文案（折叠摘要徽章与单选组共用一份，避免两处漂移）。 */
const MODE_LABELS: Record<string, string> = {
  npx: "官方 npx 命令",
  system: "系统全局命令",
  binary: "指定程序路径",
  custom: "自定义命令",
};

interface PickerChoice {
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
class Picker {
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

  /** 摘掉挂在 document 上的监听：换主题重建界面时旧实例要清掉，否则越积越多。 */
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
    const rect = this.button.getBoundingClientRect();
    const gap = 6;
    const below = window.innerHeight - rect.bottom - gap - 8;
    const above = rect.top - gap - 8;
    const wanted = Math.min(this.list.scrollHeight, 260);
    const flipUp = below < wanted && above > below;
    this.list.classList.toggle("up", flipUp);
    this.list.style.maxHeight = `${Math.max(120, Math.round(Math.min(wanted, flipUp ? above : below)))}px`;
    this.list.querySelector<HTMLElement>('.picker-option[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
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

/** 候选文案来自后端（发行版名），插进 innerHTML 前统一转义。 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

/* ==================== 界面主题 ====================
   三个主题只差外观与排版，内容（字段、文案、id）完全一致：
     classic    原版雾光蓝（src/style.css，也就是原来的界面）
     nativeDark 原版排版 ＋ themes/native-dark.css（候选 I 的外观）
     native     上一套外观 ＋ themes/native-layout.css（候选 I 的排版，含系统标题栏）

   样式由 ?inline 读成字符串塞进 <style id="theme-style">，而不是静态 import：
   只有当前主题的规则在页面里，且切换主题不重载页面。 */

/** 界面主题。 */
type ThemeId = "classic" | "nativeDark" | "native";

/** 主题记在 localStorage（折叠状态 dsharbor.ui.cardCollapsed 也是这么存的）。
 *  index.html 的内联脚本复写了这个键名（静态脚本没法 import），改键名/主题名两处同步。 */
const THEME_KEY = "dsharbor.ui.theme";

const THEME_CHOICES: ReadonlyArray<{ value: ThemeId; label: string }> = [
  { value: "classic", label: "原版（雾光蓝）" },
  { value: "nativeDark", label: "原生暗色（保持原版排版）" },
  { value: "native", label: "系统原生（含排版与标题栏）" },
];

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_CHOICES.some((choice) => choice.value === value);
}

/** 已保存的主题；没存过、被改坏或存储被禁用时回落原版。 */
function readStoredTheme(): ThemeId {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (isThemeId(saved)) {
      return saved;
    }
  } catch {
    // 隐私模式等场景下读不到，按原版走。
  }
  return "classic";
}

/** 「启动 DSH」按钮的两组文字：常显的一组 / 悬停时逐字换上的一组。 */
const TOGGLE_TEXT_REST = "启动 DSH";
const TOGGLE_TEXT_HOVER = "开始运行";

/** 逐字拆成 span；空格用 nbsp，否则在 inline-block 里会被折叠成 0 宽。 */
function charsToSpans(text: string): string {
  return Array.from(text)
    .map((ch) => `<span>${ch === " " ? "&nbsp;" : ch}</span>`)
    .join("");
}

/**
 * 「启动 / 停止」按钮停止态的内部标记（两组文字做逐字切换，样式见 style.css 的
 * #btn-toggle.swap）。buildHtml 的初始标记必须就用这一形态：-run 轮询 render 前
 * 若按钮先以普通按钮（红底大「启动 DSH」）渲染一帧，开着界面/切主题就会闪一下红。
 */
function toggleSwapHtml(): string {
  // 逐字 span 会被读屏逐字念出来，故对读屏隐藏画面、用 aria-label 给整体名字。
  return (
    `<span class="text-window" aria-hidden="true">` +
    `<span class="span-mother">${charsToSpans(TOGGLE_TEXT_REST)}</span>` +
    `<span class="span-mother2">${charsToSpans(TOGGLE_TEXT_HOVER)}</span>` +
    `</span>`
  );
}

/**
 * 「启动中」= 本壳拉起的进程已起来、登录链接还没就绪（npx 首次下载与 DSH 冷启动都停在这一步）。
 * 壳外检测到的 DSH（pid 未知）不在等待登录链接的路上，直接按「运行中」显示，否则会永远转圈。
 */
function isStarting(status: SessionStatus): boolean {
  return status.state === "running" && status.pid !== null && !status.loginReady && !status.loginError;
}

/**
 * 「重启 DSH」点击后的持续转动（2026-10-17 维护者规格）：点击瞬间就锁在悬停终态（文字推出、
 * 图标板铺满）并按徽章「启动中」的节拍（--spin-ms）无限转，鼠标移开也不归位。
 * 收场信号：徽章离开「启动中」（运行中就绪 / 启动失败）→ 正常收工；点「停止」主动打断 → 立即停；
 * 30 秒上限 → 兜底停（登录链接一直不就绪时别转下去）。
 * 最短转满 700ms：重启快到轮询都没看见「启动中」时也至少给出一圈反馈。
 * 状态放模块级：切主题会把整个界面重建一次，转动要跨重建继续，计时不重来。
 */
// 与 src/style.css 的 --spin-ms（700ms）同值不同责：那边是一圈转动的时长，这里是收场前给足的最短反馈；
// 改转速时两处一起检查。
const RESTART_SPIN_MIN_MS = 700;
const RESTART_SPIN_MAX_MS = 30_000;
/** 「已停止」会出现在重启「先停旧、再起新」的缝隙里，这个时长内不收场，免得转动一闪而过。 */
const RESTART_SPIN_STOP_GRACE_MS = 3_000;

let restartSpin: { startedAt: number; sawStarting: boolean } | null = null;
/** 最短时长补收定时器（条件提前满足时到点收场）。 */
let restartSpinTimer: number | undefined;
/** 30 秒上限的独立兜底定时器：不搭轮询便车——dsh_status 一直报错时也得停转。 */
let restartSpinCapTimer: number | undefined;

/** 由 mount 注入「重新查询一次状态」，供上面最短时长的定时器到点补一拍（render 每秒也会跑）。 */
let requestStatusRefresh: () => Promise<void> = async () => {};

/** 把转动状态贴到界面上那颗「重启 DSH」上（切主题后元素会换，所以每次现查）。 */
function applyRestartSpin(): void {
  document.querySelector<HTMLButtonElement>("#btn-restart")?.classList.toggle("is-restarting", restartSpin !== null);
}

function beginRestartSpin(): void {
  window.clearTimeout(restartSpinTimer);
  window.clearTimeout(restartSpinCapTimer);
  restartSpinTimer = undefined;
  restartSpinCapTimer = undefined;
  restartSpin = { startedAt: Date.now(), sawStarting: false };
  applyRestartSpin();
  // 30 秒必停：只要点过重启就有这条兜底，不依赖后续任何轮询成功。
  restartSpinCapTimer = window.setTimeout(() => {
    restartSpinCapTimer = undefined;
    endRestartSpin();
    void requestStatusRefresh();
  }, RESTART_SPIN_MAX_MS);
}

function endRestartSpin(): void {
  if (restartSpin === null) return;
  restartSpin = null;
  window.clearTimeout(restartSpinTimer);
  window.clearTimeout(restartSpinCapTimer);
  restartSpinTimer = undefined;
  restartSpinCapTimer = undefined;
  applyRestartSpin();
}

/** render 每次拿到状态就过一遍收场条件；条件满足但还没转满最短时长时，挂个到点的定时器补收
 * （到点直接收场 + 补一拍刷新，刷新失败也不影响收场这件事本身）。 */
function updateRestartSpin(status: SessionStatus, starting: boolean): void {
  const spin = restartSpin;
  if (spin === null) return;
  const elapsed = Date.now() - spin.startedAt;
  if (starting) spin.sawStarting = true;
  const failed = status.state === "failed";
  const settled =
    failed ||
    (status.state === "running" && !starting) ||
    (status.state === "stopped" && (spin.sawStarting || elapsed >= RESTART_SPIN_STOP_GRACE_MS));
  if (!settled) return;
  const remaining = RESTART_SPIN_MIN_MS - elapsed;
  if (failed || remaining <= 0) {
    endRestartSpin();
    return;
  }
  window.clearTimeout(restartSpinTimer);
  restartSpinTimer = window.setTimeout(() => {
    restartSpinTimer = undefined;
    endRestartSpin();
    void requestStatusRefresh();
  }, remaining);
}

/** 「原生」类的主题：外观照搬候选 I（它俩还共用一处差别：端口带上下箭头）。 */
function isNativeLook(theme: ThemeId): boolean {
  return theme !== "classic";
}

/** 「系统原生」主题：连排版一起换（hero 页头、折叠分组、系统标题栏）。 */
function isNativeLayout(theme: ThemeId): boolean {
  return theme === "native";
}

/** 当前主题要注入的样式：原版全在 src/style.css 里，这里一条都不要；
    另外两套在原版之上叠主题样式（「系统原生」多一层排版）。 */
function themeCss(theme: ThemeId): string {
  if (!isNativeLook(theme)) {
    return "";
  }
  return isNativeLayout(theme) ? `${nativeDarkCss}\n${nativeLayoutCss}` : nativeDarkCss;
}

/** 折叠分组头：原生排版里每个分组都用它，原版只有「启动方式」「桥接插件」「环境」「网络」「集成」用。 */
function foldHead(key: string, title: string, summary = ""): string {
  return `<h2 class="card-head">
    <button id="card-toggle-${key}" class="card-toggle" aria-expanded="true"><span class="chev">▸</span>${title}${summary}</button>
  </h2>`;
}

function plainHead(title: string): string {
  return `<h2>${title}</h2>`;
}

function cardSection(head: string, body: string): string {
  return `<section class="card">
  ${head}
  <div class="card-body">${body}</div>
</section>`;
}

/** 界面骨架。内容在三个主题里一字不差，只有容器不同：原生排版把卡片拆成更细的
    折叠分组、页头换成 hero（候选 I 把「停止 / 重启」摆在 hero 右侧）。 */
function buildHtml(info: AppInfo, theme: ThemeId): string {
  const nativeLook = isNativeLook(theme);
  const nativeLayout = isNativeLayout(theme);

  const titlebar = `
    <!-- 自绘标题栏（tauri.conf.json 里 decorations: false）：整条可拖动，
         按钮只发窗口命令，关闭走的还是原生关闭那条路（Rust 侧转轻量模式）。 -->
    <div class="titlebar" data-tauri-drag-region>
      <span class="titlebar-brand" data-tauri-drag-region>
        <img class="titlebar-logo" src="${logoUrl}" alt="" draggable="false" />DSHarbor
      </span>
      <div class="titlebar-buttons">
        <button id="win-min" class="win-btn" type="button" title="最小化" aria-label="最小化">${ICON_MINIMIZE}</button>
        <button id="win-max" class="win-btn" type="button" title="最大化" aria-label="最大化">${ICON_MAXIMIZE}</button>
        <button id="win-close" class="win-btn win-close" type="button" title="关闭窗口（DSH 继续运行）" aria-label="关闭">${ICON_CLOSE}</button>
      </div>
    </div>
  `;
  const h1Line = `
    <h1>${info.name}</h1>
  `;
  const tagline = `
    <p class="tagline">DSH Web 的桌面壳</p>
  `;
  const lightHint = `
    <p class="light-hint">关闭窗口 = 轻量模式：界面内存释放，DSH 与托盘常驻；单击托盘图标随时回来（关闭后多久进入、打开哪个窗口均可在下面设置）。</p>
  `;
  const badges = `
    <div class="status-row">
      <span id="login-badge" class="badge badge-stopped"><span id="login-text">登录等待中</span><span id="login-info" class="info-dot" role="img" tabindex="0" aria-label="登录链接说明" data-tip="登录链接就绪后即可打开 DSH 界面">!</span></span>
      <span id="status-badge" class="badge badge-stopped"><span id="status-spinner" class="spinner hidden"></span><span id="status-text">已停止</span></span>
      <span id="version-badge" class="badge badge-version" title="每次成功启动 DSH 后自动读取">${SPARKLE_SVG}<span id="version-text">DSH 版本未知</span></span>
      <span class="status-meta">PID：<b id="status-pid">—</b></span>
      <span class="status-meta">端口：<b id="status-port">—</b></span>
    </div>
  `;
  // 会话区共用件：三个主题同一份标记，id 不变，绑定代码共用。
  const statusErrorBlock = `<p id="status-error" class="error hidden"></p>`;
  const loginNoteBlock = `<p id="login-note" class="hint login-note hidden"></p>`;
  // 按钮行（维护者要求，三个主题统一）：排在状态徽章行下面、占满一整行。
  // 启动前整行只有「启动 DSH」；运行后「停止 / 重启 DSH」撑满左侧余量，
  // 「应用内打开 / 浏览器打开」靠右。两组的显隐由 render() 按状态切换，
  // 拉伸与靠右在 style.css 的 .actions-row 里。
  const sessionActionsRow = `
    <div class="actions-row">
      <div class="actions actions-primary">
        <!-- 初始即停止态的逐字切换形态：首帧就用正确样式，等 render 前不会闪红底大字。 -->
        <button id="btn-toggle" class="primary swap" aria-label="${TOGGLE_TEXT_REST}">${toggleSwapHtml()}</button>
        <button id="btn-restart" class="hidden"><span class="btn-text">重启 DSH</span><span class="btn-ico" aria-hidden="true">${ICON_RESTART}</span></button>
      </div>
      <div class="actions actions-open hidden" id="actions-open">
        <button id="btn-open-app" disabled><span class="btn-text">应用内打开</span><span class="btn-ico" aria-hidden="true">${ICON_OPEN_APP}</span></button>
        <button id="btn-open-browser" disabled><span class="btn-text">浏览器打开</span><span class="btn-ico" aria-hidden="true">${ICON_OPEN_BROWSER}</span></button>
      </div>
    </div>
  `;
  const logBlock = `
    <details class="log-box">
      <summary><span class="chev">▸</span>最近输出</summary>
      <div class="log-area">
        <pre id="log">（暂无输出）</pre>
        <button type="button" class="log-copy" id="btn-copy-log">复制</button>
      </div>
    </details>
  `;
  // 原版排版把两条托盘设置留在会话卡片里，说明直接写在控件下方。
  const trayFields = `
    <div class="fields tray-fields">
      <label>托盘单击打开</label>
      <div class="picker" id="tray-picker"></div>
      <p class="hint">单击系统托盘图标时打开哪一个；右键菜单「浏览器打开 / 应用内打开 / 打开启动界面」随时可用。</p>
    </div>
    <div class="fields tray-fields">
      <label>关闭窗口后释放界面内存</label>
      <div class="picker" id="light-delay-picker"></div>
      <p class="hint">关闭后先留在内存里，这段时间内从托盘回来是秒开；到点后释放界面内存。</p>
    </div>
  `;
  const modesSummary = `
    <span id="modes-summary" class="badge badge-stopped card-summary">官方 npx 命令</span>
  `;
  const bridgeSummary = `
    <span id="bridge-summary" class="badge badge-stopped card-summary">读取中…</span>
  `;
  // 「环境」「网络」「集成」三张卡本轮只铺承载：标题、折叠头、摘要徽章与一行占位说明。
  // 卡片的具体内容（环境列表 / 下载源与代理 / 命令行与缓存）由后续版本逐张接入，
  // 字段本身已经在读写链路上，不再变动。摘要徽章先给占位文案，免得收起后一片空白。
  const placeholderCard = (key: CardKey, title: string, note: string): string =>
    cardSection(
      foldHead(key, title, `\n    <span id="${key}-summary" class="badge badge-stopped card-summary">未设置</span>\n  `),
      `<p class="hint">${note}</p>`,
    );
  const profilesSection = placeholderCard("profiles", "环境", "当前使用哪一份 DSH 环境、装了哪些插件，将在后续版本显示在这里。");
  const networkSection = placeholderCard("network", "网络", "下载源与代理设置的选项，将在后续版本显示在这里。");
  const integrationsSection = placeholderCard(
    "integrations",
    "集成",
    "命令行集成与缓存清理的开关，将在后续版本显示在这里。",
  );
  const modesBody = `
    <label class="mode">
      <input type="radio" name="mode" value="npx" checked />
      <span>
        <b>${MODE_LABELS.npx}</b>
        <small>未全局安装 DSH 时用；首次启动会自动下载（较慢）<br />执行 <code id="npx-command-preview">${npxCommandOf("latest", null)}</code></small>
      </span>
    </label>
    <div id="npx-fields" class="fields hidden">
      <span class="field-label">运行环境 <span class="info-dot" role="img" tabindex="0" aria-label="运行环境说明" data-tip="默认在 Windows 侧执行命令；选 WSL 发行版则通过 wsl.exe 在该发行版内执行，桥接插件也装到那个发行版里。">!</span></span>
      <div class="picker" id="npx-runtime-picker"></div>
      <span class="field-label">渠道 <span class="info-dot" role="img" tabindex="0" aria-label="渠道说明" data-tip="稳定版 / 最新尝鲜版对应 npm 的 latest / next 标签，右侧徽章显示标签当前指向的版本；尝鲜版历史版本 / 内测版是版本范围，需要再选一个具体版本。">!</span></span>
      <div class="control-line">
        <div class="picker" id="npx-channel-picker"></div>
        <span id="npx-channel-badge" class="badge badge-version"></span>
        <div class="picker hidden" id="npx-version-picker"></div>
      </div>
      <div id="npx-versions-hint" class="hint hidden"></div>
    </div>
    <label class="mode">
      <input type="radio" name="mode" value="system" />
      <span>
        <b>${MODE_LABELS.system}</b>
        <small>已执行过 <code>npm install -g @deepseek-ai/dsh</code></small>
      </span>
    </label>
    <label class="mode">
      <input type="radio" name="mode" value="binary" />
      <span>
        <b>${MODE_LABELS.binary}</b>
        <small>最可靠：直接启动 dsh.exe / dsh.cmd 的完整路径</small>
      </span>
    </label>
    <div id="binary-fields" class="fields hidden">
      <div class="path-row">
        <input id="binary-path" type="text" placeholder="例如 D:\\tools\\dsh.cmd" />
        <button type="button" id="binary-browse" class="path-browse" title="选择 dsh.exe / dsh.cmd / dsh.bat">浏览…</button>
      </div>
      <p id="binary-error" class="error field-error hidden"></p>
    </div>
    <label class="mode">
      <input type="radio" name="mode" value="custom" />
      <span>
        <b>${MODE_LABELS.custom}</b>
        <small>自己写整条启动命令，例如 <code>npx @deepseek-ai/dsh@next web</code>（换版本标签、换包管理器、包一层脚本都行）</small>
      </span>
    </label>
    <div id="custom-fields" class="fields hidden">
      <span class="field-label">运行环境 <span class="info-dot" role="img" tabindex="0" aria-label="运行环境说明" data-tip="默认在 Windows 侧执行命令；选 WSL 发行版则通过 wsl.exe 在该发行版内执行这条命令。">!</span></span>
      <div class="picker" id="custom-runtime-picker"></div>
      <input id="custom-command" type="text" value="${CUSTOM_DEFAULT_COMMAND}" placeholder="例如 npx @deepseek-ai/dsh@next web" />
      <p class="hint">写整条启动命令（末尾保留 <code>web</code> 子命令）；只允许字母数字与 <code>- _ . / : = @ +</code> 和空格，引号、管道、重定向会被拒绝。壳会自动补上 <code>--no-open</code>。</p>
    </div>
  `;
  // 端口控件：原生两主题用候选 I 的 NumberBox（带上下箭头），原版是纯文本框（id 一样，绑定代码共用）。
  const portControl = nativeLook
    ? `<div class="step num"><input id="port" type="text" inputmode="numeric" placeholder="例如 3099" /><span class="spins"><button type="button" class="spin" data-step="1" tabindex="-1" aria-label="端口加一">▲</button><button type="button" class="spin" data-step="-1" tabindex="-1" aria-label="端口减一">▼</button></span></div>`
    : `<input id="port" type="text" inputmode="numeric" placeholder="例如 3099" />`;
  // 通用设置：原版是「启动方式」卡片里的子面板，主题三由 native-layout.css 覆盖成两列并排的底色框。
  // 两处说明都进 ⓘ 气泡（维护者要求），端口那条由 renderPortHint() 动态改写 data-tip。
  const commonBody = `
    <div class="subcard">
      <div class="grid-2">
        <div class="fields">
          <label for="extra-args">附加参数 <span class="info-dot" role="img" tabindex="0" aria-label="附加参数说明" data-tip="追加到该启动方式的命令末尾（运行环境选 WSL 时追加到发行版内的命令后面）。仅允许字母数字与 - _ . / : = @ + 和空格；壳始终自动追加 --no-open（不自动弹浏览器），需要时用上面的「浏览器打开」。">!</span></label>
          <input id="extra-args" type="text" placeholder="例如 --port 3081 --no-open" />
        </div>
        <div class="fields">
          <label for="port">端口 <span id="port-info" class="info-dot" role="img" tabindex="0" aria-label="端口说明" data-tip="正在读取 DSH 配置…">!</span></label>
          <div class="port-row">${portControl}<button type="button" id="port-reset" class="port-reset" title="把端口还原为默认（留空 = 跟随 DSH 配置）">还原</button></div>
        </div>
      </div>
    </div>
  `;
  const bridgeBody = `
    <p class="hint">安装后壳经 DSH 内部插件接口直接取带 token 的登录链接，不依赖日志格式；未安装时自动降级为日志解析（可用但较脆）。安装/卸载前请先停止 DSH。每次安装或卸载都会自动备份 profile 文件，只保留最近 5 份，超出后删掉最旧的。</p>
    <div class="kv">
      <div class="kv-row"><span class="kv-key">目标环境</span><span class="kv-value" id="bridge-target">—</span></div>
      <div class="kv-row"><span class="kv-key">安装状态</span><span class="kv-value" id="bridge-status">读取中…</span></div>
      <div class="kv-row"><span class="kv-key">最近备份</span><span class="kv-value" id="bridge-backup">—</span></div>
    </div>
    <div class="actions bridge-actions">
      <button id="btn-bridge-install" class="primary">安装桥接插件</button>
      <button id="btn-bridge-uninstall">卸载</button>
      <button id="btn-bridge-restore">恢复最近备份</button>
      <button id="btn-bridge-backups">打开备份目录</button>
    </div>
    <p id="bridge-note" class="hint hidden"></p>
    <p id="bridge-error" class="error hidden"></p>
    <details class="log-box">
      <summary><span class="chev">▸</span>操作输出</summary>
      <div class="log-area">
        <pre id="bridge-output">（暂无操作）</pre>
        <button type="button" class="log-copy" id="btn-copy-bridge-output">复制</button>
      </div>
    </details>
  `;
  const aboutKv = `
    <div class="kv">
      <div class="kv-row"><span class="kv-key">壳版本</span><span class="kv-value" id="about-shell">${info.name} ${info.version}（核心库 ${info.core_version}）</span></div>
      <div class="kv-row"><span class="kv-key">DSH 版本</span><span class="kv-value" id="about-dsh">未知</span></div>
      <div class="kv-row"><span class="kv-key">开源许可证</span><span class="kv-value" id="about-license">${info.license}</span></div>
      <div class="kv-row kv-row-action"><span class="kv-key">项目仓库</span><span class="kv-value" id="about-repo">${info.repository}</span><button id="btn-about-repo" class="kv-action">打开 GitHub 仓库</button></div>
      <div class="kv-row kv-row-action"><span class="kv-key">DSH 官网</span><span class="kv-value" id="about-site">${info.site_url}</span><button id="btn-about-site" class="kv-action">打开 DSH 官网</button></div>
      <div class="kv-row kv-row-action"><span class="kv-key">配置目录</span><span class="kv-value" id="about-config-dir">${info.config_dir}</span><button id="btn-about-config" class="kv-action">打开配置目录</button></div>
      <div class="kv-row kv-row-action"><span class="kv-key">日志目录</span><span class="kv-value" id="about-logs-dir">${info.logs_dir}</span><button id="btn-about-logs" class="kv-action">打开日志目录</button></div>
    </div>
  `;
  const aboutTail = `
    <p id="about-note" class="hint hidden"></p>
    <p class="hint">DSH 版本在每次成功启动后自动读取；配置目录放壳设置与桥接备份，日志目录放 DSH 的启动日志（运行环境选 WSL 时日志在发行版内的 <code>~/.dsh/logs</code>）。</p>
  `;
  // 主题三把两条托盘设置搬到「关于」里并排（维护者要求），说明改到 ⓘ 气泡里。
  const aboutSettingsRow = `
    <div class="settings-row">
      <div class="setting-col">
        <span class="setting-label">托盘单击打开 <span class="info-dot" role="img" tabindex="0" aria-label="托盘单击说明" data-tip="单击系统托盘图标时打开哪一个；右键菜单「浏览器打开 / 应用内打开 / 打开启动界面」随时可用。">!</span></span>
        <div class="picker" id="tray-picker"></div>
      </div>
      <div class="setting-col">
        <span class="setting-label">关闭窗口后释放界面内存 <span class="info-dot" role="img" tabindex="0" aria-label="关闭窗口说明" data-tip="关闭后先留在内存里，这段时间内从托盘回来是秒开；到点后释放界面内存。">!</span></span>
        <div class="picker" id="light-delay-picker"></div>
      </div>
    </div>
  `;

  // 主题入口放在「关于」里：主题 3 用系统标题栏，放标题栏会多出一套入口，
  // 而「关于」在三个主题里都在。
  const themeFields = `
    <div class="theme-fields">
      <div class="theme-field">
        <span class="theme-field-label">界面主题 <span class="info-dot" role="img" tabindex="0" aria-label="界面主题说明" data-tip="换主题按新排版重建界面，字段内容不变；选择记在本机，下次启动沿用。">!</span></span>
        <div class="picker" id="theme-picker"></div>
      </div>
    </div>`;

  const titleAndTagline = `${h1Line}
  ${tagline}
  ${lightHint}`;
  // 页头：原生排版换成候选 I 的 hero（logo 在左）；状态徽章与四颗按钮在卡片里的同一行。
  const header = nativeLayout
    ? `<header class="head hero">
  <img class="hero-logo" src="${logoUrl}" alt="" draggable="false" />
  <div class="hero-text">${titleAndTagline}
  </div>
</header>`
    : `<header class="head">${titleAndTagline}</header>`;

  // 主题三：状态、提示、动作按钮、最近输出都收进第一张 hero 卡片，「DSH 会话」分组取消（内容已全部移出）；
  // 「通用设置」不再单独成组，合并进「启动方式」卡片底部。原版/原生暗色里会话、启动方式、桥接插件三张卡片照旧。
  // hero 卡片：标题区 + 提示 + 状态徽章行 + 按钮行（三个主题同一套排版）+ 最近输出。
  const heroSection = nativeLayout
    ? `<section class="card hero-card">
  ${header}
  ${statusErrorBlock}
  ${loginNoteBlock}
  ${badges}
  ${sessionActionsRow}
  <div class="hero-log">${logBlock}</div>
</section>`
    : "";
  const sessionSection = nativeLayout
    ? ""
    : cardSection(
        plainHead("DSH 会话"),
        `${badges}
  ${statusErrorBlock}
  ${sessionActionsRow}
  ${loginNoteBlock}
  ${trayFields}
  ${logBlock}`,
      );
  const modesSection = cardSection(foldHead("modes", "启动方式", modesSummary), `${modesBody}
  ${commonBody}`);
  const bridgeSection = cardSection(foldHead("bridge", "桥接插件（登录链接的可靠通道）", bridgeSummary), bridgeBody);
  const aboutSection = cardSection(
    nativeLayout ? foldHead("about", "关于") : plainHead("关于"),
    `${aboutKv}${nativeLayout ? aboutSettingsRow : ""}${themeFields}<div class="about-tail">${aboutTail}</div>`,
  );

  return `${titlebar}
  ${nativeLayout ? "" : header}
  ${heroSection}
  ${sessionSection}
  ${modesSection}
  ${bridgeSection}
  ${profilesSection}
  ${networkSection}
  ${integrationsSection}
  ${aboutSection}`;
}

async function main(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    return;
  }
  // 界面挂载、重建都要用它；写成非空类型，省得每个用到的地方再判一次空。
  const root: HTMLDivElement = app;

  let info: AppInfo = {
    name: "DSHarbor",
    version: "未知",
    core_version: "未知",
    repository: "未知",
    site_url: "未知",
    license: "未知",
    config_dir: "未知",
    logs_dir: "未知",
  };
  try {
    info = await invoke<AppInfo>("app_info");
  } catch (err) {
    // 在普通浏览器里打开页面时没有 Tauri 环境，保留占位信息即可。
    console.error("无法通过 Tauri 获取应用信息:", err);
  }

  let theme: ThemeId = readStoredTheme();
  // 六个新字段的当前值：后端读回来之后换成它。本版只做承载，没有界面控件改它，
  // 但保存链路上必须原样带上，否则界面上任何一次保存都会把用户已改的值抹回默认。
  let prefs: ShellPrefs = { ...DEFAULT_PREFS };
  let livePickers: Picker[] = [];
  // 界面重建时 DOM 与绑定全部重来，挂在 window 上的监听不能跟着重来：
  // 这三处跨重建的东西只注册一次，通过钩子指向当前这套界面。
  let updateScrollThumbHook: () => void = () => {};
  let syncMaximizeIconHook: () => void = () => {};
  let refreshNowHook: () => Promise<void> = async () => {};

  /** 按主题重建界面：先摘掉上一套界面的 Picker，再照新主题生成 DOM 与绑定。 */
  async function mount(next: ThemeId): Promise<void> {
    for (const picker of livePickers) {
      picker.dispose();
    }
    livePickers = [];
    // 上一套界面的按钮已经不在文档里了，先清空同步钩子，等新按钮挂上再设。
    syncMaximizeIconHook = () => {};

    // 只有当前主题的规则进页面：原版靠 src/style.css，另外两套再叠主题样式。
    const themeStyle = document.querySelector<HTMLStyleElement>("#theme-style");
    const style = themeStyle ?? document.createElement("style");
    style.id = "theme-style";
    style.textContent = themeCss(next);
    if (!themeStyle) {
      document.head.appendChild(style);
    }
    // 同步 <html data-theme>：index.html 首屏内联样式按它预着色，避免深色主题
    // 开窗先闪一帧亮底；主题切换时刷新，回到原版则摘掉（恢复浅底）。
    if (isNativeLook(next)) {
      document.documentElement.dataset.theme = next;
    } else {
      delete document.documentElement.dataset.theme;
    }

    root.innerHTML = buildHtml(info, next);

    const $ = <T extends HTMLElement>(id: string): T => {
      const el = root.querySelector<T>(`#${id}`);
      if (!el) {
        throw new Error(`缺少元素 #${id}`);
      }
      return el;
    };

    const badge = $<HTMLSpanElement>("status-badge");
    const statusText = $<HTMLElement>("status-text");
    const statusSpinner = $<HTMLElement>("status-spinner");
    const versionText = $<HTMLElement>("version-text");
    const pidEl = $<HTMLElement>("status-pid");
    const portEl = $<HTMLElement>("status-port");
    const errorEl = $<HTMLParagraphElement>("status-error");
    const logEl = $<HTMLPreElement>("log");
    const btnToggle = $<HTMLButtonElement>("btn-toggle");
    const btnRestart = $<HTMLButtonElement>("btn-restart");
    const extraInput = $<HTMLInputElement>("extra-args");
    const binaryPath = $<HTMLInputElement>("binary-path");
    const binaryBrowse = $<HTMLButtonElement>("binary-browse");
    const binaryError = $<HTMLParagraphElement>("binary-error");
    const customCommand = $<HTMLInputElement>("custom-command");
    const npxCommandPreview = $<HTMLElement>("npx-command-preview");
    const npxVersionRoot = $<HTMLElement>("npx-version-picker");
    const npxChannelBadge = $<HTMLSpanElement>("npx-channel-badge");
    const npxVersionsHint = $<HTMLDivElement>("npx-versions-hint");
    const portInput = $<HTMLInputElement>("port");
    const portReset = $<HTMLButtonElement>("port-reset");
    const portInfoEl = $<HTMLSpanElement>("port-info");
    const loginBadge = $<HTMLSpanElement>("login-badge");
    const loginText = $<HTMLElement>("login-text");
    const loginInfo = $<HTMLElement>("login-info");
    const loginNote = $<HTMLParagraphElement>("login-note");
    const btnOpenApp = $<HTMLButtonElement>("btn-open-app");
    const btnOpenBrowser = $<HTMLButtonElement>("btn-open-browser");
    const actionsOpen = $<HTMLElement>("actions-open");
    const trayPicker = new Picker("tray-picker", () => void persistConfigQuiet());
    trayPicker.setChoices([
      { value: "launcher", label: "启动界面（默认）" },
      { value: "dsh", label: "应用内窗口" },
    ]);
    const lightDelayPicker = new Picker("light-delay-picker", () => void persistConfigQuiet());
    /** 「关闭窗口后释放界面内存」的延迟候选，value 为秒数的十进制字符串。 */
    const LIGHT_DELAY_CHOICES: PickerChoice[] = [
      { value: "0", label: "立即" },
      { value: "5", label: "5 秒" },
      { value: "15", label: "15 秒" },
      { value: "30", label: "30 秒" },
      { value: "60", label: "1 分钟" },
      { value: "300", label: "5 分钟" },
    ];
    lightDelayPicker.setChoices(LIGHT_DELAY_CHOICES);
    // 运行环境是壳级选择：官方 npx 命令与自定义命令共用同一份值，两个下拉框互相同步。
    let runtime: LaunchRuntime = { kind: "default" };
    /** null = 还没读到；读取失败时也是 null，靠 distrosError 区分「加载中」与「失败」。 */
    let distroInfos: DistroInfo[] | null = null;
    let distrosError: string | null = null;
    /** 官方版本列表：按运行环境分别读；Rust 侧有 10 分钟缓存，这里不再叠一层。 */
    let registry: RegistryInfo | null = null;
    let registryError: string | null = null;
    let registryLoading = false;
    /** 保存过但还没等版本列表回来回填的具体版本。 */
    let pendingVersion: string | null = null;

    const runtimeValue = (value: LaunchRuntime): string =>
      value.kind === "wsl" ? `wsl:${value.distro}` : RUNTIME_DEFAULT;

    const runtimeOf = (value: string): LaunchRuntime =>
      value.startsWith("wsl:") ? { kind: "wsl", distro: value.slice(4) } : { kind: "default" };

    /** 发行版列表就绪前先占位的禁用项（value 为空，选不到）。 */
    function runtimeChoices(): PickerChoice[] {
      const choices: PickerChoice[] = [{ value: RUNTIME_DEFAULT, label: "默认" }];
      if (distroInfos === null) {
        choices.push({
          value: "",
          label: distrosError === null ? "（正在读取发行版列表…）" : "（读取发行版列表失败）",
          disabled: true,
        });
        return choices;
      }
      for (const info of distroInfos) {
        // 装了 WSL 但没有 node/npm 的发行版仍然可选，只在文字上标一下，让用户自己决定。
        choices.push({
          value: `wsl:${info.distro}`,
          label: info.hasNode ? `WSL - ${info.distro}` : `WSL - ${info.distro}（未检测到 Node.js）`,
        });
      }
      if (distroInfos.length === 0) {
        choices.push({ value: "", label: "（未检测到 WSL 发行版）", disabled: true });
      }
      // 存过但发行版已经没了：仍列出来（让用户看见存的是什么），改选「默认」就清掉。
      if (runtime.kind === "wsl") {
        const saved = runtime.distro;
        if (!distroInfos.some((info) => info.distro === saved)) {
          choices.push({ value: `wsl:${saved}`, label: `WSL - ${saved}（发行版已不存在）` });
        }
      }
      return choices;
    }

    function syncRuntimePickers(): void {
      const choices = runtimeChoices();
      const value = runtimeValue(runtime);
      for (const picker of [npxRuntimePicker, customRuntimePicker]) {
        picker.setChoices(choices);
        picker.setValue(value);
      }
    }

    function onRuntimeChange(value: string): void {
      runtime = runtimeOf(value);
      syncRuntimePickers();
      void persistConfigQuiet();
      void refreshPortHint();
      void refreshBridgeState();
      // 先清掉上一个环境的清单，否则换发行版后到新清单回来之前，版本下拉里
      // 还挂着另一个环境（另一个 npm registry 视图）的版本号。
      // 当前选中的具体版本先存进 pendingVersion，新清单回来后 loadRegistry 会回填。
      if (!BADGE_CHANNELS.includes(currentChannel())) {
        pendingVersion = npxVersionPicker.value.trim() || null;
      }
      registry = null;
      registryError = null;
      void loadRegistry();
    }

    const npxRuntimePicker = new Picker("npx-runtime-picker", onRuntimeChange);
    npxRuntimePicker.setChoices([{ value: RUNTIME_DEFAULT, label: "默认" }]);
    const customRuntimePicker = new Picker("custom-runtime-picker", onRuntimeChange);
    customRuntimePicker.setChoices([{ value: RUNTIME_DEFAULT, label: "默认" }]);

    const currentChannel = (): Channel => {
      const value = npxChannelPicker.value;
      return value === "next" || value === "rc" || value === "alpha" ? value : "latest";
    };

    /** 当前选定的具体版本；latest / next 靠 dist-tag 定位，不存版本号。 */
    const currentVersion = (): string | null =>
      BADGE_CHANNELS.includes(currentChannel()) ? null : npxVersionPicker.value.trim() || null;

    /** 版本候选；保存过/选过但官方列表已经没有的版本仍然列出来，标一句「已不在官方列表」。 */
    function versionChoices(channel: Channel): PickerChoice[] {
      const versions = channelVersions(registry, channel);
      if (registryLoading && versions.length === 0) {
        return [{ value: "", label: "（正在读取版本列表…）", disabled: true }];
      }
      const choices: PickerChoice[] = versions.map((version) => ({ value: version, label: version }));
      const kept = pendingVersion ?? (npxVersionPicker.value.trim() || null);
      if (kept !== null && !versions.includes(kept)) {
        choices.push({ value: kept, label: `${kept}（已不在官方列表）` });
      }
      return choices;
    }

    function registryHint(channel: Channel): string {
      if (registryLoading) {
        return "正在读取官方版本列表…";
      }
      if (registryError !== null) {
        if (runtime.kind === "wsl") {
          const distro = runtime.distro;
          const info = distroInfos?.find((item) => item.distro === distro);
          if (info && !info.hasNode) {
            return `${distro} 里没有 node/npm，读不到版本列表；要先在该发行版里装 Node.js。稳定版（latest）同理也需要。`;
          }
        }
        return "读不到官方版本列表（npm view 失败或断网）。稳定版（latest）仍可直接启动。";
      }
      if (!BADGE_CHANNELS.includes(channel) && channelVersions(registry, channel).length === 0) {
        return "官方列表里还没有这一渠道的版本。";
      }
      return "";
    }

    function renderChannelUI(): void {
      const channel = currentChannel();
      const isBadge = BADGE_CHANNELS.includes(channel);
      npxChannelBadge.classList.toggle("hidden", !isBadge);
      npxVersionRoot.classList.toggle("hidden", isBadge);
      if (isBadge) {
        const version = channelTagVersion(registry, channel);
        npxChannelBadge.textContent = version ?? "—";
        npxChannelBadge.title = version
          ? `npm 的 ${channel} 标签当前指向 ${version}`
          : "还没读到 npm 标签信息";
      } else {
        npxVersionPicker.setChoices(versionChoices(channel));
      }
      npxCommandPreview.textContent = npxCommandOf(channel, currentVersion());
      const hint = registryHint(channel);
      npxVersionsHint.classList.toggle("hidden", hint === "" && registryError === null);
      npxVersionsHint.innerHTML =
        registryError === null
          ? escapeHtml(hint)
          : `${escapeHtml(hint)} <button type="button" id="npx-versions-retry" class="port-reset" title="重新执行 npm view 读取版本列表">重新读取</button>`;
    }

    async function loadDistros(): Promise<void> {
      try {
        distroInfos = await invoke<DistroInfo[]>("wsl_distro_info");
        distrosError = null;
      } catch (err) {
        distroInfos = null;
        distrosError = String(err);
        console.error("读取 WSL 发行版失败:", err);
      }
      syncRuntimePickers();
    }

    async function loadRegistry(): Promise<void> {
      registryLoading = true;
      registryError = null;
      renderChannelUI();
      try {
        registry = await invoke<RegistryInfo>("query_dsh_versions", { runtime });
      } catch (err) {
        registry = null;
        registryError = String(err);
        console.error("读取官方版本列表失败:", err);
      } finally {
        registryLoading = false;
      }
      // 保存过的具体版本要等列表回来才能回填（否则 setChoices 会把它退回第一项）。
      if (pendingVersion !== null) {
        const channel = currentChannel();
        if (!BADGE_CHANNELS.includes(channel)) {
          npxVersionPicker.setChoices(versionChoices(channel));
          npxVersionPicker.setValue(pendingVersion);
        }
        pendingVersion = null;
      }
      renderChannelUI();
    }

    const npxChannelPicker = new Picker("npx-channel-picker", () => {
      const channel = currentChannel();
      if (!BADGE_CHANNELS.includes(channel)) {
        const versions = channelVersions(registry, channel);
        npxVersionPicker.setChoices(versionChoices(channel));
        // 换到版本渠道时默认选最新的那个。
        if (versions.length > 0) {
          npxVersionPicker.setValue(versions[0]);
        }
      }
      renderChannelUI();
      void persistConfigQuiet();
    });
    npxChannelPicker.setChoices(CHANNEL_CHOICES);
    const npxVersionPicker = new Picker("npx-version-picker", () => {
      renderChannelUI();
      void persistConfigQuiet();
    });
    npxVersionPicker.setChoices([]);
    npxVersionsHint.addEventListener("click", (event) => {
      if ((event.target as HTMLElement | null)?.id === "npx-versions-retry") {
        void loadRegistry();
      }
    });
    const themePicker = new Picker("theme-picker", (value) => {
      if (isThemeId(value)) {
        void switchTheme(value);
      }
    });
    themePicker.setChoices(THEME_CHOICES.map((choice) => ({ value: choice.value, label: choice.label })));
    themePicker.setValue(theme);
    // 重建界面时旧实例要 dispose（它们各自挂着 document 监听）。
    livePickers = [
      trayPicker,
      lightDelayPicker,
      npxRuntimePicker,
      customRuntimePicker,
      npxChannelPicker,
      npxVersionPicker,
      themePicker,
    ];
    const modesSummary = $<HTMLSpanElement>("modes-summary");
    const bridgeSummary = $<HTMLSpanElement>("bridge-summary");
    const btnCopyLog = $<HTMLButtonElement>("btn-copy-log");
    const btnCopyBridgeOutput = $<HTMLButtonElement>("btn-copy-bridge-output");
    const bridgeTarget = $<HTMLElement>("bridge-target");
    const bridgeStatus = $<HTMLElement>("bridge-status");
    const bridgeBackup = $<HTMLElement>("bridge-backup");
    const bridgeError = $<HTMLParagraphElement>("bridge-error");
    const bridgeNote = $<HTMLParagraphElement>("bridge-note");
    const bridgeOutput = $<HTMLPreElement>("bridge-output");
    const btnBridgeInstall = $<HTMLButtonElement>("btn-bridge-install");
    const btnBridgeUninstall = $<HTMLButtonElement>("btn-bridge-uninstall");
    const btnBridgeRestore = $<HTMLButtonElement>("btn-bridge-restore");
    const btnBridgeBackups = $<HTMLButtonElement>("btn-bridge-backups");
    const aboutDsh = $<HTMLElement>("about-dsh");
    const aboutNote = $<HTMLParagraphElement>("about-note");
    // 「系统原生」主题用系统标题栏，这三个按钮不存在。
    const btnWinMin = root.querySelector<HTMLButtonElement>("#win-min");
    const btnWinMax = root.querySelector<HTMLButtonElement>("#win-max");
    const btnWinClose = root.querySelector<HTMLButtonElement>("#win-close");
    const btnAboutRepo = $<HTMLButtonElement>("btn-about-repo");
    const btnAboutSite = $<HTMLButtonElement>("btn-about-site");
    const btnAboutConfig = $<HTMLButtonElement>("btn-about-config");
    const btnAboutLogs = $<HTMLButtonElement>("btn-about-logs");

    // 卡片折叠（所有带折叠头的分组，含「环境」「网络」「集成」）：默认展开；用户点出来的折叠状态记在 localStorage，
    // 壳重启、轻量模式重建窗口后沿用（维护者要求）。不放 config.json：那是整份回写的设置文件，
    // 折叠只是界面偏好，丢了不影响功能。
    const CARD_COLLAPSE_KEY = "dsharbor.ui.cardCollapsed";
    const cardToggle = (key: CardKey): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>(`#card-toggle-${key}`);

    function readCardCollapsed(): Partial<Record<CardKey, boolean>> {
      try {
        const raw = window.localStorage.getItem(CARD_COLLAPSE_KEY);
        const parsed: unknown = raw === null ? null : JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null
          ? (parsed as Partial<Record<CardKey, boolean>>)
          : {};
      } catch {
        // 存储被禁用，或内容被改坏：当成「都没折叠」，不影响使用
        return {};
      }
    }

    const cardCollapsed = readCardCollapsed();

    /** 单一入口：改 DOM + 记状态。persist 只在用户点击时为真——桥接操作触发的临时展开不落盘。 */
    const setCardCollapsed = (key: CardKey, collapsed: boolean, persist: boolean): void => {
      cardCollapsed[key] = collapsed;
      const toggle = cardToggle(key);
      if (!toggle) {
        return; // 当前主题里没有这个分组（原版只有「启动方式」「桥接插件」能折）
      }
      toggle.closest(".card")?.classList.toggle("collapsed", collapsed);
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      if (persist) {
        try {
          window.localStorage.setItem(CARD_COLLAPSE_KEY, JSON.stringify(cardCollapsed));
        } catch {
          // 存储被禁用时忽略：本次会话仍按内存里的状态走
        }
      }
    };

    const expandCard = (key: CardKey): void => setCardCollapsed(key, false, false);

    const CARD_KEYS = ["session", "modes", "common", "bridge", "profiles", "network", "integrations", "about"] as const;
    for (const key of CARD_KEYS) {
      const toggle = cardToggle(key);
      if (!toggle) {
        continue; // 「会话」与「关于」没有折叠头（原生排版里「关于」有，会话永远没有）
      }
      toggle.addEventListener("click", () => {
        setCardCollapsed(key, cardCollapsed[key] !== true, true);
      });
      setCardCollapsed(key, cardCollapsed[key] === true, false);
    }

    // 「最近输出」「操作输出」折叠块：对应操作产生终端输出时自动展开（维护者要求）。
    const logDetails = $<HTMLElement>("log").closest("details");
    const bridgeOutputDetails = $<HTMLElement>("bridge-output").closest("details");
    const expandLog = (): void => {
      if (logDetails) {
        logDetails.open = true;
      }
    };
    const expandBridgeOutput = (): void => {
      if (bridgeOutputDetails) {
        bridgeOutputDetails.open = true;
      }
    };

    /** 日志块右侧的「复制」：先走剪贴板 API，不可用时退回「选中 + execCommand」。 */
    function copyLog(pre: HTMLPreElement, button: HTMLButtonElement): void {
      void (async () => {
        const text = pre.textContent ?? "";
        const flash = (label: string): void => {
          button.textContent = label;
          window.setTimeout(() => {
            button.textContent = "复制";
          }, 1500);
        };
        try {
          if (!navigator.clipboard?.writeText) {
            throw new Error("剪贴板 API 不可用");
          }
          await navigator.clipboard.writeText(text);
          flash("已复制");
          return;
        } catch {
          // 兜底：临时选中文本交给浏览器复制（WebView2 支持 execCommand）。
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(pre);
          selection?.removeAllRanges();
          selection?.addRange(range);
          const ok = document.execCommand("copy");
          selection?.removeAllRanges();
          flash(ok ? "已复制" : "复制失败");
        }
      })();
    }

    // 复制按钮悬浮在日志区右上角（不在 <summary> 里），点它不会折叠日志块。
    for (const [button, pre] of [
      [btnCopyLog, logEl],
      [btnCopyBridgeOutput, bridgeOutput],
    ] as const) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        copyLog(pre, button);
      });
    }

    // 桥接插件卡片状态：busy 防重复点击；lastBridgeState 供「恢复最近备份」用。
    let bridgeBusy = false;
    let lastBridgeState: BridgeState | null = null;

    // ---- 端口字段：托管值提示 + 覆盖状态 + 输入校验 --------------------------

    let portHint: PortHint | null = null;

    /** 端口输入的即时校验；为空 = 不覆盖（合法）。 */
    function portFieldError(): string | null {
      const raw = portInput.value.trim();
      if (raw === "") {
        return null;
      }
      if (!/^\d+$/.test(raw)) {
        return "端口必须是 1-65535 的整数（留空表示跟随 DSH 配置）";
      }
      const value = Number.parseInt(raw, 10);
      if (value < 1 || value > 65535) {
        return "端口超出范围：必须是 1-65535 的整数";
      }
      return null;
    }

    /** 端口说明写进标签后的 ⓘ 气泡：动态状态 + 原来那行小字里「所有启动方式共用这两个字段」的固定说明。 */
    function setPortTip(text: string): void {
      portInfoEl.dataset.tip = `${text}四种启动方式共用这两个字段，运行环境选 WSL 时同样生效（壳注入的端口覆盖层会经 /mnt 路径送进发行版）。配置改完自动保存，重开壳后保留。`;
    }

    /** 附加参数里的 `--port` / `--host`：它们会盖掉 profile 的 webserver 配置，提示里要说清。 */
    function extraArgFlag(name: string): string | null {
      const args = extraInput.value.trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === name) return args[i + 1] ?? "";
        if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
      }
      return null;
    }

    function renderPortHint(): void {
      const raw = portInput.value.trim();
      // 输入框提示显示 DSH 配置里的真实端口（读不到就显示默认 3080）：只是提示文字，
      // 不参与保存，「留空 = 跟随 DSH 配置」的语义不变。
      const managedPort = portHint !== null && portHint.source === "managed" ? portHint.port : null;
      portInput.placeholder = String(managedPort ?? 3080);
      // 空 = 本来就跟配置走，没有可还原的东西。
      portReset.disabled = raw === "";
      const flagPort = extraArgFlag("--port");
      const flagHost = extraArgFlag("--host");
      // 谁真正生效：profile 里写死的 webserver 块压过 DSH 的 --port / --host（真机实测：
      // profile 写 3080 + `--port 3097` 仍监听 3080，profile 写 192.168.1.7 时
      // `--host 127.0.0.1` 也不生效）；只有 profile 没写那项时附加参数才轮得到。
      const managedHost = portHint !== null && portHint.source === "managed" ? portHint.host : null;
      const overridden: string[] = [];
      if (flagPort !== null && managedPort !== null) overridden.push("--port");
      if (flagHost !== null && managedHost !== null) overridden.push("--host");
      const wins: string[] = [];
      if (flagPort !== null && managedPort === null) wins.push(`--port ${flagPort || "（缺值）"}`);
      if (flagHost !== null && managedHost === null) wins.push(`--host ${flagHost || "（缺值）"}`);
      const flagNote =
        overridden.length > 0 || wins.length > 0
          ? `${overridden.length > 0 ? `注意：附加参数里的 ${overridden.join(" / ")} 不生效——DSH 配置的 webserver 块已写死，优先级更高。` : ""}${wins.length > 0 ? `注意：附加参数里的 ${wins.join("、")} 会盖掉下面的配置。` : ""}`
          : "";
      if (!portHint) {
        setPortTip(flagNote || "正在读取 DSH 配置…");
        return;
      }
      if (portHint.source === "managed" && portHint.port !== null) {
        const host = portHint.host ? `host ${portHint.host}，` : "";
        setPortTip(`${flagNote}当前生效值：${portHint.port}（来自 DSH 配置的 webserver 块，${host}留空时不动它；自定义端口会保留 host）。`);
      } else {
        setPortTip(`${flagNote}未读到 DSH 端口配置（默认 3080）；留空则完全不干预。`);
      }
    }

    async function refreshPortHint(): Promise<void> {
      try {
        portHint = await invoke<PortHint>("profile_port_hint", { config: collectConfig() });
      } catch (err) {
        portHint = null;
        console.error("读取端口提示失败:", err);
      }
      renderPortHint();
    }

    /** 静默保存当前配置（编辑中暂时不合法时跳过，启动时会再校验）。 */
    async function persistConfigQuiet(): Promise<void> {
      if (portFieldError()) {
        renderPortHint();
        return;
      }
      try {
        const shell: ShellConfig = {
          launch: collectConfig(),
          trayClick: trayPicker.value as TrayClick,
          lightDelaySecs: Number(lightDelayPicker.value),
          // 主题镜像一致即可；写进 save_shell_config 会被整份串行化，若不一致也顺手对齐
          // （正常路径由 switchTheme 单独走 save_ui_theme）。
          uiTheme: theme,
          // 三张新卡的六个字段本版没有界面控件，但必须原样带上：整份回写会把漏掉的键
          // 抹回默认值。值来自后端读回（缺字段时为 normalizePrefs 补的默认）。
          ...prefs,
        };
        await invoke("save_shell_config", { config: shell });
        // 配置已回到合法状态：把之前因非法输入显示的错误消掉。
        if (localError) {
          localError = null;
          await refresh();
        }
      } catch (err) {
        console.debug("配置暂未保存:", err);
      }
    }

    const modeRadios = () => Array.from(root.querySelectorAll<HTMLInputElement>('input[name="mode"]'));
    const currentMode = (): string => modeRadios().find((r) => r.checked)?.value ?? "npx";

    function syncModeFields(): void {
      $("npx-fields").classList.toggle("hidden", currentMode() !== "npx");
      $("binary-fields").classList.toggle("hidden", currentMode() !== "binary");
      $("custom-fields").classList.toggle("hidden", currentMode() !== "custom");
      // 卡片收起后靠这个徽章显示当前启动方式（展开时徽章隐藏，见 CSS）。
      const mode = currentMode();
      modesSummary.textContent = MODE_LABELS[mode] ?? "启动方式";
      // 桥接插件与端口提示都跟随运行环境（Windows 宿主 / WSL 发行版），换模式就刷新。
      void refreshBridgeState();
      void refreshPortHint();
    }
    for (const radio of modeRadios()) {
      radio.addEventListener("change", () => {
        syncModeFields();
        void persistConfigQuiet();
      });
    }
    syncModeFields();

    function collectConfig(): LaunchConfig {
      const extraArgs = extraInput.value.trim().split(/\s+/).filter(Boolean);
      const raw = portInput.value.trim();
      // 端口输入非法时调用方（启动/保存）会先报错拦截；这里兜底按 null 处理。
      const parsed = raw === "" ? null : Number.parseInt(raw, 10);
      const port = parsed !== null && Number.isFinite(parsed) ? parsed : null;
      // 运行环境只对「官方 npx」「自定义命令」生效；另外两种固定跑 Windows 宿主，
      // 写盘时按默认值序列化，避免下拉里残留的 WSL 值跟着进配置文件（否则壳会
      // 把桥接插件装进发行版、按 WSL 算探测地址）。壳级共享的 runtime 不变。
      const mode = currentMode();
      const effectiveRuntime: LaunchRuntime =
        mode === "npx" || mode === "custom" ? runtime : { kind: "default" };
      const base = { runtime: effectiveRuntime, extraArgs, port };
      switch (mode) {
        case "system":
          return { ...base, mode: { kind: "system" } };
        case "binary":
          return { ...base, mode: { kind: "binary", path: binaryPath.value.trim() } };
        case "custom":
          return { ...base, mode: { kind: "custom", command: customCommand.value.trim() } };
        default:
          return { ...base, mode: { kind: "npx", channel: currentChannel(), version: currentVersion() } };
      }
    }

    // 配置自动保存：任一字段变更后尝试写盘（当前不合法时不写、不打扰；启动时会再校验）。
    // 自绘下拉框（托盘单击打开 / 运行环境 / 渠道 / 版本）的回调在构造时已接进 persistConfigQuiet。
    for (const input of [extraInput, binaryPath, customCommand, portInput]) {
      input.addEventListener("change", () => void persistConfigQuiet());
    }
    // 附加参数里可能写了 --port / --host，改完立刻刷新端口气泡里的「以它为准」提示。
    extraInput.addEventListener("input", () => renderPortHint());
    // 「指定程序路径」：点「浏览…」弹系统「打开文件」框（默认只列可执行文件），选完写入输入框并
    // 即时校验；手打/粘贴的路径在失焦时校验。红字只是提前提醒，不拦启动（启动时后端仍会校验）。
    binaryBrowse.addEventListener("click", () => void pickBinaryPath());
    binaryPath.addEventListener("blur", () => void checkBinaryPath());

    async function pickBinaryPath(): Promise<void> {
      let picked: string | string[] | null;
      try {
        picked = await openFileDialog({
          multiple: false,
          directory: false,
          filters: [
            { name: "可执行文件", extensions: ["exe", "cmd", "bat"] },
            { name: "所有文件", extensions: ["*"] },
          ],
        });
      } catch (err) {
        // 弹框失败（多半是缺少 dialog 权限）也要说清楚，不能静默。
        showBinaryError(`打开文件对话框失败：${String(err)}`);
        return;
      }
      if (typeof picked !== "string") return; // 用户取消：输入框保持原样
      binaryPath.value = picked;
      void persistConfigQuiet();
      await checkBinaryPath();
    }

    /** 校验「指定程序路径」并在字段下方显示/清除红字；空值当作「还没填」，不提示。 */
    async function checkBinaryPath(): Promise<void> {
      const path = binaryPath.value.trim();
      if (!path) {
        hideBinaryError();
        return;
      }
      try {
        await invoke("check_binary_path", { path });
        hideBinaryError();
      } catch (err) {
        showBinaryError(String(err));
      }
    }

    function showBinaryError(message: string): void {
      binaryError.textContent = message;
      binaryError.classList.remove("hidden");
    }

    function hideBinaryError(): void {
      binaryError.textContent = "";
      binaryError.classList.add("hidden");
    }
    // 端口：输入即刷新提示与「还原」按钮（不含程序化赋值）；失焦再刷新一次保证同步。
    portInput.addEventListener("input", renderPortHint);
    portInput.addEventListener("change", renderPortHint);
    // 「还原」：清空输入框并派发 input/change，走与手打完全相同的自动保存路径。
    portReset.addEventListener("click", () => {
      portInput.value = "";
      portInput.dispatchEvent(new Event("input", { bubbles: true }));
      portInput.dispatchEvent(new Event("change", { bubbles: true }));
      portInput.focus();
    });
    // 「原生」主题的端口是 I 的 NumberBox，带上下箭头；原版那个文本框里没有按钮，
    // 这段就取不到元素、自然不生效。基准值取「当前输入 > 已读到的生效端口 > 3080」。
    for (const spin of Array.from(root.querySelectorAll<HTMLButtonElement>("#port ~ .spins .spin, .port-row .step.num .spin"))) {
      spin.addEventListener("click", () => {
        const step = Number.parseInt(spin.dataset.step ?? "1", 10);
        const typed = Number.parseInt(portInput.value.trim(), 10);
        const base = Number.isFinite(typed) ? typed : portHint?.port ?? 3080;
        portInput.value = String(Math.min(65535, Math.max(1, base + step)));
        portInput.dispatchEvent(new Event("input", { bubbles: true }));
        portInput.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    // 启动/停止失败时后端返回的错误（与轮询到的会话错误分开保存，
    // 否则下一次轮询（每秒一次）会把刚显示的错误清掉）。
    let localError: string | null = null;

    /** 把说明写进登录徽章的感叹号气泡（悬停或键盘聚焦时显示）。 */
    function setLoginTip(text: string): void {
      loginInfo.dataset.tip = text;
      loginInfo.setAttribute("aria-label", `登录链接说明：${text}`);
    }

    /**
     * 输出块（「最近输出」「操作输出」）的文本更新。
     *
     * 状态每秒轮询一次，每次都把同一个字符串重新赋给 `textContent`；换掉文本节点本身就会清掉选区，
     * 表现就是「拖选几段、一松手就没了」。所以：文本没变就不动 DOM，用户正在这块里框选（选区未折叠）
     * 也先不动。轮询每 1 秒重跑一次，等用户点别处解除选区后自然会补上。
     */
    function setOutputText(el: HTMLElement, text: string): void {
      if (el.textContent === text || hasSelectionWithin(el)) {
        return;
      }
      el.textContent = text;
    }

    /** 选区（含折叠判定）是否落在这个元素里：跨块拖选时 anchor 与 focus 任一端在内就算。 */
    function hasSelectionWithin(el: HTMLElement): boolean {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return false;
      }
      return [selection.anchorNode, selection.focusNode].some((node) => node !== null && el.contains(node));
    }

    /**
     * 操作输出的结果文案（安装 / 卸载 / 回滚 / 打开备份目录的反馈）必须落地，不能被选区挡住，
     * 所以写之前先放下用户在这块里的选区；每秒轮询的「最近输出」走 setOutputText，不动选区。
     */
    function setBridgeOutput(text: string): void {
      const selection = window.getSelection();
      if (selection && hasSelectionWithin(bridgeOutput)) {
        selection.removeAllRanges();
      }
      bridgeOutput.textContent = text;
    }

    /** 最近一次渲染的状态：「启动 / 停止」合并成一个按钮，靠它决定该发哪条命令。 */
    let currentStatus: SessionStatus | null = null;

    /** 上次渲染的按钮形态：render 每秒跑一次，只在跨状态时重建 DOM。
     * 初始就是 swap（buildHtml 的标记带 .swap），第一轮 render 不必重建。 */
    let toggleMode: "swap" | "plain" | null = "swap";

    /**
     * 渲染「启动 / 停止」按钮：停止态用两组文字做逐字切换（样式在 style.css 的 #btn-toggle.swap），
     * 运行态是普通纯文本按钮。两种形态只在切换时重建一次。
     * （TOGGLE_TEXT_* / charsToSpans / 初始 swap 标记在模块级，buildHtml 也要用。）
     */
    function renderToggleButton(stopped: boolean): void {
      const mode = stopped ? "swap" : "plain";
      if (mode === toggleMode) return;
      toggleMode = mode;
      if (!stopped) {
        btnToggle.classList.remove("swap");
        btnToggle.removeAttribute("aria-label");
        // 「停止」与其余三颗会话按钮一样带图标段（悬停展开效果由 CSS 统一处理）。
        btnToggle.innerHTML = `<span class="btn-text">停止</span><span class="btn-ico" aria-hidden="true">${ICON_STOP}</span>`;
        return;
      }
      btnToggle.classList.add("swap");
      btnToggle.setAttribute("aria-label", TOGGLE_TEXT_REST);
      btnToggle.innerHTML = toggleSwapHtml();
    }

    function render(status: SessionStatus): void {
      currentStatus = status;
      const starting = isStarting(status);
      badge.className = `badge ${starting ? "badge-starting" : status.state === "running" ? "badge-running" : status.state === "failed" ? "badge-failed" : "badge-stopped"}`;
      statusText.textContent = starting ? "启动中" : status.state === "running" ? "运行中" : status.state === "failed" ? "启动失败" : "已停止";
      statusSpinner.classList.toggle("hidden", !starting);
      // DSH 版本：后端在每次成功启动后异步补上，重启壳后为「未知」直到再次启动。
      versionText.textContent = status.dshVersion ? `DSH v${status.dshVersion}` : "DSH 版本未知";
      aboutDsh.textContent = status.dshVersion ?? "未知";
      pidEl.textContent = status.pid === null ? "—" : String(status.pid);
      portEl.textContent = status.port === null ? "—" : String(status.port);
      const message = localError ?? status.error;
      if (message) {
        errorEl.textContent = message;
        errorEl.classList.remove("hidden");
      } else {
        errorEl.textContent = "";
        errorEl.classList.add("hidden");
      }
      setOutputText(logEl, status.logTail.length > 0 ? status.logTail.join("\n") : "（暂无输出）");
      const running = status.state === "running";
      // 「启动 DSH」与「停止」是同一个按钮（维护者要求）：按状态换文案与语义。
      // 后端只在子进程还活着时给 Running，Failed 必然是进程已退出，所以按 running 二分就够。
      renderToggleButton(!running);
      btnToggle.classList.toggle("primary", !running);
      // 「重启 DSH」只在运行中出现（维护者要求）：启动前整个界面只有一个「启动 DSH」，
      // 起来之后才同时给出「停止 / 重启 DSH」。
      btnRestart.classList.toggle("hidden", !running);
      // 「应用内打开 / 浏览器打开」整组也只在运行后出现（维护者要求）：启动前按钮行整行就是「启动 DSH」。
      actionsOpen.classList.toggle("hidden", !running);

      // 登录链接徽章：桥接就绪 > 日志兜底就绪 > 等待中 > 获取失败。
      // 正常状态的细节说明放在徽章的感叹号气泡里（维护者要求），失败信息仍留在行内便于直接排查。
      if (status.loginReady) {
        const viaBridge = status.loginChannel === "bridge";
        loginBadge.className = "badge badge-running";
        loginText.textContent = viaBridge ? "桥接就绪" : "日志兜底就绪";
        setLoginTip(
          viaBridge
            ? "已通过桥接插件取得带 token 的登录链接。"
            : "桥接插件未启用，已从启动日志解析出带 token 的登录链接（可用，但依赖 DSH 的日志格式）。",
        );
        loginNote.classList.add("hidden");
      } else if (status.loginError) {
        loginBadge.className = "badge badge-failed";
        loginText.textContent = "登录获取失败";
        setLoginTip(status.loginError);
        loginNote.textContent = status.loginError;
        loginNote.classList.remove("hidden");
      } else {
        loginBadge.className = "badge badge-stopped";
        loginText.textContent = running ? "登录等待中…" : "登录等待中";
        setLoginTip("登录链接就绪后即可打开 DSH 界面。");
        loginNote.classList.add("hidden");
      }
      btnOpenApp.disabled = !status.loginReady;
      btnOpenBrowser.disabled = !status.loginReady;
      // 「重启 DSH」的持续转动：拿这次状态过一遍收场条件（每秒轮询都会走到这里）。
      updateRestartSpin(status, starting);
      // 日志会不断长个儿，顺带把滚动指示条的几何刷新一下（这里只算不显示）。
      updateScrollThumbHook();
    }

    async function refresh(): Promise<void> {
      try {
        render(await invoke<SessionStatus>("dsh_status"));
      } catch (err) {
        console.error("查询状态失败:", err);
      }
    }
    requestStatusRefresh = refresh;

    /** 按当前界面配置启动 DSH；`restart_dsh` 会先停掉现有会话再拉起（「启动」与「重启」共用）。 */
    async function startOrRestart(command: "start_dsh" | "restart_dsh"): Promise<void> {
      localError = null;
      // 端口非法输入：明确提示、不保存、不启动。
      const portError = portFieldError();
      if (portError) {
        localError = portError;
        // 重启点击时已经开始转（beginRestartSpin），命令没发出去就别转了。
        endRestartSpin();
        await refresh();
        return;
      }
      // 启动/重启 DSH 都会产生终端输出：自动展开「最近输出」（维护者要求）。
      expandLog();
      try {
        await invoke(command, { config: collectConfig() });
      } catch (err) {
        localError = String(err);
        // 命令被后端拒绝（如端口占用）：重启没真正发生，立即收拾掉点击时的转动。
        if (command === "restart_dsh") endRestartSpin();
      }
      await refresh();
    }

    // 「启动 DSH / 停止」同一个按钮：运行中（含「启动中」）点击是停止，否则是启动（失败后也是重新启动）。
    // 转动中按下「停止」= 主动打断重启：转动立即停（维护者规格），剩下的交给 stop_dsh。
    btnToggle.addEventListener("click", () => {
      if (currentStatus?.state === "running") {
        endRestartSpin();
        void stopDsh();
        return;
      }
      void startOrRestart("start_dsh");
    });
    // 「重启 DSH」：点击瞬间开始持续转动（不等悬停漫过的 300ms 提前量），转动期间照旧可点、重点即重新计时。
    btnRestart.addEventListener("click", () => {
      beginRestartSpin();
      void startOrRestart("restart_dsh");
    });

    async function stopDsh(): Promise<void> {
      localError = null;
      expandLog();
      try {
        await invoke("stop_dsh");
      } catch (err) {
        localError = String(err);
      }
      await refresh();
    }

    // 「应用内打开」：每次点击都重新取当前登录链接（token 是一次性铸造的）。
    btnOpenApp.addEventListener("click", () => {
      void (async () => {
        localError = null;
        try {
          await invoke("open_dsh_window");
        } catch (err) {
          localError = String(err);
          await refresh();
        }
      })();
    });

    // 「浏览器打开」：显式把登录链接交给系统默认浏览器（壳的默认流程不弹浏览器）。
    btnOpenBrowser.addEventListener("click", () => {
      void (async () => {
        localError = null;
        try {
          await invoke("open_dsh_in_browser");
        } catch (err) {
          localError = String(err);
          await refresh();
        }
      })();
    });

    function updateBridgeButtons(): void {
      btnBridgeInstall.disabled = bridgeBusy;
      btnBridgeUninstall.disabled = bridgeBusy;
      btnBridgeRestore.disabled = bridgeBusy;
    }

    async function refreshBridgeState(): Promise<void> {
      try {
        const state = await invoke<BridgeState>("bridge_state", { config: collectConfig() });
        lastBridgeState = state;
        bridgeTarget.textContent = state.target;
        bridgeStatus.textContent = state.installed ? "已安装（优先走桥接通道）" : "未安装（走日志兜底）";
        // 卡片收起后靠这个徽章显示安装状态（展开时徽章隐藏，见 CSS）。
        bridgeSummary.className = `badge ${state.installed ? "badge-running" : "badge-stopped"} card-summary`;
        bridgeSummary.textContent = state.installed ? "已安装" : "未安装";
        bridgeBackup.textContent = state.latestBackup
          ? `最近备份：${state.latestBackup}`
          : "还没有备份：安装或卸载时会自动创建，可用「恢复最近备份」回滚。";
      } catch (err) {
        bridgeStatus.textContent = `读取失败：${err}`;
        bridgeSummary.className = "badge badge-failed card-summary";
        bridgeSummary.textContent = "读取失败";
      }
    }

    function runBridgeOp(name: "bridge_install" | "bridge_uninstall"): void {
      void (async () => {
        bridgeBusy = true;
        updateBridgeButtons();
        bridgeError.classList.add("hidden");
        // 桥接操作会产生 pnpm/命令的终端输出：自动展开卡片与「操作输出」（维护者要求）。
        expandCard("bridge");
        expandBridgeOutput();
        setBridgeOutput("执行中…（首次可能较慢，pnpm 需要解析依赖）");
        try {
          const outcome = await invoke<BridgeOutcome>(name, { config: collectConfig() });
          setBridgeOutput(outcome.message);
          if (!outcome.ok) {
            bridgeError.textContent = "命令返回非成功状态，请看下方输出与备份目录。";
            bridgeError.classList.remove("hidden");
          }
        } catch (err) {
          bridgeError.textContent = String(err);
          bridgeError.classList.remove("hidden");
        } finally {
          bridgeBusy = false;
          updateBridgeButtons();
          await refreshBridgeState();
        }
      })();
    }

    btnBridgeInstall.addEventListener("click", () => runBridgeOp("bridge_install"));
    btnBridgeUninstall.addEventListener("click", () => runBridgeOp("bridge_uninstall"));
    btnBridgeRestore.addEventListener("click", () => {
      void (async () => {
        const backup = lastBridgeState?.latestBackup;
        if (!backup) {
          bridgeError.textContent = "还没有可恢复的备份：先执行一次安装或卸载，壳会自动创建备份。";
          bridgeError.classList.remove("hidden");
          return;
        }
        bridgeBusy = true;
        updateBridgeButtons();
        try {
          // 恢复同样产生终端输出：自动展开卡片与「操作输出」。
          expandCard("bridge");
          expandBridgeOutput();
          const message = await invoke<string>("bridge_restore", {
            config: collectConfig(),
            backupDir: backup,
          });
          setBridgeOutput(message);
          bridgeError.classList.add("hidden");
        } catch (err) {
          bridgeError.textContent = String(err);
          bridgeError.classList.remove("hidden");
        } finally {
          bridgeBusy = false;
          updateBridgeButtons();
          await refreshBridgeState();
        }
      })();
    });

    /** 「桥接插件」卡片：在资源管理器里打开备份目录（安装/卸载的备份都落在这里）。 */
    btnBridgeBackups.addEventListener("click", () => {
      void (async () => {
        bridgeNote.classList.add("hidden");
        try {
          const path = await invoke<string>("open_shell_dir", { kind: "backups" });
          bridgeNote.textContent = `已在资源管理器中打开备份目录：${path}`;
          bridgeNote.classList.remove("hidden");
        } catch (err) {
          bridgeNote.textContent = `打开备份目录失败：${err}`;
          bridgeNote.classList.remove("hidden");
        }
      })();
    });

    /** 「关于」卡片：打开项目仓库 / DSH 官网（URL 固定在 Rust 侧，界面只传目标键）。 */
    function openExternal(target: "repo" | "site"): void {
      void (async () => {
        aboutNote.classList.add("hidden");
        try {
          await invoke("open_external", { target });
        } catch (err) {
          aboutNote.textContent = `打开失败：${err}`;
          aboutNote.classList.remove("hidden");
        }
      })();
    }

    /** 「关于」卡片：在系统文件管理器里打开壳配置目录 / DSH 日志目录。 */
    function openShellDir(kind: "config" | "logs"): void {
      void (async () => {
        aboutNote.classList.add("hidden");
        try {
          const path = await invoke<string>("open_shell_dir", { kind });
          aboutNote.textContent = `已在资源管理器中打开：${path}`;
          aboutNote.classList.remove("hidden");
        } catch (err) {
          aboutNote.textContent = `打开目录失败：${err}`;
          aboutNote.classList.remove("hidden");
        }
      })();
    }

    btnAboutRepo.addEventListener("click", () => openExternal("repo"));
    btnAboutSite.addEventListener("click", () => openExternal("site"));
    btnAboutConfig.addEventListener("click", () => openShellDir("config"));
    btnAboutLogs.addEventListener("click", () => openShellDir("logs"));


    // 自绘标题栏的窗口按钮（「系统原生」主题用系统标题栏，没有这三个按钮）。
    // 拖拽与双击最大化由 data-tauri-drag-region 交给系统处理，这里只发最小化 /
    // 最大化切换 / 关闭；关窗命令和原生关闭按钮走同一条路径，最终由 Rust 侧的
    // CloseRequested 拦下来转成轻量模式。
    if (btnWinMin && btnWinMax && btnWinClose) {
      const minButton = btnWinMin;
      const maxButton = btnWinMax;
      const closeButton = btnWinClose;
      try {
        const appWindow = getCurrentWindow();
        const windowButtons: Array<[HTMLButtonElement, () => Promise<void>]> = [
          [minButton, () => appWindow.minimize()],
          [maxButton, () => appWindow.toggleMaximize()],
          [closeButton, () => appWindow.close()],
        ];
        for (const [button, action] of windowButtons) {
          button.addEventListener("click", () => {
            void action().catch((err) => console.error("窗口操作失败:", err));
          });
        }
      } catch (err) {
        // 普通浏览器里没有 Tauri 窗口环境（预览用），按钮保留但点了没反应。
        console.error("无法获取当前窗口:", err);
      }

      // 最大化后按钮应该显示「还原」（两个叠放的方框）。窗口尺寸一变就同步一次：
      // 最大化 / 还原 / 贴靠 / 拖边缩放都会改视图尺寸，所以监 window.resize 就够，
      // 不必再走 Tauri 的窗口事件通道。监听跨主题重建只注册一次（见 main 尾部），
      // 这里只把钩子换成新界面上的按钮。
      syncMaximizeIconHook = (): void => {
        try {
          void getCurrentWindow()
            .isMaximized()
            .then((maximized) => {
              maxButton.innerHTML = maximized ? ICON_RESTORE : ICON_MAXIMIZE;
              const label = maximized ? "还原" : "最大化";
              maxButton.title = label;
              maxButton.setAttribute("aria-label", label);
            });
        } catch (err) {
          console.error("读取窗口最大化状态失败:", err);
        }
      };
      syncMaximizeIconHook();
    }

    /** 首启/重开壳时把已保存的设置填回界面（后端缺省时返回默认值）。 */
    async function loadSavedConfig(): Promise<void> {
      let saved: ShellConfig;
      try {
        saved = await invoke<ShellConfig>("load_shell_config");
      } catch (err) {
        console.error("读取已保存配置失败:", err);
        return;
      }
      const launch = saved.launch;
      // 环境 / 网络 / 集成的六个字段：缺键、坏值在这里统一兜底成默认（与 Rust 侧宽容读取同语义），
      // 以后每次保存都按这份值原样回写。
      prefs = normalizePrefs(saved);
      const radio = modeRadios().find((r) => r.value === launch.mode.kind);
      if (radio) {
        radio.checked = true;
      }
      if (launch.mode.kind === "binary") {
        binaryPath.value = launch.mode.path;
      }
      if (launch.mode.kind === "custom") {
        customCommand.value = launch.mode.command;
      }
      // 运行环境：旧配置没有 runtime 字段就是 default（后端 fallback 也是这个值）。
      runtime = launch.runtime ?? { kind: "default" };
      syncRuntimePickers();
      if (launch.mode.kind === "npx") {
        npxChannelPicker.setValue(launch.mode.channel ?? "latest");
        // 具体版本要等版本列表回来再回填，否则会被 setChoices 退回第一项。
        pendingVersion = launch.mode.version ?? null;
      }
      extraInput.value = launch.extraArgs.join(" ");
      if (launch.port !== null && launch.port !== undefined) {
        portInput.value = String(launch.port);
      }
      trayPicker.setValue(saved.trayClick);
      // 缺字段或值不在候选集合时回落「立即」。
      const lightDelay = String(saved.lightDelaySecs ?? 0);
      lightDelayPicker.setValue(LIGHT_DELAY_CHOICES.some((choice) => choice.value === lightDelay) ? lightDelay : "0");
      syncModeFields();
      renderPortHint();
      renderChannelUI();
    }

    await loadSavedConfig();
    // 运行环境候选与官方版本列表都提前读好，展开卡片即可选。
    await loadDistros();
    await loadRegistry();
    await refreshPortHint();
    await refresh();
    void refreshBridgeState();
    refreshNowHook = refresh;
    // 切主题会重建整个界面：转动状态与计时在模块级，这里把类重新贴到新的那颗「重启 DSH」上。
    applyRestartSpin();
  }

  /** 把主题镜像给 Rust（ui_theme）：开窗处要在页面加载前决定窗口装饰（见 save_ui_theme）。 */
  function syncThemeToShell(next: ThemeId): void {
    invoke("save_ui_theme", { theme: next }).catch((err) => {
      // 失败只影响下次开窗的头一帧（可能闪一次自绘标题栏），本次界面不受影响。
      console.debug("镜像主题到外壳失败:", err);
    });
  }

  /** 换主题：记下来（下次启动沿用）→ 按主题重建界面 → 调整窗口边框与标题栏。 */
  async function switchTheme(next: ThemeId): Promise<void> {
    theme = next;
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // 存不下（隐私模式）也不影响这次切换，只是下次启动回到默认。
    }
    // Rust 侧镜像同步要先行：万一用户在界面重建/窗口调整完成前关掉壳，
    // 下次开窗也能按新主题出装饰。
    syncThemeToShell(next);
    // 先挂界面再调窗口：标题栏颜色要取新主题的界面底色。
    await mount(next);
    await applyWindowChrome(next);
  }

  /** 当前界面底色，换算成 Windows 的 COLORREF（0x00BBGGRR）；解析不出来就返回 null。 */
  function bodyColorRef(): number | null {
    const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(
      window.getComputedStyle(document.body).backgroundColor,
    );
    if (!match) {
      return null;
    }
    const [red, green, blue] = match.slice(1).map(Number);
    return ((red & 0xff) << 0) | ((green & 0xff) << 8) | ((blue & 0xff) << 16);
  }

  /** 「系统原生」主题用系统标题栏，另外两套用自绘的（见 buildHtml 里的标题栏）。 */
  async function applyWindowChrome(target: ThemeId): Promise<void> {
    try {
      const appWindow = getCurrentWindow();
      const wanted = isNativeLayout(target);
      if ((await appWindow.isDecorated()) !== wanted) {
        await appWindow.setDecorations(wanted);
      }
      // 系统标题栏的颜色跟窗口的浅色/深色走：界面本身是深色（#202020，Win11 深色
      // 标题栏正好也是这个色），所以有系统标题栏时把窗口钉成深色，免得 Windows 用
      // 浅色模式时顶上多一条亮带。另外两套是自绘标题栏，交回系统即可（null）。
      await appWindow.setTheme(wanted ? "dark" : null);
      // 光钉深色还不够：Windows 的标题栏带透明度（受壁纸色调影响），实测会偏蓝，
      // 跟界面底色对不齐，所以直接把这一条染成界面底色；另外两套交回系统。
      await invoke("set_caption_color", { color: wanted ? bodyColorRef() : null });
    } catch (err) {
      // 普通浏览器里没有窗口对象（预览用）。
      console.error("调整窗口外观失败:", err);
    }
  }

  // 自绘滚动指示条：视口的原生滚动条已在 style.css 里藏起来，滚动时右边缘浮出
  // 一条细胶囊，停手约 1 秒后淡出。只做视觉，不拦事件（pointer-events: none），
  // 滚轮 / 键盘 / 触控板照旧；轨道从标题栏下面开始，不会压在窗口按钮上。
  const scrollTrack = document.createElement("div");
  scrollTrack.className = "scroll-track";
  const scrollThumb = document.createElement("div");
  scrollThumb.className = "scroll-thumb";
  scrollTrack.appendChild(scrollThumb);
  document.body.appendChild(scrollTrack);

  const updateScrollThumb = (): void => {
    const doc = document.documentElement;
    const viewport = doc.clientHeight;
    const total = doc.scrollHeight;
    const trackHeight = scrollTrack.clientHeight;
    if (total <= viewport + 1 || trackHeight <= 0) {
      scrollThumb.style.height = "0px";
      return;
    }
    const height = Math.max(28, (viewport / total) * trackHeight);
    const top = (doc.scrollTop / (total - viewport)) * (trackHeight - height);
    scrollThumb.style.height = `${height}px`;
    scrollThumb.style.transform = `translateY(${top}px)`;
  };

  let scrollIdleTimer = 0;
  let dragState: { pointerId: number; startY: number; startScrollTop: number; scale: number } | null = null;
  const showScrollThumb = (): void => {
    scrollThumb.classList.add("visible");
    window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = window.setTimeout(() => scrollThumb.classList.remove("visible"), 900);
  };
  window.addEventListener(
    "scroll",
    () => {
      updateScrollThumb();
      // 拖动期间不跑这个计时器，否则按住不动 0.9 秒胶囊会在手里淡掉
      if (!dragState) showScrollThumb();
    },
    { passive: true },
  );
  window.addEventListener("resize", updateScrollThumb);

  // 按住胶囊上下拖 = 直接改滚动位置。轨道在右侧那条细带上收指针事件（悬停显示），
  // 指针一旦离开就松手；位移按「胶囊能走的距离 ↔ 内容还能滚的距离」等比换算。
  scrollThumb.addEventListener("pointerdown", (event) => {
    const doc = document.documentElement;
    const travel = scrollTrack.clientHeight - scrollThumb.offsetHeight;
    const scrollable = doc.scrollHeight - doc.clientHeight;
    if (travel <= 0 || scrollable <= 1) return;
    event.preventDefault();
    dragState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: doc.scrollTop,
      scale: scrollable / travel,
    };
    scrollThumb.setPointerCapture(event.pointerId);
    scrollThumb.classList.add("dragging");
  });
  scrollThumb.addEventListener("pointermove", (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    document.documentElement.scrollTop = dragState.startScrollTop + (event.clientY - dragState.startY) * dragState.scale;
  });
  const endScrollDrag = (event: PointerEvent): void => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    dragState = null;
    scrollThumb.classList.remove("dragging");
    if (scrollThumb.hasPointerCapture(event.pointerId)) scrollThumb.releasePointerCapture(event.pointerId);
    showScrollThumb();
  };
  scrollThumb.addEventListener("pointerup", endScrollDrag);
  scrollThumb.addEventListener("pointercancel", endScrollDrag);

  updateScrollThumb();

  // 「最大化」图标同步与 1 秒状态轮询都跨主题重建，只注册一次。
  window.addEventListener("resize", () => syncMaximizeIconHook());
  window.setInterval(() => void refreshNowHook(), 1000);
  updateScrollThumbHook = updateScrollThumb;

  // 先挂界面再调窗口：标题栏颜色要取新主题的界面底色。
  // 主题镜像给 Rust：老配置里没有这份镜像（主题本来只存 localStorage），启动时补齐，
  // 下次开窗（含托盘重开）就能第一时间按主题出系统标题栏/自绘标题栏。
  syncThemeToShell(theme);
  await mount(theme);
  await applyWindowChrome(theme);
}

void main();
