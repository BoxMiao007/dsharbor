//! 端口覆盖层（核心库纯逻辑）。
//!
//! 背景：DSH 的 profile 里可能有一块由第三方插件（如 remote-web-ui 的
//! lan-bind）写入的 webserver 固定配置（`host: 0.0.0.0 / port: 3080`，
//! 注释标注 managed - do not edit）。实测 `--port` 旗标打不过它，而
//! **launcher 层 patch**（`dsh --patch <文件>`）在所有层之后应用、
//! 优先级最高，且只影响本次启动、不改用户的任何文件。
//!
//! 本模块负责两件纯文本的事：
//! 1. 从 profile 的 `cordis.patch.yml` 文本里找到 webserver 行的 config 块
//!    （用于界面展示「当前生效值」，以及生成覆盖层时保留 host 等键）；
//! 2. 生成覆盖层 YAML：字段照抄现有块、只替换/补上 `port`。
//!
//! 没有可用的现有块时按出厂模板的形状兜底（host 跟随 webStartup，
//! compression 保持与出厂一致，不硬编码 host）。

use crate::endpoint;

/// 从 profile patch 文本里提取的 webserver 行信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebserverBlock {
    /// 行内声明的包名（`name:`），没有则为 None。
    pub name: Option<String>,
    /// `config:` 之下的映射行（原样保留缩进与内容）。
    pub config_lines: Vec<String>,
    /// 去掉引号后的 host 字面量；是 `!!js` 表达式时为 None。
    pub host: Option<String>,
    /// 显式写死的端口（数字）；表达式或缺失时为 None。
    pub port: Option<u16>,
}

/// 在 patch 文本里查找 `- id: webserver` 行，返回其 config 块信息。
/// 只认第一个匹配；找不到返回 None。
pub fn find_webserver_block(text: &str) -> Option<WebserverBlock> {
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];
        let trimmed = raw.trim_start();
        if trimmed.starts_with("- id:") && trimmed["- id:".len()..].trim() == "webserver" {
            let row_indent = raw.len() - trimmed.len();
            let mut name = None;
            let mut config_lines: Vec<String> = Vec::new();
            let mut config_indent: Option<usize> = None;
            let mut j = i + 1;
            while j < lines.len() {
                let line = lines[j];
                let t = line.trim_start();
                let indent = line.len() - t.len();
                // 顶格的下一条 patch 行 = 本行结束。
                if !t.is_empty() && indent <= row_indent && t.starts_with("- ") {
                    break;
                }
                match config_indent {
                    None => {
                        if let Some(value) = t.strip_prefix("name:") {
                            name = clean_scalar(value);
                        }
                        if t.starts_with("config:") {
                            config_indent = Some(indent);
                        }
                    }
                    Some(cfg_indent) => {
                        if !t.is_empty() && indent <= cfg_indent {
                            // config 块结束（回到行级键或空行之后的内容）。
                            break;
                        }
                        if !t.is_empty() {
                            config_lines.push(line.to_string());
                        }
                    }
                }
                j += 1;
            }
            let host = config_lines
                .iter()
                .find_map(|line| scalar_of(line, "host:"));
            let port = config_lines
                .iter()
                .find_map(|line| scalar_of(line, "port:").and_then(|v| v.parse::<u16>().ok()));
            return Some(WebserverBlock {
                name,
                config_lines,
                host,
                port,
            });
        }
        i += 1;
    }
    None
}

/// 去掉引号的标量值；空值或 `!!js` 表达式返回 None（不可当字面量用）。
fn clean_scalar(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains("!!js") {
        return None;
    }
    let unquoted = trimmed.trim_matches(|c| c == '\'' || c == '"');
    Some(unquoted.to_string())
}

fn scalar_of(line: &str, key: &str) -> Option<String> {
    let t = line.trim_start();
    t.strip_prefix(key).and_then(clean_scalar)
}

/// 生成端口覆盖用的 launcher 层 patch 文本。
pub fn build_port_overlay(block: Option<&WebserverBlock>, port: u16) -> String {
    let mut out = String::new();
    out.push_str("# DSHarbor 生成：本次启动的端口覆盖（launcher 层，不改动你的配置文件）\n");
    out.push_str("- id: webserver\n");
    match block {
        Some(b) => {
            if let Some(name) = &b.name {
                out.push_str(&format!("  name: '{name}'\n"));
            }
        }
        None => {
            // 没有现有块可参照：用出厂包名（匹配到 shipped 的 webserver 行）。
            out.push_str("  name: '@deepseek-ai/dsh-host-webserver'\n");
        }
    }
    out.push_str("  config:\n");
    match block {
        Some(b) if !b.config_lines.is_empty() => {
            let mut replaced = false;
            for line in &b.config_lines {
                let t = line.trim_start();
                if !replaced && t.starts_with("port:") {
                    let indent = &line[..line.len() - t.len()];
                    out.push_str(&format!("{indent}port: {port}\n"));
                    replaced = true;
                } else if let Some(value) = scalar_of(line, "host:") {
                    // DSH 0.2.1-rc.2 起 webserver 的 host 必须是具体 IP 字面量：通配地址
                    // （0.0.0.0 / ::，官方 remote-web-ui 就写这个）会被直接拒绝、整只
                    // DSH 起不来，主机名（localhost）同样不合法。照抄旧块会把用户带进
                    // 这个坑里，所以这里归一成可用的具体地址。
                    let indent = &line[..line.len() - t.len()];
                    let host = endpoint::resolve_host(Some(&value), false);
                    out.push_str(&format!("{indent}host: '{host}'\n"));
                } else {
                    out.push_str(line);
                    out.push('\n');
                }
            }
            if !replaced {
                let indent = block_config_indent(b);
                out.push_str(&format!("{indent}port: {port}\n"));
            }
        }
        _ => {
            // 兜底：照抄出厂 webserver 配置的形状，host 交给 webStartup 决定，
            // compression 保持与出厂一致（避免顺手把压缩关掉）。
            out.push_str("    host: !!js ctx.webStartup.host ?? '127.0.0.1'\n");
            out.push_str("    compression: gzip\n");
            out.push_str("    compressionLevel: 1\n");
            out.push_str("    compressionThresholdBytes: 1024\n");
            out.push_str(&format!("    port: {port}\n"));
        }
    }
    out
}

fn block_config_indent(block: &WebserverBlock) -> String {
    block
        .config_lines
        .first()
        .map(|line| {
            let t = line.trim_start();
            line[..line.len() - t.len()].to_string()
        })
        .unwrap_or_else(|| "    ".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用户 Windows profile 里由 remote-web-ui 写入的真实形状。
    const MANAGED_BLOCK: &str = r#"# --- remote-web-ui lan-bind block (managed - do not edit) ---
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: '0.0.0.0'
    port: 3080
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
# --- end remote-web-ui lan-bind block ---
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      - danger-full-access
"#;

    #[test]
    fn finds_managed_block() {
        let block = find_webserver_block(MANAGED_BLOCK).expect("应能找到 webserver 行");
        assert_eq!(
            block.name.as_deref(),
            Some("@deepseek-ai/dsh-host-webserver")
        );
        assert_eq!(block.host.as_deref(), Some("0.0.0.0"));
        assert_eq!(block.port, Some(3080));
        assert_eq!(block.config_lines.len(), 5);
    }

    #[test]
    fn overlay_replaces_port_and_keeps_other_keys() {
        let block = find_webserver_block(MANAGED_BLOCK).unwrap();
        let yaml = build_port_overlay(Some(&block), 3099);
        assert!(yaml.contains("- id: webserver"));
        assert!(yaml.contains("name: '@deepseek-ai/dsh-host-webserver'"));
        // 旧块的通配 host 被归一成具体地址：DSH 0.2.1-rc.2 会拒绝 0.0.0.0。
        assert!(yaml.contains("host: '127.0.0.1'"));
        assert!(!yaml.contains("0.0.0.0"));
        assert!(yaml.contains("compression: gzip"));
        assert!(yaml.contains("port: 3099"));
        assert!(!yaml.contains("port: 3080"));
    }

    #[test]
    fn overlay_keeps_concrete_lan_host() {
        let text = "- id: webserver\n  config:\n    host: '192.168.1.7'\n    port: 3080\n";
        let block = find_webserver_block(text).unwrap();
        let yaml = build_port_overlay(Some(&block), 3099);
        assert!(yaml.contains("host: '192.168.1.7'"));
        assert!(yaml.contains("port: 3099"));
    }

    #[test]
    fn overlay_appends_port_when_missing() {
        let text = "- id: webserver\n  config:\n    host: 127.0.0.1\n";
        let block = find_webserver_block(text).unwrap();
        assert_eq!(block.port, None);
        let yaml = build_port_overlay(Some(&block), 3100);
        assert!(yaml.contains("host: '127.0.0.1'"));
        assert!(yaml.contains("port: 3100"));
    }

    #[test]
    fn overlay_falls_back_without_block() {
        let yaml = build_port_overlay(None, 3099);
        assert!(yaml.contains("name: '@deepseek-ai/dsh-host-webserver'"));
        assert!(yaml.contains("!!js ctx.webStartup.host"));
        assert!(yaml.contains("port: 3099"));
    }

    #[test]
    fn no_webserver_row_returns_none() {
        assert_eq!(
            find_webserver_block("- id: permission\n  config: {}\n"),
            None
        );
        assert_eq!(find_webserver_block(""), None);
    }

    #[test]
    fn expression_host_is_not_a_literal() {
        let text = "- id: webserver\n  config:\n    host: !!js ctx.webStartup.host ?? '127.0.0.1'\n    port: 3080\n";
        let block = find_webserver_block(text).unwrap();
        assert_eq!(block.host, None);
        assert_eq!(block.port, Some(3080));
    }

    #[test]
    fn double_quoted_host_is_stripped() {
        let text = "- id: webserver\n  config:\n    host: \"0.0.0.0\"\n";
        let block = find_webserver_block(text).unwrap();
        assert_eq!(block.host.as_deref(), Some("0.0.0.0"));
    }
}
