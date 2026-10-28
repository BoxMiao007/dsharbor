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
use dsharbor_core::plugin_switch::PluginItem;
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
/// 「检查更新」按钮走 [`list_all`] 强制重查一遍；更新成功后把对应条目挪掉，让
/// 收尾重查真的发网络、看到装好的新版本。
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

/// [`run_plugin_op`] 的结果：最后一次执行的退出码与输出，加上壳补做了什么。
/// 补做动作为空表示没触发；触发了但没补好也会留一句原因，界面回执要能让用户
/// 知道壳查过这一步。
struct OpRun {
    /// 最后一次执行的退出码。
    code: i32,
    /// 最后一次执行的输出。
    output: String,
    /// 壳替用户补做的动作（修锁文件、放行 pnpm 供应链保护），回执要写清。
    note: Option<String>,
    /// 重跑时实际用上的放行开关——回执里的命令回显要带上，用户照着敲才等价。
    relax: Vec<launch::PnpmRelax>,
}

/// 跑一次插件安装/卸载命令；遇到「壳能自救」的失败就补一步再重跑。
///
/// 目前两类，都会让「装上新版本」这件事莫名其妙地失败，而原因都不在包本身：
/// 1. 环境自己的锁文件坏了（`ERR_PNPM_LOCKFILE_*`）：DSH 的 plugin 命令把 pnpm 当
///    外部命令直接 exec，不会自救，壳替它补 `pnpm install --fix-lockfile` 再重跑。
/// 2. pnpm 的供应链保护拦了「刚发布」的版本（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`
///    发布不满 1 天、`ERR_PNPM_IGNORED_BUILDS` 依赖的安装脚本未批准）：用户点的是
///    「更新到这个明确版本」，壳放行一次再重装，并在回执里说明放行了什么。
///
/// 每类最多补一次，补完还失败就照原样把 pnpm 的报错交给用户。
fn run_plugin_op(
    config: &LaunchConfig,
    profile: &str,
    op: &launch::PluginOp,
    env: &[(String, String)],
) -> Result<OpRun, String> {
    let (mut code, mut output) = run_plugin_command(config, profile, op, env, &[])?;
    let mut notes: Vec<String> = Vec::new();

    if code != 0 && plugin_update::lockfile_needs_repair(&output) {
        match repair_lockfile(config, profile, env) {
            Ok((0, _repair_output)) => {
                let (retry_code, retry_output) = run_plugin_command(config, profile, op, env, &[])?;
                code = retry_code;
                output = retry_output;
                notes.push("锁文件已按现存依赖重修（pnpm install --fix-lockfile）".to_string());
            }
            Ok((repair_code, repair_output)) => notes.push(format!(
                "锁文件自动修复失败（退出码 {repair_code}）：{}",
                plugin::tail_chars(&repair_output, 600)
            )),
            // 起不来 pnpm（没装 / 不在 PATH）就照原样报下去，别把真实失败原因盖掉。
            Err(err) => notes.push(format!("锁文件自动修复没能执行：{err}")),
        }
    }

    // 供应链保护可能与「锁文件坏了」叠着出现（修好锁文件后校验才轮到它），
    // 所以这一步独立判断，最多补两轮（先放行发布时长，再放行安装脚本）。
    let mut relax: Vec<launch::PnpmRelax> = Vec::new();
    for _ in 0..2 {
        if code == 0 {
            break;
        }
        let Some(next) = supply_chain_relax(&output) else {
            break;
        };
        let fresh: Vec<launch::PnpmRelax> = next
            .into_iter()
            .filter(|option| !relax.contains(option))
            .collect();
        if fresh.is_empty() {
            break;
        }
        relax.extend(fresh);
        let (retry_code, retry_output) = run_plugin_command(config, profile, op, env, &relax)?;
        code = retry_code;
        output = retry_output;
    }
    if !relax.is_empty() {
        let outcome = if code == 0 {
            "重装成功"
        } else {
            "重装仍未成功"
        };
        notes.push(format!(
            "已放行 pnpm 的供应链保护（{}）{outcome}",
            relax_text(&relax)
        ));
    }

    Ok(OpRun {
        code,
        output,
        note: if notes.is_empty() {
            None
        } else {
            Some(notes.join("\n"))
        },
        relax,
    })
}

/// 跑一条插件命令（`relax` 为空就是原命令）。
fn run_plugin_command(
    config: &LaunchConfig,
    profile: &str,
    op: &launch::PluginOp,
    env: &[(String, String)],
    relax: &[launch::PnpmRelax],
) -> Result<(i32, String), String> {
    let command = if relax.is_empty() {
        plugin::plugin_command(config, profile, op, env)?
    } else {
        plugin::plugin_command_with(config, profile, op, env, relax)?
    };
    plugin::run_capture(command, plugin::PLUGIN_OP_TIMEOUT)
}

/// 这次失败是不是 pnpm 供应链保护拦的；是就给出要放行的开关。
///
/// 认不出、或者认得出但取不到包名（`--allow-build` 需要包名）就返回 `None`：
/// 宁可不放行，也不要拿着猜出来的参数去跑第三方安装脚本。
fn supply_chain_relax(output: &str) -> Option<Vec<launch::PnpmRelax>> {
    if plugin_update::release_age_blocked(output) {
        return Some(vec![launch::PnpmRelax::ReleaseAge]);
    }
    if plugin_update::builds_blocked(output) {
        let packages = plugin_update::blocked_build_packages(output);
        if packages.is_empty() {
            return None;
        }
        return Some(
            packages
                .into_iter()
                .map(launch::PnpmRelax::AllowBuild)
                .collect(),
        );
    }
    None
}

/// 放行说明里的人话部分（回执正文用，不写参数）。
fn relax_text(relax: &[launch::PnpmRelax]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if relax
        .iter()
        .any(|option| matches!(option, launch::PnpmRelax::ReleaseAge))
    {
        parts.push("该版本发布不满 1 天，pnpm 默认要等满才装".to_string());
    }
    let builds: Vec<&str> = relax
        .iter()
        .filter_map(|option| match option {
            launch::PnpmRelax::AllowBuild(name) => Some(name.as_str()),
            launch::PnpmRelax::ReleaseAge => None,
        })
        .collect();
    if !builds.is_empty() {
        parts.push(format!("已允许 {} 的安装脚本执行", builds.join("、")));
    }
    parts.join("；")
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
    let run = run_plugin_op(config, profile, &op, &env)?;
    // 命令回显要带上壳实际用过的放行开关（撞上 pnpm 供应链保护时会补参数），
    // 用户照着这一行自己重跑才等价。
    let command_line = plugin::plugin_command_line_with(config, profile, &op, &run.relax)
        .unwrap_or_else(|_| {
            format!(
                "dsh plugin --profile {} add {package}",
                plugin::cli_profile_label(profile)
            )
        });
    let OpRun {
        code, output, note, ..
    } = run;
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
    // 壳替用户补做的动作（修锁文件、放行 pnpm 供应链保护）要写进回执：
    // 补成功了用户不用管，没补好也得知道壳查过什么。
    let recover_note = match &note {
        Some(note) => format!("\n{}", note),
        None => String::new(),
    };
    let message = format!(
        "{first_line}\n\
         命令：{command_line}（经 {}）\n\
         校验：{verify_text}{recover_note}\n\
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
            let rows = list(app, config, profile, source)?;
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

/// 某个目标环境对「把这份插件装过去」这件事的现状（界面右键菜单逐行显示）。
///
/// 「已经装过」的判定口径与插件面板一致：目标环境的 `package.json` 里
/// `dependencies` 或 `dsh.profile.bundles` 登记了同名包就算装过——只被别的包当
/// 依赖拉进 `node_modules` 的传递包不算，否则像 `@modelcontextprotocol/sdk`
/// 这种被顺带装进来的包会到处显示成「已装」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallTarget {
    /// 目标环境名。
    pub profile: String,
    /// 这个环境装过依赖没有（没有就没有 `node_modules`，装不了）。
    pub deps_installed: bool,
    /// 目标环境是否已经登记了这个插件（任何版本都算）。
    pub installed: bool,
    /// 已装的具体版本；登记了但 `node_modules` 读不到版本时是 None（界面只显示「已装」）。
    pub installed_version: Option<String>,
    /// 读这个目标环境时出的错（目录损坏、权限问题）；有值时界面把那一行置灰。
    pub error: Option<String>,
}

/// 判断清单里是否登记了这个包（`dependencies` 或组合包列表任一命中）。
///
/// 抽出来是为了让「已装」的判定只有一份实现：跨环境安装的拒绝、右键菜单的置灰
/// 都走它，不会出现「菜单说能装、后端说已经装过」这种自相矛盾。
fn registered_in_manifest(manifest: &str, name: &str) -> Result<bool, String> {
    let bundles = plugin_switch::bundle_names(manifest)?;
    if bundles.iter().any(|bundle| bundle == name) {
        return Ok(true);
    }
    let deps = plugin_switch::dependency_names(manifest)?;
    Ok(deps.iter().any(|dep| dep == name))
}

/// 列出「这个插件能装进哪些环境」，供右键菜单逐行显示现状。
///
/// 一次读完所有其它环境（每个环境读一次 `package.json`，WSL 目标经 wsl.exe），
/// 所以菜单是右键那一刻才问、不预取。源环境自己不出现在结果里。
pub fn install_targets(
    config: &LaunchConfig,
    source_profile: &str,
    name: &str,
) -> Result<Vec<InstallTarget>, String> {
    plugin_update::validate_package_name(name)?;
    let target = Target::of(config);
    let listing = plugin::list_profiles(config)?;
    let mut out = Vec::new();
    for profile in listing.profiles {
        if profile.name == source_profile {
            continue;
        }
        let mut row = InstallTarget {
            profile: profile.name.clone(),
            deps_installed: profile.deps_installed,
            installed: false,
            installed_version: None,
            error: None,
        };
        match read_profile_manifest(&target, &profile.name) {
            Ok(manifest) => match registered_in_manifest(&manifest, name) {
                Ok(installed) => {
                    row.installed = installed;
                    if installed {
                        let dir = match plugin::profile_dir(&target, &profile.name) {
                            Ok(dir) => dir,
                            Err(err) => {
                                row.error = Some(err);
                                out.push(row);
                                continue;
                            }
                        };
                        row.installed_version = read_installed(&target, &dir, name).0;
                    }
                }
                Err(err) => row.error = Some(err),
            },
            Err(err) => row.error = Some(err),
        }
        out.push(row);
    }
    Ok(out)
}

/// 读某个环境的 `package.json` 原文（读不到就把原因带上去）。
fn read_profile_manifest(target: &Target, profile: &str) -> Result<String, String> {
    let dir = plugin::profile_dir(target, profile)?;
    plugin::read_file(target, &plugin::join_path(target, &dir, "package.json"))
}

/// 把一份环境里装着的插件装进另一份环境（界面上的「添加到其他环境」）。
///
/// 两套环境都在同一个运行环境里（宿主或同一个 WSL 发行版）：壳的插件命令只认
/// 当前 `LaunchConfig` 的 runtime，跨 runtime 搬运需要两套运行时同时在场，
/// 界面也从不提供这种入口，所以直接拒掉而不是默默装错地方。
///
/// 版本取源环境里实际装着的那一份，而不是 registry 上的最新版——用户点的是
/// 「把这个插件搬过去」，搬完两边应当同时是同一份版本。
///
/// 目标环境已经有同名插件（任何版本）就拒绝：覆盖安装会让「两个环境各管一份」
/// 变得不可预测，想换版本应当去那个环境自己的「更新」里做。
pub fn install_into(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    source_profile: &str,
    target_profile: &str,
    name: &str,
) -> Result<UpdateOutcome, String> {
    if source_profile == target_profile {
        return Err("源环境和目标环境是同一个，不用搬。".to_string());
    }
    if !plugin_update::in_update_scope(name) {
        return Err("官方内置包与桥接插件不适用跨环境搬运".to_string());
    }
    plugin_update::validate_package_name(name)?;
    let target = Target::of(config);
    if !crate::profile_ops::profile_exists(&target, source_profile)? {
        return Err(format!("找不到源环境「{source_profile}」。"));
    }
    if !crate::profile_ops::profile_exists(&target, target_profile)? {
        return Err(format!("找不到目标环境「{target_profile}」。"));
    }
    let source_dir = plugin::profile_dir(&target, source_profile)?;
    let (version, source_error) = read_installed(&target, &source_dir, name);
    let Some(version) = version else {
        return Err(source_error.unwrap_or_else(|| {
            format!("环境「{source_profile}」里没有装「{name}」（读不到已装版本）")
        }));
    };

    // 目标环境已经有同名插件（任何版本）就停手：覆盖安装会让「两个环境各管一份」
    // 变得不可预测，想换版本应当去那个环境自己的「更新」里做。
    let target_dir = plugin::profile_dir(&target, target_profile)?;
    let target_manifest = read_profile_manifest(&target, target_profile)?;
    if registered_in_manifest(&target_manifest, name)? {
        let (existing, _) = read_installed(&target, &target_dir, name);
        let current_text = match existing.as_deref() {
            Some(current) => format!("已经装着 {current}"),
            None => "已经装着".to_string(),
        };
        return Err(format!(
            "环境「{target_profile}」{current_text}这个插件，不重复装；想换版本请到这个环境自己的「更新」里做。"
        ));
    }

    let prefs = crate::settings::load(app).prefs;
    let env = crate::proxy::child_env(&prefs, prefs.download_source);
    let package = format!("{name}@{version}");
    let op = launch::PluginOp::Install {
        package: package.clone(),
    };
    let backup = plugin::backup_profile(app, &target, target_profile)?;
    let run = run_plugin_op(config, target_profile, &op, &env)?;
    // 命令回显要带上壳实际用过的放行开关（撞上 pnpm 供应链保护时会补参数）。
    let command_line = plugin::plugin_command_line_with(config, target_profile, &op, &run.relax)
        .unwrap_or_else(|_| {
            format!(
                "dsh plugin --profile {} add {package}",
                plugin::cli_profile_label(target_profile)
            )
        });
    let OpRun {
        code, output, note, ..
    } = run;
    let verify = verify_installed_version(&target, &target_dir, name, &version);
    let ok = code == 0 && verify.is_ok();
    let verify_text = match &verify {
        Ok(()) => format!("版本已就位 {version} ✓"),
        Err(err) => format!("{err} ✗"),
    };
    let lockfile_broken = plugin_update::lockfile_needs_repair(&output);
    let first_line = match (&verify, code) {
        (Err(err), _) if lockfile_broken => format!(
            "目标环境的依赖锁文件坏了（pnpm-lock.yaml 与已装依赖对不上），装在装之前就失败：{err}（退出码 {code}）：{}",
            cli_error_digest(&output)
        ),
        (Err(err), _) => format!("已执行但校验未过：{err}（退出码 {code}）"),
        (Ok(()), code) => format!(
            "安装命令失败（退出码 {code}）：{}",
            cli_error_digest(&output)
        ),
    };
    let recover_note = match &note {
        Some(note) => format!(
            "
{note}"
        ),
        None => String::new(),
    };
    let detail = format!(
        "{first_line}
         命令：{command_line}（经 {}）
         校验：{verify_text}{recover_note}
         输出：
{}
         备份目录：{}{}",
        target.label(),
        plugin::tail_chars(&output, 4000),
        backup.dir,
        plugin::prune_note(&backup.pruned)
    );
    if ok {
        Ok(UpdateOutcome {
            ok: true,
            message: format!(
                "已把「{name}」@{version} 从环境「{source_profile}」装进「{target_profile}」。重启 DSH 后生效。
{detail}"
            ),
            backup_dir: backup.dir,
        })
    } else {
        Err(format!(
            "把「{name}」装进环境「{target_profile}」失败：
{detail}"
        ))
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

/// 按 [`CHECK_CONCURRENCY`] 分块并发地对每一项跑一次 `work`，结果按输入顺序返回。
///
/// 块内串行、块间并发：同时活着的 worker 数有上界，不会因为插件多就起几十条
/// `npm view`。空输入不建线程；每个槽位只被一个 worker 写过，最后按输入顺序装配。
fn run_concurrently<T, R, F>(items: &[T], work: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync,
{
    if items.is_empty() {
        return Vec::new();
    }
    let mut slots: Vec<Option<R>> = (0..items.len()).map(|_| None).collect();
    std::thread::scope(|scope| {
        let mut pending_items = items;
        let mut pending_slots = &mut slots[..];
        for (start, end) in chunk_bounds(items.len()) {
            let width = end - start;
            let (item_chunk, rest_items) = pending_items.split_at(width);
            let (slot_chunk, rest_slots) = pending_slots.split_at_mut(width);
            pending_items = rest_items;
            pending_slots = rest_slots;
            let work = &work;
            scope.spawn(move || {
                for (item, slot) in item_chunk.iter().zip(slot_chunk) {
                    *slot = Some(work(item));
                }
            });
        }
    });
    slots
        .into_iter()
        .map(|slot| slot.expect("并发区间恰好盖满每个槽位"))
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
    let latest = query_latest(runtime, source, env, name, false);
    assemble(name, current, latest)
}

/// 检查更新的扫描名单：插件卡上那几行里，属于更新范围的那些包名。
///
/// 名字直接从插件卡同一份清单（`plugin_switch::bare_items`）里挑，而不是自己另读
/// 一遍 `dsh.profile.bundles`——两处口径分开写必然漂：DSH 停用一个插件只把它从
/// 组合包列表里摘掉、包与依赖都留在磁盘上，只看组合包列表会让停用中的插件在界面
/// 上既没有版本号也没有「更新」按钮；反过来，多查了卡上没有的行，可更新徽章的
/// 计数又会和看得见的行对不上。
///
/// 保留的条件与界面一致：可开关（有挂载点，官方内置骨架包没有）、不是桥接插件
/// （归「桥接插件」浮窗管）、且在 [`plugin_update::in_update_scope`] 范围内。
fn update_scan_names(items: &[PluginItem]) -> Vec<String> {
    items
        .iter()
        .filter(|item| {
            item.switchable && !item.bridge && plugin_update::in_update_scope(&item.name)
        })
        .map(|item| item.name.clone())
        .collect()
}

/// 一个环境里要检查的包名：读清单，再按 [`update_scan_names`] 挑出更新范围里的。
fn scan_names(target: &Target, dir: &str) -> Result<Vec<String>, String> {
    Ok(update_scan_names(&crate::plugin_switch::bare_items(
        target, dir,
    )?))
}

/// 按 [`CHECK_CONCURRENCY`] 并发检查一个环境的这批包名，结果按名单顺序返回。
fn check_names(
    target: &Target,
    dir: &str,
    runtime: &launch::Runtime,
    source: DownloadSource,
    env: &[(String, String)],
    names: &[String],
) -> Vec<PluginUpdateItem> {
    run_concurrently(names, |name| {
        check_one(target, dir, runtime, source, env, name)
    })
}

/// 各环境名单里出现过的包名，去重并保留首次出现的顺序。
///
/// 目标版本只跟运行时、下载源与 registry 有关，与环境无关（会话缓存的键也不含
/// 环境名，见 [`check_cache_key`]）：同一批插件装在多个环境里时网络只该查一次。
fn unique_names(scans: &[&[String]]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for names in scans {
        for name in *names {
            if !out.iter().any(|seen| seen == name) {
                out.push(name.clone());
            }
        }
    }
    out
}

/// 检查一个环境全部第三方插件的更新，按登记顺序返回一行一个结果。
///
/// 会话级缓存优先：同一插件本次使用会话内只在第一次进插件卡时查一次；要拿最新
/// 结论走 [`list_all`]（界面「检查更新」按钮）。官方内置骨架包与桥接插件不在
/// 清单里（[`plugin_update::in_update_scope`]），整表读不到清单时直接报错。
/// 查询最多 [`CHECK_CONCURRENCY`] 路并发跑（见该常量的安全论证），结果仍按
/// 清单登记顺序返回。
///
/// 扫描范围见 [`update_scan_names`]：**停用的插件也查**，断网或私有包失败按行记原因。
pub fn list(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    profile: &str,
    source: DownloadSource,
) -> Result<Vec<PluginUpdateItem>, String> {
    let target = Target::of(config);
    let dir = plugin::profile_dir(&target, profile)?;
    let names = scan_names(&target, &dir)
        .map_err(|err| format!("读不到环境「{profile}」的插件清单：{err}"))?;
    // 下载源用界面这次传的（它才是权威），代理用已保存的设置——与官方版本查询同一份口径。
    let prefs = crate::settings::load(app).prefs;
    let env = crate::proxy::child_env(&prefs, source);
    let runtime = launch::runtime_of(config);
    Ok(check_names(&target, &dir, runtime, source, &env, &names))
}

/// 一次「检查所有环境」里某个环境的结果（界面按环境分别落可更新数徽标）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUpdates {
    /// 环境名；顺序与 [`plugin::list_profiles`] 枚举到的一致。
    pub profile: String,
    /// 这个环境查到的更新清单；读不到清单时是 `None`（原因在 `error`）。
    pub items: Option<Vec<PluginUpdateItem>>,
    /// 这个环境自己的失败原因；查到清单时为 `None`。
    pub error: Option<String>,
}

/// 「检查所有环境」第一阶段（读名单）的结果：环境名 + 目录与要查的包名，或读不到的原因。
type PreparedEnv = (String, Result<(String, Vec<String>), String>);

/// 强制重查**所有环境**的插件更新（界面「检查更新」按钮发起的一次动作）。
///
/// 与 [`list`] 的差别有两点：
///  1. 环境由后端自己枚举（界面看到的那份清单可能刚变过），逐个环境各出一行
///     结果；某个环境读不到清单只算它自己失败，不牵连其余环境；
///  2. 目标版本与环境无关，所以先对所有环境去重后的包名**各强制查一次**并写进
///     会话缓存，再逐环境装配行。否则 N 个环境会把同一批 `npm view` 重复发 N
///     遍——十几个插件乘几个环境，界面要空转明显更久。这也是会话缓存键不含
///     环境名的同一前提（见 [`check_cache_key`]）。
pub fn list_all(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    source: DownloadSource,
) -> Result<Vec<ProfileUpdates>, String> {
    let listing = plugin::list_profiles(config)?;
    if !listing.supported {
        return Ok(Vec::new());
    }
    let target = Target::of(config);
    // 第一阶段：读每个环境的名单（磁盘读；WSL 目标下每条是一次 wsl.exe）。
    // 读不到的环境记下原因，不再参与后面的网络查询。
    let prepared: Vec<PreparedEnv> = listing
        .profiles
        .into_iter()
        .map(|profile| {
            let name = profile.name;
            let scan = plugin::profile_dir(&target, &name)
                .map_err(|err| format!("读不到环境「{name}」的目录：{err}"))
                .and_then(|dir| {
                    scan_names(&target, &dir)
                        .map(|names| (dir, names))
                        .map_err(|err| format!("读不到环境「{name}」的插件清单：{err}"))
                });
            (name, scan)
        })
        .collect();
    // 下载源与代理口径同 [`list`]。
    let prefs = crate::settings::load(app).prefs;
    let env = crate::proxy::child_env(&prefs, source);
    let runtime = launch::runtime_of(config);
    // 第二阶段：所有环境去重后的包名各强制查一次，结果写进会话缓存。
    let lists: Vec<&[String]> = prepared
        .iter()
        .filter_map(|(_, scan)| scan.as_ref().ok().map(|(_, names)| names.as_slice()))
        .collect();
    let fresh = unique_names(&lists);
    run_concurrently(&fresh, |name| {
        let _ = query_latest(runtime, source, &env, name, true);
    });
    // 第三阶段：逐环境装配（读已装版本 + 命中刚写好的缓存），顺序照环境枚举顺序。
    Ok(prepared
        .into_iter()
        .map(|(profile, scan)| match scan {
            Ok((dir, names)) => ProfileUpdates {
                profile,
                items: Some(check_names(&target, &dir, runtime, source, &env, &names)),
                error: None,
            },
            Err(error) => ProfileUpdates {
                profile,
                items: None,
                error: Some(error),
            },
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dsharbor_core::profiles::BRIDGE_PLUGIN;

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

    #[test]
    fn run_concurrently_visits_every_item_once_and_keeps_input_order() {
        let items: Vec<usize> = (0..23).collect();
        let seen = std::sync::Mutex::new(Vec::new());
        let out = run_concurrently(&items, |item| {
            seen.lock().unwrap().push(*item);
            *item * 2
        });
        assert_eq!(
            out,
            items.iter().map(|item| item * 2).collect::<Vec<_>>(),
            "结果要按输入顺序装配，不能随并发完成顺序抖动"
        );
        let mut visited = seen.into_inner().unwrap();
        visited.sort_unstable();
        assert_eq!(visited, items, "每项恰好跑一次");

        let empty: [usize; 0] = [];
        assert!(run_concurrently(&empty, |_| 0usize).is_empty());
    }

    #[test]
    fn unique_names_dedupes_across_environments_and_keeps_first_order() {
        let web = vec!["dsh-b".to_string(), "dsh-a".to_string()];
        let lab = vec!["dsh-a".to_string(), "dsh-c".to_string()];
        let empty: Vec<String> = Vec::new();
        let scans: Vec<&[String]> = vec![&web, &lab, &empty];
        assert_eq!(
            unique_names(&scans),
            vec!["dsh-b", "dsh-a", "dsh-c"],
            "同一个包只查一次网络，顺序照各环境名单首次出现"
        );
        assert!(unique_names(&[]).is_empty());
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

    // ---- 检查更新的扫描名单 ------------------------------------------------

    fn scan_item(name: &str, switchable: bool, bridge: bool) -> PluginItem {
        PluginItem {
            name: name.to_string(),
            entries: if switchable {
                vec![format!("{name}-row")]
            } else {
                Vec::new()
            },
            enabled: true,
            bridge,
            manual: false,
            switchable,
            description: None,
            home: None,
        }
    }

    #[test]
    fn update_scan_names_keep_disabled_plugins_and_skip_unmanaged_ones() {
        // `enabled: false` 就是停用（DSH 只把它移出组合包列表，包还在磁盘上）：
        // 这种行照样要查更新，否则界面上那一行没有版本号也没有「更新」。
        let items = vec![
            scan_item("dsh-on", true, false),
            scan_item("dsh-off", true, false),
            scan_item("@deepseek-ai/dsh-base", false, false),
            scan_item(BRIDGE_PLUGIN, true, true),
        ];
        assert_eq!(
            update_scan_names(&items),
            vec!["dsh-on".to_string(), "dsh-off".to_string()],
            "停用的照查；官方骨架包（不可开关）与桥接插件跳过"
        );
    }

    #[test]
    fn update_scan_names_on_an_empty_list_is_empty() {
        assert!(update_scan_names(&[]).is_empty());
    }

    // ---- 「目标环境装过没有」的判定 ------------------------------------------

    #[test]
    fn registered_in_manifest_counts_dependencies_and_bundles_only() {
        let manifest = r#"{
            "name": "web",
            "dependencies": { "dsh-context": "0.75.1" },
            "dsh": { "profile": { "bundles": ["billion-context"] } }
        }"#;
        // 组合包列表登记算装过。
        assert!(registered_in_manifest(manifest, "billion-context").unwrap());
        // 只在 dependencies 里（被关掉了）也算装过——包还在磁盘上。
        assert!(registered_in_manifest(manifest, "dsh-context").unwrap());
        // 没登记就不算：传递依赖不进清单，别把它们误判成「已装」。
        assert!(!registered_in_manifest(manifest, "@modelcontextprotocol/sdk").unwrap());
    }

    #[test]
    fn registered_in_manifest_reports_a_broken_manifest() {
        // 坏 JSON 要把原因带出去，让右键菜单那一行显示「读不到」而不是「能装」。
        assert!(registered_in_manifest("{ not json", "dsh-one").is_err());
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
