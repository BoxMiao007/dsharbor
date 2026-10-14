//! DSHarbor 外壳（Tauri 2 应用）。
//!
//! 职责：窗口、IPC 命令、托盘，以及把启动器（`launcher`）暴露给前端。
//! 轻量模式（关窗销毁 WebView、DSH 常驻、托盘常驻）由核心库的
//! `dsharbor_core::lifecycle` 状态机决策，本文件只负责执行副作用。

mod launcher;
mod plugin;
mod profile;
mod settings;
mod tray;
mod wsl;

use std::sync::Mutex;

use dsharbor_core::launch::LaunchConfig;
use dsharbor_core::lifecycle::{ShellAction, ShellEvent, ShellMachine, ShellState};
use launcher::{SessionHandle, SessionStatus};
use serde::Serialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 前端启动时查询的应用信息（欢迎页展示 + 链路自检）。
#[derive(Serialize)]
struct AppInfo {
    name: &'static str,
    version: &'static str,
    /// 核心库版本，与外壳版本分开返回，便于以后独立升级核心逻辑。
    core_version: &'static str,
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
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: dsharbor_core::APP_NAME,
        version: env!("CARGO_PKG_VERSION"),
        core_version: dsharbor_core::version(),
    }
}

/// 拉起 DSH。已有会话在运行时拒绝，残留的已退出会话会先清掉。
#[tauri::command]
fn start_dsh(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
) -> Result<(), String> {
    // 先过校验并持久化（保留托盘单击等壳偏好）：非法输入在这里报错——不写配置、不启动进程。
    settings::save_launch(&app, &config)?;
    let launcher_args = profile::port_overlay_args(&app, &config)?;
    spawn_session(&state, &config, &launcher_args)?;
    remember_config(&state, &config);
    Ok(())
}

/// 拉起 DSH 并把新会话放进共享状态（启动命令与托盘「重启 DSH」共用）。
fn spawn_session(
    state: &AppState,
    config: &LaunchConfig,
    launcher_args: &[String],
) -> Result<(), String> {
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
        match launcher::spawn(config, launcher_args) {
            Ok(session) => {
                *guard = Some(session);
                Ok(())
            }
            Err(err) => Err(err),
        }
    };
    if let Ok(mut slot) = state.spawn_error.lock() {
        *slot = result.as_ref().err().cloned();
    }
    result
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
#[tauri::command]
fn save_shell_config(app: tauri::AppHandle, config: settings::ShellConfig) -> Result<(), String> {
    settings::save(&app, &config)
}

/// 读取当前目标环境 profile 里 webserver 的托管端口信息（界面展示用）。
#[tauri::command]
fn profile_port_hint(config: LaunchConfig) -> Result<profile::PortHint, String> {
    profile::port_hint(&config)
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
#[tauri::command]
fn stop_dsh(state: tauri::State<'_, AppState>) -> Result<(), String> {
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

/// 查询会话状态（前端每秒轮询一次）。
#[tauri::command]
fn dsh_status(state: tauri::State<'_, AppState>) -> SessionStatus {
    match state.session.lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(session) => session.status(),
            None => {
                // 无会话时也要把托盘重启等后台启动失败的原因显示出来。
                let mut status = SessionStatus::stopped();
                if let Ok(slot) = state.spawn_error.lock() {
                    status.error = slot.clone();
                }
                status
            }
        },
        Err(_) => SessionStatus {
            state: launcher::SessionState::Failed,
            pid: None,
            port: None,
            error: Some("内部状态异常".into()),
            log_tail: Vec::new(),
            login_ready: false,
            login_channel: None,
            login_error: None,
        },
    }
}

/// 枚举 WSL 发行版（配置界面的下拉框）。
#[tauri::command]
fn list_wsl_distros() -> Result<Vec<String>, String> {
    wsl::list_distros()
}

/// 打开（或刷新）DSH 界面窗口——界面与托盘的「当前程序打开」。
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

/// 「当前程序打开」的内核：被 async 命令（界面按钮）与托盘入口共用。
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
        WebviewWindowBuilder::new(app, "dsh-view", WebviewUrl::External(parsed))
            .title("DSH")
            .inner_size(width, height)
            .min_inner_size(760.0, 480.0)
            .center()
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

/// 「浏览器打开」：把当前登录链接交给系统默认浏览器（界面按钮与托盘菜单共用）。
/// 这是显式的用户动作；壳的启动流程从不自动弹浏览器（DSH 侧始终带 --no-open）。
#[tauri::command]
async fn open_dsh_in_browser(app: tauri::AppHandle) -> Result<(), String> {
    open_dsh_in_browser_inner(&app)
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

/// 安装/卸载桥接插件时要求会话已停止（pnpm 需要独占 profile 目录）。
fn ensure_session_stopped(state: &tauri::State<'_, AppState>) -> Result<(), String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "内部状态异常".to_string())?;
    if let Some(session) = guard.as_mut() {
        if session.is_alive() {
            return Err("请先停止 DSH 再操作桥接插件：pnpm 需要独占 profile 目录。".to_string());
        }
    }
    Ok(())
}

/// 安装桥接插件（备份 → 官方 plugin add → 校验 bundles 登记）。
#[tauri::command]
fn bridge_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
) -> Result<plugin::BridgeOutcome, String> {
    ensure_session_stopped(&state)?;
    plugin::install(&app, &config)
}

/// 卸载桥接插件（备份 → 官方 plugin remove → 校验 bundles 摘除）。
#[tauri::command]
fn bridge_uninstall(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
) -> Result<plugin::BridgeOutcome, String> {
    ensure_session_stopped(&state)?;
    plugin::uninstall(&app, &config)
}

/// 从备份恢复 profile 文件（回滚）。
#[tauri::command]
fn bridge_restore(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: LaunchConfig,
    backup_dir: String,
) -> Result<String, String> {
    ensure_session_stopped(&state)?;
    plugin::restore(&app, &config, &backup_dir)
}

/// 查询桥接插件在当前目标环境中的状态。
#[tauri::command]
fn bridge_state(
    app: tauri::AppHandle,
    config: LaunchConfig,
) -> Result<plugin::BridgeState, String> {
    plugin::state(&app, &config)
}

/// 轻量模式状态机的副作用执行器（托盘点击、关窗事件、测试钩子都走这里）。
pub(crate) fn dispatch_lifecycle(app: &tauri::AppHandle, event: ShellEvent) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let actions = match state.lifecycle.lock() {
        Ok(mut machine) => machine.handle(event),
        Err(_) => return,
    };
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
                let launcher_args = profile::port_overlay_args(app, &config).unwrap_or_default();
                if let Err(err) = spawn_session(&state, &config, &launcher_args) {
                    eprintln!("重启 DSH 失败：{err}");
                }
            }
            ShellAction::StopDshAndExit => {
                stop_session(&state);
                app.exit(0);
            }
        }
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

/// 托盘「当前程序打开」：没有登录链接时回退到启动界面，给用户以反馈。
pub(crate) fn open_dsh_or_launcher(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = open_dsh_window_inner(&app) {
            eprintln!("「当前程序打开」失败，回退启动界面：{err}");
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

/// 重建主窗口：参数与 tauri.conf.json 的 main 窗口保持一致。
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
        let result =
            WebviewWindowBuilder::new(&app_for_main, "main", WebviewUrl::App("index.html".into()))
                .title("DSHarbor")
                .inner_size(1000.0, 700.0)
                .min_inner_size(720.0, 520.0)
                .center()
                .build();
        if let Err(err) = result {
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
        "close-main" => ShellEvent::WindowCloseRequested,
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
        .manage(AppState::default())
        .setup(|app| {
            // 托盘：轻量模式的入口。这里失败会直接终止启动——
            // 没有托盘的轻量态意味着窗口关掉后应用再也回不来。
            tray::setup(app.handle())?;
            // 无人值守的自测/截图钩子：DSHARBOR_AUTOSTART 里放 LaunchConfig 的 JSON
            // 时，应用启动后自动拉起 DSH。正常使用不会设置这个变量。
            if let Ok(raw) = std::env::var("DSHARBOR_AUTOSTART") {
                match serde_json::from_str::<LaunchConfig>(&raw) {
                    Ok(config) => {
                        let state = app.state::<AppState>();
                        let launcher_args =
                            profile::port_overlay_args(app.handle(), &config).unwrap_or_default();
                        match launcher::spawn(&config, &launcher_args) {
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
            stop_dsh,
            dsh_status,
            list_wsl_distros,
            open_dsh_window,
            open_dsh_in_browser,
            bridge_install,
            bridge_uninstall,
            bridge_restore,
            bridge_state,
            lifecycle_action,
            load_shell_config,
            save_shell_config,
            profile_port_hint
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
                    // 轻量模式：关主窗口 ≠ 退出应用。拦下默认关闭，
                    // 交给状态机去「销毁窗口、保留 DSH 与托盘」。
                    api.prevent_close();
                    dispatch_lifecycle(app_handle, ShellEvent::WindowCloseRequested);
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
                    // 真正的退出：兜底确保 DSH 已停（正常路径在 StopDshAndExit 里已停过）。
                    stop_session(&state);
                }
            }
            _ => {}
        });
}
