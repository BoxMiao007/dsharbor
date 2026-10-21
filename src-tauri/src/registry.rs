//! 查 npm 上的 DSH 版本清单（配置界面的版本下拉的数据源）。
//!
//! 分两层：解析与排序在核心库（`dsharbor_core::registry`，纯逻辑可测），
//! 这里只负责「在哪个环境里执行 npm」和缓存。
//!
//! 缓存 10 分钟：`npm view` 每次要拉起 node + 一次网络往返（Windows 上约 1 秒，
//! 经 wsl.exe 进发行版更慢），而界面在切运行环境、切启动方式时都会读一次；
//! 缓存让这些切换不卡。代价是刚发布的版本最多晚 10 分钟才出现在下拉里，
//! 对选版本这个场景完全可以接受——界面上的刷新按钮用 `force` 明确要求重查，
//! 绕过这层缓存。

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use dsharbor_core::launch::Runtime;
use dsharbor_core::net::{self, SelfCheckReport};
use dsharbor_core::prefs::{DownloadSource, ShellPrefs};
use dsharbor_core::registry::{self, RegistryInfo};

/// 缓存有效期。
const CACHE_TTL: Duration = Duration::from_secs(600);

/// 单次查询的超时：`npm view` 正常 1~3 秒；冷启动 / 慢网络给足余量，
/// 超时就当失败（界面显示「读不到版本列表」，不阻塞任何操作）。
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);

/// 缓存键：运行环境 + 发行版 + 下载源。Windows 与各发行版里的 npm 是各自独立的
/// registry 视图（代理、镜像配置都可能不同），必须分别缓存；下载源也进键，
/// 切源后就不会命中另一个源的旧清单。
type CacheKey = String;

struct CacheEntry {
    info: RegistryInfo,
    fetched_at: Instant,
}

static CACHE: Mutex<Option<HashMap<CacheKey, CacheEntry>>> = Mutex::new(None);

fn cache_key(runtime: &Runtime, source: DownloadSource) -> CacheKey {
    match runtime {
        Runtime::Default => format!("host:{}", source.as_str()),
        Runtime::Wsl { distro } => format!("wsl:{distro}:{}", source.as_str()),
    }
}

/// 清掉全部缓存。保存下载源之后调用：换了源，旧清单里的版本号来自另一个 registry，
/// 立刻作废；下一次查询就会带上新源重新跑 `npm view`。
pub fn invalidate_all() {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = None;
    }
}

/// 查清单：命中新鲜缓存直接返回；否则跑 `npm view`（带上下载源对应的 registry）。
///
/// `env` 是这次要注入 npm 进程的全部环境变量（下载源 + 代理），由调用方用
/// `net::plan_env` 算好——本函数不再自己拼，三条注入路径因此不会各写一套。
/// `force` 为 true 时跳过新鲜缓存直接重查（界面的刷新按钮：刚发布的版本要立刻可见）。
/// 查询失败时退回该运行环境上一次成功的快照（哪怕已过期）：断网时用户仍能
/// 选回上次见过的版本，而不是面对一个空下拉。
pub fn query(
    runtime: &Runtime,
    source: DownloadSource,
    env: &[(String, String)],
    force: bool,
) -> Result<RegistryInfo, String> {
    let key = cache_key(runtime, source);
    if !force {
        if let Some(info) = cache_get(&key) {
            return Ok(info);
        }
    }
    match run_query(runtime, env) {
        Ok(info) => {
            cache_put(&key, info.clone());
            Ok(info)
        }
        Err(err) => match cache_get_any(&key) {
            // 过期的缓存比「一个版本都列不出来」有用：断网时用户仍能选回上次见过的版本。
            // 刷新按钮也会走到这里：手动重查失败不该让下拉变空。
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
/// 自检的单次超时。
///
/// 比版本查询的 30 秒短：用户点了「测试连接」就坐在那里等结果，
/// 一次几秒、最多两次，再久他只会以为界面卡死了。
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// 「网络」卡的「测试连接」：拿当前下载源与当前代理设置真的跑一次 npm。
///
/// 跑几条由 `net::self_check_plan` 决定（配了代理才有第二跑），
/// 跑完的结果由 `net::self_check_outcome` 归成三态并写中文原因；
/// 这里只负责把命令拉起来，不自己拼任何环境变量或参数。
pub fn self_check(
    runtime: &Runtime,
    prefs: &ShellPrefs,
    source: DownloadSource,
) -> SelfCheckReport {
    let proxy = crate::proxy::resolution(prefs);
    let plan = net::self_check_plan(net::registry_of(source), &proxy);
    let first = run_check(runtime, &plan.first);
    let second = match (&first, &plan.second) {
        // 第一条就通了，那条「去掉代理再试一次」根本不跑。
        (Ok(()), _) => None,
        (Err(_), Some(env)) => Some(run_check(runtime, env)),
        (Err(_), None) => None,
    };
    let outcome = net::self_check_outcome(plan.first_via, first, second);
    net::self_check_report(source, &proxy, &outcome)
}

/// 跑一条自检请求。
///
/// 用的是与真实下载完全相同的命令装配（同一个 `build_command`、同一套
/// `query_args()`），只是把环境变量换成自检这一条要用的那份。
///
/// 退出码 0 就算通，不再去解析输出：`run_capture` 把 stdout 与 stderr 合在了一起，
/// npm 的一句无害警告就会让解析失败，把一个真的通了的连接报成失败。
fn run_check(runtime: &Runtime, env: &[(String, String)]) -> Result<(), String> {
    let command = build_command(runtime, env)?;
    let (code, output) = crate::plugin::run_capture(command, CHECK_TIMEOUT)?;
    check_result(code, &output)
}

/// 把一次自检命令的退出码与输出变成「通 / 不通」。
///
/// 只看退出码：`run_capture` 把 stdout 与 stderr 合在了一起，
/// npm 的一句无害警告（新版本可用、某些旧依赖已废弃）就会让 JSON 解析失败，
/// 把一个真的通了的连接报成失败——比报错更难查。
/// 不通时把整段原始输出带上去，归类那一层会自己取首行。
fn check_result(code: i32, output: &str) -> Result<(), String> {
    if code == 0 {
        return Ok(());
    }
    let trimmed = output.trim();
    Err(if trimmed.is_empty() {
        format!("npm view 执行失败（退出码 {code}）")
    } else {
        trimmed.to_string()
    })
}

fn timeout_error() -> String {
    format!("查询官方版本列表超时（{} 秒）", QUERY_TIMEOUT.as_secs())
}

fn run_query(runtime: &Runtime, env: &[(String, String)]) -> Result<RegistryInfo, String> {
    let mut command = build_command(runtime, env)?;
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
///
/// `extra_env` 决定往子进程环境里塞什么：下载源（选「沿用 npm 全局配置」时那一项根本不出现，
/// 子进程读到的就是用户自己 `.npmrc` 里的源）与代理。都是环境变量覆盖，
/// 不修改用户的任何配置文件。
fn build_command(runtime: &Runtime, extra_env: &[(String, String)]) -> Result<Command, String> {
    npm_command(runtime, &registry::query_args(), extra_env)
}

/// 组装一条任意的 npm 命令（Windows 经 cmd.exe，WSL 经 wsl.exe 进发行版）。
///
/// 与 `build_command` 是同一个装配逻辑，只是把参数从「查版本清单」放开成调用方给的
/// 那串——`dsh_versions` 要用它跑 `npm ls -g` 与 `npm uninstall -g`。`args` 全是
/// 代码里的固定字面量，不经过任何用户输入。
pub(crate) fn npm_command(
    runtime: &Runtime,
    args: &[&str],
    extra_env: &[(String, String)],
) -> Result<Command, String> {
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
            command.envs(extra_env.iter().map(|(key, value)| (key, value)));
            Ok(command)
        }
        Runtime::Wsl { distro } => {
            let mut command = Command::new("wsl.exe");
            command.args(["-d", distro, "--"]);
            let mut env: Vec<(String, String)> = Vec::new();
            // 与启动 DSH 时同一份干净 PATH：清理 /mnt 污染项并补上
            // ~/.local/share/pnpm/bin、~/.local/bin。
            match crate::wsl::clean_path(distro) {
                Ok(path) => {
                    env.push(("PATH".to_string(), path));
                }
                // 取不到干净 PATH 就按原样进发行版，至少还有一次机会。
                Err(err) => eprintln!("[dsharbor] 读取 WSL PATH 失败，直接执行：{err}"),
            }
            // 代理与源一起进 `env K=V`：WSL 里 Command::env 只作用于 Windows 侧进程，
            // 到不了发行版内部，只能拼成 argv 交给 env。
            env.extend_from_slice(extra_env);
            if !env.is_empty() {
                command.arg("env");
                for (key, value) in env {
                    // 值都是 URL / PATH，不含空格也不含引号，`env K=V` 单个 argv 即可。
                    command.arg(format!("{key}={value}"));
                }
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
    use dsharbor_core::net::{self, ProxyResolution};

    /// 代理方案的测试替身：一条地址、一组例外，别去碰开发机真实的系统设置。
    fn proxy(url: &str) -> ProxyResolution {
        ProxyResolution {
            url: Some(url.to_string()),
            bypass: vec!["*.corp.example".to_string()],
            ..ProxyResolution::default()
        }
    }

    #[test]
    fn cache_key_separates_runtimes() {
        assert_eq!(
            cache_key(&Runtime::Default, DownloadSource::Inherit),
            "host:inherit"
        );
        assert_eq!(
            cache_key(
                &Runtime::Wsl {
                    distro: "Ubuntu".into()
                },
                DownloadSource::Inherit
            ),
            "wsl:Ubuntu:inherit"
        );
    }

    #[test]
    fn cache_key_separates_download_sources() {
        // 切源后不能命中另一个源的旧清单：版本号来自不同的 registry。
        let official = cache_key(&Runtime::Default, DownloadSource::Official);
        let mirror = cache_key(&Runtime::Default, DownloadSource::Mirror);
        let inherit = cache_key(&Runtime::Default, DownloadSource::Inherit);
        assert_ne!(official, mirror);
        assert_ne!(official, inherit);
        assert_ne!(mirror, inherit);
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
        let command = build_command(
            &Runtime::Wsl {
                distro: "Ubuntu".into(),
            },
            &[],
        )
        .unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(&args[..3], ["-d", "Ubuntu", "--"]);
        assert_eq!(args[args.len() - 2], "-lc");
        let line = &args[args.len() - 1];
        assert!(line.contains("npm view @deepseek-ai/dsh"), "{line}");
        assert!(line.contains("--json"), "{line}");
    }

    #[test]
    fn wsl_command_passes_the_registry_through_env() {
        // WSL 里没法用 Command::env（那是 Windows 进程的环境），只能拼成
        // `env K=V` 的 argv 夹在 wsl.exe 与 bash 之间。
        let command = build_command(
            &Runtime::Wsl {
                distro: "Ubuntu".into(),
            },
            &net::plan_env(
                net::registry_of(DownloadSource::Official),
                &ProxyResolution::default(),
            ),
        )
        .unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert!(
            args.iter()
                .any(|arg| arg == "npm_config_registry=https://registry.npmjs.org"),
            "{args:?}"
        );
        // 注入项必须在 bash 之前，否则会变成 bash 的参数而不是环境变量。
        let bash_at = args.iter().position(|arg| arg == "bash").unwrap();
        let registry_at = args
            .iter()
            .position(|arg| arg.starts_with("npm_config_registry="))
            .unwrap();
        assert!(registry_at < bash_at, "{args:?}");
    }

    #[test]
    fn host_command_sets_the_registry_env_var_and_inherit_sets_nothing() {
        let official = build_command(
            &Runtime::Default,
            &net::plan_env(
                net::registry_of(DownloadSource::Official),
                &ProxyResolution::default(),
            ),
        )
        .unwrap();
        let envs: Vec<(String, String)> = official
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.unwrap_or_default().to_string_lossy().to_string(),
                )
            })
            .collect();
        assert!(
            envs.contains(&(
                "npm_config_registry".to_string(),
                "https://registry.npmjs.org".to_string()
            )),
            "{envs:?}"
        );

        // 验收标准③：选「沿用」时不下发 registry，行为等同于没有这项功能。
        let inherit = build_command(
            &Runtime::Default,
            &net::plan_env(
                net::registry_of(DownloadSource::Inherit),
                &ProxyResolution::default(),
            ),
        )
        .unwrap();
        assert!(
            inherit
                .get_envs()
                .all(|(key, _)| key.to_string_lossy() != "npm_config_registry"),
            "沿用 npm 全局配置时不该注入 registry"
        );
    }

    #[test]
    fn host_command_carries_the_proxy_alongside_the_source() {
        // 代理与源一起由 plan_env 产出：这条测试盯的是「查询路径也走了同一个计划」。
        let env = net::plan_env(
            net::registry_of(DownloadSource::Official),
            &proxy("http://127.0.0.1:7890"),
        );
        let command = build_command(&Runtime::Default, &env).unwrap();
        let envs: Vec<(String, String)> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.unwrap_or_default().to_string_lossy().to_string(),
                )
            })
            .collect();
        assert!(
            envs.contains(&(
                "npm_config_registry".to_string(),
                "https://registry.npmjs.org".to_string()
            )),
            "{envs:?}"
        );
        assert!(
            envs.contains(&(
                "HTTPS_PROXY".to_string(),
                "http://127.0.0.1:7890".to_string()
            )),
            "{envs:?}"
        );
        let no_proxy = envs
            .iter()
            .find(|(key, _)| key == "NO_PROXY")
            .map(|(_, value)| value.clone())
            .expect("NO_PROXY 应该在计划里");
        assert!(
            no_proxy.starts_with("localhost,127.0.0.1,::1"),
            "{no_proxy}"
        );
        assert!(no_proxy.contains("*.corp.example"), "{no_proxy}");
    }

    #[test]
    fn wsl_command_passes_the_proxy_through_env_args() {
        // 回环例外里含 `::1`，值本身不含空格——WSL 的 `env K=V` argv 才能不转义就传下去。
        let env = net::plan_env(None, &proxy("http://127.0.0.1:7890"));
        let command = build_command(
            &Runtime::Wsl {
                distro: "Ubuntu".into(),
            },
            &env,
        )
        .unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        let bash_at = args.iter().position(|arg| arg == "bash").unwrap();
        let https_at = args
            .iter()
            .position(|arg| arg == "HTTPS_PROXY=http://127.0.0.1:7890")
            .unwrap();
        assert!(https_at < bash_at, "{args:?}");
        // 每个注入项都得是单个 argv（含空格就会被 env 拆坏）。
        for arg in &args[..bash_at] {
            assert!(!arg.contains(' '), "注入项不该含空格：{arg}");
        }
    }

    #[test]
    fn host_command_runs_npm_view_in_json_mode() {
        let command = build_command(&Runtime::Default, &[]).unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert!(args.contains(&"view".to_string()), "{args:?}");
        assert!(args.contains(&"--json".to_string()), "{args:?}");
        assert!(args.contains(&"versions".to_string()), "{args:?}");
        assert!(args.contains(&"dist-tags".to_string()), "{args:?}");
    }

    #[test]
    fn a_zero_exit_counts_as_reachable_even_with_warnings_on_stderr() {
        // `run_capture` 把 stdout 与 stderr 合并了：npm 的「有新版本」之类警告
        // 不应把一次真的通了的连接报成失败，所以这里不看输出只看出码。
        assert!(check_result(0, "npm warn deprecated foo@1.0.0").is_ok());
        assert!(check_result(0, "").is_ok());
    }

    #[test]
    fn a_failing_pass_carries_the_raw_output_for_classification() {
        let err = check_result(
            1,
            "npm error code ENOTFOUND\nnpm error network getaddrinfo ENOTFOUND registry.npmjs.org\n",
        )
        .expect_err("非零退出码就是不通");
        // 首尾空白要削掉，不然拼进界面会多一行空行。
        assert!(err.starts_with("npm error code ENOTFOUND"), "{err}");
        assert!(!err.ends_with('\n'), "{err:?}");
    }

    #[test]
    fn a_silent_failure_still_says_something() {
        // 被杀掉的进程 / 什么也没打印的失败：至少得告诉用户退出码。
        let err = check_result(1, "   \n").expect_err("非零退出码就是不通");
        assert!(err.contains("退出码 1"), "{err}");
    }

    #[test]
    fn the_two_passes_are_ordered_proxy_then_direct_when_a_proxy_is_set() {
        // 自检的第一跑必须与真实下载同一条路，否则「通了」不能证明下载能成。
        let resolved = proxy("http://127.0.0.1:7890");
        let plan = net::self_check_plan(net::registry_of(DownloadSource::Mirror), &resolved);
        assert_eq!(plan.first_via, net::CheckVia::Proxy);
        assert!(plan
            .first
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("https_proxy")));
        let second = plan.second.expect("第一跑失败后要去掉代理再试一次");
        assert!(!second.iter().any(|(key, _)| key.contains("proxy")));
        // 两跑都能拿这个 env 拼出真命令（防止只测了纯函数、接不上真命令）。
        assert!(build_command(&Runtime::Default, &plan.first).is_ok());
        assert!(build_command(&Runtime::Default, &second).is_ok());
    }

    #[test]
    fn a_bypassed_source_runs_a_single_direct_pass() {
        // 例外列表已覆盖的域名：真实下载本来就是直连，跑两遍没意义。
        let resolved = ProxyResolution {
            url: Some("http://127.0.0.1:7890".to_string()),
            bypass: vec!["*.npmmirror.com".to_string()],
            ..ProxyResolution::default()
        };
        let plan = net::self_check_plan(net::registry_of(DownloadSource::Mirror), &resolved);
        assert_eq!(plan.first_via, net::CheckVia::Direct);
        assert!(plan.second.is_none());
    }
}
