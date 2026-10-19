//! 外壳配置里属于「环境 / 网络 / 集成」三张卡的六个字段。
//!
//! 为什么放在核心库：这六个字段的取值、默认值与宽容读取都是纯逻辑，放这里能在开发机上
//! 全自动验证。config.json 是用户可手改的文本——缺键、枚举写成认不出的名字（甚至类型不对）
//! 都不该让整份配置解析失败、把用户的启动配置一起弄丢。
//!
//! 外壳（src-tauri/src/settings.rs）用 `#[serde(flatten)]` 把它平铺进 ShellConfig，
//! 界面（src/main.ts 的 ShellConfig）的键名与这里的 JSON 键名一一对应：
//! `profile`、`downloadSource`、`proxyMode`、`proxyAddress`、`cliIntegration`、`cacheCleanup`。

use serde::{Deserialize, Deserializer, Serialize};

use crate::launch::PROFILE_NAME;

/// 默认环境名：DSH 自带的 `web` 环境。
pub const DEFAULT_PROFILE: &str = PROFILE_NAME;

/// 下载源：npm 从哪个 registry 拉包。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum DownloadSource {
    /// 沿用 npm 全局配置——默认。壳不下发任何 registry 值，用户自己的 .npmrc 说了算。
    #[default]
    Inherit,
    /// 镜像源（国内直连更快；新版本可能稍晚才同步到）。
    Mirror,
    /// npm 官方源（更新及时；国内直连可能较慢）。
    Official,
}

impl DownloadSource {
    /// 落盘、日志与界面共用的字面量。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inherit => "inherit",
            Self::Mirror => "mirror",
            Self::Official => "official",
        }
    }

    /// 字面量转枚举；认不出的名字返回 None（IPC 校验与宽容读取共用）。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "inherit" => Some(Self::Inherit),
            "mirror" => Some(Self::Mirror),
            "official" => Some(Self::Official),
            _ => None,
        }
    }
}

/// 代理模式：DSH 子进程与壳自己的下载动作走哪个代理。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ProxyMode {
    /// 跟随系统——默认。壳按系统里已配置的代理下发环境变量（系统没配就等同直连）。
    #[default]
    System,
    /// 手动填写：用配置里的代理地址。
    Manual,
    /// 不走代理：不向子进程下发任何代理环境变量。
    Off,
}

impl ProxyMode {
    /// 落盘、日志与界面共用的字面量。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Manual => "manual",
            Self::Off => "off",
        }
    }

    /// 字面量转枚举；认不出的名字返回 None（IPC 校验与宽容读取共用）。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "system" => Some(Self::System),
            "manual" => Some(Self::Manual),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
}

/// 宽容读取下载源：认不出的值（别的名字、数字、null 都算）退回默认，不给整份配置报错。
fn lenient_download_source<'de, D>(deserializer: D) -> Result<DownloadSource, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(deserializer)?;
    Ok(raw
        .as_str()
        .and_then(DownloadSource::parse)
        .unwrap_or_default())
}

/// 宽容读取代理模式：同 `lenient_download_source`。
fn lenient_proxy_mode<'de, D>(deserializer: D) -> Result<ProxyMode, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(deserializer)?;
    Ok(raw.as_str().and_then(ProxyMode::parse).unwrap_or_default())
}

/// 「环境 / 网络 / 集成」三张卡承载的六个字段。
///
/// 只承载取值与默认值：这三张卡各自的行为（列环境、下载源映射、写 PATH 垫片等）由后续实现，
/// 本轮谁都不读它们，只保证「界面能读回、能原样写回、旧配置缺键也不炸」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellPrefs {
    /// 当前环境名（DSH 的 profile 名，「环境」卡的下拉选它）；默认 `web`。
    pub profile: String,
    /// 下载源（「网络」卡的下拉）；默认沿用 npm 全局配置。
    #[serde(deserialize_with = "lenient_download_source")]
    pub download_source: DownloadSource,
    /// 代理模式（「网络」卡的下拉）；默认跟随系统。
    #[serde(deserialize_with = "lenient_proxy_mode")]
    pub proxy_mode: ProxyMode,
    /// 手动代理地址；只有代理模式为「手动填写」时才用得上，默认空串。
    pub proxy_address: String,
    /// 命令行集成开关（「集成」卡的开关）；默认关。
    pub cli_integration: bool,
    /// 缓存清理开关（「集成」卡的开关）；默认关。
    ///
    /// 打开后，每次**真正拉起** DSH 进程之后顺手跑一次与「立即清理」
    /// 完全相同的修剪（判定规则见 `crate::npx_cache`，是否该跑的判断见
    /// `crate::cache_auto::should_run`）。注意触发点是「拉起了一个进程」，不是「启动成功」：
    /// 进程起来之后能不能健康跑下去由会话状态单独反映，不在这里等。默认关是有意的：
    /// 自动删东西的风险高于省下的磁盘，先让用户看到能省多少再自己决定。关着时界面照样显示
    /// 可回收大小。
    pub cache_cleanup: bool,
}

impl Default for ShellPrefs {
    fn default() -> Self {
        Self {
            profile: DEFAULT_PROFILE.to_string(),
            download_source: DownloadSource::default(),
            proxy_mode: ProxyMode::default(),
            proxy_address: String::new(),
            cli_integration: false,
            cache_cleanup: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_of(prefs: &ShellPrefs) -> serde_json::Value {
        serde_json::to_value(prefs).expect("ShellPrefs 必须可序列化")
    }

    fn parse(json: &str) -> ShellPrefs {
        serde_json::from_str(json).expect("ShellPrefs 必须可宽容解析")
    }

    #[test]
    fn defaults_are_the_documented_ones() {
        let prefs = ShellPrefs::default();
        assert_eq!(prefs.profile, "web", "默认环境名");
        assert_eq!(prefs.download_source, DownloadSource::Inherit, "默认沿用");
        assert_eq!(prefs.proxy_mode, ProxyMode::System, "默认跟随系统");
        assert_eq!(prefs.proxy_address, "", "默认没有手动代理地址");
        assert!(!prefs.cli_integration, "命令行集成默认关");
        assert!(!prefs.cache_cleanup, "缓存清理默认关");
    }

    #[test]
    fn json_keys_and_enum_literals_are_the_wire_contract() {
        let prefs = ShellPrefs {
            profile: "lab".to_string(),
            download_source: DownloadSource::Mirror,
            proxy_mode: ProxyMode::Manual,
            proxy_address: "http://127.0.0.1:7890".to_string(),
            cli_integration: true,
            cache_cleanup: true,
        };
        // 键名与字面量是界面（src/main.ts）与后续票据的共同契约，写死在这里防漂移。
        assert_eq!(
            json_of(&prefs),
            serde_json::json!({
                "profile": "lab",
                "downloadSource": "mirror",
                "proxyMode": "manual",
                "proxyAddress": "http://127.0.0.1:7890",
                "cliIntegration": true,
                "cacheCleanup": true,
            })
        );
    }

    #[test]
    fn round_trips_through_json() {
        let prefs = ShellPrefs {
            profile: "office".to_string(),
            download_source: DownloadSource::Official,
            proxy_mode: ProxyMode::Off,
            proxy_address: String::new(),
            cli_integration: true,
            cache_cleanup: false,
        };
        let text = serde_json::to_string(&prefs).expect("序列化");
        assert_eq!(parse(&text), prefs, "改 → 存 → 读回应完全一致");
    }

    #[test]
    fn cache_cleanup_switch_survives_a_restart() {
        // 自动清理开关是「打开一次就一直生效」的偏好：写盘再读回必须还是开着的，
        // 缺键（老配置没有这个键）才是关。
        let text = r#"{"cacheCleanup":true}"#;
        assert!(parse(text).cache_cleanup, "存下来的开状态要读回来");
        assert!(
            !parse(r#"{"cacheCleanup":false}"#).cache_cleanup,
            "关状态也要原样读回"
        );
        assert!(!parse("{}").cache_cleanup, "老配置没有这个键时按默认关处理");
    }

    #[test]
    fn missing_keys_take_defaults() {
        assert_eq!(parse("{}"), ShellPrefs::default());
        // 只给一个键时其余取默认，给了的那个值要留住。
        let partial = parse(r#"{"profile":"lab"}"#);
        assert_eq!(partial.profile, "lab");
        assert_eq!(partial.download_source, DownloadSource::Inherit);
        assert_eq!(partial.proxy_mode, ProxyMode::System);
    }

    #[test]
    fn unknown_enum_values_fall_back_to_default() {
        // 手改坏了（旧版本没这个名字 / 打错字）只让这一个字段回默认。
        let prefs = parse(
            r#"{"profile":"lab","downloadSource":"taobao","proxyMode":"socks5","cliIntegration":true}"#,
        );
        assert_eq!(prefs.download_source, DownloadSource::Inherit);
        assert_eq!(prefs.proxy_mode, ProxyMode::System);
        // 同一份配置里的其它字段不受影响。
        assert_eq!(prefs.profile, "lab");
        assert!(prefs.cli_integration);
    }

    #[test]
    fn wrong_types_on_enums_do_not_break_the_struct() {
        let prefs = parse(r#"{"downloadSource":42,"proxyMode":null}"#);
        assert_eq!(prefs.download_source, DownloadSource::Inherit);
        assert_eq!(prefs.proxy_mode, ProxyMode::System);
    }

    #[test]
    fn enum_literals_round_trip_through_parse_and_as_str() {
        for source in [
            DownloadSource::Inherit,
            DownloadSource::Mirror,
            DownloadSource::Official,
        ] {
            assert_eq!(DownloadSource::parse(source.as_str()), Some(source));
        }
        for mode in [ProxyMode::System, ProxyMode::Manual, ProxyMode::Off] {
            assert_eq!(ProxyMode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(DownloadSource::parse("inherit "), None, "带空格不算认得出");
        assert_eq!(ProxyMode::parse(""), None);
    }
}
