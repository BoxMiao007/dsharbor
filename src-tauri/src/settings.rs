//! 壳级设置与持久化（在 app_data_root/config.json）。
//!
//! 为什么单独成模块：不止「启动参数」要持久化——托盘单击打开哪个窗口
//! 这类壳行为偏好同样要活过重开与卸载，统一存一个 JSON。
//! 兼容旧格式：此前该文件顶层直接就是 `LaunchConfig`，加载时自动迁移。

use dsharbor_core::launch::{LaunchConfig, LaunchMode};
use serde::{Deserialize, Serialize};

/// 托盘图标单击（左键）时默认打开的目标。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TrayClick {
    /// 启动界面（主窗口）——默认。
    #[default]
    Launcher,
    /// 当前程序打开的窗口（壳内的 DSH 界面）。
    Dsh,
}

/// 壳的全部持久化设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellConfig {
    pub launch: LaunchConfig,
    #[serde(default)]
    pub tray_click: TrayClick,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            launch: LaunchConfig {
                mode: LaunchMode::Npx,
                extra_args: Vec::new(),
                port: None,
            },
            tray_click: TrayClick::Launcher,
        }
    }
}

fn path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::app_data_root(app)?.join("config.json"))
}

/// 读取设置；文件缺失/损坏时返回默认值（兼容旧的顶层 LaunchConfig 格式）。
pub fn load(app: &tauri::AppHandle) -> ShellConfig {
    let Ok(path) = path(app) else {
        return ShellConfig::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return ShellConfig::default();
    };
    if let Ok(config) = serde_json::from_str::<ShellConfig>(&text) {
        return config;
    }
    match serde_json::from_str::<LaunchConfig>(&text) {
        Ok(launch) => ShellConfig {
            launch,
            tray_click: TrayClick::default(),
        },
        Err(_) => ShellConfig::default(),
    }
}

/// 写盘（先过核心库校验：非法输入不会落盘）。
fn store(app: &tauri::AppHandle, config: &ShellConfig) -> Result<(), String> {
    dsharbor_core::launch::validate(&config.launch)?;
    let path = path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| format!("创建配置目录失败：{err}"))?;
    }
    let text =
        serde_json::to_string_pretty(config).map_err(|err| format!("序列化配置失败：{err}"))?;
    std::fs::write(&path, text).map_err(|err| format!("写入配置失败：{err}"))
}

/// 保存整份设置（界面自动保存用）。
pub fn save(app: &tauri::AppHandle, config: &ShellConfig) -> Result<(), String> {
    store(app, config)
}

/// 只更新启动配置、保留壳偏好（托盘单击目标等）；启动流程使用。
pub fn save_launch(app: &tauri::AppHandle, launch: &LaunchConfig) -> Result<(), String> {
    let mut config = load(app);
    config.launch = launch.clone();
    store(app, &config)
}
