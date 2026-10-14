import { invoke } from "@tauri-apps/api/core";
import "./style.css";

/** 与 Rust 侧 `app_info` 命令的返回结构一一对应。 */
interface AppInfo {
  name: string;
  version: string;
  core_version: string;
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

async function main(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    return;
  }

  let info: AppInfo = { name: "DSHarbor", version: "未知", core_version: "未知" };
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
        <span id="status-badge" class="badge badge-stopped">已停止</span>
        <span class="status-meta">PID：<b id="status-pid">—</b></span>
        <span class="status-meta">端口：<b id="status-port">—</b></span>
      </div>
      <p id="status-error" class="error hidden"></p>
      <div class="actions">
        <button id="btn-start" class="primary">启动 DSH</button>
        <button id="btn-stop">停止</button>
        <button id="btn-restart">重启 DSH</button>
      </div>
      <div class="status-row login-row">
        <span id="login-badge" class="badge badge-stopped">登录链接：等待中</span>
        <span class="actions">
          <button id="btn-open-app" disabled>当前程序打开</button>
          <button id="btn-open-browser" disabled>浏览器打开</button>
        </span>
      </div>
      <p id="login-note" class="hint hidden"></p>
      <div class="fields tray-fields">
        <label for="tray-click">托盘单击打开</label>
        <select id="tray-click">
          <option value="launcher">启动界面（默认）</option>
          <option value="dsh">当前程序打开的窗口</option>
        </select>
        <p class="hint">单击系统托盘图标时打开哪一个；右键菜单「浏览器打开 / 当前程序打开 / 打开启动界面」随时可用。</p>
      </div>
      <details class="log-box">
        <summary><span class="chev">▸</span>最近输出</summary>
        <pre id="log">（暂无输出）</pre>
      </details>
    </section>

    <section class="card">
      <h2>启动方式</h2>
      <label class="mode">
        <input type="radio" name="mode" value="npx" checked />
        <span>
          <b>官方 npx 命令</b>
          <small>未全局安装 DSH 时用；执行 <code>npx --yes @deepseek-ai/dsh web --no-open</code>，首次启动会自动下载（较慢）</small>
        </span>
      </label>
      <label class="mode">
        <input type="radio" name="mode" value="system" />
        <span>
          <b>系统全局命令</b>
          <small>已执行过 npm install -g @deepseek-ai/dsh</small>
        </span>
      </label>
      <label class="mode">
        <input type="radio" name="mode" value="binary" />
        <span>
          <b>指定程序路径</b>
          <small>最可靠：直接启动 dsh.exe / dsh.cmd 的完整路径</small>
        </span>
      </label>
      <div id="binary-fields" class="fields hidden">
        <input id="binary-path" type="text" placeholder="例如 D:\\tools\\dsh.cmd" />
      </div>
      <label class="mode">
        <input type="radio" name="mode" value="wsl" />
        <span>
          <b>通过 WSL 启动</b>
          <small>Windows 壳启动 WSL 发行版里的 DSH</small>
        </span>
      </label>
      <div id="wsl-fields" class="fields hidden">
        <select id="wsl-distro"><option value="">（正在读取发行版列表…）</option></select>
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
    </section>

    <section class="card">
      <h2>桥接插件（登录链接的可靠通道）</h2>
      <p class="hint">安装后壳经 DSH 内部插件接口直接取带 token 的登录链接，不依赖日志格式；未安装时自动降级为日志解析（可用但较脆）。安装/卸载前请先停止 DSH。</p>
      <div class="kv">
        <div class="kv-row"><span class="kv-key">目标环境</span><span class="kv-value" id="bridge-target">—</span></div>
        <div class="kv-row"><span class="kv-key">安装状态</span><span class="kv-value" id="bridge-status">读取中…</span></div>
        <div class="kv-row"><span class="kv-key">最近备份</span><span class="kv-value" id="bridge-backup">—</span></div>
      </div>
      <div class="actions bridge-actions">
        <button id="btn-bridge-install" class="primary">安装桥接插件</button>
        <button id="btn-bridge-uninstall">卸载</button>
        <button id="btn-bridge-restore">恢复最近备份</button>
      </div>
      <p id="bridge-error" class="error hidden"></p>
      <details class="log-box">
        <summary><span class="chev">▸</span>操作输出</summary>
        <pre id="bridge-output">（暂无操作）</pre>
      </details>
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
  const pidEl = $<HTMLElement>("status-pid");
  const portEl = $<HTMLElement>("status-port");
  const errorEl = $<HTMLParagraphElement>("status-error");
  const logEl = $<HTMLPreElement>("log");
  const btnStart = $<HTMLButtonElement>("btn-start");
  const btnStop = $<HTMLButtonElement>("btn-stop");
  const btnRestart = $<HTMLButtonElement>("btn-restart");
  const extraInput = $<HTMLInputElement>("extra-args");
  const binaryPath = $<HTMLInputElement>("binary-path");
  const distroSelect = $<HTMLSelectElement>("wsl-distro");
  const innerInput = $<HTMLInputElement>("wsl-inner");
  const portInput = $<HTMLInputElement>("port");
  const portBadge = $<HTMLSpanElement>("port-badge");
  const portHintEl = $<HTMLParagraphElement>("port-hint");
  const loginBadge = $<HTMLSpanElement>("login-badge");
  const loginNote = $<HTMLParagraphElement>("login-note");
  const btnOpenApp = $<HTMLButtonElement>("btn-open-app");
  const btnOpenBrowser = $<HTMLButtonElement>("btn-open-browser");
  const traySelect = $<HTMLSelectElement>("tray-click");
  const bridgeTarget = $<HTMLElement>("bridge-target");
  const bridgeStatus = $<HTMLElement>("bridge-status");
  const bridgeBackup = $<HTMLElement>("bridge-backup");
  const bridgeError = $<HTMLParagraphElement>("bridge-error");
  const bridgeOutput = $<HTMLPreElement>("bridge-output");
  const btnBridgeInstall = $<HTMLButtonElement>("btn-bridge-install");
  const btnBridgeUninstall = $<HTMLButtonElement>("btn-bridge-uninstall");
  const btnBridgeRestore = $<HTMLButtonElement>("btn-bridge-restore");

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
        trayClick: traySelect.value as TrayClick,
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
      distroSelect.innerHTML = "";
      if (distros.length === 0) {
        distroSelect.innerHTML = `<option value="">（未检测到 WSL 发行版）</option>`;
        return;
      }
      for (const distro of distros) {
        const option = document.createElement("option");
        option.value = distro;
        option.textContent = distro;
        distroSelect.appendChild(option);
      }
    } catch (err) {
      distroSelect.innerHTML = `<option value="">（读取失败）</option>`;
      console.error("读取 WSL 发行版失败:", err);
    }
  }
  distroSelect.addEventListener("focus", () => void ensureDistros());
  distroSelect.addEventListener("pointerdown", () => void ensureDistros());

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
        return { ...base, mode: { kind: "wsl", distro: distroSelect.value.trim(), inner: innerInput.value.trim() } };
      default:
        return { ...base, mode: { kind: "npx" } };
    }
  }

  // 配置自动保存：任一字段变更后尝试写盘（当前不合法时不写、不打扰；启动时会再校验）。
  for (const input of [extraInput, binaryPath, distroSelect, innerInput, portInput, traySelect]) {
    input.addEventListener("change", () => void persistConfigQuiet());
  }
  // 端口：输入即刷新徽章（不含程序化赋值）；失焦再刷新一次保证同步。
  portInput.addEventListener("input", renderPortHint);
  portInput.addEventListener("change", renderPortHint);
  distroSelect.addEventListener("change", () => void refreshPortHint());

  // 启动/停止失败时后端返回的错误（与轮询到的会话错误分开保存，
  // 否则下一次轮询（每秒一次）会把刚显示的错误清掉）。
  let localError: string | null = null;

  function render(status: SessionStatus): void {
    const badgeClass = status.state === "running" ? "badge-running" : status.state === "failed" ? "badge-failed" : "badge-stopped";
    const badgeText = status.state === "running" ? "运行中" : status.state === "failed" ? "启动失败" : "已停止";
    badge.className = `badge ${badgeClass}`;
    badge.textContent = badgeText;
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
    logEl.textContent = status.logTail.length > 0 ? status.logTail.join("\n") : "（暂无输出）";
    const running = status.state === "running";
    btnStart.disabled = running;
    btnStop.disabled = !running && status.state !== "failed";
    // 「重启 DSH」常驻（与托盘菜单同款入口）：运行中可一键重启，停止时等价于启动。

    // 登录链接徽章：桥接就绪 > 日志兜底就绪 > 等待中 > 获取失败。
    if (status.loginReady) {
      const viaBridge = status.loginChannel === "bridge";
      loginBadge.className = "badge badge-running";
      loginBadge.textContent = viaBridge ? "登录链接：桥接就绪" : "登录链接：日志兜底就绪";
      loginNote.textContent = viaBridge
        ? "已通过桥接插件取得带 token 的登录链接。"
        : "桥接插件未启用，已从启动日志解析出登录链接。";
      loginNote.classList.remove("hidden");
    } else if (status.loginError) {
      loginBadge.className = "badge badge-failed";
      loginBadge.textContent = "登录链接：获取失败";
      loginNote.textContent = status.loginError;
      loginNote.classList.remove("hidden");
    } else {
      loginBadge.className = "badge badge-stopped";
      loginBadge.textContent = running ? "登录链接：等待中…" : "登录链接：等待中";
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

  btnStart.addEventListener("click", () => void startOrRestart("start_dsh"));
  btnRestart.addEventListener("click", () => void startOrRestart("restart_dsh"));

  btnStop.addEventListener("click", () => {
    void (async () => {
      localError = null;
      expandLog();
      try {
        await invoke("stop_dsh");
      } catch (err) {
        localError = String(err);
      }
      await refresh();
    })();
  });

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
      bridgeBackup.textContent = state.latestBackup
        ? `最近备份：${state.latestBackup}`
        : "还没有备份：安装或卸载时会自动创建，可用「恢复最近备份」回滚。";
    } catch (err) {
      bridgeStatus.textContent = `读取失败：${err}`;
    }
  }

  function runBridgeOp(name: "bridge_install" | "bridge_uninstall"): void {
    void (async () => {
      bridgeBusy = true;
      updateBridgeButtons();
      bridgeError.classList.add("hidden");
      // 桥接操作会产生 pnpm/命令的终端输出：自动展开「操作输出」（维护者要求）。
      expandBridgeOutput();
      bridgeOutput.textContent = "执行中…（首次可能较慢，pnpm 需要解析依赖）";
      try {
        const outcome = await invoke<BridgeOutcome>(name, { config: collectConfig() });
        bridgeOutput.textContent = outcome.message;
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
        // 恢复同样产生终端输出：自动展开「操作输出」。
        expandBridgeOutput();
        const message = await invoke<string>("bridge_restore", {
          config: collectConfig(),
          backupDir: backup,
        });
        bridgeOutput.textContent = message;
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
      distroSelect.value = launch.mode.distro;
      innerInput.value = launch.mode.inner;
    }
    extraInput.value = launch.extraArgs.join(" ");
    if (launch.port !== null && launch.port !== undefined) {
      portInput.value = String(launch.port);
    }
    traySelect.value = saved.trayClick;
    syncModeFields();
    renderPortHint();
  }

  await loadSavedConfig();
  // 发行版列表提前读好，切到 WSL 模式即可选。
  void ensureDistros();
  await refreshPortHint();
  await refresh();
  void refreshBridgeState();
  window.setInterval(() => void refresh(), 1000);
}

void main();
