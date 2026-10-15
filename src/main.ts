import { invoke } from "@tauri-apps/api/core";
import "./style.css";

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

/** 与 Rust 侧 `launch::LaunchMode`（serde tag = kind）一一对应。 */
type LaunchMode =
  | { kind: "npx" }
  | { kind: "system" }
  | { kind: "binary"; path: string }
  | { kind: "wsl"; distro: string; inner: string };

interface LaunchConfig {
  mode: LaunchMode;
  extraArgs: string[];
  /** 端口覆盖：null = 跟随 DSH 自身配置；数字 = 壳注入 launcher 层覆盖。 */
  port: number | null;
}

/** 与 Rust 侧 `settings::TrayClick` 对应：托盘单击打开哪个窗口。 */
type TrayClick = "launcher" | "dsh";

/** 与 Rust 侧 `settings::ShellConfig` 对应（整份壳设置）。 */
interface ShellConfig {
  launch: LaunchConfig;
  trayClick: TrayClick;
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

const WSL_DEFAULT_INNER = "npx --yes @deepseek-ai/dsh web";

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
  wsl: "通过 WSL 启动",
};

interface PickerChoice {
  value: string;
  label: string;
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
    document.addEventListener("pointerdown", (event) => {
      if (this.isOpen() && !this.root.contains(event.target as Node)) {
        this.close();
      }
    });
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

  /** 重设候选列表；当前选中项不在新列表里时退回第一项。 */
  setChoices(choices: PickerChoice[]): void {
    this.choices = choices.slice();
    if (!this.choices.some((choice) => choice.value === this.selected)) {
      this.selected = this.choices[0]?.value ?? "";
    }
    this.renderLabel();
    this.renderOptions();
  }

  private isOpen(): boolean {
    return !this.list.classList.contains("hidden");
  }

  private renderLabel(): void {
    const current = this.choices.find((choice) => choice.value === this.selected);
    this.label.textContent = current?.label ?? "（未选择）";
  }

  private renderOptions(): void {
    this.list.innerHTML = this.choices
      .map((choice, index) => {
        const selected = choice.value === this.selected;
        return `<li class="picker-option${index === this.activeIndex ? " active" : ""}" role="option" data-index="${index}" aria-selected="${selected}"><span class="tick">${selected ? "✓" : ""}</span><span class="text">${escapeHtml(choice.label)}</span></li>`;
      })
      .join("");
    for (const option of Array.from(this.list.querySelectorAll<HTMLElement>(".picker-option"))) {
      option.addEventListener("click", () => {
        const index = Number.parseInt(option.dataset.index ?? "", 10);
        this.commit(index);
      });
    }
  }

  private open(): void {
    // 打开时先不放蓝底：蓝色只属于「正要选中的那一项」，鼠标点开时不该有任何一行被标上。
    // 当前值靠行首的 ✓ 认，长列表滚到它那里去。
    this.activeIndex = -1;
    this.renderOptions();
    this.list.classList.remove("hidden");
    this.button.setAttribute("aria-expanded", "true");
    this.list.querySelector<HTMLElement>('.picker-option[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  private close(): void {
    this.list.classList.add("hidden");
    this.button.setAttribute("aria-expanded", "false");
    this.activeIndex = -1;
  }

  private commit(index: number): void {
    const choice = this.choices[index];
    if (!choice) {
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
      this.activeIndex = Math.min(this.choices.length - 1, Math.max(0, this.activeIndex + step));
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

async function main(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    return;
  }

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

  root.innerHTML = `
    <header class="head">
      <h1>${info.name}</h1>
      <p class="tagline">DSH Web 的轻量桌面壳</p>
      <p class="light-hint">关闭窗口 = 轻量模式：界面内存释放，DSH 与托盘常驻；单击托盘图标随时回来（打开哪个窗口可在下面设置）。</p>
    </header>

    <section class="card">
      <h2>DSH 会话</h2>
      <div class="status-row">
        <span id="login-badge" class="badge badge-stopped"><span id="login-text">登录等待中</span><span id="login-info" class="info-dot" role="img" tabindex="0" aria-label="登录链接说明" data-tip="登录链接就绪后即可打开 DSH 界面">!</span></span>
        <span id="status-badge" class="badge badge-stopped"><span id="status-spinner" class="spinner hidden"></span><span id="status-text">已停止</span></span>
        <span id="version-badge" class="badge badge-version" title="每次成功启动 DSH 后自动读取">${SPARKLE_SVG}<span id="version-text">DSH 版本未知</span></span>
        <span class="status-meta">PID：<b id="status-pid">—</b></span>
        <span class="status-meta">端口：<b id="status-port">—</b></span>
      </div>
      <p id="status-error" class="error hidden"></p>
      <div class="actions-row">
        <div class="actions">
          <button id="btn-toggle" class="primary">启动 DSH</button>
          <button id="btn-restart">重启 DSH</button>
        </div>
        <div class="actions">
          <button id="btn-open-app" disabled>当前程序打开</button>
          <button id="btn-open-browser" disabled>浏览器打开</button>
        </div>
      </div>
      <p id="login-note" class="hint login-note hidden"></p>
      <div class="fields tray-fields">
        <label>托盘单击打开</label>
        <div class="picker" id="tray-picker"></div>
        <p class="hint">单击系统托盘图标时打开哪一个；右键菜单「浏览器打开 / 当前程序打开 / 打开启动界面」随时可用。</p>
      </div>
      <details class="log-box">
        <summary><span class="chev">▸</span>最近输出<button type="button" class="log-copy" id="btn-copy-log">复制</button></summary>
        <pre id="log">（暂无输出）</pre>
      </details>
    </section>

    <section class="card">
      <h2 class="card-head">
        <button id="card-toggle-modes" class="card-toggle" aria-expanded="true"><span class="chev">▸</span>启动方式<span id="modes-summary" class="badge badge-stopped card-summary">官方 npx 命令</span></button>
      </h2>
      <div class="card-body">
      <label class="mode">
        <input type="radio" name="mode" value="npx" checked />
        <span>
          <b>${MODE_LABELS.npx}</b>
          <small>未全局安装 DSH 时用；首次启动会自动下载（较慢）<br />执行 <code>npx --yes @deepseek-ai/dsh web --no-open</code></small>
        </span>
      </label>
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
        <input id="binary-path" type="text" placeholder="例如 D:\\tools\\dsh.cmd" />
      </div>
      <label class="mode">
        <input type="radio" name="mode" value="wsl" />
        <span>
          <b>${MODE_LABELS.wsl}</b>
          <small>Windows 壳启动 WSL 发行版里的 DSH</small>
        </span>
      </label>
      <div id="wsl-fields" class="fields hidden">
        <div class="picker" id="wsl-distro-picker"></div>
        <input id="wsl-inner" type="text" value="${WSL_DEFAULT_INNER}" />
      </div>
      <div class="subcard">
        <p class="subcard-title">当前启动方式的通用设置（对上面选中的方式生效）</p>
        <div class="grid-2">
          <div class="fields">
            <label for="extra-args">附加参数（可选，按空格分隔）</label>
            <input id="extra-args" type="text" placeholder="例如 --port 3081 --no-open" />
            <p class="hint">追加到该启动方式的命令末尾（WSL 模式下追加到发行版内部命令）。仅允许字母数字与 <code>- _ . / : = @ +</code> 和空格；壳始终自动追加 <code>--no-open</code>（不自动弹浏览器），需要时用上面的「浏览器打开」。</p>
          </div>
          <div class="fields">
            <label for="port">端口（可选，留空 = 跟随 DSH 配置）</label>
            <div class="port-row">
              <input id="port" type="text" inputmode="numeric" placeholder="例如 3099" />
              <span id="port-badge" class="badge badge-stopped">跟随 DSH 配置</span>
            </div>
            <p class="hint" id="port-hint">正在读取 DSH 配置…</p>
          </div>
        </div>
        <p class="hint">四种启动方式共用这两个字段，WSL 模式同样生效（壳注入的端口覆盖层会经 /mnt 路径送进发行版）。配置改完自动保存，重开壳后保留。</p>
      </div>
      </div>
    </section>

    <section class="card">
      <h2 class="card-head">
        <button id="card-toggle-bridge" class="card-toggle" aria-expanded="true"><span class="chev">▸</span>桥接插件（登录链接的可靠通道）<span id="bridge-summary" class="badge badge-stopped card-summary">读取中…</span></button>
      </h2>
      <div class="card-body">
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
        <summary><span class="chev">▸</span>操作输出<button type="button" class="log-copy" id="btn-copy-bridge-output">复制</button></summary>
        <pre id="bridge-output">（暂无操作）</pre>
      </details>
      </div>
    </section>

    <section class="card">
      <h2>关于</h2>
      <div class="kv">
        <div class="kv-row"><span class="kv-key">壳版本</span><span class="kv-value" id="about-shell">—</span></div>
        <div class="kv-row"><span class="kv-key">DSH 版本</span><span class="kv-value" id="about-dsh">未知</span></div>
        <div class="kv-row"><span class="kv-key">开源许可证</span><span class="kv-value" id="about-license">—</span></div>
        <div class="kv-row kv-row-action"><span class="kv-key">项目仓库</span><span class="kv-value" id="about-repo">—</span><button id="btn-about-repo" class="kv-action">打开 GitHub 仓库</button></div>
        <div class="kv-row kv-row-action"><span class="kv-key">DSH 官网</span><span class="kv-value" id="about-site">—</span><button id="btn-about-site" class="kv-action">打开 DSH 官网</button></div>
        <div class="kv-row kv-row-action"><span class="kv-key">配置目录</span><span class="kv-value" id="about-config-dir">—</span><button id="btn-about-config" class="kv-action">打开配置目录</button></div>
        <div class="kv-row kv-row-action"><span class="kv-key">日志目录</span><span class="kv-value" id="about-logs-dir">—</span><button id="btn-about-logs" class="kv-action">打开日志目录</button></div>
      </div>
      <p id="about-note" class="hint hidden"></p>
      <p class="hint">DSH 版本在每次成功启动后自动读取；配置目录放壳设置与桥接备份，日志目录放 DSH 的启动日志（WSL 模式下日志在发行版内的 <code>~/.dsh/logs</code>）。</p>
    </section>
  `;

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
  const innerInput = $<HTMLInputElement>("wsl-inner");
  const portInput = $<HTMLInputElement>("port");
  const portBadge = $<HTMLSpanElement>("port-badge");
  const portHintEl = $<HTMLParagraphElement>("port-hint");
  const loginBadge = $<HTMLSpanElement>("login-badge");
  const loginText = $<HTMLElement>("login-text");
  const loginInfo = $<HTMLElement>("login-info");
  const loginNote = $<HTMLParagraphElement>("login-note");
  const btnOpenApp = $<HTMLButtonElement>("btn-open-app");
  const btnOpenBrowser = $<HTMLButtonElement>("btn-open-browser");
  const trayPicker = new Picker("tray-picker", () => void persistConfigQuiet());
  trayPicker.setChoices([
    { value: "launcher", label: "启动界面（默认）" },
    { value: "dsh", label: "当前程序打开的窗口" },
  ]);
  const distroPicker = new Picker("wsl-distro-picker", () => {
    void persistConfigQuiet();
    void refreshPortHint();
  });
  distroPicker.setChoices([{ value: "", label: "（正在读取发行版列表…）" }]);
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
  const btnAboutRepo = $<HTMLButtonElement>("btn-about-repo");
  const btnAboutSite = $<HTMLButtonElement>("btn-about-site");
  const btnAboutConfig = $<HTMLButtonElement>("btn-about-config");
  const btnAboutLogs = $<HTMLButtonElement>("btn-about-logs");

  // 卡片折叠（「启动方式」「桥接插件」）：默认展开，收起状态只活在 DOM 里，不持久化。
  const cardToggle = (key: "modes" | "bridge"): HTMLButtonElement => $<HTMLButtonElement>(`card-toggle-${key}`);
  const expandCard = (key: "modes" | "bridge"): void => {
    const toggle = cardToggle(key);
    toggle.closest(".card")?.classList.remove("collapsed");
    toggle.setAttribute("aria-expanded", "true");
  };
  for (const key of ["modes", "bridge"] as const) {
    const toggle = cardToggle(key);
    toggle.addEventListener("click", () => {
      const collapsed = toggle.closest(".card")?.classList.toggle("collapsed") ?? false;
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
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

  // 复制按钮在 <summary> 里：拦掉默认行为，避免顺带折叠/展开日志块。
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

  function renderPortHint(): void {
    const raw = portInput.value.trim();
    if (raw !== "") {
      portBadge.className = "badge badge-running";
      portBadge.textContent = `自定义 ${raw}`;
    } else {
      portBadge.className = "badge badge-stopped";
      portBadge.textContent = "跟随 DSH 配置";
    }
    if (!portHint) {
      portHintEl.textContent = "正在读取 DSH 配置…";
      return;
    }
    if (portHint.source === "managed" && portHint.port !== null) {
      const host = portHint.host ? `host ${portHint.host}，` : "";
      portHintEl.textContent = `当前生效值：${portHint.port}（来自 DSH 配置的 webserver 块，${host}留空时不动它；自定义端口会保留 host）`;
    } else {
      portHintEl.textContent = "未读到 DSH 端口配置（默认 3080）；留空则完全不干预。";
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
    $("binary-fields").classList.toggle("hidden", currentMode() !== "binary");
    $("wsl-fields").classList.toggle("hidden", currentMode() !== "wsl");
    // 卡片收起后靠这个徽章显示当前启动方式（展开时徽章隐藏，见 CSS）。
    const mode = currentMode();
    modesSummary.textContent = MODE_LABELS[mode] ?? "启动方式";
    if (mode === "wsl") {
      // 发行版列表原先是下拉框获得焦点时才读；自绘下拉框没有这个时机，改成切到 WSL 模式就读。
      void ensureDistros();
    }
    // 桥接插件与端口提示都跟随启动方式（Windows 宿主 / WSL 发行版），换模式就刷新。
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

  // 发行版列表按需读取一次即可。
  let distrosLoaded = false;
  async function ensureDistros(): Promise<void> {
    if (distrosLoaded) {
      return;
    }
    distrosLoaded = true;
    try {
      const distros = await invoke<string[]>("list_wsl_distros");
      if (distros.length === 0) {
        distroPicker.setChoices([{ value: "", label: "（未检测到 WSL 发行版）" }]);
        return;
      }
      distroPicker.setChoices(distros.map((distro) => ({ value: distro, label: distro })));
    } catch (err) {
      distroPicker.setChoices([{ value: "", label: "（读取失败）" }]);
      console.error("读取 WSL 发行版失败:", err);
    }
  }

  function collectConfig(): LaunchConfig {
    const extraArgs = extraInput.value.trim().split(/\s+/).filter(Boolean);
    const raw = portInput.value.trim();
    // 端口输入非法时调用方（启动/保存）会先报错拦截；这里兜底按 null 处理。
    const parsed = raw === "" ? null : Number.parseInt(raw, 10);
    const port = parsed !== null && Number.isFinite(parsed) ? parsed : null;
    const base = { extraArgs, port };
    switch (currentMode()) {
      case "system":
        return { ...base, mode: { kind: "system" } };
      case "binary":
        return { ...base, mode: { kind: "binary", path: binaryPath.value.trim() } };
      case "wsl":
        return { ...base, mode: { kind: "wsl", distro: distroPicker.value.trim(), inner: innerInput.value.trim() } };
      default:
        return { ...base, mode: { kind: "npx" } };
    }
  }

  // 配置自动保存：任一字段变更后尝试写盘（当前不合法时不写、不打扰；启动时会再校验）。
  // 两个自绘下拉框（托盘单击打开 / WSL 发行版）的回调在构造时已接进 persistConfigQuiet。
  for (const input of [extraInput, binaryPath, innerInput, portInput]) {
    input.addEventListener("change", () => void persistConfigQuiet());
  }
  // 端口：输入即刷新徽章（不含程序化赋值）；失焦再刷新一次保证同步。
  portInput.addEventListener("input", renderPortHint);
  portInput.addEventListener("change", renderPortHint);

  // 启动/停止失败时后端返回的错误（与轮询到的会话错误分开保存，
  // 否则下一次轮询（每秒一次）会把刚显示的错误清掉）。
  let localError: string | null = null;

  /** 把说明写进登录徽章的感叹号气泡（悬停或键盘聚焦时显示）。 */
  function setLoginTip(text: string): void {
    loginInfo.dataset.tip = text;
    loginInfo.setAttribute("aria-label", `登录链接说明：${text}`);
  }

  /** 「启动中」= 进程已起来、登录链接还没就绪（npx 首次下载与 DSH 冷启动都停在这一步）。 */
  function isStarting(status: SessionStatus): boolean {
    return status.state === "running" && !status.loginReady && !status.loginError;
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
    btnToggle.textContent = running ? "停止" : "启动 DSH";
    btnToggle.classList.toggle("primary", !running);
    // 「重启 DSH」常驻（与托盘菜单同款入口）：运行中可一键重启，停止时等价于启动。

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
  }

  async function refresh(): Promise<void> {
    try {
      render(await invoke<SessionStatus>("dsh_status"));
    } catch (err) {
      console.error("查询状态失败:", err);
    }
  }

  /** 按当前界面配置启动 DSH；`restart_dsh` 会先停掉现有会话再拉起（「启动」与「重启」共用）。 */
  async function startOrRestart(command: "start_dsh" | "restart_dsh"): Promise<void> {
    localError = null;
    // 端口非法输入：明确提示、不保存、不启动。
    const portError = portFieldError();
    if (portError) {
      localError = portError;
      await refresh();
      return;
    }
    // 启动/重启 DSH 都会产生终端输出：自动展开「最近输出」（维护者要求）。
    expandLog();
    try {
      await invoke(command, { config: collectConfig() });
    } catch (err) {
      localError = String(err);
    }
    await refresh();
  }

  // 「启动 DSH / 停止」同一个按钮：运行中（含「启动中」）点击是停止，否则是启动（失败后也是重新启动）。
  btnToggle.addEventListener("click", () => {
    void (currentStatus?.state === "running" ? stopDsh() : startOrRestart("start_dsh"));
  });
  btnRestart.addEventListener("click", () => void startOrRestart("restart_dsh"));

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

  // 「当前程序打开」：每次点击都重新取当前登录链接（token 是一次性铸造的）。
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
    const radio = modeRadios().find((r) => r.value === launch.mode.kind);
    if (radio) {
      radio.checked = true;
    }
    if (launch.mode.kind === "binary") {
      binaryPath.value = launch.mode.path;
    }
    if (launch.mode.kind === "wsl") {
      await ensureDistros();
      distroPicker.setValue(launch.mode.distro);
      innerInput.value = launch.mode.inner;
    }
    extraInput.value = launch.extraArgs.join(" ");
    if (launch.port !== null && launch.port !== undefined) {
      portInput.value = String(launch.port);
    }
    trayPicker.setValue(saved.trayClick);
    syncModeFields();
    renderPortHint();
  }

  // 「关于」卡片：静态信息来自 app_info；DSH 版本随状态轮询更新（见 render）。
  $("about-shell").textContent = `${info.name} ${info.version}（核心库 ${info.core_version}）`;
  $("about-license").textContent = info.license;
  $("about-repo").textContent = info.repository;
  $("about-site").textContent = info.site_url;
  $("about-config-dir").textContent = info.config_dir;
  $("about-logs-dir").textContent = info.logs_dir;

  await loadSavedConfig();
  // 发行版列表提前读好，切到 WSL 模式即可选。
  void ensureDistros();
  await refreshPortHint();
  await refresh();
  void refreshBridgeState();
  window.setInterval(() => void refresh(), 1000);
}

void main();
