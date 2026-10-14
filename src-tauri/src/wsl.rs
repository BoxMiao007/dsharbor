//! 枚举 WSL 发行版（供配置界面的下拉框）。
//!
//! 注意：wsl.exe 的输出是 UTF-16LE（首条带 BOM），必须走 ConsoleDecoder，
//! 否则界面上的发行版列表会全是乱码。

use std::process::{Command, Stdio};

use dsharbor_core::console::ConsoleDecoder;

pub fn list_distros() -> Result<Vec<String>, String> {
    let mut command = Command::new("wsl.exe");
    command
        .args(["-l", "-q"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|err| format!("无法调用 wsl.exe：{err}（系统可能未安装 WSL）"))?;
    let mut stdout_decoder = ConsoleDecoder::new();
    let stdout = stdout_decoder.feed(&output.stdout);
    if !output.status.success() {
        let mut stderr_decoder = ConsoleDecoder::new();
        let stderr = stderr_decoder.feed(&output.stderr);
        let detail = stderr.trim();
        let detail = if detail.is_empty() {
            "wsl.exe 返回失败".to_string()
        } else {
            detail.to_string()
        };
        return Err(format!("读取 WSL 发行版列表失败：{detail}"));
    }
    Ok(stdout
        .lines()
        .map(|line| line.trim().trim_matches('\0').to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

/// 取发行版的一份干净 PATH（供 `wsl.exe … env PATH=…` 显式注入）。
///
/// 用 `printenv PATH` / `printenv HOME` 直接读环境变量、不经 shell：实测
/// wsl.exe 会破坏参数里的引号，带引号的 shell 命令不可靠。取到后交给 core 的
/// `wsl_inject_path`：清理掉 /mnt 污染项，并补上 `~/.local/share/pnpm/bin`、
/// `~/.local/bin`（pnpm 的 PATH 在 ~/.bashrc 里，非交互登录 shell 读不到）。
pub fn clean_path(distro: &str) -> Result<String, String> {
    let path_raw = printenv(distro, "PATH")?;
    let home = printenv(distro, "HOME").unwrap_or_default();
    let assembled = dsharbor_core::paths::wsl_inject_path(&path_raw, &home);
    if assembled.is_empty() {
        return Err(format!("WSL 发行版 {distro} 的 PATH 为空或全部不可用"));
    }
    Ok(assembled)
}

fn printenv(distro: &str, name: &str) -> Result<String, String> {
    let mut command = Command::new("wsl.exe");
    command
        .args(["-d", distro, "--", "printenv", name])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|err| format!("无法调用 wsl.exe：{err}"))?;
    if !output.status.success() {
        return Err(format!("读取 WSL 发行版环境变量 {name} 失败（{distro}）"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
