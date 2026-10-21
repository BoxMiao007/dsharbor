//! 壳级设置与持久化（在 app_data_root）：设置本体是 config.json，
//! 另有一个 dsh-version.txt 存上次读到的 DSH 版本号（见 save_dsh_version）。
//!
//! 为什么单独成模块：不止「启动参数」要持久化——托盘单击打开哪个窗口
//! 这类壳行为偏好同样要活过重开与卸载，统一存一个 JSON。
//! 兼容旧格式：此前该文件顶层直接就是 `LaunchConfig`，加载时自动迁移。

use dsharbor_core::launch::{LaunchConfig, LaunchMode, Runtime};
use dsharbor_core::prefs::ShellPrefs;
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

/// 界面外观（Rust 侧的镜像，本体在 WebView 的 localStorage）。
/// 序列化成 light|dark，与前端 main.ts 的 ThemeId 字面量一一对应；
/// 改名会让两侧对不上（开窗底色按错的一侧给），必须同步。
/// 旧版的三套主题（classic / nativeDark / native）通过 alias 继续可读：
/// classic 是浅色，nativeDark 与 native 都是深色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum UiTheme {
    #[serde(alias = "classic")]
    Light,
    #[default]
    #[serde(alias = "nativeDark", alias = "native")]
    Dark,
}

/// IPC 传入的主题名转枚举（save_ui_theme 的校验入口）；不认识的返回 None。
pub fn parse_ui_theme(raw: &str) -> Option<UiTheme> {
    match raw {
        "light" => Some(UiTheme::Light),
        "dark" => Some(UiTheme::Dark),
        // 旧版的三个名字：迁移后仍能被接受，免得存量配置文件写回时报错。
        "classic" => Some(UiTheme::Light),
        "nativeDark" | "native" => Some(UiTheme::Dark),
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
    /// 「环境 / 网络 / 集成」三张卡承载的五个字段（JSON 里与上面几个键平级）。
    /// 取值、默认值与宽容读取都在核心库（`dsharbor_core::prefs`）里定义与测试：
    /// 缺键取默认，枚举认不出的名字只让那一个字段回默认，不牵连其余设置。
    #[serde(flatten)]
    pub prefs: ShellPrefs,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            launch: LaunchConfig {
                // 默认「官方 npx 命令」+ 自动最新版本（不指定版本号）。
                mode: LaunchMode::Npx { version: None },
                runtime: Runtime::Default,
                extra_args: Vec::new(),
                port: None,
            },
            tray_click: TrayClick::Launcher,
            light_delay_secs: 0,
            ui_theme: None,
            prefs: ShellPrefs::default(),
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
            ..ShellConfig::default()
        },
        Err(_) => ShellConfig::default(),
    }
}

/// 写盘（先过核心库校验：非法输入不会落盘）。
fn store(app: &tauri::AppHandle, config: &ShellConfig) -> Result<(), String> {
    dsharbor_core::launch::validate(&config.launch)?;
    validate_proxy(&config.prefs)?;
    let path = path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| format!("创建配置目录失败：{err}"))?;
    }
    let text =
        serde_json::to_string_pretty(config).map_err(|err| format!("序列化配置失败：{err}"))?;
    std::fs::write(&path, text).map_err(|err| format!("写入配置失败：{err}"))
}

/// 代理地址的落盘前校验。
///
/// 只校验「手动模式且真的填了东西」这一种：
/// - 其它模式下留着的地址只是没被清理的残留，拦住它会让「切回系统代理后啥也没改却存不了盘」；
/// - 手动模式下空地址是刚切过来的中间状态，界面已经用提示行说了「还没填」，
///   不需要用「整份配置存不下去」再拦一次。
///
/// 真正要拦的是「填了一个用不出去的地址」：这种值一经落盘就会静默带到代理变量、
/// 下载源自检与命令行接入上，事后很难看出是哪一步坏的。
fn validate_proxy(prefs: &ShellPrefs) -> Result<(), String> {
    if prefs.proxy_mode != dsharbor_core::prefs::ProxyMode::Manual {
        return Ok(());
    }
    if prefs.proxy_address.trim().is_empty() {
        return Ok(());
    }
    dsharbor_core::net::normalize_proxy_url(&prefs.proxy_address)
        .map(|_| ())
        .map_err(|err| format!("代理地址填错了：{}", err.message()))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 壳配置里五个新字段的完整往返：界面改 → 存盘（序列化）→ 重启（反序列化）。
    #[test]
    fn shell_config_round_trips_the_five_new_fields() {
        let config = ShellConfig {
            prefs: ShellPrefs {
                profile: "自定义环境".into(),
                download_source: dsharbor_core::prefs::DownloadSource::Mirror,
                proxy_mode: dsharbor_core::prefs::ProxyMode::Manual,
                proxy_address: "http://127.0.0.1:7890".into(),
                cli_integration: true,
            },
            ..ShellConfig::default()
        };

        let text = serde_json::to_string_pretty(&config).expect("序列化壳配置失败");
        let back: ShellConfig = serde_json::from_str(&text).expect("反序列化壳配置失败");

        assert_eq!(back.prefs, config.prefs, "五个新字段应原样往返");
    }

    /// 老配置文件（没有这些新键）与新配置（键齐全）混着读都要成立。
    #[test]
    fn missing_new_keys_take_defaults_without_dropping_other_settings() {
        // 旧配置文件：只有壳自己的键，没有环境/网络/集成的字段。
        let text = r#"{
  "launch": { "mode": { "kind": "npx" }, "runtime": { "kind": "default" } },
  "trayClick": "dsh",
  "lightDelaySecs": 15,
  "uiTheme": "nativeDark"
}"#;
        let config: ShellConfig = serde_json::from_str(text).expect("旧配置应能读出来");

        assert_eq!(config.tray_click, TrayClick::Dsh, "其余设置不能丢");
        assert_eq!(config.light_delay_secs, 15, "其余设置不能丢");
        assert_eq!(
            config.ui_theme,
            Some(UiTheme::Dark),
            "旧值 nativeDark 按深色读；其余设置不能丢"
        );
        assert_eq!(
            config.prefs,
            ShellPrefs::default(),
            "缺键时这些字段取默认值"
        );
    }

    /// 手改坏了枚举值只让那一个字段回默认，壳照样能打开、其余设置照样在。
    #[test]
    fn unknown_enum_literal_in_file_falls_back_per_field() {
        let text = r#"{
  "launch": { "mode": { "kind": "npx" }, "runtime": { "kind": "default" } },
  "trayClick": "launcher",
  "lightDelaySecs": 30,
  "downloadSource": "某个不存在的源",
  "proxyMode": 42,
  "proxyAddress": "http://127.0.0.1:1080",
  "cliIntegration": true
}"#;
        let config: ShellConfig =
            serde_json::from_str(text).expect("坏枚举值不该让整份配置读不出来");

        assert_eq!(config.light_delay_secs, 30, "坏枚举只影响自己那一个字段");
        assert_eq!(
            config.prefs.download_source,
            dsharbor_core::prefs::DownloadSource::Inherit,
            "认不出的下载源退回默认"
        );
        assert_eq!(
            config.prefs.proxy_mode,
            dsharbor_core::prefs::ProxyMode::System,
            "类型都不对的代理模式也退回默认"
        );
        assert_eq!(
            config.prefs.proxy_address, "http://127.0.0.1:1080",
            "字符串照读"
        );
        assert!(config.prefs.cli_integration, "布尔照读");
    }

    /// 手动模式填了个写不出来的地址：存盘前就要被拦住，不能落盘。
    ///
    /// 不拦的话坏地址会静默写进 config.json，下次启动依次污染代理变量、
    /// 下载源自检与「命令行接入」，排查时看不出是哪一步坏的。
    #[test]
    fn a_broken_manual_proxy_address_is_refused_before_it_is_written() {
        let prefs = ShellPrefs {
            proxy_mode: dsharbor_core::prefs::ProxyMode::Manual,
            proxy_address: "socks5://127.0.0.1:7890".into(),
            ..ShellPrefs::default()
        };

        let err = validate_proxy(&prefs).expect_err("socks 地址在手动模式下应被拒");
        assert!(err.contains("http"), "拒绝理由要直接说人话，实际是：{err}");
    }

    /// 手动模式但还没填地址：这是界面上的中间状态（刚切到手动），不能拦住整份配置。
    #[test]
    fn an_empty_manual_proxy_address_is_not_a_save_blocker() {
        let prefs = ShellPrefs {
            proxy_mode: dsharbor_core::prefs::ProxyMode::Manual,
            proxy_address: "  ".into(),
            ..ShellPrefs::default()
        };

        assert!(validate_proxy(&prefs).is_ok());
    }

    /// 别的模式下留着的地址只是残留（切回系统代理后再也没碰过它），不该挡整份配置保存。
    #[test]
    fn a_leftover_address_in_other_modes_does_not_block_saving() {
        for mode in [
            dsharbor_core::prefs::ProxyMode::System,
            dsharbor_core::prefs::ProxyMode::Off,
        ] {
            let prefs = ShellPrefs {
                proxy_mode: mode,
                proxy_address: "socks5://127.0.0.1:7890".into(),
                ..ShellPrefs::default()
            };
            assert!(
                validate_proxy(&prefs).is_ok(),
                "{mode:?} 模式下的残留地址不该挡住保存"
            );
        }
    }

    /// 手动模式下能归一化的地址（不写协议、纯主机名）也算合格：归一化规则跟下发同一套。
    #[test]
    fn a_manual_address_that_normalizes_is_accepted() {
        let prefs = ShellPrefs {
            proxy_mode: dsharbor_core::prefs::ProxyMode::Manual,
            proxy_address: "127.0.0.1:7890".into(),
            ..ShellPrefs::default()
        };

        assert!(validate_proxy(&prefs).is_ok());
    }
}
