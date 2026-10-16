//! DSH 界面窗口的链接策略：站内跳转留在窗口里，站外交系统默认浏览器。
//!
//! 判定放在核心库，是因为它全是可以枚举的地址边界（端口、`localhost` 与
//! `127.0.0.1` 的等价、IPv6 回环、协议不同、`about:`/`blob:` 这类 WebView
//! 内部导航），开发机 `cargo test` 就能全跑完；外壳那边只剩「取消导航 +
//! 交给系统」这一个副作用。

use url::Url;

/// 一次导航该去哪儿。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
    /// 留在 DSH 窗口里（站内跳转、WebView 自身的内部导航）。
    Stay,
    /// 交系统默认浏览器打开（站外链接、`mailto:` 之类）。
    OpenExternal,
}

/// 判定 DSH 窗口里的一次导航：`internal` 是本次登录链接（站内基准），
/// `target` 是导航目标。
pub fn navigation_decision(internal: &Url, target: &Url) -> NavigationDecision {
    match target.scheme() {
        "http" | "https" => {
            if same_site(internal, target) {
                NavigationDecision::Stay
            } else {
                NavigationDecision::OpenExternal
            }
        }
        // WebView2 的内部导航与页面自造的资源 URL：留在窗口，取消它们会把 WebView 弄坏。
        "about" | "blob" | "data" | "file" => NavigationDecision::Stay,
        // `mailto:` / `tel:` 交系统处理，走与站外链接同一条路。
        _ => NavigationDecision::OpenExternal,
    }
}

/// 站内判定：同源，或同为回环地址且协议、端口一致。
///
/// 后一条是必需的：DSH 打印的登录链接与页面里自造的绝对链接可能一边写
/// `127.0.0.1`、一边写 `localhost`，把这种组合当站外会让站内跳转被丢进浏览器。
fn same_site(internal: &Url, target: &Url) -> bool {
    if internal.origin() == target.origin() {
        return true;
    }
    internal.scheme() == target.scheme()
        && internal.port() == target.port()
        && is_loopback(internal)
        && is_loopback(target)
}

/// 回环地址判定（`localhost` / `127.0.0.0/8` / `[::1]`）。
fn is_loopback(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    // IPv6 的 host_str 带方括号（`[::1]`）。
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn same_origin_stays_in_window() {
        let internal = url("http://127.0.0.1:3080/?token=abc");
        assert_eq!(
            navigation_decision(&internal, &url("http://127.0.0.1:3080/chat")),
            NavigationDecision::Stay
        );
    }

    #[test]
    fn localhost_and_loopback_ip_count_as_one_site() {
        let internal = url("http://127.0.0.1:3080/");
        assert_eq!(
            navigation_decision(&internal, &url("http://localhost:3080/chat")),
            NavigationDecision::Stay
        );
        assert_eq!(
            navigation_decision(
                &url("http://localhost:3080/"),
                &url("http://127.0.0.1:3080/")
            ),
            NavigationDecision::Stay
        );
        // IPv6 回环：host_str 会带方括号。
        assert_eq!(
            navigation_decision(&internal, &url("http://[::1]:3080/")),
            NavigationDecision::Stay
        );
    }

    #[test]
    fn other_port_or_scheme_goes_out() {
        let internal = url("http://127.0.0.1:3080/");
        assert_eq!(
            navigation_decision(&internal, &url("http://127.0.0.1:5173/")),
            NavigationDecision::OpenExternal
        );
        assert_eq!(
            navigation_decision(&internal, &url("https://127.0.0.1:3080/")),
            NavigationDecision::OpenExternal
        );
    }

    #[test]
    fn external_hosts_go_out() {
        let internal = url("http://127.0.0.1:3080/");
        assert_eq!(
            navigation_decision(&internal, &url("https://github.com/BoxMiao007/dsharbor")),
            NavigationDecision::OpenExternal
        );
        // 名字里带 localhost 但不是回环地址，不能算站内。
        assert_eq!(
            navigation_decision(&internal, &url("http://localhost.example.com:3080/")),
            NavigationDecision::OpenExternal
        );
        // 整个 127.0.0.0/8 都算回环：同协议同端口即视为同一站点（真的连不上时
        // 由连接结果体现，不在这里拦）。
        assert_eq!(
            navigation_decision(&internal, &url("http://127.0.0.2:3080/")),
            NavigationDecision::Stay
        );
    }

    #[test]
    fn webview_internal_schemes_stay() {
        let internal = url("http://127.0.0.1:3080/");
        for target in [
            "about:blank",
            "blob:http://127.0.0.1:3080/9f1c",
            "data:text/plain,hi",
            "file:///C:/docs/x.txt",
        ] {
            assert_eq!(
                navigation_decision(&internal, &url(target)),
                NavigationDecision::Stay,
                "{target}"
            );
        }
    }

    #[test]
    fn non_browser_schemes_go_out() {
        let internal = url("http://127.0.0.1:3080/");
        for target in ["mailto:a@b.c", "tel:+123456"] {
            assert_eq!(
                navigation_decision(&internal, &url(target)),
                NavigationDecision::OpenExternal,
                "{target}"
            );
        }
    }

    #[test]
    fn loopback_recognizes_only_real_loopback_hosts() {
        for host in [
            "http://localhost/",
            "http://127.0.0.1/",
            "http://127.0.0.2/",
            "http://[::1]/",
        ] {
            assert!(is_loopback(&url(host)), "{host}");
        }
        for host in [
            "http://localhost.example.com/",
            "http://10.0.0.1/",
            "http://192.168.1.5/",
            "mailto:a@b.c",
        ] {
            assert!(!is_loopback(&url(host)), "{host}");
        }
    }
}
