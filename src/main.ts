import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import logoUrl from "./assets/logo.png";
import "./style.css";

/** 左侧导航的五个分区图标：统一 24 单位视框、描边 1.55，与左栏底部的浅/深图标同源。 */
const ICON_LAUNCH = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 16.5 3 21l4.5-1.5" /><path d="M14 4c3.5-1 6 1.5 5 5-1.2 4.2-5.6 7.6-8.4 9.1L8 15.4C9.5 12.6 11.3 5.2 14 4Z" /><circle cx="14.6" cy="9.4" r="1.6" /></svg>`;
const ICON_ENV = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" /><path d="m4 7.5 8 4.5 8-4.5" /><path d="M12 12v9" /></svg>`;
const ICON_INTEG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" rx="2.5" /><path d="m6.5 10 2.5 2.5L6.5 15" /><path d="M12 15.5h5" /></svg>`;
const ICON_TRAYNET = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="10" r="6.5" /><path d="M5.5 10h13" /><path d="M12 3.5a10.5 10.5 0 0 1 2.6 6.5 10.5 10.5 0 0 1-2.6 6.5 10.5 10.5 0 0 1-2.6-6.5A10.5 10.5 0 0 1 12 3.5z" /><path d="M4 19.5h4l1.2 2h5.6l1.2-2h4" /></svg>`;
const ICON_ABOUT = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><circle cx="12" cy="7.9" r="0.9" fill="currentColor" stroke="none" /></svg>`;

/** 左栏底部那颗浅/深切换图标：显示的是「点下去会变成什么」，不是当前状态。 */
const ICON_SUN = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" /></svg>`;
const ICON_MOON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></svg>`;

/** 左侧导航的五个分区：导航按钮与面板标题都按这份表生成，顺序即显示顺序。 */
const PANELS: ReadonlyArray<{ key: PanelKey; label: string; icon: string }> = [
  { key: "launch", label: "启动方式", icon: ICON_LAUNCH },
  { key: "env", label: "环境", icon: ICON_ENV },
  { key: "integ", label: "集成", icon: ICON_INTEG },
  { key: "traynet", label: "托盘与网络", icon: ICON_TRAYNET },
  { key: "about", label: "关于", icon: ICON_ABOUT },
];

/** 三只窗口按钮的图标：10px 见方的细线 SVG，形状统一收在 9px 见方内、
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
/** 左栏底部的「GitHub 仓库」入口与打开方式里的「复制登录链接」共用这颗代码括号图标。 */
const ICON_CODE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 7.5-5 4.5 5 4.5" /><path d="m15.5 7.5 5 4.5-5 4.5" /><path d="M13.5 4.5 10.5 19.5" /></svg>`;
/** 打开方式的两段式按钮右侧那颗小三角，以及日志条的展开/收起箭头。 */
const ICON_CHEVRON_DOWN = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9.5 6 6 6-6" /></svg>`;
const ICON_CHEVRON_UP = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14.5 6-6 6 6" /></svg>`;
const ICON_COPY = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2" /><path d="M15 6.5A2.5 2.5 0 0 0 12.5 4H6.5A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15" /></svg>`;

/** 与 Rust 侧 `app_info` 命令的返回结构一一对应。 */
interface AppInfo {
  name: string;
  version: string;
  core_version: string;
  /** 项目仓库地址（「关于」面板展示与一键打开）。 */
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

/** 左侧导航的五个分区：点哪个，右侧面板就显哪一块（选择记在 localStorage）。 */
type PanelKey = "launch" | "env" | "integ" | "traynet" | "about";

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

/** 一份环境（DSH profile）的摘要：与 Rust 侧 `dsharbor_core::profiles::ProfileSummary` 对应。 */
interface ProfileSummary {
  name: string;
  /** `dsh.profile.bundles` 里登记了多少项。 */
  plugins: number;
  /** 桥接插件是否已登记在 bundles 里。 */
  bridgeInstalled: boolean;
  /** 是否登记了网页应用 bundle（决定它能不能起网页界面）。 */
  webCapable: boolean;
  /** 依赖是否装过（新建/复制出来的环境没有 node_modules）。 */
  depsInstalled: boolean;
}

/** `list_profiles` 的返回值：支持标记 + 清单。
 * 与 Rust 侧 `dsharbor_core::profiles::ProfileListing` 对应。
 * 为什么不只下发数组：非 Windows 宿主上环境卡要收起并说「仅在 Windows 宿主可用」，
 * 而一份空数组分不清「这里不支持」与「一个环境都没有」。 */
interface ProfileListing {
  supported: boolean;
  profiles: ProfileSummary[];
}

/** 下载源候选：标签用界面上的原文，value 与 Rust 侧 `DownloadSource::as_str()` 一致。 */
const DOWNLOAD_SOURCE_CHOICES: PickerChoice[] = [
  { value: "inherit", label: "沿用 npm 全局配置" },
  { value: "mirror", label: "镜像源" },
  { value: "official", label: "官方源" },
];

/** 下载源选中后那行说明：随选项变化，说清代价而不是只报名字。 */
function downloadSourceHint(source: DownloadSource): string {
  switch (source) {
    case "mirror":
      return "镜像源：国内直连较快；新版本可能稍晚才同步到。";
    case "official":
      return "官方源：更新及时；国内直连可能较慢。";
    default:
      return "沿用 npm 全局配置：不向 DSH 下发任何源，npm 自己读你的 .npmrc；行为与没有这项设置时一致。";
  }
}

/** 面板标题旁的摘要徽章用的名字：与下拉选项同一套文案。 */
function downloadSourceLabel(source: DownloadSource): string {
  return DOWNLOAD_SOURCE_CHOICES.find((choice) => choice.value === source)?.label ?? "沿用 npm 全局配置";
}

/** 代理模式候选：标签用界面上的原文，value 与 Rust 侧 `ProxyMode::as_str()` 一致。 */
const PROXY_MODE_CHOICES: PickerChoice[] = [
  { value: "system", label: "跟随系统" },
  { value: "manual", label: "手动填写" },
  { value: "off", label: "不走代理" },
];

/** 面板标题旁的代理摘要：与下拉选项同一套文案。 */
function proxyModeLabel(mode: ProxyMode): string {
  return PROXY_MODE_CHOICES.find((choice) => choice.value === mode)?.label ?? "跟随系统";
}

/** 与 Rust 侧 `proxy::ProxyState` 对应：生效地址、例外列表与那一行说明都由后端算好，
    界面只负责显示（地址归一化与提示文案只在核心库有一份，界面不另写一套）。 */
interface ProxyState {
  /** 这台宿主能不能真正生效：false 时整张网络卡换成一句「仅在 Windows 宿主可用」。 */
  supported: boolean;
  /** 真正下发的代理地址；null 表示这次不注入任何代理变量。 */
  url: string | null;
  /** 例外列表（回环地址由后端兜底加在最前面，不在这里重复）。 */
  bypass: string[];
  /** 一行说明：生效了报走哪儿，没生效说原因。 */
  hint: string;
  /** 当前代理状态的一句话，自检失败时拼在结论后面（文案在核心库一处定）。 */
  stateText: string;
}

/** 与 Rust 侧 `net::SelfCheckReport` 对应：三态、结论依据的那条路、
    实际用到的下载源与代理地址、失败说明。 */
interface SelfCheckReport {
  /** `proxyOk` / `directOnly` / `bothFail`。 */
  state: "proxyOk" | "directOnly" | "bothFail";
  /** `proxy` / `direct`：结论依据的那条路。 */
  via: "proxy" | "direct";
  /** 实际请求的下载源；null 表示透传 npm 全局配置。 */
  registry: string | null;
  /** 实际用上的代理地址；null 表示这条请求没走代理。 */
  proxy: string | null;
  /** 失败说明（一句中文 + 一行原文）；成功时为 null。 */
  failure: string | null;
}

/** 与 Rust 侧 `plugin::BridgeOutcome` 对应。 */
interface BridgeOutcome {
  ok: boolean;
  message: string;
  backupDir: string;
}

/** 与 Rust 侧 `shellpath::CliIntegrationState` 对应：目录、垫片预览、手动命令与状态说明
    都在后端算好，界面只负责显示。 */
interface CliIntegrationState {
  /** 当前宿主能不能自动接入（只有 Windows 会改 PATH）。 */
  supported: boolean;
  /** 开关值（`cliIntegration`）。 */
  enabled: boolean;
  /** 垫片目录（配置目录下的 `bin`）。 */
  binDir: string;
  /** 垫片文件完整路径。 */
  shimPath: string;
  /** 那个目录现在是否真的在用户 PATH 里。 */
  onPath: boolean;
  /** 可粘进 shell 配置的手动命令。 */
  manualCommand: string;
  /** 垫片按当前启动配置应该有的内容。 */
  shimText: string;
  /** 渲染垫片失败的原因（启动方式还没填完整等）。 */
  shimError: string | null;
  /** 探测到的系统全局 dsh 绝对路径。 */
  systemDsh: string | null;
  /** PATH 里排在垫片目录之前、会让终端先命中另一份 dsh 的那个文件。 */
  shadow: string | null;
  /** 一行状态说明。 */
  message: string;
}

/** 与 Rust 侧 `npxcache::CacheDir` 对应：缓存里属于本包的一个目录。 */
interface CacheDir {
  /** 目录名（`_npx` 下的那串哈希）。 */
  name: string;
  /** 界面直接显示的标签。 */
  label: string;
  /** 字节数。 */
  bytes: number;
  /** 上面那个数给界面显示的样子（`1.8 GB`）。 */
  bytesText: string;
  /** 当前配置是否保留这一份。 */
  keep: boolean;
  /** 是不是当前启动配置对应的那份。 */
  current: boolean;
}

/** 与 Rust 侧 `npxcache::CacheState` 对应：缓存盘面。 */
interface CacheState {
  /** 当前宿主能不能扫（只有 Windows 动文件）。 */
  supported: boolean;
  /** 缓存根（`npm config get cache` 问出来的那个目录）。 */
  root: string | null;
  /** 根是从哪来的：`npm` 或 `fallback`。 */
  rootSource: string;
  /** 本包占用字节数。 */
  ownBytes: number;
  /** 本包占用字节数的显示形式。 */
  ownBytesText: string;
  /** 本包目录份数。 */
  ownCount: number;
  /** 可回收字节数。 */
  reclaimableBytes: number;
  /** 可回收字节数的显示形式。 */
  reclaimableBytesText: string;
  /** 可删目录份数。 */
  removableCount: number;
  /** 保留份数（当前那份 + 最近用过的几份）。 */
  keepCount: number;
  /** 当前启动配置对应的那份目录名。 */
  current: string | null;
  /** 一行状态说明。 */
  message: string;
  /** 扫描时的告警（例如没问出 npm 缓存位置）。 */
  warning: string | null;
  /** 属于本包的目录明细。 */
  dirs: CacheDir[];
}

/** 与 Rust 侧 `npxcache::CleanedDir` 对应：清掉的一个目录。 */
interface CleanedDir {
  label: string;
  bytes: number;
  bytesText: string;
}

/** 与 Rust 侧 `npxcache::CleanupFailure` 对应：没清掉的一个目录与原因。 */
interface CleanupFailure {
  label: string;
  path: string;
  reason: string;
}

/** 与 Rust 侧 `npxcache::CleanupResult` 对应：清理结果与清理后的新盘面。 */
interface CleanupResult {
  removed: CleanedDir[];
  failed: CleanupFailure[];
  freedBytes: number;
  message: string;
  state: CacheState;
}

/** 与 Rust 侧 `AutoCleanupReport` 对应：最近一次「启动后自动清理」的结果。 */
interface AutoCleanupReport {
  /** 第几次自动清理；界面只播报比上次新的那一次。 */
  seq: number;
  /** 说明文字（成功时以「启动后自动清理：」开头）。 */
  message: string;
  /** 成功时的逐条结果；缓存根都定位不到时没有可展示的条目。 */
  result: CleanupResult | null;
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

/** 候选文案来自后端（发行版名），插进 innerHTML 前统一转义。 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

/* ==================== 浅色 / 深色 ====================
   只有两种外观，差别全在 src/style.css 里的 CSS 变量上：切换时只改
   <html data-mode>，不重建界面、不重载页面。 */

/** 外观模式。 */
type ThemeId = "dark" | "light";

/** 外观记在 localStorage。index.html 的内联脚本复写了这个键名（静态脚本没法 import），
    改键名或模式名时两处同步。 */
const THEME_KEY = "dsharbor.ui.theme";

/** 旧版本存的是经典主题名：换版本后沿用用户的明暗偏好，而不是回落到默认。 */
const LEGACY_DARK_THEMES = new Set(["nativeDark", "native"]);

/** 已保存的外观；没存过、被改坏或存储被禁用时回落到深色。 */
function readStoredTheme(): ThemeId {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") {
      return saved;
    }
    if (saved !== null && LEGACY_DARK_THEMES.has(saved)) {
      return "dark";
    }
  } catch {
    // 隐私模式等场景下读不到，按默认走。
  }
  return "dark";
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
 * 状态放模块级：界面元素可能被重建，转动要跨重建继续，计时不重来。
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

/** 把外观贴到 <html>：src/style.css 里 html[data-mode="dark"|"light"] 两套变量据此生效。 */
function applyMode(mode: ThemeId): void {
  document.documentElement.dataset.mode = mode;
}

/** 面板外壳：`<section class="panel" data-panel="…">`，未选中时由 CSS 隐藏。 */
function panelSection(key: PanelKey, body: string): string {
  return `<section class="panel" data-panel="${key}">
  <div class="panel-body">${body}</div>
</section>`;
}

/**
 * 小卡：主卡里每个条目各装一张小卡（卡中卡）。圆角比主卡收窄两圈，
 * 靠主卡的内边距与 gap 露出主卡底色——露缝，不画分隔线。
 */
function cell(body: string): string {
  return `<section class="cell">${body}</section>`;
}

/**
 * 主卡：内容区里那张大卡片，里面按顺序摆若干小卡；条目撑高时由主卡自己滚。
 */
function mainCard(items: string[]): string {
  return `<section class="block main-card">${items.join("")}</section>`;
}

/** 主卡里并排两张小卡（附加参数│端口、托盘设置│网络与代理）：卡与卡之间同样露缝。 */
function cellRow(ratio: string, left: string, right: string): string {
  return `<div class="cell-row" data-ratio="${ratio}">${cell(left)}${cell(right)}</div>`;
}

/** 并排两列时的小标题：左列「托盘设置」、右列「网络与代理」，保证两列从同一行起。 */
function colHead(title: string, extra = ""): string {
  return `<div class="col-head"><span class="col-title">${title}</span>${extra}</div>`;
}

/** 卡片里的一行状态徽章：放在小标题右侧，一眼看到当前状态（启动方式 / 桥接 / 缓存占用）。 */
function badgeLine(key: string, text: string): string {
  return `<span id="${key}" class="badge badge-stopped panel-badge">${text}</span>`;
}

/** 界面骨架：一张通高的左栏悬浮块 + 右栏（工具条悬浮块 / 主卡 / 两张并排次卡）+ 统一日志浮层。
    三只窗口按钮不在任何块里，浮在窗口右上角；块与块之间留缝，露出页面背景。
    所有可交互元素的 id 不变，绑定代码共用。 */
function buildHtml(info: AppInfo): string {
  // 窗口按钮：浮在窗口最右上角，压在所有块之上（tauri.conf.json 里 decorations: false）。
  const winControls = `
    <div class="win-controls">
      <button id="win-min" class="win-btn" type="button" title="最小化" aria-label="最小化">${ICON_MINIMIZE}</button>
      <button id="win-max" class="win-btn" type="button" title="最大化" aria-label="最大化">${ICON_MAXIMIZE}</button>
      <button id="win-close" class="win-btn win-close" type="button" title="关闭窗口 = 轻量模式：界面内存释放，DSH 与托盘常驻" aria-label="关闭">${ICON_CLOSE}</button>
    </div>
  `;

  // 左栏：一张通高的悬浮块。顶部产品名 + 副标题，中间五个分区，底部三个纯图标快捷入口。
  const sidebar = `
    <aside class="sidebar" data-tauri-drag-region>
      <div class="sidebar-brand" data-tauri-drag-region>
        <div class="sidebar-brand-row">
          <img class="sidebar-logo" src="${logoUrl}" alt="" draggable="false" />
          <span class="sidebar-name">${info.name}</span>
        </div>
        <p class="sidebar-sub">DSH Web 的桌面壳</p>
      </div>
      <nav class="rail" id="nav" aria-label="设置分区">
        ${PANELS.map(
          (item) =>
            `<button class="ico-item" type="button" data-panel-btn="${item.key}">${item.icon}<span class="txt">${item.label}</span></button>`,
        ).join("\n        ")}
      </nav>
      <div class="sidebar-links">
        <button id="link-site" class="icon-btn" type="button" title="打开 DSH 官网" aria-label="打开 DSH 官网">${ICON_OPEN_BROWSER}</button>
        <button id="link-repo" class="icon-btn" type="button" title="打开 GitHub 仓库" aria-label="打开 GitHub 仓库">${ICON_CODE}</button>
        <button id="mode-btn" class="icon-btn" type="button" title="切换到浅色模式" aria-label="切换到浅色模式">${ICON_SUN}</button>
      </div>
    </aside>
  `;

  // 工具条：一张独立的悬浮块。左边徽章群，右边主操作。启动前只有「启动」可点（打开方式可以先选好），
  // 运行后「停止 / 重启」出现。打开方式是「主按钮 + 右侧小三角」的两段式：
  // 点三角选方式，选完文字与图标回填到主按钮，再点主按钮才执行。
  const toolbar = `
    <section class="block toolbar-block">
      <div class="status-row">
        <span id="login-badge" class="badge badge-stopped"><span id="login-text">登录等待中</span><span id="login-info" class="info-dot" role="img" tabindex="0" aria-label="登录链接说明" data-tip="登录链接就绪后即可打开 DSH 界面">!</span></span>
        <span id="status-badge" class="badge badge-stopped"><span id="status-spinner" class="spinner hidden"></span><span id="status-text">已停止</span></span>
        <span id="version-badge" class="badge badge-version" title="每次成功启动 DSH 后自动读取">${SPARKLE_SVG}<span id="version-text">DSH 版本未知</span></span>
        <span class="status-meta">PID <b id="status-pid">—</b></span>
        <span class="status-meta">监听 <b id="status-port">—</b></span>
      </div>
      <!-- 拖动带：徽章之间到右侧按钮之间的空白交给系统拖窗口（按钮本身不参与）。 -->
      <div class="toolbar-drag" data-tauri-drag-region></div>
      <div class="toolbar-actions">
        <div class="actions actions-primary">
          <!-- 初始即停止态的逐字切换形态：首帧就用正确样式，等 render 前不会闪红底大字。 -->
          <button id="btn-toggle" class="primary swap" aria-label="${TOGGLE_TEXT_REST}">${toggleSwapHtml()}</button>
          <button id="btn-restart" class="hidden"><span class="btn-text">重启 DSH</span><span class="btn-ico" aria-hidden="true">${ICON_RESTART}</span></button>
        </div>
        <div class="open-split">
          <button id="btn-open" class="btn-open" type="button" disabled>
            <span class="btn-ico" id="open-ico" aria-hidden="true">${ICON_OPEN_APP}</span>
            <span class="btn-text" id="open-text">应用内打开</span>
          </button>
          <button id="btn-open-more" class="btn-open-more" type="button" title="更换打开方式" aria-label="更换打开方式" aria-expanded="false" aria-controls="open-menu">${ICON_CHEVRON_DOWN}</button>
          <div id="open-menu" class="open-menu hidden" role="menu" aria-label="打开方式">
            <button class="open-item" type="button" role="menuitem" data-open-mode="app">${ICON_OPEN_APP}<span>应用内打开</span></button>
            <button class="open-item" type="button" role="menuitem" data-open-mode="browser">${ICON_OPEN_BROWSER}<span>浏览器打开</span></button>
            <button class="open-item" type="button" role="menuitem" data-open-mode="copy">${ICON_CODE}<span>复制登录链接</span></button>
          </div>
        </div>
      </div>
    </section>
  `;

  // 状态错误与登录失败的两行提示：工具条下方整行显示，不塞进任何块。
  const statusErrorBlock = `<p id="status-error" class="error hidden"></p>`;
  const loginNoteBlock = `<p id="login-note" class="hint login-note hidden"></p>`;

  // 两条托盘设置（单击打开 / 释放界面内存）在「托盘设置」块里，说明直接写在控件下方。
  const trayFields = `
    ${colHead("托盘设置")}
    <div class="fields">
      <label>托盘单击打开</label>
      <div class="picker" id="tray-picker"></div>
      <p class="hint">单击系统托盘图标时打开哪一个；右键菜单「浏览器打开 / 应用内打开 / 打开启动界面」随时可用。</p>
    </div>
    <div class="fields">
      <label>关闭窗口后释放界面内存</label>
      <div class="picker" id="light-delay-picker"></div>
      <p class="hint">关闭后先留在内存里，这段时间内从托盘回来是秒开；到点后释放界面内存。</p>
    </div>
  `;

  // 分区里的次要内容（补丁层与插件）：平时隐藏在「管理环境」展开区里，展开后才出现。
  const manageBlockBody = `
    <div id="profile-manage" class="subcard hidden">
      <span class="subcard-title">管理环境</span>
      <div id="profile-manage-list" class="profile-manage-list"></div>
      <div class="fields">
        <span class="field-label" id="profile-manage-name-label">环境名</span>
        <input id="profile-manage-name" type="text" spellcheck="false" autocomplete="off" placeholder="例如 lab">
      </div>
      <p class="hint">环境名只能用字母、数字和 - _ .，且以字母或数字开头。</p>
      <div class="actions">
        <button id="btn-profile-create" class="ghost">新建空白环境</button>
        <button id="btn-profile-copy" class="ghost">复制所选环境</button>
        <button id="btn-profile-rename" class="ghost">重命名所选环境</button>
        <button id="btn-profile-delete" class="ghost danger">删除所选环境</button>
        <button id="btn-profile-deps" class="ghost">重装依赖</button>
      </div>
      <div id="profile-manage-confirm" class="profile-confirm hidden">
        <p id="profile-manage-confirm-text" class="hint"></p>
        <div class="actions">
          <button id="btn-profile-confirm-yes" class="danger">确定删除</button>
          <button id="btn-profile-confirm-no" class="ghost">取消</button>
        </div>
      </div>
      <div id="profile-patch" class="patch-panel hidden">
        <span class="subcard-title">补丁层（cordis.patch.yml）</span>
        <p class="hint">补丁层是你手写的插件覆盖层，改坏了 DSH 可能起不来。改动前先备份一份，改坏了再还原回来：每个环境只保留最近 5 份备份；还原前会自动把当前版本另存一份，所以还原本身也能再退回去。补丁层与依赖都要重启 DSH 后才生效，操作前请先停止 DSH。</p>
        <div class="actions">
          <button id="btn-patch-backup" class="ghost">备份补丁层</button>
        </div>
        <div id="patch-restore-confirm" class="profile-confirm hidden">
          <p id="patch-restore-confirm-text" class="hint"></p>
          <div class="actions">
            <button id="btn-patch-confirm-yes" class="danger">确定还原</button>
            <button id="btn-patch-confirm-no" class="ghost">取消</button>
          </div>
        </div>
        <div id="patch-backup-list" class="patch-backup-list"></div>
      </div>
      <div id="profile-plugins" class="patch-panel hidden">
        <span class="subcard-title">插件</span>
        <p class="hint">开关改的是补丁层里的禁用表达，<b>不会卸载插件包</b>：关掉后重启 DSH 才不再加载它，重新打开也不需要重新下载。每次开关前会自动备份一份补丁层（每个环境保留最近 5 份）；改完要重启 DSH 才生效，所以操作前请先停止 DSH。</p>
        <div id="plugin-list" class="plugin-list"></div>
        <div id="plugin-empty" class="plugin-empty hidden">
          <p class="hint">这个环境还没有装任何插件。先给环境安装依赖，再用官方命令把插件装上（<code>dsh plugin --profile &lt;环境名&gt; add &lt;插件名&gt;</code>）。</p>
          <div class="actions">
            <button id="btn-plugin-deps" class="ghost">去安装依赖</button>
          </div>
        </div>
        <p id="plugin-note" class="hint hidden"></p>
        <p id="plugin-warning" class="hint plugin-warning hidden"></p>
      </div>
      <p id="profile-manage-note" class="hint hidden"></p>
      <p id="profile-manage-error" class="error hidden"></p>
    </div>
  `;

  // 「环境」块：选当前启动用哪一份 DSH 环境（profile）。下拉只列能起网页界面的环境
  // （官方桌面端专用目录整份隐藏，见核心库 profiles.rs）。切换只写配置、不自动重启。
  // `${manageBlockBody}` 是「管理环境」的展开区（补丁层与插件），默认隐藏。
  const profilesBody = `
    ${colHead("当前环境", badgeLine("profiles-summary", "读取中…"))}
    <p id="profiles-windows-only" class="hint profiles-windows-only hidden">仅在 Windows 宿主可用：环境列表与管理要读写 DSH 自己的 <code>~/.dsh/profiles</code> 目录，这里不会改动任何文件。</p>
    <div id="profiles-content" class="profiles-content">
    <div class="fields profiles-fields">
      <span class="field-label">启动用环境 <span class="info-dot" role="img" tabindex="0" aria-label="环境说明" data-tip="环境是 ~/.dsh/profiles 下的一份独立 DSH 安装，各自有自己的插件与配置。只有登记了网页应用的环境才能起界面；切换后需要重启 DSH 才生效。">!</span></span>
      <div class="picker" id="profile-picker"></div>
      <p class="hint" id="profile-hint"></p>
    </div>
    <div id="profile-restart-row" class="actions hidden">
      <button id="btn-profile-restart" class="primary">重启 DSH 使切换生效</button>
    </div>
    <p id="profile-note" class="hint hidden"></p>
    <p id="profile-error" class="error hidden"></p>
    <div class="actions">
      <button id="btn-profile-manage" class="ghost">管理环境</button>
    </div>
    ${manageBlockBody}
    </div>
  `;

  // 「网络与代理」块：下载源 + 代理。代理设置按下发到子进程的时机生效，所以地址框失焦就存。
  const networkFieldsBody = `
    <p id="network-windows-only" class="hint network-windows-only hidden">仅在 Windows 宿主可用：代理设置要读系统代理（Windows 注册表或环境变量）并下发到子进程，自检也要起 npm；这里不会改动任何设置。</p>
    <div id="network-content" class="network-content">
    ${colHead("网络与代理", `<span id="network-summary" class="badge badge-stopped panel-badge">沿用 npm 全局配置 · 跟随系统</span>`)}
    <div class="fields">
      <span class="field-label">下载源</span>
      <div class="picker" id="download-source-picker"></div>
      <p class="hint" id="download-source-hint"></p>
    </div>
    <div class="fields">
      <span class="field-label">代理</span>
      <div class="picker" id="proxy-mode-picker"></div>
      <div id="proxy-manual" class="proxy-manual hidden">
        <input id="proxy-address" type="text" placeholder="例如 http://127.0.0.1:7890" spellcheck="false" autocomplete="off" />
      </div>
      <p class="hint" id="proxy-hint"></p>
    </div>
    </div>
  `;

  // 「网络自检」块：真正起一次 npm，看直连和走代理各自通不通。
  const selfCheckBody = `
    <div class="fields">
      <div class="actions">
        <button type="button" id="btn-self-check">测试连接</button>
      </div>
      <p class="hint" id="self-check-status"></p>
      <p class="hint hidden" id="self-check-detail"></p>
    </div>
  `;

  // 「命令行集成」块：内容全部由后端算好（目录、垫片内容、手动命令、状态说明），
  // 界面只负责显示，避免两边各算一套口径。非 Windows 宿主只留手动命令。
  const cliBlockBody = `
    ${colHead("命令行集成", badgeLine("integrations-summary", "读取中…"))}
    <div class="cli-windows-only">
      <label class="switch-line">
        <input type="checkbox" id="cli-toggle" />
        <span>把 <code>dsh</code> 命令接进终端：在固定目录写一份 <code>dsh.cmd</code>，再把这个目录加到当前用户的 PATH 末尾</span>
      </label>
      <p class="hint">只改当前用户的 PATH，不动系统 PATH，其它条目原样保留（百分号变量也不会被展开）；写入是原值回写，再长也不会截断。改完不影响已经开着的终端，<b>新开一个终端</b>才生效。</p>
      <div class="kv">
        <div class="kv-row"><span class="kv-key">垫片目录</span><span class="kv-value" id="cli-bin-dir">—</span></div>
        <div class="kv-row kv-row-action"><span class="kv-key">垫片文件</span><span class="kv-value" id="cli-shim-path">—</span><button id="btn-cli-dir" class="kv-action">打开目录</button></div>
      </div>
    </div>
    <div class="kv">
      <div class="kv-row kv-row-action"><span class="kv-key">手动命令</span><span class="kv-value cli-command" id="cli-manual">—</span><button id="btn-cli-copy" class="kv-action">复制</button></div>
    </div>
    <p class="hint">不想打开上面的开关时，把这条命令粘进 <b>命令提示符（cmd）</b> 或 <b>PowerShell</b> 回车执行，也就是自己把它追加到当前用户的 PATH 末尾；开新终端后生效。注意 <code>setx</code> 会把 <code>%VAR%</code> 展开成当前值、超过 1024 个字符会被截断，所以它只适合手动救场，日常用上面那个开关（那边是原值回写，不会被展开也不会截断）。</p>
    <p id="cli-message" class="hint">读取中…</p>
    <p id="cli-error" class="error hidden"></p>
    <div class="cli-windows-only">
      <details class="log-box">
        <summary><span class="chev">▸</span>垫片内容（跟随当前启动方式）</summary>
        <div class="log-area">
          <pre id="cli-shim-text">（读取中）</pre>
          <button type="button" class="log-copy" id="btn-cli-copy-shim">复制</button>
        </div>
      </details>
    </div>
  `;

  // 「npx 缓存」块：占用字节、可回收字节、目录明细、每次删除的结果都在后端算好。
  const cacheBlockBody = `
    ${colHead("npx 缓存")}
    <p class="hint">只统计明确记录着本包的缓存目录，别的包既不计入也不删。清理会保留当前启动配置对应的那份加最近用过的几份，其余删除；npm 的包体缓存不动，下次启动不用重新下载。</p>
    <label class="switch-line">
      <input type="checkbox" id="cache-auto-toggle" />
      <span>真的拉起一个 DSH 进程之后自动清理一次：保留当前启动配置对应的那份与最近用过的几份，其余删掉</span>
    </label>
    <p class="hint">默认关闭。打开后，只在这一回真的拉起了一个 DSH 进程之后修剪一次（壳外已经有一份在跑时什么也不拉起，所以什么也不删）；进程起来了但随后又崩了也照样清理，这里不等它健康退出。清掉了哪些、释放了多少会显示在下面。</p>
    <div class="kv">
      <div class="kv-row"><span class="kv-key">本包占用</span><span class="kv-value" id="cache-own">—</span></div>
      <div class="kv-row"><span class="kv-key">可回收</span><span class="kv-value" id="cache-reclaimable">—</span></div>
      <div class="kv-row kv-row-action"><span class="kv-key">缓存目录</span><span class="kv-value" id="cache-root">—</span><button id="btn-cache-clean" class="kv-action">立即清理</button></div>
    </div>
    <p id="cache-message" class="hint">读取中…</p>
    <p id="cache-warning" class="hint hidden"></p>
    <p id="cache-error" class="error hidden"></p>
    <div id="cache-results" class="hidden">
      <div class="kv" id="cache-results-body"></div>
    </div>
    <details class="log-box">
      <summary><span class="chev">▸</span>缓存明细（保留的与可回收的）</summary>
      <div class="log-area">
        <pre id="cache-dirs">（读取中）</pre>
      </div>
    </details>
  `;

  // 「启动方式」块：四选一 + 各自参数。实际执行的命令与附加参数放在下面并排的两块里。
  const modesBody = `
    ${colHead("启动方式", badgeLine("modes-summary", "官方 npx 命令"))}
    <label class="mode">
      <input type="radio" name="mode" value="npx" checked />
      <span>
        <b>${MODE_LABELS.npx}</b>
        <small>未全局安装 DSH 时用；首次启动会自动下载（较慢）；实际执行的命令见下方「命令预览」。</small>
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
      <p class="hint">写整条启动命令；只允许字母数字与 <code>- _ . / : = @ +</code> 和空格，引号、管道、重定向会被拒绝。壳会自动补上 <code>--no-open</code>。选中「环境」面板里的其它环境时不会改写这条命令——自己写进去才算数。</p>
    </div>
  `;

  const portControl = `<input id="port" type="text" inputmode="numeric" placeholder="例如 3099" />`;
  // 命令预览：跟着渠道 / 版本 / 运行环境实时刷新的那条真实命令，单独一张小卡接在启动方式下面。
  const commandPreviewBody = `<code id="npx-command-preview" class="command-preview">${npxCommandOf("latest", null)}</code>`;
  // 与启动方式同在主卡内、并排的两张小卡：「附加参数」与「端口」。
  const extraArgsBody = `<div class="fields">
      <label for="extra-args">附加参数 <span class="info-dot" role="img" tabindex="0" aria-label="附加参数说明" data-tip="追加到该启动方式的命令末尾（运行环境选 WSL 时追加到发行版内的命令后面）。仅允许字母数字与 - _ . / : = @ + 和空格；壳始终自动追加 --no-open（不自动弹浏览器），需要时用工具栏的「打开方式」。">!</span></label>
      <input id="extra-args" type="text" placeholder="例如 --port 3081 --no-open" />
    </div>`;
  const portBody = `<div class="fields">
      <label for="port">监听端口 <span id="port-info" class="info-dot" role="img" tabindex="0" aria-label="端口说明" data-tip="正在读取 DSH 配置…">!</span></label>
      <div class="port-row">${portControl}<button type="button" id="port-reset" class="port-reset" title="把端口还原为默认（留空 = 跟随 DSH 配置）">还原</button></div>
      <p class="hint" id="port-hint">留空即跟随 DSH 自身的配置。</p>
    </div>`;

  // 「桥接插件」块：登录链接的可靠通道，挂在「环境」里与它所属的环境挨着。
  const bridgeBody = `
    ${colHead("桥接插件", badgeLine("bridge-summary", "读取中…"))}
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
  `;

  // 「关于」：只留版本与两个目录（仓库 / 官网的入口挪到了左栏底部的图标）。
  const aboutKv = `
    <div class="kv">
      <div class="kv-row"><span class="kv-key">壳版本</span><span class="kv-value" id="about-shell">${info.name} ${info.version}（核心库 ${info.core_version}）</span></div>
      <div class="kv-row"><span class="kv-key">DSH 版本</span><span class="kv-value" id="about-dsh">未知</span></div>
      <div class="kv-row"><span class="kv-key">开源许可证</span><span class="kv-value" id="about-license">${info.license}</span></div>
      <div class="kv-row kv-row-action"><span class="kv-key">配置目录</span><span class="kv-value" id="about-config-dir">${info.config_dir}</span><button id="btn-about-config" class="kv-action">打开</button></div>
      <div class="kv-row kv-row-action"><span class="kv-key">日志目录</span><span class="kv-value" id="about-logs-dir">${info.logs_dir}</span><button id="btn-about-logs" class="kv-action">打开</button></div>
    </div>
  `;
  const aboutTail = `
    <p id="about-note" class="hint hidden"></p>
    <p class="hint">DSH 版本在每次成功启动后自动读取；配置目录放壳设置与桥接备份，日志目录放 DSH 的启动日志（运行环境选 WSL 时日志在发行版内的 <code>~/.dsh/logs</code>）。</p>
  `;

  // 「关于」卡：一行小标题 + 版本与目录表。
  const aboutBody = `${colHead("版本与目录")}${aboutKv}${aboutTail}`;

  // 五个分区共用同一套骨架：内容区就是一张主卡，里面每个条目各装一张小卡（卡中卡），
  // 超过高度时由主卡自己滚。并排的两项用 cellRow 包成两张小卡，留在主卡内部。
  const panels = [
    panelSection(
      "launch",
      mainCard([cell(modesBody), cell(commandPreviewBody), cellRow("1-1", extraArgsBody, portBody)]),
    ),
    panelSection("env", mainCard([cell(profilesBody), cell(bridgeBody)])),
    panelSection("integ", mainCard([cell(cliBlockBody), cell(cacheBlockBody)])),
    panelSection(
      "traynet",
      mainCard([cellRow("1-2", trayFields, networkFieldsBody), cell(selfCheckBody)]),
    ),
    panelSection("about", mainCard([cell(aboutBody)])),
  ].join("\n");

  // 日志：折叠时只是工具条下方的一条窄箭头；展开时是从工具条往下盖住内容的浮层。
  const logBar = `
    <div class="log-bar">
      <button id="log-toggle" class="log-toggle" type="button" aria-expanded="false" aria-controls="log-panel" title="展开日志" aria-label="展开日志">${ICON_CHEVRON_DOWN}</button>
    </div>
  `;
  const logOverlay = `
    <div id="log-scrim" class="log-scrim hidden"></div>
    <section id="log-panel" class="log-panel hidden" aria-hidden="true" aria-label="日志">
      <header class="log-head">
        <button id="btn-clear-log" class="log-action" type="button">清空日志</button>
        <button id="btn-copy-log" class="log-action" type="button">复制日志</button>
      </header>
      <pre id="log" class="log-body">（暂无输出）</pre>
      <div class="log-foot">
        <button id="log-collapse" class="log-toggle" type="button" title="收起日志" aria-label="收起日志">${ICON_CHEVRON_UP}</button>
      </div>
    </section>
  `;

  return `${winControls}
  <div class="shell">
    ${sidebar}
    <main class="content">
      ${toolbar}
      ${statusErrorBlock}
      ${loginNoteBlock}
      <div class="content-main">
        ${logBar}
        <div class="page" id="page">${panels}</div>
        ${logOverlay}
      </div>
    </main>
  </div>`;
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
  // DOM 只在启动时生成一次：切浅色/深色只改 <html data-mode>，不重建界面。
  // 挂在 window / document 上的监听（窗口缩放、托盘轮询、自绘滚动条）也只注册一次，
  // 通过下面三个钩子指到当前这套界面。
  let updateScrollThumbHook: () => void = () => {};
  let syncMaximizeIconHook: () => void = () => {};
  let refreshNowHook: () => Promise<void> = async () => {};

  /** 生成界面与全部绑定。只在启动时跑一次：切浅色/深色只改 <html data-mode>，不重建 DOM。 */
  async function mount(): Promise<void> {
    applyMode(theme);
    root.innerHTML = buildHtml(info);

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
    // 日志浮层：一条窄箭头开关 + 一个盖住内容的浮层（右上角清空 / 复制，右下角收起）。
    const logBarToggle = $<HTMLButtonElement>("log-toggle");
    const logPanel = $<HTMLElement>("log-panel");
    const logScrim = $<HTMLElement>("log-scrim");
    const logCollapse = $<HTMLButtonElement>("log-collapse");
    const btnClearLog = $<HTMLButtonElement>("btn-clear-log");
    // 打开方式：主按钮 + 右侧小三角的两段式（选完回填，再点主按钮才执行）。
    const btnOpen = $<HTMLButtonElement>("btn-open");
    const btnOpenMore = $<HTMLButtonElement>("btn-open-more");
    const openMenu = $<HTMLElement>("open-menu");
    const openIco = $<HTMLElement>("open-ico");
    const openText = $<HTMLElement>("open-text");
    const linkSite = $<HTMLButtonElement>("link-site");
    const linkRepo = $<HTMLButtonElement>("link-repo");
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
        registry = await invoke<RegistryInfo>("query_dsh_versions", { runtime, source: prefs.downloadSource });
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
      // 渠道（稳定版 / next / 具体版本）直接写在垫片里，换完就重写。
      void syncCliShim();
    });
    npxChannelPicker.setChoices(CHANNEL_CHOICES);
    const npxVersionPicker = new Picker("npx-version-picker", () => {
      renderChannelUI();
      void persistConfigQuiet();
      void syncCliShim();
    });
    npxVersionPicker.setChoices([]);
    npxVersionsHint.addEventListener("click", (event) => {
      if ((event.target as HTMLElement | null)?.id === "npx-versions-retry") {
        void loadRegistry();
      }
    });
    // 左栏底部那颗浅/深切换：图标画的是「点下去会变成什么」，切换只改 <html data-mode>，
    // 界面不重建，正在填的字段与滚动位置都保住。
    const modeBtn = $<HTMLButtonElement>("mode-btn");
    const renderModeButton = (): void => {
      const dark = theme === "dark";
      modeBtn.innerHTML = dark ? ICON_SUN : ICON_MOON;
      const label = dark ? "切换到浅色模式" : "切换到深色模式";
      modeBtn.title = label;
      modeBtn.setAttribute("aria-label", label);
    };
    modeBtn.addEventListener("click", () => {
      theme = theme === "dark" ? "light" : "dark";
      applyMode(theme);
      renderModeButton();
      try {
        window.localStorage.setItem(THEME_KEY, theme);
      } catch {
        // 隐私模式等场景下存不下：本次切换仍生效，只是下次启动回到默认。
      }
      syncThemeToShell(theme);
    });
    renderModeButton();
    // 下载源：「网络」卡的第一个控件。改完立刻生效于版本清单查询（选「官方源」
    // 就真的去官方地址拉），不必重启壳。
    const networkSummary = $<HTMLSpanElement>("network-summary");
    const networkWindowsOnly = $<HTMLElement>("network-windows-only");
    const networkContent = $<HTMLElement>("network-content");
    /** 这台宿主能不能真正生效（后端给的平台标记）；还没读到代理状态时先按 true 留着。 */
    let networkSupported = true;
    const downloadSourceHintEl = $<HTMLParagraphElement>("download-source-hint");
    const proxyHintEl = $<HTMLParagraphElement>("proxy-hint");
    const proxyManualRow = $<HTMLElement>("proxy-manual");
    const proxyAddressInput = $<HTMLInputElement>("proxy-address");
    /** 后端算好的代理状态（地址、例外列表与那一行说明）；还没读到时为 null。 */
    let proxyState: ProxyState | null = null;
    /** 上一次提交地址时被后端拒绝的理由；成功存盘或切模式后清掉。 */
    let proxySaveError: string | null = null;

    /** 平台标记只决定「整卡还是只留一句」——单独拿出来，免得刷新代理状态时把自检结果也抹掉。 */
    function renderNetworkSupport(): void {
      networkWindowsOnly.classList.toggle("hidden", networkSupported);
      networkContent.classList.toggle("hidden", !networkSupported);
      if (!networkSupported) {
        networkSummary.textContent = "仅 Windows 可用";
      }
    }

    function renderNetworkUI(): void {
      // 非 Windows 宿主：整卡换成一句说明（跟环境卡用同一个写法：平台标记由后端给，
      // 界面只负责 toggle）——不能让人在能点但不能生效的控件上白调。
      renderNetworkSupport();
      if (!networkSupported) {
        return;
      }
      // 收起时摘要把两个选择拼在一行：「镜像源 · 跟随系统」。
      networkSummary.textContent = `${downloadSourceLabel(prefs.downloadSource)} · ${proxyModeLabel(prefs.proxyMode)}`;
      downloadSourceHintEl.textContent = downloadSourceHint(prefs.downloadSource);
      // 地址输入框只在手动模式才露出来；另外两种模式那个值不参与计算，露出来只会让人以为要填。
      proxyManualRow.classList.toggle("hidden", prefs.proxyMode !== "manual");
      proxySaveError = null;
      renderProxyHint();
      // 源或代理变了，上一次自检的结论就不适用了：清掉，别让人拿旧结论判断新配置。
      // 只有这条路径会清它：每秒的状态刷新走的不是 renderNetworkUI，
      // 所以用户刚看到的结果不会被自动刷新抹掉。
      selfCheckReport = null;
      renderSelfCheck();
    }

    /** 提示行：手动模式填错了就把那句校验文案当错误显示，其它情形都是普通说明。 */
    function renderProxyHint(): void {
      const state = proxyState;
      if (proxySaveError !== null) {
        // 存盘被后端拦下：这是比「地址算不出来」更要紧的事实——整份配置根本没落地，
        // 界面上的值只在这次会话里，重开就回到旧值。必须说出来，不能只 console.debug。
        proxyHintEl.textContent = proxySaveError;
        proxyHintEl.classList.add("error", "field-error");
        return;
      }
      if (state === null) {
        proxyHintEl.textContent = "正在读取系统代理设置…";
        proxyHintEl.classList.remove("error", "field-error");
        return;
      }
      // 手动模式里填了地址却没生效（socks、格式错、缺主机）：那行说明就是错在哪里。
      const isError =
        prefs.proxyMode === "manual" && state.url === null && prefs.proxyAddress.trim() !== "";
      proxyHintEl.textContent = state.hint;
      proxyHintEl.classList.toggle("error", isError);
      proxyHintEl.classList.toggle("field-error", isError);
    }

    const downloadSourcePicker = new Picker("download-source-picker", (value) => {
      const next = normalizePrefs({ downloadSource: value as DownloadSource }).downloadSource;
      if (next === prefs.downloadSource) {
        return;
      }
      prefs = { ...prefs, downloadSource: next };
      renderNetworkUI();
      // 先存盘（壳在保存时作废版本清单缓存），再重新查一次：旧清单里的版本号
      // 是从另一个 registry 拉到的，留着会让人以为切换没生效。
      void (async () => {
        await persistConfigQuiet();
        registry = null;
        registryError = null;
        await loadRegistry();
      })();
    });
    downloadSourcePicker.setChoices(DOWNLOAD_SOURCE_CHOICES);
    downloadSourcePicker.setValue(prefs.downloadSource);

    /** 代理状态由后端算（核心库负责地址归一化与文案）；读不到就退成一句说明。 */
    async function refreshProxyState(): Promise<void> {
      try {
        proxyState = await invoke<ProxyState>("proxy_state");
        networkSupported = proxyState?.supported !== false;
      } catch (err) {
        proxyState = { supported: true, url: null, bypass: [], hint: `读取代理设置失败：${err}`, stateText: "" };
      }
      renderNetworkSupport();
      renderProxyHint();
    }

    const proxyModePicker = new Picker("proxy-mode-picker", (value) => {
      const next = normalizePrefs({ proxyMode: value as ProxyMode }).proxyMode;
      if (next === prefs.proxyMode) {
        return;
      }
      prefs = { ...prefs, proxyMode: next };
      renderNetworkUI();
      // 切模式不必重查版本：地址变了要等下一次启动才生效，这里只把存盘与提示跟上。
      void (async () => {
        await persistConfigQuiet();
        await refreshProxyState();
      })();
    });
    proxyModePicker.setChoices(PROXY_MODE_CHOICES);
    proxyModePicker.setValue(prefs.proxyMode);

    /** 提交地址：只在失焦与回车时调，不跟着每次敲键存盘。 */
    function commitProxyAddress(): void {
      const next = proxyAddressInput.value.trim();
      if (next === prefs.proxyAddress) {
        return;
      }
      prefs = { ...prefs, proxyAddress: next };
      void (async () => {
        // 这条路径单独看存盘结果：地址填错时后端会拒收整份配置，
        // 不报出来的话输入框里留着「看起来已经生效」的地址，重开才回到旧值。
        const err = await persistConfigQuiet();
        proxySaveError = err;
        renderProxyHint();
        await refreshProxyState();
      })();
    }

    proxyAddressInput.addEventListener("blur", commitProxyAddress);
    proxyAddressInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitProxyAddress();
        proxyAddressInput.blur();
      }
    });

    // 自检（「测试连接」）：结果只属于「点下的这一次」。存在这里的变量里，
    // 不放进 prefs、也不跟着每秒的状态刷新重算——自动刷新把用户刚看到的结果
    // 抹掉是本卡最容易被投诉的毛病。只有改了下载源才清空（那时的结论已经不适用了）。
    const btnSelfCheck = $<HTMLButtonElement>("btn-self-check");
    const selfCheckStatus = $<HTMLParagraphElement>("self-check-status");
    const selfCheckDetail = $<HTMLParagraphElement>("self-check-detail");
    let selfCheckReport: SelfCheckReport | null = null;
    /** 正在进行中的请求：非 null 时按钮禁用，连点也不会发第二次。 */
    let selfCheckRunning = false;

    /** 结果行的文案：三态各一句，通了要说清是走代理通的还是直连通的。 */
    function selfCheckLine(report: SelfCheckReport): string {
      const source = report.registry ?? "npm 全局配置里的源";
      // 当前代理状态由后端一句话给出（与上方 hint 同一套口径），这里只负责拼上去。
      const proxyNow = proxyState?.stateText ? ` ${proxyState.stateText}。` : "";
      switch (report.state) {
        case "proxyOk":
          return report.via === "proxy" && report.proxy
            ? `通了：经代理 ${report.proxy} 访问 ${source} 成功，下载会走这条路。`
            : `通了：直连 ${source} 成功（这次没走代理），下载会走这条路。`;
        case "directOnly":
          return `只有直连能通：去掉代理后访问 ${source} 成功了。真实下载仍然会带代理，所以很可能下不动——建议检查代理设置，或者选「不走代理」。${proxyNow}`;
        default:
          return `两种都不通：带代理和不带代理都没拿到 ${source} 的数据。先看下面的原因，再检查代理设置或换一个下载源。${proxyNow}`;
      }
    }

    function renderSelfCheck(): void {
      const report = selfCheckReport;
      btnSelfCheck.disabled = selfCheckRunning;
      btnSelfCheck.textContent = selfCheckRunning ? "测试中…" : "测试连接";
      if (selfCheckRunning) {
        selfCheckStatus.textContent = "正在测试…（最多要等十几秒）";
        selfCheckStatus.classList.remove("error");
        selfCheckDetail.classList.add("hidden");
        selfCheckDetail.textContent = "";
        return;
      }
      if (report === null) {
        selfCheckStatus.textContent = "用当前下载源与代理设置跑一次真实请求，确认到底通不通。";
        selfCheckStatus.classList.remove("error");
        selfCheckDetail.classList.add("hidden");
        selfCheckDetail.textContent = "";
        return;
      }
      selfCheckStatus.textContent = selfCheckLine(report);
      selfCheckStatus.classList.toggle("error", report.state !== "proxyOk");
      // 失败原因单独一行：它是「一句中文 + 一行原文」，跟上面那句混在一起太长。
      const failure = report.failure;
      selfCheckDetail.classList.toggle("hidden", failure === null);
      selfCheckDetail.textContent = failure ?? "";
    }

    async function runSelfCheck(): Promise<void> {
      // 已有一个在跑：什么也不做（按钮本来就禁用着，这里再拒一次防竞态）。
      if (selfCheckRunning) {
        return;
      }
      selfCheckRunning = true;
      renderSelfCheck();
      try {
        selfCheckReport = await invoke<SelfCheckReport>("self_check_network", {
          runtime,
          source: prefs.downloadSource,
        });
      } catch (err) {
        // 命令本身没跑起来（IPC 出错）：当作「都不通」上报，同样带一句原因。
        selfCheckReport = {
          state: "bothFail",
          via: "direct",
          registry: null,
          proxy: null,
          failure: `自检没能执行：${err}`,
        };
      } finally {
        selfCheckRunning = false;
        renderSelfCheck();
      }
    }

    btnSelfCheck.addEventListener("click", () => void runSelfCheck());

    renderNetworkUI();
    const modesSummary = $<HTMLSpanElement>("modes-summary");
    const bridgeSummary = $<HTMLSpanElement>("bridge-summary");
    const btnCopyLog = $<HTMLButtonElement>("btn-copy-log");
    const bridgeTarget = $<HTMLElement>("bridge-target");
    const bridgeStatus = $<HTMLElement>("bridge-status");
    const bridgeBackup = $<HTMLElement>("bridge-backup");
    const bridgeError = $<HTMLParagraphElement>("bridge-error");
    const bridgeNote = $<HTMLParagraphElement>("bridge-note");
    const btnBridgeInstall = $<HTMLButtonElement>("btn-bridge-install");
    const btnBridgeUninstall = $<HTMLButtonElement>("btn-bridge-uninstall");
    const btnBridgeRestore = $<HTMLButtonElement>("btn-bridge-restore");
    const btnBridgeBackups = $<HTMLButtonElement>("btn-bridge-backups");
    const aboutDsh = $<HTMLElement>("about-dsh");
    const aboutNote = $<HTMLParagraphElement>("about-note");
    // 浮在窗口右上角的三颗窗口按钮。窗口一律无边框，这里理论上必然存在；
    // 仍用可空取法，是因为这段代码在普通浏览器预览里也要能跑通。
    const btnWinMin = root.querySelector<HTMLButtonElement>("#win-min");
    const btnWinMax = root.querySelector<HTMLButtonElement>("#win-max");
    const btnWinClose = root.querySelector<HTMLButtonElement>("#win-close");
    const btnAboutConfig = $<HTMLButtonElement>("btn-about-config");
    const btnAboutLogs = $<HTMLButtonElement>("btn-about-logs");

    // ---- 集成面板：命令行集成（PATH 与 dsh 垫片） ------------------------------
    // 展示内容全部由后端算好（目录、垫片内容、手动命令、状态说明），界面只负责渲染，
    // 免得两边各算一套口径对不上。
    const cliSummary = $<HTMLSpanElement>("integrations-summary");
    const cliToggle = $<HTMLInputElement>("cli-toggle");
    const cliBinDir = $<HTMLElement>("cli-bin-dir");
    const cliShimPath = $<HTMLElement>("cli-shim-path");
    const cliManual = $<HTMLElement>("cli-manual");
    const cliShimText = $<HTMLPreElement>("cli-shim-text");
    const cliMessage = $<HTMLParagraphElement>("cli-message");
    const cliError = $<HTMLParagraphElement>("cli-error");
    const btnCliDir = $<HTMLButtonElement>("btn-cli-dir");
    const btnCliCopy = $<HTMLButtonElement>("btn-cli-copy");
    const btnCliCopyShim = $<HTMLButtonElement>("btn-cli-copy-shim");
    // 「自动接入」那两半截（开关 + 目录、垫片内容）只在 Windows 下有意义。
    const cliWindowsOnly = Array.from(root.querySelectorAll<HTMLElement>(".cli-windows-only"));

    // ---- 集成面板：npx 缓存盘面 --------------------------------------------------
    // 占用字节、可回收字节、目录明细、每次删除的结果都在后端算好，界面只渲染。
    const CACHE_WINDOWS_ONLY = Array.from(root.querySelectorAll<HTMLElement>(".cache-windows-only"));
    const cacheOwn = $<HTMLElement>("cache-own");
    const cacheReclaimable = $<HTMLElement>("cache-reclaimable");
    const cacheRoot = $<HTMLElement>("cache-root");
    const btnCacheClean = $<HTMLButtonElement>("btn-cache-clean");
    const cacheMessage = $<HTMLParagraphElement>("cache-message");
    const cacheWarning = $<HTMLParagraphElement>("cache-warning");
    const cacheError = $<HTMLParagraphElement>("cache-error");
    const cacheDirs = $<HTMLPreElement>("cache-dirs");
    const cacheResults = $<HTMLDivElement>("cache-results");
    const cacheResultsBody = $<HTMLDivElement>("cache-results-body");
    const cacheAutoToggle = $<HTMLInputElement>("cache-auto-toggle");

    // 分区导航：点左侧图标切右侧面板。选择记在 localStorage，壳重启、轻量模式重建窗口后沿用。
    // 不放 config.json：那是整份回写的设置文件，界面偏好丢了不影响功能。
    const PANEL_KEY = "dsharbor.ui.panel";
    const navButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-panel-btn]"));
    const panelSections = Array.from(root.querySelectorAll<HTMLElement>("[data-panel]"));
    /** 内容区整体滚动（工具栏与左栏固定），滚动指示条挂在它的外层。 */

    function readStoredPanel(): PanelKey {
      try {
        const saved = window.localStorage.getItem(PANEL_KEY);
        if (PANELS.some((item) => item.key === saved)) {
          return saved as PanelKey;
        }
      } catch {
        // 存储被禁用：用默认分区。
      }
      return "launch";
    }

    let currentPanel: PanelKey = readStoredPanel();

    /** 切换分区：同步 aria-current 与可见性，并把主卡滚回顶部（换内容时留着旧滚动位置很莫名）。
        滚动容器是当前分区那张主卡（`.block.main-card`），不是 #page。 */
    const selectPanel = (key: PanelKey, persist: boolean): void => {
      currentPanel = key;
      for (const button of navButtons) {
        button.setAttribute("aria-current", button.dataset.panelBtn === key ? "true" : "false");
      }
      for (const panel of panelSections) {
        const showing = panel.dataset.panel === key;
        panel.classList.toggle("hidden", !showing);
        // 换内容时留着旧滚动位置很莫名：主卡（唯一的滚动容器）回到顶部。
        if (showing) {
          for (const host of panel.querySelectorAll<HTMLElement>(".block.main-card")) host.scrollTop = 0;
        }
      }
      updateScrollThumbHook();
      if (persist) {
        try {
          window.localStorage.setItem(PANEL_KEY, key);
        } catch {
          // 存储被禁用时忽略：本次会话仍按内存里的状态走
        }
      }
    };

    for (const button of navButtons) {
      button.addEventListener("click", () => {
        selectPanel(button.dataset.panelBtn as PanelKey, true);
      });
    }
    selectPanel(currentPanel, false);

    // ---- 日志：一条窄箭头开关 + 盖住内容的浮层 ---------------------------------
    // 折叠状态与「用户本次会话里手动收过」都记在 localStorage：主动操作触发的自动展开
    // 不能抢过用户的收缩动作（收过一次就不再抢开）。
    const LOG_OPEN_KEY = "dsharbor.ui.logOpen";

    function readLogOpen(): boolean {
      try {
        return window.localStorage.getItem(LOG_OPEN_KEY) === "1";
      } catch {
        return false;
      }
    }

    let logOpen = readLogOpen();
    /** 用户手动收过一次：本次会话里不再被主动操作拉起来。 */
    let logSuppressed = false;
    /** 浮层打开、内容刷新后要不要把滚动条拉到底（用户往上翻时不抢）。 */
    let logFollow = true;

    function paintLogOpen(): void {
      logBarToggle.classList.toggle("is-open", logOpen);
      logBarToggle.setAttribute("aria-expanded", logOpen ? "true" : "false");
      const title = logOpen ? "收起日志" : "展开日志";
      logBarToggle.title = title;
      logBarToggle.setAttribute("aria-label", title);
      logPanel.classList.toggle("hidden", !logOpen);
      logScrim.classList.toggle("hidden", !logOpen);
      logPanel.setAttribute("aria-hidden", logOpen ? "false" : "true");
      if (logOpen) {
        logFollow = true;
        scrollLogToEnd();
      }
    }

    function setLogOpen(open: boolean): void {
      logOpen = open;
      logSuppressed = !open;
      paintLogOpen();
      try {
        window.localStorage.setItem(LOG_OPEN_KEY, open ? "1" : "0");
      } catch {
        // 存储被禁用时只影响下次启动的初始状态
      }
    }

    /** 主动操作（启动 / 重启 / 桥接 / 环境 / 缓存）产生的输出：自动展开浮层，除非用户手动收过。 */
    const expandLog = (): void => {
      if (logSuppressed) return;
      if (!logOpen) {
        logOpen = true;
        paintLogOpen();
      }
      logFollow = true;
      scrollLogToEnd();
    };

    function scrollLogToEnd(): void {
      if (!logOpen) return;
      window.requestAnimationFrame(() => {
        logEl.scrollTop = logEl.scrollHeight;
      });
    }

    logEl.addEventListener("scroll", () => {
      const distance = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight;
      logFollow = distance < 24;
    });

    logBarToggle.addEventListener("click", () => setLogOpen(!logOpen));
    logCollapse.addEventListener("click", () => setLogOpen(false));
    logScrim.addEventListener("click", () => setLogOpen(false));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && logOpen) setLogOpen(false);
    });
    paintLogOpen();

    /** 日志浮层右上角的「清空日志」：只清界面这一份（后端的环形缓冲不动）。 */
    btnClearLog.addEventListener("click", () => clearLog());

    /** 写剪贴板：先试剪贴板 API，不可用时退回「选中 + execCommand」。返回是否成功。 */
    async function writeText(text: string): Promise<boolean> {
      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error("剪贴板 API 不可用");
        }
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // 兜底：临时建一个不可见的 textarea 选中复制（WebView2 支持 execCommand）。
        const holder = document.createElement("textarea");
        holder.value = text;
        holder.setAttribute("readonly", "");
        holder.style.position = "fixed";
        holder.style.opacity = "0";
        document.body.appendChild(holder);
        holder.select();
        let ok = false;
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
        holder.remove();
        return ok;
      }
    }

    /** 按钮上的「复制」：复制某个元素里的文本，并在按钮上短暂回显结果。
        日志面板的「复制日志」与命令行集成的「手动命令」「垫片内容」共用这一套。 */
    function copyLog(source: HTMLElement, button: HTMLButtonElement): void {
      void (async () => {
        const ok = await writeText(source.textContent ?? "");
        button.textContent = ok ? "已复制" : "复制失败";
        window.setTimeout(() => {
          button.textContent = "复制";
        }, 1500);
      })();
    }

    btnCopyLog.addEventListener("click", () => copyLog(logEl, btnCopyLog));
    for (const [button, source] of [
      [btnCliCopy, cliManual],
      [btnCliCopyShim, cliShimText],
    ] as const) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        copyLog(source, button);
      });
    }

    // 桥接插件小节的状态：busy 防重复点击；lastBridgeState 供「恢复最近备份」用。
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

    /**
     * 静默保存当前配置（编辑中暂时不合法时跳过，启动时会再校验）。
     *
     * 返回存盘失败的理由；存成功了返回 null。大多数调用方不关心，但代理地址那条路径
     * 必须把错误报给用户：后端会拒收填错的地址，静静吞掉就成了「看起来生效、重开就没了」。
     */
    async function persistConfigQuiet(): Promise<string | null> {
      if (portFieldError()) {
        renderPortHint();
        return null;
      }
      try {
        const shell: ShellConfig = {
          launch: collectConfig(),
          trayClick: trayPicker.value as TrayClick,
          lightDelaySecs: Number(lightDelayPicker.value),
          // 主题镜像一致即可；写进 save_shell_config 会被整份串行化，若不一致也顺手对齐
          // （正常路径由左栏底部的浅/深切换单独走 save_ui_theme）。
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
        return null;
      } catch (err) {
        console.debug("配置暂未保存:", err);
        return String(err);
      }
    }

    const modeRadios = () => Array.from(root.querySelectorAll<HTMLInputElement>('input[name="mode"]'));
    const currentMode = (): string => modeRadios().find((r) => r.checked)?.value ?? "npx";

    function syncModeFields(): void {
      $("npx-fields").classList.toggle("hidden", currentMode() !== "npx");
      $("binary-fields").classList.toggle("hidden", currentMode() !== "binary");
      $("custom-fields").classList.toggle("hidden", currentMode() !== "custom");
      // 「启动方式」卡片顶部的徽章显示当前启动方式。
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
        // 转换启动方式后垫片要跟着重写，否则终端里的 dsh 还是旧的那份（票据验收标准）。
        void syncCliShim();
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
    // 二进制路径与自定义命令直接决定垫片内容：改完（失焦/回车）就按新值重写。
    for (const input of [binaryPath, customCommand]) {
      input.addEventListener("change", () => void syncCliShim());
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
    // 启动/停止失败时后端返回的错误（与轮询到的会话错误分开保存，
    // 否则下一次轮询（每秒一次）会把刚显示的错误清掉）。
    let localError: string | null = null;

    /** 把说明写进登录徽章的感叹号气泡（悬停或键盘聚焦时显示）。 */
    function setLoginTip(text: string): void {
      loginInfo.dataset.tip = text;
      loginInfo.setAttribute("aria-label", `登录链接说明：${text}`);
    }

    /**
     * 日志面板的文本更新。
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

    // ---- 统一日志 ------------------------------------------------------------------
    // 界面里只留一个日志：后端 DSH 进程的输出尾部 + 桥接 / 环境 / 缓存这些主动操作的结果都写进
    // 这一份，不随切分区丢、不自动清，只有点「清空日志」或完全退出程序才清。
    // 后端的环形缓冲留 1200 行、状态查询每次给最后 300 行（见 launcher.rs），这里只负责
    // 算出「这一轮新长出来的那几行」，不然每秒轮询会把同一段尾巴反复追加一遍。
    let logText = "";
    /** 上一轮拿到的日志尾部：用来做增量比对，只追加新增的那几行。 */
    let lastLogTail: string[] | null = null;
    /** 上一次往日志里写东西的时间：间隔太长就补一条 `--- 时间 ---` 分段线。 */
    let lastLogAt = 0;
    const LOG_GAP_MS = 10 * 60 * 1000;

    function logStamp(): string {
      const now = new Date();
      const pad = (value: number): string => String(value).padStart(2, "0");
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    /** 往日志末尾追加一批行；`stamp` 为真时先插一条 `--- 时间 ---` 分段线。 */
    function appendLog(lines: string[], stamp: boolean): void {
      const body = lines.join("\n").replace(/\s+$/, "");
      if (body === "") return;
      const needStamp = stamp || lastLogAt === 0 || Date.now() - lastLogAt > LOG_GAP_MS;
      const chunk = needStamp ? `--- ${logStamp()} ---\n${body}` : body;
      // 同一批次的连续追加只用单换行接上；换批次（带分段线）时前面空一行。
      const separator = logText === "" ? "" : needStamp ? "\n\n" : "\n";
      logText = `${logText.replace(/\s+$/, "")}${separator}${chunk}`;
      lastLogAt = Date.now();
      setOutputText(logEl, logText);
      if (logFollow) scrollLogToEnd();
    }

    /** 主动操作的结果（桥接 / 环境 / 缓存）：写进统一日志，并拉起浮层（用户手动收过就只写不拉）。 */
    function logAction(text: string): void {
      expandLog();
      appendLog([text], true);
    }

    /** 后端日志尾部：算出新增的那几行（上一轮的尾巴可能已被环形缓冲挤掉前半段，所以两头都试）。 */
    function syncLogFromTail(tail: string[]): void {
      const previous = lastLogTail;
      lastLogTail = [...tail];
      if (previous === null) {
        appendLog(tail, false);
        return;
      }
      if (tail.length === 0) return;
      // 正常情况：上一轮尾巴是这一轮的前缀，新的就是尾部多出来的那几行。
      const sameHead = previous.length <= tail.length && previous.every((line, index) => line === tail[index]);
      if (sameHead) {
        if (tail.length > previous.length) appendLog(tail.slice(previous.length), false);
        return;
      }
      // 缓冲已满、上一轮的尾巴被挤掉前半段：找最长的重叠部分拼上去。
      const limit = Math.min(previous.length, tail.length);
      for (let overlap = limit; overlap > 0; overlap -= 1) {
        const tailStart = tail.length - overlap;
        let same = true;
        for (let i = 0; i < overlap; i += 1) {
          if (previous[previous.length - overlap + i] !== tail[tailStart + i]) {
            same = false;
            break;
          }
        }
        if (same) {
          if (overlap < tail.length) appendLog(tail.slice(overlap), false);
          return;
        }
      }
      // 完全接不上（DSH 重启、换了环境）：整段当成新的一批。
      appendLog(tail, true);
    }

    function clearLog(): void {
      logText = "";
      lastLogTail = null;
      lastLogAt = 0;
      logEl.textContent = "（暂无输出）";
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
      syncLogFromTail(status.logTail);
      const running = status.state === "running";
      // 「启动 DSH」与「停止」是同一个按钮（维护者要求）：按状态换文案与语义。
      // 后端只在子进程还活着时给 Running，Failed 必然是进程已退出，所以按 running 二分就够。
      renderToggleButton(!running);
      btnToggle.classList.toggle("primary", !running);
      // 「重启 DSH」只在运行中出现（维护者要求）：启动前整个界面只有一个「启动 DSH」，
      // 起来之后才同时给出「停止 / 重启 DSH」。
      btnRestart.classList.toggle("hidden", !running);
      // 「打开方式」：启动前后都在，只在登录链接就绪后可点（没链接时点开也没用）。
      btnOpen.disabled = !status.loginReady;
      btnOpenMore.disabled = !status.loginReady;

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
      // 自动清理是后端在真的拉起 DSH 进程之后自己跑的，没有推送通道：顺路问一句有没有新结果。
      await pollAutoCleanup();
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
      // 启动/重启 DSH 都会产生终端输出：自动展开日志浮层（维护者要求）。
      expandLog();
      try {
        await invoke(command, { config: collectConfig() });
      } catch (err) {
        localError = String(err);
        // 命令被后端拒绝（如端口占用）：重启没真正发生，立即收拾掉点击时的转动。
        if (command === "restart_dsh") endRestartSpin();
      }
      await refresh();
      // 新会话已经换成配置里的环境了：收起「需要重启」那一行，免得一直挂在那儿。
      pendingProfile = null;
      renderProfilesUI();
      void loadProfiles();
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

    // ---- 打开方式：主按钮 + 右侧小三角的两段式 ----------------------------------
    // 点小三角展开菜单 → 选一种方式 → 文字与图标回填到主按钮 → 再点主按钮才执行。
    // 选择记在 localStorage：下次启动沿用上次的方式（默认应用内打开）。
    const OPEN_MODE_KEY = "dsharbor.ui.openMode";
    type OpenMode = "app" | "browser" | "copy";
    const OPEN_MODES: ReadonlyArray<{ key: OpenMode; label: string; icon: string }> = [
      { key: "app", label: "应用内打开", icon: ICON_OPEN_APP },
      { key: "browser", label: "浏览器打开", icon: ICON_OPEN_BROWSER },
      { key: "copy", label: "复制登录链接", icon: ICON_COPY },
    ];

    function readOpenMode(): OpenMode {
      try {
        const raw = window.localStorage.getItem(OPEN_MODE_KEY);
        return raw === "browser" || raw === "copy" ? raw : "app";
      } catch {
        return "app";
      }
    }

    let openMode: OpenMode = readOpenMode();

    /** 主按钮回填当前方式；菜单里的勾选也跟着走。 */
    function paintOpenMode(): void {
      const mode = OPEN_MODES.find((item) => item.key === openMode) ?? OPEN_MODES[0];
      openIco.innerHTML = mode.icon;
      openText.textContent = mode.label;
      for (const item of Array.from(openMenu.querySelectorAll<HTMLButtonElement>("[data-open-mode]"))) {
        item.setAttribute("aria-checked", item.dataset.openMode === openMode ? "true" : "false");
      }
    }

    function setOpenMenuOpen(open: boolean): void {
      openMenu.classList.toggle("hidden", !open);
      btnOpenMore.setAttribute("aria-expanded", open ? "true" : "false");
    }

    btnOpenMore.addEventListener("click", (event) => {
      event.stopPropagation();
      setOpenMenuOpen(openMenu.classList.contains("hidden"));
    });
    document.addEventListener("click", () => setOpenMenuOpen(false));
    openMenu.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpenMenuOpen(false);
    });

    for (const item of Array.from(openMenu.querySelectorAll<HTMLButtonElement>("[data-open-mode]"))) {
      item.addEventListener("click", () => {
        openMode = item.dataset.openMode as OpenMode;
        try {
          window.localStorage.setItem(OPEN_MODE_KEY, openMode);
        } catch {
          // 存储被禁用时只在本次会话生效
        }
        paintOpenMode();
        setOpenMenuOpen(false);
      });
    }

    /** 复制登录链接：链接每次都重新取（token 是一次性铸造的），成功后按钮上短暂回显。 */
    async function copyLoginUrl(): Promise<void> {
      const url = await invoke<string>("dsh_login_url");
      const ok = await writeText(url);
      if (!ok) throw new Error("复制失败：剪贴板不可用");
      const label = openText.textContent;
      openText.textContent = "已复制链接";
      window.setTimeout(() => {
        if (openText.textContent === "已复制链接") openText.textContent = label;
      }, 1500);
    }

    // 主按钮：按当前方式真的去打开（应用内 / 浏览器 / 复制）。
    btnOpen.addEventListener("click", () => {
      void (async () => {
        localError = null;
        try {
          if (openMode === "app") {
            await invoke("open_dsh_window");
          } else if (openMode === "browser") {
            await invoke("open_dsh_in_browser");
          } else {
            await copyLoginUrl();
          }
        } catch (err) {
          localError = String(err);
          await refresh();
        }
      })();
    });

    paintOpenMode();

    // 左栏底部的官网 / 仓库链接（「关于」里不再重复这两项）。
    linkSite.addEventListener("click", () => void openExternal("site"));
    linkRepo.addEventListener("click", () => void openExternal("repo"));

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
        // 「桥接插件」卡片顶部的徽章显示安装状态。
        bridgeSummary.className = `badge ${state.installed ? "badge-running" : "badge-stopped"} panel-badge`;
        bridgeSummary.textContent = state.installed ? "已安装" : "未安装";
        bridgeBackup.textContent = state.latestBackup
          ? `最近备份：${state.latestBackup}`
          : "还没有备份：安装或卸载时会自动创建，可用「恢复最近备份」回滚。";
      } catch (err) {
        bridgeStatus.textContent = `读取失败：${err}`;
        bridgeSummary.className = "badge badge-failed panel-badge";
        bridgeSummary.textContent = "读取失败";
      }
    }

    function runBridgeOp(name: "bridge_install" | "bridge_uninstall"): void {
      void (async () => {
        bridgeBusy = true;
        updateBridgeButtons();
        bridgeError.classList.add("hidden");
        // 桥接操作会产生 pnpm/命令的终端输出：自动切到「环境」面板并拉起日志浮层（维护者要求）。
        selectPanel("env", true);
        logAction("桥接插件：执行中…（首次可能较慢，pnpm 需要解析依赖）");
        try {
          const outcome = await invoke<BridgeOutcome>(name, { config: collectConfig() });
          logAction(outcome.message);
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
          // 恢复同样产生终端输出：自动切到「环境」面板并拉起日志浮层。
          selectPanel("env", true);
          const message = await invoke<string>("bridge_restore", {
            config: collectConfig(),
            backupDir: backup,
          });
          logAction(message);
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

    // ---- 环境面板：选当前启动用哪一份 DSH 环境（profile） ----------------------
    // 只列能起网页界面的环境；下拉项文案与摘要徽章都由核心库的 `ProfileSummary`
    // 算好（名字 · 插件数 · 桥接状态），界面不另算一套口径。
    const profilesSummary = $<HTMLSpanElement>("profiles-summary");
    const profileHintEl = $<HTMLParagraphElement>("profile-hint");
    const profileNote = $<HTMLParagraphElement>("profile-note");
    const profileError = $<HTMLParagraphElement>("profile-error");
    const profileRestartRow = $<HTMLElement>("profile-restart-row");
    const btnProfileRestart = $<HTMLButtonElement>("btn-profile-restart");
    // 非 Windows 宿主把整卡内容收起、只留一条说明（同集成卡的 .cli-windows-only）。
    const profilesWindowsOnly = $<HTMLElement>("profiles-windows-only");
    const profilesContent = $<HTMLElement>("profiles-content");
    /** 后端枚举回来的全部环境（含不能选的，便于提示「当前环境不可用」）。 */
    let profileList: ProfileSummary[] = [];
    /** 当前宿主能不能枚举环境；false 时环境卡收起并只说这一件事。 */
    let profilesSupported = true;
    /** 已切换但还没重启时记住目标名字，用来决定「提示重启」那一行显不显示。 */
    let pendingProfile: string | null = null;

    const profileOf = (name: string): ProfileSummary | null =>
      profileList.find((item) => item.name === name) ?? null;

    /** 徽章文案：优先说当前选中的那份，选中的找不到时（环境被删了）如实说。 */
    function profileBadgeText(): string {
      if (!profilesSupported) {
        return "仅 Windows 可用";
      }
      const current = profileOf(prefs.profile);
      if (!current) {
        return profileList.length === 0 ? "没有可用环境" : `${prefs.profile}（找不到）`;
      }
      return `${current.name} · ${current.plugins} 个插件 · ${current.bridgeInstalled ? "桥接已装" : "桥接未装"}`;
    }

    function renderProfilesUI(): void {
      // 不支持的环境下收起整卡内容，只留一条「仅在 Windows 宿主可用」的说明，
      // 免得在下拉里看到一个永远为空的列表还以为环境全丢了。
      profilesWindowsOnly.classList.toggle("hidden", profilesSupported);
      profilesContent.classList.toggle("hidden", !profilesSupported);
      const current = profileOf(prefs.profile);
      profilesSummary.textContent = profileBadgeText();
      profilesSummary.className = `badge ${profilesSupported && current ? "badge-running" : "badge-stopped"} panel-badge`;
      profileHintEl.textContent = current
        ? `已登记 ${current.plugins} 个插件，${current.bridgeInstalled ? "桥接插件已装（能直接取带 token 的登录链接）" : "桥接插件未装（登录链接走日志兜底）"}。`
        : profileList.length === 0
          ? "还没读到任何能起网页界面的环境；先启动一次 DSH 会创建默认环境。"
          : `配置里记的环境「${prefs.profile}」已经不在了，从下拉里重新选一个。`;
      // 只有「已存进配置」且与当前环境不同的目标才需要重启生效。
      profileRestartRow.classList.toggle("hidden", pendingProfile === null || !profilesSupported);
    }

    function fillProfilePicker(): void {
      const selectable = profileList.filter((item) => item.webCapable && item.name !== "desktop");
      profilePicker.setChoices(
        selectable.map((item) => ({ value: item.name, label: `${item.name} · ${item.plugins} 个插件` })),
      );
      // 当前环境不在可选集里（被删了 / 还没读到）时不强行改 value，让下拉停在原值上，
      // 由下面的说明文字告诉用户去重选。
      if (selectable.some((item) => item.name === prefs.profile)) {
        profilePicker.setValue(prefs.profile);
      }
    }

    async function loadProfiles(): Promise<void> {
      try {
        const listing = await invoke<ProfileListing>("list_profiles", { config: collectConfig() });
        profilesSupported = listing.supported;
        profileList = listing.profiles;
        profileError.classList.add("hidden");
      } catch (err) {
        // 读取失败不等于不支持：把失败原因如实反映出来，卡内容照旧展开，
        // 免得把一次暂时读盘失败说成「这个平台不支持」。
        profilesSupported = true;
        profileList = [];
        profileError.textContent = `读取环境列表失败：${err}`;
        profileError.classList.remove("hidden");
      }
      fillProfilePicker();
      renderProfilesUI();
      // 管理面板与下拉看的是同一份环境清单，重读后一起刷新。
      renderManageUI();
    }

    /** 切环境：写配置 → 需要时补装桥接 → 提示重启。不自动重启，免得断掉正在跑的会话。 */
    async function selectProfile(name: string): Promise<void> {
      if (name === prefs.profile) {
        return;
      }
      profileError.classList.add("hidden");
      const previous = prefs.profile;
      prefs = { ...prefs, profile: name };
      pendingProfile = name;
      renderProfilesUI();
      await persistConfigQuiet();
      // 环境名进了配置文件，后续所有插件操作与启动都按新环境走（后端从磁盘读）。
      const target = profileOf(name);
      const running = currentStatus?.state === "running";
      if (target && !target.bridgeInstalled) {
        if (running) {
          // 实例在跑的时候不能改它的 profile 文件（pnpm 会抢锁）：只提示，不打断。
          profileNote.textContent = `「${name}」里还没装桥接插件；先停止 DSH，重启时会自动装好。`;
          profileNote.classList.remove("hidden");
        } else {
          profileNote.textContent = `正在给「${name}」安装桥接插件…`;
          profileNote.classList.remove("hidden");
          try {
            // 后端从磁盘读环境名，所以必须先落盘再调。
            const outcome = await invoke<BridgeOutcome>("bridge_install", { config: collectConfig() });
            profileNote.textContent = outcome.ok
              ? `已给「${name}」装好桥接插件。`
              : `给「${name}」装桥接插件没成功：${outcome.message}`;
          } catch (err) {
            profileNote.textContent = `给「${name}」装桥接插件失败：${err}`;
          }
        }
      } else {
        profileNote.classList.add("hidden");
      }
      // 切换后重读列表（桥接可能刚装上）与桥接卡状态。
      await loadProfiles();
      void refreshBridgeState();
      void syncCliShim();
      if (running) {
        // 实例还在跑：写清「现在跑的还是旧环境」——这句比「已装好桥接」重要，覆盖它。
        profileNote.classList.remove("hidden");
        profileNote.textContent = `已切到「${name}」；正在跑的会话仍是「${previous}」，重启后才会用新环境。`;
      }
    }

    const profilePicker = new Picker("profile-picker", (value) => {
      void selectProfile(value);
    });
    btnProfileRestart.addEventListener("click", () => {
      pendingProfile = null;
      renderProfilesUI();
      beginRestartSpin();
      void startOrRestart("restart_dsh");
    });

    // ---- 管理环境：新建 / 复制 / 重命名 / 删除 ---------------------------------
    // 四个动作的规则（名字合法性、哪些不能删、依赖目录与锁文件不跟着复制）全在后端，
    // 界面只负责收集名字、转述后端那句中文说明、刷新列表。
    const profileManagePanel = $<HTMLElement>("profile-manage");
    const profileManageList = $<HTMLElement>("profile-manage-list");
    const profileManageName = $<HTMLInputElement>("profile-manage-name");
    const profileManageNameLabel = $<HTMLElement>("profile-manage-name-label");
    const profileManageNote = $<HTMLParagraphElement>("profile-manage-note");
    const profileManageError = $<HTMLParagraphElement>("profile-manage-error");
    const profileManageConfirm = $<HTMLElement>("profile-manage-confirm");
    const profileManageConfirmText = $<HTMLParagraphElement>("profile-manage-confirm-text");
    const btnProfileManage = $<HTMLButtonElement>("btn-profile-manage");
    const btnProfileCreate = $<HTMLButtonElement>("btn-profile-create");
    const btnProfileCopy = $<HTMLButtonElement>("btn-profile-copy");
    const btnProfileRename = $<HTMLButtonElement>("btn-profile-rename");
    const btnProfileDelete = $<HTMLButtonElement>("btn-profile-delete");
    const btnProfileDeps = $<HTMLButtonElement>("btn-profile-deps");
    const btnProfileConfirmYes = $<HTMLButtonElement>("btn-profile-confirm-yes");
    const btnProfileConfirmNo = $<HTMLButtonElement>("btn-profile-confirm-no");
    /** 面板里选中的「操作对象」环境；与「启动用环境」是两件事，互不影响。 */
    let manageTarget: string | null = null;
    /** 正在跑的动作（忙时所有按钮置灰，防重复提交）。 */
    let manageBusy = false;
    /** 删除的二次确认阶段：非空时确认行显示。 */
    let managePendingDelete: string | null = null;

    /** 后端返回值：与 Rust 侧 `profile_ops::ProfileOutcome` 对应。 */
    interface ProfileOutcome {
      ok: boolean;
      message: string;
      name: string;
      summary: ProfileSummary | null;
    }

    // ---- 管理环境：补丁层备份 / 还原 ---------------------------------------------
    // 规则（文件名、保留份数、还原前另存与说明文案）全在后端 `patch_layer` 里算，
    // 界面只负责：对选中的那个环境发命令、把备份列表列出来、把说明原文贴出来。
    const profilePatchPanel = $<HTMLElement>("profile-patch");
    const patchBackupList = $<HTMLElement>("patch-backup-list");
    const btnPatchBackup = $<HTMLButtonElement>("btn-patch-backup");
    const patchRestoreConfirm = $<HTMLElement>("patch-restore-confirm");
    const patchRestoreConfirmText = $<HTMLParagraphElement>("patch-restore-confirm-text");
    const btnPatchConfirmYes = $<HTMLButtonElement>("btn-patch-confirm-yes");
    const btnPatchConfirmNo = $<HTMLButtonElement>("btn-patch-confirm-no");

    /** 与 Rust 侧 `patch_layer::PatchBackup` 对应（最旧在前）。 */
    interface PatchBackup {
      name: string;
      path: string;
      stamp: number;
    }

    /** 与 Rust 侧 `patch::PatchOutcome` 对应。 */
    interface PatchOutcome {
      message: string;
      path: string;
      backups: PatchBackup[];
    }

    /** 当前选中环境的补丁层备份（最旧在前，与后端返回顺序一致）。 */
    let patchBackups: PatchBackup[] = [];
    /** 补丁层动作是否在跑（忙时按钮置灰，防重复提交）。 */
    let patchBusy = false;
    /** 已拉取备份清单的那个环境；换环境才重新拉，避免每次渲染都打一趟后端。 */
    let patchLoadedFor: string | null = null;
    /** 待确认的还原目标（备份文件名）；非 null 时确认行展开（与删除那处同一个写法）。 */
    let patchPendingRestore: string | null = null;

    // ---- 管理环境：插件开关 ------------------------------------------------------
    // 哪些插件、现在开没开、该往补丁层写什么，规则全在后端
    // （dsharbor_core::plugin_switch）。界面只负责：列出来、发开关命令、把后端
    // 那句中文说明与提醒原文贴出来。
    const profilePluginPanel = $<HTMLElement>("profile-plugins");
    const pluginList = $<HTMLElement>("plugin-list");
    const pluginEmpty = $<HTMLElement>("plugin-empty");
    const pluginNote = $<HTMLParagraphElement>("plugin-note");
    const pluginWarning = $<HTMLParagraphElement>("plugin-warning");
    const btnPluginDeps = $<HTMLButtonElement>("btn-plugin-deps");

    /** 与 Rust 侧 `plugin_switch::PluginItem` 对应。 */
    interface PluginItem {
      name: string;
      entries: string[];
      enabled: boolean;
      bridge: boolean;
      manual: boolean;
      switchable: boolean;
    }

    /** 与 Rust 侧 `plugin_switch::ToggleOutcome` 对应。 */
    interface ToggleOutcome {
      message: string;
      backup: string;
      warning: string | null;
      items: PluginItem[];
    }

    /** 当前选中环境实际加载的插件（后端顺序，与 package.json 里登记的顺序一致）。 */
    let pluginItems: PluginItem[] = [];
    /** 插件清单是否已拉过（未拉到时不能把空数组当成「零插件」画空状态）。 */
    let pluginLoaded = false;
    /** 已为哪个环境拉过清单；换环境才重新拉。 */
    let pluginLoadedFor: string | null = null;
    /** 插件开关动作是否在跑（忙时所有开关置灰，防重复提交）。 */
    let pluginBusy = false;

    /** 备份时间戳（unix 秒）→ 本地时间文本；文件名里就是它，用户能对着看。 */
    function stampLabel(stamp: number): string {
      const date = new Date(stamp * 1000);
      const pad = (value: number): string => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** 备份清单：最新的在最上面，每行能直接点「还原」；路径原文照抄，方便自己去翻。 */
    function renderPatchList(): void {
      if (patchBackups.length === 0) {
        patchBackupList.innerHTML = `<p class="hint">这个环境还没有补丁层备份。改补丁层之前先点「备份补丁层」留个底。</p>`;
        return;
      }
      const newest = patchBackups[patchBackups.length - 1]?.name ?? "";
      patchBackupList.innerHTML = [...patchBackups]
        .reverse()
        .map((item) => {
          const tag = item.name === newest ? `<span class="profile-manage-tag">最新</span>` : "";
          const disabled = patchBusy || manageBusy ? " disabled" : "";
          return `<div class="patch-backup-row"><span class="patch-backup-time">${stampLabel(item.stamp)}</span><span class="patch-backup-path">${escapeHtml(item.path)}</span>${tag}<button type="button" class="kv-action" data-patch-restore="${escapeHtml(item.name)}"${disabled}>还原这一份</button></div>`;
        })
        .join("");
      for (const button of patchBackupList.querySelectorAll<HTMLButtonElement>("[data-patch-restore]")) {
        button.addEventListener("click", () => {
          // 第一下只展开确认行；真正改文件要再点一次「确定还原」。
          patchPendingRestore = button.dataset.patchRestore ?? "";
          setManageError(null);
          setManageNote(null);
          renderManageUI();
        });
      }
    }

    /** 选中环境变了才重新拉备份清单；同一个环境只拉一次。 */
    function syncPatchPanel(): void {
      const target = manageTarget;
      profilePatchPanel.classList.toggle("hidden", target === null);
      if (target === null) {
        patchBackups = [];
        patchLoadedFor = null;
        renderPatchList();
        return;
      }
      if (patchLoadedFor !== target) {
        patchLoadedFor = target;
        patchBackups = [];
        renderPatchList();
        // 换环境才拉一次：每次重渲染都打一趟后端没必要（这只是一个目录列举）。
        void refreshPatchBackups(target);
        return;
      }
      renderPatchList();
    }

    /** 读一次备份清单（读失败只提示，不打断其它面板动作）。 */
    async function refreshPatchBackups(name: string): Promise<void> {
      try {
        const list = await invoke<PatchBackup[]>("patch_backups", { config: collectConfig(), name });
        if (manageTarget !== name) {
          return; // 期间换了环境，丢弃这批结果
        }
        patchBackups = list;
        renderPatchList();
      } catch (err) {
        if (manageTarget === name) {
          setManageError(`读取补丁层备份失败：${String(err)}`);
        }
      }
    }

    /** 备份补丁层：成功与否都要落地一句原文（含路径），失败原因不吞。 */
    async function backupPatchLayer(): Promise<void> {
      const name = manageTarget;
      if (!name || patchBusy || manageBusy) {
        return;
      }
      patchBusy = true;
      setManageError(null);
      setManageNote(null);
      renderManageUI();
      try {
        const outcome = await invoke<PatchOutcome>("patch_backup", { config: collectConfig(), name });
        patchBackups = outcome.backups;
        patchLoadedFor = name;
        logAction(outcome.message);
      } catch (err) {
        setManageError(String(err));
        logAction(`备份补丁层失败：${String(err)}`);
      } finally {
        patchBusy = false;
        renderManageUI();
      }
    }

    /**
     * 还原到某一份备份。
     *
     * 会覆盖当前的补丁层文件，所以界面上先要一次确认（与删除同一个写法）：
     * 后端覆盖前会把当前版本另存一份备份，因此这一步可反悔，但那不等于不用问。
     */
    async function restorePatchLayer(backup: string): Promise<void> {
      const name = manageTarget;
      if (!name || !backup || patchBusy || manageBusy) {
        return;
      }
      patchPendingRestore = null;
      patchBusy = true;
      setManageError(null);
      setManageNote(null);
      renderManageUI();
      try {
        const outcome = await invoke<PatchOutcome>("patch_restore", {
          config: collectConfig(),
          name,
          backup,
        });
        patchBackups = outcome.backups;
        patchLoadedFor = name;
        logAction(outcome.message);
      } catch (err) {
        setManageError(String(err));
        logAction(`还原补丁层失败：${String(err)}`);
      } finally {
        patchBusy = false;
        renderManageUI();
      }
    }

    /**
     * 插件清单：一行一个插件，开/关一个复选框。
     *
     * 三件必须一眼看到的事：桥接插件要标出来（关掉它登录链接只能靠日志）；
     * 禁用表达写在补丁层里某处的要说明来源（用户手写的不等于壳生成的）；
     * 读不到挂载点的内置骨架包开关置灰（壳不往补丁层塞 DSH 不认识的 id）。
     */
    function renderPluginList(): void {
      const hasItems = pluginItems.length > 0;
      pluginEmpty.classList.toggle("hidden", hasItems || !pluginLoaded);
      pluginList.innerHTML = pluginItems
        .map((item) => {
          const marks: string[] = [];
          if (item.bridge) {
            marks.push(`<span class="plugin-tag plugin-tag-bridge">桥接</span>`);
          }
          if (item.manual) {
            marks.push(`<span class="plugin-tag">手写禁用</span>`);
          }
          const checked = item.enabled ? " checked" : "";
          const disabled = pluginBusy || !item.switchable ? " disabled" : "";
          const title = item.switchable
            ? ""
            : ` title="官方内置的骨架包，没有可禁用的挂载点"`;
          return `<label class="plugin-row${item.enabled ? "" : " is-off"}"${title}><input type="checkbox" data-plugin="${escapeHtml(item.name)}"${checked}${disabled} /><span class="plugin-name">${escapeHtml(item.name)}</span><span class="plugin-state">${item.enabled ? "已启用" : "已停用"}</span>${marks.join("")}</label>`;
        })
        .join("");
      for (const box of pluginList.querySelectorAll<HTMLInputElement>("[data-plugin]")) {
        box.addEventListener("change", () => {
          void togglePlugin(box.dataset.plugin ?? "", box.checked);
        });
      }
    }

    /** 插件面板跟着选中的环境走；换环境才拉一次清单。 */
    function syncPluginPanel(): void {
      const target = manageTarget;
      profilePluginPanel.classList.toggle("hidden", target === null);
      if (target === null) {
        pluginItems = [];
        pluginLoaded = false;
        pluginLoadedFor = null;
        setPluginNote(null);
        setPluginWarning(null);
        renderPluginList();
        return;
      }
      if (pluginLoadedFor !== target) {
        pluginLoadedFor = target;
        pluginItems = [];
        pluginLoaded = false;
        setPluginNote(null);
        setPluginWarning(null);
        renderPluginList();
        void refreshPluginList(target);
        return;
      }
      renderPluginList();
    }

    /** 读一次插件清单（读失败只提示，不打断其它面板动作）。 */
    async function refreshPluginList(name: string): Promise<void> {
      try {
        const list = await invoke<PluginItem[]>("plugin_list", { config: collectConfig(), name });
        if (manageTarget !== name) {
          return; // 期间换了环境，丢弃这批结果
        }
        pluginItems = list;
        pluginLoaded = true;
        renderPluginList();
      } catch (err) {
        if (manageTarget === name) {
          setManageError(`读取插件清单失败：${String(err)}`);
        }
      }
    }

    /**
     * 开关一个插件。
     *
     * 后端在写文件前会自己先备份一次补丁层，成功时把备份路径与刷新后的清单一起带回来；
     * 关掉桥接插件时还会带一句「登录链接只能靠日志兜底」的提醒。
     */
    async function togglePlugin(name: string, enabled: boolean): Promise<void> {
      const target = manageTarget;
      if (!target || !name || pluginBusy || manageBusy || patchBusy) {
        return;
      }
      pluginBusy = true;
      setManageError(null);
      setManageNote(null);
      setPluginNote(null);
      setPluginWarning(null);
      renderManageUI();
      try {
        const outcome = await invoke<ToggleOutcome>("plugin_toggle", {
          config: collectConfig(),
          name: target,
          plugin: name,
          enabled,
        });
        pluginItems = outcome.items;
        pluginLoaded = true;
        setPluginWarning(outcome.warning);
        setPluginNote(
          enabled
            ? `已打开「${name}」，重启 DSH 后生效。`
            : `已关闭「${name}」，重启 DSH 后生效；重新打开不需要重新下载。`,
        );
        logAction(outcome.message);
        // 开关前刚自动备份过，备份清单跟着刷新一次，免得用户还要再点一下才能看到。
        patchLoadedFor = null;
      } catch (err) {
        setManageError(String(err));
        logAction(`切换插件开关失败：${String(err)}`);
        // 失败时那个复选框已经跟着鼠标点过去了，重拉一次清单把它掰回真实状态。
        pluginLoadedFor = null;
      } finally {
        pluginBusy = false;
        renderManageUI();
      }
    }

    /** 开关后的那一句确认（含「重启才生效」）：面板上一眼能看到，不用展开输出块。 */
    function setPluginNote(text: string | null): void {
      if (!text) {
        pluginNote.textContent = "";
        pluginNote.classList.add("hidden");
        return;
      }
      pluginNote.textContent = text;
      pluginNote.classList.remove("hidden");
    }

    /** 桥接关掉后的提醒：一字不改地用后端那句，免两处口径不一样。 */
    function setPluginWarning(text: string | null): void {
      if (!text) {
        pluginWarning.textContent = "";
        pluginWarning.classList.add("hidden");
        return;
      }
      pluginWarning.textContent = text;
      pluginWarning.classList.remove("hidden");
    }

    function setManageNote(text: string | null): void {
      if (!text) {
        profileManageNote.textContent = "";
        profileManageNote.classList.add("hidden");
        return;
      }
      profileManageNote.textContent = text;
      profileManageNote.classList.remove("hidden");
    }

    function setManageError(text: string | null): void {
      if (!text) {
        profileManageError.textContent = "";
        profileManageError.classList.add("hidden");
        return;
      }
      profileManageError.textContent = text;
      profileManageError.classList.remove("hidden");
    }

    /** 面板里那一行行环境：点一下就把名字填进输入框，后续按钮对它操作。 */
    function renderManageList(): void {
      if (profileList.length === 0) {
        manageTarget = null;
        profileManageList.innerHTML = `<p class="hint">没有可管理的环境。</p>`;
        return;
      }
      if (!manageTarget || !profileOf(manageTarget)) {
        manageTarget = profileList[0].name;
      }
      profileManageList.innerHTML = profileList
        .map((item) => {
          const marks: string[] = [];
          if (item.name === prefs.profile) {
            marks.push("当前启动用");
          }
          if (!item.depsInstalled) {
            marks.push("依赖未安装");
          }
          if (!item.webCapable) {
            marks.push("不能起网页");
          }
          const selected = item.name === manageTarget ? " is-selected" : "";
          const tail = marks.length > 0 ? `<span class="profile-manage-tag">${marks.join(" · ")}</span>` : "";
          return `<button class="profile-manage-item${selected}" data-profile="${item.name}"><span class="profile-manage-name-text">${item.name}</span><span class="profile-manage-meta">${item.plugins} 个插件</span>${tail}</button>`;
        })
        .join("");
      for (const item of profileManageList.querySelectorAll<HTMLButtonElement>(".profile-manage-item")) {
        item.addEventListener("click", () => {
          manageTarget = item.dataset.profile ?? null;
          managePendingDelete = null;
          patchPendingRestore = null;
          renderManageUI();
        });
      }
    }

    function renderManageUI(): void {
      renderManageList();
      const target = manageTarget ? profileOf(manageTarget) : null;
      const hasTarget = target !== null;
      profileManageNameLabel.textContent = hasTarget ? `新名字（当前「${target.name}」）` : "环境名";
      profileManageName.placeholder = hasTarget ? `把「${target.name}」改成…` : "例如 lab";
      for (const btn of [btnProfileCopy, btnProfileRename, btnProfileDelete]) {
        btn.disabled = manageBusy || !hasTarget;
      }
      for (const btn of [btnProfileCreate]) {
        btn.disabled = manageBusy;
      }
      // 「重装依赖」不随依赖是否已装而隐藏：新建/复制出来缺依赖时要装，装过之后
      // 依赖坏了、装歪了也要能重来（票据要求的三个手动动作之一），所以一直露着。
      btnProfileDeps.classList.toggle("hidden", !hasTarget);
      btnProfileDeps.disabled = manageBusy || patchBusy;
      btnProfileDeps.textContent = manageBusy ? "安装中…" : "重装依赖";
      // 删除要一次确认：第一次点「删除」只展开确认行，再点一次才真的删。
      const confirming = managePendingDelete !== null;
      profileManageConfirm.classList.toggle("hidden", !confirming);
      if (confirming) {
        profileManageConfirmText.textContent = `确定删除环境「${managePendingDelete}」？目录与里面的插件配置会被一起删掉，这个操作没法撤销。`;
      }
      btnProfileConfirmYes.disabled = manageBusy;
      btnProfileConfirmNo.disabled = manageBusy;
      // 补丁层还原也要一次确认：跟删除用同一个写法（第一次展开确认行，第二次才真改）。
      const restoring = patchPendingRestore !== null;
      patchRestoreConfirm.classList.toggle("hidden", !restoring);
      if (restoring) {
        patchRestoreConfirmText.textContent = `确定把补丁层还原成「${patchPendingRestore}」？这会覆盖当前那份 cordis.patch.yml（现有内容会先另存一份备份，改坏了还能再退回来）。`;
      }
      btnPatchConfirmYes.disabled = patchBusy || manageBusy;
      btnPatchConfirmNo.disabled = patchBusy || manageBusy;
      // 补丁层面板跟着选中的环境走：没选中就没有可备份的东西。
      btnPatchBackup.disabled = !hasTarget || patchBusy || manageBusy || pluginBusy;
      btnPatchBackup.textContent = patchBusy ? "处理中…" : "备份补丁层";
      syncPatchPanel();
      // 插件开关同样跟着选中的环境走（两者会互相影响：开关一次就多一份备份）。
      syncPluginPanel();
    }

    /**
     * 跑一个生命周期动作：清提示 → 置忙 → 调后端 → 转述结果 → 重读列表。
     *
     * `reloadPrefs` 用于重命名：后端可能已经把配置里的环境名改掉了，界面必须重读，
     * 否则下一次保存配置会把旧名字写回去。
     */
    async function runManage(
      action: () => Promise<ProfileOutcome>,
      options: { reloadPrefs?: boolean; output?: boolean } = {},
    ): Promise<void> {
      if (manageBusy) {
        return;
      }
      manageBusy = true;
      setManageError(null);
      setManageNote(null);
      managePendingDelete = null;
      renderManageUI();
      try {
        const outcome = await action();
        manageTarget = outcome.summary ? outcome.name : null;
        if (options.output) {
          // 重装依赖的说明里有命令原文、退出码与输出尾部，整段贴进输出块；
          // 面板上只留一句结论，否则一行 hint 会被几百行输出撞长。
          logAction(outcome.message);
          if (outcome.ok) {
            setManageNote(`环境「${outcome.name}」的依赖已就绪。`);
          } else {
            setManageError(
              `重装依赖没有完成（环境「${outcome.name}」）：命令原文、退出码与输出尾部都在日志浮层里。`,
            );
          }
        } else {
          setManageNote(outcome.message);
        }
        // 新建/复制/重命名都会改变清单，删掉的更得重读：一律重读一次。
        // 重装依赖同样可能让插件数从零变成若干，插件清单也得重新拉。
        pluginLoadedFor = null;
        await loadProfiles();
        if (options.reloadPrefs) {
          await reloadPrefsFromDisk();
        }
      } catch (err) {
        setManageError(String(err));
      } finally {
        manageBusy = false;
        renderManageUI();
      }
    }

    /** 配置里的环境名可能被后端改过（重命名/删除当前环境），重读一遍再回写界面。 */
    async function reloadPrefsFromDisk(): Promise<void> {
      try {
        const saved = await invoke<ShellConfig>("load_shell_config");
        prefs = normalizePrefs(saved);
        fillProfilePicker();
        renderProfilesUI();
        renderCacheAutoToggle();
      } catch (err) {
        setManageError(`重读配置失败：${err}`);
      }
    }

    async function createSelected(): Promise<ProfileOutcome> {
      const name = profileManageName.value.trim();
      const outcome = await invoke<ProfileOutcome>("create_profile", { config: collectConfig(), name });
      profileManageName.value = "";
      return outcome;
    }

    async function copySelected(): Promise<ProfileOutcome> {
      const source = manageTarget ?? "";
      const name = profileManageName.value.trim();
      const outcome = await invoke<ProfileOutcome>("copy_profile", { config: collectConfig(), source, name });
      profileManageName.value = "";
      return outcome;
    }

    async function renameSelected(): Promise<ProfileOutcome> {
      const oldName = manageTarget ?? "";
      const name = profileManageName.value.trim();
      const outcome = await invoke<ProfileOutcome>("rename_profile", {
        config: collectConfig(),
        oldName,
        name,
      });
      profileManageName.value = "";
      return outcome;
    }

    // 名字要由调用方传进来：runManage 一开始就把确认行清掉，读 managePendingDelete 会拿到空串。
    async function deleteSelected(name: string): Promise<ProfileOutcome> {
      return invoke<ProfileOutcome>("delete_profile", { config: collectConfig(), name });
    }

    async function installDepsSelected(): Promise<ProfileOutcome> {
      const name = manageTarget ?? "";
      setManageNote(`正在给「${name}」重装依赖，可能要几分钟…（期间请不要关窗口）`);
      return invoke<ProfileOutcome>("install_profile_deps", { config: collectConfig(), name });
    }

    btnProfileManage.addEventListener("click", () => {
      const open = profileManagePanel.classList.toggle("hidden");
      btnProfileManage.textContent = open ? "管理环境" : "收起管理";
      if (!open) {
        managePendingDelete = null;
        patchPendingRestore = null;
        renderManageUI();
      }
    });

    btnProfileCreate.addEventListener("click", () => {
      void runManage(createSelected);
    });

    btnProfileCopy.addEventListener("click", () => {
      void runManage(copySelected);
    });

    btnProfileRename.addEventListener("click", () => {
      void runManage(renameSelected, { reloadPrefs: true });
    });

    // 删除分两拍：第一次只展开确认行，第二次才真删（票要求「一次确认」）。
    btnProfileDelete.addEventListener("click", () => {
      if (manageBusy || !manageTarget) {
        return;
      }
      managePendingDelete = manageTarget;
      setManageError(null);
      setManageNote(null);
      renderManageUI();
    });

    btnProfileConfirmYes.addEventListener("click", () => {
      const name = managePendingDelete;
      if (!name) {
        return;
      }
      void runManage(() => deleteSelected(name));
    });

    btnProfileConfirmNo.addEventListener("click", () => {
      managePendingDelete = null;
      renderManageUI();
    });

    btnProfileDeps.addEventListener("click", () => {
      void runManage(installDepsSelected, { output: true });
    });

    // 零插件空状态里的「去安装依赖」：跟着走同一个动作，而不是另写一份。
    btnPluginDeps.addEventListener("click", () => {
      void runManage(installDepsSelected, { output: true });
    });

    // 补丁层：备份一颗按钮，还原在备份列表的每一行上（用户选定哪一份就退到哪一份）。
    btnPatchBackup.addEventListener("click", () => {
      void backupPatchLayer();
    });

    // 还原分两拍：第一下点备份行只展开确认行，这里才真的改文件。
    btnPatchConfirmYes.addEventListener("click", () => {
      const backup = patchPendingRestore;
      if (!backup) {
        return;
      }
      void restorePatchLayer(backup);
    });

    btnPatchConfirmNo.addEventListener("click", () => {
      patchPendingRestore = null;
      renderManageUI();
    });

    // 环境名输入框回车 = 按当前选中的动作提交不了，只做一件事：
    // 把默认动作告诉用户（新建），避免回车没反应看起来像坏了。
    profileManageName.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      btnProfileCreate.click();
    });

    // ---- 集成面板：命令行集成（用户级 PATH + dsh 垫片） ------------------------
    // 目录、垫片内容、手动命令与状态说明都由后端算好，界面只负责渲染，
    // 免得两边各算一套口径对不上。
    let cliBusy = false;
    /** 后端说当前宿主能不能自动接入（只有 Windows）。非 Windows 时开关整段藏起来。 */
    let cliSupported = false;
    /** 两张半卡（命令行 + 缓存）共享同一个收起后徽章，所以各自只记录状态，徽章统一渲染。 */
    let cliBadgeText = "命令行读取中";
    let cliBadgeConnected = false;
    let cliBadgeFailed = false;
    /** 命令行那半是否已经拿到结果（两半各跑各的，先到的不应该把另一份还没读的当成「不可用」）。 */
    let cliLoaded = false;
    let cacheBadgeText: string | null = null;
    let cacheBadgeFailed = false;

    /** 收起后只能看到这一个徽章，所以两半的信息合在一起：`命令行已接入 · 缓存 1.8 GB`。 */
    function renderIntegrationsSummary(): void {
      if (cliLoaded && !cliSupported) {
        cliSummary.className = "badge badge-stopped panel-badge";
        cliSummary.textContent = "仅 Windows 可用";
        return;
      }
      if (cliLoaded && cacheBadgeFailed && cliBadgeFailed) {
        cliSummary.className = "badge badge-failed panel-badge";
        cliSummary.textContent = "读取失败";
        return;
      }
      const parts = [cliBadgeText];
      if (cacheBadgeText !== null) {
        parts.push(cacheBadgeText);
      }
      cliSummary.className = `badge ${cliBadgeConnected ? "badge-running" : "badge-stopped"} panel-badge`;
      cliSummary.textContent = parts.join(" · ");
    }

    function renderCliState(state: CliIntegrationState): void {
      cliSupported = state.supported;
      cliLoaded = true;
      // 非 Windows 宿主不改任何 shell 配置：自动接入那半截整段收起来，只留手动命令。
      for (const el of cliWindowsOnly) {
        el.classList.toggle("hidden", !state.supported);
      }
      cliToggle.checked = state.enabled;
      cliToggle.disabled = cliBusy || !state.supported;
      cliBinDir.textContent = state.binDir;
      cliShimPath.textContent = state.shimPath;
      cliManual.textContent = state.manualCommand;
      // 垫片渲染不出来（启动方式还没填完整等）时把原因显示在代码块里，便于手改。
      cliShimText.textContent = state.shimError === null ? state.shimText : state.shimError;
      cliMessage.textContent = state.message;
      const connected = state.supported && state.enabled && state.onPath;
      cliBadgeConnected = connected;
      cliBadgeFailed = false;
      cliBadgeText = !state.supported ? "仅 Windows 可用" : connected ? "命令行已接入" : "命令行未接入";
      renderIntegrationsSummary();
    }

    async function refreshCliState(): Promise<void> {
      try {
        const state = await invoke<CliIntegrationState>("cli_integration_state", { config: collectConfig() });
        renderCliState(state);
      } catch (err) {
        cliMessage.textContent = `读取命令行集成状态失败：${err}`;
        cliLoaded = true;
        cliBadgeFailed = true;
        cliBadgeText = "命令行读取失败";
        renderIntegrationsSummary();
      }
    }

    /** 开关与「启动方式变了之后重写垫片」共用：enabled 就是希望变成的状态。 */
    async function applyCliIntegration(enabled: boolean): Promise<void> {
      cliBusy = true;
      cliToggle.disabled = true;
      cliError.classList.add("hidden");
      try {
        const state = await invoke<CliIntegrationState>("set_cli_integration", {
          config: collectConfig(),
          enabled,
        });
        prefs.cliIntegration = state.enabled;
        renderCliState(state);
      } catch (err) {
        // 写 PATH 失败时后端不会留下半成品，这里把界面也拨回去，避免看着「已接入」其实没接。
        cliError.textContent = String(err);
        cliError.classList.remove("hidden");
        cliToggle.checked = prefs.cliIntegration;
      } finally {
        cliBusy = false;
        cliToggle.disabled = !cliSupported;
      }
    }

    /** 启动方式（或二进制路径、自定义命令）改了就按新配置重写垫片；开关关着时只刷新说明。
        顺便重扫缓存盘面：保留集合里的「当前配置那份」跟着启动配置走，不重扫就会停在旧值。 */
    async function syncCliShim(): Promise<void> {
      void refreshCacheState();
      if (!prefs.cliIntegration) {
        await refreshCliState();
        return;
      }
      try {
        const state = await invoke<CliIntegrationState>("set_cli_integration", {
          config: collectConfig(),
          enabled: true,
        });
        renderCliState(state);
      } catch (err) {
        cliMessage.textContent = `垫片没能跟着重写：${err}`;
      }
    }

    cliToggle.addEventListener("change", () => {
      void applyCliIntegration(cliToggle.checked);
    });

    // 自动清理开关：只改一个持久化的偏好，真正的触发在后端真的拉起 DSH 进程之后。
    // 先回写 prefs 再保存，否则下一次任何字段的自动保存都会把刚打开的值抹回默认。
    cacheAutoToggle.addEventListener("change", () => {
      prefs.cacheCleanup = cacheAutoToggle.checked;
      void persistConfigQuiet();
    });

    btnCliDir.addEventListener("click", () => {
      void (async () => {
        cliError.classList.add("hidden");
        try {
          await invoke<string>("open_shell_dir", { kind: "bin" });
        } catch (err) {
          cliError.textContent = `打开垫片目录失败：${err}`;
          cliError.classList.remove("hidden");
        }
      })();
    });

    // ---- 集成面板：npx 缓存盘面 --------------------------------------------------
    // 归属判定、保留集合、占用与可回收字节、每次删除成败与原因全部在后端算好，
    // 界面只负责渲染（数字已由后端格式化成 `1.8 GB` 这种形式）。
    let cacheBusy = false;
    /** 最近一次拿到的盘面：清理结束后要根据新的可回收份数决定按钮能不能再点。 */
    let cacheRemovable = 0;

    /** 缓存明细：每行一份目录，写清是保留还是可回收。 */
    function renderCacheDirs(state: CacheState): void {
      if (state.dirs.length === 0) {
        cacheDirs.textContent = "（本包还没有 npx 缓存目录）";
        return;
      }
      cacheDirs.textContent = state.dirs
        .map((dir) => {
          const tag = dir.current ? "当前配置" : dir.keep ? "保留" : "可回收";
          return `${tag}  ${dir.label}  ${dir.bytesText}`;
        })
        .join("\n");
    }

    /** 逐条结果：清掉了什么（带字节数）与没清掉什么（带原因），清空重画。 */
    function renderCleanupResults(result: CleanupResult): void {
      cacheResultsBody.textContent = "";
      for (const dir of result.removed) {
        const row = document.createElement("div");
        row.className = "kv-row";
        const key = document.createElement("span");
        key.className = "kv-key";
        key.textContent = "已清掉";
        const value = document.createElement("span");
        value.className = "kv-value";
        value.textContent = `${dir.label}（${dir.bytesText}）`;
        row.append(key, value);
        cacheResultsBody.append(row);
      }
      for (const failure of result.failed) {
        const row = document.createElement("div");
        row.className = "kv-row";
        const key = document.createElement("span");
        key.className = "kv-key";
        key.textContent = "没清掉";
        const value = document.createElement("span");
        value.className = "kv-value";
        value.textContent = `${failure.label}：${failure.reason}`;
        row.append(key, value);
        cacheResultsBody.append(row);
      }
      cacheResults.classList.toggle("hidden", cacheResultsBody.childElementCount === 0);
    }

    function renderCacheState(state: CacheState): void {
      for (const el of CACHE_WINDOWS_ONLY) {
        el.classList.toggle("hidden", !state.supported);
      }
      cacheOwn.textContent = state.supported ? `${state.ownBytesText}（${state.ownCount} 份）` : "—";
      cacheReclaimable.textContent = state.supported ? state.reclaimableBytesText : "—";
      cacheRoot.textContent = state.root === null ? "—" : state.root;
      cacheRemovable = state.removableCount;
      btnCacheClean.disabled = cacheBusy || !state.supported || state.removableCount === 0;
      cacheMessage.textContent = state.message;
      // 没问出 npm 缓存位置时后端会退到平台默认位置，并在这里说清用的是哪个。
      cacheWarning.textContent = state.warning ?? "";
      cacheWarning.classList.toggle("hidden", state.warning === null);
      renderCacheDirs(state);
      if (!state.supported) {
        cacheBadgeText = null;
        cacheBadgeFailed = false;
        renderIntegrationsSummary();
        return;
      }
      cacheBadgeFailed = false;
      cacheBadgeText =
        state.ownCount === 0
          ? "缓存为空"
          : state.removableCount > 0
            ? `缓存 ${state.ownBytesText} · 可回收 ${state.reclaimableBytesText}`
            : `缓存 ${state.ownBytesText}`;
      renderIntegrationsSummary();
    }

    /** 已经播报过的自动清理序号：界面只用它分辨「有没有新的一次」，不重复播报。 */
    let autoCleanupSeq = 0;

    /** 开关状态跟着配置走：读回配置、改开关都调它，避免两处各写一遍。 */
    function renderCacheAutoToggle(): void {
      cacheAutoToggle.checked = prefs.cacheCleanup;
    }

    /** 自动清理的结果在后端，界面没有推送通道：搭在每秒的状态轮询上顺路问一句。
        超过 `autoCleanupSeq` 的才算新结果（启动后删东西是用户看不见的事，必须播报）。 */
    async function pollAutoCleanup(): Promise<void> {
      let report: AutoCleanupReport | null;
      try {
        report = await invoke<AutoCleanupReport | null>("auto_cleanup_report", { since: autoCleanupSeq });
      } catch (err) {
        console.debug("读取自动清理结果失败:", err);
        return;
      }
      if (report === null) return;
      autoCleanupSeq = report.seq;
      if (report.result === null) {
        // 连缓存根都没定位到（npm 坏了等）：没有逐条结果，只留一行说明。
        cacheMessage.textContent = report.message;
        return;
      }
      // 与「立即清理」走同一套渲染：新盘面 + 「清掉哪些」逐条列表。
      renderCacheState(report.result.state);
      renderCleanupResults(report.result);
      cacheMessage.textContent = report.message;
    }

    async function refreshCacheState(): Promise<void> {
      try {
        const state = await invoke<CacheState>("cache_state", { config: collectConfig() });
        renderCacheState(state);
        // 重扫说明盘面变了（切了启动方式等），上一次的逐条结果已经不对应当前盘面，一并清掉。
        cacheResultsBody.textContent = "";
        cacheResults.classList.add("hidden");
      } catch (err) {
        cacheMessage.textContent = `读取缓存盘面失败：${err}`;
        cacheBadgeFailed = true;
        renderIntegrationsSummary();
      }
    }

    btnCacheClean.addEventListener("click", () => {
      void (async () => {
        cacheBusy = true;
        btnCacheClean.disabled = true;
        cacheError.classList.add("hidden");
        try {
          const result = await invoke<CleanupResult>("cleanup_cache", { config: collectConfig() });
          // 后端清完会顺手重扫一遍并把新盘面一起送回来，数字直接跟着刷。
          renderCacheState(result.state);
          renderCleanupResults(result);
          cacheMessage.textContent = result.message;
        } catch (err) {
          cacheError.textContent = `清理缓存失败：${err}`;
          cacheError.classList.remove("hidden");
          // 失败时也重扫一次：部分目录可能已经删掉了，数字不能停在旧值。
          await refreshCacheState();
        } finally {
          cacheBusy = false;
          // 按钮能不能再点看清理后的可回收份数，不能无脑恢复成可点。
          btnCacheClean.disabled = cacheRemovable === 0;
        }
      })();
    });

    /** 桥接插件：「打开备份目录」（安装/卸载的备份都落在这里）。 */    btnBridgeBackups.addEventListener("click", () => {
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

    /** 「关于」面板：打开项目仓库 / DSH 官网（URL 固定在 Rust 侧，界面只传目标键）。 */
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

    /** 「关于」面板：在系统文件管理器里打开壳配置目录 / DSH 日志目录。 */
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

    btnAboutConfig.addEventListener("click", () => openShellDir("config"));
    btnAboutLogs.addEventListener("click", () => openShellDir("logs"));


    // 窗口右上角那三颗按钮。拖拽与双击最大化由 data-tauri-drag-region 交给系统处理，这里只发最小化 /
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
      // 不必再走 Tauri 的窗口事件通道。监听只注册一次（见 main 尾部），
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
      // 下载源与代理：读回来的值可能不是界面上的默认项，回填下拉、地址框与摘要。
      downloadSourcePicker.setValue(prefs.downloadSource);
      proxyModePicker.setValue(prefs.proxyMode);
      proxyAddressInput.value = prefs.proxyAddress;
      renderNetworkUI();
      // 缓存自动清理开关（默认关）：跟着读回来的配置走，重开壳仍然生效。
      renderCacheAutoToggle();
      void refreshProxyState();
    }

    await loadSavedConfig();
    // 运行环境候选与官方版本列表都提前读好，切到对应面板即可直接选。
    await loadDistros();
    await loadRegistry();
    await refreshPortHint();
    await refresh();
    void refreshBridgeState();
    void refreshCliState();
    // 缓存盘面要起 npm 子进程，不阻塞首次挂载。
    void refreshCacheState();
    void loadProfiles();
    refreshNowHook = refresh;
    // 转动状态与计时在模块级（界面元素可能被重建），这里把类贴到当前这颗「重启 DSH」上。
    applyRestartSpin();
  }

  /** 把浅色/深色镜像给 Rust（ui_theme）：开窗前要按它定 WebView 底色，避免首帧闪白。 */
  function syncThemeToShell(next: ThemeId): void {
    invoke("save_ui_theme", { theme: next }).catch((err) => {
      // 失败只影响下次开窗的头一帧底色，本次界面不受影响。
      console.debug("镜像主题到外壳失败:", err);
    });
  }

  // 自绘滚动指示条：主卡（`.block.main-card`）的原生滚动条已在 style.css 里藏起来，滚动时它
  // 右边缘浮出一条细胶囊，停手约 1 秒后淡出。只做视觉，不拦内容事件（轨道 5px 窄、
  // 只在身上收指针），滚轮 / 键盘 / 触控板照旧。
  //
  // 挂的是「当前分区的主卡」而不是视口：界面定高，只有主卡内部滚、下方小卡固定可见，
  // 视口永远不可滚，绑在视口上就等于没有。
  const scrollTrack = document.createElement("div");
  scrollTrack.className = "scroll-track";
  const scrollThumb = document.createElement("div");
  scrollThumb.className = "scroll-thumb";
  scrollTrack.appendChild(scrollThumb);

  /**
   * 滚动容器是当前分区那张主卡（`.block.main-card`）：只有它内部滚，下方并排的小卡
   * 固定可见（2026-10-21 维护者定稿）。没有小卡的分区主卡同样吃掉整个高度。
   */
  function activePanel(): HTMLElement | null {
    return root.querySelector<HTMLElement>(".panel:not(.hidden) .block.main-card");
  }

  let scrollHost: HTMLElement | null = null;
  /**
   * 指示条挂在 `.content-main` 上：主卡自己是滚动容器，绝对定位的子元素会跟着
   * 内容一起滚走，挂在外层才定得住（要贴住主卡右侧，见 style.css 的 .scroll-track）。
   */
  function mountScrollTrack(): void {
    const holder = root.querySelector<HTMLElement>(".content-main");
    if (holder && scrollTrack.parentElement !== holder) holder.appendChild(scrollTrack);
  }

  function syncScrollHost(): void {
    mountScrollTrack();
    scrollHost = activePanel();
    updateScrollThumb();
  }

  const updateScrollThumb = (): void => {
    mountScrollTrack();
    // 以当前可见分区的主卡为准：切分区时记着的旧主卡已经随分区隐藏了。
    const host = activePanel() ?? scrollHost;
    if (!host) {
      scrollThumb.style.height = "0px";
      return;
    }
    scrollHost = host;
    // 轨道贴住主卡的上下边界（内容区里除了主卡还有小卡与日志条，轨道理应只覆盖主卡）。
    const holder = scrollTrack.parentElement;
    if (holder) {
      const hostRect = host.getBoundingClientRect();
      const holderRect = holder.getBoundingClientRect();
      scrollTrack.style.top = `${Math.round(hostRect.top - holderRect.top)}px`;
      scrollTrack.style.bottom = "auto";
      scrollTrack.style.height = `${Math.round(hostRect.height)}px`;
    }
    const viewport = host.clientHeight;
    const total = host.scrollHeight;
    const trackHeight = scrollTrack.clientHeight;
    if (total <= viewport + 1 || trackHeight <= 0) {
      scrollThumb.style.height = "0px";
      return;
    }
    const height = Math.max(28, (viewport / total) * trackHeight);
    const top = (host.scrollTop / (total - viewport)) * (trackHeight - height);
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
  // 面板是滚动容器本身：滚动事件不从 window 冒泡上去，只能挂在面板上，
  // 所以在最外层（只注册一次）用捕获阶段接住任意面板的滚动。
  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains("block")) return;
      if (!target.classList.contains("split")) return;
      if (target !== scrollHost) syncScrollHost();
      updateScrollThumb();
      // 拖动期间不跑这个计时器，否则按住不动 0.9 秒胶囊会在手里淡掉
      if (!dragState) showScrollThumb();
    },
    { capture: true, passive: true },
  );
  window.addEventListener("resize", () => {
    syncScrollHost();
    updateScrollThumb();
  });

  // 按住胶囊上下拖 = 直接改面板的滚动位置。位移按「胶囊能走的距离 ↔ 内容还能滚的距离」等比换算。
  scrollThumb.addEventListener("pointerdown", (event) => {
    const host = scrollHost ?? activePanel();
    if (!host) return;
    const travel = scrollTrack.clientHeight - scrollThumb.offsetHeight;
    const scrollable = host.scrollHeight - host.clientHeight;
    if (travel <= 0 || scrollable <= 1) return;
    event.preventDefault();
    dragState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: host.scrollTop,
      scale: scrollable / travel,
    };
    scrollThumb.setPointerCapture(event.pointerId);
    scrollThumb.classList.add("dragging");
  });
  scrollThumb.addEventListener("pointermove", (event) => {
    const host = scrollHost;
    if (!dragState || !host || event.pointerId !== dragState.pointerId) return;
    host.scrollTop = dragState.startScrollTop + (event.clientY - dragState.startY) * dragState.scale;
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

  syncScrollHost();

  // 窗口尺寸变化与 1 秒状态轮询只注册一次，通过钩子指向当前这套界面。
  window.addEventListener("resize", () => {
    syncMaximizeIconHook();
    syncScrollHost();
  });
  window.setInterval(() => void refreshNowHook(), 1000);
  updateScrollThumbHook = updateScrollThumb;

  // 浅色/深色镜像给 Rust：老配置里没有这份镜像（主题本来只存 localStorage），启动时补齐，
  // 下次开窗（含托盘重开）就能第一时间按主题铺底色，避免首帧闪一下另一种色。
  syncThemeToShell(theme);
  await mount();
}

void main();
