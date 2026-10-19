//! 系统代理探测，以及「这次要往子进程里塞哪些环境变量」的唯一算法入口（外壳侧）。
//!
//! 纯逻辑都在核心库（`dsharbor_core::net`）：地址归一化、按模式选代理、例外列表匹配、
//! 最终键值对都由那边算，这里只做核心库不能做的两件事——
//! 1. 读系统里到底配了什么：先看环境变量（`https_proxy` 等，跨平台且最直接），
//!    Windows 上再看「Internet 选项 → 连接 → 局域网设置」对应的注册表键；
//! 2. 把结果缓存 30 秒：界面切模式、切下载源会连续触发多次查询，
//!    每次去跑一遍 `reg.exe` 太浪费；30 秒足够短，用户改完系统代理再操作就能看到。
//!
//! 为什么走 `reg query` 而不是引第三方 crate：只为读三个值，多一个依赖不划算；
//! 输出解析（`ProxyEnable` / `ProxyServer` / `ProxyOverride`）已经有现成的
//! `registry_query::parse_reg_query_value` 与核心库里的 `parse_reg_dword` 等纯函数。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use dsharbor_core::net::{self, ProxyResolution, ProxySource, SystemProxyProbe};
use dsharbor_core::prefs::{DownloadSource, ShellPrefs};
use dsharbor_core::registry_query::parse_reg_query_value;

/// 系统代理探测结果的缓存有效期。
const PROBE_TTL: Duration = Duration::from_secs(30);

/// 读注册表的超时：`reg query` 正常几十毫秒，给足余量但不允许卡死界面。
const REG_TIMEOUT: Duration = Duration::from_secs(15);

/// Windows「局域网设置」所在的注册表键。
#[cfg(windows)]
const INTERNET_SETTINGS: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

/// 环境变量里表示「代理地址」的名字，按优先级排列。
///
/// 先小写再大写：Node 生态（含 npm 自己）惯例用小写，而各平台的图形程序更常写大写；
/// 同一个进程里两种写法都存在时，取小写那个（更贴近实际在使用的那份配置）。
const PROXY_ENV_KEYS: [&str; 6] = [
    "https_proxy",
    "HTTPS_PROXY",
    "http_proxy",
    "HTTP_PROXY",
    "all_proxy",
    "ALL_PROXY",
];

/// 环境变量里表示「例外列表」的名字。
const BYPASS_ENV_KEYS: [&str; 2] = ["no_proxy", "NO_PROXY"];

static PROBE: Mutex<Option<(Instant, SystemProxyProbe)>> = Mutex::new(None);

/// 读系统代理（带缓存）。
///
/// 探测失败（没有 `reg.exe`、键不存在、权限不足）一律当作「没配代理」：
/// 拿不到系统设置不该让启动 DSH 这类操作失败，直连至少还能用。
pub fn system_probe() -> SystemProxyProbe {
    if let Ok(guard) = PROBE.lock() {
        if let Some((at, probe)) = guard.as_ref() {
            if at.elapsed() < PROBE_TTL {
                return probe.clone();
            }
        }
    }
    let probe = probe_uncached();
    if let Ok(mut guard) = PROBE.lock() {
        *guard = Some((Instant::now(), probe.clone()));
    }
    probe
}

/// 丢掉探测缓存（保存代理设置后调用：用户可能刚在系统里改了代理）。
pub fn invalidate_probe() {
    if let Ok(mut guard) = PROBE.lock() {
        *guard = None;
    }
}

/// 真去探一次：环境变量优先，Windows 上再兜注册表。
fn probe_uncached() -> SystemProxyProbe {
    if let Some(probe) = probe_from_env(|name| std::env::var(name).ok()) {
        return probe;
    }
    #[cfg(windows)]
    if let Some(probe) = probe_from_registry() {
        return probe;
    }
    SystemProxyProbe::none()
}

/// 从环境变量里拼探测结果；一个代理变量都没有时返回 `None`（继续看注册表）。
///
/// 抽成接受 `lookup` 的函数是为了能单测：单元测试里不能保证开发机自己没设代理。
fn probe_from_env(lookup: impl Fn(&str) -> Option<String>) -> Option<SystemProxyProbe> {
    let url = PROXY_ENV_KEYS
        .iter()
        .find_map(|key| lookup(key).map(|value| value.trim().to_string()))
        .filter(|value| !value.is_empty())?;
    let bypass = BYPASS_ENV_KEYS
        .iter()
        .find_map(|key| lookup(key).filter(|value| !value.trim().is_empty()))
        .map(|raw| net::parse_exception_list(&raw))
        .unwrap_or_default();
    Some(SystemProxyProbe {
        url: Some(url),
        bypass,
        source: ProxySource::Env,
    })
}

/// 读 Windows 的「局域网设置」。
///
/// 一次 `reg query` 拿整键，再从中取三个值：起三个进程读三个值没必要，
/// 而且 `ProxyEnable` 与 `ProxyServer` 必须来自同一份快照，否则可能读到半新半旧。
#[cfg(windows)]
fn probe_from_registry() -> Option<SystemProxyProbe> {
    let mut command = std::process::Command::new("reg");
    command.args(["query", INTERNET_SETTINGS]);
    let (code, output) = crate::plugin::run_capture(command, REG_TIMEOUT).ok()?;
    if code != 0 {
        return None;
    }
    parse_registry_output(&output)
}

/// 解析 `reg query` 的整键输出。
///
/// `ProxyEnable` 缺失或为 0 时返回 `None`（系统里填了地址但没启用，等同于没配）。
#[cfg(windows)]
fn parse_registry_output(output: &str) -> Option<SystemProxyProbe> {
    let enabled = parse_reg_query_value(output, "ProxyEnable")
        .and_then(|raw| net::parse_reg_dword(&raw))
        .unwrap_or(0);
    if enabled == 0 {
        return None;
    }
    let url = parse_reg_query_value(output, "ProxyServer")
        .and_then(|raw| net::parse_windows_proxy_server(&raw))?;
    let bypass = parse_reg_query_value(output, "ProxyOverride")
        .map(|raw| net::parse_exception_list(&raw))
        // 系统里的默认值是一串 `*.local` 之类的模板；读不到就当没有例外列表，
        // 回环地址仍由 plan_env 兜底加在最前面。
        .unwrap_or_default();
    Some(SystemProxyProbe {
        url: Some(url),
        bypass,
        source: ProxySource::WindowsRegistry,
    })
}

/// 界面「网络」卡代理段要显示的东西：生效的地址、例外列表与那一行说明。
///
/// 界面不自己判对错、也不自己拼文案：地址归一化与提示集中在核心库，
/// 这里只把探测结果与偏好合起来交给它算。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyState {
    /// 这台宿主能不能真正生效（v1 只做 Windows）：false 时界面上整卡只留一句说明。
    /// 与环境卡的 `ProfileListing.supported` 同一个思路：平台判断在后端做，界面只读标记。
    pub supported: bool,
    /// 真正下发的代理地址；`None` 表示这次不注入任何代理变量。
    pub url: Option<String>,
    /// 例外列表（系统里那份；回环地址由核心库兜底加在最前面）。
    pub bypass: Vec<String>,
    /// 一行说明：生效了就报走哪儿，没生效就说原因。
    pub hint: String,
    /// 当前代理状态的一句话（「当前代理：…」）。
    /// 自检失败时要把它拼在后面：光说「不通」而不说「当时走的是哪条路」，用户改完也不知道对不对。
    pub state_text: String,
}

/// 按当前设置算出的代理方案（探测结果带缓存）。
pub fn resolution(prefs: &ShellPrefs) -> ProxyResolution {
    net::resolve_proxy(prefs.proxy_mode, &prefs.proxy_address, &system_probe())
}

/// 界面展示用的代理状态（探测结果带缓存）。
pub fn state(prefs: &ShellPrefs) -> ProxyState {
    state_with(prefs, &system_probe(), cfg!(windows))
}

/// 同 [`state`]，但探测结果与平台标记由调用方给——便于不依赖开发机环境做单测。
fn state_with(prefs: &ShellPrefs, probe: &SystemProxyProbe, supported: bool) -> ProxyState {
    let resolution = net::resolve_proxy(prefs.proxy_mode, &prefs.proxy_address, probe);
    ProxyState {
        supported,
        hint: net::status_hint(prefs.proxy_mode, &resolution),
        state_text: net::proxy_state_text(prefs.proxy_mode, &resolution),
        url: resolution.url,
        bypass: resolution.bypass,
    }
}

/// 这次要注入子进程的全部环境变量：下载源 + 代理，一次算完。
///
/// 三条注入路径（版本查询、插件安装卸载、拉起 DSH）都调这一个函数，
/// 不各自拼一套键值。
pub fn child_env(prefs: &ShellPrefs, source: DownloadSource) -> Vec<(String, String)> {
    net::plan_env(net::registry_of(source), &resolution(prefs))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup_from(pairs: Vec<(&'static str, &'static str)>) -> impl Fn(&str) -> Option<String> {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn no_proxy_variables_means_fall_through() {
        assert!(probe_from_env(lookup_from(vec![])).is_none());
        // 空值不算「配了代理」：有些工具会把变量设成空串。
        assert!(probe_from_env(lookup_from(vec![("http_proxy", "  ")])).is_none());
    }

    #[test]
    fn lowercase_names_win_and_bypass_is_parsed() {
        let probe = probe_from_env(lookup_from(vec![
            ("https_proxy", "127.0.0.1:7890"),
            ("HTTPS_PROXY", "10.0.0.1:8888"),
            ("no_proxy", "localhost, .corp.example"),
        ]))
        .unwrap();
        assert_eq!(probe.url.as_deref(), Some("127.0.0.1:7890"));
        assert_eq!(probe.source, ProxySource::Env);
        assert_eq!(probe.bypass, vec!["localhost", ".corp.example"]);
    }

    #[test]
    fn env_without_bypass_still_counts() {
        let probe =
            probe_from_env(lookup_from(vec![("ALL_PROXY", "socks5://127.0.0.1:1080")])).unwrap();
        assert_eq!(probe.url.as_deref(), Some("socks5://127.0.0.1:1080"));
        assert!(probe.bypass.is_empty());
    }

    #[test]
    fn state_reports_the_effective_url_and_explains_the_other_modes() {
        let probe = SystemProxyProbe {
            url: Some("127.0.0.1:7890".to_string()),
            bypass: vec!["*.corp.example".to_string()],
            source: ProxySource::Env,
        };
        let system = ShellPrefs::default();
        let state = state_with(&system, &probe, true);
        assert_eq!(state.url.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(state.bypass, vec!["*.corp.example"]);
        assert!(state.hint.contains("跟随系统"), "{}", state.hint);

        // 手动模式填坏了：不下发地址，说明里就是那句校验文案。
        let manual = ShellPrefs {
            proxy_mode: dsharbor_core::prefs::ProxyMode::Manual,
            proxy_address: "socks5://127.0.0.1:1080".to_string(),
            ..ShellPrefs::default()
        };
        let state = state_with(&manual, &probe, true);
        assert_eq!(state.url, None);
        assert!(state.hint.contains("混合端口"), "{}", state.hint);

        // 不走代理：地址为空，说明说清「不注入」。
        let off = ShellPrefs {
            proxy_mode: dsharbor_core::prefs::ProxyMode::Off,
            ..ShellPrefs::default()
        };
        let state = state_with(&off, &probe, true);
        assert_eq!(state.url, None);
        assert!(state.hint.contains("不走代理"), "{}", state.hint);
    }

    #[test]
    fn the_host_platform_flag_rides_along_with_the_state() {
        // 非 Windows 宿主上网络图标不能装「生效了」：界面把整卡换成一句说明，
        // 标记由后端给（跟环境卡的 ProfileListing.supported 同一个思路）。
        let probe = SystemProxyProbe {
            url: Some("127.0.0.1:7890".to_string()),
            bypass: Vec::new(),
            source: ProxySource::Env,
        };
        let prefs = ShellPrefs::default();
        assert!(state_with(&prefs, &probe, true).supported);
        assert!(!state_with(&prefs, &probe, false).supported);
    }

    #[test]
    fn state_carries_the_one_line_proxy_summary_for_failure_texts() {
        // 自检失败时界面要把这句拼在后面，而文案只在核心库一处定。
        let probe = SystemProxyProbe {
            url: Some("127.0.0.1:7890".to_string()),
            bypass: Vec::new(),
            source: ProxySource::Env,
        };
        assert_eq!(
            state_with(&ShellPrefs::default(), &probe, true).state_text,
            "当前代理：http://127.0.0.1:7890（跟随系统）"
        );
        let off = ShellPrefs {
            proxy_mode: dsharbor_core::prefs::ProxyMode::Off,
            ..ShellPrefs::default()
        };
        assert_eq!(
            state_with(&off, &probe, true).state_text,
            "当前代理：不走代理"
        );
    }

    #[cfg(windows)]
    #[test]
    fn disabled_registry_entry_is_treated_as_no_proxy() {
        let output = "\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\n    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7890\n";
        assert!(parse_registry_output(output).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn enabled_registry_entry_yields_url_and_bypass() {
        let output = "\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\n    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7890\n    ProxyOverride    REG_SZ    *.corp.example;<local>\n";
        let probe = parse_registry_output(output).unwrap();
        assert_eq!(probe.url.as_deref(), Some("127.0.0.1:7890"));
        assert_eq!(probe.bypass, vec!["*.corp.example", "<local>"]);
        assert_eq!(probe.source, ProxySource::WindowsRegistry);
    }

    #[cfg(windows)]
    #[test]
    fn registry_output_without_proxy_server_is_ignored() {
        // 只有 ProxyEnable=1、没有地址：当作没配，别下发一个空代理。
        let output = "\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\n    ProxyEnable    REG_DWORD    0x1\n";
        assert!(parse_registry_output(output).is_none());
    }
}
