//! DSHarbor 外壳（Tauri 2 应用）。
//!
//! 职责：窗口、IPC 命令、托盘，以及把启动器（`launcher`）暴露给前端。
//! 轻量模式（关窗销毁 WebView、DSH 常驻、托盘常驻）由核心库的
//! `dsharbor_core::lifecycle` 状态机决策，本文件只负责执行副作用。

mod detect;
mod dsh_versions;
mod launcher;
mod npxcache;
mod patch;
mod plugin;
mod plugin_switch;
mod plugin_update;
mod profile;
mod profile_ops;
mod proxy;
mod registry;
mod settings;
mod shellpath;
mod tray;
mod wsl;

use std::sync::Mutex;

use dsharbor_core::launch::{self, LaunchConfig};
use dsharbor_core::lifecycle::{ShellAction, ShellEvent, ShellMachine, ShellState};
use dsharbor_core::links::{navigation_decision, NavigationDecision};
use launcher::{SessionHandle, SessionStatus};
use serde::Serialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// DSH 官网页（「关于」面板的「打开 DSH 官网」按钮）。
const DSH_SITE_URL: &str = "https://www.deepseek.com/harness/";

/// 查询 DSH 版本号时追加的启动器层旗标（排在 app 参数之前，`dsh web --version` 只打印版本后退出）。
const VERSION_ARG: &str = "--version";

/// 版本查询的超时：正常几百毫秒内出结果；npx 冷缓存要下载时给足时间，超时就放弃。
const VERSION_QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// 前端启动时查询的应用信息（「关于」面板展示）。
#[derive(Serialize)]
struct AppInfo {
    name: &'static str,
    version: &'static str,
    /// 核心库版本，与外壳版本分开返回，便于以后独立升级核心逻辑。
    core_version: &'static str,
    /// 项目仓库地址（「关于」面板展示与一键打开）。
    repository: &'static str,
    /// DSH 官网地址。
    site_url: &'static str,
    license: &'static str,
    /// 壳配置目录（`%APPDATA%\DSHarbor`）。
    config_dir: String,
    /// DSH 日志目录（`%USERPROFILE%\.dsh\logs`）。
    logs_dir: String,
}

/// 应用级共享状态：同一时间最多一个 DSH 会话。
#[derive(Default)]
struct AppState {
    session: Mutex<Option<SessionHandle>>,
    /// 轻量模式状态机（窗口与托盘行为统一由它决策，避免状态不同步）。
    lifecycle: Mutex<ShellMachine>,
    /// 最近一次成功启动的配置：托盘「重启 DSH」原样复用。
    last_config: Mutex<Option<LaunchConfig>>,
    /// 后台发起（托盘「重启 DSH」）的启动失败信息，供状态轮询展示。
    spawn_error: Mutex<Option<String>>,
    /// 最近一次成功启动的 DSH 版本号；随状态轮询回给界面（取不到时保持 None）。
    dsh_version: Mutex<Option<String>>,
    /// 壳外检测：目标地址上已有 DSH Web 在听（不是壳的子进程）时记下它；消失即清。
    external_port: Mutex<Option<dsharbor_core::endpoint::Endpoint>>,
    /// 已把保存的启动配置懒加载进 last_config（壳刚打开还没有启动过时，外部检测照常要端口）。
    last_config_loaded: std::sync::atomic::AtomicBool,
    /// 延迟销毁主窗口的世代号：每次重新计时或撤销计时都自增，
    /// 上一轮的计时线程醒来发现不是最新一代就直接放弃（见 arm_light_destroy）。
    light_generation: std::sync::atomic::AtomicU64,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    // 目录取不到（环境变量缺失等）时把原因显示在面板里，而不是让整条命令失败。
    let config_dir = app_data_root(&app)
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|err| format!("（未知：{err}）"));
    let logs_dir = plugin::host_dsh_home()
        .map(|home| {
            std::path::PathBuf::from(home)
                .join("logs")
                .display()
                .to_string()
        })
        .unwrap_or_else(|err| format!("（未知：{err}）"));
    AppInfo {
        name: dsharbor_core::APP_NAME,
        version: env!("CARGO_PKG_VERSION"),
        core_version: dsharbor_core::version(),
        repository: env!("CARGO_PKG_REPOSITORY"),
        site_url: DSH_SITE_URL,
        license: env!("CARGO_PKG_LICENSE"),
        config_dir,
        logs_dir,
    }
}

/// 启动 DSH 的公共路径：校验并持久化配置 → 构造端口覆盖 → 拉起进程 → 记住配置。
/// 「启动」与「重启」共用；`restart_dsh` 在此基础上先停掉现有会话。
fn start_session(
    app: &tauri::AppHandle,
    state: &AppState,
    config: &LaunchConfig,
) -> Result<(), String> {
    // 先过校验并持久化（保留托盘单击等壳偏好）：非法输入在这里报错——不写配置、不启动进程。
    settings::save_launch(app, config)?;
    // 启动恒用 web 环境（`launch::PROFILE_NAME`）。「环境与插件」里选中哪个环境只是
    // 插件与补丁层的管理目标，不参与启动——之前跟着选中项走，选中官方桌面端的
    // `desktop` 会去跑 `dsh desktop`，那个环境起不了 web 服务，整个启动就失败。
    let profile = launch::PROFILE_NAME;
    let launcher_args = profile::port_overlay_args(app, config, profile)?;
    spawn_session(app, state, config, profile, &launcher_args)?;
    remember_config(state, config);
    Ok(())
}

/// 拉起 DSH。已有会话在运行时拒绝，残留的已退出会话会先清掉。
#[tauri::command]
fn start_dsh(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
) -> Result<(), String> {
    start_session(&app, &state, &config)
}

/// 重启 DSH：先停掉现有会话再按传入配置拉起（界面「重启 DSH」按钮）。
/// 与托盘「重启 DSH」共用停止 + 拉起路径；区别：托盘的复用最近一次成功启动的
/// 配置（`ShellAction::RestartDsh`），界面的用当前界面配置。
#[tauri::command]
fn restart_dsh(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
) -> Result<(), String> {
    stop_session(&state);
    start_session(&app, &state, &config)
}

/// 拉起 DSH 并把新会话放进共享状态（启动命令与托盘「重启 DSH」共用）。
fn spawn_session(
    app: &tauri::AppHandle,
    state: &AppState,
    config: &LaunchConfig,
    profile: &str,
    launcher_args: &[String],
) -> Result<(), String> {
    let mut spawned_child = false;
    // 配置只读一次：拉起进程要注入的那份环境变量按这个快照算，
    // 半路有人改配置也不会出现「按 A 启动、按 B 注入」。
    let prefs = settings::load(app).prefs;
    let result = {
        let mut guard = state
            .session
            .lock()
            .map_err(|_| "内部状态异常".to_string())?;
        if let Some(existing) = guard.as_mut() {
            if existing.is_alive() {
                return Err("已有 DSH 会话在运行，请先停止再启动。".into());
            }
        }
        *guard = None;
        // 壳外检测：目标地址已有服务在听就不盲目拉起第二个进程。
        // 确认是 DSH（多半是上次壳异常退出的残留，或用户自己起的）→ 按外部运行中报送；
        // 是别的程序占着端口 → 给出明确的占用提示，代替原先干巴巴的退出代码。
        // 地址跟随 profile 的 host：DSH 可以只绑在网卡 IP 上，探回环会漏判。
        let endpoint = detect::effective_endpoint(config, profile);
        let tls_requested = launch::has_tls_args(&config.extra_args);
        if detect::port_alive(&endpoint) {
            if detect::dsh_fingerprint(&endpoint) == Some(true) {
                if let Ok(mut slot) = state.external_port.lock() {
                    *slot = Some(endpoint);
                }
                Ok(())
            } else if tls_requested {
                // 开了 TLS 的 DSH 用明文连不上，指纹必然取不到；这时若还按
                // 「被别的程序占用」报错，用户会一头雾水（那可能就是他自己的 DSH）。
                Err(format!(
                    "{endpoint} 上有服务在听，但本壳的探测走明文 HTTP，读不出它是不是 DSH——\
                     你启用了 DSH 的 TLS（--tls-cert / --tls-key），壳暂不支持加密连接。\
                     请先结束该进程，或删掉这两个参数后重试；TLS 场景请直接用浏览器访问。"
                ))
            } else {
                Err(format!(
                    "检测到 {endpoint} 已被其他程序占用，没有启动新进程；可更换端口或结束占用它的程序后再试。"
                ))
            }
        } else {
            if let Ok(mut slot) = state.external_port.lock() {
                *slot = None;
            }
            // 代理与下载源注入被拉起的 DSH 进程（与版本查询、插件安装卸载同一份计划）。
            let env = proxy::child_env(&prefs, prefs.download_source);
            match launcher::spawn(config, profile, launcher_args, &env, endpoint) {
                Ok(session) => {
                    *guard = Some(session);
                    spawned_child = true;
                    Ok(())
                }
                Err(err) => Err(err),
            }
        }
    };
    if let Ok(mut slot) = state.spawn_error.lock() {
        *slot = result.as_ref().err().cloned();
    }
    if result.is_ok() && spawned_child {
        // 版本号在启动成功后异步查，不拖慢「启动」按钮；取不到就保持「DSH 版本未知」。
        query_dsh_version_async(app, config, profile);
    }
    result
}

/// 启动成功后异步查询 DSH 版本号（失败只记日志：界面显示「DSH 版本未知」即可）。
fn query_dsh_version_async(app: &tauri::AppHandle, config: &LaunchConfig, profile: &str) {
    let app = app.clone();
    let config = config.clone();
    let profile = profile.to_string();
    std::thread::spawn(move || match query_dsh_version(&config, &profile) {
        Ok(version) => {
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut slot) = state.dsh_version.lock() {
                    *slot = Some(version.clone());
                }
            }
            // 记盘：壳完全退出再打开时用这个值先填界面，不会回到「未知」。
            if let Err(err) = settings::save_dsh_version(&app, &version) {
                eprintln!("[dsharbor] 记录 DSH 版本号失败：{err}");
            }
            eprintln!("[dsharbor] 当前 DSH 版本：{version}");
        }
        Err(err) => eprintln!("[dsharbor] 查询 DSH 版本失败：{err}"),
    });
}

/// 按当前启动方式跑一次 `<启动方式> … --version` 取版本号。
///
/// 复用启动器的同一条通路（同样的启动方式、同样的 PATH 注入），所以四种启动方式都能查；
/// 该命令只打印版本号后退出（实测 `dsh web --version` 不落盘、不起服务）。
fn query_dsh_version(config: &LaunchConfig, profile: &str) -> Result<String, String> {
    let plan =
        dsharbor_core::launch::build_launch_plan(config, profile, &[], &[VERSION_ARG.to_string()])?;
    let mut command = launcher::command_for_plan(&plan);
    launcher::apply_no_window(&mut command);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|err| format!("启动版本查询进程失败：{err}"))?;

    // 逐行读 stdout（复用启动器的编码嗅探）：交给核心库辨认版本号——
    // WSL 模式下 `bash -lc` 可能先吐出 MOTD / 启动脚本文本。
    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        launcher::spawn_line_reader(stdout, move |line| {
            let _ = sender.send(line);
        });
    }
    let deadline = std::time::Instant::now() + VERSION_QUERY_TIMEOUT;
    let mut output = String::new();
    while let Ok(line) =
        receiver.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
    {
        output.push_str(&line);
        output.push('\n');
    }
    // 读完或超时：查询进程不该留活口（npx 可能还在下载）。
    if child
        .try_wait()
        .map(|state| state.is_none())
        .unwrap_or(false)
    {
        let _ = launcher::kill_tree(child.id());
    }
    let _ = child.wait();

    dsharbor_core::launch::parse_version_output(&output)
        .ok_or_else(|| "命令输出里没有版本号".to_string())
}

/// 记住最近一次成功的启动配置。
fn remember_config(state: &AppState, config: &LaunchConfig) {
    if let Ok(mut slot) = state.last_config.lock() {
        *slot = Some(config.clone());
    }
}

/// 壳自己的数据根目录：`%APPDATA%\DSHarbor`（配置、端口覆盖文件、桥接备份）。
///
/// 为什么不用 Tauri 的 app_data_dir()（= `%APPDATA%\<identifier>`）：
/// NSIS 卸载器会删掉以 identifier 命名的目录，而这里存的是用户配置和
/// 桥接插件的回滚备份——卸载应只删安装目录，这些必须保留。
pub(crate) fn app_data_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .config_dir()
        .map(|dir| dir.join("DSHarbor"))
        .map_err(|err| format!("找不到用户配置目录：{err}"))
}

/// 读取整份壳设置（启动配置 + 托盘单击目标；界面加载时调用）。
#[tauri::command]
fn load_shell_config(app: tauri::AppHandle) -> settings::ShellConfig {
    settings::load(&app)
}

/// 保存整份壳设置（非法输入报错、不写盘——配置界面的输入校验兜底）。
///
/// 下载源变了就清掉版本清单缓存：旧清单里的版本号来自另一个 registry，
/// 不作废会让人以为切换没生效。
#[tauri::command]
fn save_shell_config(app: tauri::AppHandle, config: settings::ShellConfig) -> Result<(), String> {
    let previous = settings::load(&app).prefs;
    settings::save(&app, &config)?;
    // 下载源或代理变了就清掉版本清单缓存：旧清单是在另一个源/另一条代理下取的，
    // 不作废会让人以为切换没生效。代理探测结果也一起作废——用户可能刚改过系统设置。
    let proxy_changed = previous.proxy_mode != config.prefs.proxy_mode
        || previous.proxy_address != config.prefs.proxy_address;
    if proxy_changed {
        proxy::invalidate_probe();
    }
    if previous.download_source != config.prefs.download_source || proxy_changed {
        registry::invalidate_all();
    }
    Ok(())
}

/// 「网络」卡代理段的状态：现在到底走不走代理、走的是哪个地址、例外列表有多大。
///
/// async + spawn_blocking：跟随系统时要读环境变量并在 Windows 上跑 `reg.exe`，
/// 同步命令会把这段算在主线程上（有 30 秒缓存，但仍不动主线程）。
#[tauri::command]
async fn proxy_state(app: tauri::AppHandle) -> Result<proxy::ProxyState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let prefs = settings::load(&app).prefs;
        proxy::state(&prefs)
    })
    .await
    .map_err(|err| format!("读取代理状态失败：{err}"))
}

/// 「网络」卡的「测试连接」：拿当前下载源与当前代理设置真的跑一次 npm，
/// 告诉用户到底通不通、是怎么通的、不通是卡在哪。
///
/// async + spawn_blocking：要拉 npm 子进程并等它结束（最多两条），同步命令会堵主线程。
///
/// 下载源由界面随请求一起传，与 `query_dsh_versions` 同一个理由：它才是
/// 「这次用哪个源」的权威，不必先去读盘；代理由已保存的设置决定，
/// 与真实下载走同一条注入路径。
///
/// 不写入缓存（见 `registry::self_check`）：自检的结果是「此刻这条网络」的快照，
/// 界面随请求传来的下载源字符串 → 强类型。认不出就按默认源处理并记日志：
/// 界面传错值不该让整条查询失败。走网络的四条命令（自检/查版本/插件检查/插件更新）共用。
fn parse_source_arg(source: String) -> dsharbor_core::prefs::DownloadSource {
    dsharbor_core::prefs::DownloadSource::parse(&source).unwrap_or_else(|| {
        eprintln!("[dsharbor] 认不出的下载源 {source}，按默认处理");
        dsharbor_core::prefs::DownloadSource::default()
    })
}

/// 与「有多少版本可选」是两回事，互相覆盖只会让两边都不准。
#[tauri::command]
async fn self_check_network(
    app: tauri::AppHandle,
    runtime: launch::Runtime,
    source: String,
) -> Result<dsharbor_core::net::SelfCheckReport, String> {
    let source = parse_source_arg(source);
    let prefs = settings::load(&app).prefs;
    tauri::async_runtime::spawn_blocking(move || registry::self_check(&runtime, &prefs, source))
        .await
        .map_err(|err| format!("后台自检失败：{err}"))
}

/// 「集成」卡命令行集成段的当前状态：开关值、真实 PATH 情况、垫片预览与状态说明。
///
/// async + spawn_blocking：读 PATH 要起 `reg.exe`、探测 dsh 要看磁盘，同步命令会堵主线程。
#[tauri::command]
async fn cli_integration_state(
    app: tauri::AppHandle,
    config: LaunchConfig,
) -> Result<shellpath::CliIntegrationState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let enabled = settings::load(&app).prefs.cli_integration;
        shellpath::state(&app, &config, enabled)
    })
    .await
    .map_err(|err| format!("读取命令行集成状态失败：{err}"))
}

/// 打开 / 关闭命令行集成：写（或删）`dsh.cmd` 垫片，并改当前用户 PATH 里的那一条。
///
/// 开关值随同落盘：不改 `cliIntegration` 的话，壳下次启动看不出「该不该刷垫片」，
/// 与用户刚看到的开关状态会对不上。
#[tauri::command]
async fn set_cli_integration(
    app: tauri::AppHandle,
    config: LaunchConfig,
    enabled: bool,
) -> Result<shellpath::CliIntegrationState, String> {
    let next = {
        let app = app.clone();
        let config = config.clone();
        tauri::async_runtime::spawn_blocking(move || shellpath::apply(&app, &config, enabled))
            .await
            .map_err(|err| format!("切换命令行集成失败：{err}"))??
    };
    let mut settings = settings::load(&app);
    settings.prefs.cli_integration = enabled;
    settings.launch = config;
    // PATH 已经改完了，这里存配置失败不该报「整个操作失败」（那样用户会以为 PATH 没动）。
    if let Err(err) = settings::save(&app, &settings) {
        eprintln!("[dsharbor] 命令行集成：开关状态未能落盘：{err}");
    }
    Ok(next)
}

/// 「DSH 版本」卡：扫一遍本机装了哪些 DSH（npx 缓存里的 + npm 全局装的）。
///
/// async + spawn_blocking：要跑 `npm ls -g`、读 `_npx` 下每个目录，同步命令会堵主线程。
#[tauri::command]
async fn installed_dsh_versions(
    config: LaunchConfig,
) -> Result<Vec<dsh_versions::InstalledDsh>, String> {
    tauri::async_runtime::spawn_blocking(move || dsh_versions::scan(&config))
        .await
        .map_err(|err| format!("读取已装 DSH 版本失败：{err}"))?
}

/// 卸载 npm 全局装的那一份 DSH（npx 缓存里的不删，见 `dsh_versions::uninstall_global`）。
///
/// async + spawn_blocking：`npm uninstall -g` 是一次真实的 npm 操作，会阻塞几十秒。
#[tauri::command]
async fn uninstall_dsh_global(runtime: launch::Runtime) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || dsh_versions::uninstall_global(&runtime))
        .await
        .map_err(|err| format!("卸载全局 DSH 失败：{err}"))?
}

/// 删掉 npx 缓存里的某一份 DSH（`path` 必须是扫描结果里的那个 `_npx` 目录）。
///
/// async + spawn_blocking：递归删目录可能要清几万个文件，同步会堵主线程。
#[tauri::command]
async fn delete_dsh_npx(runtime: launch::Runtime, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || dsh_versions::remove_npx(&runtime, &path))
        .await
        .map_err(|err| format!("删除 npx 缓存中的 DSH 失败：{err}"))?
}

/// 读取启动用 web 环境里 webserver 的托管端口信息（界面展示用）。
///
/// async 命令：同步命令跑在主线程上，而读 target 环境配置在 WSL 模式下要起 wsl.exe
/// （几百毫秒到数秒）——主线程一堵，窗口的拖动/滚动/点击全跟着僵（切换启动方式卡顿的根因）。
#[tauri::command]
async fn profile_port_hint(
    _app: tauri::AppHandle,
    config: LaunchConfig,
) -> Result<profile::PortHint, String> {
    // spawn_blocking 错掉（JoinError）或 port_hint 自己报错都要传给界面。
    let hint = tauri::async_runtime::spawn_blocking(move || {
        // 端口提示要看的是真正会被拉起来的那个环境：启动恒用 web，
        // 「环境与插件」里选中的只影响插件与补丁层管理，不能拿它的端口来提示。
        profile::port_hint(&config, launch::PROFILE_NAME)
    })
    .await
    .map_err(|err| format!("后台读取端口信息失败：{err}"))??;
    Ok(hint)
}

/// 停掉当前会话（无会话时无事发生）。
fn stop_session(state: &AppState) {
    if let Ok(mut guard) = state.session.lock() {
        if let Some(mut session) = guard.take() {
            let _ = session.stop();
        }
    }
}

/// 停止 DSH（杀进程树并等待退出）。
///
/// async 命令：结束进程树要等子进程真正退出（最坏等到超时），同步命令会把这段
/// 等待全压在主线程上，点「停止」整个窗口跟着僵住。
#[tauri::command]
async fn stop_dsh(state: tauri::State<'_, AppState>) -> Result<(), String> {
    // 壳外检测到的 DSH 不是壳的子进程，代为结束既做不到也越权：
    // 明确说明，而不是让「停止」看起来按了没反应。
    let external = state
        .external_port
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    if let Some(endpoint) = external {
        if detect::port_alive(&endpoint) {
            return Err(format!(
                "{endpoint} 上的 DSH 不是本壳启动的，无法代为结束；请自行结束该进程后再试。"
            ));
        }
        if let Ok(mut slot) = state.external_port.lock() {
            *slot = None;
        }
    }
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "内部状态异常".to_string())?;
    if let Some(session) = guard.as_mut() {
        session.stop()?;
    }
    *guard = None;
    Ok(())
}

/// 壳外 DSH 按「运行中」报送时的状态：进程不是壳的子进程，PID 未知；
/// 来龙去脉写进日志区说明，不假装报错、也不假装停止/重启对它有效。
fn external_status(endpoint: &dsharbor_core::endpoint::Endpoint) -> SessionStatus {
    SessionStatus {
        state: launcher::SessionState::Running,
        pid: None,
        port: Some(endpoint.port),
        error: None,
        log_tail: vec![format!(
            "检测到 {endpoint} 已有 DSH Web 在运行（不是本壳启动的，可能是上次壳异常退出留下的）。为避免端口冲突没有重复拉起新进程；要由本壳管理（登录链接 / 停止 / 重启），请先结束该进程再点「启动 DSH」。"
        )],
        login_ready: false,
        login_channel: None,
        login_error: None,
        dsh_version: None,
    }
}

/// 无会话时的壳外检测：外部标记还活着就继续报送；没有标记就用「最近一次启动配置（否则读一次已保存配置）」的目标端口探一下，探到 DSH 就记标记。
fn external_detection_status(app: &tauri::AppHandle, state: &AppState) -> Option<SessionStatus> {
    if let Ok(mut slot) = state.external_port.lock() {
        match slot.clone() {
            Some(endpoint) => {
                if detect::port_alive(&endpoint) {
                    return Some(external_status(&endpoint));
                }
                *slot = None;
            }
            None => {
                let config = {
                    let mut guard = state.last_config.lock().ok()?;
                    if guard.is_none()
                        && !state
                            .last_config_loaded
                            .load(std::sync::atomic::Ordering::Relaxed)
                    {
                        // 只读一次盘：壳刚打开、还没在壳里启动过，用已保存的启动方式探测。
                        *guard = Some(settings::load(app).launch);
                        state
                            .last_config_loaded
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    guard.clone()
                };
                if let Some(config) = config {
                    // 探测地址按真正会启动的 web 环境算：选中项只影响插件/补丁层管理。
                    let endpoint = detect::effective_endpoint(&config, launch::PROFILE_NAME);
                    if detect::port_alive(&endpoint)
                        && detect::dsh_fingerprint(&endpoint) == Some(true)
                    {
                        // 用外层 slot 守卫直接写：Mutex 不可重入，这里再 lock() 一把会永久卡死
                        // dsh_status（真实事故：探到壳外 DSH 就整只壳停在初始停止态）。
                        *slot = Some(endpoint.clone());
                        return Some(external_status(&endpoint));
                    }
                }
            }
        }
    }
    None
}

/// 查询会话状态（前端每秒轮询一次）。
///
/// 会话快照是纯内存操作；无会话时的壳外 DSH 探测（TCP + HTTP 指纹）最坏要等满
/// 超时——环境里有防火墙/安全软件拦一下就是秒级——所以放后台线程执行，
/// 不占 async runtime 的 worker，也不拿着会话锁跨 await（MutexGuard 不是 Send）。
#[tauri::command]
async fn dsh_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SessionStatus, String> {
    let status = match state.session.lock() {
        Ok(mut guard) => guard.as_mut().map(launcher::SessionHandle::status),
        Err(_) => Some(SessionStatus {
            state: launcher::SessionState::Failed,
            pid: None,
            port: None,
            error: Some("内部状态异常".into()),
            log_tail: Vec::new(),
            login_ready: false,
            login_channel: None,
            login_error: None,
            dsh_version: None,
        }),
    };
    let mut status = match status {
        Some(status) => status,
        // 无会话：先做壳外检测。目标端口上已有 DSH 在听（上次壳异常退出的残留，
        // 或用户自己在终端起的）就按「运行中（外部）」报送，不重复拉起；
        // 标记的进程消失了就清掉，回到普通停止态。
        None => {
            let app_for_probe = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                app_for_probe
                    .try_state::<AppState>()
                    .and_then(|state| external_detection_status(&app_for_probe, &state))
            })
            .await
            .map_err(|err| format!("后台探测壳外 DSH 失败：{err}"))?
            .unwrap_or_else(|| {
                // 无外部 DSH 时也要把托盘重启等后台启动失败的原因显示出来。
                let mut status = SessionStatus::stopped();
                if let Ok(slot) = state.spawn_error.lock() {
                    status.error = slot.clone();
                }
                status
            })
        }
    };
    // 版本号由启动后的后台线程回写：不随会话结束清掉，停止后仍显示上次读到的版本。
    if let Ok(slot) = state.dsh_version.lock() {
        status.dsh_version = slot.clone();
    }
    Ok(status)
}

/// 枚举 WSL 发行版并标注里面有没有 node/npm（配置界面的运行环境下拉框）。
///
/// async 命令：wsl.exe 首次要拉起整个 WSL 子系统（秒级），同步命令会让窗口发僵。
#[tauri::command]
async fn wsl_distro_info() -> Result<Vec<wsl::DistroInfo>, String> {
    let distros = tauri::async_runtime::spawn_blocking(wsl::distro_info)
        .await
        .map_err(|err| format!("后台枚举 WSL 发行版失败：{err}"))??;
    Ok(distros)
}

/// 查 npm 上的 DSH 版本清单（带 10 分钟缓存）。
///
/// async 命令：要拉起 npm（WSL 下还要先起 wsl.exe），同步命令会把主线程堵住。
/// 查询失败就返回错误字符串，界面自己降级成「自动最新版本 + 默认环境」继续可用。
///
/// `force` 为 true 时跳过那 10 分钟缓存直接重查（界面上的刷新按钮：
/// 刚发布的版本要立刻出现在下拉里）；缺省 false，走缓存。
///
/// 下载源由界面随请求一起传（`source`）：它才是「这次要用哪个源」的权威，
/// 不必先去读盘——否则一旦保存没落盘，界面显示的选项与实际请求的源就对不上。
/// 认不出的值退回默认并只记日志，不影响使用。
#[tauri::command]
async fn query_dsh_versions(
    app: tauri::AppHandle,
    runtime: launch::Runtime,
    source: String,
    force: Option<bool>,
) -> Result<dsharbor_core::registry::RegistryInfo, String> {
    let source = parse_source_arg(source);
    // 注入给 npm 的环境变量在这里算好：源用界面这次传的（它才是权威），
    // 代理用已保存的设置（见壳设置里的「网络」卡）。
    let prefs = settings::load(&app).prefs;
    let env = proxy::child_env(&prefs, source);
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || registry::query(&runtime, source, &env, force))
        .await
        .map_err(|err| format!("后台查询版本列表失败：{err}"))?
}

/// `npx_cached_versions` 的返回：三个口径的「本机已缓存」。
///
/// - `versions`：缓存里出现过的版本（「已缓存」徽章按它挂）；
/// - `pinServed`：其中钉版本写法（`dsh@<版本>`）启动能直接复用的那部分——npx 按命令
///   写法各存一份缓存，裸包名写法留下的目录服务不了钉版本的启动命令，所以两个清单
///   不重合时，界面要如实告诉用户「选了还会再下载一份」；
/// - `bareCached`：自动最新（裸包名写法）的缓存键在不在——启动前的「下载安装」提示
///   按它判断这次会不会现下载。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedVersions {
    versions: Vec<String>,
    pin_served: Vec<String>,
    bare_cached: bool,
}

/// 列出 npx 缓存里已经缓存过的本包版本号（给界面「已缓存」徽章与「本机已经装过」提示用）。
///
/// 跟随当前运行环境：Windows 宿主扫宿主 npm 缓存，WSL 则进发行版里扫——
/// 同一个版本号在宿主上是「已缓存」、在发行版里可能是要现下的，所以必须分环境算。
///
/// async + spawn_blocking：要问 npm 缓存根、递归扫 `_npx` 下每个目录（WSL 下还要
/// 起 wsl.exe），同步命令会把主线程堵住。
#[tauri::command]
async fn npx_cached_versions(runtime: launch::Runtime) -> Result<CachedVersions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 已缓存徽章、「不会再下载」判定与「下载安装」提示共用一次 `_npx` 扫描（WSL 下免得起两次 wsl.exe）。
        let (versions, pin_served, bare_cached) = npxcache::cached_and_pin_served(&runtime)?;
        Ok(CachedVersions {
            versions,
            pin_served,
            bare_cached,
        })
    })
    .await
    .map_err(|err| format!("后台读取已缓存版本失败：{err}"))?
}

/// 打开（或刷新）DSH 界面窗口——界面与托盘的「应用内打开」。
/// 窗口内的链接策略见 `dsh_navigation_allowed`。
/// 每次点击都用当前登录链接重新导航：token 是一次性铸造的，
/// 这样「关掉窗口再打开」也能拿到有效链接（轻量模式复用同一路径）。
///
/// 必须是 async 命令：Tauri 官方文档明确提示，在**同步命令**里调
/// `WebviewWindowBuilder::build()` 在 Windows 上会死锁（WebView2 已知问题）。
/// 实机症状：第二个窗口白屏、页面导航永远挂起、连窗口都关不掉。
/// 参考 https://github.com/tauri-apps/tauri/issues/13092 与 docs.rs 提示。
#[tauri::command]
async fn open_dsh_window(app: tauri::AppHandle) -> Result<(), String> {
    open_dsh_window_inner(&app)
}

/// 「应用内打开」的内核：被 async 命令（界面按钮）与托盘入口共用。
fn open_dsh_window_inner(app: &tauri::AppHandle) -> Result<(), String> {
    let url = current_login_url(app)?;
    let parsed = tauri::Url::parse(&url).map_err(|err| format!("登录链接无效：{err}"))?;
    if let Some(window) = app.get_webview_window("dsh-view") {
        window
            .navigate(parsed)
            .map_err(|err| format!("刷新 DSH 窗口失败：{err}"))?;
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let (width, height) = dsh_window_size(app);
        // 链接策略要判「哪儿算站内」，用本次登录链接的地址当基准。
        let internal = parsed.clone();
        WebviewWindowBuilder::new(app, "dsh-view", WebviewUrl::External(parsed))
            .title("DSH")
            .inner_size(width, height)
            .min_inner_size(760.0, 480.0)
            .center()
            .initialization_script(DSH_LINK_SCRIPT)
            .on_navigation(move |target| dsh_navigation_allowed(&internal, target))
            .build()
            .map_err(|err| format!("打开 DSH 窗口失败：{err}"))?;
    }
    Ok(())
}

/// DSH 界面窗口尺寸：跟随主显示器可用区域，避免窗口高出屏幕下边界
/// （维护者实测：125% 缩放的 1536x864 屏上，固定 1200x800 会超出底部）。
/// 取主显示器逻辑尺寸的 92% 宽 / 88% 高，上限 1280x860、下限 760x480；
/// 读不到显示器信息时退回 1120x680。
fn dsh_window_size(app: &tauri::AppHandle) -> (f64, f64) {
    const MAX_W: f64 = 1280.0;
    const MAX_H: f64 = 860.0;
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let logical_w = monitor.size().width as f64 / scale;
        let logical_h = monitor.size().height as f64 / scale;
        return (
            (logical_w * 0.92).clamp(760.0, MAX_W),
            (logical_h * 0.88).clamp(480.0, MAX_H),
        );
    }
    (1120.0, 680.0)
}

/// 注入 DSH 界面窗口的脚本：把站外链接的「弹新窗口」改成同窗跳转，
/// 再交给 `dsharbor_core::links::navigation_decision` 判断留在窗口里还是丢给系统浏览器。
///
/// 为什么不走 Tauri 命令：DSH 是远端页面，给它开 IPC 权限等于把壳的接口
/// 暴露出去；这段脚本只碰 DOM，判断全在壳里。
/// 背景：DSH 前端的 http(s) 链接都带 `target="_blank" rel="noopener noreferrer"`，
/// WebView2 把弹窗拦掉，用户点了没任何反应。
const DSH_LINK_SCRIPT: &str = r#"
(function () {
  var nativeOpen = window.open;
  window.open = function (url) {
    if (typeof url === 'string' && /^https?:/i.test(url)) {
      window.location.assign(url);
      return null;
    }
    return nativeOpen.apply(window, arguments);
  };
  document.addEventListener('click', function (event) {
    var node = event.target;
    var link = node && node.closest ? node.closest('a[href]') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (!/^https?:/i.test(href)) return;
    if ((link.getAttribute('target') || '').toLowerCase() === '_blank') {
      event.preventDefault();
      window.location.assign(href);
    }
  }, true);
})();
"#;

/// DSH 界面窗口的导航策略：站内留在窗口里，站外交给系统默认浏览器。
/// 返回 false 会在 WebView2 里取消这次导航，页面原地不动。
/// 判定本身在核心库（`dsharbor_core::links`），这里只执行副作用。
fn dsh_navigation_allowed(internal: &tauri::Url, target: &tauri::Url) -> bool {
    match navigation_decision(internal, target) {
        NavigationDecision::Stay => true,
        NavigationDecision::OpenExternal => {
            hand_off_to_browser(target);
            false
        }
    }
}

/// 站外链接交给系统默认浏览器。失败只记日志：导航已被取消、页面没动，
/// 再弹错误框只会打断用户。
fn hand_off_to_browser(url: &tauri::Url) {
    if let Err(err) = launch_default_browser(url.as_str()) {
        eprintln!("[dsharbor] 外链交给系统浏览器失败：{err}（{url}）");
    }
}

/// 「浏览器打开」：把当前登录链接交给系统默认浏览器（界面按钮与托盘菜单共用）。
/// 这是显式的用户动作；壳的启动流程从不自动弹浏览器（DSH 侧始终带 --no-open）。
#[tauri::command]
async fn open_dsh_in_browser(app: tauri::AppHandle) -> Result<(), String> {
    open_dsh_in_browser_inner(&app)
}

/// 「复制登录链接」：把当前登录链接返回给界面，由界面写进剪贴板。
/// 不在这里直接操作剪贴板（也不用额外插件）：前端已有 copying 的兼底实现。
#[tauri::command]
async fn dsh_login_url(app: tauri::AppHandle) -> Result<String, String> {
    current_login_url(&app)
}

/// 「浏览器打开」内核（供托盘回退逻辑复用）。
fn open_dsh_in_browser_inner(app: &tauri::AppHandle) -> Result<(), String> {
    let url = current_login_url(app)?;
    // 先解析再拼引号：解析后的 URL 只由合法 URL 字符组成，不会破坏 cmd 引用。
    let parsed = tauri::Url::parse(&url).map_err(|err| format!("登录链接无效：{err}"))?;
    launch_default_browser(parsed.as_str())
}

/// 取当前会话的登录链接（未启动 / 未就绪时给出可读原因）。
fn current_login_url(app: &tauri::AppHandle) -> Result<String, String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "内部状态未初始化".to_string())?;
    let url = {
        let mut guard = state
            .session
            .lock()
            .map_err(|_| "内部状态异常".to_string())?;
        match guard.as_mut() {
            Some(session) => session.login_url(),
            None => None,
        }
    };
    url.ok_or_else(|| "登录链接还没有准备好：请先启动 DSH，等状态显示运行中后再打开。".to_string())
}

/// 调系统默认浏览器打开 URL。
/// 用 `cmd /C start "" "<url>"`：URL 已由 tauri::Url 规范化，`&`、`?` 不会被
/// cmd 当命令分隔符；CREATE_NO_WINDOW 避免闪黑框。
fn launch_default_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .raw_arg(format!("/C start \"\" \"{url}\""))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|err| format!("调用系统浏览器失败：{err}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|err| format!("调用系统浏览器失败：{err}"))?;
        Ok(())
    }
}

/// 打开「关于」面板里的外部链接（地址固定在壳里，界面只能传这两个键）。
#[tauri::command]
fn open_external(target: String) -> Result<(), String> {
    let url = match target.as_str() {
        "repo" => env!("CARGO_PKG_REPOSITORY"),
        "site" => DSH_SITE_URL,
        other => return Err(format!("不认识的打开目标：{other}")),
    };
    launch_default_browser(url)
}

/// 开窗即定 webview 底色：WebView2 首次绘制前有一帧自身底色（纯白），index.html
/// 再怎么预着色也管不到它。深色给页面底 #0b0f14、浅色给 #eef2f7，与 index.html
/// 的预着色规则、src/style.css 里 --bg 的取值同值，改色三处同步。
/// 前端切深浅不调这个：外观切换只重染页面，露不出底。
fn webview_base_color(theme: Option<settings::UiTheme>) -> tauri::window::Color {
    if matches!(theme, Some(settings::UiTheme::Dark)) {
        tauri::window::Color(11, 15, 20, 255)
    } else {
        tauri::window::Color(238, 242, 247, 255)
    }
}

/// 在系统文件管理器里打开壳配置目录 / DSH 日志目录 / 桥接插件备份目录。
/// 备份目录入口在「环境/插件」面板的桥接插件浮窗（安装/卸载的备份都落在那里）。
/// `kind = "profile"` 打开某个环境自己的目录（名称由 `profile` 参数传入，缺省为管理目标）。
#[tauri::command]
fn open_shell_dir(
    app: tauri::AppHandle,
    kind: String,
    profile: Option<String>,
) -> Result<String, String> {
    let dir = match kind.as_str() {
        "config" => app_data_root(&app)?,
        "logs" => std::path::PathBuf::from(plugin::host_dsh_home()?).join("logs"),
        "backups" => plugin::backups_root(&app)?,
        // 命令行集成的垫片目录（与版本目录解耦，PATH 里那条永远指这里）。
        "bin" => shellpath::bin_dir(&app)?,
        // 环境目录：前端算不出宿主 / WSL 下的 ~/.dsh/profiles/<名字>，所以由后端拼。
        "profile" => {
            let name = match profile {
                Some(name) => name,
                None => settings::load(&app).prefs.profile,
            };
            std::path::PathBuf::from(plugin::profile_dir(
                &plugin::Target::of(&settings::load(&app).launch),
                &name,
            )?)
        }
        other => return Err(format!("不认识的目录：{other}")),
    };
    // 目录可能还不存在（重装后首次启动、DSH 还没写过日志）：先建出来，否则资源管理器报错。
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("创建目录失败（{}）：{err}", dir.display()))?;
    open_in_file_manager(&dir)?;
    Ok(dir.display().to_string())
}

/// 用系统文件管理器打开一个目录（Windows 走 explorer，开发机走 xdg-open）。
fn open_in_file_manager(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // explorer 即使成功也可能返回非 0 退出码，所以只拉起、不等结果。
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|err| format!("打开目录失败：{err}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|err| format!("打开目录失败：{err}"))?;
        Ok(())
    }
}

/// 要求会话已停止才能做的目录操作。
///
/// 重装依赖要走 pnpm 写 `node_modules`，备份/还原补丁层要改 DSH 自己加载的
/// 配置文件；运行中的 DSH 同时读写这些位置，谁后写谁赢——所以先停下来，别抢。
/// 提示里带上具体动作与环境名：同一个判断服务四种操作，说法必须对得上刚点的按钮。
fn ensure_session_stopped(
    state: &tauri::State<'_, AppState>,
    action: &str,
    profile: &str,
) -> Result<(), String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "内部状态异常".to_string())?;
    if let Some(session) = guard.as_mut() {
        if session.is_alive() {
            return Err(dsharbor_core::patch_layer::session_busy(action, profile));
        }
    }
    Ok(())
}

/// 安装桥接插件（备份 → 官方 plugin add → 校验 bundles 登记）。
/// 桥接恒装在启动用的 web 环境：它是 DSH 注入头的必需项，
/// 而其它环境只是「为了管理插件才被选中」，装不装桥接不影响任何事。
#[tauri::command]
fn bridge_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
) -> Result<plugin::BridgeOutcome, String> {
    ensure_session_stopped(&state, "操作桥接插件", launch::PROFILE_NAME)?;
    plugin::install(&app, &config, launch::PROFILE_NAME)
}

/// 卸载桥接插件（备份 → 官方 plugin remove → 校验 bundles 摘除）。
#[tauri::command]
fn bridge_uninstall(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
) -> Result<plugin::BridgeOutcome, String> {
    ensure_session_stopped(&state, "操作桥接插件", launch::PROFILE_NAME)?;
    plugin::uninstall(&app, &config, launch::PROFILE_NAME)
}

/// 从备份恢复 web 环境的 profile 文件（回滚）。
#[tauri::command]
fn bridge_restore(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
    backup_dir: String,
) -> Result<String, String> {
    ensure_session_stopped(&state, "操作桥接插件", launch::PROFILE_NAME)?;
    plugin::restore(&app, &config, launch::PROFILE_NAME, &backup_dir)
}

/// 查询桥接插件在启动用 web 环境中的状态（顶部那颗徽章看的就它）。
///
/// async 命令：WSL 目标下要经 wsl.exe 读发行版里的文件（秒级），同步命令会让
/// 换启动方式时整个窗口发僵（同 profile_port_hint）。
#[tauri::command]
async fn bridge_state(
    app: tauri::AppHandle,
    config: LaunchConfig,
) -> Result<plugin::BridgeState, String> {
    let bridge = tauri::async_runtime::spawn_blocking(move || {
        plugin::state(&app, &config, launch::PROFILE_NAME)
    })
    .await
    .map_err(|err| format!("后台读取桥接状态失败：{err}"))??;
    Ok(bridge)
}

/// 列出当前目标环境下能起网页界面、可供「启动用」选择的环境。
///
/// 返回值是带 `supported` 标记的包装结构而不是裸数组：非 Windows 宿主上环境卡
/// 要收起并说「仅在 Windows 宿主可用」，而一份空数组表达不了这个区别（分不清
/// 「这里不支持」与「一个环境都没有」）。
///
/// async 命令：WSL 目标下要经 wsl.exe 读发行版里的目录（秒级），同步命令会让
/// 换启动方式时整个窗口发僵（同 profile_port_hint）。
#[tauri::command]
async fn list_profiles(
    config: LaunchConfig,
) -> Result<dsharbor_core::profiles::ProfileListing, String> {
    tauri::async_runtime::spawn_blocking(move || plugin::list_profiles(&config))
        .await
        .map_err(|err| format!("后台枚举环境失败：{err}"))?
}

/// 新建一个空白环境（只写骨架文件，不装依赖）。
///
/// async 命令：WSL 目标下每个动作都要经 wsl.exe 来回（秒级），同步命令会让窗口发僵
/// （同 list_profiles）。
#[tauri::command]
async fn create_profile(
    config: LaunchConfig,
    name: String,
) -> Result<profile_ops::ProfileOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || profile_ops::create(&config, &name))
        .await
        .map_err(|err| format!("后台新建环境失败：{err}"))?
}

/// 复制一份环境（不搬依赖目录与锁文件）。
#[tauri::command]
async fn copy_profile(
    config: LaunchConfig,
    source: String,
    name: String,
) -> Result<profile_ops::ProfileOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || profile_ops::copy(&config, &source, &name))
        .await
        .map_err(|err| format!("后台复制环境失败：{err}"))?
}

/// 重命名环境：目录与清单里的名字一起改；改的是当前启动用的环境时同步改配置。
///
/// 配置更新放在返回之前做：界面拿到成功结果后会重新读配置，顺序反了会读到旧名字。
#[tauri::command]
async fn rename_profile(
    app: tauri::AppHandle,
    config: LaunchConfig,
    old_name: String,
    name: String,
) -> Result<profile_ops::ProfileOutcome, String> {
    let (outcome, config_error) = tauri::async_runtime::spawn_blocking(move || {
        let outcome = profile_ops::rename(&config, &old_name, &name)?;
        // 选中态存在配置文件里（不是内存里），改名成功后必须跟着改，否则下次启动
        // 会去找一个已经不存在的老名字。配置写失败不算动作失败（目录已经搬完了），
        // 但要带回去告诉用户。
        let mut shell = settings::load(&app);
        let mut error = None;
        if shell.prefs.profile == old_name {
            shell.prefs.profile = name.clone();
            if let Err(err) = settings::save(&app, &shell) {
                error = Some(format!("环境已改名，但当前管理的环境没跟着改：{err}"));
            }
        }
        Ok::<_, String>((outcome, error))
    })
    .await
    .map_err(|err| format!("后台重命名环境失败：{err}"))??;
    let mut outcome = outcome;
    if let Some(error) = config_error {
        outcome.ok = false;
        outcome.message = format!("{}\n{error}", outcome.message);
    }
    Ok(outcome)
}

/// 删除环境：当前启动用的环境与官方桌面端目录会被拒绝（守卫在核心库）。
#[tauri::command]
async fn delete_profile(
    app: tauri::AppHandle,
    config: LaunchConfig,
    name: String,
) -> Result<profile_ops::ProfileOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = settings::load(&app).prefs.profile;
        profile_ops::delete(&config, &current, &name)
    })
    .await
    .map_err(|err| format!("后台删除环境失败：{err}"))?
}

/// 给某个环境安装依赖（新建/复制出来的环境都缺这一步）。
///
/// 异步命令且可能跑几分钟：`dsh plugin ... install` 要拉几百 MB，期间界面靠
/// 按钮的忙碌态提示，不能阻塞主线程。
///
/// 先要求会话已停止：pnpm 要独占环境目录，与运行中的 DSH 抢同一份 `node_modules`
/// 会互相覆盖，结果不可预测（票据 #20 留下的已知风险）。
#[tauri::command]
async fn install_profile_deps(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
    name: String,
) -> Result<profile_ops::ProfileOutcome, String> {
    ensure_session_stopped(&state, "重装依赖", &name)?;
    tauri::async_runtime::spawn_blocking(move || profile_ops::install_deps(&app, &config, &name))
        .await
        .map_err(|err| format!("后台安装依赖失败：{err}"))?
}

/// 备份某个环境的补丁层（`cordis.patch.yml`），产生一份带时间戳的副本。
///
/// 异步命令：WSL 目标要经 `wsl.exe` 读发行版里的文件（秒级）。
#[tauri::command]
async fn patch_backup(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
    name: String,
) -> Result<patch::PatchOutcome, String> {
    ensure_session_stopped(&state, "备份补丁层", &name)?;
    tauri::async_runtime::spawn_blocking(move || patch::backup(&app, &config, &name))
        .await
        .map_err(|err| format!("后台备份补丁层失败：{err}"))?
}

/// 把补丁层还原到某一份备份（还原前自动把当前版本另存一份）。
#[tauri::command]
async fn patch_restore(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
    name: String,
    backup: String,
) -> Result<patch::PatchOutcome, String> {
    ensure_session_stopped(&state, "还原补丁层", &name)?;
    tauri::async_runtime::spawn_blocking(move || patch::restore(&app, &config, &name, &backup))
        .await
        .map_err(|err| format!("后台还原补丁层失败：{err}"))?
}

/// 列出某个环境现有的补丁层备份（按时间从旧到新）。
#[tauri::command]
async fn patch_backups(
    app: tauri::AppHandle,
    config: LaunchConfig,
    name: String,
) -> Result<Vec<dsharbor_core::patch_layer::PatchBackup>, String> {
    tauri::async_runtime::spawn_blocking(move || patch::list(&app, &config, &name))
        .await
        .map_err(|err| format!("后台读取补丁层备份失败：{err}"))?
}

/// 列出某个环境当前加载的插件（带启用状态、是否桥接、是否可开关）。
///
/// 只读：要读环境的 `package.json` 与各插件的 bundle 补丁文件，WSL 目标还要经
/// `wsl.exe`，所以放后台线程。
#[tauri::command]
async fn plugin_list(
    app: tauri::AppHandle,
    config: LaunchConfig,
    name: String,
) -> Result<Vec<dsharbor_core::plugin_switch::PluginItem>, String> {
    tauri::async_runtime::spawn_blocking(move || plugin_switch::items(&app, &config, &name))
        .await
        .map_err(|err| format!("后台读取插件清单失败：{err}"))?
}

/// 开关某个环境里的一个插件（作用在补丁层的禁用表达上，不是卸载）。
///
/// 会写 DSH 自己加载的配置文件，所以要求会话已停止：运行中的 DSH 同时读它，
/// 谁后写谁赢。
#[tauri::command]
async fn plugin_toggle(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
    name: String,
    plugin: String,
    enabled: bool,
) -> Result<plugin_switch::ToggleOutcome, String> {
    let action = if enabled {
        "打开插件开关"
    } else {
        "关闭插件开关"
    };
    ensure_session_stopped(&state, action, &name)?;
    tauri::async_runtime::spawn_blocking(move || {
        plugin_switch::toggle(&app, &config, &name, &plugin, enabled)
    })
    .await
    .map_err(|err| format!("后台切换插件开关失败：{err}"))?
}

/// 检查某个环境里第三方插件的更新（当前版本 → registry 目标版本）。
///
/// 只读 + 会话级缓存：每个（环境, 包名）本次使用会话只在第一次进插件卡时查一次，
/// `force=true`（「检查更新」按钮）绕过缓存重查。官方内置骨架包与桥接插件不参与。
/// 下载源随请求传（与 `query_dsh_versions` 同一个理由：界面才是权威）。
#[tauri::command]
async fn plugin_updates_list(
    app: tauri::AppHandle,
    config: LaunchConfig,
    name: String,
    source: String,
    force: Option<bool>,
) -> Result<Vec<dsharbor_core::plugin_update::PluginUpdateItem>, String> {
    let source = parse_source_arg(source);
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        plugin_update::list(&app, &config, &name, source, force)
    })
    .await
    .map_err(|err| format!("后台检查插件更新失败：{err}"))?
}

/// 更新某个环境里的第三方插件：`plugin` 有值更新单个，`None` 更新全部有更新的
/// （逐个执行，单个失败不影响其余，最后汇总）。
///
/// `progress` 是可选进度通道：界面批量更新时传进来，每开一个插件发一条 `start`、
/// 跑完发一条 `done`（见 [`plugin_update::ProgressEvent`]）；单个更新不需要它，
/// 结果只从返回值读。Tauri 的 `Channel<T>` 只实现了「必填」的参数抽取，可选通道
/// 按官方推荐收 `JavaScriptChannelId`，再用 webview 兑换成 `Channel`。
///
/// 要写 node_modules，所以要求会话已停止：运行中的 DSH 同时在用这些文件，
/// 谁后写谁赢（与重装依赖同一理由）。
#[tauri::command]
// 参数是 Tauri 注入项与前端字段一一对应的命令入参（app/webview/state/config/name/
// source/plugin/progress），拆成结构体只是把同一张表抄两遍，没有别的收益。
#[allow(clippy::too_many_arguments)]
async fn plugin_update(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
    name: String,
    source: String,
    plugin: Option<String>,
    progress: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<plugin_update::UpdateOutcome, String> {
    ensure_session_stopped(&state, "更新插件", &name)?;
    let source = parse_source_arg(source);
    let progress: Option<tauri::ipc::Channel<plugin_update::ProgressEvent>> =
        progress.map(|id| id.channel_on(webview));
    tauri::async_runtime::spawn_blocking(move || {
        plugin_update::update(
            &app,
            &config,
            &name,
            source,
            plugin.as_deref(),
            progress.as_ref(),
        )
    })
    .await
    .map_err(|err| format!("后台更新插件失败：{err}"))?
}

/// 记录界面主题（Rust 侧镜像）。
///
/// 主题本体记在 WebView 的 localStorage，Rust 读不到；但窗口装饰（主题 3 换系统
/// 标题栏）必须在建窗那一刻定下来，不能等页面挂载完（否则每次开窗先闪一帧主题 1）。
/// 所以界面每次换主题/启动时把值镜像一份到这里，开窗处（setup、create_main_window）读它。
#[tauri::command]
fn save_ui_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    let theme = settings::parse_ui_theme(&theme).ok_or_else(|| format!("未知主题：{theme}"))?;
    let mut config = settings::load(&app);
    if config.ui_theme == Some(theme) {
        return Ok(());
    }
    config.ui_theme = Some(theme);
    settings::save(&app, &config)
}

/// 「指定程序路径」的即时校验：选完文件或输入框失焦后由界面调用。
/// 复用启动时的格式校验（文案一致）并补文件存在性检查；只做提示，不拦启动。
#[tauri::command]
fn check_binary_path(path: String) -> Result<(), String> {
    dsharbor_core::launch::check_binary_path(&path)
}

/// 轻量模式状态机的副作用执行器（托盘点击、关窗事件、测试钩子都走这里）。
pub(crate) fn dispatch_lifecycle(app: &tauri::AppHandle, event: ShellEvent) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    // 关闭请求自带延迟秒数：状态机据此决定「立刻销毁」还是「先隐藏、等倒计时」。
    let requested_delay = match &event {
        ShellEvent::WindowCloseRequested { light_delay_secs } => Some(*light_delay_secs),
        _ => None,
    };
    let actions = match state.lifecycle.lock() {
        Ok(mut machine) => machine.handle(event),
        Err(_) => return,
    };
    let hide_only = actions
        .iter()
        .any(|action| matches!(action, ShellAction::HideMainWindow));
    for action in actions {
        match action {
            ShellAction::DestroyMainWindow => {
                // 只销毁主窗口（启动界面）：destroy 是立即销毁（不是隐藏、不是最小化）。
                // DSH 界面窗口相互独立——用户关它时才关，这里不连带处理。
                // 这里必须留下错误线索：销毁失败但状态机已记 Light 的话，
                // 会出现「窗口还看得见，但再点关闭没反应」的诡异状态。
                match app.get_webview_window("main") {
                    Some(window) => match window.destroy() {
                        Ok(()) => eprintln!("[dsharbor] 主窗口已销毁（轻量模式）"),
                        Err(err) => eprintln!("[dsharbor] 销毁主窗口失败：{err}"),
                    },
                    None => eprintln!("[dsharbor] 销毁主窗口：窗口不存在"),
                }
            }
            ShellAction::HideMainWindow => {
                // 先隐藏（不是销毁）：窗口、页面、DSH 会话都还在，延迟期内从托盘
                // 回来是「原窗口直接显示」，不重建、不重新加载。
                match app.get_webview_window("main") {
                    Some(window) => match window.hide() {
                        Ok(()) => eprintln!("[dsharbor] 主窗口已隐藏，等待进入轻量模式"),
                        Err(err) => eprintln!("[dsharbor] 隐藏主窗口失败：{err}"),
                    },
                    None => eprintln!("[dsharbor] 隐藏主窗口：窗口不存在"),
                }
            }
            ShellAction::CreateWindow => {
                if let Err(err) = create_main_window(app) {
                    eprintln!("重建主窗口失败：{err}");
                }
            }
            ShellAction::FocusWindow => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            ShellAction::RestartDsh => {
                stop_session(&state);
                let config = state
                    .last_config
                    .lock()
                    .ok()
                    .and_then(|slot| slot.clone())
                    .unwrap_or_else(|| settings::load(app).launch);
                let profile = launch::PROFILE_NAME.to_string();
                let launcher_args =
                    profile::port_overlay_args(app, &config, &profile).unwrap_or_default();
                if let Err(err) = spawn_session(app, &state, &config, &profile, &launcher_args) {
                    eprintln!("重启 DSH 失败：{err}");
                }
            }
            ShellAction::StopDshAndExit => {
                stop_session(&state);
                app.exit(0);
            }
        }
    }
    // 计时与「刚刚做了什么」保持同步：隐藏 → 开始倒计时；显示回来 / 已销毁 → 撤销计时。
    if hide_only {
        arm_light_destroy(app, requested_delay.unwrap_or(0));
    } else {
        cancel_light_destroy(app);
    }
}

/// 延迟进入轻量模式：`delay_secs` 秒后派发 `LightTimeout`（仍走同一条状态机路径）。
///
/// 用时器线程 + 世代号，而不是「取消线程」：arm / cancel 都让世代号自增，
/// 线程醒来发现不是最新一代就直接退出。真正决定不销毁的是状态机——中途从托盘
/// 回来已把状态推回 `Normal`，到点的 `LightTimeout` 也会被忽略；世代号管的是
/// 「再次关窗重新计时」时，别让上一轮的计时提前把窗口收掉。
fn arm_light_destroy(app: &tauri::AppHandle, delay_secs: u64) {
    use std::sync::atomic::Ordering;

    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let generation = state.light_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(delay_secs));
        let current = app
            .try_state::<AppState>()
            .map(|state| state.light_generation.load(Ordering::SeqCst))
            .unwrap_or(0);
        if current != generation {
            return;
        }
        let app_for_main = app.clone();
        if let Err(err) = app
            .run_on_main_thread(move || dispatch_lifecycle(&app_for_main, ShellEvent::LightTimeout))
        {
            eprintln!("[dsharbor] 调度轻量模式计时失败：{err}");
        }
    });
}

/// 撤销还挂着的延迟销毁（窗口显示回来了 / 已销毁 / 正在退出）。
fn cancel_light_destroy(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state
            .light_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 托盘单击：打开壳设置里配置的默认窗口（启动界面 / 程序窗口）。
/// 经 async_runtime 派发——不能在托盘的同步事件回调里直接建窗，Windows 会死锁
/// （tauri#13092 家族问题；async 上下文是已验证的安全路径，与界面按钮同源）。
pub(crate) fn tray_left_click(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match settings::load(&app).tray_click {
            settings::TrayClick::Launcher => show_or_create_main(&app),
            settings::TrayClick::Dsh => open_dsh_or_launcher(&app),
        }
    });
}

/// 托盘「应用内打开」：没有登录链接时回退到启动界面，给用户以反馈。
pub(crate) fn open_dsh_or_launcher(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = open_dsh_window_inner(&app) {
            eprintln!("「应用内打开」失败，回退启动界面：{err}");
            show_or_create_main(&app);
        }
    });
}

/// 托盘「浏览器打开」：没有登录链接时回退到启动界面。
pub(crate) fn open_browser_or_launcher(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = open_dsh_in_browser_inner(&app) {
            eprintln!("「浏览器打开」失败，回退启动界面：{err}");
            show_or_create_main(&app);
        }
    });
}

/// 托盘「停止 DSH」：停掉当前会话（DSH 界面窗口不关，登录链接随之失效）。
/// 与界面「停止」按钮同源；经 async 派发，避免在同步菜单回调里做进程操作。
pub(crate) fn tray_stop_dsh(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(state) = app.try_state::<AppState>() {
            stop_session(&state);
        }
    });
}

/// 显示（必要时重建）启动界面：统一走轻量模式状态机（TrayShow）。
///
/// 为什么不直接 show/focus：状态机里的 `window_open` 是「关窗是否该销毁窗口」
/// 的唯一依据，两套路径各自改窗口会让它分叉（历史上就出现过
/// 「窗口明明在，状态机却以为已关」→ 再点关闭被忽略的怪症）。
/// 调用方都在 async_runtime 任务内；重建经 `run_on_main_thread`（见 create_main_window）。
fn show_or_create_main(app: &tauri::AppHandle) {
    dispatch_lifecycle(app, ShellEvent::TrayShow);
}

/// 建主窗口并把 webview 底色一次性摆到位：第一帧就是正确外观。
/// 建窗参数只在这里一处（tauri.conf.json 已不声明窗口）——setup 首开与
/// create_main_window 托盘重建共用；装饰的「已知陷阱」见下方：
/// 漏写 `decorations(false)` 不会有编译错误，只会让重建出来的窗口套回系统标题栏，
/// 于是「关窗后从托盘重开界面」变成系统标题栏 + 页面里自己画的三只窗口按钮。
/// 窗口尺寸要容得下「左栏卡片 + 右栏（工具条 / 日志窄条 / 主卡里并排的小卡）」：
/// 1240 的内宽让主卡里还能并排两张小卡（如「附加参数│端口」），900 是最小可用宽。
/// 必须在主线程调用（背景见 create_main_window 注释）。
fn build_main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, tauri::Error> {
    let theme = settings::load(app).ui_theme;
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("DSHarbor")
        .inner_size(1240.0, 800.0)
        .min_inner_size(900.0, 620.0)
        .center()
        .decorations(false)
        .background_color(webview_base_color(theme))
        .build()?;
    dress_main_window(&window, theme);
    Ok(window)
}

/// 把已在的窗口的 webview 底色补齐（建窗参数之外只有这一项与外观有关）。
/// setup 的防御分支（窗口已存在时）与 build_main_window 共用这一份。
fn dress_main_window(window: &tauri::WebviewWindow, theme: Option<settings::UiTheme>) {
    let _ = window.set_background_color(Some(webview_base_color(theme)));
}

/// 托盘重建主窗口的入口（首次启动的窗口在 setup 里建，不走这里）。
///
/// 关键：经 `run_on_main_thread` 排队到主线程创建。窗口创建必须发生在主线程；
/// 从 async_runtime 任务里直接 build 会触发 WebView2 的卡死/进程崩溃
/// （tauri#13092 家族），而「托盘事件回调（主线程）里同步建窗」是 #5 期已验证
/// 可用的路径——这里就是回到那条路径。异步上下文由调用方保证（见 show_or_create_main）。
fn create_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        if app_for_main.get_webview_window("main").is_some() {
            return;
        }
        // build_main_window 建完就按主题摆好装饰与底色：
        // 不再丢掉返回值查回窗口，也不重复读一次配置。
        if let Err(err) = build_main_window(&app_for_main) {
            eprintln!("[dsharbor] 创建主窗口失败：{err}");
        }
    })
    .map_err(|err| format!("调度主窗口创建失败：{err}"))?;
    Ok(())
}

/// 测试钩子：把托盘动作与关窗事件经同一条状态机路径执行（自动化验收用；
/// 远端页面拿不到 Tauri IPC，只有壳自己的界面或本地调试通道能调）。
#[tauri::command]
async fn lifecycle_action(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let event = match name.as_str() {
        "show" => ShellEvent::TrayShow,
        "restart" => ShellEvent::TrayRestart,
        "quit" => ShellEvent::TrayQuit,
        // 「停止 DSH」不是状态机事件（不涉及窗口生命周期），直接走托盘菜单同一入口。
        "stop" => {
            crate::tray_stop_dsh(&app);
            return Ok("已派发托盘动作：停止 DSH".to_string());
        }
        // 测试钩子：平台的「窗口关闭请求」无法用脚本合成（合成 WM_CLOSE
        // 在 WebView2 宿主窗口上不可靠），这里直接驱动同一状态机事件，
        // 用来验证主窗口销毁 + 「托盘单击重建」这条链路。
        // 「关闭主窗口」按当前设置走延迟：界面里选「立即」就是旧行为。
        "close-main" => {
            let light_delay_secs = settings::load(&app).light_delay().as_secs();
            ShellEvent::WindowCloseRequested { light_delay_secs }
        }
        other => return Err(format!("未知的轻量模式动作：{other}")),
    };
    dispatch_lifecycle(&app, event);
    Ok(format!("已派发轻量模式动作：{name}"))
}

/// Tauri 入口：注册状态、命令，并在退出时收尾。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 重复启动壳：切回已有实例（不再开第二个进程）。
            // 情形一：窗口还在 → 聚焦；情形二：轻量态窗口已销毁 → 重建窗口。
            // 走与托盘「显示窗口」完全同一条状态机路径，保证两种情形都正确。
            let handle = app.clone();
            let inner = handle.clone();
            if handle
                .run_on_main_thread(move || dispatch_lifecycle(&inner, ShellEvent::TrayShow))
                .is_err()
            {
                eprintln!("单实例：切回主窗口失败（无法调度到主线程）");
            }
        }))
        // 文件对话框：「指定程序路径」的「浏览…」（权限见 capabilities/default.json）。
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            // 主窗口不在 tauri.conf.json 里声明：conf 的装饰/底色是写死的，深浅外观（底色）
            // 在这里按镜像的 ui_theme 现建，开窗第一帧就是正确外观（若由 conf 静态建窗，
            // setup 再改也追不上 webview 的第一次绘制，深色下开窗必闪一帧浅底）。
            // 必须赶在页面加载前，否则每次开窗都先闪一帧默认底色。
            match app.get_webview_window("main") {
                // conf 已不再声明窗口，这个分支只是防御：真有窗口（异常场景）也把外观摆对。
                Some(window) => {
                    let theme = settings::load(app.handle()).ui_theme;
                    dress_main_window(&window, theme);
                }
                None => {
                    // 建出来的窗口由 tauri 自己持有，这里不需要保存句柄。
                    build_main_window(app.handle())
                        .map_err(|err| format!("主窗口创建失败：{err}"))?;
                }
            }
            // 上次记录到的 DSH 版本号：壳重开后界面立刻沿用这个值，
            // 不再等（也不是）本次启动的查询——查询规则不变，见 query_dsh_version_async。
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut slot) = state.dsh_version.lock() {
                    *slot = settings::load_dsh_version(app.handle());
                }
            }
            // 托盘：轻量模式的入口。这里失败会直接终止启动——
            // 没有托盘的轻量态意味着窗口关掉后应用再也回不来。
            tray::setup(app.handle())?;
            // 命令行集成开着时按当前启动配置重写垫片（跟随启动方式变化）。
            // 失败只记日志，不阻塞启动：垫片是便利功能，坏掉不该让壳起不来。
            shellpath::refresh_on_start(app.handle());
            // 无人值守的自测/截图钩子：DSHARBOR_AUTOSTART 里放 LaunchConfig 的 JSON
            // 时，应用启动后自动拉起 DSH。正常使用不会设置这个变量。
            if let Ok(raw) = std::env::var("DSHARBOR_AUTOSTART") {
                match serde_json::from_str::<LaunchConfig>(&raw) {
                    Ok(config) => {
                        let state = app.state::<AppState>();
                        let profile = launch::PROFILE_NAME.to_string();
                        let launcher_args =
                            profile::port_overlay_args(app.handle(), &config, &profile)
                                .unwrap_or_default();
                        let endpoint = detect::effective_endpoint(&config, &profile);
                        let prefs = settings::load(app.handle()).prefs;
                        let env = proxy::child_env(&prefs, prefs.download_source);
                        match launcher::spawn(&config, &profile, &launcher_args, &env, endpoint) {
                            Ok(session) => {
                                if let Ok(mut guard) = state.session.lock() {
                                    *guard = Some(session);
                                }
                            }
                            Err(err) => eprintln!("DSHARBOR_AUTOSTART 启动失败：{err}"),
                        }
                    }
                    Err(err) => eprintln!("DSHARBOR_AUTOSTART 不是合法配置 JSON：{err}"),
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            start_dsh,
            restart_dsh,
            stop_dsh,
            dsh_status,
            wsl_distro_info,
            query_dsh_versions,
            npx_cached_versions,
            open_dsh_window,
            open_dsh_in_browser,
            dsh_login_url,
            bridge_install,
            bridge_uninstall,
            bridge_restore,
            bridge_state,
            lifecycle_action,
            load_shell_config,
            save_shell_config,
            proxy_state,
            self_check_network,
            profile_port_hint,
            list_profiles,
            create_profile,
            copy_profile,
            rename_profile,
            delete_profile,
            install_profile_deps,
            patch_backup,
            patch_restore,
            patch_backups,
            plugin_list,
            plugin_toggle,
            plugin_updates_list,
            plugin_update,
            open_external,
            save_ui_theme,
            check_binary_path,
            open_shell_dir,
            cli_integration_state,
            set_cli_integration,
            installed_dsh_versions,
            uninstall_dsh_global,
            delete_dsh_npx
        ])
        .build(tauri::generate_context!())
        .expect("构建 DSHarbor 外壳失败")
        .run(|app_handle, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                if label == "main" {
                    // 轻量模式：关主窗口 ≠ 退出应用。拦下默认关闭，交给状态机——
                    // 设置「立即」就销毁窗口，设了延迟则先隐藏、到点再销毁。
                    api.prevent_close();
                    let light_delay_secs = settings::load(app_handle).light_delay().as_secs();
                    dispatch_lifecycle(
                        app_handle,
                        ShellEvent::WindowCloseRequested { light_delay_secs },
                    );
                }
            }
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                // 所有窗口关闭时事件循环会请求退出（code 为 None）：
                // 只要不是「完全退出」，就留在托盘里继续跑。
                let exiting = app_handle
                    .try_state::<AppState>()
                    .and_then(|state| {
                        state
                            .lifecycle
                            .lock()
                            .ok()
                            .map(|machine| machine.state() == ShellState::Exiting)
                    })
                    .unwrap_or(false);
                if code.is_none() && !exiting {
                    api.prevent_exit();
                } else if let Some(state) = app_handle.try_state::<AppState>() {
                    // 真正的退出：撤销还挂着的延迟销毁，兜底确保 DSH 已停
                    //（正常路径在 StopDshAndExit 里已停过）。
                    cancel_light_destroy(app_handle);
                    stop_session(&state);
                }
            }
            _ => {}
        });
}
