//! 查 npm 上的 DSH 渠道 / 版本清单（配置界面的渠道下拉与版本下拉的数据源）。
//!
//! 分两层：解析与排序在核心库（`dsharbor_core::registry`，纯逻辑可测），
//! 这里只负责「在哪个环境里执行 npm」和缓存。
//!
//! 缓存 10 分钟：`npm view` 每次要拉起 node + 一次网络往返（Windows 上约 1 秒，
//! 经 wsl.exe 进发行版更慢），而界面在切运行环境、切启动方式时都会读一次；
//! 缓存让这些切换不卡。代价是刚发布的版本最多晚 10 分钟才出现在下拉里，
//! 对选版本这个场景完全可以接受——真需要的用户点「重新读取」即可。

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use dsharbor_core::launch::Runtime;
use dsharbor_core::registry::{self, RegistryInfo};

/// 缓存有效期。
const CACHE_TTL: Duration = Duration::from_secs(600);

/// 单次查询的超时：`npm view` 正常 1~3 秒；冷启动 / 慢网络给足余量，
/// 超时就当失败（界面显示「读不到版本列表」，不阻塞任何操作）。
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);

/// 缓存键：运行环境 + 发行版。Windows 与各发行版里的 npm 是各自独立的
/// registry 视图（代理、镜像配置都可能不同），必须分别缓存。
type CacheKey = String;

struct CacheEntry {
    info: RegistryInfo,
    fetched_at: Instant,
}

static CACHE: Mutex<Option<HashMap<CacheKey, CacheEntry>>> = Mutex::new(None);

fn cache_key(runtime: &Runtime) -> CacheKey {
    match runtime {
        Runtime::Default => "host".to_string(),
        Runtime::Wsl { distro } => format!("wsl:{distro}"),
    }
}

/// 查清单：命中新鲜缓存直接返回；否则跑 `npm view`。
///
/// 查询失败时退回该运行环境上一次成功的快照（哪怕已过期）：断网时用户仍能
/// 选回上次见过的版本，而不是面对一个空下拉。
pub fn query(runtime: &Runtime) -> Result<RegistryInfo, String> {
    let key = cache_key(runtime);
    if let Some(info) = cache_get(&key) {
        return Ok(info);
    }
    match run_query(runtime) {
        Ok(info) => {
            cache_put(&key, info.clone());
            Ok(info)
        }
        Err(err) => match cache_get_any(&key) {
            // 过期的缓存比「一个版本都列不出来」有用：断网时用户仍能选回上次见过的版本。
            Some(stale) => {
                eprintln!("[dsharbor] 读取官方版本列表失败，退回缓存：{err}");
                Ok(stale)
            }
            None => Err(err),
        },
    }
}

fn cache_get(key: &str) -> Option<RegistryInfo> {
    let guard = CACHE.lock().ok()?;
    let map = guard.as_ref()?;
    let entry = map.get(key)?;
    if entry.fetched_at.elapsed() < CACHE_TTL {
        Some(entry.info.clone())
    } else {
        None
    }
}

/// 不看有效期，取该键下最后一次成功的快照（查询失败时的兜底）。
fn cache_get_any(key: &str) -> Option<RegistryInfo> {
    let guard = CACHE.lock().ok()?;
    let map = guard.as_ref()?;
    map.get(key).map(|entry| entry.info.clone())
}

fn cache_put(key: &str, info: RegistryInfo) {
    if let Ok(mut guard) = CACHE.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(
            key.to_string(),
            CacheEntry {
                info,
                fetched_at: Instant::now(),
            },
        );
    }
}

/// 真的去跑一次 `npm view`。
///
/// 走与启动 DSH 同一条 PATH 注入（WSL 下先取发行版的干净 PATH）：否则发行版里
/// 那份 npm 可能压根不在 PATH 上，或者直接误用 Windows 版 npm。
fn timeout_error() -> String {
    format!("查询官方版本列表超时（{} 秒）", QUERY_TIMEOUT.as_secs())
}

fn run_query(runtime: &Runtime) -> Result<RegistryInfo, String> {
    let mut command = build_command(runtime)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::launcher::apply_no_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("启动 npm 查询失败：{err}（请确认已安装 Node.js）"))?;

    // 逐行收集 stdout：与启动器同一套编码嗅探（Windows 上 npm 输出可能有编码变化）。
    // 先把 stdout/stderr 的读线程变成独立线程，再在主线程里盯进程退出与超时：
    // 读线程只能告知 EOF，不能保证进程真的退出（Windows 上 `cmd /C npm` 后面还有
    // 一层 node），所以等进程结束必须单独做，且同样要受 deadline 约束。
    let (sender, receiver) = mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        crate::launcher::spawn_line_reader(stdout, move |line| {
            let _ = sender.send(line);
        });
    }
    // stderr 单独收：npm 的报错（ENOTFOUND、E404）比空 stdout 有用得多。
    let (err_sender, err_receiver) = mpsc::channel::<String>();
    if let Some(stderr) = child.stderr.take() {
        crate::launcher::spawn_line_reader(stderr, move |line| {
            let _ = err_sender.send(line);
        });
    }

    let deadline = Instant::now() + QUERY_TIMEOUT;
    let mut output = String::new();
    // 是否真的等到了 deadline。不能用「读完后 child 还活着」来判断超时：
    // 读线程看到 EOF 的时刻总比进程真正退出早一点点（Windows 上 `cmd /C npm`
    // 后面还有一层 node），那一瞬间 try_wait 必然返回 None，每次都会误判成超时。
    let mut timed_out = false;
    loop {
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(line) => {
                output.push_str(&line);
                output.push('\n');
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                timed_out = true;
                break;
            }
        }
    }
    let mut error_output = String::new();
    while let Ok(line) = err_receiver.try_recv() {
        error_output.push_str(&line);
        error_output.push('\n');
    }

    if timed_out {
        // 超时：查询进程不该留活口（npm 可能卡在网络重试上）。
        let _ = crate::launcher::kill_tree(child.id());
        return Err(timeout_error());
    }
    // stdout 关闭了不代表进程已结束（`cmd /C npm` 后面还有一层 node）：
    // 同样用 deadline 轮询，不让它无限占着一个 blocking 线程。
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(err) => return Err(format!("等待 npm 查询结束失败：{err}")),
        }
        if Instant::now() >= deadline {
            let _ = crate::launcher::kill_tree(child.id());
            return Err(timeout_error());
        }
        std::thread::sleep(Duration::from_millis(120));
    };
    if !status.success() && output.trim().is_empty() {
        let detail = error_output.trim();
        let detail = if detail.is_empty() {
            "npm view 执行失败".to_string()
        } else {
            detail.lines().next().unwrap_or(detail).to_string()
        };
        return Err(format!("读取官方版本列表失败：{detail}"));
    }
    registry::parse(&output)
}

/// 组装查询命令：Windows 直接跑 npm；WSL 经 wsl.exe 在发行版里跑。
fn build_command(runtime: &Runtime) -> Result<Command, String> {
    let args = registry::query_args();
    match runtime {
        Runtime::Default => {
            let mut command = if cfg!(windows) {
                // npm 在 Windows 上是 `npm.cmd`，必须经 cmd.exe 才能拉起
                // （直接 CreateProcess 一个 .cmd 会得到「不是有效的应用程序」）。
                let mut command = Command::new("cmd");
                command.args(["/C", "npm"]);
                command
            } else {
                Command::new("npm")
            };
            command.args(args);
            Ok(command)
        }
        Runtime::Wsl { distro } => {
            let mut command = Command::new("wsl.exe");
            command.args(["-d", distro, "--"]);
            // 与启动 DSH 时同一份干净 PATH：清理 /mnt 污染项并补上
            // ~/.local/share/pnpm/bin、~/.local/bin。
            match crate::wsl::clean_path(distro) {
                Ok(path) => {
                    command.arg("env").arg(format!("PATH={path}"));
                }
                // 取不到干净 PATH 就按原样进发行版，至少还有一次机会。
                Err(err) => eprintln!("[dsharbor] 读取 WSL PATH 失败，直接执行：{err}"),
            }
            command.args(["bash", "-lc"]);
            // 一整条命令作为单个 argv 传给 bash -lc：npm 与参数都是固定字面量，
            // 不经过任何用户输入。
            command.arg(format!("npm {}", args.join(" ")));
            Ok(command)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_separates_runtimes() {
        assert_eq!(cache_key(&Runtime::Default), "host");
        assert_eq!(
            cache_key(&Runtime::Wsl {
                distro: "Ubuntu".into()
            }),
            "wsl:Ubuntu"
        );
    }

    #[test]
    fn expired_cache_is_still_used_as_fallback() {
        // 断网时「上次见过的版本」比空下拉有用：过期条目不当新鲜命中，
        // 但查询失败时要能拿来兜底。
        let key = "test:expired";
        let old = Instant::now()
            .checked_sub(CACHE_TTL + Duration::from_secs(60))
            .expect("Instant 支持回退到一小时前");
        {
            let mut guard = CACHE.lock().unwrap();
            guard.get_or_insert_with(HashMap::new).insert(
                key.to_string(),
                CacheEntry {
                    info: RegistryInfo::default(),
                    fetched_at: old,
                },
            );
        }
        assert!(cache_get(key).is_none(), "过期条目不该算命中");
        assert!(cache_get_any(key).is_some(), "查询失败时要能用过期条目兜底");
    }

    #[test]
    fn wsl_command_injects_clean_path_and_runs_npm() {
        // 只校验参数结构，不真的执行（开发机上不一定装了 WSL）。
        let command = build_command(&Runtime::Wsl {
            distro: "Ubuntu".into(),
        })
        .unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(&args[..3], ["-d", "Ubuntu", "--"]);
        assert_eq!(args.last().map(String::as_str), Some("bash"));
        let line = args.last().map(String::as_str).unwrap_or_default();
        assert_eq!(args[args.len() - 2], "-lc");
        assert!(
            args[args.len() - 1].contains("npm view @deepseek-ai/dsh"),
            "{line}"
        );
        assert!(args[args.len() - 1].contains("--json"));
    }

    #[test]
    fn host_command_runs_npm_view_in_json_mode() {
        let command = build_command(&Runtime::Default).unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert!(args.contains(&"view".to_string()), "{args:?}");
        assert!(args.contains(&"--json".to_string()), "{args:?}");
        assert!(args.contains(&"versions".to_string()), "{args:?}");
        assert!(args.contains(&"dist-tags".to_string()), "{args:?}");
    }
}
