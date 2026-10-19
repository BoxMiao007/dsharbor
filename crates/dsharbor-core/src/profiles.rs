//! 环境（DSH profile）的纯逻辑：名字合法性、从 `package.json` 读摘要、能不能列出来。
//!
//! 环境指的是 `~/.dsh/profiles/<名字>` 下的一份独立 DSH 安装。壳对一份环境只关心
//! 三件事：它能不能起网页界面、登记了多少个插件、桥接插件是否已经在里面。
//! 读盘与枚举目录在壳那一层做，这里只吃文本，方便全自动测试。

/// 官方桌面端（Electron 外壳）独占的环境名。
///
/// 它同样能起网页界面，但 DSH 的 CLI 明确拒绝针对它的启动与插件管理请求；
/// 列进「启动用」下拉只会让用户选到一个必然失败的环境，因此整份隐藏。
pub const DESKTOP_PROFILE: &str = "desktop";

/// 提供网页界面的 bundle。只有登记了它的环境才能起 DSH Web。
pub const WEB_APP_BUNDLE: &str = "@deepseek-ai/dsh-web-app";

/// 桥接插件在 `dsh.profile.bundles` 里的登记名。
pub const BRIDGE_PLUGIN: &str = "dsharbor-bridge";

/// 环境名长度上限。名字既是目录名又会作为位置参数进入命令行，留足余量。
const MAX_NAME_LEN: usize = 64;

/// 环境名合法性。
///
/// 名字会拼进 DSH 的启动命令行（Windows 侧是经 `cmd` 执行的整行字符串），
/// 也会拼成磁盘路径，所以只放行 ASCII 字母数字与 `- _ .`：不含引号、空格、
/// 反斜杠与路径分隔符，既挡命令注入也挡目录穿越。
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("环境名不能为空".into());
    }
    if name.len() > MAX_NAME_LEN {
        return Err(format!("环境名过长（最多 {MAX_NAME_LEN} 字符）：{name}"));
    }
    if name == "." || name == ".." {
        return Err(format!("环境名不能是 {name}"));
    }
    let mut chars = name.chars();
    // 空串已在上面排除，这里一定有第一个字符。
    if let Some(first) = chars.next() {
        if !first.is_ascii_alphanumeric() {
            return Err(format!("环境名必须以字母或数字开头：{name}"));
        }
    }
    if let Some(bad) = chars.find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
    {
        return Err(format!(
            "环境名包含不允许的字符 {bad:?}：{name}（仅允许字母数字与 - _ .）"
        ));
    }
    Ok(())
}

/// 是否是被壳保留、永远不会出现在「启动用」下拉里的环境名。
pub fn is_reserved(name: &str) -> bool {
    name == DESKTOP_PROFILE
}

/// 一份环境的摘要（界面展示与选中判定都用它）。
///
/// 实现 `Serialize` 是给外壳的 `list_profiles` IPC 下发用：界面只需要这三个数字与
/// 名字，不自己再去读磁盘。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub name: String,
    /// `dsh.profile.bundles` 里登记了多少项。
    pub plugins: usize,
    /// 桥接插件是否已登记在 bundles 里。
    pub bridge_installed: bool,
    /// 是否登记了网页应用 bundle（决定它能不能起 DSH Web）。
    pub web_capable: bool,
    /// 依赖是否装过（环境目录里有没有 `node_modules`）。
    ///
    /// 新建与复制出来的环境都没有依赖：能起网页但启动会因为没有依赖而失败，
    /// 所以界面要能一眼看出来并给出「安装依赖」。这个事实只能读盘得知，
    /// 因此由枚举清单的一方标上，`summarize` 只看文本时一律按「没装」处理。
    pub deps_installed: bool,
}

impl ProfileSummary {
    /// 补上「依赖装过没」这个只有读盘才知道的事实。
    pub fn with_deps(mut self, deps_installed: bool) -> Self {
        self.deps_installed = deps_installed;
        self
    }

    /// 能不能出现在「启动用」下拉里。
    pub fn is_selectable(&self) -> bool {
        self.web_capable && !is_reserved(&self.name)
    }

    /// 收起状态的摘要徽章文案，例如 `web · 17 个插件 · 桥接已装`。
    pub fn badge(&self) -> String {
        format!(
            "{} · {} 个插件 · {}",
            self.name,
            self.plugins,
            if self.bridge_installed {
                "桥接已装"
            } else {
                "桥接未装"
            }
        )
    }
}

/// 从环境目录里的 `package.json` 文本解析摘要。
///
/// 只看 `dsh.profile.bundles`：它是 DSH 自己的插件登记表，`dependencies` 里有包
/// 不代表会在启动时挂载。bundles 缺失按「零个插件」处理（新建的环境就是空的）；
/// 只有 JSON 本身坏了才算错误——那种环境读不出内容，壳也管不了它。
pub fn summarize(name: &str, package_json: &str) -> Result<ProfileSummary, String> {
    let value: serde_json::Value = serde_json::from_str(package_json)
        .map_err(|err| format!("环境 {name} 的 package.json 不是合法 JSON：{err}"))?;
    let bundles: Vec<&str> = value
        .get("dsh")
        .and_then(|dsh| dsh.get("profile"))
        .and_then(|profile| profile.get("bundles"))
        .and_then(|bundles| bundles.as_array())
        .map(|items| items.iter().filter_map(|item| item.as_str()).collect())
        .unwrap_or_default();
    Ok(ProfileSummary {
        name: name.to_string(),
        plugins: bundles.len(),
        bridge_installed: bundles.contains(&BRIDGE_PLUGIN),
        web_capable: bundles.contains(&WEB_APP_BUNDLE),
        // 目录里有没有 node_modules 从 package.json 看不出来，见 `with_deps`。
        deps_installed: false,
    })
}

/// 解析「一行一个环境」的清单文本：`名字<TAB>依赖标记<TAB>package.json 的单行内容`。
///
/// 宿主直连与 WSL 两条读盘路径都先把目录内容拼成这种文本，再用同一套规则解析，
/// 于是「哪个环境能列出来」只在这里判一次。依赖标记是 `1`（装过）/`0`（没装）。
/// 两列的旧格式（没有依赖标记）照样认，按「没装」处理——这只是为了让格式演进
/// 不必两侧同时上线，正常运行时两栏一定都在。
/// 坏行（缺 tab、名字非法、JSON 坏掉）直接跳过：一份坏环境不该让整个下拉变成空的。
pub fn parse_listing(text: &str) -> Vec<ProfileSummary> {
    let mut profiles: Vec<ProfileSummary> = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let name = parts.next()?.trim();
            let second = parts.next()?;
            let (deps_installed, package_json) = match parts.next() {
                Some(package_json) => (second.trim() == "1", package_json),
                None => (false, second),
            };
            validate_name(name).ok()?;
            summarize(name, package_json)
                .ok()
                .map(|summary| summary.with_deps(deps_installed))
        })
        .collect();
    profiles.sort_by(|a, b| a.name.cmp(&b.name));
    profiles
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(bundles: &[&str]) -> String {
        let list: Vec<String> = bundles.iter().map(|item| format!("\"{item}\"")).collect();
        format!(
            "{{\"name\":\"dsh-profile-x\",\"private\":true,\
             \"dsh\":{{\"profile\":{{\"bundles\":[{}]}}}},\
             \"dependencies\":{{\"dsharbor-bridge\":\"file:/tmp/x.tgz\"}}}}",
            list.join(",")
        )
    }

    #[test]
    fn ordinary_names_pass() {
        for name in ["web", "lab", "my-env_2", "v0.3.1", "a"] {
            assert!(validate_name(name).is_ok(), "{name} 应该合法");
        }
    }

    #[test]
    fn names_that_leak_into_shell_or_paths_are_rejected() {
        for name in [
            "",       // 空
            " ",      // 空白
            "a b",    // 含空格（命令行会被切开）
            "a;rm",   // shell 分隔符
            "a/b",    // 路径分隔符
            "../etc", // 目录穿越（且含 /）
            "..",     // 目录穿越
            ".",      // 当前目录
            "-web",   // 以 - 开头会被当成旗标
            "web\"",  // 引号
            "web\n",  // 换行
            "环境",   // 非 ASCII
        ] {
            assert!(validate_name(name).is_err(), "{name:?} 应该被拒绝");
        }
    }

    #[test]
    fn overlong_names_are_rejected() {
        let long = "a".repeat(MAX_NAME_LEN + 1);
        assert!(validate_name(&long).is_err());
        assert!(validate_name(&"a".repeat(MAX_NAME_LEN)).is_ok());
    }

    #[test]
    fn error_messages_name_the_offending_character() {
        let err = validate_name("a b").unwrap_err();
        assert!(err.contains("' '"), "{err}");
        let err = validate_name("-web").unwrap_err();
        assert!(err.contains("-web"), "{err}");
    }

    #[test]
    fn summary_counts_bundles_and_spots_the_bridge() {
        let summary = summarize("web", &manifest(&["a", "b", "dsharbor-bridge"])).unwrap();
        assert_eq!(summary.plugins, 3);
        assert!(summary.bridge_installed);
        assert!(!summary.web_capable);
    }

    #[test]
    fn only_environments_with_the_web_bundle_are_selectable() {
        let web = summarize("web", &manifest(&[WEB_APP_BUNDLE, "x"])).unwrap();
        assert!(web.web_capable);
        assert!(web.is_selectable());

        let headless = summarize("headless", &manifest(&["@deepseek-ai/dsh-base"])).unwrap();
        assert!(!headless.web_capable);
        assert!(!headless.is_selectable());
    }

    #[test]
    fn desktop_profile_is_never_selectable_even_though_it_has_the_web_bundle() {
        let desktop = summarize(DESKTOP_PROFILE, &manifest(&[WEB_APP_BUNDLE])).unwrap();
        assert!(desktop.web_capable, "desktop 确实挂了网页 bundle");
        assert!(!desktop.is_selectable(), "但它必须被隐藏");
        assert!(is_reserved(DESKTOP_PROFILE));
        assert!(!is_reserved("web"));
    }

    #[test]
    fn missing_bundles_read_as_an_empty_environment() {
        let summary = summarize("fresh", "{\"name\":\"dsh-profile-fresh\"}").unwrap();
        assert_eq!(summary.plugins, 0);
        assert!(!summary.bridge_installed);
        assert!(!summary.web_capable);
    }

    #[test]
    fn non_string_bundle_entries_are_ignored_instead_of_failing() {
        let json = "{\"dsh\":{\"profile\":{\"bundles\":[1,null,\"a\",{\"b\":1}]}}}";
        let summary = summarize("odd", json).unwrap();
        assert_eq!(summary.plugins, 1);
    }

    #[test]
    fn broken_json_is_an_error_that_names_the_environment() {
        let err = summarize("lab", "{oops").unwrap_err();
        assert!(err.contains("lab"), "{err}");
        assert!(err.contains("不是合法 JSON"), "{err}");
    }

    #[test]
    fn listing_keeps_good_lines_and_skips_broken_ones() {
        let text = format!(
            "web\t1\t{}\n\nlab\t1\t{{oops\n../etc\t1\t{{}}\nbroken-line-without-tab\nheadless\t0\t{}\n",
            manifest(&[WEB_APP_BUNDLE, BRIDGE_PLUGIN]),
            manifest(&["@deepseek-ai/dsh-base"])
        );
        let profiles = parse_listing(&text);
        let names: Vec<&str> = profiles.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["headless", "web"]);
        assert!(profiles[1].is_selectable());
        assert!(!profiles[0].is_selectable());
    }

    #[test]
    fn listing_reports_whether_dependencies_are_installed() {
        let text = format!(
            "web\t1\t{}\nfresh\t0\t{}\n",
            manifest(&[WEB_APP_BUNDLE]),
            manifest(&[WEB_APP_BUNDLE])
        );
        let profiles = parse_listing(&text);
        assert_eq!(profiles[0].name, "fresh");
        assert!(!profiles[0].deps_installed, "复制出来的环境没有依赖");
        assert!(profiles[1].deps_installed);
    }

    #[test]
    fn listing_without_a_dependency_column_reads_as_not_installed() {
        let text = format!("web\t{}\n", manifest(&[WEB_APP_BUNDLE]));
        let profiles = parse_listing(&text);
        assert_eq!(profiles.len(), 1);
        assert!(!profiles[0].deps_installed);
        assert_eq!(profiles[0].plugins, 1, "旧格式的内容照样解析");
    }

    #[test]
    fn empty_listing_means_no_environments() {
        assert!(parse_listing("").is_empty());
        assert!(parse_listing("\n\n").is_empty());
    }

    #[test]
    fn badge_reads_like_the_collapsed_card_summary() {
        let summary = summarize("web", &manifest(&[WEB_APP_BUNDLE, "dsharbor-bridge"])).unwrap();
        assert_eq!(summary.badge(), "web · 2 个插件 · 桥接已装");
        let summary = summarize("lab", &manifest(&[WEB_APP_BUNDLE])).unwrap();
        assert_eq!(summary.badge(), "lab · 1 个插件 · 桥接未装");
    }
}
