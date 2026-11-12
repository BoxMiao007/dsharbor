//! 枚举 WSL 发行版，并标注每个发行版里有没有 node/npm。
//!
//! 注意：wsl.exe 的输出是 UTF-16LE（首条带 BOM），必须走 ConsoleDecoder，
//! 否则界面上的发行版列表会全是乱码。

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use dsharbor_core::console::ConsoleDecoder;
use serde::{Deserialize, Serialize};

/// 界面下拉框要的一条：发行版名 + 里面能不能跑 `npx`。
///
/// `has_node` 只用来在选项文字上标一句「（未检测到 Node.js）」提醒用户，
/// 不阻止选择——用户可能正打算进发行版里装，或者只是想先把配置存下来。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistroInfo {
    pub distro: String,
    pub has_node: bool,
}

/// 探测结果的落盘缓存文件名（放在壳的数据根目录，见 `app_data_root`）。
///
/// 为什么要缓存：探测要进每个发行版跑一次 `bash -lc`，首次会拉起整个 WSL 子系统
/// （实测 8 秒）。启动时先用上次这份把下拉框铺出来，探测挪到后台再刷——否则
/// 「运行环境」会一直卡在「正在读取发行版列表…」。
pub const CACHE_FILE: &str = "wsl-distros.json";

/// 缓存文件内容：探测结果 + 探测时刻（Unix 秒）。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DistroCache {
    fetched_at: u64,
    distros: Vec<DistroInfo>,
}

/// 读上次探测到的发行版列表。
///
/// 没有缓存、读不懂、结构对不上都返回 `None`：缓存只负责先把下拉框铺出来，
/// 读不到就照旧等后台探测，不该让启动失败。
pub fn read_cache(path: &Path) -> Option<Vec<DistroInfo>> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<DistroCache>(&text)
        .ok()
        .map(|cache| cache.distros)
}

/// 把这次探测结果落盘（尽力而为：写不进去只记日志，不影响这一次的下拉框）。
///
/// 走 `atomic::write_host`：壳被强杀时不能留下半截 JSON，否则下次启动读到坏缓存。
pub fn write_cache(path: &Path, distros: &[DistroInfo]) {
    let fetched_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|span| span.as_secs())
        .unwrap_or(0);
    let cache = DistroCache {
        fetched_at,
        distros: distros.to_vec(),
    };
    let Ok(text) = serde_json::to_string(&cache) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(err) = crate::atomic::write_host(path, text.as_bytes()) {
        eprintln!(
            "[dsharbor] 写 WSL 发行版缓存失败（{}）：{err}",
            path.display()
        );
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 本进程专用的临时目录（与其它模块的测试同一套做法）。
    fn scratch(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("dsharbor-wsl-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn sample() -> Vec<DistroInfo> {
        vec![
            DistroInfo {
                distro: "Ubuntu".to_string(),
                has_node: true,
            },
            DistroInfo {
                distro: "Debian".to_string(),
                has_node: false,
            },
        ]
    }

    #[test]
    fn cache_round_trips_distro_names_and_node_flags() {
        let root = scratch("roundtrip");
        let path = root.join(CACHE_FILE);
        write_cache(&path, &sample());
        assert_eq!(read_cache(&path), Some(sample()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_is_written_as_camel_case_json_with_a_timestamp() {
        // 缓存文件是壳自己的私有格式，但保持 camelCase 与界面上看到的一致，
        // 出问题时能直接打开文件核对。
        let root = scratch("shape");
        let path = root.join(CACHE_FILE);
        write_cache(&path, &sample());
        let text = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(value.get("fetchedAt").and_then(|v| v.as_u64()).is_some());
        assert_eq!(value["distros"][0]["distro"], "Ubuntu");
        assert_eq!(value["distros"][0]["hasNode"], true);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_or_broken_cache_reads_as_none() {
        let root = scratch("missing");
        let path = root.join(CACHE_FILE);
        assert_eq!(read_cache(&path), None, "没有缓存时返回 None");

        std::fs::write(&path, "{ 半截").unwrap();
        assert_eq!(read_cache(&path), None, "坏 JSON 不该让启动失败");

        std::fs::write(&path, r#"{"distros":[]}"#).unwrap();
        assert_eq!(read_cache(&path), None, "缺字段的结构对不上，也当没有缓存");

        std::fs::write(&path, r#"{"fetchedAt":1,"distros":[]}"#).unwrap();
        assert_eq!(read_cache(&path), Some(Vec::new()), "空列表是合法缓存");
        let _ = std::fs::remove_dir_all(&root);
    }
}
