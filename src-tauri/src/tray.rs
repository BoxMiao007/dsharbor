//! 系统托盘：菜单「浏览器打开 / 应用内打开 / 打开启动界面 / 重启 DSH / 停止 DSH / 完全退出」；
//! 单击托盘图标打开壳设置里配置的默认窗口（启动界面或程序窗口）。
//!
//! 托盘只把点击翻译成动作：状态机事件（`ShellEvent`）走 `dispatch_lifecycle`；
//! 涉及窗口创建/浏览器的动作走 `lib.rs` 的 `*_or_launcher` 入口——它们与界面
//! 按钮共用同一实现（open_dsh_window / open_dsh_in_browser 内核），行为一致。
//! 这些入口内部经 async_runtime 派发：Windows 上在同步事件回调里直接建窗会死锁
//! （tauri#13092 家族问题），必须借异步上下文（与 async 命令同路径）。

use dsharbor_core::lifecycle::ShellEvent;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::dispatch_lifecycle;

const MENU_BROWSER: &str = "tray-browser";
const MENU_DSH: &str = "tray-dsh";
const MENU_LAUNCHER: &str = "tray-launcher";
const MENU_RESTART: &str = "tray-restart";
const MENU_STOP: &str = "tray-stop";
const MENU_QUIT: &str = "tray-quit";

/// 创建托盘图标与菜单。
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let menu = tauri::menu::MenuBuilder::new(app)
        .item(&tauri::menu::MenuItemBuilder::with_id(MENU_BROWSER, "浏览器打开").build(app)?)
        .item(&tauri::menu::MenuItemBuilder::with_id(MENU_DSH, "应用内打开").build(app)?)
        .item(&tauri::menu::MenuItemBuilder::with_id(MENU_LAUNCHER, "打开启动界面").build(app)?)
        .separator()
        .item(&tauri::menu::MenuItemBuilder::with_id(MENU_RESTART, "重启 DSH").build(app)?)
        .item(&tauri::menu::MenuItemBuilder::with_id(MENU_STOP, "停止 DSH").build(app)?)
        .separator()
        .item(&tauri::menu::MenuItemBuilder::with_id(MENU_QUIT, "完全退出").build(app)?)
        .build()?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("DSHarbor — DSH Web 的轻量桌面壳")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_BROWSER => crate::open_browser_or_launcher(app),
            MENU_DSH => crate::open_dsh_or_launcher(app),
            MENU_LAUNCHER => dispatch_lifecycle(app, ShellEvent::TrayShow),
            MENU_RESTART => dispatch_lifecycle(app, ShellEvent::TrayRestart),
            MENU_STOP => crate::tray_stop_dsh(app),
            MENU_QUIT => dispatch_lifecycle(app, ShellEvent::TrayQuit),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 单击（左键按下并松开）= 打开配置的默认窗口。双击会连续触发两次
            // Click，动作本身幂等（已打开再点=聚焦），不需要单独分支。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::tray_left_click(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
