//! 插件更新的纯逻辑：更新范围、包名校验、目标版本选取与新旧比较。
//!
//! 这些规则决定「升不升、升到哪」，必须可离线测试；碰系统的事（读已装版本、
//! 跑 npm、备份、执行更新）在外壳 crate（src-tauri/src/plugin_update.rs）里做。

use serde::Serialize;

use crate::profiles::BRIDGE_PLUGIN;
use crate::registry::sort_newest_first;

/// 官方内置骨架包的 scope 前缀：它们跟随 DSH 本体发版，不走插件更新这条通道。
pub const OFFICIAL_SCOPE: &str = "@deepseek-ai/";

/// 一行更新检查结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateItem {
    /// 插件包名。
    pub name: String,
    /// 已装版本；读不到时为 `None`（`error` 说明原因）。
    pub current: Option<String>,
    /// 目标版本（registry 全部版本里最新的一个，含预发布）；查不到时为 `None`。
    pub target: Option<String>,
    /// 本行的失败原因（读版本或查 registry 失败）；正常行是 `None`。
    pub error: Option<String>,
    /// 是否有更新：已装版本与目标版本都拿到，且目标更新。
    pub has_update: bool,
}

/// 该插件是否在更新范围内：跳过官方内置骨架包（`@deepseek-ai/*`）与桥接插件。
///
/// 桥接插件归壳自己的「桥接插件」浮窗管，版本跟着壳发版；官方骨架包跟着 DSH
/// 本体发版——这两类从插件通道升级会把匹配关系搅乱。
pub fn in_update_scope(name: &str) -> bool {
    !name.is_empty() && name != BRIDGE_PLUGIN && !name.starts_with(OFFICIAL_SCOPE)
}

/// 校验包名能否安全地作为 npm 命令参数。
///
/// 包名来自环境清单（用户装了什么就是什么），而 WSL 下参数会拼进 `bash -lc`
/// 的整行里，所以必须先过滤：只允许 ASCII 字母数字与 `@ . _ - /`，且 `@scope/name`
/// 结构要完整（恰好一个 `/`、两段非空）。通过即保证不含空格、引号与 shell 元字符。
pub fn validate_package_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("包名为空".to_string());
    }
    if name.len() > 214 {
        return Err(format!("包名过长（最多 214 字符）：{name}"));
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '@' | '.' | '_' | '-' | '/'))
    {
        return Err(format!(
            "包名包含不允许的字符（只允许字母数字与 @ . _ - /）：{name}"
        ));
    }
    if name.contains("..") {
        return Err(format!("包名不允许包含 \"..\"：{name}"));
    }
    if let Some(rest) = name.strip_prefix('@') {
        let Some((scope, local)) = rest.split_once('/') else {
            return Err(format!("带 scope 的包名要写成 @scope/name：{name}"));
        };
        if scope.is_empty() || local.is_empty() || local.contains('/') {
            return Err(format!(
                "带 scope 的包名要写成 @scope/name（两段都不能空，且只允许一个 /）：{name}"
            ));
        }
    } else if name.contains('/') {
        return Err(format!("不带 scope 的包名不允许包含 /：{name}"));
    }
    Ok(())
}

/// 目标版本：全部版本里最新的一个（含预发布）。
///
/// 不取 `dist-tags.latest`——插件常用预发布通道，`latest` 常落后于真实最新。
/// 版本比较用 registry 模块的同一条 semver 排序；空列表返回 `None`。
pub fn target_version(versions: &[String]) -> Option<String> {
    let mut sorted = versions.to_vec();
    sort_newest_first(&mut sorted);
    sorted.into_iter().next().filter(|v| !v.is_empty())
}

/// `candidate` 是否比 `current` 新（semver 顺序；相同或无法比较都算「否」）。
pub fn is_newer(candidate: &str, current: &str) -> bool {
    if candidate == current {
        return false;
    }
    // 排序「新在前」：排完后 candidate 在首位就是它更新。不是 semver 形态的
    // 值（如读到怪 version 字段）会被排到最后，所以拿它当目标时不算更新、
    // 拿它当当前版本时仍可更新。
    let mut pair = [current.to_string(), candidate.to_string()];
    sort_newest_first(&mut pair);
    pair[0] == candidate
}

/// 输出里是不是「环境自己的锁文件坏了」，而不是这个包装不上。
///
/// pnpm 在 `pnpm-lock.yaml` 的 importers 段与 packages 段对不上时（历史合并冲突、
/// 手改、旧版本残留都会造成）会直接报 `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY` /
/// `ERR_PNPM_OUTDATED_LOCKFILE` / `Broken lockfile`，并在 help 里让人去跑
/// `pnpm install --fix-lockfile`。DSH 的 `plugin` 命令把 pnpm 当外部命令直接 exec，
/// 不会自救——所以壳必须认得出这一类失败，走一次修复重试，而不是把 pnpm 的原始
/// 报错埋在「输出：」块里让用户自己猜。
pub fn lockfile_needs_repair(output: &str) -> bool {
    output.contains("ERR_PNPM_LOCKFILE_")
        || output.contains("ERR_PNPM_OUTDATED_LOCKFILE")
        || output.contains("Broken lockfile")
}

/// pnpm 供应链保护：这次失败是因为「版本太新」，不是因为这个包装不上。
///
/// pnpm 11 起默认 `minimumReleaseAge = 1440`（发布不满 1 天的版本不参与解析）。
/// 显式 `pnpm add 包@版本` 时 pnpm 会自己把该版本写进环境的
/// `minimumReleaseAgeExclude` 放行；但只要锁文件里存在这类条目而 exclude 里没有
/// （上次更新中断、还原了旧的 `pnpm-workspace.yaml`、并发安装互相覆盖都会造成），
/// 安装前的锁文件校验就整次失败，报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`。
/// 这跟「这个包坏了」是两件事：用户点的是「更新到这个明确版本」，壳放行一次再重装。
pub fn release_age_blocked(output: &str) -> bool {
    output.contains("ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION")
        || output.contains("failed supply-chain policy")
        || output.contains("minimumReleaseAge cutoff")
}

/// pnpm 供应链保护：这次失败是因为有依赖的安装脚本没被批准。
///
/// pnpm 11 起默认不执行依赖的 `preinstall`/`install`/`postinstall`，不在环境
/// `pnpm-workspace.yaml` 的 `allowBuilds` 名单里的包会被拦下，整次 `add` 以
/// `ERR_PNPM_IGNORED_BUILDS` 失败——所以「只有新发布的那几个版本装不上」，
/// 因为它们刚引入了需要编译或下载二进制的依赖。
pub fn builds_blocked(output: &str) -> bool {
    output.contains("ERR_PNPM_IGNORED_BUILDS") || output.contains("Ignored build scripts:")
}

/// 从 pnpm 输出里取「等批准的安装脚本」属于哪些包（去重、保持出现顺序）。
///
/// 只认 `Ignored build scripts:` 之后那一行的逗号列表（`esbuild@0.28.2, sharp@0.34.1`），
/// 版本号去掉只留包名——`--allow-build` 要的是包名。抓不到就是空表，调用方据此
/// 决定别乱放行。
pub fn blocked_build_packages(output: &str) -> Vec<String> {
    const MARKER: &str = "Ignored build scripts:";
    let mut packages: Vec<String> = Vec::new();
    for line in output.lines() {
        let Some((_, rest)) = line.split_once(MARKER) else {
            continue;
        };
        for item in rest.split(',') {
            let item = item.trim().trim_end_matches('.').trim();
            if item.is_empty() {
                continue;
            }
            // `name@1.2.3` → `name`；`@scope/name@1.2.3` → `@scope/name`。
            // 只按「最后一段以数字开头」判版本，免得把 scope 里的 `@` 当分隔。
            let name = match item.rsplit_once('@') {
                Some((head, tail))
                    if !head.is_empty() && tail.starts_with(|ch: char| ch.is_ascii_digit()) =>
                {
                    head
                }
                _ => item,
            };
            if validate_package_name(name).is_ok() && !packages.iter().any(|done| done == name) {
                packages.push(name.to_string());
            }
        }
    }
    packages
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    // ---- 更新范围 ------------------------------------------------------------

    #[test]
    fn scope_keeps_third_party_and_skips_official_and_bridge() {
        assert!(in_update_scope("dsh-free-search"));
        assert!(
            in_update_scope("@someone/cool-plugin"),
            "第三方 scope 包在范围内"
        );
        assert!(
            !in_update_scope("@deepseek-ai/dsh-base"),
            "官方内置骨架包跳过"
        );
        assert!(
            !in_update_scope("@deepseek-ai/dsh-web-app"),
            "官方网页骨架跳过"
        );
        assert!(!in_update_scope(BRIDGE_PLUGIN), "桥接插件跳过");
        assert!(!in_update_scope(""), "空名字不算插件");
    }

    // ---- 包名校验 ------------------------------------------------------------

    #[test]
    fn package_name_accepts_normal_npm_names() {
        assert_eq!(validate_package_name("dsh-one"), Ok(()));
        assert_eq!(validate_package_name("billion-context"), Ok(()));
        assert_eq!(validate_package_name("@someone/cool-plugin"), Ok(()));
        assert_eq!(validate_package_name("a.b_c-d"), Ok(()));
    }

    #[test]
    fn package_name_rejects_shell_metacharacters_and_weird_shapes() {
        assert!(validate_package_name("").is_err(), "空名");
        assert!(validate_package_name("a b").is_err(), "空格会截断参数");
        assert!(validate_package_name("a;b").is_err(), "分号能续命令");
        assert!(
            validate_package_name("$(rm -rf /)").is_err(),
            "美元符能做替换"
        );
        assert!(validate_package_name("a`b").is_err(), "反引号能做替换");
        assert!(validate_package_name("'quoted'").is_err(), "引号能逃出参数");
        assert!(validate_package_name("插件").is_err(), "非 ASCII 一律不收");
        assert!(
            validate_package_name("@scope").is_err(),
            "只有 scope 没有包名"
        );
        assert!(validate_package_name("@scope/").is_err(), "包名段为空");
        assert!(validate_package_name("@/name").is_err(), "scope 段为空");
        assert!(validate_package_name("@scope/a/b").is_err(), "多于一个斜杠");
        assert!(
            validate_package_name("plain/name").is_err(),
            "不带 scope 不该有斜杠"
        );
        assert!(validate_package_name("..").is_err(), "相对路径形状");
        assert!(validate_package_name("a/../b").is_err(), "夹带相对路径");
        let long = "a".repeat(215);
        assert!(
            validate_package_name(&long).is_err(),
            "超过 npm 的 214 上限"
        );
    }

    // ---- 目标版本 ------------------------------------------------------------

    #[test]
    fn target_version_prefers_newest_including_prerelease() {
        let versions = list(&["0.2.0", "0.2.1-rc.2", "0.2.1-alpha.10", "0.2.1-alpha.2"]);
        assert_eq!(target_version(&versions).as_deref(), Some("0.2.1-rc.2"));
    }

    #[test]
    fn target_version_handles_numeric_and_text_prerelease_order() {
        // 字符串比较会把 alpha.10 排到 alpha.2 前面，semver 排序必须按数值比。
        let versions = list(&["1.0.0-alpha.2", "1.0.0-alpha.10"]);
        assert_eq!(target_version(&versions).as_deref(), Some("1.0.0-alpha.10"));
        // 正版永远比预发布新。
        let versions = list(&["1.0.0-rc.1", "1.0.0"]);
        assert_eq!(target_version(&versions).as_deref(), Some("1.0.0"));
    }

    #[test]
    fn target_version_empty_returns_none() {
        assert_eq!(target_version(&[]), None, "registry 查不到版本时没有目标");
    }

    #[test]
    fn target_version_ignores_non_version_entries() {
        // registry::parse 理论上已过滤掉非版本号；这里再兜一层底。
        let versions = list(&["1.2.3", "banana"]);
        assert_eq!(target_version(&versions).as_deref(), Some("1.2.3"));
    }

    // ---- 新旧比较 ------------------------------------------------------------

    #[test]
    fn is_newer_compares_semantically() {
        assert!(is_newer("1.2.3", "1.2.2"));
        assert!(is_newer("0.10.0", "0.9.0"), "数值比较，不是字典序");
        assert!(is_newer("1.0.0-rc.1", "1.0.0-alpha.9"));
        assert!(is_newer("1.0.0-alpha.10", "1.0.0-alpha.2"));
        assert!(!is_newer("1.2.3", "1.2.3"), "同版本不算更新");
        assert!(!is_newer("1.2.2", "1.2.3"));
        assert!(is_newer("1.2.3", "1.2.3-rc.1"), "正版比自己的预发布新");
        assert!(!is_newer("1.2.3-rc.1", "1.2.3"), "预发布不算比正版新");
        assert!(!is_newer("banana", "1.0.0"), "怪版本不冒充更新");
        assert!(is_newer("1.0.0", "banana"), "当前版本读成了怪值时仍可更新");
    }

    // ---- 锁文件损坏识别 ------------------------------------------------------

    #[test]
    fn lockfile_breakage_is_recognized() {
        // 实机日志原文（desktop 环境 2026-10-25 那次失败）。
        let real = "Progress: resolved 0, reused 1, downloaded 0, added 0\n\
                    Error: ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY\n\
                    \u{a0} \u{d7} adding a new package\n\
                    \u{a0} \u{2570}\u{2500}\u{25b6} Broken lockfile: no entry for 'billion-context@0.1.207' in pnpm-\n\
                    \u{a0} \u{a0} \u{a0} \u{a0} lock.yaml\n";
        assert!(lockfile_needs_repair(real));
        // 只认锁文件这一类，别的 pnpm 报错不该触发自动修复。
        assert!(lockfile_needs_repair("Error: ERR_PNPM_OUTDATED_LOCKFILE"));
        assert!(!lockfile_needs_repair("Error: ERR_PNPM_FETCH_404"));
        assert!(!lockfile_needs_repair(
            "Error: ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependencies"
        ));
        assert!(!lockfile_needs_repair(""));
        assert!(!lockfile_needs_repair("Progress: resolved 12, reused 12"));
    }

    // ---- pnpm 供应链保护识别 -------------------------------------------------

    #[test]
    fn release_age_violation_is_recognized() {
        // 实机日志原文（desktop 环境 2026-10-21 那次失败，dshmarket@1.66.45）。
        let real = "\u{d7} Lockfile failed supply-chain policy check (73 entries in 3.3s)\n\
                    [ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n\
                    \u{a0} dshmarket@1.66.45 was published at 2026-10-20T17:40:41.049Z, within the minimumReleaseAge cutoff\n";
        assert!(release_age_blocked(real));
        // 成功时的 exclude 提示不该被当成失败（那种行里也有 minimumReleaseAge 字样）。
        assert!(!release_age_blocked(
            "Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml:\n  dsh-ops@0.4.4\nDone in 25.5s"
        ));
        assert!(!release_age_blocked(""));
        assert!(!release_age_blocked("Error: ERR_PNPM_FETCH_404"));
    }

    #[test]
    fn blocked_build_scripts_are_recognized_and_named() {
        // 实机输出（DSH 自带的 pnpm 11.28.5 装 esbuild）。
        let real = "dependencies:\n+ esbuild 0.28.2\n\n\
                    [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.28.2\n\n\
                    Run \"pnpm approve-builds\" to pick which dependencies should be allowed to run scripts.\n";
        assert!(builds_blocked(real));
        assert_eq!(blocked_build_packages(real), list(&["esbuild"]));

        // 多个包、带 scope、结尾带句号都要能认出来，且去重。
        let multi =
            "x\nIgnored build scripts: @scope/native@1.2.3, sharp@0.34.1, esbuild@0.28.2.\n";
        assert_eq!(
            blocked_build_packages(multi),
            list(&["@scope/native", "sharp", "esbuild"])
        );
        let dup = "Ignored build scripts: sharp@0.34.1\nIgnored build scripts: sharp@0.34.2\n";
        assert_eq!(blocked_build_packages(dup), list(&["sharp"]));

        // 不是这一类失败就别乱放行。
        assert!(!builds_blocked("Error: ERR_PNPM_FETCH_404"));
        assert!(blocked_build_packages("Error: ERR_PNPM_FETCH_404").is_empty());
    }
}
