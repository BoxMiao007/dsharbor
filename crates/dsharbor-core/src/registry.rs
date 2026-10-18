//! npm 渠道版本查询的纯逻辑：解析 `npm view` 的 JSON、按渠道分组、按版本从新到旧排序。
//!
//! 为什么放在核心库：真正跑 `npm view` 要拉起子进程（还可能经 wsl.exe 进发行版），
//! 在开发机上不好稳定复现；而「哪几条版本属于 rc 渠道」「谁比谁新」是纯字符串与
//! 版本号比较，放这里可以全自动测。外壳（src-tauri）只负责执行命令与缓存。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::launch::{Channel, NPX_PACKAGE};

/// npm 的 dist-tag 快照。只有 latest / next 靠标签定位版本：
/// npm 上没有 rc 这个标签，rc / alpha 渠道由版本列表给出具体版本号。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistTags {
    /// `latest` 标签指向的版本（稳定版）。
    pub latest: Option<String>,
    /// `next` 标签指向的版本（最新尝鲜版）。
    pub next: Option<String>,
    /// `alpha` 标签指向的版本；界面上不直接用，留着供排错。
    pub alpha: Option<String>,
}

/// 界面要用的版本清单：标签 + 按渠道分好组的具体版本（都从新到旧）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryInfo {
    pub dist_tags: DistTags,
    /// 尝鲜版历史版本（`-rc.N`）。
    pub rc: Vec<String>,
    /// 内测版（`-alpha.N`）。
    pub alpha: Vec<String>,
}

impl RegistryInfo {
    /// 指定渠道的版本列表（标签型渠道返回空：界面用徽章而不是下拉）。
    pub fn versions_of(&self, channel: Channel) -> &[String] {
        match channel {
            Channel::Rc => &self.rc,
            Channel::Alpha => &self.alpha,
            Channel::Latest | Channel::Next => &[],
        }
    }

    /// 标签型渠道当前指向的版本。
    pub fn tag_version(&self, channel: Channel) -> Option<&str> {
        match channel {
            Channel::Latest => self.dist_tags.latest.as_deref(),
            Channel::Next => self.dist_tags.next.as_deref(),
            Channel::Rc | Channel::Alpha => None,
        }
    }
}

/// 查询参数：一次拿到标签与全部版本。
///
/// 实测 `npm view <包> dist-tags versions --json` 返回单个对象
/// `{"dist-tags":{…},"versions":[…]}`；分两次查询要多一个 node 启动 + 一次网络往返
/// （Windows 上每次约 1 秒），没必要。
pub fn query_args() -> [&'static str; 5] {
    ["view", NPX_PACKAGE, "dist-tags", "versions", "--json"]
}

/// 解析 `npm view` 的输出。
///
/// 接受三种形状：带 `dist-tags` + `versions` 的对象（正常路径）、裸版本数组、
/// 单版本字符串（只有一个版本时 npm 不返回数组）。
pub fn parse(json: &str) -> Result<RegistryInfo, String> {
    let raw = json.trim();
    if raw.is_empty() {
        return Err("npm view 没有返回内容".into());
    }
    let parsed: Value =
        serde_json::from_str(raw).map_err(|err| format!("输出不是合法 JSON：{err}"))?;
    match &parsed {
        Value::Object(object) => {
            let versions = match object.get("versions") {
                Some(value) => versions_from(value)?,
                None => return Err("输出里没有版本列表".into()),
            };
            let dist_tags = match object.get("dist-tags") {
                Some(value) => dist_tags_from(value)?,
                // 标签缺失不算致命：版本下拉照样能用，标签型渠道显示 `—`。
                None => DistTags::default(),
            };
            Ok(build(dist_tags, versions))
        }
        // 兜底：万一以后只查 versions，也不能整次失败。
        Value::Array(_) | Value::String(_) => {
            Ok(build(DistTags::default(), versions_from(&parsed)?))
        }
        _ => Err("输出既不是对象也不是版本列表".into()),
    }
}

fn build(dist_tags: DistTags, versions: Vec<String>) -> RegistryInfo {
    RegistryInfo {
        rc: group(&versions, Channel::Rc),
        alpha: group(&versions, Channel::Alpha),
        dist_tags,
    }
}

/// 从 JSON 值里取版本列表：数组、单版本字符串都接住，非版本号形态的条目丢掉。
fn versions_from(value: &Value) -> Result<Vec<String>, String> {
    let mut versions: Vec<String> = match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        Value::String(single) => vec![single.clone()],
        _ => return Err("版本列表既不是数组也不是字符串".into()),
    };
    // 只认版本号形态：非版本号形态的字符串混进来会拼出非法命令行。
    versions.retain(|version| is_version_like(version));
    sort_newest_first(&mut versions);
    Ok(versions)
}

/// 从 JSON 值里取 dist-tags；缺哪个标签就留 None（新包可能还没有 alpha）。
fn dist_tags_from(value: &Value) -> Result<DistTags, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "标签信息不是 JSON 对象".to_string())?;
    let read = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| is_version_like(value))
            .map(str::to_string)
    };
    Ok(DistTags {
        latest: read("latest"),
        next: read("next"),
        alpha: read("alpha"),
    })
}

/// 按渠道给版本分组。`-rc.N` / `-alpha.N` 之外的版本不列：
/// latest / next 用标签定位，这两条渠道不给版本下拉，列出来也没有入口。
fn group(versions: &[String], channel: Channel) -> Vec<String> {
    let marker = match channel {
        Channel::Rc => "-rc.",
        Channel::Alpha => "-alpha.",
        Channel::Latest | Channel::Next => return Vec::new(),
    };
    versions
        .iter()
        .filter(|version| version.contains(marker))
        .cloned()
        .collect()
}

/// 版本号形态（与 `launch::validate_version` 同一套字符）：只含字母数字与 `. - + _`。
fn is_version_like(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text.starts_with(|c: char| c.is_ascii_digit())
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'))
}

/// 从新到旧排序。非 semver 形态的版本（解析失败）排到最后，保持原相对顺序。
fn sort_newest_first(versions: &mut [String]) {
    versions.sort_by(|a, b| match (semver_key(a), semver_key(b)) {
        (Some(left), Some(right)) => right.cmp(&left),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
}

/// semver 的比较键：主次修订号按数值比，再比预发布标识。
#[derive(Debug, PartialEq, Eq)]
struct SemverKey {
    core: (u64, u64, u64),
    /// None = 正版。正版高于任何预发布版，所以手写 Ord 时把 None 当成最大。
    pre: Option<Vec<PreId>>,
}

impl Ord for SemverKey {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.core
            .cmp(&other.core)
            .then_with(|| match (&self.pre, &other.pre) {
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(left), Some(right)) => left.cmp(right),
            })
    }
}

impl PartialOrd for SemverKey {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, PartialEq, Eq)]
enum PreId {
    Num(u64),
    Text(String),
}

impl Ord for PreId {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            (PreId::Num(a), PreId::Num(b)) => a.cmp(b),
            (PreId::Text(a), PreId::Text(b)) => a.cmp(b),
            // 数字段低于字母段。
            (PreId::Num(_), PreId::Text(_)) => std::cmp::Ordering::Less,
            (PreId::Text(_), PreId::Num(_)) => std::cmp::Ordering::Greater,
        }
    }
}

impl PartialOrd for PreId {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// 只实现排序要用到的那部分 semver 优先级规则（完整规范里的构建元数据不参与比较）。
fn semver_key(version: &str) -> Option<SemverKey> {
    let text = version.trim().trim_start_matches('v');
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (text, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    // 允许 `0.1` 这种省略修订号的写法。
    let patch = match parts.next() {
        Some(raw) => raw.parse::<u64>().ok()?,
        None => 0,
    };
    if parts.next().is_some() {
        return None;
    }
    let pre = match pre {
        // `-` 之后为空视为无预发布标识。
        Some("") | None => None,
        Some(pre) => Some(
            pre.split('.')
                .map(|id| match id.parse::<u64>() {
                    Ok(num) => PreId::Num(num),
                    Err(_) => PreId::Text(id.to_string()),
                })
                .collect::<Vec<_>>(),
        ),
    };
    Some(SemverKey {
        core: (major, minor, patch),
        pre,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 实机 `npm view @deepseek-ai/dsh dist-tags versions --json` 的形状（截取）。
    const COMBINED: &str = r#"{
        "dist-tags": {"latest":"0.2.0-rc.2","alpha":"0.2.1-alpha.5","next":"0.2.1-rc.2"},
        "versions": ["0.0.1-rc.1","0.2.1-alpha.3","0.2.0-rc.2","0.2.1-alpha.4","0.2.1-rc.1","0.2.1-rc.2","0.2.1-alpha.5"]
    }"#;

    #[test]
    fn parses_real_npm_output() {
        let info = parse(COMBINED).unwrap();
        assert_eq!(info.dist_tags.latest.as_deref(), Some("0.2.0-rc.2"));
        assert_eq!(info.dist_tags.next.as_deref(), Some("0.2.1-rc.2"));
        assert_eq!(info.dist_tags.alpha.as_deref(), Some("0.2.1-alpha.5"));
        // 从新到旧。
        assert_eq!(
            info.rc,
            vec!["0.2.1-rc.2", "0.2.1-rc.1", "0.2.0-rc.2", "0.0.1-rc.1"]
        );
        assert_eq!(
            info.alpha,
            vec!["0.2.1-alpha.5", "0.2.1-alpha.4", "0.2.1-alpha.3"]
        );
    }

    #[test]
    fn sorts_numerically_not_lexically() {
        // 字符串排序会把 0.10.0 排在 0.9.0 前面，必须按数值比。
        let info = parse(r#"{"versions":["0.9.0-rc.1","0.10.0-rc.1","0.2.0-rc.10","0.2.0-rc.2"]}"#)
            .unwrap();
        assert_eq!(
            info.rc,
            vec!["0.10.0-rc.1", "0.9.0-rc.1", "0.2.0-rc.10", "0.2.0-rc.2"]
        );
    }

    #[test]
    fn stable_version_outranks_prerelease() {
        let mut versions = vec![
            "0.2.0-rc.2".to_string(),
            "0.2.0".to_string(),
            "0.1.9".to_string(),
        ];
        sort_newest_first(&mut versions);
        assert_eq!(versions, vec!["0.2.0", "0.2.0-rc.2", "0.1.9"]);
        // 正版不进 rc / alpha 列表（渠道靠标签，不用下拉）。
        let info = parse(r#"{"versions":["0.2.0","0.2.0-rc.2"]}"#).unwrap();
        assert_eq!(info.rc, vec!["0.2.0-rc.2"]);
        assert!(info.alpha.is_empty());
    }

    #[test]
    fn accepts_single_version_output() {
        // npm 在只有一个版本时输出字符串而不是数组。
        let info =
            parse(r#"{"dist-tags":{"latest":"0.0.1-rc.1"},"versions":"0.0.1-rc.1"}"#).unwrap();
        assert_eq!(info.rc, vec!["0.0.1-rc.1"]);
        assert_eq!(info.dist_tags.latest.as_deref(), Some("0.0.1-rc.1"));
    }

    #[test]
    fn accepts_bare_version_list() {
        // 兜底：万一输出里只有版本数组（没有外层对象）。
        let info = parse(r#"["0.2.0-rc.2"]"#).unwrap();
        assert_eq!(info.rc, vec!["0.2.0-rc.2"]);
        assert_eq!(info.dist_tags, DistTags::default());
    }

    #[test]
    fn missing_dist_tags_are_tolerated() {
        // 新包可能还没有 alpha 标签；缺标签不能让整次查询失败。
        let info =
            parse(r#"{"dist-tags":{"latest":"0.2.0-rc.2"},"versions":["0.2.0-rc.2"]}"#).unwrap();
        assert_eq!(info.dist_tags.latest.as_deref(), Some("0.2.0-rc.2"));
        assert_eq!(info.dist_tags.next, None);
        assert_eq!(info.dist_tags.alpha, None);
        // 连 dist-tags 键都没有时也不失败。
        let info = parse(r#"{"versions":["0.2.0-rc.2"]}"#).unwrap();
        assert_eq!(info.dist_tags, DistTags::default());
    }

    #[test]
    fn rejects_garbage_output() {
        assert!(parse("").is_err());
        assert!(parse("   ").is_err());
        assert!(parse("not json").is_err());
        assert!(parse("123").is_err());
        assert!(parse(r#"{"dist-tags":{"latest":"0.2.0-rc.2"}}"#).is_err());
        assert!(parse(r#"{"versions":42}"#).is_err());
        assert!(parse(r#"{"dist-tags":"latest","versions":[]}"#).is_err());
    }

    #[test]
    fn drops_entries_that_are_not_versions() {
        // 防御：非版本号形态的字符串不能进命令行。
        let info = parse(r#"{"versions":["0.2.0-rc.2","rm -rf /","",null]}"#).unwrap();
        assert_eq!(info.rc, vec!["0.2.0-rc.2"]);
        // 标签里也做同样过滤。
        let info = parse(r#"{"dist-tags":{"latest":"1.0 && reboot"},"versions":[]}"#).unwrap();
        assert_eq!(info.dist_tags.latest, None);
    }

    #[test]
    fn versions_of_and_tag_version_split_by_channel() {
        let info = parse(COMBINED).unwrap();
        assert_eq!(info.versions_of(Channel::Rc).len(), 4);
        assert_eq!(info.versions_of(Channel::Alpha).len(), 3);
        assert!(info.versions_of(Channel::Latest).is_empty());
        assert!(info.versions_of(Channel::Next).is_empty());
        assert_eq!(info.tag_version(Channel::Latest), Some("0.2.0-rc.2"));
        assert_eq!(info.tag_version(Channel::Next), Some("0.2.1-rc.2"));
        assert_eq!(info.tag_version(Channel::Rc), None);
        assert_eq!(info.tag_version(Channel::Alpha), None);
    }

    #[test]
    fn serializes_as_camel_case_for_frontend() {
        let json = serde_json::to_string(&parse(COMBINED).unwrap()).unwrap();
        assert!(json.contains(r#""distTags""#), "{json}");
        assert!(json.contains(r#""rc""#), "{json}");
        assert!(json.contains(r#""alpha""#), "{json}");
        // 前端按 camelCase 读 label 之外的字段，这里只关心 distTags 的键名。
        assert!(json.contains(r#""latest""#), "{json}");
    }

    #[test]
    fn npm_args_use_the_shared_package_name() {
        let args = query_args();
        assert_eq!(args[0], "view");
        assert_eq!(args[1], NPX_PACKAGE);
        assert_eq!(args[4], "--json");
    }
}
