//! 壳级设置与持久化（在 app_data_root）：设置本体是 config.json，
//! 另有一个 dsh-version.txt 存上次读到的 DSH 版本号（见 save_dsh_version）。
//!
//! 为什么单独成模块：不止「启动参数」要持久化——托盘单击打开哪个窗口
//! 这类壳行为偏好同样要活过重开与卸载，统一存一个 JSON。
//! 兼容旧格式：此前该文件顶层直接就是 `LaunchConfig`，加载时自动迁移。

use dsharbor_core::launch::{Channel, LaunchConfig, LaunchMode, Runtime};
use serde::{Deserialize, Serialize};

/// 托盘图标单击（左键）时默认打开的目标。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TrayClick {
    /// 启动界面（主窗口）——默认。
    #[default]
    Launcher,
    /// 应用内打开的窗口（壳内的 DSH 界面）。
    Dsh,
}

/// 关闭主窗口后可选的延迟秒数（界面下拉用）。
/// 0 = 立即销毁（现有行为）；其余为「先隐藏、到点再销毁」的秒数。
pub const LIGHT_DELAY_CHOICES: [u64; 6] = [0, 5, 15, 30, 60, 300];

/// 界面主题（Rust 侧的镜像，主题本体在 WebView 的 localStorage）。
/// 序列化成 classic|nativeDark|native，与前端 main.ts 的 ThemeId 字面量一一对应；
/// 改名会让两侧对不上（开窗装饰按 classic 兜底再闪一帧），必须同步。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum UiTheme {
    #[default]
    Classic,
    NativeDark,
    Native,
}

/// IPC 传入的主题名转枚举（save_ui_theme 的校验入口）；不认识的返回 None。
pub fn parse_ui_theme(raw: &str) -> Option<UiTheme> {
    match raw {
        "classic" => Some(UiTheme::Classic),
        "nativeDark" => Some(UiTheme::NativeDark),
        "native" => Some(UiTheme::Native),
        _ => None,
    }
}

/// 壳的全部持久化设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellConfig {
    pub launch: LaunchConfig,
    #[serde(default)]
    pub tray_click: TrayClick,
    /// 关闭主窗口后进入轻量态的延迟秒数（JSON 键 `lightDelaySecs`）。
    /// 旧配置没有这个键，取默认 0 = 现有行为。
    #[serde(default)]
    pub light_delay_secs: u64,
    /// 界面主题的 Rust 侧镜像（JSON 键 `uiTheme`，枚举见 UiTheme）。
    /// 开窗前由 Rust 读它定窗口装饰——等页面挂载完再切会先闪一帧自绘标题栏。
    /// 手改成不认识的值会让整份配置解析失败、镜像落空（按 classic 兜底），
    /// 界面下次启动会写回合法值。
    #[serde(default)]
    pub ui_theme: Option<UiTheme>,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            launch: LaunchConfig {
                mode: LaunchMode::Npx {
                    channel: Channel::Latest,
                    version: None,
                },
                runtime: Runtime::Default,
                extra_args: Vec::new(),
                port: None,
            },
            tray_click: TrayClick::Launcher,
            light_delay_secs: 0,
            ui_theme: None,
        }
    }
}

impl ShellConfig {
    /// 关窗后进轻量态的延迟时长。
    ///
    /// 不在 `LIGHT_DELAY_CHOICES` 里的值一律按 0（立即）处理：config.json 是用户可手改的
    /// 文本，若不兜底则一个手滑的巨值会让窗口永远只隐藏不销毁，界面内存一直不释放；
    /// 按 0 处理等于回到现有行为，最安全。
    pub fn light_delay(&self) -> std::time::Duration {
        let secs = if LIGHT_DELAY_CHOICES.contains(&self.light_delay_secs) {
            self.light_delay_secs
        } else {
            0
        };
        std::time::Duration::from_secs(secs)
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
            light_delay_secs: 0,
            ui_theme: None,
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

/// DSH 版本号缓存文件（`app_data_root/dsh-version.txt`）。
///
/// 为什么不并进 config.json：那份设置由界面整份回写（`save_shell_config`），
/// 版本号混在里面会被界面提交的旧值覆盖回去，单开一个文件才不会被覆盖。
fn version_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::app_data_root(app)?.join("dsh-version.txt"))
}

/// 上次记录到的 DSH 版本号（没记录过/读不出来时返回 None）。
pub fn load_dsh_version(app: &tauri::AppHandle) -> Option<String> {
    let path = version_path(app).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    let version = text.trim();
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

/// 记录 DSH 版本号：壳重开后先用这个值填界面，不再显示「未知」。
///
/// 落盘时机是每次查询成功时。版本号只有一个来源（启动后那次查询），
/// 停止与退出都不会让已查到的值变化，所以“退出瞬间的值”就是最后一次查到的值；
/// 实时落盘还能兼顾被强杀、断电这类收不到退出事件的情况。
pub fn save_dsh_version(app: &tauri::AppHandle, version: &str) -> Result<(), String> {
    let version = version.trim();
    if version.is_empty() {
        return Ok(());
    }
    let path = version_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| format!("创建配置目录失败：{err}"))?;
    }
    std::fs::write(&path, version).map_err(|err| format!("写入 DSH 版本号失败：{err}"))
}

/// 只更新启动配置、保留壳偏好（托盘单击目标等）；启动流程使用。
pub fn save_launch(app: &tauri::AppHandle, launch: &LaunchConfig) -> Result<(), String> {
    let mut config = load(app);
    config.launch = launch.clone();
    store(app, &config)
}
