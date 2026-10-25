//! 插件开关：把环境里登记的组合包与已装的插件包合成一份「启用 / 停用」视图，
//! 以及切换时该改哪里。
//!
//! 开关的落点与 DSH 自己的插件管理同口径（DSH 插件列表那排开关就是组合包开关，
//! 见 dsh-plugin-manager 的 README）：**改环境 `package.json` 的
//! `dsh.profile.bundles` 有序列表**。开着 = 名字在列表里，DSH 加载时挂载；
//! 关掉 = 从列表摘除，包与依赖都留在 `node_modules` 里（DSH 也是这么关的），
//! 重新打开不需要重新下载，也不碰 pnpm 与 DSH 的锁定文件；重新打开时把名字追加
//! 到列表末尾，数组变换与 DSH 自己一致。
//!
//! 旧版壳把开关写在补丁层（`cordis.patch.yml` 里 entry 的 `disabled`），那是 DSH
//! 详情页里「包含的组件」那一级的开关——两级开关并存时两边的界面会各说各话。现在
//! 壳只管组合包这一级，每次开关顺手把旧版壳写进托管块的遗留记录整段清掉（托管块
//! 全部由壳生成，头部注释写明手改会被覆盖）；用户手写的组件级禁用不动，只在界面
//! 上用「手动」提示。
//!
//! 两个信息源：
//! - 组合包登记来自环境 `package.json` 的 `dsh.profile.bundles`；
//! - 已停用的组合包从 `dependencies` 里找（DSH 关闭组合包时保留依赖），每个名字
//!   是否真的装着插件，由外壳在 `node_modules` 里核对 bundle 补丁文件
//!   （`dsh.bundle.patch.yml` / `cordis.patch.yml`）后以挂载点形式传进来。

use serde::Serialize;

use crate::profiles::BRIDGE_PLUGIN;

/// 旧版壳托管块的起始标记行（整行匹配，缩进与行尾空白不算）。
///
/// 旧版壳把禁用表达全写在这一段里；开关迁到组合包列表后这段只剩遗留记录，
/// 开关时用 [`drop_managed_block`] 整段摘掉。
const MANAGED_OPEN: &str = "# >>> DSHarbor 插件开关（自动生成，手改会被覆盖）>>>";
/// 旧版壳托管块的结束标记行。
const MANAGED_CLOSE: &str = "# <<< DSHarbor 插件开关 <<<";

/// 插件包里的 bundle 补丁文件名，按顺序找第一个存在的。
///
/// 每个包在自己的 `package.json` 里用 `dsh.bundle.patch` 声明它叫什么，实测下来
/// 全部落在下面两个名字之一。壳在 WSL 那一侧不方便解析 JSON，两侧就统一按名字试，
/// 认不出来只会让该插件显示成「不可开关」，不会误改任何文件。
pub const BUNDLE_PATCH_CANDIDATES: &[&str] = &["dsh.bundle.patch.yml", "cordis.patch.yml"];

/// bundle 补丁文件清单里每条记录的分隔前缀（后面跟包名）。
pub const BUNDLE_MARKER: &str = "@@bundle@@ ";

/// 一项 `disabled:` 的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Disabled {
    /// 没有禁用表达，或显式 `disabled: false`：插件会加载。
    Off,
    /// `disabled: true`：插件不加载。
    On,
    /// `disabled:` 后面是表达式（`!!js "..."`）——用户自己写的守卫，只做提示。
    Expression,
}

/// 补丁层里的一个顶层项（只保留开关视图需要的两个字段）。
#[derive(Debug, Clone)]
struct EntryRef {
    id: String,
    disabled: Disabled,
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
    /// 现在会不会被加载：名字在组合包列表里就是开，与 DSH 插件列表同口径。
    pub enabled: bool,
    /// 是不是桥接插件。
    pub bridge: bool,
    /// 补丁层里有组件级禁用记录（用户手写的，或旧版壳托管块的遗留），界面上
    /// 提示去 DSH 插件详情页看「包含的组件」。
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
    // 当前项在 entries 里的下标 + 它子键的缩进（遇到第一个缩进行时确定）。
    let mut current: Option<(usize, usize)> = None;

    for (idx, raw) in lines.iter().enumerate() {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim();
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
                    disabled: Disabled::Off,
                });
                current = Some((entries.len() - 1, 0));
            }
            continue;
        }

        let Some((index, body_indent)) = current.as_mut() else {
            continue;
        };
        let indent = indent_of(line);
        if *body_indent == 0 {
            *body_indent = indent;
        }
        if indent == *body_indent {
            if let Some(value) = value_of(line, "disabled") {
                entries[*index].disabled = if value == "true" {
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

/// 从 `package.json` 文本读 `dependencies` 的包名（保持书写顺序）。
///
/// DSH 关闭组合包时把名字从 bundles 摘除但保留依赖，停用的组合包只能在这里找到。
pub fn dependency_names(package_json: &str) -> Result<Vec<String>, String> {
    let value: serde_json::Value = serde_json::from_str(package_json)
        .map_err(|err| format!("环境的 package.json 不是合法 JSON：{err}"))?;
    let mut names: Vec<String> = Vec::new();
    if let Some(deps) = value.get("dependencies").and_then(|deps| deps.as_object()) {
        for name in deps.keys() {
            if !name.is_empty() {
                names.push(name.clone());
            }
        }
    }
    Ok(names)
}

/// 组合包列表的目标状态：启用时把名字追加到末尾（已在列表里就不动，不换位置），
/// 停用时把名字摘掉（不在列表里就不动）。与 DSH 自己的组合包开关同一套数组变换。
pub fn set_bundle_enabled(mut bundles: Vec<String>, name: &str, enabled: bool) -> Vec<String> {
    if enabled {
        if !bundles.iter().any(|bundle| bundle == name) {
            bundles.push(name.to_string());
        }
    } else {
        bundles.retain(|bundle| bundle != name);
    }
    bundles
}

/// 把新的组合包列表写回 `package.json` 文本。
///
/// 其余内容原样保留：serde_json 开了 `preserve_order`，键不会被重排；输出用
/// 2 空格缩进（pnpm 写出的格式）。原文以换行结尾时输出也保持。
pub fn with_bundles(package_json: &str, bundles: &[String]) -> Result<String, String> {
    let mut value: serde_json::Value = serde_json::from_str(package_json)
        .map_err(|err| format!("环境的 package.json 不是合法 JSON：{err}"))?;
    let list: Vec<serde_json::Value> = bundles
        .iter()
        .map(|name| serde_json::Value::String(name.clone()))
        .collect();
    let dsh = value
        .get_mut("dsh")
        .ok_or_else(|| "环境的 package.json 里没有 dsh 字段".to_string())?;
    let profile = dsh
        .get_mut("profile")
        .ok_or_else(|| "环境的 package.json 里没有 dsh.profile 字段".to_string())?;
    let profile = profile
        .as_object_mut()
        .ok_or_else(|| "环境的 package.json 里 dsh.profile 不是对象".to_string())?;
    profile.insert("bundles".to_string(), serde_json::Value::Array(list));
    let mut out = serde_json::to_string_pretty(&value)
        .map_err(|err| format!("环境的 package.json 写不回去：{err}"))?;
    if package_json.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

/// 把旧版壳的托管块（两行标记 + 块内所有内容）整段从补丁层文本里摘掉。
///
/// 找不到配对的标记就原样返回，宁可留着力气也不误删；块外的用户内容一个字不动，
/// 结尾多出来的空行收敛掉、按原文件的换行形状补尾。
pub fn drop_managed_block(patch: &str) -> String {
    let lines: Vec<&str> = patch.split('\n').collect();
    let Some(open) = lines
        .iter()
        .position(|line| line.trim_end_matches('\r').trim() == MANAGED_OPEN)
    else {
        return patch.to_string();
    };
    let Some(close) = lines[open + 1..]
        .iter()
        .position(|line| line.trim_end_matches('\r').trim() == MANAGED_CLOSE)
        .map(|offset| open + 1 + offset)
    else {
        return patch.to_string();
    };

    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    out.extend_from_slice(&lines[..open]);
    out.extend_from_slice(&lines[close + 1..]);
    while out
        .last()
        .map(|line| line.trim().is_empty())
        .unwrap_or(false)
    {
        out.pop();
    }
    let mut text = out.join("\n");
    if patch.ends_with('\n') && !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text
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
/// `mounts` 是 [`mount_points`] 的结果（外壳按「组合包 ∪ 依赖」扫出来的），
/// `patch` 是补丁层原文（文件不存在就传空串）。
///
/// 名字清单 = 组合包登记 ∪ 已装补丁文件的包；`enabled` 只看组合包登记（与 DSH
/// 插件列表同口径），补丁层里残留的组件级禁用不影响它，只用 `manual` 提示。
pub fn items(
    package_json: &str,
    mounts: &[(String, Vec<String>)],
    patch: &str,
) -> Result<Vec<PluginItem>, String> {
    let registered = bundle_names(package_json)?;
    let scan = scan(patch)?;
    let mut names = registered.clone();
    for (bundle, _) in mounts {
        if !names.iter().any(|name| name == bundle) {
            names.push(bundle.clone());
        }
    }

    Ok(names
        .into_iter()
        .map(|name| {
            let entries: Vec<String> = mounts
                .iter()
                .find(|(bundle, _)| *bundle == name)
                .map(|(_, ids)| ids.clone())
                .unwrap_or_default();
            let manual = entries.iter().any(|id| {
                scan.entries
                    .iter()
                    .any(|entry| &entry.id == id && entry.disabled != Disabled::Off)
            });
            PluginItem {
                bridge: name == BRIDGE_PLUGIN,
                switchable: !entries.is_empty(),
                enabled: registered.contains(&name),
                manual,
                name,
                entries,
                description: None,
            }
        })
        .collect())
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
        format!("已把「{name}」加回 DSH 的组合包列表，重启 DSH 后生效。")
    } else {
        format!("已把「{name}」移出 DSH 的组合包列表，重启 DSH 后生效；插件包和依赖都留在磁盘上，重新打开不需要重新下载。")
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
    fn dependency_names_keep_writing_order() {
        let names = dependency_names("{\"dependencies\":{\"zebra\":1,\"alpaca\":2}}").unwrap();
        assert_eq!(names, vec!["zebra", "alpaca"]);
    }

    #[test]
    fn missing_dependencies_read_as_empty() {
        assert!(dependency_names("{\"name\":\"x\"}").unwrap().is_empty());
    }

    #[test]
    fn enabling_appends_to_the_end_and_is_idempotent() {
        let bundles = set_bundle_enabled(vec!["a".to_string()], "b", true);
        assert_eq!(bundles, vec!["a", "b"]);
        // 已在列表里：保持原位（不挪到末尾）。
        let bundles = set_bundle_enabled(vec!["b".to_string(), "a".to_string()], "b", true);
        assert_eq!(bundles, vec!["b", "a"]);
    }

    #[test]
    fn disabling_removes_every_occurrence() {
        let bundles = set_bundle_enabled(vec!["a".to_string(), "b".to_string()], "b", false);
        assert_eq!(bundles, vec!["a"]);
        assert_eq!(set_bundle_enabled(vec![], "b", false), Vec::<String>::new());
    }

    #[test]
    fn with_bundles_rewrites_the_list_and_keeps_key_order() {
        let source = format!("{}\n", manifest(&["a", "b"]));
        let out = with_bundles(&source, &["a".to_string(), "c".to_string()]).unwrap();
        // 键序保持 name → private → dsh，bundles 换成新列表。
        assert!(out.contains("\"name\""), "{out}");
        assert!(out.starts_with("{\n  \"name\""), "{out}");
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        let bundles: Vec<&str> = value["dsh"]["profile"]["bundles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        assert_eq!(bundles, vec!["a", "c"]);
        // 原文以换行结尾，输出也要。
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn with_bundles_needs_the_dsh_profile_section() {
        let err = with_bundles("{\"name\":\"x\"}", &["a".to_string()]).unwrap_err();
        assert!(err.contains("没有 dsh 字段"), "{err}");
    }

    #[test]
    fn drop_managed_block_removes_the_whole_block_and_keeps_user_content() {
        let patch = "\
- id: keep
  name: x
# >>> DSHarbor 插件开关（自动生成，手改会被覆盖）>>>
- id: row
  disabled: true
# <<< DSHarbor 插件开关 <<<

";
        let out = drop_managed_block(patch);
        assert_eq!(out, "- id: keep\n  name: x\n");
    }

    #[test]
    fn drop_managed_block_keeps_crlf_shape() {
        let patch = "- id: keep\r\n# >>> DSHarbor 插件开关（自动生成，手改会被覆盖）>>>\r\n- id: row\r\n  disabled: true\r\n# <<< DSHarbor 插件开关 <<<\r\n";
        assert_eq!(drop_managed_block(patch), "- id: keep\r\n");
    }

    #[test]
    fn drop_managed_block_without_paired_markers_is_a_no_op() {
        let user_only = "- id: keep\n  name: x\n";
        assert_eq!(drop_managed_block(user_only), user_only);
        let missing_close = "- id: keep\n# >>> DSHarbor 插件开关（自动生成，手改会被覆盖）>>>\n";
        assert_eq!(drop_managed_block(missing_close), missing_close);
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
    fn items_treat_bundle_membership_as_the_switch() {
        let mounts = vec![
            ("fourth".to_string(), vec!["fourth-row".to_string()]),
            ("whale".to_string(), vec!["whale-row".to_string()]),
        ];
        // fourth 在组合包列表里但被用户在补丁层手写了组件级禁用；whale 是停用后
        // 留在 dependencies 里的组合包（登记摘了、依赖还在）。
        let patch = "- id: fourth-row\n  disabled: true\n";
        let list = items(&manifest(&["builtin", "fourth"]), &mounts, patch).unwrap();
        // 内置骨架包读不到挂载点 → 不可开关，但仍列出来。
        assert_eq!(list[0].name, "builtin");
        assert!(!list[0].switchable);
        assert!(list[0].enabled);
        assert_eq!(list[1].name, "fourth");
        assert!(list[1].switchable);
        assert!(list[1].enabled, "开关只看组合包登记");
        assert!(list[1].manual, "补丁层里的组件级禁用要用 manual 提示");
        assert_eq!(list[2].name, "whale");
        assert!(!list[2].enabled, "不在组合包登记里就是关");
        assert!(!list[2].manual);
    }

    #[test]
    fn items_flag_the_bridge_plugin() {
        let mounts = vec![(
            BRIDGE_PLUGIN.to_string(),
            vec!["dsharbor-bridge".to_string()],
        )];
        let list = items(&manifest(&[BRIDGE_PLUGIN]), &mounts, "").unwrap();
        assert!(list[0].bridge);
        assert!(list[0].enabled);
        assert!(!list[0].manual);
    }

    #[test]
    fn leftover_managed_disables_count_as_manual() {
        let mounts = vec![("p".to_string(), vec!["p-row".to_string()])];
        let patch = "\
# >>> DSHarbor 插件开关（自动生成，手改会被覆盖）>>>
- id: p-row
  disabled: true
# <<< DSHarbor 插件开关 <<<
";
        let list = items(&manifest(&["p"]), &mounts, patch).unwrap();
        assert!(list[0].enabled, "旧版壳写的遗留禁用不该再压住组合包开关");
        assert!(list[0].manual, "不管是谁写的，组件级禁用都要提示出来");
    }

    #[test]
    fn nested_disabled_under_config_is_not_item_level() {
        let mounts = vec![("p".to_string(), vec!["p-row".to_string()])];
        let list = items(&manifest(&["p"]), &mounts, USER_PATCH).unwrap();
        // USER_PATCH 里 `disabled: true` 缩进 4，属于 config 的子键，不算停用。
        assert!(list[0].enabled);
        assert!(!list[0].manual);
    }

    #[test]
    fn broken_yaml_gives_a_readable_error_instead_of_panicking() {
        let err = items(&manifest(&["a"]), &[], "我随便写的\n").unwrap_err();
        assert!(err.contains("第 1 行不是列表项"), "{err}");
        assert!(err.contains("我随便写的"), "{err}");

        let err = items(&manifest(&["a"]), &[], "- id:\n").unwrap_err();
        assert!(err.contains("后面没有值"), "{err}");
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
