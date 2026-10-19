//! 命令行集成：把壳的启动配置渲染成 `dsh` 垫片，并维护用户 PATH 里的那一条。
//!
//! 垫片只表达到包，参数全部透传（Windows 用 `%*`，POSIX 用 `"$@"`），不带壳自己的
//! 环境名位置参数与 `--no-open`，这样终端里 `dsh web`、`dsh plugin add`、`dsh --version`
//! 都按 CLI 自己的语义工作。
//!
//! 这里只有纯逻辑：渲染文本、算 PATH 字符串。读写注册表、落盘、探测系统 `dsh`
//! 都在外壳侧，本模块不碰文件系统与进程。

use crate::launch::{npx_spec, LaunchMode, NPX_PREFIX};

/// Windows 用户 PATH 的条目分隔符。
pub const WINDOWS_PATH_SEP: char = ';';
/// 垫片在该目录下的文件名（POSIX 宿主用无扩展名的那个）。
pub const SHIM_NAME_WINDOWS: &str = "dsh.cmd";
pub const SHIM_NAME_POSIX: &str = "dsh";

/// 当前宿主的 PATH 分隔符。
pub fn platform_path_sep() -> char {
    if cfg!(windows) {
        WINDOWS_PATH_SEP
    } else {
        ':'
    }
}

/// 两个 PATH 条目是否指同一个目录：忽略大小写与首尾空白，并剥掉尾随的路径分隔符
/// （`C:\bin\` 与 `C:\bin` 是同一个目录，否则反复开关会叠出两条）。
fn same_entry(a: &str, b: &str) -> bool {
    fn key(value: &str) -> String {
        let trimmed = value.trim();
        let mut stripped = trimmed.trim_end_matches(['\\', '/']);
        // 盘符根（`C:\`）剥成 `C:` 之后仍要能自洽，但不能再退到空串。
        if stripped.is_empty() {
            stripped = trimmed;
        }
        stripped.to_ascii_lowercase()
    }
    key(a) == key(b)
}

/// 按分隔符切开、去首尾空白、丢掉空项，保持原有顺序（不去重）。
fn entries(current: &str, sep: char) -> Vec<&str> {
    current
        .split(sep)
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// 把 `dir` 加进 `current`：先剔除同名条目（大小写不敏感），再追加到末尾。
///
/// 幂等：对同一个 `dir` 反复调用结果不变。其余条目的相对顺序原样保留。
pub fn path_add_entry_with(current: &str, dir: &str, sep: char) -> String {
    let mut kept: Vec<&str> = entries(current, sep)
        .into_iter()
        .filter(|entry| !same_entry(entry, dir))
        .collect();
    kept.push(dir.trim());
    kept.join(&sep.to_string())
}

/// 把 `dir` 从 `current` 里剔除，其余条目原样保留。目标不存在时等于原值（仅做空白规整）。
pub fn path_remove_entry_with(current: &str, dir: &str, sep: char) -> String {
    entries(current, sep)
        .into_iter()
        .filter(|entry| !same_entry(entry, dir))
        .collect::<Vec<_>>()
        .join(&sep.to_string())
}

/// `current` 里是否已有 `dir`（大小写不敏感、忽略空白与尾随分隔符）。
pub fn path_has_entry_with(current: &str, dir: &str, sep: char) -> bool {
    entries(current, sep)
        .into_iter()
        .any(|entry| same_entry(entry, dir))
}

/// 宿主分隔符版本的 [`path_add_entry_with`]。
pub fn path_add_entry(current: &str, dir: &str) -> String {
    path_add_entry_with(current, dir, platform_path_sep())
}

/// 宿主分隔符版本的 [`path_remove_entry_with`]。
pub fn path_remove_entry(current: &str, dir: &str) -> String {
    path_remove_entry_with(current, dir, platform_path_sep())
}

/// 宿主分隔符版本的 [`path_has_entry_with`]。
pub fn path_has_entry(current: &str, dir: &str) -> bool {
    path_has_entry_with(current, dir, platform_path_sep())
}

/// 垫片目录自身也必须是能安全写进 PATH 的形式：不含会破坏 PATH 或垫片的字符。
pub fn validate_dir(dir: &str) -> Result<(), String> {
    let dir = dir.trim();
    if dir.is_empty() {
        return Err("垫片目录不能为空".into());
    }
    if dir.len() > 1024 {
        return Err("垫片目录过长（最多 1024 字符）".into());
    }
    if let Some(bad) = dir
        .chars()
        .find(|c| matches!(c, '"' | '%' | ';' | '\n' | '\r'))
    {
        return Err(format!(
            "垫片目录包含不允许的字符 {bad:?}：{dir}（不能有双引号、百分号、分号或换行）"
        ));
    }
    Ok(())
}

/// 垫片里表达「运行哪个包」的那一段命令行（不含 `%*` / `"$@"`）。
///
/// * 官方 npx：`npx --yes @deepseek-ai/dsh[<渠道/版本后缀>]`
/// * 系统全局命令：`system_exe`，即壳探测到的 `dsh` 可执行文件绝对路径。**不写成裸
///   `dsh`**——垫片自己就叫 `dsh`，裸名会绕回自己（系统里没装 dsh 时直接无限递归）。
/// * 指定程序路径：`"<path>"`
/// * 自定义命令：原样透传
pub fn shim_target(mode: &LaunchMode, system_exe: Option<&str>) -> Result<String, String> {
    match mode {
        LaunchMode::Npx { channel, version } => Ok(format!(
            "{NPX_PREFIX} {}",
            npx_spec(*channel, version.as_deref())
        )),
        LaunchMode::System => {
            let exe = system_exe.map(str::trim).unwrap_or_default();
            if exe.is_empty() {
                return Err(
                    "没在 PATH 里找到系统全局的 dsh 命令，请先全局安装 DSH，或改用其它启动方式"
                        .into(),
                );
            }
            validate_executable(exe, "系统 dsh 命令路径")?;
            Ok(quote(exe))
        }
        LaunchMode::Binary { path } => {
            let path = path.trim();
            validate_executable(path, "程序路径")?;
            Ok(quote(path))
        }
        LaunchMode::Custom { command } => {
            let command = command.trim();
            if command.is_empty() {
                return Err("自定义命令不能为空".into());
            }
            if let Some(bad) = command.chars().find(|c| is_hostile(*c)) {
                return Err(format!(
                    "自定义命令包含不允许的字符 {bad:?}：{command}（不能有引号、百分号、换行、& | < > ^ ! ( ) ` ;）"
                ));
            }
            Ok(command.to_string())
        }
    }
}

/// 会破坏 `.cmd` 垫片与 shell 命令行的字符。`%` 在 `.cmd` 里是变量展开，必须排除；
/// 其余是 cmd.exe 与 POSIX shell 的语句分隔/转义字符。
fn is_hostile(c: char) -> bool {
    matches!(
        c,
        '"' | '%' | '\n' | '\r' | '&' | '|' | '<' | '>' | '^' | '!' | '(' | ')' | '`' | ';'
    )
}

fn validate_executable(value: &str, what: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{what}不能为空"));
    }
    if value.len() > 1024 {
        return Err(format!("{what}过长（最多 1024 字符）"));
    }
    if let Some(bad) = value.chars().find(|c| is_hostile(*c)) {
        return Err(format!(
            "{what}包含不允许的字符 {bad:?}：{value}（不能有引号、百分号、换行、& | < > ^ ! ( ) ` ;）"
        ));
    }
    Ok(())
}

/// 含空格的路径要包双引号，否则 `.cmd` 里会被当成两个词。入口已保证路径本身不含 `"`。
fn quote(value: &str) -> String {
    if value.contains(' ') {
        format!("\"{value}\"")
    } else {
        value.to_string()
    }
}

/// Windows 垫片（`dsh.cmd`）全文。
///
/// `@echo off` 之后不加 `setlocal`/`pushd`（会改掉 `cd` 相对路径的语义），也不加
/// `call`（我们的垫片只有这一条命令，`%*` 之后没有语句可被吞）。
pub fn windows_shim(mode: &LaunchMode, system_exe: Option<&str>) -> Result<String, String> {
    let target = shim_target(mode, system_exe)?;
    Ok(format!("@echo off\r\n{target} %*\r\n"))
}

/// POSIX 垫片（无扩展名 `dsh`）全文。本票在 Windows 上不落地，供手动接入与
/// Git Bash / WSL 场景展示。
pub fn posix_shim(mode: &LaunchMode, system_exe: Option<&str>) -> Result<String, String> {
    let target = shim_target(mode, system_exe)?;
    Ok(format!("#!/bin/sh\nexec {target} \"$@\"\n"))
}

/// 展开 `%NAME%` 形式的环境变量引用。`lookup` 返回 None 时原样保留，不报错。
///
/// 为什么要在核心库里做：PATH 里常见 `%USERPROFILE%\bin`，写回时一个字符都不能变；
/// 但拿它去磁盘上找文件时必须展开，否则找不到。
pub fn expand_env_vars(raw: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match lookup(name) {
                    Some(value) => out.push_str(&value),
                    // 认不出的变量名（或空名）原样保留。
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                // 剩下的 % 没有配对，原样留下。
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 垫片文件该写的字节。
///
/// 纯 ASCII（`npx --yes @deepseek-ai/dsh %*`、`D:\tools\dsh.exe %*` 这类绝大多数情况）
/// 原样写 UTF-8——与 ASCII 完全等同。含非 ASCII（中文用户名目录、中文程序路径）时
/// 转成 GBK：cmd.exe 按系统 OEM 代码页读批处理文件，UTF-8 字节会被当成乱码。
pub fn encode_batch_file(text: &str) -> Vec<u8> {
    if text.is_ascii() {
        return text.as_bytes().to_vec();
    }
    encoding_rs::GBK.encode(text).0.into_owned()
}

/// 界面给的「手动接过这条 PATH」的命令：不改任何配置文件，只给可粘贴的文本。
///
/// 命令的形式跟着平台走——在 cmd / PowerShell 里粘 `export PATH=...` 什么也不会发生，
/// 反之亦然。所以这里按宿主分岔，别拿一条 POSIX 文本糊弄 Windows 用户。
pub fn manual_command(bin_dir: &str) -> String {
    manual_command_for(bin_dir, cfg!(windows))
}

/// `manual_command` 的平台显式版本：两条分支都能在任一宿主上被单测覆盖。
///
/// Windows 走 `setx PATH "%PATH%;<目录>"`（粘进 cmd 或 PowerShell 都认；
/// 不要用 `$env:PATH`，cmd 用户占多数）。副作用由界面提示：`setx` 会把 `%VAR%`
/// 展开成当时的值，且值超过 1024 字符会被截断——所以自动接入那条路才用 `reg add`。
/// 非 Windows 保持 `export PATH="$PATH:<目录>"`（粘进 shell 的启动文件或当前会话）。
pub fn manual_command_for(bin_dir: &str, windows: bool) -> String {
    if windows {
        format!("setx PATH \"%PATH%;{bin_dir}\"")
    } else {
        format!("export PATH=\"$PATH:{bin_dir}\"")
    }
}

/// 按 PATH 顺序把每个目录与 `names` 拼接成候选路径（**不检查是否存在**）。
///
/// `path_value` 里的 `%VAR%` 由调用方先展开（本函数不认识环境变量）；`skip_dir`
/// 用来排除垫片目录自己——否则「系统全局 dsh」会探测到垫片、垫片又指向它，绕成环。
pub fn path_candidates(
    path_value: &str,
    names: &[&str],
    skip_dir: Option<&str>,
    sep: char,
) -> Vec<String> {
    let mut out = Vec::new();
    for dir in entries(path_value, sep) {
        if skip_dir.is_some_and(|skip| same_entry(dir, skip)) {
            continue;
        }
        let dir = dir.trim_end_matches(['\\', '/']);
        if dir.is_empty() {
            continue;
        }
        for name in names {
            out.push(format!("{dir}\\{name}"));
        }
    }
    out
}

/// 找到 `dir` 在 PATH 里的序号（从 0 起；不在里面时返回 None）。
pub fn path_entry_index(path_value: &str, dir: &str, sep: char) -> Option<usize> {
    entries(path_value, sep)
        .iter()
        .position(|entry| same_entry(entry, dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch::Channel;

    const SEP: char = ';';

    fn add(current: &str, dir: &str) -> String {
        path_add_entry_with(current, dir, SEP)
    }
    fn remove(current: &str, dir: &str) -> String {
        path_remove_entry_with(current, dir, SEP)
    }
    fn has(current: &str, dir: &str) -> bool {
        path_has_entry_with(current, dir, SEP)
    }

    #[test]
    fn adds_to_empty_path() {
        assert_eq!(add("", r"C:\bin"), r"C:\bin");
        assert_eq!(add("   ", r"C:\bin"), r"C:\bin");
    }

    #[test]
    fn adds_to_path_with_only_separators() {
        assert_eq!(add(";;;", r"C:\bin"), r"C:\bin");
    }

    #[test]
    fn appends_to_existing_path() {
        assert_eq!(add(r"C:\a;C:\b", r"C:\bin"), r"C:\a;C:\b;C:\bin");
    }

    #[test]
    fn add_is_idempotent() {
        let once = add(r"C:\a", r"C:\bin");
        let twice = add(&once, r"C:\bin");
        let thrice = add(&twice, r"C:\bin");
        assert_eq!(once, r"C:\a;C:\bin");
        assert_eq!(twice, once);
        assert_eq!(thrice, once);
    }

    #[test]
    fn add_moves_existing_entry_to_tail() {
        assert_eq!(add(r"C:\bin;C:\a;C:\b", r"C:\bin"), r"C:\a;C:\b;C:\bin");
        assert_eq!(add(r"C:\bin;C:\bin", r"C:\bin"), r"C:\bin");
    }

    #[test]
    fn add_dedupes_case_insensitively() {
        assert_eq!(add(r"c:\BIN;C:\a", r"C:\bin"), r"C:\a;C:\bin");
    }

    #[test]
    fn add_treats_trailing_separator_as_same_entry() {
        assert_eq!(add(r"C:\bin\;C:\a", r"C:\bin"), r"C:\a;C:\bin");
    }

    #[test]
    fn add_keeps_percent_entries_verbatim() {
        assert_eq!(
            add(r"%USERPROFILE%\bin;C:\a", r"C:\bin"),
            r"%USERPROFILE%\bin;C:\a;C:\bin"
        );
    }

    #[test]
    fn add_drops_blank_entries_and_trims_whitespace() {
        assert_eq!(add(r"  C:\a ;; C:\b ;  ", r"C:\bin"), r"C:\a;C:\b;C:\bin");
    }

    #[test]
    fn add_keeps_unrelated_duplicates() {
        assert_eq!(add(r"C:\a;C:\a;C:\b", r"C:\bin"), r"C:\a;C:\a;C:\b;C:\bin");
    }

    #[test]
    fn removes_entry_keeping_order() {
        assert_eq!(remove(r"C:\a;C:\bin;C:\b", r"C:\bin"), r"C:\a;C:\b");
        assert_eq!(remove(r"C:\bin;C:\a", r"C:\bin"), r"C:\a");
        assert_eq!(remove(r"C:\a;C:\bin", r"C:\bin"), r"C:\a");
    }

    #[test]
    fn remove_is_idempotent_when_missing() {
        assert_eq!(remove(r"C:\a;C:\b", r"C:\bin"), r"C:\a;C:\b");
    }

    #[test]
    fn remove_matches_case_insensitively() {
        assert_eq!(remove(r"C:\a;c:\BiN;C:\b", r"C:\bin"), r"C:\a;C:\b");
    }

    #[test]
    fn remove_leaves_empty_string_when_only_entry() {
        assert_eq!(remove(r"C:\bin", r"C:\bin"), "");
    }

    #[test]
    fn has_entry_ignores_case_and_whitespace() {
        assert!(has(r" C:\a ; C:\BIN ", r"C:\bin"));
        assert!(!has(r"C:\a;C:\b", r"C:\bin"));
        assert!(!has("", r"C:\bin"));
        assert!(!has(";;", r"C:\bin"));
    }

    #[test]
    fn add_then_remove_restores_original() {
        let original = r"%USERPROFILE%\bin;C:\Tools;C:\Windows";
        let added = add(original, r"C:\Users\me\AppData\Roaming\DSHarbor\bin");
        assert_eq!(
            remove(&added, r"C:\Users\me\AppData\Roaming\DSHarbor\bin"),
            original
        );
    }

    #[test]
    fn validate_dir_accepts_app_data_like_path() {
        assert!(validate_dir(r"C:\Users\me\AppData\Roaming\DSHarbor\bin").is_ok());
    }

    #[test]
    fn validate_dir_rejects_hostile_chars() {
        for bad in [
            r#"C:\a"b"#,
            r"C:\a%b",
            r"C:\a;b",
            "C:\\a\nb",
            "C:\\a\rb",
            "   ",
        ] {
            assert!(validate_dir(bad).is_err(), "应拒绝：{bad:?}");
        }
    }

    #[test]
    fn windows_shim_for_npx_keeps_percent_star() {
        let mode = LaunchMode::Npx {
            channel: Channel::Latest,
            version: None,
        };
        let text = windows_shim(&mode, None).unwrap();
        assert_eq!(text, "@echo off\r\nnpx --yes @deepseek-ai/dsh %*\r\n");
        // 只表达到包：不带壳自己的环境名位置参数与选项。
        assert!(!text.contains(" web"));
        assert!(!text.contains("--no-open"));
        assert!(!text.contains("setlocal"));
        assert!(!text.contains("pushd"));
        assert!(!text.contains("call "));
    }

    #[test]
    fn windows_shim_specializes_npx_channel() {
        let next = LaunchMode::Npx {
            channel: Channel::Next,
            version: None,
        };
        assert!(windows_shim(&next, None)
            .unwrap()
            .contains("@deepseek-ai/dsh@next %*"));

        let rc = LaunchMode::Npx {
            channel: Channel::Rc,
            version: Some("0.2.1-rc.2".to_string()),
        };
        assert!(windows_shim(&rc, None)
            .unwrap()
            .contains("@deepseek-ai/dsh@0.2.1-rc.2 %*"));
    }

    #[test]
    fn windows_shim_for_system_uses_detected_exe() {
        let text = windows_shim(&LaunchMode::System, Some(r"C:\Users\me\npm\dsh.cmd")).unwrap();
        assert_eq!(text, "@echo off\r\nC:\\Users\\me\\npm\\dsh.cmd %*\r\n");
        // 没探测到就不能裸写 dsh，否则垫片会绕回自己。
        assert!(windows_shim(&LaunchMode::System, None).is_err());
    }

    #[test]
    fn windows_shim_quotes_binary_path_with_spaces() {
        let mode = LaunchMode::Binary {
            path: r"D:\my tools\dsh.cmd".to_string(),
        };
        assert_eq!(
            windows_shim(&mode, None).unwrap(),
            "@echo off\r\n\"D:\\my tools\\dsh.cmd\" %*\r\n"
        );
        let plain = LaunchMode::Binary {
            path: "D:\\tools\\dsh.exe".to_string(),
        };
        assert_eq!(
            windows_shim(&plain, None).unwrap(),
            "@echo off\r\nD:\\tools\\dsh.exe %*\r\n"
        );
    }

    #[test]
    fn windows_shim_passes_custom_command_through() {
        let mode = LaunchMode::Custom {
            command: "pnpm dlx @deepseek-ai/dsh".to_string(),
        };
        assert_eq!(
            windows_shim(&mode, None).unwrap(),
            "@echo off\r\npnpm dlx @deepseek-ai/dsh %*\r\n"
        );
    }

    #[test]
    fn shim_rejects_hostile_binary_path() {
        for bad in [
            r"D:\bad%path\dsh.exe",
            "D:\\a\"b\\dsh.exe",
            "D:\\a\nb\\dsh.exe",
        ] {
            let mode = LaunchMode::Binary {
                path: bad.to_string(),
            };
            assert!(windows_shim(&mode, None).is_err(), "应拒绝：{bad:?}");
            assert!(posix_shim(&mode, None).is_err());
            assert!(shim_target(&mode, None).is_err());
        }
    }

    #[test]
    fn shim_rejects_hostile_custom_command() {
        for bad in [
            "dsh && echo pwned",
            "dsh %PATH%",
            "dsh | more",
            "dsh\nwhoami",
        ] {
            let mode = LaunchMode::Custom {
                command: bad.to_string(),
            };
            assert!(windows_shim(&mode, None).is_err(), "应拒绝：{bad:?}");
        }
        let empty = LaunchMode::Custom {
            command: "   ".to_string(),
        };
        assert!(windows_shim(&empty, None).is_err());
    }

    #[test]
    fn posix_shim_for_npx_uses_exec_and_dollar_at() {
        let mode = LaunchMode::Npx {
            channel: Channel::Latest,
            version: None,
        };
        assert_eq!(
            posix_shim(&mode, None).unwrap(),
            "#!/bin/sh\nexec npx --yes @deepseek-ai/dsh \"$@\"\n"
        );
    }

    #[test]
    fn posix_shim_quotes_binary_path() {
        let mode = LaunchMode::Binary {
            path: "/usr/local/bin/dsh".to_string(),
        };
        assert_eq!(
            posix_shim(&mode, None).unwrap(),
            "#!/bin/sh\nexec /usr/local/bin/dsh \"$@\"\n"
        );
    }

    #[test]
    fn platform_sep_wrapper_matches_platform() {
        let dir = if cfg!(windows) { r"C:\bin" } else { "/opt/bin" };
        let added = path_add_entry("", dir);
        assert_eq!(added, dir);
        assert!(path_has_entry(&added, dir));
        assert_eq!(path_remove_entry(&added, dir), "");
    }

    #[test]
    fn manual_command_matches_platform() {
        // 两条分支都断言：宿主是 Windows 时也得能把 POSIX 那条测到。
        let dir = r"C:\Users\me\AppData\Roaming\DSHarbor\bin";
        let win = manual_command_for(dir, true);
        assert_eq!(
            win,
            "setx PATH \"%PATH%;C:\\Users\\me\\AppData\\Roaming\\DSHarbor\\bin\""
        );
        assert_eq!(win.matches(dir).count(), 1);

        let posix = manual_command_for("/home/me/.config/DSHarbor/bin", false);
        assert_eq!(posix, "export PATH=\"$PATH:/home/me/.config/DSHarbor/bin\"");
        assert_eq!(posix.matches("/home/me/.config/DSHarbor/bin").count(), 1);

        // 便捷入口跟随宿主，不再固定成 POSIX 形式（否则 Windows 上给的命令是废的）。
        assert_eq!(manual_command(dir), manual_command_for(dir, cfg!(windows)));
    }

    #[test]
    fn batch_file_bytes_are_ascii_verbatim() {
        let text = "@echo off\r\nnpx --yes @deepseek-ai/dsh %*\r\n";
        assert_eq!(encode_batch_file(text), text.as_bytes().to_vec());
    }

    #[test]
    fn batch_file_bytes_use_gbk_for_non_ascii() {
        // 中文路径必须按 GBK 写：cmd.exe 按 OEM 代码页读批处理文件。
        let text = "@echo off\r\n\"D:\\工具\\dsh.exe\" %*\r\n";
        let bytes = encode_batch_file(text);
        assert_ne!(bytes, text.as_bytes().to_vec());
        assert_eq!(encoding_rs::GBK.decode(&bytes).0, text);
    }

    #[test]
    fn path_candidates_keep_order_and_skip_own_dir() {
        let cands = path_candidates(
            r"C:\a;C:\bin;C:\b",
            &["dsh.exe", "dsh.cmd"],
            Some(r"C:\bin"),
            SEP,
        );
        assert_eq!(
            cands,
            vec![
                r"C:\a\dsh.exe",
                r"C:\a\dsh.cmd",
                r"C:\b\dsh.exe",
                r"C:\b\dsh.cmd",
            ]
        );
    }

    #[test]
    fn path_candidates_strip_trailing_separators() {
        let cands = path_candidates(r"C:\a\;;", &["dsh.exe"], None, SEP);
        assert_eq!(cands, vec![r"C:\a\dsh.exe"]);
        assert!(path_candidates("", &["dsh.exe"], None, SEP).is_empty());
    }

    #[test]
    fn path_entry_index_reports_order() {
        assert_eq!(path_entry_index(r"C:\bin;C:\a", r"C:\bin", SEP), Some(0));
        assert_eq!(path_entry_index(r"C:\a;c:\BIN", r"C:\bin", SEP), Some(1));
        assert_eq!(path_entry_index(r"C:\a", r"C:\bin", SEP), None);
    }

    #[test]
    fn expands_known_vars_and_keeps_unknown() {
        let lookup = |name: &str| match name {
            "USERPROFILE" => Some(r"C:\Users\me".to_string()),
            "SystemRoot" => Some(r"C:\Windows".to_string()),
            _ => None,
        };
        assert_eq!(
            expand_env_vars(r"%USERPROFILE%\bin;%SystemRoot%;%NOPE%\x", lookup),
            r"C:\Users\me\bin;C:\Windows;%NOPE%\x"
        );
    }

    #[test]
    fn expand_leaves_plain_text_untouched() {
        let lookup = |_: &str| Some("X".to_string());
        assert_eq!(expand_env_vars(r"C:\a;C:\b", lookup), r"C:\a;C:\b");
        assert_eq!(expand_env_vars("", lookup), "");
        // 落单的 % 不配对被原样留下。
        assert_eq!(expand_env_vars("100%", lookup), "100%");
        assert_eq!(expand_env_vars("%", lookup), "%");
    }
}
