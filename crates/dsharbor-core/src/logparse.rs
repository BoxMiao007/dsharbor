//! 日志兜底通道：从 DSH 启动日志里解析带 token 的登录链接公告。
//!
//! `dsh web` 启动时（@deepseek-ai/dsh-web-app 的 announce）打印：
//! `dsh web: http://127.0.0.1:3080/?token=<token> (LAN: http://192.168.1.8:3080/?token=<token>)`
//!
//! 这是**兜底**通道：公告格式属 DSH 实现细节、官方没有稳定性承诺，日志格式
//! 一变就会失效。首选通道是桥接插件（`/dsharbor-bridge/url`），本模块只在
//! 桥接不可用时使用，并且实现与 IO 完全解耦（输入一行文本、输出结构化结果），
//! 便于用真实样本做回归测试。

/// 一条登录链接公告。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Announcement {
    /// 本机登录链接（127.0.0.1），URL 已带 `?token=`。
    pub local_url: String,
    /// LAN 登录链接（webserver 绑定 0.0.0.0 时才有），URL 已带 `?token=`。
    pub lan_url: Option<String>,
}

const MARKER: &str = "dsh web: ";
const LAN_PREFIX: &str = " (LAN: ";

/// 解析一行日志；命中返回公告，未命中返回 None。
///
/// 宽容处理：ANSI 颜色码、行首时间戳等噪音都不影响命中；LAN 段括号缺失时
/// 只返回本机链接（格式漂移时尽量还能用）。
pub fn parse_announcement(line: &str) -> Option<Announcement> {
    let cleaned = strip_ansi(line);
    let start = cleaned.find(MARKER)?;
    let rest = cleaned[start + MARKER.len()..].trim();
    match rest.find(LAN_PREFIX) {
        Some(pos) => {
            let local = sanitize_url(&rest[..pos])?;
            let after = &rest[pos + LAN_PREFIX.len()..];
            let lan = match after.find(')') {
                Some(end) => sanitize_url(&after[..end]),
                None => None,
            };
            Some(Announcement {
                local_url: local,
                lan_url: lan,
            })
        }
        None => Some(Announcement {
            local_url: sanitize_url(rest)?,
            lan_url: None,
        }),
    }
}

/// 从一段文本里取 URL：截断到第一个空白，去掉行尾标点，校验 http(s) 前缀。
fn sanitize_url(raw: &str) -> Option<String> {
    let cut = raw.split_whitespace().next()?;
    let url = cut.trim_end_matches([')', ',']);
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url.to_string())
    } else {
        None
    }
}

/// 去掉 ANSI 转义序列（形如 `ESC [ ... 字母`），防止颜色码混进解析。
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c2 in chars.by_ref() {
                    if c2.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // 样本取自票2 验收时实机跑出的真实日志行。
    const REAL_LINE: &str = "dsh web: http://127.0.0.1:3080/?token=Hg2-FSVi19r0havm1WCAjf408xgTND8dUk9PTmKs6Cg (LAN: http://192.168.1.8:3080/?token=Hg2-FSVi19r0havm1WCAjf408xgTND8dUk9PTmKs6Cg)";

    #[test]
    fn parses_real_announcement_line() {
        let parsed = parse_announcement(REAL_LINE).expect("应命中公告");
        assert_eq!(
            parsed.local_url,
            "http://127.0.0.1:3080/?token=Hg2-FSVi19r0havm1WCAjf408xgTND8dUk9PTmKs6Cg"
        );
        assert_eq!(
            parsed.lan_url.as_deref(),
            Some("http://192.168.1.8:3080/?token=Hg2-FSVi19r0havm1WCAjf408xgTND8dUk9PTmKs6Cg")
        );
    }

    #[test]
    fn parses_announcement_with_noise_and_ansi() {
        let line = "\u{1b}[32m2026-10-14 18:00:00 INFO dsh web: http://127.0.0.1:3081/?token=abc123 (LAN: http://10.0.0.5:3081/?token=abc123)\u{1b}[0m".to_string();
        let parsed = parse_announcement(&line).expect("应命中公告");
        assert_eq!(parsed.local_url, "http://127.0.0.1:3081/?token=abc123");
        assert_eq!(
            parsed.lan_url.as_deref(),
            Some("http://10.0.0.5:3081/?token=abc123")
        );
    }

    #[test]
    fn parses_local_only_announcement() {
        let parsed =
            parse_announcement("dsh web: http://127.0.0.1:3090/?token=lonely").expect("应命中");
        assert_eq!(parsed.local_url, "http://127.0.0.1:3090/?token=lonely");
        assert_eq!(parsed.lan_url, None);
    }

    #[test]
    fn ignores_unrelated_lines() {
        for line in [
            "正在启动 DSH…",
            "dsh: some other message",
            "prefix dsh web: not-a-url",
            "",
        ] {
            assert!(parse_announcement(line).is_none(), "不应命中: {line:?}");
        }
    }

    #[test]
    fn malformed_lan_part_keeps_local_url() {
        // 括号不闭合的畸形行：保底返回本机链接。
        let parsed = parse_announcement(
            "dsh web: http://127.0.0.1:3091/?token=x (LAN: http://10.0.0.9:3091/?token=x",
        )
        .expect("应命中");
        assert_eq!(parsed.local_url, "http://127.0.0.1:3091/?token=x");
        assert_eq!(parsed.lan_url, None);
    }
}
