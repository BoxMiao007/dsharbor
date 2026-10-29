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
/// **安全边界**：这是用户环境里的真实文件，写坏一次该环境所有 pnpm 操作都报废。
/// 所以只处理能看懂的块状序列（有缩进与无缩进两种都合法），并且：
/// - 键写成行内数组、值在键的下一行用 flow 写法、条目是映射/怪引号……
///   一律原样返回、一条都不补（调用方会退到「临时关闸门」的兜底）；
/// - 全文出现过这个键名却没被认出来，也不追加新键——否则会变成重复键；
/// - 根节点是 flow 形式（`{}` / `[]`）时不追加（会变成两个根节点）。
pub fn merge_release_age_exclude(
    yaml: &str,
    additions: &[PackageSpec],
) -> (String, Vec<PackageSpec>) {
    const KEY: &str = "minimumReleaseAgeExclude:";
    let unchanged = || (yaml.to_string(), Vec::new());
    let newline = if yaml.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = yaml.split_inclusive('\n').map(str::to_string).collect();
    // 末尾没有换行时先补一个：否则新追加的条目会与最后一行拼成一行。
    if let Some(last) = lines.last_mut() {
        if !last.ends_with('\n') {
            last.push_str(newline);
        }
    }
    let key_index = lines
        .iter()
        .position(|line| exclude_key_tail(line).is_some());
    let block = match key_index {
        None => {
            // 认不出键就先别追加：文件里出现过这个名字说明写法超出理解范围
            // （BOM、引号键、别处提及……），再追加一个同名键只会更糟。
            if yaml.contains("minimumReleaseAgeExclude") || root_is_flow(&lines) {
                return unchanged();
            }
            // 追加一整块：留一个空行与上面的内容分开（空文件不画蛇添足）。
            if !yaml.trim().is_empty() {
                lines.push(newline.to_string());
            }
            lines.push(format!("{KEY}{newline}"));
            let at = lines.len();
            Block {
                start: at,
                end: at,
                indent: 2,
            }
        }
        Some(index) => {
            let tail = exclude_key_tail(&lines[index]).unwrap_or_default();
            // 键后面直接跟了值（`key: [...]` / `key: []`）：行内写法认不准，一个字都不改。
            if !tail.is_empty() && !tail.starts_with('#') {
                return unchanged();
            }
            let Some(block) = scan_block(&lines, index + 1) else {
                return unchanged();
            };
            block
        }
    };

    let mut applied: Vec<PackageSpec> = Vec::new();
    let last_item = (block.start..block.end)
        .rev()
        .find(|&index| lines[index].trim_start().starts_with("- "));
    let mut cursor = match last_item {
        Some(index) => index + 1,
        None => block.start,
    };
    for addition in additions {
        let existing = (block.start..block.end).find(|&index| {
            item_specs(&lines[index])
                .first()
                .and_then(|spec| PackageSpec::parse(spec))
                .map(|spec| spec.name == addition.name)
                .unwrap_or(false)
        });
        if let Some(index) = existing {
            // 行尾带注释（pnpm 不会这么写，但用户可能手改）：追加会把版本写进
            // 注释里，等于没放行。改成另起一行，别碰原文。
            if !lines[index].contains('#') {
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
                let raw = lines[index].trim_end_matches(['\r', '\n']);
                let Some(updated) = append_exclude_version(raw, &addition.version) else {
                    // 引号结构认不准（混合引号、flow 条目……）：这一条不补。
                    continue;
                };
                lines[index] = format!("{updated}{newline}");
                applied.push(addition.clone());
                continue;
            }
        }
        let quoted = if addition.name.starts_with('@') {
            format!("'{}'", addition.written())
        } else {
            addition.written()
        };
        let line = format!("{}- {quoted}{newline}", " ".repeat(block.indent));
        lines.insert(cursor, line);
        cursor += 1;
        applied.push(addition.clone());
    }
    // 兜底自检：合并后必须恰好一个这个键（重复键会让 pnpm 读不了配置）。
    if lines
        .iter()
        .filter(|line| exclude_key_tail(line).is_some())
        .count()
        != 1
    {
        return unchanged();
    }
    (lines.concat(), applied)
}

/// `minimumReleaseAgeExclude` 块的范围与条目缩进。
struct Block {
    start: usize,
    end: usize,
    indent: usize,
}

/// 扫描键下面的块序列，返回范围与缩进；认不出的形状返回 `None`。
///
/// 支持两种合法写法：有缩进的序列（`  - pkg@1`）与**无缩进序列**
/// （`- pkg@1` 顶格，YAML 规范允许，真实仓库里就有）。除此之外——flow 数组、
/// 下一行裸标量、映射项——一律不认，让调用方走兜底。
fn scan_block(lines: &[String], start: usize) -> Option<Block> {
    let first = (start..lines.len()).find(|&index| meaningful(&lines[index]))?;
    let raw = lines[first].trim_end_matches(['\r', '\n']);
    let body = raw.trim_start();
    if body.starts_with(['[', '{']) {
        return None;
    }
    if !body.starts_with("- ") {
        return None;
    }
    let indent = raw.len() - body.len();
    // 块到下一个「顶层且不是注释」的行为止；无缩进序列里顶格的 `- ` 仍算块内。
    let mut end = start;
    while end < lines.len() {
        let line = lines[end].trim_end_matches(['\r', '\n']);
        let trimmed = line.trim();
        let top_level = !line.is_empty() && !line.starts_with([' ', '\t']);
        let indentless_item = indent == 0 && line.starts_with("- ");
        if top_level && !trimmed.starts_with('#') && !indentless_item {
            break;
        }
        end += 1;
    }
    Some(Block { start, end, indent })
}

/// 这一行是不是有效内容（非空、不是注释）。
fn meaningful(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && !trimmed.starts_with('#')
}

/// 根节点是不是 flow 形式（`{}` / `[]`）；是的话不能再追加块状键。
fn root_is_flow(lines: &[String]) -> bool {
    for line in lines {
        let trimmed = line.trim_start_matches('\u{feff}').trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed == "---" {
            continue;
        }
        return trimmed.starts_with('{') || trimmed.starts_with('[');
    }
    false
}

/// 这一行是不是 `minimumReleaseAgeExclude:` 键；是就返回键名后面剩下的部分。
///
/// 容忍行首 BOM、引号包起来的键名、冒号前的空白、行尾注释——这些写法 pnpm 都认，
/// 认不出来就会走到「追加一个同名键」那条更糟的路上。
fn exclude_key_tail(line: &str) -> Option<String> {
    let text = line
        .trim_end_matches(['\r', '\n'])
        .trim_start_matches('\u{feff}')
        .trim_start();
    let (name, tail) = text.split_once(':')?;
    let name = name.trim().trim_matches(|ch| ch == '\'' || ch == '"');
    if name != "minimumReleaseAgeExclude" {
        return None;
    }
    if !tail.is_empty() && !tail.starts_with([' ', '\t', '#']) {
        return None;
    }
    Some(tail.trim().to_string())
}

/// 拆一条序列项：返回（条目本体，包住它的引号）。引号结构认不准时 `None`。
fn item_body(line: &str) -> Option<(&str, Option<char>)> {
    let trimmed = line.trim();
    let item = trimmed.strip_prefix("- ")?.trim_end();
    if let Some(quote) = item.chars().next().filter(|ch| *ch == '\'' || *ch == '"') {
        if item.len() < 2 || !item.ends_with(quote) {
            return None;
        }
        let inner = &item[1..item.len() - 1];
        // 混合引号（`'a@1' || '2'`）不是 pnpm 的写法，也认不准，别碰。
        if inner.contains(quote) {
            return None;
        }
        return Some((inner, Some(quote)));
    }
    if item.starts_with(['[', '{']) {
        return None;
    }
    Some((item, None))
}

/// 一条放行清单项里的各个「包名@版本」（`name@1.0.0 || 1.0.1` 按 `||` 拆开）。
///
/// 行尾注释先切掉：包名里不允许出现 `#`，按它切不会误伤真包名；不切的话
/// `dshmarket@1.0.0 # 备注` 的版本部分解析不出来，会被当成「清单里没有这个包」。
fn item_specs(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    let Some(rest) = trimmed.strip_prefix("- ") else {
        return Vec::new();
    };
    let rest = rest.split_once('#').map(|(head, _)| head).unwrap_or(rest);
    let rest = rest.trim();
    let inner = item_body(line).map(|(body, _)| body).unwrap_or(rest);
    inner
        .split("||")
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

/// 在一条清单项末尾追加一个版本，保持原有的缩进与引号风格。
///
/// 引号结构认不准（混合引号、flow 条目）就返回 `None`——宁可这一条不补，
/// 也不要把非法 YAML 写进用户的环境文件。
fn append_exclude_version(raw: &str, version: &str) -> Option<String> {
    let trimmed = raw.trim_end();
    let indent_len = trimmed.len() - trimmed.trim_start().len();
    let indent = &trimmed[..indent_len];
    let (item, quote) = item_body(trimmed)?;
    let separator = if item.trim_end().ends_with("||") {
        " "
    } else {
        " || "
    };
    let body = format!("{}{separator}{version}", item.trim_end());
    Some(match quote {
        Some(quote) => format!("{indent}- {quote}{body}{quote}"),
        None => format!("{indent}- {body}"),
    })
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
    fn exclude_merge_survives_missing_final_newline_and_refuses_commented_lines() {
        // 文件最后一行没有换行：新条目不能和它拼成一行。
        let no_eol = "minimumReleaseAgeExclude:\n  - dshmarket@1.0.0";
        let (merged, applied) = merge_release_age_exclude(
            no_eol,
            &[PackageSpec {
                name: "dshmarket".into(),
                version: "1.73.3".into(),
            }],
        );
        assert_eq!(
            merged,
            "minimumReleaseAgeExclude:\n  - dshmarket@1.0.0 || 1.73.3\n"
        );
        assert_eq!(applied.len(), 1);

        // 行尾带注释：版本不能追加到注释后面（等于没放行），改另起一行。
        let commented = "minimumReleaseAgeExclude:\n  - dshmarket@1.0.0 # 手改过\n";
        let (merged, applied) = merge_release_age_exclude(
            commented,
            &[PackageSpec {
                name: "dshmarket".into(),
                version: "1.73.3".into(),
            }],
        );
        assert_eq!(
            merged,
            "minimumReleaseAgeExclude:\n  - dshmarket@1.0.0 # 手改过\n  - dshmarket@1.73.3\n"
        );
        assert_eq!(applied.len(), 1);
    }

    #[test]
    fn exclude_merge_keeps_every_legal_shape_legal() {
        let addition = |name: &str, version: &str| PackageSpec {
            name: name.into(),
            version: version.into(),
        };
        // 无缩进序列（合法 YAML，真实仓库里有这种写法）：沿用 0 缩进往后接，
        // 不能把顶格的 `- ` 当成「下一个顶层键」再把条目插到它前面。
        let indentless = "minimumReleaseAgeExclude:\n- dshmarket@1.0.0\nallowBuilds:\n  x: true\n";
        let (merged, applied) = merge_release_age_exclude(
            indentless,
            &[addition("dshmarket", "1.73.3"), addition("zod", "4.6.7")],
        );
        assert_eq!(
            merged,
            "minimumReleaseAgeExclude:\n- dshmarket@1.0.0 || 1.73.3\n- zod@4.6.7\nallowBuilds:\n  x: true\n"
        );
        assert_eq!(applied.len(), 2);

        // 键的下一行是 flow 数组：认不出，原样返回（调用方走临时关闸门兜底）。
        let flow = "minimumReleaseAgeExclude:\n  [dshmarket@1.0.0]\nallowBuilds:\n  x: true\n";
        assert_eq!(
            merge_release_age_exclude(flow, &[addition("zod", "4.6.7")]),
            (flow.to_string(), Vec::new())
        );

        // 双引号条目：版本补进闭引号里面，不是拼在引号外。
        let double = "minimumReleaseAgeExclude:\n  - \"dshmarket@1.0.0\"\n";
        let (merged, applied) =
            merge_release_age_exclude(double, &[addition("dshmarket", "1.73.3")]);
        assert_eq!(
            merged,
            "minimumReleaseAgeExclude:\n  - \"dshmarket@1.0.0 || 1.73.3\"\n"
        );
        assert_eq!(applied.len(), 1);

        // 混合引号不是 pnpm 的写法，也认不准：这一条不补（返回原样）。
        let mixed = "minimumReleaseAgeExclude:\n  - 'a@1.0.0' || '2.0.0'\n";
        assert_eq!(
            merge_release_age_exclude(mixed, &[addition("a", "3.0.0")]),
            (mixed.to_string(), Vec::new())
        );

        // 带 BOM 的键要认得出，不能追加出第二个同名键。
        let bom = "\u{feff}minimumReleaseAgeExclude:\n  - dshmarket@1.0.0\n";
        let (merged, applied) = merge_release_age_exclude(bom, &[addition("dshmarket", "1.73.3")]);
        assert_eq!(
            merged,
            "\u{feff}minimumReleaseAgeExclude:\n  - dshmarket@1.0.0 || 1.73.3\n"
        );
        assert_eq!(applied.len(), 1);

        // 根节点是 flow 映射：再追加块状键会变成两个根节点，原样返回。
        let empty_map = "{}\n";
        assert_eq!(
            merge_release_age_exclude(empty_map, &[addition("zod", "4.6.7")]),
            (empty_map.to_string(), Vec::new())
        );

        // 近似但不等于的键名 / 别处提到这个名字：不猜，原样返回。
        let similar = "minimumReleaseAgeExcludePatch: 1\n";
        assert_eq!(
            merge_release_age_exclude(similar, &[addition("zod", "4.6.7")]),
            (similar.to_string(), Vec::new())
        );
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
