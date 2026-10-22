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

use crate::plugin::{self, Target};
use crate::registry;

/// 已装版本与读取失败原因（二选一有值：成功时原因是 `None`，失败时版本是 `None`）。
type InstalledVersion = (Option<String>, Option<String>);

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
    let command = plugin::plugin_command(config, profile, &op, &env)?;
    let (code, output) = plugin::run_capture(command, plugin::PLUGIN_OP_TIMEOUT)?;
    let verify = verify_installed_version(&target, &dir, name, &latest);
    let ok = code == 0 && verify.is_ok();
    if ok {
        forget_check(runtime, source, name);
    }
    let verify_text = match &verify {
        Ok(()) => format!("版本已换成 {latest} ✓"),
        Err(err) => format!("{err} ✗"),
    };
    let message = format!(
        "更新命令：dsh plugin --profile {profile} add {package}（经 {}）\n\
         插件包：{package}\n\
         退出码：{code}\n\
         校验：{verify_text}\n\
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

/// 更新单个（`name=Some`）或全部有更新的第三方插件（`name=None`，逐个执行、
/// 单个失败不影响其余）。
pub fn update(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    profile: &str,
    source: DownloadSource,
    name: Option<&str>,
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
            let mut results: Vec<(String, Result<String, String>)> = Vec::new();
            let mut backup_dir = String::new();
            for name in &worklist {
                match update_one(app, config, profile, source, name) {
                    Ok((version, dir)) => {
                        if backup_dir.is_empty() {
                            backup_dir = dir;
                        }
                        results.push((name.clone(), Ok(version)));
                    }
                    Err(err) => results.push((name.clone(), Err(err))),
                }
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

/// 检查一个环境全部第三方插件的更新，按登记顺序返回一行一个结果。
///
/// 会话级缓存优先（`force` 绕过）：同一插件本次使用会话内只在第一次进插件卡
/// 时查一次，之后由界面「检查更新」按钮强制重查。官方内置骨架包与桥接插件
/// 不在清单里（[`plugin_update::in_update_scope`]），整表读不到清单时直接报错。
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
    let mut items = Vec::new();
    for name in &bundles {
        if !plugin_update::in_update_scope(name) {
            continue;
        }
        // 包名不安全（正常登记不会这样）就亮错误行：不拿它拼路径、拼命令。
        if let Err(err) = plugin_update::validate_package_name(name) {
            items.push(PluginUpdateItem {
                name: name.clone(),
                current: None,
                target: None,
                error: Some(err),
                has_update: false,
            });
            continue;
        }
        let current = read_installed(&target, &dir, name);
        let latest = query_latest(runtime, source, &env, name, force);
        items.push(assemble(name, current, latest));
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

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
