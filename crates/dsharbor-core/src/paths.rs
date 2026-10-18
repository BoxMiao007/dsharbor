//! 路径格式转换（Windows 壳 ↔ WSL 发行版之间互通）。
//!
//! 场景：壳跑在 Windows 上，启动方式选了 WSL 时，桥接插件的资源包（.tgz）
//! 在 Windows 磁盘上，但安装命令在发行版内部执行，需要 `/mnt/...` 形式的路径。

/// 把 Windows 盘符路径转成 WSL 里可见的 `/mnt/<盘符>/...` 形式。
///
/// 仅支持盘符路径；UNC 网络路径（`\\\\server\\share`）在 WSL 里没有默认挂载点，
/// 返回 None（调用方给出可读错误）。
pub fn windows_path_to_wsl(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    if bytes.len() < 3 || bytes[1] != b':' {
        return None;
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    if !drive.is_ascii_lowercase() {
        return None;
    }
    let rest = &path[2..];
    let rest = rest.trim_start_matches(['\\', '/']);
    let mut out = format!("/mnt/{drive}");
    for part in rest.split(['\\', '/']).filter(|part| !part.is_empty()) {
        out.push('/');
        out.push_str(part);
    }
    Some(out)
}

/// 单个 PATH 条目是否可安全注入（`/mnt` 挂载点、空白、引号、反斜杠一律丢弃）。
///
/// 非 ASCII **不**丢：实测 `wsl.exe … env PATH=/home/用户名/.local/bin:…` 会把
/// 原样 UTF-8 字节递进发行版（`printenv` 读回无变化），中文用户名下的 pnpm 目录
/// 正靠它才能注入。真正会坏事的是空白与引号（`env` 后面是 shell 命令行，实测
/// 带 `"` 或 `'` 的条目会让 bash 报 `unexpected EOF`）与反斜杠（会被当转义）。
fn safe_entry(entry: &str) -> bool {
    !entry.is_empty()
        && !entry.starts_with("/mnt/")
        && !entry
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\'' || c == '\\')
}

/// 清理从 WSL 侧取得的 PATH，供 `wsl.exe … env PATH=<clean>` 显式注入。
///
/// 为什么需要：从 Windows 侧经 wsl.exe 启动发行版时，Windows 的 PATH 会以
/// `/mnt/c/…` 形式混进发行版 PATH；发行版里没有的工具（如 pnpm 装在
/// `~/.local/share/pnpm/bin`）会误用 Windows 版同名二进制。
///
/// 为什么剔除规则这么严：清理结果要作为 `env PATH=…` 的单个 argv 交给
/// wsl.exe——实测 wsl.exe 会破坏参数里的引号（含 `"` 或 `'` 的条目会让 bash 报
/// `unexpected EOF`），含空白或反斜杠的条目也可能把参数改坏，宁可丢掉这类条目。
/// 非 ASCII 目录名（中文用户名）是安全的、必须保留。
pub fn sanitize_wsl_path(path: &str) -> String {
    path.split(':')
        .filter(|entry| safe_entry(entry))
        .collect::<Vec<_>>()
        .join(":")
}

/// 组装要注入 WSL 的 PATH：清理后的基础 PATH 之前，补用户级工具目录。
///
/// 为什么还要补：发行版里 pnpm 的 PATH 通常由 `~/.bashrc` 追加，而**非交互的
/// `bash -lc` 不读 `~/.bashrc`**——只注入“干净继承 PATH”会让 pnpm 直接找不到
/// （实测症状：`dsh: pnpm was not found`，退出码 127）。所以显式补上 pnpm
/// 独立安装的默认位置与 `~/.local/bin`（目录不存在留着也无害）。
pub fn wsl_inject_path(base: &str, home: &str) -> String {
    let home = home.trim().trim_end_matches('/');
    let mut entries: Vec<String> = Vec::new();
    if safe_entry(home) {
        for candidate in [
            format!("{home}/.local/share/pnpm/bin"),
            format!("{home}/.local/bin"),
        ] {
            if !entries.contains(&candidate) {
                entries.push(candidate);
            }
        }
    }
    for entry in base.split(':') {
        if safe_entry(entry) && !entries.iter().any(|existing| existing == entry) {
            entries.push(entry.to_string());
        }
    }
    entries.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_drive_paths() {
        assert_eq!(
            windows_path_to_wsl("C:\\Users\\boxmiao\\AppData\\dsharbor-bridge-0.1.0.tgz")
                .as_deref(),
            Some("/mnt/c/Users/boxmiao/AppData/dsharbor-bridge-0.1.0.tgz")
        );
        assert_eq!(
            windows_path_to_wsl("d:\\x\\y").as_deref(),
            Some("/mnt/d/x/y"),
            "盘符应统一为小写"
        );
        assert_eq!(
            windows_path_to_wsl("D:/mixed/sep/file").as_deref(),
            Some("/mnt/d/mixed/sep/file")
        );
    }

    #[test]
    fn rejects_unsupported_forms() {
        assert_eq!(windows_path_to_wsl("relative\\path"), None);
        assert_eq!(
            windows_path_to_wsl("\\\\server\\share\\file"),
            None,
            "UNC 无默认挂载点"
        );
        assert_eq!(windows_path_to_wsl(""), None);
        assert_eq!(windows_path_to_wsl("C:"), None, "长度不足");
    }

    #[test]
    fn sanitizes_wsl_path() {
        // 典型现场：Windows 翻译目录在前、Linux 目录在后。
        assert_eq!(
            sanitize_wsl_path("/mnt/d/IT/Scoop/nodejs:/usr/local/bin:/usr/bin:/bin"),
            "/usr/local/bin:/usr/bin:/bin"
        );
        // 空白/引号/反斜杠的条目丢掉（argv 传递会被 shell 改坏）；非 ASCII 保留
        // ——实测中文目录名经 env PATH=… 能原样递进发行版。
        assert_eq!(
            sanitize_wsl_path("/opt/my tools:/usr/bin:/数据:/opt/quo\"te"),
            "/usr/bin:/数据"
        );
        // 中文用户名下的 pnpm 目录必须留下（否则 pnpm 找不到）。
        assert_eq!(
            sanitize_wsl_path("/home/张三/.local/share/pnpm/bin:/usr/bin"),
            "/home/张三/.local/share/pnpm/bin:/usr/bin"
        );
        // 全是 /mnt 时返回空串（调用方视为失败）。
        assert_eq!(sanitize_wsl_path("/mnt/c/a:/mnt/d/b"), "");
        assert_eq!(sanitize_wsl_path(""), "");
    }

    #[test]
    fn injects_user_bin_dirs_before_clean_base() {
        assert_eq!(
            wsl_inject_path("/mnt/d/win:/usr/local/bin:/usr/bin", "/home/u"),
            "/home/u/.local/share/pnpm/bin:/home/u/.local/bin:/usr/local/bin:/usr/bin"
        );
        // home 未知时只清理基础 PATH，不补用户目录。
        assert_eq!(wsl_inject_path("/mnt/d/win:/usr/bin", "  "), "/usr/bin");
        // 去重：基础 PATH 里已有的用户目录不重复出现。
        assert_eq!(
            wsl_inject_path("/home/u/.local/bin:/usr/bin", "/home/u"),
            "/home/u/.local/share/pnpm/bin:/home/u/.local/bin:/usr/bin"
        );
    }
}
