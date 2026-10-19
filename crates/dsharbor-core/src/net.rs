//! 下载源与网络代理到「该往子进程塞哪些环境变量」的映射。
//!
//! 为什么放在核心库：这里只有「哪个选项对应哪个地址」「哪些键值对要下发」这类纯字符串
//! 逻辑，放核心库能在开发机上全自动测；真正把算出来的键值对塞进子进程环境变量、以及去
//! 读系统代理设置，都是外壳的事（`src-tauri/src/proxy.rs` 的探测、
//! `src-tauri/src/registry.rs` 的版本查询、`src-tauri/src/plugin.rs` 的插件安装、
//! `src-tauri/src/launcher.rs` 的启动）。
//!
//! 三个调用点共用 [`plan_env`] 这一份结果，不各拼一套：下载源与代理的注入路径只有一条。
//!
//! 枚举复用 [`crate::prefs::DownloadSource`] 与 [`crate::prefs::ProxyMode`]：界面下拉、
//! 落盘、宽容读取已经在用那两份，另开同形枚举只会多一处需要对齐的字面量。

use crate::prefs::{DownloadSource, ProxyMode};
use url::Url;

/// npm 官方源。
pub const OFFICIAL_REGISTRY: &str = "https://registry.npmjs.org";

/// 国内镜像源。
pub const MIRROR_REGISTRY: &str = "https://registry.npmmirror.com";

/// 下发 registry 用的环境变量名。
///
/// npm 读环境变量时逐字认这个字面量（大小写敏感的 Unix 侧也一样），所以外壳在几条路径上
/// 都原样注入：主机是 `Command::env`，WSL 是 `env K=V` 的单个 argv。值是不带空格的 URL，
/// 这一写法不需要额外转义。
pub const REGISTRY_ENV: &str = "npm_config_registry";

/// 例外列表里恒有的回环地址。
///
/// 回环地址在任何模式下都必须直连：用户把请求代理到本机端口时，代理软件自己再去连
/// 127.0.0.1 会绕回来打成环；而「代理监听在本机、程序又要求代理去连本机」也会死循环。
pub const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// 该下载源对应的 registry 地址；`None` 表示不下发任何 registry 值（沿用 npm 全局配置）。
pub fn registry_of(source: DownloadSource) -> Option<&'static str> {
    match source {
        DownloadSource::Inherit => None,
        DownloadSource::Mirror => Some(MIRROR_REGISTRY),
        DownloadSource::Official => Some(OFFICIAL_REGISTRY),
    }
}

/// 该下载源要注入子进程的环境变量；「沿用 npm 全局配置」时返回空 vec。
///
/// 空 vec 的语义就是「没有这项功能」：调用点拿到空 vec 不做任何注入，
/// 子进程读到的仍是用户自己 `.npmrc` 里的源。
pub fn registry_env(source: DownloadSource) -> Vec<(String, String)> {
    match registry_of(source) {
        Some(url) => vec![(REGISTRY_ENV.to_string(), url.to_string())],
        None => Vec::new(),
    }
}

/// 代理地址归一化失败的原因。
///
/// 每个变体都要能直接给人看：手动模式填错时界面把这些文案原样显示在提示行里，
/// 所以文案本身写清楚「错在哪」和「该写成什么样」。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProxyUrlError {
    /// 什么都没填。
    Empty,
    /// socks 代理：本壳只下发 http 代理变量，得填同一端口的 http 混合端口。
    Socks,
    /// 协议不是 http/https。
    Scheme(String),
    /// 解析不出主机名。
    Host,
    /// 含非 ASCII 字符（中文、全角标点），大概率是手误或从别处粘错。
    Encoding,
}

impl ProxyUrlError {
    /// 一句话中文说明，界面直接显示。
    pub fn message(&self) -> String {
        match self {
            Self::Empty => "还没填代理地址，形如 http://127.0.0.1:7890".to_string(),
            Self::Socks => {
                "这里是 socks 代理，请填同一端口的 http 混合端口，形如 http://127.0.0.1:7890"
                    .to_string()
            }
            Self::Scheme(scheme) => {
                format!("只支持 http 或 https 代理，不认识 {scheme}:// 开头的地址")
            }
            Self::Host => "地址里没解析出主机名，形如 http://127.0.0.1:7890".to_string(),
            Self::Encoding => {
                "地址里有中文或全角字符，请填纯英文的地址，形如 http://127.0.0.1:7890".to_string()
            }
        }
    }
}

impl std::fmt::Display for ProxyUrlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// 把用户填的代理地址收拾成可以下发的形态。
///
/// 规则（写死在这里，界面与外壳都不要再各判一遍）：
/// - 没写协议就补 `http://`（用户最常见的填法是 `127.0.0.1:7890`）；
/// - 只接受 http / https，其它协议报 [`ProxyUrlError::Scheme`]；
/// - 路径与查询串一律丢掉（代理地址只需要协议 + 主机 + 端口）；
/// - 保留 `user:pass@`（有些内网代理要认证）；
/// - 含非 ASCII 字符直接拒（`url` 会把它转成 `xn--` 假域名，还不如直接说人话）。
pub fn normalize_proxy_url(raw: &str) -> Result<String, ProxyUrlError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ProxyUrlError::Empty);
    }
    if !trimmed.is_ascii() {
        return Err(ProxyUrlError::Encoding);
    }
    // 带协议头的地址先看协议名：socks 要单独给文案（混合端口的说法），不能笼统报「不支持」。
    if let Some((head, _)) = trimmed.split_once("://") {
        let head = head.to_ascii_lowercase();
        if head.starts_with("socks") {
            return Err(ProxyUrlError::Socks);
        }
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let parsed = Url::parse(&candidate).map_err(|_| ProxyUrlError::Host)?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(ProxyUrlError::Scheme(scheme));
    }
    let host = parsed
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or(ProxyUrlError::Host)?;

    let mut out = String::new();
    out.push_str(&scheme);
    out.push_str("://");
    if !parsed.username().is_empty() {
        out.push_str(parsed.username());
        if let Some(password) = parsed.password() {
            out.push(':');
            out.push_str(password);
        }
        out.push('@');
    }
    out.push_str(host);
    if let Some(port) = parsed.port() {
        out.push(':');
        out.push_str(&port.to_string());
    }
    Ok(out)
}

/// 系统代理探测的结果来源。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProxySource {
    /// 没探到（或者关着）。
    #[default]
    None,
    /// 来自环境变量（`https_proxy` / `HTTPS_PROXY` / `all_proxy` 等）。
    Env,
    /// 来自 Windows 的「Internet 选项 → 连接 → 局域网设置」。
    WindowsRegistry,
}

/// 系统代理探测结果：纯数据，由外壳填、核心库读。
///
/// 探测本身（读环境变量、`reg query`）必须在外壳做——核心库不碰系统 API，也不做 I/O。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SystemProxyProbe {
    /// 系统里配的代理地址（未归一化，可能是 `host:port` 这种省略协议的写法）。
    pub url: Option<String>,
    /// 系统里配的例外列表，原样保留（可能含 `*`、`.域名`、`<local>`、`host:port`）。
    pub bypass: Vec<String>,
    /// 这份结果从哪来，仅用于提示与测试断言。
    pub source: ProxySource,
}

impl SystemProxyProbe {
    /// 「什么都没探到」。
    pub fn none() -> Self {
        Self {
            url: None,
            bypass: Vec::new(),
            source: ProxySource::None,
        }
    }
}

/// 解析出的代理方案附带的提示，界面用来解释「为什么现在没走代理」。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ProxyNote {
    /// 正常：要么有代理，要么用户自己选了不走代理且不需要解释。
    #[default]
    None,
    /// 选了「跟随系统」，但系统里没探到代理。
    SystemNotDetected,
    /// 手动模式的地址不可用，带一句具体原因。
    ManualInvalid(String),
    /// 手动模式填的是 socks（要改填 http 混合端口）。
    ManualSocks,
    /// 用户选了「不走代理」。
    Off,
}

/// 代理方案：最终下发的地址、例外列表，以及给界面看的提示。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProxyResolution {
    /// `None` 表示不下发任何代理环境变量。
    pub url: Option<String>,
    /// 例外列表（已含系统里的那份，回环地址由 [`plan_env`] 兜底加在最前面）。
    pub bypass: Vec<String>,
    /// 界面提示。
    pub note: ProxyNote,
}

/// 按模式算出真正要用的代理。
///
/// - [`ProxyMode::System`]：用 [`SystemProxyProbe`] 探到的地址；探不到就静默直连并给提示。
/// - [`ProxyMode::Manual`]：用用户填的地址；不可用时不下发任何变量，只把原因放进提示。
/// - [`ProxyMode::Off`]：一个变量都不下发（连 `NO_PROXY` 也不下发，见 [`plan_env`]）。
///
/// 三种模式都保留系统里的例外列表：用户自己维护的 bypass 是他表达「这些别走代理」的方式，
/// 手动模式下也不该丢。
pub fn resolve_proxy(mode: ProxyMode, manual: &str, system: &SystemProxyProbe) -> ProxyResolution {
    let bypass = system.bypass.clone();
    match mode {
        ProxyMode::Off => ProxyResolution {
            url: None,
            bypass: Vec::new(),
            note: ProxyNote::Off,
        },
        ProxyMode::Manual => match normalize_proxy_url(manual) {
            Ok(url) => ProxyResolution {
                url: Some(url),
                bypass,
                note: ProxyNote::None,
            },
            Err(ProxyUrlError::Socks) => ProxyResolution {
                url: None,
                bypass,
                note: ProxyNote::ManualSocks,
            },
            Err(err) => ProxyResolution {
                url: None,
                bypass,
                note: ProxyNote::ManualInvalid(err.message()),
            },
        },
        ProxyMode::System => match system.url.as_deref().map(normalize_proxy_url) {
            Some(Ok(url)) => ProxyResolution {
                url: Some(url),
                bypass,
                note: ProxyNote::None,
            },
            _ => ProxyResolution {
                url: None,
                bypass,
                note: ProxyNote::SystemNotDetected,
            },
        },
    }
}

/// 这一组环境变量要下发给子进程；键值顺序稳定，方便断言。
///
/// 下载源与代理从同一个出口出：三条注入路径（版本查询、插件安装卸载、拉起的 DSH 进程）
/// 都拿这一份，不各拼一套。
///
/// 没有代理方案时只下发下载源；两个都没有就返回空 vec（调用点不做任何注入）。
/// 「不走代理」因此连 `NO_PROXY` 都不会出现——子进程环境里干干净净。
pub fn plan_env(registry: Option<&str>, proxy: &ProxyResolution) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(url) = registry {
        env.push((REGISTRY_ENV.to_string(), url.to_string()));
    }
    let Some(proxy_url) = proxy.url.as_deref() else {
        return env;
    };
    let exceptions = no_proxy_value(&proxy.bypass);
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
        env.push((key.to_string(), proxy_url.to_string()));
    }
    for key in ["NO_PROXY", "no_proxy"] {
        env.push((key.to_string(), exceptions.clone()));
    }
    for key in ["npm_config_proxy", "npm_config_https_proxy"] {
        env.push((key.to_string(), proxy_url.to_string()));
    }
    env.push(("npm_config_noproxy".to_string(), exceptions));
    env
}

/// 把提示翻译成界面那一行中文；正常情况（[`ProxyNote::None`]）返回 `None`，不占地方。
///
/// 文案集中在核心库：地址校验的即时提示（[`ProxyUrlError::message`]）与保存后的状态说明
/// 因此必然是同一句话，不会出现「输入框说 socks 不行、下面那行说别的」的错位。
pub fn note_text(note: &ProxyNote) -> Option<String> {
    match note {
        ProxyNote::None => None,
        ProxyNote::SystemNotDetected => {
            Some("跟随系统：系统里没检测到代理设置，请求直连。".to_string())
        }
        ProxyNote::ManualInvalid(message) => Some(message.clone()),
        ProxyNote::ManualSocks => Some(ProxyUrlError::Socks.message()),
        ProxyNote::Off => Some("不走代理：不向 DSH 下发任何代理环境变量。".to_string()),
    }
}

/// 界面「网络」卡代理段那一行说明：说清现在到底走没走代理、走的是哪个。
///
/// 与 [`note_text`] 的分工：`note_text` 只说「为什么没生效」，这里是**已生效**也要有一句
/// 确认（跟随系统时用户看不到系统里配了什么，不告诉他就会以为没起作用）。
pub fn status_hint(mode: ProxyMode, resolution: &ProxyResolution) -> String {
    let Some(url) = resolution.url.as_deref() else {
        // 没生效的三种理由都由 note 解释；Off 与 System 不可能同时为 None 且无提示。
        return note_text(&resolution.note)
            .unwrap_or_else(|| "当前没有启用代理，连接直连。".to_string());
    };
    let head = match mode {
        ProxyMode::Manual => format!("手动填写：DSH 与下载都走 {url}"),
        _ => format!("跟随系统：使用系统里配的代理 {url}"),
    };
    let tail = if resolution.bypass.is_empty() {
        String::new()
    } else {
        format!("，系统例外 {} 项一并直连", resolution.bypass.len())
    };
    format!("{head}；回环地址始终直连{tail}。")
}

/// 拼 `NO_PROXY` 的值：回环地址恒在最前，再接用户自己的例外列表（去重、保序）。
fn no_proxy_value(bypass: &[String]) -> String {
    let mut items: Vec<String> = Vec::new();
    for host in LOOPBACK_HOSTS {
        push_unique(&mut items, host);
    }
    for rule in bypass {
        let rule = rule.trim();
        if rule.is_empty() {
            continue;
        }
        push_unique(&mut items, rule);
    }
    items.join(",")
}

fn push_unique(items: &mut Vec<String>, value: &str) {
    let already = items
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(value));
    if !already {
        items.push(value.to_string());
    }
}

/// 解析 Windows「局域网设置」里的 `ProxyServer` 值。
///
/// 这个值有两种写法：
/// - `127.0.0.1:7890`：所有协议共用同一台代理；
/// - `http=127.0.0.1:7890;https=127.0.0.1:7890`：按协议分别配置。
///
/// 第二种写法里只取 http（优先）或 https 那一项：壳与 DSH 只认 http 代理变量，
/// 拿到 ftp/socks 的地址下发给子进程没有意义。都认不出就返回 `None`（当作没配代理）。
pub fn parse_windows_proxy_server(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.contains('=') {
        let mut http: Option<&str> = None;
        let mut https: Option<&str> = None;
        for item in raw.split(';') {
            let Some((scheme, value)) = item.split_once('=') else {
                continue;
            };
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            match scheme.trim().to_ascii_lowercase().as_str() {
                "http" if http.is_none() => http = Some(value),
                "https" if https.is_none() => https = Some(value),
                _ => {}
            }
        }
        return http.or(https).map(|value| value.to_string());
    }
    Some(raw.to_string())
}

/// 解析代理例外列表（分号或逗号分隔）。
///
/// 两种形态共用一份解析：环境变量里的 `no_proxy` 惯例用逗号，Windows 的
/// `ProxyOverride` 用分号；用户两种写法混着来也认。
///
/// 原样保留每一项（`*`、`.域名`、`host:port`、`<local>`），只做去空白与去空项：
/// 语义交给 [`bypass_matches`]，这里不替用户猜。
pub fn parse_exception_list(raw: &str) -> Vec<String> {
    raw.split([';', ','])
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(|item| item.to_string())
        .collect()
}

/// 解析 `reg query` 读回来的 DWORD（`REG_DWORD` 那列形如 `0x1`，也可能是十进制）。
/// 认不出的一律当「没开」，避免把读不懂的值当成「代理开着」而去读一个空地址。
pub fn parse_reg_dword(raw: &str) -> Option<u32> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    match raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        Some(hex) => u32::from_str_radix(hex, 16).ok(),
        None => raw.parse::<u32>().ok(),
    }
}

/// 回环地址判定：这些地址在任何模式下都直连。
pub fn is_loopback(host: &str) -> bool {
    let host = strip_brackets(host.trim());
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    if LOOPBACK_HOSTS.contains(&host.as_str()) {
        return true;
    }
    // 127.0.0.0/8 整段都是回环。
    match host.strip_prefix("127.") {
        Some(rest) => rest
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit())),
        None => false,
    }
}

/// 例外列表是否命中这个主机（可带端口）。
///
/// 认的写法：`*`（全放行）、`example.com` / `.example.com` / `*.example.com`（该域名及其
/// 子域）、`host:port`（限定端口才命中）、`<local>`（Windows 的「不使用代理服务器」里
/// 表示不含点的主机名）。规则来自用户系统设置，写得糙很正常，认不出的一律当不命中。
pub fn bypass_matches(host: &str, port: Option<u16>, rules: &[String]) -> bool {
    let host = {
        let stripped = strip_brackets(host.trim());
        stripped.trim_end_matches('.').to_ascii_lowercase()
    };
    if host.is_empty() {
        return false;
    }
    // 回环地址恒直连，不看规则。
    if is_loopback(&host) {
        return true;
    }
    rules
        .iter()
        .any(|rule| rule_matches_host(&host, port, rule))
}

fn rule_matches_host(host: &str, port: Option<u16>, rule: &str) -> bool {
    let rule = rule.trim();
    if rule.is_empty() {
        return false;
    }
    let rule = rule.to_ascii_lowercase();
    if rule == "*" {
        return true;
    }
    if rule == "<local>" {
        return !host.contains('.') && host.parse::<std::net::IpAddr>().is_err();
    }
    let (target, rule_port) = split_rule_port(&rule);
    if let Some(wanted) = rule_port {
        match port {
            Some(actual) if actual == wanted => {}
            _ => return false,
        }
    }
    let target = {
        let stripped = strip_brackets(target.trim());
        stripped.trim_start_matches('*').trim_start_matches('.')
    };
    if target.is_empty() {
        return true;
    }
    host == target || host.ends_with(&format!(".{target}"))
}

/// 规则里的端口：只有「最后一个冒号后面全是数字、前面确实是主机」时才当端口，
/// 免得把 IPv6 的 `::1` 拆错。
fn split_rule_port(rule: &str) -> (String, Option<u16>) {
    let Some(index) = rule.rfind(':') else {
        return (rule.to_string(), None);
    };
    let (head, tail) = rule.split_at(index);
    let digits = &tail[1..];
    let numeric =
        !digits.is_empty() && digits.len() <= 5 && digits.chars().all(|c| c.is_ascii_digit());
    let head_is_host = (head.starts_with('[') && head.ends_with(']')) || !head.contains(':');
    if numeric && head_is_host {
        if let Ok(port) = digits.parse::<u16>() {
            return (head.to_string(), Some(port));
        }
    }
    (rule.to_string(), None)
}

fn strip_brackets(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(url: &str, bypass: &[&str], source: ProxySource) -> SystemProxyProbe {
        SystemProxyProbe {
            url: Some(url.to_string()),
            bypass: bypass.iter().map(|item| item.to_string()).collect(),
            source,
        }
    }

    fn system(url: &str) -> ProxyResolution {
        resolve_proxy(
            ProxyMode::System,
            "",
            &probe(url, &[], ProxySource::WindowsRegistry),
        )
    }

    // ---- 下载源（原有行为，不能破） ----

    #[test]
    fn inherit_sends_no_registry_at_all() {
        // 验收标准：选「沿用」时不下发 registry，行为等同于没有这项功能。
        assert_eq!(registry_of(DownloadSource::Inherit), None);
        assert!(registry_env(DownloadSource::Inherit).is_empty());
    }

    #[test]
    fn mirror_and_official_point_at_their_own_registries() {
        assert_eq!(
            registry_of(DownloadSource::Mirror),
            Some("https://registry.npmmirror.com")
        );
        assert_eq!(
            registry_of(DownloadSource::Official),
            Some("https://registry.npmjs.org")
        );
    }

    #[test]
    fn env_carries_one_key_with_the_source_url() {
        // 键名是界面与外壳之间的契约（npm 认这个名字），写死在这里防漂移。
        assert_eq!(
            registry_env(DownloadSource::Mirror),
            vec![(
                "npm_config_registry".to_string(),
                MIRROR_REGISTRY.to_string()
            )]
        );
        assert_eq!(
            registry_env(DownloadSource::Official),
            vec![(
                "npm_config_registry".to_string(),
                OFFICIAL_REGISTRY.to_string()
            )]
        );
        assert_eq!(REGISTRY_ENV, "npm_config_registry");
    }

    #[test]
    fn addresses_are_plain_https_urls_without_spaces() {
        // WSL 分支把键值拼成 `env K=V` 的单个 argv：值里不能有空格，否则 wsl.exe 会把
        // 它拆成两段。地址是写死的常量，这里把约束钉在测试里。
        for url in [MIRROR_REGISTRY, OFFICIAL_REGISTRY] {
            assert!(url.starts_with("https://"), "{url}");
            assert!(!url.contains(char::is_whitespace), "{url}");
            assert!(!url.ends_with('/'), "{url} 不该带尾斜杠");
        }
    }

    // ---- 地址归一化 ----

    #[test]
    fn bare_host_and_port_get_http_prefixed() {
        // 用户最常这么填，不能要求他手写协议。
        assert_eq!(
            normalize_proxy_url("127.0.0.1:7890").unwrap(),
            "http://127.0.0.1:7890"
        );
        assert_eq!(
            normalize_proxy_url("  localhost:8080  ").unwrap(),
            "http://localhost:8080"
        );
    }

    #[test]
    fn path_and_query_are_dropped_but_credentials_kept() {
        assert_eq!(
            normalize_proxy_url("https://127.0.0.1:7890/pac?x=1").unwrap(),
            "https://127.0.0.1:7890"
        );
        assert_eq!(
            normalize_proxy_url("http://user:secret@127.0.0.1:7890/").unwrap(),
            "http://user:secret@127.0.0.1:7890"
        );
    }

    #[test]
    fn empty_address_is_its_own_error_with_a_format_example() {
        let err = normalize_proxy_url("   ").unwrap_err();
        assert_eq!(err, ProxyUrlError::Empty);
        assert!(err.message().contains("http://127.0.0.1:7890"), "{err}");
    }

    #[test]
    fn socks_addresses_get_the_mixed_port_wording() {
        // 验收标准：以 socks 开头的地址给专门的混合端口文案，不是笼统的「不支持」。
        for raw in [
            "socks5://127.0.0.1:1080",
            "socks://127.0.0.1:1080",
            "SOCKS4://1.2.3.4:1080",
        ] {
            let err = normalize_proxy_url(raw).unwrap_err();
            assert_eq!(err, ProxyUrlError::Socks, "{raw}");
            assert!(err.message().contains("http 混合端口"), "{raw}");
        }
        // 主机名里恰好带 socks 不该被误判。
        assert_eq!(
            normalize_proxy_url("socksproxy.corp:8080").unwrap(),
            "http://socksproxy.corp:8080"
        );
    }

    #[test]
    fn non_http_schemes_are_rejected() {
        let err = normalize_proxy_url("ftp://127.0.0.1:21").unwrap_err();
        assert_eq!(err, ProxyUrlError::Scheme("ftp".to_string()));
        assert!(err.message().contains("ftp://"), "{err}");
    }

    #[test]
    fn non_ascii_input_is_rejected_instead_of_punycoded() {
        assert_eq!(
            normalize_proxy_url("http://代理.local:7890").unwrap_err(),
            ProxyUrlError::Encoding
        );
        // 全角冒号是最常见的手误。
        assert_eq!(
            normalize_proxy_url("127.0.0.1：7890").unwrap_err(),
            ProxyUrlError::Encoding
        );
        assert!(ProxyUrlError::Encoding
            .message()
            .contains("http://127.0.0.1:7890"));
    }

    #[test]
    fn addresses_without_a_host_are_rejected() {
        assert_eq!(
            normalize_proxy_url("http://").unwrap_err(),
            ProxyUrlError::Host
        );
        assert!(ProxyUrlError::Host
            .message()
            .contains("http://127.0.0.1:7890"));
    }

    // ---- 回环与例外列表 ----

    // ---- 注册表值的解析（外壳负责读取，这里只管认） ----

    #[test]
    fn windows_proxy_server_handles_both_shapes() {
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:7890").as_deref(),
            Some("127.0.0.1:7890")
        );
        // 分协议写法：http 优先，其次 https；ftp/socks 那几项不下发。
        assert_eq!(
            parse_windows_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7891;ftp=10.0.0.1:21")
                .as_deref(),
            Some("127.0.0.1:7890")
        );
        assert_eq!(
            parse_windows_proxy_server("https=127.0.0.1:7891;ftp=10.0.0.1:21").as_deref(),
            Some("127.0.0.1:7891")
        );
        assert_eq!(parse_windows_proxy_server("  "), None);
        assert_eq!(parse_windows_proxy_server("ftp=10.0.0.1:21"), None);
        // 读出来的值可能带协议头，归一化交给 normalize_proxy_url。
        assert_eq!(
            normalize_proxy_url(
                parse_windows_proxy_server("127.0.0.1:7890")
                    .as_deref()
                    .unwrap()
            )
            .unwrap(),
            "http://127.0.0.1:7890"
        );
    }

    #[test]
    fn exception_list_is_split_and_trimmed() {
        assert_eq!(
            parse_exception_list("*.corp.example; 10.* ;<local>;;"),
            vec!["*.corp.example", "10.*", "<local>"]
        );
        // 环境变量的 no_proxy 惯例用逗号。
        assert_eq!(
            parse_exception_list("localhost,127.0.0.1, ::1"),
            vec!["localhost", "127.0.0.1", "::1"]
        );
        assert!(parse_exception_list("").is_empty());
        // 解析出来的列表直接能喂给 bypass_matches。
        let rules = parse_exception_list("*.corp.example;<local>");
        assert!(bypass_matches("api.corp.example", None, &rules));
    }

    #[test]
    fn reg_dword_is_read_in_either_notation() {
        assert_eq!(parse_reg_dword("0x1"), Some(1));
        assert_eq!(parse_reg_dword("0x0"), Some(0));
        assert_eq!(parse_reg_dword("1"), Some(1));
        assert_eq!(parse_reg_dword("乱写的"), None);
        assert_eq!(parse_reg_dword(""), None);
    }

    #[test]
    fn loopback_hosts_cover_localhost_and_the_whole_127_range() {
        for host in [
            "localhost",
            "LOCALHOST",
            "127.0.0.1",
            "127.1.2.3",
            "::1",
            "[::1]",
        ] {
            assert!(is_loopback(host), "{host}");
        }
        for host in [
            "10.0.0.1",
            "example.com",
            "1270.0.0.1",
            "",
            "localhost.example.com",
        ] {
            assert!(!is_loopback(host), "{host}");
        }
    }

    #[test]
    fn bypass_matches_domains_wildcards_and_ports() {
        let rules: Vec<String> = ["*.corp.example", ".lan", "intranet", "10.1.2.3:8080"]
            .iter()
            .map(|item| item.to_string())
            .collect();
        assert!(bypass_matches("corp.example", None, &rules));
        assert!(bypass_matches("api.corp.example", None, &rules));
        assert!(bypass_matches("files.lan", None, &rules));
        assert!(bypass_matches("intranet", None, &rules));
        assert!(!bypass_matches("notintranet", None, &rules));
        assert!(!bypass_matches("example.com", None, &rules));
        // 带端口的规则只有端口对得上才命中。
        assert!(bypass_matches("10.1.2.3", Some(8080), &rules));
        assert!(!bypass_matches("10.1.2.3", Some(9090), &rules));
        assert!(!bypass_matches("10.1.2.3", None, &rules));
    }

    #[test]
    fn bypass_understands_the_windows_local_token_and_star() {
        let rules = vec!["<local>".to_string()];
        assert!(bypass_matches("intranet", None, &rules));
        assert!(!bypass_matches("intranet.example", None, &rules));
        assert!(bypass_matches("anything.example", None, &["*".to_string()]));
        // 回环恒命中，不看规则是否写得对。
        assert!(bypass_matches("127.0.0.1", Some(1), &[]));
    }

    // ---- 三种模式 ----

    #[test]
    fn system_mode_uses_the_detected_proxy_and_keeps_bypass() {
        let system = probe(
            "127.0.0.1:7890",
            &["*.corp.example", "10.0.0.0/8"],
            ProxySource::WindowsRegistry,
        );
        let resolved = resolve_proxy(ProxyMode::System, "ignored:1", &system);
        assert_eq!(resolved.url.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(resolved.note, ProxyNote::None);
        assert_eq!(resolved.bypass, system.bypass);
    }

    #[test]
    fn system_mode_without_a_proxy_detects_nothing_and_sends_nothing() {
        let resolved = resolve_proxy(ProxyMode::System, "", &SystemProxyProbe::none());
        assert_eq!(resolved.url, None);
        assert_eq!(resolved.note, ProxyNote::SystemNotDetected);
        assert!(plan_env(Some(MIRROR_REGISTRY), &resolved)
            .iter()
            .all(|(key, _)| key == REGISTRY_ENV));
        // 系统里只配了 socks 时同样算没探到（下发的变量只会是 http 代理）。
        let socks_only = probe("socks5://127.0.0.1:1080", &[], ProxySource::Env);
        assert_eq!(
            resolve_proxy(ProxyMode::System, "", &socks_only).note,
            ProxyNote::SystemNotDetected
        );
    }

    #[test]
    fn manual_mode_reports_the_specific_problem_and_ignores_the_system_proxy() {
        let system = probe("127.0.0.1:7890", &["*.corp.example"], ProxySource::Env);
        let bad = resolve_proxy(ProxyMode::Manual, "not a url", &system);
        assert_eq!(bad.url, None);
        assert!(matches!(bad.note, ProxyNote::ManualInvalid(_)));
        let ProxyNote::ManualInvalid(message) = &bad.note else {
            unreachable!()
        };
        assert!(message.contains("http://127.0.0.1:7890"), "{message}");
        // 手动模式也不丢系统里的例外列表。
        assert_eq!(bad.bypass, system.bypass);

        let socks = resolve_proxy(ProxyMode::Manual, "socks5://127.0.0.1:1080", &system);
        assert_eq!(socks.note, ProxyNote::ManualSocks);
        assert_eq!(socks.url, None);

        let good = resolve_proxy(ProxyMode::Manual, "192.168.1.9:3128", &system);
        assert_eq!(good.url.as_deref(), Some("http://192.168.1.9:3128"));
        assert_eq!(good.note, ProxyNote::None);
    }

    #[test]
    fn off_mode_sends_no_proxy_variable_at_all() {
        let system = probe("127.0.0.1:7890", &["*.corp.example"], ProxySource::Env);
        let resolved = resolve_proxy(ProxyMode::Off, "192.168.1.9:3128", &system);
        assert_eq!(resolved.url, None);
        assert_eq!(resolved.note, ProxyNote::Off);
        assert!(resolved.bypass.is_empty());
        // 验收标准：不走代理时子进程环境里没有任何代理变量。
        let env = plan_env(Some(OFFICIAL_REGISTRY), &resolved);
        assert_eq!(
            env,
            vec![(REGISTRY_ENV.to_string(), OFFICIAL_REGISTRY.to_string())]
        );
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "npm_config_proxy"] {
            assert!(!env.iter().any(|(name, _)| name == key), "{key}");
        }
    }

    // ---- 注入计划 ----

    #[test]
    fn plan_env_lists_registry_then_proxy_in_a_stable_order() {
        let resolved = system("127.0.0.1:7890");
        let env = plan_env(Some(MIRROR_REGISTRY), &resolved);
        let keys: Vec<&str> = env.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                "npm_config_registry",
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "http_proxy",
                "https_proxy",
                "NO_PROXY",
                "no_proxy",
                "npm_config_proxy",
                "npm_config_https_proxy",
                "npm_config_noproxy",
            ]
        );
        // 大小写两套与 npm 自己的两套变量都要有：不同工具认不同的写法。
        for (key, value) in &env {
            if key == REGISTRY_ENV {
                assert_eq!(value, MIRROR_REGISTRY);
            } else if key.to_ascii_uppercase().contains("NOPROXY")
                || key.starts_with("no_proxy")
                || key == "NO_PROXY"
            {
                assert!(
                    value.starts_with("localhost,127.0.0.1,::1"),
                    "{key}={value}"
                );
            } else {
                assert_eq!(value, "http://127.0.0.1:7890", "{key}");
            }
        }
    }

    #[test]
    fn no_proxy_starts_with_loopback_then_the_user_list() {
        let system = probe(
            "127.0.0.1:7890",
            &["*.corp.example", "", "localhost", "10.1.2.3:8080"],
            ProxySource::WindowsRegistry,
        );
        let resolved = resolve_proxy(ProxyMode::System, "", &system);
        let env = plan_env(None, &resolved);
        let value = env
            .iter()
            .find(|(key, _)| key == "NO_PROXY")
            .map(|(_, value)| value.clone())
            .unwrap();
        // 回环恒在最前；重复的 localhost 不重复出现；空项被丢掉。
        assert_eq!(
            value,
            "localhost,127.0.0.1,::1,*.corp.example,10.1.2.3:8080"
        );
        assert_eq!(
            env.iter()
                .find(|(key, _)| key == "npm_config_noproxy")
                .map(|(_, value)| value.as_str()),
            Some(value.as_str())
        );
    }

    // ---- 提示文案 ----

    #[test]
    fn note_text_explains_each_state_in_chinese() {
        // 一切正常时界面不需要额外解释。
        assert_eq!(note_text(&ProxyNote::None), None);
        assert!(note_text(&ProxyNote::SystemNotDetected)
            .unwrap()
            .contains("没检测到代理"));
        assert_eq!(
            note_text(&ProxyNote::ManualSocks).unwrap(),
            ProxyUrlError::Socks.message()
        );
        let invalid = note_text(&ProxyNote::ManualInvalid(ProxyUrlError::Host.message())).unwrap();
        assert!(invalid.contains("形如 http://127.0.0.1:7890"), "{invalid}");
        assert!(note_text(&ProxyNote::Off).unwrap().contains("不走代理"));
        // 界面显示的必须就是 resolve_proxy 产出的这一句，不另拼一套说法。
        let resolved = resolve_proxy(ProxyMode::Manual, "随便写的", &SystemProxyProbe::none());
        assert_eq!(
            note_text(&resolved.note),
            Some(ProxyUrlError::Encoding.message())
        );
        // 地址校验的即时提示与保存后的提示同源：都是 ProxyUrlError 的文案。
        assert_eq!(
            normalize_proxy_url("随便写的")
                .err()
                .map(|err| err.message()),
            note_text(&resolved.note)
        );
    }

    #[test]
    fn status_hint_confirms_what_actually_happens() {
        let working = probe("127.0.0.1:7890", &["*.corp.example"], ProxySource::Env);
        let system = resolve_proxy(ProxyMode::System, "", &working);
        let line = status_hint(ProxyMode::System, &system);
        assert!(
            line.starts_with("跟随系统：使用系统里配的代理 http://127.0.0.1:7890"),
            "{line}"
        );
        assert!(line.contains("回环地址始终直连"), "{line}");
        assert!(line.contains("系统例外 1 项"), "{line}");

        let manual = resolve_proxy(
            ProxyMode::Manual,
            "192.168.1.9:3128",
            &SystemProxyProbe::none(),
        );
        let line = status_hint(ProxyMode::Manual, &manual);
        assert!(
            line.starts_with("手动填写：DSH 与下载都走 http://192.168.1.9:3128"),
            "{line}"
        );
        assert!(!line.contains("系统例外"), "{line}");

        // 没生效时这一行就是 note_text 的那句原因，不再另拼。
        let none = resolve_proxy(ProxyMode::System, "", &SystemProxyProbe::none());
        assert_eq!(
            status_hint(ProxyMode::System, &none),
            note_text(&ProxyNote::SystemNotDetected).unwrap()
        );
        let off = resolve_proxy(ProxyMode::Off, "", &working);
        assert_eq!(
            status_hint(ProxyMode::Off, &off),
            note_text(&ProxyNote::Off).unwrap()
        );
        let bad = resolve_proxy(ProxyMode::Manual, "socks5://127.0.0.1:1080", &working);
        assert_eq!(
            status_hint(ProxyMode::Manual, &bad),
            ProxyUrlError::Socks.message()
        );
    }

    #[test]
    fn injecting_nothing_yields_an_empty_plan() {
        // 「沿用 npm 全局配置」+「不走代理」时不做任何注入，子进程读自己的配置。
        let resolved = resolve_proxy(ProxyMode::Off, "", &SystemProxyProbe::none());
        assert!(plan_env(None, &resolved).is_empty());
    }

    #[test]
    fn planned_values_have_no_whitespace_for_the_wsl_env_argv() {
        // WSL 分支把键值拼成 `env K=V` 的单个 argv，值里有空格就会被拆开。
        let system = probe("127.0.0.1:7890", &["*.corp.example"], ProxySource::Env);
        let resolved = resolve_proxy(ProxyMode::System, "", &system);
        for (key, value) in plan_env(Some(MIRROR_REGISTRY), &resolved) {
            assert!(!value.contains(char::is_whitespace), "{key}={value}");
            assert!(!key.contains(char::is_whitespace), "{key}");
        }
    }
}
