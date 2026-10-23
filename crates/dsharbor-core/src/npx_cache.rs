//! npx 缓存（`npm config get cache` 下面的 `_npx/<hash>`）里装过哪些本包版本。
//!
//! 为什么放核心库：这里是纯粹的解析与归属判定（哪些目录属于本包、哪个 spec 解析成哪个
//! 版本），能在开发机上用单测覆盖；真正去读目录、跑 `npm config get cache` 是外壳的事
//! （`src-tauri/src/npxcache.rs`）。
//!
//! 归属判定故意严格：只有 `package.json` 里明确记录着本包的目录才算「我们的」。
//! `_npx` 下面还躺着别的包（其它工具、别的服务）的缓存，把它们当成「装过 DSH」是错的。
//!
//! 壳不管理缓存（不统计占用、不清理），这里也就只留「读」所需的最小集合。

use crate::launch::NPX_PACKAGE;

/// 缓存根下的这一层目录名。
pub const NPX_DIR_NAME: &str = "_npx";

/// `package.json` 里判定归属需要的两个字段。
///
/// 读不到文件、解析不了 JSON 时用 `Manifest::default()`（空 = 不属于本包），
/// 宁可少算一份，也不要把别人的缓存算进来。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Manifest {
    /// `_npx.packages`：`npx` 调用时的原始 spec，形如
    /// `@deepseek-ai/dsh` / `@deepseek-ai/dsh@next` / `@deepseek-ai/dsh@0.2.1-rc.2`。
    pub packages: Vec<String>,
    /// `dependencies` 的键（包名，不带版本）。
    pub dependencies: Vec<String>,
}

impl Manifest {
    /// 这份缓存目录是否明确记录着本包。
    ///
    /// 两个字段都要看：`_npx.packages` 存的是原始 spec（`@next` 这种可能带版本），
    /// `dependencies` 存的是解析后的包名，单看一个会漏。
    pub fn owns(&self) -> bool {
        self.packages
            .iter()
            .any(|spec| spec_package_name(spec) == NPX_PACKAGE)
            || self.dependencies.iter().any(|name| name == NPX_PACKAGE)
    }
}

/// 从一份 `package.json` 正文里抽出归属判定要用的字段。
///
/// 返回 `None`：不是合法 JSON、或者顶层不是对象（文件被写坏、被别的工具改过）。
/// 空对象 `{}` 返回空 `Manifest`：能读但没有归属信息，也不算本包。
pub fn parse_manifest(json: &str) -> Option<Manifest> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let object = value.as_object()?;
    let mut manifest = Manifest::default();
    if let Some(packages) = object
        .get("_npx")
        .and_then(|npx| npx.get("packages"))
        .and_then(|packages| packages.as_array())
    {
        for item in packages {
            if let Some(text) = item.as_str() {
                manifest.packages.push(text.to_string());
            }
        }
    }
    if let Some(dependencies) = object.get("dependencies").and_then(|deps| deps.as_object()) {
        manifest.dependencies = dependencies.keys().cloned().collect();
    }
    Some(manifest)
}

/// 去掉 npx spec 末尾的 `@版本`，只留包名。
///
/// `@deepseek-ai/dsh` 原样返回；`@deepseek-ai/dsh@next`、`@deepseek-ai/dsh@0.2.1-rc.2`
/// 返回 `@deepseek-ai/dsh`；不带 scope 的 `lodash@4.17.21` 返回 `lodash`。
pub fn spec_package_name(spec: &str) -> &str {
    let spec = spec.trim();
    // 带 scope 的包名以 `@` 开头，要从第二个 `@` 开始找版本分隔符。
    let start = if spec.starts_with('@') { 1 } else { 0 };
    match spec.get(start..).and_then(|rest| rest.find('@')) {
        Some(index) => &spec[..start + index],
        None => spec,
    }
}

/// 从一条本包 npx spec 里取具体版本号；不带版本后缀时 None。
///
/// `@deepseek-ai/dsh@0.2.1-rc.2` → `Some("0.2.1-rc.2")`，而 `@deepseek-ai/dsh`、
/// `@deepseek-ai/dsh@next`、别的包（`lodash@4`）、空串或脏数据都是 None。
/// 两层判断都必要：先确认包名是本包（`_npx` 里躺着别的包，`lodash@4` 的后缀也是
/// 数字开头，不认包名就会把别人的版本算成「已缓存」），再确认后缀是版本号形态
/// （复用 `registry::is_version_like`：dist-tag 不是版本号）。
pub fn spec_version(spec: &str) -> Option<&str> {
    if spec_package_name(spec) != NPX_PACKAGE {
        return None;
    }
    let spec = spec.trim();
    let start = if spec.starts_with('@') { 1 } else { 0 };
    let suffix = &spec[start..].split_once('@')?.1;
    if crate::registry::is_version_like(suffix) {
        Some(suffix)
    } else {
        None
    }
}

/// 「钉版本写法」（`@deepseek-ai/dsh@<具体版本号>`）能直接复用缓存的版本清单（去重 + 从新到旧）。
///
/// npx 的缓存键是命令写法本身：裸包名 `@deepseek-ai/dsh` 与钉版本
/// `@deepseek-ai/dsh@0.2.1-rc.2` 解析到同一版本也各建一个 `_npx/<hash>` 目录。
/// 所以「缓存里有 v」不等于「选 v 启动不用再下载」——只有 manifest 里登记的就是
/// 钉版本写法的那份目录才服务得了钉版本的启动命令。`spec_version` 恰好只认这种
/// 具体版本号的钉版本 spec（裸包名、`@next` 这类标签、别的包都判 None），直接复用。
pub fn pin_served_versions<I, S>(entries: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: IntoIterator,
    S::Item: AsRef<str>,
{
    let mut versions: Vec<String> = Vec::new();
    for specs in entries {
        for spec in specs {
            if let Some(version) = spec_version(spec.as_ref()) {
                versions.push(version.to_string());
            }
        }
    }
    versions.sort();
    versions.dedup();
    crate::registry::sort_newest_first(&mut versions);
    versions
}

/// 把 `_npx` 里扫到的「本包版本」汇总成界面要用的清单（去重 + 从新到旧）。
///
/// 每个目录给两个来源，顺序不能反：
/// - `resolved`：该目录 `node_modules/@deepseek-ai/dsh/package.json` 里的 `version`，
///   这是 npx 当年真正解析出来的那一版；
/// - `specs`：该目录 `package.json` 的 `_npx.packages` 原始 spec，读不到上面那版时
///   退回用它的版本后缀（`npx_cache::spec_version`）。
///
/// 两个来源都可能缺（目录没装完、被清过、spec 是 `@next` 这种标签），缺就跳过；
/// 该目录一个来源都没有就不产出任何版本，绝不用别的包或标签凑数。
pub fn cached_versions<'a, I, S>(entries: I) -> Vec<String>
where
    I: IntoIterator<Item = (Option<&'a str>, S)>,
    S: IntoIterator,
    S::Item: AsRef<str>,
{
    let mut versions: Vec<String> = Vec::new();
    for (resolved, specs) in entries {
        let version = resolved
            .map(str::trim)
            .filter(|version| crate::registry::is_version_like(version))
            .map(str::to_string)
            .or_else(|| {
                specs
                    .into_iter()
                    .find_map(|spec| spec_version(spec.as_ref()).map(str::to_string))
            });
        if let Some(version) = version {
            versions.push(version);
        }
    }
    versions.sort();
    versions.dedup();
    crate::registry::sort_newest_first(&mut versions);
    versions
}

/// 从 `npm config get cache` 的输出里抽出缓存根。
///
/// 不能直接取第一行：采集 stdout 与 stderr 是合并的，npm 可能把升级提示、警告排在前面。
/// 所以倒着找最后一条看起来像路径的行（含路径分隔符），去掉两侧引号。
pub fn parse_cache_root(text: &str) -> Option<String> {
    let mut found: Option<&str> = None;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.contains('\\') || line.contains('/') {
            found = Some(line);
        }
    }
    found.map(|line| line.trim_matches('"').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(packages: &[&str], deps: &[&str]) -> Manifest {
        Manifest {
            packages: packages.iter().map(|item| item.to_string()).collect(),
            dependencies: deps.iter().map(|item| item.to_string()).collect(),
        }
    }

    #[test]
    fn spec_package_name_strips_version_but_keeps_scope() {
        assert_eq!(spec_package_name("@deepseek-ai/dsh"), "@deepseek-ai/dsh");
        assert_eq!(
            spec_package_name("@deepseek-ai/dsh@next"),
            "@deepseek-ai/dsh"
        );
        assert_eq!(
            spec_package_name("@deepseek-ai/dsh@0.2.1-rc.2"),
            "@deepseek-ai/dsh"
        );
        assert_eq!(spec_package_name("lodash@4.17.21"), "lodash");
        assert_eq!(spec_package_name("  lodash  "), "lodash");
        assert_eq!(spec_package_name(""), "");
    }

    #[test]
    fn owned_via_npx_packages_with_version_suffix() {
        // 实测见过的三种 spec：不带版本、带 dist-tag、带具体版本。
        for spec in [
            "@deepseek-ai/dsh",
            "@deepseek-ai/dsh@next",
            "@deepseek-ai/dsh@0.2.1-rc.2",
        ] {
            let entry = dir(&[spec], &[]);
            assert!(entry.owns(), "{spec} 应判为本包");
        }
    }

    #[test]
    fn owned_via_dependencies_key_only() {
        // 只看 dependencies 也能认出来：`_npx.packages` 缺失或被清掉时的兜底。
        let entry = dir(&[], &[NPX_PACKAGE]);
        assert!(entry.owns());
    }

    #[test]
    fn other_packages_are_never_ours() {
        assert!(!dir(&["typescript@5.6.3"], &["typescript"]).owns());
        // 同 scope 的另一个包不算：比的是完整包名。
        let sibling = dir(&["@deepseek-ai/cli@next"], &["@deepseek-ai/cli"]);
        assert!(!sibling.owns());
    }

    #[test]
    fn missing_manifest_file_is_not_ours() {
        assert!(!Manifest::default().owns());
    }

    #[test]
    fn broken_json_is_rejected_and_maps_to_not_ours() {
        assert_eq!(parse_manifest(""), None);
        assert_eq!(parse_manifest("{oops"), None);
        assert_eq!(parse_manifest("[1, 2]"), None);
        assert_eq!(
            parse_manifest("{\"name\":\"x\"}").and_then(|m| m.owns().then_some(m)),
            None,
            "没有归属字段的空 Manifest 不该算本包"
        );
    }

    #[test]
    fn parse_manifest_reads_packages_and_dependency_keys() {
        let json = r#"{
            "dependencies": {"@deepseek-ai/dsh": "0.2.1-rc.2", "left-pad": "^1.0.0"},
            "_npx": {"packages": ["@deepseek-ai/dsh@next", 42, null]}
        }"#;
        let manifest = parse_manifest(json).expect("合法 JSON");
        assert_eq!(manifest.packages, vec!["@deepseek-ai/dsh@next".to_string()]);
        assert_eq!(manifest.dependencies.len(), 2);
        assert!(manifest.owns());
    }

    #[test]
    fn spec_version_reads_only_concrete_versions() {
        assert_eq!(
            spec_version("@deepseek-ai/dsh@0.2.1-rc.2"),
            Some("0.2.1-rc.2")
        );
        assert_eq!(spec_version("  @deepseek-ai/dsh@0.2.1 "), Some("0.2.1"));
        // dist-tag 不是版本号：它不代表任何已装版本，界面不能在「已缓存」里列它。
        assert_eq!(spec_version("@deepseek-ai/dsh@next"), None);
        assert_eq!(spec_version("@deepseek-ai/dsh@latest"), None);
        // 不带版本后缀、别的包、脏数据。
        assert_eq!(spec_version("@deepseek-ai/dsh"), None);
        assert_eq!(spec_version("lodash@4"), None);
        assert_eq!(spec_version(""), None);
        assert_eq!(spec_version("   "), None);
        assert_eq!(spec_version("@deepseek-ai/dsh@"), None);
    }

    #[test]
    fn cached_versions_prefers_resolved_then_manifest_spec() {
        let entries: [(&str, Option<&str>, &[&str]); 5] = [
            // 解析出来的那一版优先，spec 里的后缀忽略（同一目录两个来源会不一致）。
            (
                "hash-a",
                Some(" 0.2.1-rc.2 "),
                &["@deepseek-ai/dsh@0.2.1-alpha.5"],
            ),
            // 读不到 node_modules 清单时退回 spec 后缀。
            ("hash-b", None, &["@deepseek-ai/dsh@0.2.0"]),
            // 两个来源都没有可用版本：spec 是 dist-tag，不能凑数。
            ("hash-c", None, &["@deepseek-ai/dsh@next"]),
            // 同一版本出现两次只报一次。
            ("hash-d", Some("0.3.0"), &["@deepseek-ai/dsh@0.3.0"]),
            // 脏数据（被改坏的清单）不算版本，也不能 panic。
            ("hash-e", Some("not-a-version"), &["@deepseek-ai/dsh@"]),
        ];
        let versions = cached_versions(
            entries
                .iter()
                .map(|(_, resolved, specs)| (*resolved, *specs)),
        );
        assert_eq!(versions, vec!["0.3.0", "0.2.1-rc.2", "0.2.0"]);

        // 空输入不是错误：缓存里还没有本包的任何版本。
        assert!(cached_versions(Vec::<(Option<&str>, Vec<&str>)>::new()).is_empty());
    }

    #[test]
    fn pin_served_versions_reads_only_pinned_specs() {
        // 钉版本写法的目录：这一版启动能直接复用。
        let pinned: Vec<Vec<&str>> = vec![vec!["@deepseek-ai/dsh@0.2.1-rc.2"]];
        assert_eq!(pin_served_versions(&pinned), vec!["0.2.1-rc.2"]);

        // 裸包名与 dist-tag 写法的目录再多也服务不了钉版本的启动：一个都不算。
        let loose: Vec<Vec<&str>> = vec![
            vec!["@deepseek-ai/dsh"],
            vec!["@deepseek-ai/dsh@next"],
            vec!["@deepseek-ai/dsh@"],
        ];
        assert!(pin_served_versions(&loose).is_empty());

        // 别的包不算（`lodash@4` 的后缀也是数字开头）。
        let other: Vec<Vec<&str>> = vec![vec!["lodash@4.17.21"]];
        assert!(pin_served_versions(&other).is_empty());

        // 空输入不是错误。
        assert!(pin_served_versions(Vec::<Vec<&str>>::new()).is_empty());
    }

    #[test]
    fn pin_served_versions_dedupes_and_sorts_newest_first() {
        // 同一版本钉过两次（或同一目录登记多条）只报一次；空格容忍与 cached_versions 一致。
        let entries: Vec<Vec<&str>> = vec![
            vec!["@deepseek-ai/dsh@0.2.0", "  @deepseek-ai/dsh@0.2.0 "],
            vec!["@deepseek-ai/dsh@0.3.0"],
        ];
        assert_eq!(pin_served_versions(&entries), vec!["0.3.0", "0.2.0"]);
    }

    #[test]
    fn parse_cache_root_skips_npm_chatter_and_takes_the_last_path() {
        assert_eq!(
            parse_cache_root("C:\\Users\\me\\AppData\\Local\\npm-cache\n").as_deref(),
            Some("C:\\Users\\me\\AppData\\Local\\npm-cache")
        );
        // 升级提示在前、真正的值在后（stdout/stderr 合并后的常见样子）。
        let noisy = "npm warn New minor version of npm available!\nnpm warn run `npm install -g npm` to update\nD:\\cache\\npm\n";
        assert_eq!(parse_cache_root(noisy).as_deref(), Some("D:\\cache\\npm"));
        // 值带引号时去掉引号。
        assert_eq!(
            parse_cache_root("\"/home/me/.npm\"\n").as_deref(),
            Some("/home/me/.npm")
        );
        assert_eq!(parse_cache_root(""), None);
        assert_eq!(parse_cache_root("npm warn something broke"), None);
    }
}
