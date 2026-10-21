import type { ThemeId } from "./theme";

/* 前后端数据形状：invoke 返回结构、配置/状态接口，与 SessionStatus 的语义判断 isStarting —— 自 main.ts 原样搬出（2026-10 模块化拆分），声明加 export，其余未改。 */

/** 与 Rust 侧 `app_info` 命令的返回结构一一对应。 */
export interface AppInfo {
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

/** 运行环境：Windows 宿主，或某个 WSL 发行版里。与 Rust 侧 `launch::Runtime` 对应。 */
export type LaunchRuntime = { kind: "default" } | { kind: "wsl"; distro: string };

/** 与 Rust 侧 `launch::LaunchMode`（serde tag = kind）一一对应。
    npx 的 `version` 为 null = 官方命令（不写版本号，跟 npm 的 latest 标签走）。 */
export type LaunchMode =
  | { kind: "npx"; version: string | null }
  | { kind: "system" }
  | { kind: "binary"; path: string }
  | { kind: "custom"; command: string };

export interface LaunchConfig {
  mode: LaunchMode;
  /** 在哪个环境里执行（只有官方 npx / 自定义命令两块用得到，其余两种固定 Windows）。 */
  runtime: LaunchRuntime;
  extraArgs: string[];
  /** 端口覆盖：null = 跟随 DSH 自身配置；数字 = 壳注入 launcher 层覆盖。 */
  port: number | null;
}

/** 与 Rust 侧 `registry::RegistryInfo` 对应：dist-tag 与全部已发布版本（从新到旧）。 */
export interface RegistryInfo {
  distTags: { latest: string | null };
  /** npm 上发布过的全部版本，从新到旧；界面按「先 6 个 + 更多…」分页展示。 */
  versions: string[];
}

/** 与 Rust 侧 `wsl::DistroInfo` 对应：发行版名 + 里面有没有 node/npm。 */
export interface DistroInfo {
  distro: string;
  hasNode: boolean;
}

/** 与 Rust 侧 `settings::TrayClick` 对应：托盘单击打开哪个窗口。 */
export type TrayClick = "launcher" | "dsh";

/** 左侧导航的分区：点哪个，右侧面板就显哪一块（选择记在 localStorage）。 */
export type PanelKey = "launch" | "env" | "integ" | "traynet" | "log" | "about";

/** 与 Rust 侧 `dsharbor_core::prefs::DownloadSource` 对应：从哪儿取 DSH 包。 */
export type DownloadSource = "inherit" | "mirror" | "official";

/** 与 Rust 侧 `dsharbor_core::prefs::ProxyMode` 对应：网络代理怎么走。 */
export type ProxyMode = "system" | "manual" | "off";

/** 与 Rust 侧 `dsharbor_core::prefs::ShellPrefs` 对应：三张新卡承载的六个字段。
    这一版只做承载（读写、往返、默认值），各字段的实际作用由后续版本逐个接管。 */
export interface ShellPrefs {
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


/** 与 Rust 侧 `settings::ShellConfig` 对应（整份壳设置）。
    六个新字段在 Rust 侧是 `#[serde(flatten)]` 平铺的，JSON 里与 launch / trayClick 平级，
    所以这里也平铺；写成可选是因为旧配置里没有它们。 */
export interface ShellConfig extends Partial<ShellPrefs> {
  launch: LaunchConfig;
  trayClick: TrayClick;
  /** 关闭窗口后延迟多少秒释放界面内存；0 = 立即。 */
  lightDelaySecs: number;
  /** 界面主题的 Rust 侧镜像（见 save_ui_theme：开窗前定窗口装饰用）。 */
  uiTheme: ThemeId;
}

/** 与 Rust 侧 `profile::PortHint` 对应。 */
export interface PortHint {
  host: string | null;
  port: number | null;
  source: "managed" | "default";
}

export interface SessionStatus {
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
export interface BridgeState {
  installed: boolean;
  target: string;
  profileDir: string;
  detail: string;
  latestBackup: string | null;
}

/** 一份环境（DSH profile）的摘要：与 Rust 侧 `dsharbor_core::profiles::ProfileSummary` 对应。 */
export interface ProfileSummary {
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
export interface ProfileListing {
  supported: boolean;
  profiles: ProfileSummary[];
}

/** 与 Rust 侧 `proxy::ProxyState` 对应：生效地址、例外列表与那一行说明都由后端算好，
    界面只负责显示（地址归一化与提示文案只在核心库有一份，界面不另写一套）。 */
export interface ProxyState {
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
export interface SelfCheckReport {
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
export interface BridgeOutcome {
  ok: boolean;
  message: string;
  backupDir: string;
}

/** 与 Rust 侧 `shellpath::CliIntegrationState` 对应：目录、垫片预览、手动命令与状态说明
    都在后端算好，界面只负责显示。 */
export interface CliIntegrationState {
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
export interface CacheDir {
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
export interface CacheState {
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
export interface CleanedDir {
  label: string;
  bytes: number;
  bytesText: string;
}

/** 与 Rust 侧 `npxcache::CleanupFailure` 对应：没清掉的一个目录与原因。 */
export interface CleanupFailure {
  label: string;
  path: string;
  reason: string;
}

/** 与 Rust 侧 `npxcache::CleanupResult` 对应：清理结果与清理后的新盘面。 */
export interface CleanupResult {
  removed: CleanedDir[];
  failed: CleanupFailure[];
  freedBytes: number;
  message: string;
  state: CacheState;
}

/** 与 Rust 侧 `AutoCleanupReport` 对应：最近一次「启动后自动清理」的结果。 */
export interface AutoCleanupReport {
  /** 第几次自动清理；界面只播报比上次新的那一次。 */
  seq: number;
  /** 说明文字（成功时以「启动后自动清理：」开头）。 */
  message: string;
  /** 成功时的逐条结果；缓存根都定位不到时没有可展示的条目。 */
  result: CleanupResult | null;
}

/**
 * 「启动中」= 本壳拉起的进程已起来、登录链接还没就绪（npx 首次下载与 DSH 冷启动都停在这一步）。
 * 壳外检测到的 DSH（pid 未知）不在等待登录链接的路上，直接按「运行中」显示，否则会永远转圈。
 */
export function isStarting(status: SessionStatus): boolean {
  return status.state === "running" && status.pid !== null && !status.loginReady && !status.loginError;
}
