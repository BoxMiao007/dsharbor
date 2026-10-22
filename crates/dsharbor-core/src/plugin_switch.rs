//! 插件开关：把环境里登记的插件与补丁层里的禁用表达合成一份「启用 / 停用」视图，
//! 以及切换时该往补丁层写什么。
//!
//! 为什么开关落在补丁层而不是卸载：插件包本身装在 `node_modules` 里，关掉它只是让
//! DSH 下次加载时不挂载这一项，包还在磁盘上，重新打开不需要重新下载，也不用碰
//! pnpm 与 DSH 的锁定文件。补丁层（`cordis.patch.yml`）正是 DSH 自己提供的用户
//! 覆盖层，是唯一正确的落点。
//!
//! 两个信息源：
//! - 插件清单来自环境 `package.json` 的 `dsh.profile.bundles`（DSH 自己的登记表，
//!   `dependencies` 里有包不代表会挂载）；
//! - 每个插件在补丁层里对应哪个 entry id，来自它包内声明的 bundle 补丁文件
//!   （`- insert:` 下第一层的 `- id:`）。读不到就无法表达禁用，按「不可开关」处理
//!   —— 官方内置的那几个骨架包（`@deepseek-ai/dsh-base` / `dsh-web-app` /
//!   `dsh-headless`）在 `node_modules` 里本来就不存在，正是这种情况。
//!
//! 改写补丁层时只动「壳自己负责的那一段」：托管块里整项增删，块外已有的裸禁用
//! 表达按行摘除。用户手写的注释、`config`、`insert` 与别的项一律原样保留，所以
//! 「停用 → 启用」能一字不差地回到原文（有单测盯着）。

use serde::Serialize;

use crate::profiles::BRIDGE_PLUGIN;

/// 托管块的起始标记行（整行匹配，缩进与行尾空白不算）。
///
/// 壳写的禁用表达全在这一段里：切换插件时只增删这一段的内容，用户手写的其它
/// 补丁内容一个字都不碰；这一段空了就连标记一起删掉，于是「停用 → 启用」回到原状。
const MANAGED_OPEN: &str = "# >>> DSHarbor 插件开关（自动生成，手改会被覆盖）>>>";
/// 托管块的结束标记行。
const MANAGED_CLOSE: &str = "# <<< DSHarbor 插件开关 <<<";

/// 插件包里的 bundle 补丁文件名，按顺序找第一个存在的。
///
/// 每个包在自己的 `package.json` 里用 `dsh.bundle.patch` 声明它叫什么，实测下来
/// 全部落在下面两个名字之一。壳在 WSL 那一侧不方便解析 JSON，两侧就统一按名字试，
/// 认不出来只会让该插件显示成「不可停用」，不会误改任何文件。
pub const BUNDLE_PATCH_CANDIDATES: &[&str] = &["dsh.bundle.patch.yml", "cordis.patch.yml"];

/// bundle 补丁文件清单里每条记录的分隔前缀（后面跟包名）。
pub const BUNDLE_MARKER: &str = "@@bundle@@ ";

/// 默认缩进（补丁层里各项的子键都是 2 个空格）。
const DEFAULT_INDENT: usize = 2;

/// 一项 `disabled:` 的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Disabled {
    /// 没有禁用表达，或显式 `disabled: false`：插件会加载。
    Off,
    /// `disabled: true`：插件不加载。
    On,
    /// `disabled:` 后面是表达式（`!!js "..."`）——用户自己写的守卫，壳不代改。
    Expression,
}

/// 补丁层里的一个顶层项。
#[derive(Debug, Clone)]
struct EntryRef {
    id: String,
    /// `- id:` 那一行。
    head: usize,
    /// 该项最后一行的行号（等于 head 表示没有子行）。
    tail: usize,
    /// 子键的缩进（该项第一行缩进行的缩进；没有子行时是 0）。
    body_indent: usize,
    /// 该项里 `disabled:` 那一行。
    disabled_line: Option<usize>,
    disabled: Disabled,
    /// 是否位于壳的托管块内。
    managed: bool,
}

/// 一次扫描的结果。
#[derive(Debug, Default)]
struct Scan {
    entries: Vec<EntryRef>,
}

/// 一个插件在界面上的样子。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginItem {
    /// `dsh.profile.bundles` 里登记的名字（就是包名）。
    pub name: String,
    /// 它在补丁层里对应的 entry id（空＝读不到挂载点，不可开关）。
    pub entries: Vec<String>,
    /// 现在会不会被加载。
    pub enabled: bool,
    /// 是不是桥接插件。
    pub bridge: bool,
    /// 禁用表达在托管块之外（用户自己写的），界面上要能区分。
    pub manual: bool,
    /// 能不能开关（读不到挂载点的内置骨架包不能）。
    pub switchable: bool,
    /// 插件自带的说明文字（包 package.json 里的 description）。核心库只负责
    /// 传递：读文件是外壳的事，读不到就留 None，序列化成 null。
    #[serde(default)]
    pub description: Option<String>,
}

/// 行首缩进（空格数；制表符按一个算，补丁层里实际只用空格）。
fn indent_of(line: &str) -> usize {
    line.chars()
        .take_while(|ch| *ch == ' ' || *ch == '\t')
        .count()
}

/// 去掉列表项前缀 `- `，得到键值正文；不是列表项就原样返回（去空白后）。
fn strip_item(line: &str) -> &str {
    let trimmed = line.trim();
    if trimmed == "-" {
        return "";
    }
    match trimmed.strip_prefix("- ") {
        Some(rest) => rest.trim_start(),
        None => trimmed,
    }
}

/// `- key: 值` / `key: 值` 里那个值：去行尾注释、去引号、去空白。
///
/// 补丁层里的取值都是简单标量，够用就行；引号内的 ` #` 会被误当注释的概率为零
/// （那里只会出现包名与 entry id）。
fn value_of(line: &str, key: &str) -> Option<String> {
    let body = strip_item(line);
    let rest = body.strip_prefix(key)?;
    let rest = rest.strip_prefix(':')?;
    Some(clean_scalar(rest))
}

/// 简单标量清理：去注释、去引号、去空白。
fn clean_scalar(raw: &str) -> String {
    let mut text = raw.trim();
    if let Some(pos) = text.find(" #") {
        text = text[..pos].trim_end();
    }
    let bytes = text.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            text = &text[1..text.len() - 1];
        }
    }
    text.to_string()
}

/// 扫描补丁层：找出所有顶层项与它们的 `disabled:` 表达。
///
/// 只做到「够用」的 YAML 理解：顶层必须是列表项（DSH 就是这么加载的），子键按缩进
/// 归属，`- insert:` 下面的东西是另一个列表，不算顶层项。坏结构在这里变成可读的
/// 中文错误（带行号），不 panic。
fn scan(patch: &str) -> Result<Scan, String> {
    let lines: Vec<&str> = patch.split('\n').collect();
    let mut entries: Vec<EntryRef> = Vec::new();
    let mut managed = false;
    let mut current: Option<usize> = None;

    for (idx, raw) in lines.iter().enumerate() {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim();
        if trimmed == MANAGED_OPEN {
            managed = true;
            current = None;
            continue;
        }
        if trimmed == MANAGED_CLOSE {
            managed = false;
            current = None;
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if indent_of(line) == 0 {
            current = None;
            if !trimmed.starts_with('-') {
                return Err(format!(
                    "补丁层第 {} 行不是列表项（应以「- 」开头），DSH 会加载失败：{trimmed}",
                    idx + 1
                ));
            }
            if let Some(id) = value_of(line, "id") {
                if id.is_empty() {
                    return Err(format!("补丁层第 {} 行的「- id:」后面没有值", idx + 1));
                }
                entries.push(EntryRef {
                    id,
                    head: idx,
                    tail: idx,
                    body_indent: 0,
                    disabled_line: None,
                    disabled: Disabled::Off,
                    managed,
                });
                current = Some(entries.len() - 1);
            }
            continue;
        }

        let Some(index) = current else { continue };
        let indent = indent_of(line);
        let entry = &mut entries[index];
        if entry.body_indent == 0 {
            entry.body_indent = indent;
        }
        entry.tail = idx;
        if indent == entry.body_indent {
            if let Some(value) = value_of(line, "disabled") {
                entry.disabled_line = Some(idx);
                entry.disabled = if value == "true" {
                    Disabled::On
                } else if value.starts_with("!!") {
                    Disabled::Expression
                } else {
                    Disabled::Off
                };
            }
        }
    }

    Ok(Scan { entries })
}

/// 从 `package.json` 文本读 `dsh.profile.bundles`（保持登记顺序，去掉重复项）。
///
/// bundles 缺失按「零个插件」处理（新建的环境就是空的）；JSON 本身坏了才算错误。
pub fn bundle_names(package_json: &str) -> Result<Vec<String>, String> {
    let value: serde_json::Value = serde_json::from_str(package_json)
        .map_err(|err| format!("环境的 package.json 不是合法 JSON：{err}"))?;
    let mut names: Vec<String> = Vec::new();
    let bundles = value
        .get("dsh")
        .and_then(|dsh| dsh.get("profile"))
        .and_then(|profile| profile.get("bundles"))
        .and_then(|bundles| bundles.as_array());
    for item in bundles.into_iter().flatten() {
        let Some(name) = item.as_str() else { continue };
        if name.is_empty() || names.iter().any(|seen| seen == name) {
            continue;
        }
        names.push(name.to_string());
    }
    Ok(names)
}

/// 从一个包的 bundle 补丁文件里取它插入的 entry id：`- insert:` 下第一层的 `- id:`。
///
/// 只取第一层：`config:` 里嵌套的 id 不是挂载点。同一个 id 只报一次。
pub fn insert_entry_ids(patch: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut in_insert = false;
    let mut child_indent: Option<usize> = None;

    for raw in patch.split('\n') {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = indent_of(line);

        if in_insert {
            if indent == 0 {
                in_insert = false;
            } else {
                match child_indent {
                    None => child_indent = Some(indent),
                    Some(known) if indent < known => {
                        in_insert = false;
                        continue;
                    }
                    Some(_) => {}
                }
                if Some(indent) == child_indent {
                    if let Some(id) = value_of(line, "id") {
                        if !id.is_empty() && !ids.contains(&id) {
                            ids.push(id);
                        }
                    }
                }
            }
        }
        // `- insert:` 是本项自己的键；放在后面判，免得上面的 `indent == 0` 提前吃掉它。
        if strip_item(line) == "insert:" || strip_item(line).starts_with("insert: ") {
            in_insert = true;
            child_indent = None;
        }
    }
    ids
}

/// 解析 bundle 补丁文件清单：每条记录以 `@@bundle@@ <包名>` 开头，后面是文件原文。
///
/// 宿主与 WSL 两侧都把「每个包的补丁文件」拼成这种文本再交给这里，于是「哪个包挂了
/// 哪些 entry」只在这一处解析（有单测）。
pub fn mount_points(listing: &str) -> Vec<(String, Vec<String>)> {
    let mut result: Vec<(String, Vec<String>)> = Vec::new();
    let mut current: Option<(String, String)> = None;

    let flush = |slot: &mut Option<(String, String)>, out: &mut Vec<(String, Vec<String>)>| {
        if let Some((name, body)) = slot.take() {
            out.push((name, insert_entry_ids(&body)));
        }
    };

    for raw in listing.split('\n') {
        let line = raw.trim_end_matches('\r');
        if let Some(name) = line.strip_prefix(BUNDLE_MARKER) {
            flush(&mut current, &mut result);
            current = Some((name.trim().to_string(), String::new()));
            continue;
        }
        if let Some((_, body)) = current.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    flush(&mut current, &mut result);
    result
}

/// 合成界面上那份插件清单。
///
/// `mounts` 是 [`mount_points`] 的结果，`patch` 是补丁层原文（文件不存在就传空串）。
pub fn items(
    package_json: &str,
    mounts: &[(String, Vec<String>)],
    patch: &str,
) -> Result<Vec<PluginItem>, String> {
    let names = bundle_names(package_json)?;
    let scan = scan(patch)?;

    Ok(names
        .into_iter()
        .map(|name| {
            let entries: Vec<String> = mounts
                .iter()
                .find(|(bundle, _)| *bundle == name)
                .map(|(_, ids)| ids.clone())
                .unwrap_or_default();
            let mut disabled = false;
            let mut manual = false;
            for id in &entries {
                for entry in scan.entries.iter().filter(|entry| entry.id == *id) {
                    if entry.disabled != Disabled::Off {
                        disabled = true;
                        if !entry.managed {
                            manual = true;
                        }
                    }
                }
            }
            PluginItem {
                bridge: name == BRIDGE_PLUGIN,
                switchable: !entries.is_empty(),
                enabled: !disabled,
                manual,
                name,
                entries,
                description: None,
            }
        })
        .collect())
}

/// 切换一组 entry 的启用状态，返回改写后的补丁层文本。
///
/// 幂等：已经处于目标状态时原样返回（连同字节）。多条目按顺序逐个处理，每一步都
/// 重新扫描，所以同一次调用里前面的改动不会被后面的判断看漏。
pub fn set_disabled(
    patch: &str,
    entries: &[String],
    want_disabled: bool,
) -> Result<String, String> {
    let mut text = patch.to_string();
    for id in entries {
        text = if want_disabled {
            disable_one(&text, id)?
        } else {
            enable_one(&text, id)?
        };
    }
    Ok(text)
}

/// 自定义表达式控制的项：壳不代改，给可读错误。
fn expression_error(id: &str) -> String {
    format!(
        "「{id}」的禁用状态由补丁层里的自定义表达式控制，壳不会替你改它；要动请自己编辑 {patch} 里的这一项。",
        patch = crate::patch_layer::PATCH_FILE
    )
}

/// 停用一个 entry。
fn disable_one(patch: &str, id: &str) -> Result<String, String> {
    let scan = scan(patch)?;
    let matches: Vec<&EntryRef> = scan.entries.iter().filter(|entry| entry.id == id).collect();
    if matches
        .iter()
        .any(|entry| entry.disabled == Disabled::Expression)
    {
        return Err(expression_error(id));
    }
    if matches.iter().any(|entry| entry.disabled == Disabled::On) {
        return Ok(patch.to_string());
    }

    let cr = if patch.contains("\r\n") { "\r" } else { "" };
    let mut lines: Vec<String> = patch.split('\n').map(str::to_string).collect();

    // 已经有这一项（只是显式 `disabled: false`）：就地改值，不另加一项。
    if let Some(entry) = matches.iter().find(|entry| entry.disabled_line.is_some()) {
        let at = entry.disabled_line.unwrap_or(entry.head);
        let indent = indent_of(lines[at].as_str());
        lines[at] = format!("{}disabled: true{cr}", " ".repeat(indent));
        return Ok(lines.join("\n"));
    }
    // 已有这一项但没有禁用表达：就在它下面补一行，避免同 id 两项的合并语义不确定。
    if let Some(entry) = matches.first() {
        let indent = if entry.body_indent > 0 {
            entry.body_indent
        } else {
            DEFAULT_INDENT
        };
        lines.insert(
            entry.head + 1,
            format!("{}disabled: true{cr}", " ".repeat(indent)),
        );
        return Ok(lines.join("\n"));
    }
    // 补丁层里根本没这一项：写进托管块（这样重新启用时能整段摘干净）。
    Ok(append_to_managed(patch, id))
}

/// 启用一个 entry：把禁用表达摘掉。
fn enable_one(patch: &str, id: &str) -> Result<String, String> {
    let scan = scan(patch)?;
    let matches: Vec<&EntryRef> = scan.entries.iter().filter(|entry| entry.id == id).collect();
    if matches.is_empty() {
        return Ok(patch.to_string());
    }
    if matches
        .iter()
        .any(|entry| entry.disabled == Disabled::Expression)
    {
        return Err(expression_error(id));
    }

    let mut lines: Vec<String> = patch.split('\n').map(str::to_string).collect();
    let mut drop: Vec<usize> = Vec::new();
    for entry in &matches {
        let Some(at) = entry.disabled_line else {
            continue;
        };
        drop.push(at);
        if entry.managed {
            // 托管块里的项只有「- id」+「disabled」两行，整项摘掉。
            drop.push(entry.head);
            continue;
        }
        // 块外的项：摘掉 disabled 行后如果只剩 `- id:` 一行，整项一起摘。
        let leftovers: Vec<usize> = (entry.head..=entry.tail)
            .filter(|index| *index != entry.head && !drop.contains(index))
            .collect();
        if leftovers
            .iter()
            .all(|index| lines[*index].trim().is_empty())
        {
            drop.push(entry.head);
        }
    }
    if drop.is_empty() {
        return Ok(patch.to_string());
    }
    drop.sort_unstable();
    drop.dedup();
    for index in drop.iter().rev() {
        lines.remove(*index);
    }
    Ok(drop_empty_managed_block(&lines.join("\n")))
}

/// 把一项禁用表达追加到托管块里（没有块就在文件末尾新建一个）。
fn append_to_managed(patch: &str, id: &str) -> String {
    let cr = if patch.contains("\r\n") { "\r" } else { "" };
    let mut lines: Vec<String> = patch.split('\n').map(str::to_string).collect();
    let item = vec![
        format!("- id: {id}{cr}"),
        format!("{}disabled: true{cr}", " ".repeat(DEFAULT_INDENT)),
    ];

    if let Some(at) = lines
        .iter()
        .position(|line| line.trim_end_matches('\r').trim() == MANAGED_CLOSE)
    {
        for (offset, text) in item.into_iter().enumerate() {
            lines.insert(at + offset, text);
        }
        return lines.join("\n");
    }

    let mut block = vec![format!("{MANAGED_OPEN}{cr}")];
    block.extend(item);
    block.push(format!("{MANAGED_CLOSE}{cr}"));
    // 文件以换行结尾时 `split('\n')` 的最后一项是空串：插在它前面，别在末尾多留空行。
    let at = if lines.last().map(|line| line.is_empty()).unwrap_or(false) {
        lines.len() - 1
    } else {
        lines.len()
    };
    for (offset, text) in block.into_iter().enumerate() {
        lines.insert(at + offset, text);
    }
    lines.join("\n")
}

/// 托管块空了（没有任何 item）就连标记一起删掉，让「停用 → 启用」回到原状。
fn drop_empty_managed_block(patch: &str) -> String {
    let lines: Vec<&str> = patch.split('\n').collect();
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        if lines[index].trim_end_matches('\r').trim() == MANAGED_OPEN {
            let close = lines[index + 1..]
                .iter()
                .position(|line| line.trim_end_matches('\r').trim() == MANAGED_CLOSE);
            if let Some(offset) = close {
                let end = index + 1 + offset;
                let inner_empty = lines[index + 1..end]
                    .iter()
                    .all(|line| line.trim().is_empty());
                if inner_empty {
                    index = end + 1;
                    continue;
                }
            }
        }
        out.push(lines[index]);
        index += 1;
    }
    out.join("\n")
}

/// 零插件时的空状态提示（界面照抄，免得两处口径不一样）。
pub fn empty_hint() -> &'static str {
    "这个环境还没有装任何插件。先给环境安装依赖，再用官方命令把插件装上（dsh plugin --profile <环境名> add <插件名>）。"
}

/// 关掉桥接插件时的提醒：登录链接会失去自动获取。
pub fn bridge_off_warning() -> &'static str {
    "桥接插件已关闭：DSH 每次启动会动态生成登录链接，关掉桥接后壳取不到它，只能从日志里翻。"
}

/// 切换成功后的说明（必须提醒重启才生效）。
pub fn toggle_message(name: &str, enabled: bool) -> String {
    if enabled {
        format!("已打开「{name}」的插件开关，重启 DSH 后生效。")
    } else {
        format!("已关闭「{name}」的插件开关，重启 DSH 后生效；插件包还在磁盘上，重新打开不需要重新下载。")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER_PATCH: &str = "\
# 我自己的补丁层，别整份重写
- insert:
    - id: bili-native
      name: billion-context

- id: web-search-deepseek # magpie
  name: \"@deepseek-ai/dsh-web-search-deepseek\"
  config:
    apiKeyEnv: MAGPIE_GATEWAY_KEY
    disabled: true
";

    fn manifest(bundles: &[&str]) -> String {
        let list: Vec<String> = bundles.iter().map(|item| format!("\"{item}\"")).collect();
        format!(
            "{{\"name\":\"dsh-profile-x\",\"private\":true,\"dsh\":{{\"profile\":{{\"bundles\":[{}]}}}}}}",
            list.join(",")
        )
    }

    #[test]
    fn bundle_names_keep_registration_order_and_drop_duplicates() {
        let names = bundle_names(&manifest(&["a", "b", "a", "dsharbor-bridge"])).unwrap();
        assert_eq!(names, vec!["a", "b", "dsharbor-bridge"]);
    }

    #[test]
    fn missing_bundles_read_as_zero_plugins() {
        let names = bundle_names("{\"name\":\"dsh-profile-fresh\"}").unwrap();
        assert!(names.is_empty());
    }

    #[test]
    fn broken_package_json_is_an_error_not_a_panic() {
        let err = bundle_names("{oops").unwrap_err();
        assert!(err.contains("不是合法 JSON"), "{err}");
    }

    #[test]
    fn insert_entry_ids_take_only_the_first_level_of_insert() {
        let patch = "\
# 注释行不该影响解析
- insert:
    - id: bili-native
      name: billion-context
      config:
        nested: 1
- id: compaction-basic
  config:
    auto: false
";
        assert_eq!(insert_entry_ids(patch), vec!["bili-native"]);
    }

    #[test]
    fn insert_entry_ids_handle_inline_quoted_names() {
        let patch = "- insert:\n    - id: better-sidebar\n      name: 'dsh-better-sidebar'\n";
        assert_eq!(insert_entry_ids(patch), vec!["better-sidebar"]);
    }

    #[test]
    fn mount_points_split_records_and_ignore_packages_without_insert() {
        let listing = "@@bundle@@ a\n- insert:\n    - id: a-row\n@@bundle@@ b\n# 没有 insert\n@@bundle@@ c\n- insert:\n    - id: c-row\n";
        let mounts = mount_points(listing);
        assert_eq!(
            mounts,
            vec![
                ("a".to_string(), vec!["a-row".to_string()]),
                ("b".to_string(), Vec::new()),
                ("c".to_string(), vec!["c-row".to_string()]),
            ]
        );
    }

    #[test]
    fn items_merge_bundles_with_patch_layer_state() {
        let mounts = vec![
            ("fourth".to_string(), vec!["fourth-row".to_string()]),
            ("bridge".to_string(), vec!["bridge-row".to_string()]),
        ];
        let patch = "- id: fourth-row\n  disabled: true\n";
        let list = items(&manifest(&["builtin", "fourth", "bridge"]), &mounts, patch).unwrap();
        // 内置骨架包读不到挂载点 → 不可开关，但仍列出来。
        assert_eq!(list[0].name, "builtin");
        assert!(!list[0].switchable);
        assert!(list[0].enabled);
        assert_eq!(list[1].name, "fourth");
        assert!(list[1].switchable);
        assert!(!list[1].enabled);
        // 这份禁用表达是手写在托管块外的，要能区分出来。
        assert!(list[1].manual);
        assert!(!list[2].bridge, "名字不是桥接插件");
    }

    #[test]
    fn items_flag_the_bridge_plugin_and_manual_disable_expressions() {
        let mounts = vec![(
            BRIDGE_PLUGIN.to_string(),
            vec!["dsharbor-bridge".to_string()],
        )];
        let patch = "- id: dsharbor-bridge\n  disabled: true\n";
        let list = items(&manifest(&[BRIDGE_PLUGIN]), &mounts, patch).unwrap();
        assert!(list[0].bridge);
        assert!(!list[0].enabled);
        assert!(list[0].manual, "禁用表达在托管块外，标成手动");
    }

    #[test]
    fn nested_disabled_under_config_is_not_item_level() {
        let mounts = vec![("p".to_string(), vec!["p-row".to_string()])];
        let list = items(&manifest(&["p"]), &mounts, USER_PATCH).unwrap();
        // USER_PATCH 里 `disabled: true` 缩进 4，属于 config 的子键，不算停用。
        assert!(list[0].enabled);
    }

    #[test]
    fn disable_then_enable_returns_to_the_original_bytes() {
        let original = USER_PATCH.to_string();
        let mounts = [("fresh".to_string(), vec!["fresh-row".to_string()])];

        let disabled = set_disabled(&original, &mounts[0].1, true).unwrap();
        assert!(disabled.contains("- id: fresh-row"));
        assert!(disabled.contains(MANAGED_OPEN));
        let view = items(&manifest(&["fresh"]), &mounts, &disabled).unwrap();
        assert!(!view[0].enabled);

        // 再停用一次：一字不动（幂等）。
        assert_eq!(
            set_disabled(&disabled, &mounts[0].1, true).unwrap(),
            disabled
        );

        let restored = set_disabled(&disabled, &mounts[0].1, false).unwrap();
        assert_eq!(restored, original, "启用后必须回到原文");
        let view = items(&manifest(&["fresh"]), &mounts, &restored).unwrap();
        assert!(view[0].enabled);
    }

    #[test]
    fn toggling_never_touches_the_users_own_patch_content() {
        let mounts = [("fresh".to_string(), vec!["fresh-row".to_string()])];
        let disabled = set_disabled(USER_PATCH, &mounts[0].1, true).unwrap();
        assert!(disabled.starts_with(USER_PATCH), "原有内容必须原样留在前面");
        assert!(disabled.contains("config:\n    apiKeyEnv: MAGPIE_GATEWAY_KEY"));
        assert!(disabled.contains("# 我自己的补丁层，别整份重写"));
    }

    #[test]
    fn disabling_an_existing_item_adds_the_expression_below_it() {
        let patch = "- id: row\n  name: some-plugin\n";
        let out = set_disabled(patch, &["row".to_string()], true).unwrap();
        assert_eq!(out, "- id: row\n  disabled: true\n  name: some-plugin\n");
        assert_eq!(
            set_disabled(&out, &["row".to_string()], false).unwrap(),
            patch
        );
    }

    #[test]
    fn explicit_disabled_false_is_flipped_in_place() {
        let patch = "- id: row\n  disabled: false\n  name: x\n";
        let out = set_disabled(patch, &["row".to_string()], true).unwrap();
        assert_eq!(out, "- id: row\n  disabled: true\n  name: x\n");
        assert_eq!(
            set_disabled(&out, &["row".to_string()], false).unwrap(),
            "- id: row\n  name: x\n"
        );
    }

    #[test]
    fn items_with_custom_expression_are_refused_in_both_directions() {
        let patch = "- id: row\n  disabled: !!js \"[...].some((e) => !e.disabled)\"\n";
        // 不 panic，给可读中文错误。
        let err = set_disabled(patch, &["row".to_string()], true).unwrap_err();
        assert!(err.contains("自定义表达式"), "{err}");
        let err = set_disabled(patch, &["row".to_string()], false).unwrap_err();
        assert!(err.contains("cordis.patch.yml"), "{err}");
    }

    #[test]
    fn broken_yaml_gives_a_readable_error_instead_of_panicking() {
        let err = set_disabled("我随便写的\n", &["row".to_string()], true).unwrap_err();
        assert!(err.contains("第 1 行不是列表项"), "{err}");
        assert!(err.contains("我随便写的"), "{err}");

        let err = items(&manifest(&["a"]), &[], "- id:\n").unwrap_err();
        assert!(err.contains("后面没有值"), "{err}");
    }

    #[test]
    fn enabling_an_entry_that_is_not_in_the_patch_is_a_no_op() {
        assert_eq!(
            set_disabled(USER_PATCH, &["nope".to_string()], false).unwrap(),
            USER_PATCH
        );
    }

    #[test]
    fn disabling_an_entry_absent_from_the_patch_adds_it_in_the_managed_block() {
        // 项定义在更下层（bundle 自带）时补丁层里本来没有它，得靠新加一项表达禁用。
        let out = set_disabled(USER_PATCH, &["nope".to_string()], true).unwrap();
        assert!(out.starts_with(USER_PATCH));
        assert!(out.contains("- id: nope\n  disabled: true"));
        assert!(out.contains(MANAGED_OPEN));
        assert_eq!(
            set_disabled(&out, &["nope".to_string()], false).unwrap(),
            USER_PATCH
        );
    }

    #[test]
    fn disables_written_by_the_shell_are_not_marked_manual() {
        let mounts = vec![("p".to_string(), vec!["p-row".to_string()])];
        let patch = set_disabled("", &mounts[0].1, true).unwrap();
        let list = items(&manifest(&["p"]), &mounts, &patch).unwrap();
        assert!(!list[0].enabled);
        assert!(!list[0].manual, "托管块里的禁用表达不算用户手写");
    }

    #[test]
    fn crlf_files_stay_crlf() {
        let patch = "- id: keep\r\n  name: x\r\n";
        let disabled = set_disabled(patch, &["row".to_string()], true).unwrap();
        assert!(
            disabled.contains("- id: row\r\n  disabled: true\r\n"),
            "新增的项也要用 CRLF：{disabled:?}"
        );
        assert_eq!(
            set_disabled(&disabled, &["row".to_string()], false).unwrap(),
            patch
        );
    }

    #[test]
    fn a_file_without_trailing_newline_keeps_that_shape() {
        let patch = "- id: keep\n  name: x";
        let disabled = set_disabled(patch, &["row".to_string()], true).unwrap();
        assert!(disabled.starts_with("- id: keep\n  name: x\n"));
        assert_eq!(
            set_disabled(&disabled, &["row".to_string()], false).unwrap(),
            patch
        );
    }

    #[test]
    fn messages_mention_restart_and_bridge_fallback() {
        assert!(toggle_message("x", true).contains("重启"));
        assert!(toggle_message("x", false).contains("不需要重新下载"));
        assert!(bridge_off_warning().contains("日志"));
        assert!(empty_hint().contains("安装依赖"));
    }

    #[test]
    fn empty_patch_layer_means_everything_is_on() {
        let mounts = vec![("p".to_string(), vec!["p-row".to_string()])];
        let list = items(&manifest(&["p"]), &mounts, "").unwrap();
        assert!(list[0].enabled);
        assert!(list[0].switchable);
        assert!(!list[0].manual);
    }
}
