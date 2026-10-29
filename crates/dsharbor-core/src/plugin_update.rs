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

/// 一条「包名@具体版本」的引用：pnpm 放行清单里的一格、报错里点名的一个包。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageSpec {
    pub name: String,
    pub version: String,
}

impl PackageSpec {
    /// 从 `name@1.2.3` / `@scope/name@1.2.3` 解析；不带版本后缀或形状不合法时 `None`。
    pub fn parse(text: &str) -> Option<Self> {
        let text = text
            .trim()
            .trim_matches(|ch| ch == '\'' || ch == '"')
            .trim();
        let name = crate::npx_cache::spec_package_name(text);
        if name.is_empty() || name == text {
            return None;
        }
        let version = text[name.len()..].strip_prefix('@')?;
        if !crate::registry::is_version_like(version) || validate_package_name(name).is_err() {
            return None;
        }
        Some(Self {
            name: name.to_string(),
            version: version.to_string(),
        })
    }

    /// 写回 pnpm 配置时的样子（`name@1.2.3`）。
    pub fn written(&self) -> String {
        format!("{}@{}", self.name, self.version)
    }
}

/// pnpm 供应链保护：这次失败是因为有包「发布还不满最低时长」，不是这个包装不上。
///
/// pnpm 11 起默认 `minimumReleaseAge = 1440`（发布不满 1 天的版本不参与解析）。
/// 只在两种输出里认，别的 `failed supply-chain policy`（信任降级、包内容不匹配）
/// 不是同一回事，不能跟着一起放行：
/// - `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`：锁文件里已有条目没过校验（pnpm 11/12）；
/// - `ERR_PNPM_NO_MATURE_MATCHING_VERSION`：解析阶段挑不到够旧的版本（pnpm 11/12）。
///
/// 不认 `minimumReleaseAge cutoff` 这句话：它是正文里的自由文本，pnpm 12 会在
/// 80 列处硬换行，包名一长就断成两行，认不稳。
pub fn release_age_blocked(output: &str) -> bool {
    output.contains("ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION")
        || output.contains("ERR_PNPM_NO_MATURE_MATCHING_VERSION")
}

/// 从 pnpm 报错里取出「卡在发布时长上的那些包」。
///
/// 两种错误共用一种正文行：`<包名>@<版本> was published at <时间>, within the
/// minimumReleaseAge cutoff (...)`——包名与版本一定在同一行开头，换行只会发生在
/// 时间戳之后，所以按 ` was published at ` 切就够稳。同一份输出里出现多次只取一次。
///
/// pnpm 11 最多列 20 条（后面跟 `…and N more`），所以调用方要准备再跑一轮。
pub fn release_age_offenders(output: &str) -> Vec<PackageSpec> {
    let mut offenders: Vec<PackageSpec> = Vec::new();
    for line in output.lines() {
        let Some((spec, _)) = line.trim().split_once(" was published at ") else {
            continue;
        };
        if let Some(parsed) = PackageSpec::parse(spec) {
            if !offenders.contains(&parsed) {
                offenders.push(parsed);
            }
        }
    }
    offenders
}

/// pnpm 供应链保护：这次失败是因为有依赖的安装脚本没被批准。
///
/// pnpm 11 起默认不执行依赖的 `preinstall`/`install`/`postinstall`，不在环境
/// `pnpm-workspace.yaml` 的 `allowBuilds` 名单里的包会被拦下，整次 `add` 以
/// `ERR_PNPM_IGNORED_BUILDS` 失败——所以「只有新发布的那几个版本装不上」，
/// 因为它们刚引入了需要编译或下载二进制的依赖。
///
/// 只用来判断「是不是这一类失败」；要放行哪个包、哪一版，一律以环境自己的
/// `node_modules/.modules.yaml` 里的 `ignoredBuilds` 为准——报错正文会被 pnpm 12
/// 在 80 列处硬换行，还专挑连字符处断（`utf-8-` / `validate@6.0.5`），照着正文
/// 抠包名会把半个名字当参数传下去。
pub fn builds_blocked(output: &str) -> bool {
    output.contains("ERR_PNPM_IGNORED_BUILDS") || output.contains("Ignored build scripts:")
}

/// 从环境的 `node_modules/.modules.yaml` 里读「还没被批准的安装脚本」。
///
/// pnpm 11/12 都把这份文件写成 JSON 形状，名单在 `ignoredBuilds` 里，条目是
/// 精确的 `name@version`。为什么不用报错正文：pnpm 12 会在 80 列处硬换行，
/// 还专挑连字符处断（`utf-8-` / `validate@6.0.5`），照着正文抠包名会把半个
/// 名字当参数传下去（那条参数还会被 pnpm 永久记进 `allowBuilds`）。
///
/// 读不出 JSON（文件缺失、被改坏）就当没有待批准项——调用方本来就只把它
/// 当「这次新出现了哪些」的依据。
pub fn parse_modules_ignored_builds(text: &str) -> Vec<PackageSpec> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    value
        .get("ignoredBuilds")
        .and_then(|list| list.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter_map(PackageSpec::parse)
                .collect()
        })
        .unwrap_or_default()
}

/// 把「发布时长豁免」补进环境的 `pnpm-workspace.yaml`，返回（新文本，真正补上的条目）。
///
/// 为什么壳要动手改这个文件：pnpm 在宽松模式（默认）下会自己把当次解析到的
/// 新版本写进 `minimumReleaseAgeExclude`，但**只在它自己走得通的时候**。一旦
/// 锁文件里已经躺着一个没放行的新版本，`add` / `install` 会整次失败，什么也不写；
/// 而「只把闸门关掉一次」（`--config.minimumReleaseAge=0`）虽然能装成功，同样
/// 不写清单——环境就永远停在「下次再撞一次」的状态。补清单等价于 pnpm 自己
/// 在成功那次会做的事，且不改任何别的设置。
///
/// 只认块状写法（`minimumReleaseAgeExclude:` 下面一行一项）。键不存在就追加；
/// 键写成行内数组之类认不出的形状就原样返回、一条都不补，绝不猜着改。
pub fn merge_release_age_exclude(
    yaml: &str,
    additions: &[PackageSpec],
) -> (String, Vec<PackageSpec>) {
    const KEY: &str = "minimumReleaseAgeExclude:";
    let newline = if yaml.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = yaml.split_inclusive('\n').map(str::to_string).collect();
    let key_index = lines
        .iter()
        .position(|line| exclude_key_tail(line).is_some());
    // 键后面直接跟了值（`key: [...]` / `key: []`）：行内写法认不准，一个字都不改。
    if let Some(index) = key_index {
        let tail = exclude_key_tail(&lines[index]).unwrap_or_default();
        if !tail.is_empty() && !tail.starts_with('#') {
            return (yaml.to_string(), Vec::new());
        }
    }
    let mut applied: Vec<PackageSpec> = Vec::new();
    let block_start = match key_index {
        Some(index) => index + 1,
        None => {
            // 追加一整块：留一个空行与上面的内容分开（空文件不画蛇添足）。
            if !yaml.trim().is_empty() {
                if !yaml.ends_with('\n') {
                    lines.push(newline.to_string());
                }
                lines.push(newline.to_string());
            }
            lines.push(format!("{KEY}{newline}"));
            lines.len()
        }
    };
    // 块到下一个顶层键为止；新条目插在最后一条已有条目之后（不插到块尾的空行后面）。
    let mut block_end = block_start;
    while block_end < lines.len() {
        let raw = lines[block_end].trim_end_matches(['\r', '\n']);
        let trimmed = raw.trim();
        let top_level = !raw.is_empty() && !raw.starts_with([' ', '\t']);
        if top_level && !trimmed.starts_with('#') {
            break;
        }
        block_end += 1;
    }
    let last_item = (block_start..block_end)
        .rev()
        .find(|&index| lines[index].trim_start().starts_with("- "));
    let insert_at = match last_item {
        Some(index) => index + 1,
        None => block_start,
    };
    // 缩进沿用已有的条目（没有就两格）。
    let indent = lines[block_start..block_end]
        .iter()
        .find(|line| line.trim_start().starts_with("- "))
        .map(|line| line.len() - line.trim_start().len())
        .unwrap_or(2);

    let mut cursor = insert_at;
    for addition in additions {
        let existing = (block_start..block_end).find(|&index| {
            item_specs(&lines[index])
                .first()
                .and_then(|spec| PackageSpec::parse(spec))
                .map(|spec| spec.name == addition.name)
                .unwrap_or(false)
        });
        match existing {
            Some(index) => {
                // 第一个片段是 `包名@版本`，后面都是裸版本号（`|| 1.1.9`）。
                let already = item_specs(&lines[index]).iter().enumerate().any(
                    |(offset, token)| match offset {
                        0 => token == &addition.written(),
                        _ => token == &addition.version,
                    },
                );
                if already {
                    continue;
                }
                let raw = lines[index].trim_end_matches(['\r', '\n']).to_string();
                let updated = append_exclude_version(&raw, &addition.version);
                lines[index] = format!("{updated}{newline}");
                applied.push(addition.clone());
            }
            None => {
                let quoted = if addition.name.starts_with('@') {
                    format!("'{}'", addition.written())
                } else {
                    addition.written()
                };
                let line = format!("{}- {quoted}{newline}", " ".repeat(indent));
                lines.insert(cursor, line);
                cursor += 1;
                block_end += 1;
                applied.push(addition.clone());
            }
        }
    }
    (lines.concat(), applied)
}

/// 这一行是不是 `minimumReleaseAgeExclude:` 键；是就返回键名后面剩下的部分。
///
/// 键名后面必须是空白 / 注释 / 行尾——`minimumReleaseAgeExcludeSomething:` 不是它。
fn exclude_key_tail(line: &str) -> Option<String> {
    const KEY: &str = "minimumReleaseAgeExclude:";
    let tail = line
        .trim_end_matches(['\r', '\n'])
        .trim_start()
        .strip_prefix(KEY)?;
    if !tail.is_empty() && !tail.starts_with([' ', '\t', '#']) {
        return None;
    }
    Some(tail.trim().to_string())
}

/// 一条放行清单项里的各个「包名@版本」（`name@1.0.0 || 1.0.1` 按 `||` 拆开）。
fn item_specs(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    let Some(rest) = trimmed.strip_prefix("- ") else {
        return Vec::new();
    };
    let unquoted = rest.trim().trim_matches(|ch| ch == '\'' || ch == '"');
    unquoted
        .split("||")
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

/// 在一条清单项末尾追加一个版本（只在没有重复时调用），保持原有的引号风格。
fn append_exclude_version(raw: &str, version: &str) -> String {
    let trimmed = raw.trim_end();
    // 带收尾引号的写法（`- '@scope/x@1 || 2'`）：补在收尾引号里面。
    if let Some(body) = trimmed.strip_suffix('\'') {
        if let Some(open) = body.find('\'') {
            let inner = &body[open + 1..];
            let separator = if inner.trim_end().ends_with("||") {
                " "
            } else {
                " || "
            };
            return format!("{}{}{separator}{version}'", &body[..=open], inner);
        }
    }
    format!("{trimmed} || {version}")
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
        // pnpm 12 解析阶段挑不到够旧的版本（另一种同源报错）。
        assert!(release_age_blocked(
            "Error: ERR_PNPM_NO_MATURE_MATCHING_VERSION\n\n  \u{d7} adding a new package"
        ));
        // 只有那句泛化的横幅不算：信任降级、包内容不匹配也印它，不是发布时长问题。
        assert!(!release_age_blocked(
            "\u{d7} Lockfile failed supply-chain policy check (214 entries in 2.5s)\n\
             Error: ERR_PNPM_TRUST_DOWNGRADE"
        ));
        // 成功时的 exclude 提示不该被当成失败（那种行里也有 minimumReleaseAge 字样）。
        assert!(!release_age_blocked(
            "Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml:\n  dsh-ops@0.4.4\nDone in 25.5s"
        ));
        assert!(!release_age_blocked(""));
        assert!(!release_age_blocked("Error: ERR_PNPM_FETCH_404"));
    }

    #[test]
    fn release_age_offenders_are_read_from_both_error_shapes() {
        // pnpm 12（锁文件校验）：miette 会在 80 列处硬换行，但包名与版本永远在同一行开头。
        let wrapped = "\u{d7} Lockfile failed supply-chain policy check (214 entries in 2.5s)\n\
                       Error: ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION\n\n  \u{d7} adding a new package\n\
                       \u{a0} \u{2570}\u{2500}\u{25b6} 1 lockfile entries failed verification:\n\
                       \u{a0} \u{a0} \u{a0} \u{a0} dshmarket@1.73.3 was published at 2026-10-28T20:37:58.000Z, within the\n\
                       \u{a0} \u{a0} \u{a0} minimumReleaseAge cutoff (2026-10-27T23:22:58.166Z)\n";
        assert_eq!(
            release_age_offenders(wrapped),
            vec![PackageSpec {
                name: "dshmarket".into(),
                version: "1.73.3".into()
            }]
        );
        // pnpm 11/12（解析阶段）：单行写法，可以列多个包，含范围依赖带进来的包。
        let flat = "[ERR_PNPM_NO_MATURE_MATCHING_VERSION] 2 versions do not meet the minimumReleaseAge constraint:\n\
                    \u{a0} dsh-context@0.78.0 was published at 2026-10-28T15:23:19.740Z, within the minimumReleaseAge cutoff (2026-09-28T23:09:05.870Z)\n\
                    \u{a0} @scope/zod@4.6.7 was published at 2026-10-12T16:29:37.778Z, within the minimumReleaseAge cutoff (2026-09-28T23:09:05.870Z)\n";
        assert_eq!(
            release_age_offenders(flat),
            vec![
                PackageSpec {
                    name: "dsh-context".into(),
                    version: "0.78.0".into()
                },
                PackageSpec {
                    name: "@scope/zod".into(),
                    version: "4.6.7".into()
                }
            ]
        );
        // 重复只取一次；不是这一类行就一条都不取。
        let dup = "  x@1.0.0 was published at 2026-01-01T00:00:00.000Z\n  x@1.0.0 was published at 2026-01-01T00:00:00.000Z";
        assert_eq!(release_age_offenders(dup).len(), 1);
        assert!(release_age_offenders(
            "Error: ERR_PNPM_FETCH_404\n  not-a-spec was published at x"
        )
        .is_empty());
        assert!(release_age_offenders("").is_empty());
    }

    #[test]
    fn exclude_merge_appends_versions_and_keeps_the_rest_byte_for_byte() {
        let yaml = "packages:\n  - .\n\nnodeLinker: hoisted\nminimumReleaseAgeExclude:\n\
                    \u{20} - dshmarket@1.66.14 || 1.66.15\n\
                    \u{20} - '@michengai/x@1.1.7'\n\
                    \nallowBuilds:\n  esbuild: true\n";
        let (merged, applied) = merge_release_age_exclude(
            yaml,
            &[
                PackageSpec {
                    name: "dshmarket".into(),
                    version: "1.73.3".into(),
                },
                PackageSpec {
                    name: "@michengai/x".into(),
                    version: "1.1.9".into(),
                },
                PackageSpec {
                    name: "zod".into(),
                    version: "4.6.7".into(),
                },
            ],
        );
        assert_eq!(
            merged,
            "packages:\n  - .\n\nnodeLinker: hoisted\nminimumReleaseAgeExclude:\n\
             \u{20} - dshmarket@1.66.14 || 1.66.15 || 1.73.3\n\
             \u{20} - '@michengai/x@1.1.7 || 1.1.9'\n\
             \u{20} - zod@4.6.7\n\
             \nallowBuilds:\n  esbuild: true\n"
        );
        assert_eq!(applied.len(), 3);
    }

    #[test]
    fn exclude_merge_is_idempotent_and_bails_out_on_shapes_it_cannot_read() {
        let additions = [PackageSpec {
            name: "dshmarket".into(),
            version: "1.73.3".into(),
        }];
        let once = "minimumReleaseAgeExclude:\n  - dshmarket@1.73.3 || 1.74.0\n";
        let (merged, applied) = merge_release_age_exclude(once, &additions);
        assert_eq!(merged, once, "已经在清单里的版本不该重复追加");
        assert!(applied.is_empty());
        // 版本在 `||` 后面的片段里（裸版本号，不带包名）也算已经有了。
        let tail = "minimumReleaseAgeExclude:\n  - dshmarket@1.73.0 || 1.73.3\n";
        let (merged, applied) = merge_release_age_exclude(tail, &additions);
        assert_eq!(merged, tail, "第二个片段是裸版本号，不能漏判");
        assert!(applied.is_empty());

        // 没有这个键：补一整块（不是重复键），原有内容一字不改。
        let bare = "packages:\n  - .\n";
        let (merged, applied) = merge_release_age_exclude(bare, &additions);
        assert_eq!(
            merged,
            "packages:\n  - .\n\nminimumReleaseAgeExclude:\n  - dshmarket@1.73.3\n"
        );
        assert_eq!(applied.len(), 1);

        // 行内写法认不准：原样返回，宁可不补也不改坏。
        let inline = "minimumReleaseAgeExclude: [dshmarket@1.0.0]\n";
        let (merged, applied) = merge_release_age_exclude(inline, &additions);
        assert_eq!(merged, inline);
        assert!(applied.is_empty());
    }

    #[test]
    fn blocked_build_scripts_are_recognized() {
        // 实机输出（DSH 自带的 pnpm 11.28.5 装 esbuild）。
        let real = "dependencies:\n+ esbuild 0.28.2\n\n\
                    [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.28.2\n\n\
                    Run \"pnpm approve-builds\" to pick which dependencies should be allowed to run scripts.\n";
        assert!(builds_blocked(real));
        assert!(!builds_blocked("Error: ERR_PNPM_FETCH_404"));
    }

    #[test]
    fn ignored_builds_are_read_from_the_modules_manifest() {
        // 实机形状（pnpm 11/12 都写成 JSON）：精确到版本，带 scope 也能读。
        let real = r#"{
  "hoistedDependencies": {},
  "ignoredBuilds": ["esbuild@0.28.1", "@scope/native@2.0.0"],
  "layoutVersion": 5
}"#;
        assert_eq!(
            parse_modules_ignored_builds(real),
            vec![
                PackageSpec {
                    name: "esbuild".into(),
                    version: "0.28.1".into()
                },
                PackageSpec {
                    name: "@scope/native".into(),
                    version: "2.0.0".into()
                }
            ]
        );
        // 没有这个字段 / 不是 JSON / 文件缺失都当没有待批准项。
        assert!(parse_modules_ignored_builds(r#"{"layoutVersion": 5}"#).is_empty());
        assert!(parse_modules_ignored_builds("hoistedDependencies: {}\n").is_empty());
        assert!(parse_modules_ignored_builds("").is_empty());
    }

    #[test]
    fn package_spec_parses_only_concrete_name_version_pairs() {
        assert_eq!(
            PackageSpec::parse("dshmarket@1.73.3"),
            Some(PackageSpec {
                name: "dshmarket".into(),
                version: "1.73.3".into()
            })
        );
        assert_eq!(
            PackageSpec::parse("  '@scope/x@0.2.1-rc.4' "),
            Some(PackageSpec {
                name: "@scope/x".into(),
                version: "0.2.1-rc.4".into()
            })
        );
        assert_eq!(PackageSpec::parse("dshmarket"), None, "没有版本后缀");
        assert_eq!(
            PackageSpec::parse("@scope/x@next"),
            None,
            "dist-tag 不是版本"
        );
        assert_eq!(PackageSpec::parse(""), None);
        assert_eq!(
            PackageSpec {
                name: "@scope/x".into(),
                version: "1.0.0".into()
            }
            .written(),
            "@scope/x@1.0.0"
        );
    }
}
