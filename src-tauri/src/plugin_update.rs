//! 第三方插件的检查更新与升级（系统相关部分）。
//!
//! 纯规则（更新范围、包名校验、目标版本、新旧比较）在 `dsharbor_core::plugin_update`；
//! 这里做系统相关的事：读各插件已装版本（宿主直读 / WSL 经 wsl.exe）、跑
//! `npm view` 查目标版本（会话级缓存）、复用官方插件安装链路执行更新、装完回读
//! 磁盘确认版本真的换了。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use dsharbor_core::launch::{self, LaunchConfig};
use dsharbor_core::plugin_switch;
use dsharbor_core::plugin_update::{self, PluginUpdateItem};
use dsharbor_core::prefs::DownloadSource;
use serde::Serialize;
use tauri::ipc::Channel;

use crate::plugin::{self, Target};
use crate::registry;

/// 已装版本与读取失败原因（二选一有值：成功时原因是 `None`，失败时版本是 `None`）。
type InstalledVersion = (Option<String>, Option<String>);

/// 修锁文件那一步的超时：只是按现存依赖重解析元数据，不需要重下整棵依赖树。
const LOCKFILE_REPAIR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// 读一个插件已装版本：`node_modules/<name>/package.json` 的 `version` 字段。
///
/// 目录缺失、坏 JSON、缺 `version` 字段都算读失败——这种情况不给更新按钮，
/// 行上显示失败原因，免得拿「未知版本」误判该不该升。
fn read_installed(target: &Target, dir: &str, name: &str) -> InstalledVersion {
    let path = plugin::join_path(target, dir, &format!("node_modules/{name}/package.json"));
    let text = match plugin::read_file(target, &path) {
        Ok(text) => text,
        Err(err) => return (None, Some(format!("读不到已装版本：{err}"))),
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(err) => {
            return (
                None,
                Some(format!("已装版本的 package.json 不是合法 JSON：{err}")),
            )
        }
    };
    match value.get("version").and_then(|v| v.as_str()) {
        Some(version) if !version.trim().is_empty() => (Some(version.to_string()), None),
        _ => (
            None,
            Some("已装版本的 package.json 里没有 version 字段".to_string()),
        ),
    }
}

/// 把「已装版本 + registry 查询结果」装配成一行检查结果（纯逻辑，便于测试）。
///
/// `current` 是 [`read_installed`] 的产物；`latest` 是目标版本（`Ok(None)` 表示
/// registry 上没有可用版本）或查询失败原因。查询失败的原因优先展示——用户先
/// 要知道「为什么没查成」，其次才是「有没有更新」。
fn assemble(
    name: &str,
    current: InstalledVersion,
    latest: Result<Option<String>, String>,
) -> PluginUpdateItem {
    let (current_version, current_error) = current;
    let mut item = PluginUpdateItem {
        name: name.to_string(),
        current: current_version,
        target: None,
        error: None,
        has_update: false,
    };
    match latest {
        Err(err) => item.error = Some(err),
        Ok(None) => item.error = Some("registry 上查不到这个包的任何版本".to_string()),
        Ok(Some(target)) => {
            item.target = Some(target.clone());
            // 已装版本读不到时不猜「有没有更新」：不给按钮，把原因亮出来。
            if let Some(current) = &item.current {
                item.has_update = plugin_update::is_newer(&target, current);
            } else {
                item.error = current_error;
            }
        }
    }
    item
}

/// 会话级检查缓存的键：运行环境 + 下载源 + 包名。
///
/// 换环境（宿主/WSL）、换下载源都各查各的；包名必带——同一插件在两个环境里
/// 装的版本可以不同。
fn check_cache_key(runtime: &launch::Runtime, source: DownloadSource, name: &str) -> String {
    let base = match runtime {
        launch::Runtime::Default => format!("host:{}", source.as_str()),
        launch::Runtime::Wsl { distro } => format!("wsl:{distro}:{}", source.as_str()),
    };
    format!("{base}:{name}")
}

/// 检查结果的会话缓存（键见 [`check_cache_key`]，值 = 目标版本或失败原因）。
///
/// 不设时间 TTL：同一插件本次使用会话内只在第一次进插件卡时查一次，之后由
/// 「检查更新」按钮 `force` 重查；更新成功后把对应条目挪掉，让收尾重查真的
/// 发网络、看到装好的新版本。
type CheckCache = HashMap<String, Result<Option<String>, String>>;

fn check_cache() -> &'static Mutex<CheckCache> {
    static CACHE: OnceLock<Mutex<CheckCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 查一个插件在 registry 上的目标版本（会话缓存优先，`force` 绕过）。
///
/// 失败也缓存：断网或私有包 404 不值得每个动作都重打一次网络；界面上的
/// 「检查更新」随时可以强制重查。
fn query_latest(
    runtime: &launch::Runtime,
    source: DownloadSource,
    env: &[(String, String)],
    name: &str,
    force: bool,
) -> Result<Option<String>, String> {
    let key = check_cache_key(runtime, source, name);
    if !force {
        if let Ok(cache) = check_cache().lock() {
            if let Some(hit) = cache.get(&key) {
                return hit.clone();
            }
        }
    }
    let result = query_registry(runtime, env, name);
    if let Ok(mut cache) = check_cache().lock() {
        cache.insert(key, result.clone());
    }
    result
}

/// 插件版本查询的 npm view 参数。单独提成函数是为了在测试里断言参数结构：
/// 包名会拼进 WSL 的 bash 整行（见 registry::npm_command），这里多拼一个字符都是注入面。
fn plugin_view_args(name: &str) -> [&str; 5] {
    ["view", name, "dist-tags", "versions", "--json"]
}

/// 真发一次 `npm view <name> dist-tags versions --json` 并选目标版本。
fn query_registry(
    runtime: &launch::Runtime,
    env: &[(String, String)],
    name: &str,
) -> Result<Option<String>, String> {
    // 包名会拼进 WSL 的 bash 整行（见 registry::npm_command），必须先过滤。
    plugin_update::validate_package_name(name)?;
    let args = plugin_view_args(name);
    let label = format!("插件「{name}」的版本列表");
    let info = registry::run_view(runtime, env, &args, &label)?;
    Ok(plugin_update::target_version(&info.versions))
}

/// 更新完把会话缓存里的旧目标版本挪掉：界面收尾重查会真发网络、看到装上的新版本。
fn forget_check(runtime: &launch::Runtime, source: DownloadSource, name: &str) {
    let key = check_cache_key(runtime, source, name);
    if let Ok(mut cache) = check_cache().lock() {
        cache.remove(&key);
    }
}

/// 装完回读磁盘，确认 node_modules 里的版本真的换成了目标版本。
///
/// 官方 plugin add 退出码 0 不代表装上了（版本没换时 pnpm 也可能静默成功），
/// 这是 DSH-X 实测过的坑，必须回读校验。
fn verify_installed_version(
    target: &Target,
    dir: &str,
    name: &str,
    expected: &str,
) -> Result<(), String> {
    let (version, error) = read_installed(target, dir, name);
    match version {
        Some(found) if found == expected => Ok(()),
        Some(found) => Err(format!(
            "校验失败：装上的版本是 {found}，不是目标版本 {expected}"
        )),
        None => Err(format!(
            "校验失败：{}",
            error.unwrap_or_else(|| "已装版本读不出来".to_string())
        )),
    }
}

/// 把一批「包名 → 更新结果」折成一段给维护者看的汇总（失败只留首行，长输出走日志）。
fn summarize_results(results: &[(String, Result<String, String>)]) -> String {
    if results.is_empty() {
        return "没有需要更新的插件。".to_string();
    }
    let ok: Vec<String> = results
        .iter()
        .filter_map(|(name, r)| r.as_ref().ok().map(|v| format!("{name}@{v}")))
        .collect();
    let bad: Vec<String> = results
        .iter()
        .filter_map(|(name, r)| {
            r.as_ref()
                .err()
                .map(|e| format!("{name}：{}", e.lines().next().unwrap_or(e.as_str())))
        })
        .collect();
    let mut text = if bad.is_empty() {
        format!("全部更新完成：成功 {} 个（{}）。", ok.len(), ok.join("、"))
    } else {
        format!(
            "更新完成：成功 {} 个（{}）；失败 {} 个（{}）。",
            ok.len(),
            ok.join("、"),
            bad.len(),
            bad.join("；")
        )
    };
    text.push_str("重启 DSH 后生效。");
    text
}

/// 更新结果（单个或批量共用）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    pub ok: bool,
    pub message: String,
    pub backup_dir: String,
}

/// 批量更新的逐行进度事件，只在「全部更新」（`name = None`）时经可选进度通道发出。
///
/// 与前端 `interface UpdateProgressEvent`（`src/main.ts`）成对维护：界面据 `phase`
/// 把对应那一行渲染成 排队 / 更新中 / 已更新 / 失败，并用 `index / total` 推进顶部
/// 确定进度条。单插件更新不走这条通道，只用命令返回值，避免两个状态来源。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    /// 阶段：`"start"` 这一行开始更新，`"done"` 这一行已结束（成功或失败）。
    pub phase: &'static str,
    /// 这一行是第几个（从 1 开始）。
    pub index: usize,
    /// 本轮一共要更新几个。
    pub total: usize,
    /// 插件包名，对应界面里 `[data-row]` 的行。
    pub plugin: String,
    /// `done` 时是否成功；`start` 时为 `None`。
    pub ok: Option<bool>,
    /// `done` 时的结果说明（成功是版本提示，失败是错误首行）。
    pub message: Option<String>,
}

/// 发一条进度事件；通道只是界面提示，发送失败（窗口关了、页面已走）不影响更新本身。
fn send_progress(progress: Option<&Channel<ProgressEvent>>, event: ProgressEvent) {
    if let Some(channel) = progress {
        let _ = channel.send(event);
    }
}

/// 跑一次插件安装/卸载命令；输出显示环境锁文件坏了就先修锁文件再重跑一次。
///
/// DSH 的 plugin 命令把 pnpm 当外部命令直接 exec，`pnpm add` 在装包之前就会因为
/// 环境自己的 `pnpm-lock.yaml` 断裂而退出（`ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`）。
/// 这跟「这个包装不上」是两件事，壳替它补一步 `pnpm install --fix-lockfile` 再重跑，
/// 而不是把 pnpm 的原始报错原样丢给用户。
///
/// 返回（退出码，输出，修复说明）。修复动作为空表示没触发；触发了但没修好也会
/// 留一句原因，界面回执要能让用户知道壳查过这一步。
fn run_plugin_op(
    config: &LaunchConfig,
    profile: &str,
    op: &launch::PluginOp,
    env: &[(String, String)],
) -> Result<(i32, String, Option<String>), String> {
    let command = plugin::plugin_command(config, profile, op, env)?;
    let (code, output) = plugin::run_capture(command, plugin::PLUGIN_OP_TIMEOUT)?;
    if code == 0 || !plugin_update::lockfile_needs_repair(&output) {
        return Ok((code, output, None));
    }
    match repair_lockfile(config, profile, env) {
        Ok((0, _repair_output)) => {
            let retry = plugin::plugin_command(config, profile, op, env)?;
            let (retry_code, retry_output) = plugin::run_capture(retry, plugin::PLUGIN_OP_TIMEOUT)?;
            Ok((
                retry_code,
                retry_output,
                Some("锁文件已按现存依赖重修（pnpm install --fix-lockfile）".to_string()),
            ))
        }
        Ok((repair_code, repair_output)) => Ok((
            code,
            output,
            Some(format!(
                "锁文件自动修复失败（退出码 {repair_code}）：{}",
                plugin::tail_chars(&repair_output, 600)
            )),
        )),
        // 起不来 pnpm（没装 / 不在 PATH）就照原样报下去，别把真实失败原因盖掉。
        Err(err) => Ok((code, output, Some(format!("锁文件自动修复没能执行：{err}")))),
    }
}

/// 修环境自己的 `pnpm-lock.yaml`（`pnpm install --fix-lockfile`）。
///
/// 只在 [`plugin_update::lockfile_needs_repair`] 判为锁文件损坏时调用：DSH 的
/// plugin 命令把 pnpm 当外部命令直接 exec，不会自救，壳替它补这一步。
/// 在环境目录里跑（`current_dir` / `cd`），命令与参数全是固定字面量。
/// 返回（退出码，输出）；失败不致命——调用方会照原样把后续更新的真实报错交给用户。
fn repair_lockfile(
    config: &LaunchConfig,
    profile: &str,
    env: &[(String, String)],
) -> Result<(i32, String), String> {
    let target = Target::of(config);
    let dir = plugin::profile_dir(&target, profile)?;
    let command = registry::pnpm_command(
        launch::runtime_of(config),
        &["install", "--lockfile-only", "--fix-lockfile"],
        env,
        Some(&dir),
    )?;
    plugin::run_capture(command, LOCKFILE_REPAIR_TIMEOUT)
}

/// 更新单个第三方插件到 registry 上的目标版本。成功返回（装上的版本，备份目录）。
///
/// 目标版本以会话缓存（没有就现查）为准，界面传来的按钮状态不参与决策；
/// 磁盘上读不到已装版本或没有更新时拒绝执行。
fn update_one(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    profile: &str,
    source: DownloadSource,
    name: &str,
) -> Result<(String, String), String> {
    if !plugin_update::in_update_scope(name) {
        return Err("官方内置包与桥接插件不适用在线更新".to_string());
    }
    plugin_update::validate_package_name(name)?;
    let target = Target::of(config);
    let dir = plugin::profile_dir(&target, profile)?;
    let (current, current_error) = read_installed(&target, &dir, name);
    let current = match current {
        Some(version) => version,
        None => return Err(current_error.unwrap_or_else(|| "读不到已装版本".to_string())),
    };
    let prefs = crate::settings::load(app).prefs;
    let env = crate::proxy::child_env(&prefs, source);
    let runtime = launch::runtime_of(config);
    let latest = query_latest(runtime, source, &env, name, false)?
        .ok_or_else(|| "registry 上查不到这个包的任何版本".to_string())?;
    if !plugin_update::is_newer(&latest, &current) {
        return Err(format!("已是最新版本 {current}"));
    }

    // 备份 → 官方 plugin add「包名@目标版本」→ 回读校验，与桥接安装同一套链路。
    let backup = plugin::backup_profile(app, &target, profile)?;
    let package = format!("{name}@{latest}");
    let op = launch::PluginOp::Install {
        package: package.clone(),
    };
    let command_line = plugin::plugin_command_line(config, profile, &op).unwrap_or_else(|_| {
        format!(
            "dsh plugin --profile {} add {package}",
            plugin::cli_profile_label(profile)
        )
    });
    let (code, output, repaired) = run_plugin_op(config, profile, &op, &env)?;
    let verify = verify_installed_version(&target, &dir, name, &latest);
    let ok = code == 0 && verify.is_ok();
    if ok {
        forget_check(runtime, source, name);
    }
    let verify_text = match &verify {
        Ok(()) => format!("版本已换成 {latest} ✓"),
        Err(err) => format!("{err} ✗"),
    };
    // 首行必须能直接定位问题：命令退了非零就给退出码 + CLI 报错摘要，
    // 命令退了零但校验不过就给校验原因；其余细节（完整命令、输出、备份）
    // 挪到后面——界面失败行与汇总只取首行，报错被埋在末尾等于看不见。
    //
    // 锁文件坏了要单独说清：报错原文是「装上的版本没变」，用户会以为是包的问题，
    // 实际是环境里 pnpm-lock.yaml 的 importers 与 packages 两段脱节。
    let lockfile_broken = plugin_update::lockfile_needs_repair(&output);
    let first_line = match (&verify, code) {
        (Err(err), _) if lockfile_broken => format!(
            "环境的依赖锁文件坏了（pnpm-lock.yaml 与已装依赖对不上），装在装之前就失败：{err}（退出码 {code}）：{}",
            cli_error_digest(&output)
        ),
        (Err(err), _) => format!("已执行但校验未过：{err}（退出码 {code}）"),
        (Ok(()), code) => format!(
            "更新命令失败（退出码 {code}）：{}",
            cli_error_digest(&output)
        ),
    };
    // 自动修复这一步做了什么要写进回执：修好了用户不用管，没修好也得知道查过什么。
    let repair_note = match &repaired {
        Some(note) => format!("\n{}", note),
        None => String::new(),
    };
    let message = format!(
        "{first_line}\n\
         命令：{command_line}（经 {}）\n\
         校验：{verify_text}{repair_note}\n\
         输出：\n{}\n\
         备份目录：{}{}",
        target.label(),
        plugin::tail_chars(&output, 4000),
        backup.dir,
        plugin::prune_note(&backup.pruned)
    );
    if ok {
        Ok((latest, backup.dir))
    } else {
        eprintln!("[plugin-update] {name} 更新失败：\n{message}");
        Err(message)
    }
}

/// 从 CLI 输出里抓最像报错的一段做摘要：从末尾往前找报错头（pnpm/npm 的
/// `Error:`/`×`/`ERR_` 与中文「失败」），从那一行起拼到输出结束；找不到就落回
/// 最后一个非空行。只用于失败首行，压成一行并截断——完整输出仍留在「输出：」块里。
fn cli_error_digest(output: &str) -> String {
    let lines: Vec<&str> = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines
        .iter()
        .rposition(|line| {
            line.starts_with("Error")
                || line.starts_with('×')
                || line.starts_with("ERR_")
                || line.contains("失败")
        })
        .unwrap_or(lines.len().saturating_sub(1));
    let mut text = lines[start.min(lines.len())..].join(" ");
    if text.chars().count() > 240 {
        text = text.chars().take(240).collect();
    }
    text
}

/// 更新单个（`name=Some`）或全部有更新的第三方插件（`name=None`，逐个执行、
/// 单个失败不影响其余）。
///
/// `progress` 只用于批量：每开一个插件发一条 `start`、跑完发一条 `done`；
/// 单个插件更新的结果只从返回值读，不并发两条状态来源。
pub fn update(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    profile: &str,
    source: DownloadSource,
    name: Option<&str>,
    progress: Option<&Channel<ProgressEvent>>,
) -> Result<UpdateOutcome, String> {
    match name {
        Some(name) => {
            let (version, backup_dir) = update_one(app, config, profile, source, name)?;
            Ok(UpdateOutcome {
                ok: true,
                message: format!("已把「{name}」更新到 {version}。重启 DSH 后生效。"),
                backup_dir,
            })
        }
        None => {
            let rows = list(app, config, profile, source, false)?;
            let worklist: Vec<String> = rows
                .iter()
                .filter(|item| item.has_update)
                .map(|item| item.name.clone())
                .collect();
            let total = worklist.len();
            let mut results: Vec<(String, Result<String, String>)> = Vec::new();
            let mut backup_dir = String::new();
            for (offset, name) in worklist.iter().enumerate() {
                let index = offset + 1;
                send_progress(
                    progress,
                    ProgressEvent {
                        phase: "start",
                        index,
                        total,
                        plugin: name.clone(),
                        ok: None,
                        message: None,
                    },
                );
                let outcome = update_one(app, config, profile, source, name);
                let event = match &outcome {
                    Ok((version, dir)) => {
                        if backup_dir.is_empty() {
                            backup_dir = dir.clone();
                        }
                        results.push((name.clone(), Ok(version.clone())));
                        ProgressEvent {
                            phase: "done",
                            index,
                            total,
                            plugin: name.clone(),
                            ok: Some(true),
                            message: Some(format!("已更新到 {version}")),
                        }
                    }
                    Err(err) => {
                        results.push((name.clone(), Err(err.clone())));
                        ProgressEvent {
                            phase: "done",
                            index,
                            total,
                            plugin: name.clone(),
                            ok: Some(false),
                            message: Some(err.lines().next().unwrap_or(err.as_str()).to_string()),
                        }
                    }
                };
                send_progress(progress, event);
            }
            let ok = results.iter().all(|(_, r)| r.is_ok());
            Ok(UpdateOutcome {
                ok,
                message: summarize_results(&results),
                backup_dir,
            })
        }
    }
}

/// 检查更新一次最多同时发出的 `npm view` 条数。
///
/// 检查是纯只读（不写清单、不装包），每条查询是独立子进程，会话缓存与
/// registry 版本缓存都只在短锁内读写，4 路并发对 registry 与本机 npm 缓存
/// 都安全；批量「全部更新」不走这条路径，保持串行——并发 `pnpm add` 会争
/// 环境的 pnpm-lock.yaml。
const CHECK_CONCURRENCY: usize = 4;

/// 把 `total` 个槽位切成不超过 [`CHECK_CONCURRENCY`] 段的连续区间
/// （空表返回空），段与段互不重叠、按顺序恰好盖满 `0..total`。
fn chunk_bounds(total: usize) -> Vec<(usize, usize)> {
    if total == 0 {
        return Vec::new();
    }
    let chunk = total.div_ceil(total.min(CHECK_CONCURRENCY));
    (0..total)
        .step_by(chunk)
        .map(|start| (start, (start + chunk).min(total)))
        .collect()
}

/// 检查单个插件（并发 worker 里跑的那份工作）：读已装版本 + 查目标版本
/// （会话缓存优先）+ 装配结果行。包名不安全（正常登记不会这样）就亮错误行，
/// 不拿它拼路径、拼命令。
fn check_one(
    target: &Target,
    dir: &str,
    runtime: &launch::Runtime,
    source: DownloadSource,
    env: &[(String, String)],
    name: &str,
    force: bool,
) -> PluginUpdateItem {
    if let Err(err) = plugin_update::validate_package_name(name) {
        return PluginUpdateItem {
            name: name.to_string(),
            current: None,
            target: None,
            error: Some(err),
            has_update: false,
        };
    }
    let current = read_installed(target, dir, name);
    let latest = query_latest(runtime, source, env, name, force);
    assemble(name, current, latest)
}

/// 检查一个环境全部第三方插件的更新，按登记顺序返回一行一个结果。
///
/// 会话级缓存优先（`force` 绕过）：同一插件本次使用会话内只在第一次进插件卡
/// 时查一次，之后由界面「检查更新」按钮强制重查。官方内置骨架包与桥接插件
/// 不在清单里（[`plugin_update::in_update_scope`]），整表读不到清单时直接报错。
/// 查询最多 [`CHECK_CONCURRENCY`] 路并发跑（见该常量的安全论证），结果仍按
/// 清单登记顺序返回。
pub fn list(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    profile: &str,
    source: DownloadSource,
    force: bool,
) -> Result<Vec<PluginUpdateItem>, String> {
    let target = Target::of(config);
    let dir = plugin::profile_dir(&target, profile)?;
    let manifest = plugin::read_file(&target, &plugin::join_path(&target, &dir, "package.json"))
        .map_err(|err| format!("读不到环境「{profile}」的清单：{err}"))?;
    let bundles = plugin_switch::bundle_names(&manifest)
        .map_err(|err| format!("环境「{profile}」的清单读不出来：{err}"))?;
    // 下载源用界面这次传的（它才是权威），代理用已保存的设置——与官方版本查询同一份口径。
    let prefs = crate::settings::load(app).prefs;
    let env = crate::proxy::child_env(&prefs, source);
    let runtime = launch::runtime_of(config);
    let names: Vec<&str> = bundles
        .iter()
        .filter(|name| plugin_update::in_update_scope(name))
        .map(String::as_str)
        .collect();
    let mut slots: Vec<Option<PluginUpdateItem>> = vec![None; names.len()];
    // 共享引用先定形：move 闭包挪走的只是这些引用，target/dir/env 本体留在原地。
    let target = &target;
    let dir = &dir;
    let env = &env;
    std::thread::scope(|scope| {
        let mut pending_names = &names[..];
        let mut pending_slots = &mut slots[..];
        for (start, end) in chunk_bounds(names.len()) {
            let width = end - start;
            let (name_chunk, rest_names) = pending_names.split_at(width);
            let (slot_chunk, rest_slots) = pending_slots.split_at_mut(width);
            pending_names = rest_names;
            pending_slots = rest_slots;
            scope.spawn(move || {
                for (name, slot) in name_chunk.iter().zip(slot_chunk) {
                    *slot = Some(check_one(target, dir, runtime, source, env, name, force));
                }
            });
        }
    });
    Ok(slots
        .into_iter()
        .map(|slot| slot.expect("并发区间恰好盖满每个槽位"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_prefers_the_error_block_over_progress_lines() {
        let output = "Progress: resolved 0, reused 1\n\
                      Error: ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY\n\
                      \n\
                      ╰─▶ Broken lockfile: no entry for 'billion-context@0.1.206'\n\
                      dsh: plugin command failed; diagnostics: C:\\x\\pnpm.log\n";
        let digest = cli_error_digest(output);
        assert!(digest.starts_with("Error: ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY"));
        assert!(digest.contains("Broken lockfile"));
        assert!(digest.contains("diagnostics"));
    }

    #[test]
    fn digest_without_an_error_marker_falls_back_to_the_last_line() {
        assert_eq!(
            cli_error_digest("line one\nline two\n\nline three"),
            "line three"
        );
        assert_eq!(cli_error_digest(""), "");
    }

    #[test]
    fn digest_is_capped_and_single_line() {
        let long = format!("Error: {}\n", "x".repeat(600));
        let digest = cli_error_digest(&long);
        assert!(digest.chars().count() <= 240);
        assert!(!digest.contains('\n'));
    }

    /// 本进程专用的临时目录（与 plugin_switch 测试同一套做法）。
    fn temp_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "dsharbor-plugin-update-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// 写一个已安装插件的版本文件，返回环境目录字符串。
    fn install_fake(host_root: &std::path::Path, name: &str, version: &str) -> String {
        let dir = host_root.join("profiles").join("web");
        let pkg_dir = dir.join("node_modules").join(name.replace('/', "\\"));
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(
            pkg_dir.join("package.json"),
            format!(r#"{{ "name": "{name}", "version": "{version}" }}"#),
        )
        .unwrap();
        dir.to_string_lossy().to_string()
    }

    // ---- 读已装版本 ----------------------------------------------------------

    #[test]
    fn view_args_are_the_fixed_npm_view_shape() {
        // 参数结构的单点断言：多一个字段、少一个 --json、包名被换位置都是注入或坏查询。
        assert_eq!(
            plugin_view_args("billion-context"),
            ["view", "billion-context", "dist-tags", "versions", "--json"]
        );
    }

    #[test]
    fn read_installed_reads_the_version_field() {
        let root = temp_root("read");
        let dir = install_fake(&root, "dsh-one", "1.2.3");
        assert_eq!(
            read_installed(&Target::Host, &dir, "dsh-one"),
            (Some("1.2.3".to_string()), None)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_installed_reports_missing_dir_bad_json_and_missing_field() {
        let root = temp_root("read-bad");
        let dir = root
            .join("profiles")
            .join("web")
            .to_string_lossy()
            .to_string();

        // 目录都没建：读不到。
        let (version, error) = read_installed(&Target::Host, &dir, "dsh-missing");
        assert!(version.is_none());
        assert!(error.unwrap().contains("读不到已装版本"));

        // 坏 JSON。
        let pkg_dir = root
            .join("profiles")
            .join("web")
            .join("node_modules")
            .join("dsh-junk");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(pkg_dir.join("package.json"), "{ not json").unwrap();
        let (version, error) = read_installed(&Target::Host, &dir, "dsh-junk");
        assert!(version.is_none());
        assert!(error.unwrap().contains("JSON"));

        // 有文件但没有 version 字段。
        let pkg_dir = root
            .join("profiles")
            .join("web")
            .join("node_modules")
            .join("dsh-nover");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(pkg_dir.join("package.json"), r#"{ "name": "dsh-nover" }"#).unwrap();
        let (version, error) = read_installed(&Target::Host, &dir, "dsh-nover");
        assert!(version.is_none());
        assert!(error.unwrap().contains("version"));

        // scope 包走嵌套目录。
        let dir = install_fake(&root, "@scope/pkg", "0.1.0");
        assert_eq!(
            read_installed(&Target::Host, &dir, "@scope/pkg"),
            (Some("0.1.0".to_string()), None)
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- 结果装配 ------------------------------------------------------------

    #[test]
    fn assemble_prefers_query_errors_over_update_verdicts() {
        let item = assemble(
            "dsh-one",
            (Some("1.0.0".to_string()), None),
            Err("读取插件「dsh-one」的版本列表失败：E404".to_string()),
        );
        assert_eq!(item.current.as_deref(), Some("1.0.0"));
        assert_eq!(item.target, None);
        assert_eq!(
            item.error.as_deref(),
            Some("读取插件「dsh-one」的版本列表失败：E404")
        );
        assert!(!item.has_update);
    }

    #[test]
    fn assemble_marks_empty_registry_as_unavailable() {
        let item = assemble("dsh-one", (Some("1.0.0".to_string()), None), Ok(None));
        assert_eq!(item.target, None);
        assert!(item.error.unwrap().contains("查不到"));
        assert!(!item.has_update);
    }

    #[test]
    fn assemble_compares_versions_when_both_are_known() {
        let up = assemble(
            "dsh-one",
            (Some("1.0.0".to_string()), None),
            Ok(Some("1.2.0".to_string())),
        );
        assert_eq!(up.current.as_deref(), Some("1.0.0"));
        assert_eq!(up.target.as_deref(), Some("1.2.0"));
        assert_eq!(up.error, None);
        assert!(up.has_update);

        let latest = assemble(
            "dsh-one",
            (Some("1.2.0".to_string()), None),
            Ok(Some("1.2.0".to_string())),
        );
        assert!(!latest.has_update, "同版本不算更新");
    }

    #[test]
    fn assemble_without_a_readable_current_version_does_not_offer_updates() {
        // 读不到已装版本：不猜、不给更新按钮，把原因亮出来。
        let item = assemble(
            "dsh-one",
            (None, Some("读不到已装版本：…".to_string())),
            Ok(Some("1.2.0".to_string())),
        );
        assert_eq!(item.target.as_deref(), Some("1.2.0"));
        assert!(item.error.unwrap().contains("读不到已装版本"));
        assert!(!item.has_update);
    }

    // ---- 检查并发切分 --------------------------------------------------------

    #[test]
    fn chunk_bounds_covers_every_slot_in_order_with_at_most_four_segments() {
        for total in 0..=20usize {
            let bounds = chunk_bounds(total);
            assert!(
                bounds.len() <= CHECK_CONCURRENCY,
                "total={total}：{bounds:?}"
            );
            let mut covered = Vec::new();
            for (start, end) in &bounds {
                assert!(start < end, "total={total}：空区间 {bounds:?}");
                assert!(
                    covered.last().is_none_or(|&last| last + 1 == *start),
                    "total={total}：区间不连续 {bounds:?}"
                );
                covered.extend(*start..*end);
            }
            assert_eq!(covered, (0..total).collect::<Vec<_>>(), "total={total}");
        }
        assert!(chunk_bounds(0).is_empty());
        assert_eq!(chunk_bounds(1), vec![(0, 1)]);
    }

    // ---- 会话缓存键 ----------------------------------------------------------

    #[test]
    fn cache_key_separates_runtime_source_and_package() {
        let host = check_cache_key(&launch::Runtime::Default, DownloadSource::Mirror, "dsh-one");
        assert_eq!(host, "host:mirror:dsh-one");
        let wsl = check_cache_key(
            &launch::Runtime::Wsl {
                distro: "Ubuntu".to_string(),
            },
            DownloadSource::Mirror,
            "dsh-one",
        );
        assert_eq!(wsl, "wsl:Ubuntu:mirror:dsh-one");
        assert_ne!(
            host,
            check_cache_key(
                &launch::Runtime::Default,
                DownloadSource::Official,
                "dsh-one"
            ),
            "换下载源要分开缓存"
        );
        assert_ne!(
            host,
            check_cache_key(&launch::Runtime::Default, DownloadSource::Mirror, "dsh-two"),
            "换包名要分开缓存"
        );
    }

    // ---- 装后校验 ------------------------------------------------------------

    #[test]
    fn verify_accepts_target_and_rejects_mismatch_or_missing() {
        let root = temp_root("verify");
        let dir = install_fake(&root, "dsh-one", "1.2.3");

        assert!(verify_installed_version(&Target::Host, &dir, "dsh-one", "1.2.3").is_ok());

        let mismatch =
            verify_installed_version(&Target::Host, &dir, "dsh-one", "2.0.0").unwrap_err();
        assert!(
            mismatch.contains("1.2.3") && mismatch.contains("2.0.0"),
            "应同时点出实装版本与目标版本：{mismatch}"
        );

        let missing =
            verify_installed_version(&Target::Host, &dir, "dsh-none", "1.0.0").unwrap_err();
        assert!(missing.contains("读不到"), "{missing}");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- 批量汇总 ------------------------------------------------------------

    #[test]
    fn summarize_reports_successes_failures_and_nothing_to_do() {
        let all_ok = vec![
            ("dsh-a".to_string(), Ok("1.0.0".to_string())),
            ("@scope/b".to_string(), Ok("2.0.0-rc.1".to_string())),
        ];
        let text = summarize_results(&all_ok);
        assert!(
            text.contains("成功 2 个")
                && text.contains("dsh-a@1.0.0")
                && text.contains("@scope/b@2.0.0-rc.1")
                && text.contains("重启 DSH"),
            "{text}"
        );

        let mixed = vec![
            ("dsh-a".to_string(), Ok("1.0.0".to_string())),
            ("dsh-bad".to_string(), Err("boom".to_string())),
        ];
        let text = summarize_results(&mixed);
        assert!(
            text.contains("成功 1 个") && text.contains("失败 1 个"),
            "{text}"
        );
        assert!(text.contains("dsh-bad：boom"), "{text}");

        let all_bad = vec![("dsh-bad".to_string(), Err("boom".to_string()))];
        let text = summarize_results(&all_bad);
        assert!(
            text.contains("成功 0 个") && text.contains("失败 1 个"),
            "{text}"
        );

        assert_eq!(summarize_results(&[]), "没有需要更新的插件。");
    }
}
