//! DSH Web 的访问端点（host + port），核心库纯逻辑。
//!
//! 为什么单独抽出来：DSH 的 webserver 可以绑在具体网卡 IP 上（局域网访问），
//! 也可以绑回环。壳要探测「端口上是不是已经有 DSH」、要连桥接插件取登录链接，
//! 都得用**实际在听的那个地址**——写死 127.0.0.1 会在 LAN 绑定时全程连不上
//! （实测 DSH 0.2.1-rc.2 + host 192.168.1.7：探测误判端口空闲、桥接降级成日志兜底）。
//!
//! 边界：DSH 0.2.1-rc.2 起拒绝通配地址（0.0.0.0 / ::）与主机名，只收具体 IP
//! 字面量。遇到这种配置（多为旧版插件留下的）一律退回升配回环——那是唯一
//! 能确定连得上的地址。

use std::fmt;

/// 一个可连接的 HTTP 端点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

impl Endpoint {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
        }
    }

    pub fn loopback(port: u16) -> Self {
        Self::new(LOOPBACK, port)
    }

    /// 用于 HTTP `Host:` 头与错误文案的 `host:port`（IPv6 自动加方括号）。
    pub fn authority(&self) -> String {
        match self.host.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V6(addr)) => format!("[{addr}]:{}", self.port),
            _ => format!("{}:{}", self.host, self.port),
        }
    }
}

impl fmt::Display for Endpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.authority())
    }
}

pub const LOOPBACK: &str = "127.0.0.1";

/// 是否是通配绑定（`0.0.0.0` / `::`，意为「所有网卡」）。
///
/// 单列出来是因为通配地址有两副面孔：DSH 0.2.1-rc.2 起直接拒绝它（配置和
/// `--host` 都一样），而老版本的 profile 里到处是它。壳需要区别对待：
/// 探测时换成具体网卡地址、生成端口覆盖层时换成具体网卡地址，都不能照抄。
pub fn is_wildcard(host: &str) -> bool {
    host.trim()
        .parse::<std::net::IpAddr>()
        .map(|addr| addr.is_unspecified())
        .unwrap_or(false)
}

/// 本机第一块网卡的 IPv4（用于把通配绑定变成能连的地址）。
///
/// 用一个绑在 `0.0.0.0:0` 的 UDP socket「连」到一个保留地址，让系统按路由表
/// 选出出口网卡——UDP connect 不发任何包，断网时也能立即返回。取不到就返回 None
/// （调用方退回回环）。
pub fn primary_local_ipv4() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // 192.0.2.0/24 是 TEST-NET-1，永远不是真实目的地址，这里只借它选路。
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    Some(ip.to_string())
}

/// 把 profile 里写的 host 归一成「壳能连的地址」。
///
/// - WSL 目标：Windows 侧只能通过 localhost 转发访问发行版内的回环监听，固定回环。
/// - 没配 / 通配地址 / 主机名（DSH 会拒绝，且我们无法确定解析结果）：回环。
/// - 具体 IP 字面量：原样使用（IPv6 去掉可能的 zone 与 `::ffff:` 前缀）。
pub fn resolve_host(configured: Option<&str>, via_wsl: bool) -> String {
    if via_wsl {
        return LOOPBACK.to_string();
    }
    let Some(raw) = configured.map(str::trim).filter(|v| !v.is_empty()) else {
        return LOOPBACK.to_string();
    };
    let Ok(addr) = raw.parse::<std::net::IpAddr>() else {
        // 主机名（含 `localhost`）不作数：DSH 本身就不接受，壳也不猜解析结果。
        return LOOPBACK.to_string();
    };
    if addr.is_unspecified() {
        return LOOPBACK.to_string();
    }
    match addr {
        // IPv4 映射的 IPv6（::ffff:192.168.1.7）按 IPv4 走，服务端多半就是这么报的。
        std::net::IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => v6.to_string(),
        },
        std::net::IpAddr::V4(v4) => v4.to_string(),
    }
}

/// 通配绑定（`0.0.0.0` / `::`）时壳该连哪个地址：本机网卡 IP，取不到再退回回环。
///
/// 与 `resolve_host` 分开是因为这条要探网卡（带 IO），而 `resolve_host` 保持纯函数。
/// 为什么值得多这一步：老版本 DSH 与第三方插件（remote-web-ui）常把 host 写成
/// `0.0.0.0` 表示「所有网卡」；此时 DSH 实际在每块网卡上都能连通，用回环探测
/// 只能验证「壳本机能连」，而用网卡 IP 探测才与用户实际访问的地址一致。
/// 端口覆盖层也用这个结果，避免把 `0.0.0.0` 交给新版 DSH（它会直接拒绝并起不来）。
pub fn resolve_reachable_host(configured: Option<&str>, via_wsl: bool) -> String {
    if !via_wsl && configured.map(is_wildcard).unwrap_or(false) {
        if let Some(ip) = primary_local_ipv4() {
            return ip;
        }
    }
    resolve_host(configured, via_wsl)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_concrete_lan_address() {
        assert_eq!(resolve_host(Some("192.168.1.7"), false), "192.168.1.7");
    }

    #[test]
    fn wildcard_falls_back_to_loopback() {
        assert_eq!(resolve_host(Some("0.0.0.0"), false), LOOPBACK);
        assert_eq!(resolve_host(Some("::"), false), LOOPBACK);
    }

    #[test]
    fn missing_or_named_host_falls_back_to_loopback() {
        assert_eq!(resolve_host(None, false), LOOPBACK);
        assert_eq!(resolve_host(Some(""), false), LOOPBACK);
        assert_eq!(resolve_host(Some("localhost"), false), LOOPBACK);
        assert_eq!(resolve_host(Some("my-box.local"), false), LOOPBACK);
    }

    #[test]
    fn wsl_target_forces_loopback() {
        assert_eq!(resolve_host(Some("192.168.1.7"), true), LOOPBACK);
    }

    #[test]
    fn ipv6_mapped_is_reduced_to_ipv4() {
        assert_eq!(resolve_host(Some("::ffff:127.0.0.1"), false), LOOPBACK);
        assert_eq!(resolve_host(Some("::1"), false), "::1");
    }

    #[test]
    fn wildcard_is_recognized() {
        assert!(is_wildcard("0.0.0.0"));
        assert!(is_wildcard("::"));
        assert!(is_wildcard(" 0.0.0.0 "));
        assert!(!is_wildcard("127.0.0.1"));
        assert!(!is_wildcard("192.168.1.7"));
        assert!(!is_wildcard("localhost"));
        assert!(!is_wildcard(""));
    }

    #[test]
    fn reachable_host_matches_resolve_host_off_wildcard() {
        // 非通配配置不必探网卡：结果应与纯函数完全一致。
        assert_eq!(
            resolve_reachable_host(Some("192.168.1.7"), false),
            resolve_host(Some("192.168.1.7"), false)
        );
        assert_eq!(
            resolve_reachable_host(Some("localhost"), false),
            resolve_host(Some("localhost"), false)
        );
        assert_eq!(
            resolve_reachable_host(None, false),
            resolve_host(None, false)
        );
    }

    #[test]
    fn reachable_host_never_keeps_wildcard() {
        // 通配地址绝不能原样交出去（DSH 会拒绝、探测也连不上）。
        for via_wsl in [false, true] {
            let host = resolve_reachable_host(Some("0.0.0.0"), via_wsl);
            assert!(!is_wildcard(&host), "通配地址未归一：{host}");
            assert!(!host.is_empty());
        }
    }

    #[test]
    fn authority_brackets_ipv6() {
        assert_eq!(Endpoint::loopback(3080).authority(), "127.0.0.1:3080");
        assert_eq!(Endpoint::new("::1", 3080).authority(), "[::1]:3080");
    }
}
