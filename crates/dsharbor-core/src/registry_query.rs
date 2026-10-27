//! 读 `reg query` 输出的纯逻辑。
//!
//! 用户 PATH（命令行集成）与系统代理设置（网络卡）都靠 `reg query` 读注册表，
//! 解析规则只该有一份：值名列 + 类型列 + 值，值本身原样保留。两个调用点原本
//! 分别住在「PATH 垫片」与「网络」两个模块里，后者要跨模块借前者的函数——
//! 解析归解析、放这里谁都可以直接用，也不再把两个不相干的模块绑在一起。
//!
//! 这里只有纯逻辑：跑 `reg` 本身在壳那一层。

/// 从 `reg query` 的输出里取出名为 `name` 的值（值名列 + 类型列 + 值）。
///
/// `reg query HKCU\Environment` 的输出形如：
///
/// ```text
/// HKEY_CURRENT_USER\Environment
///     Path    REG_EXPAND_SZ    %USERPROFILE%\bin;D:\tools
///     TEMP    REG_EXPAND_SZ    %USERPROFILE%\AppData\Local\Temp
/// ```
///
/// 值名后必须是空白（`Path` 不能命中 `PathX`），类型列必须以 `REG_` 开头。剥掉
/// 「缩进 + 值名 + 类型 + 四个空格」后原样返回其余部分——**不做 trim 以外的任何改写**：
/// `%VAR%` 必须原样保留，否则写回去就变成展开后的硬路径了。
pub fn parse_reg_query_value(output: &str, name: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim_start();
        // 取「前 name.len() 个字节」用 get 而不是切下标：`trimmed[..name.len()]`
        // 是按字节切 UTF-8，行首含多字节字符时（第三方代理/VPN 会往
        // Internet Settings 写中文值名，而 proxy.rs 查的是整键）切点落在字符
        // 中间就直接 panic。get 在越界或非字符边界时返回 None，正好跳过该行。
        let head = match trimmed.get(..name.len()) {
            Some(head) => head,
            None => continue,
        };
        if !head.eq_ignore_ascii_case(name) {
            continue;
        }
        // 能走到这里说明 name.len() 是字符边界，下面的切片是安全的。
        let rest = &trimmed[name.len()..];
        if !rest.starts_with([' ', '\t']) {
            continue;
        }
        // 跳过空白，取出类型列。
        let after_gap = rest.trim_start();
        let type_end = after_gap
            .find(char::is_whitespace)
            .unwrap_or(after_gap.len());
        let kind = &after_gap[..type_end];
        if !kind.starts_with("REG_") {
            continue;
        }
        // 类型与值之间固定四个空格；值本身可能以空格开头，所以只剥这四个。
        let value_part = &after_gap[type_end..];
        let value = value_part.strip_prefix("    ").unwrap_or(value_part);
        return Some(value.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_reg_query_output_verbatim() {
        let output = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;D:\\tools\r\n\r\n";
        assert_eq!(
            parse_reg_query_value(output, "Path").as_deref(),
            Some(r"%USERPROFILE%\bin;D:\tools")
        );
    }

    #[test]
    fn parses_reg_query_picks_the_named_value_only() {
        let output = "HKEY_CURRENT_USER\\Environment\r\n    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\Temp\r\n    Path    REG_EXPAND_SZ    C:\\a;%SystemRoot%\r\n    TEMP2    REG_SZ    x
\n";
        assert_eq!(
            parse_reg_query_value(output, "Path").as_deref(),
            Some(r"C:\a;%SystemRoot%")
        );
        assert_eq!(
            parse_reg_query_value(output, "TEMP").as_deref(),
            Some(r"%USERPROFILE%\Temp")
        );
        // 值名不能是「某个更长的值名的前缀」。
        assert_eq!(parse_reg_query_value(output, "PAT"), None);
        assert_eq!(parse_reg_query_value(output, "PathX"), None);
    }

    #[test]
    fn parses_reg_query_with_spaces_in_value() {
        let output =
            "HKEY_CURRENT_USER\\Environment\n    Path    REG_SZ    C:\\Program Files\\x;C:\\a\n";
        assert_eq!(
            parse_reg_query_value(output, "path").as_deref(),
            Some(r"C:\Program Files\x;C:\a")
        );
    }

    #[test]
    fn parses_reg_query_with_empty_value() {
        let output = "HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    \r\n";
        assert_eq!(parse_reg_query_value(output, "Path").as_deref(), Some(""));
        let no_trailing = "    Path    REG_EXPAND_SZ";
        assert_eq!(
            parse_reg_query_value(no_trailing, "Path").as_deref(),
            Some("")
        );
    }

    #[test]
    fn non_ascii_value_names_do_not_panic() {
        // 整键 reg query 的输出里会出现第三方软件写的中文值名；历史实现按字节
        // 切前缀，切点落在多字节字符中间就 panic（已复现：byte index 11 is not
        // a char boundary）。这里同时盯住「跳过不匹配行」与「用中文值名查询」。
        let output = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    代理开关    REG_DWORD    0x1\r\n    ProxyEnable    REG_DWORD    0x1\r\n";
        assert_eq!(
            parse_reg_query_value(output, "ProxyEnable").as_deref(),
            Some("0x1")
        );
        assert_eq!(
            parse_reg_query_value(output, "代理开关").as_deref(),
            Some("0x1")
        );
    }

    #[test]
    fn parse_reg_query_returns_none_when_value_missing() {
        // 注册表里没有这个值：reg 输出的是错误文本（或只有键名一行）。
        assert_eq!(
            parse_reg_query_value("ERROR: 找不到指定的注册表项或值。", "Path"),
            None
        );
        assert_eq!(
            parse_reg_query_value("HKEY_CURRENT_USER\\Environment", "Path"),
            None
        );
        assert_eq!(parse_reg_query_value("", "Path"), None);
    }
}
