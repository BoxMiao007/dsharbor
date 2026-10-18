//! 枚举 WSL 发行版，并标注每个发行版里有没有 node/npm。
//!
//! 注意：wsl.exe 的输出是 UTF-16LE（首条带 BOM），必须走 ConsoleDecoder，
//! 否则界面上的发行版列表会全是乱码。

use std::process::{Command, Stdio};
use std::time::Duration;

use dsharbor_core::console::ConsoleDecoder;
use serde::Serialize;

/// 界面下拉框要的一条：发行版名 + 里面能不能跑 `npx`。
///
/// `has_node` 只用来在选项文字上标一句「（未检测到 Node.js）」提醒用户，
/// 不阻止选择——用户可能正打算进发行版里装，或者只是想先把配置存下来。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistroInfo {
    pub distro: String,
    pub has_node: bool,
}

/// 探测 node/npm 的超时：首次调用要拉起整个 WSL 子系统（秒级），给足余量。
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

fn list_distros() -> Result<Vec<String>, String> {
    let mut command = Command::new("wsl.exe");
    command
        .args(["-l", "-q"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::launcher::apply_no_window(&mut command);
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

/// 发行版列表 + 每个发行版有没有 node/npm。
///
/// 探测失败（发行版起不来、超时）按「没有 Node.js」处理：这只影响一句提示文字，
/// 不该让整个下拉框读取失败。
pub fn distro_info() -> Result<Vec<DistroInfo>, String> {
    let distros = list_distros()?;
    Ok(distros
        .into_iter()
        .map(|distro| {
            let has_node = has_node(&distro).unwrap_or_else(|err| {
                eprintln!("[dsharbor] 探测 WSL 发行版 {distro} 的 Node.js 失败：{err}");
                false
            });
            DistroInfo { distro, has_node }
        })
        .collect())
}

/// 发行版里能不能找到 node 和 npm。
///
/// 用 `bash -lc` 而不是 `printenv`：npm 的路径通常写在 `~/.nvm/nvm.sh` 或
/// `~/.bashrc` 里，非交互的 `printenv PATH` 读不到（DSH 本身也是经 `bash -lc`
/// 启动的，探测方式与真正执行时保持一致才不会误判）。
fn has_node(distro: &str) -> Result<bool, String> {
    let script = "command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1";
    let mut command = Command::new("wsl.exe");
    command
        .args(["-d", distro, "--", "bash", "-lc", script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::launcher::apply_no_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("无法调用 wsl.exe：{err}"))?;
    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) => {}
            Err(err) => return Err(format!("等待 wsl.exe 结束失败：{err}")),
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            return Err(format!(
                "探测 WSL 发行版 {distro} 的 Node.js 超时（{} 秒）",
                PROBE_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(120));
    }
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
    crate::launcher::apply_no_window(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("无法调用 wsl.exe：{err}"))?;
    if !output.status.success() {
        return Err(format!("读取 WSL 发行版环境变量 {name} 失败（{distro}）"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
