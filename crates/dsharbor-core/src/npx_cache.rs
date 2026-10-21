//! npx 缓存（`npm config get cache` 下面的 `_npx/<hash>`）的归属判定、保留集合与可回收量。
//!
//! 为什么放核心库：这里全是「哪几个目录属于本包、哪些可以删、删掉能腾多少」的纯计算，
//! 能在开发机上用单测覆盖；真正去 stat 目录、删目录是外壳的事
//! （`src-tauri/src/npxcache.rs`）。
//!
//! 归属判定故意严格：只有 `package.json` 里明确记录着本包的目录才算「我们的」。
//! `_npx` 下面还躺着别的包（其它工具、别的服务）的缓存，把它们算进占用或者删掉都是破坏。
//!
//! 保留策略：留下当前启动配置对应的那一份，再加最近用过的几份（目录 mtime 当「最近使用」
//! 的近似——`npx` 复用已有目录时不会刷新目录内文件的 mtime，所以这只是近似，不是精确的
//! 使用时间），其余可删。

use crate::launch::{self, LaunchConfig, LaunchMode, NPX_PACKAGE};

/// 缓存根下的这一层目录名。
pub const NPX_DIR_NAME: &str = "_npx";

/// 默认保留份数：当前启动配置那份 + 最近用过的这一份。
pub const DEFAULT_KEEP: usize = 2;

/// `package.json` 里判定归属需要的两个字段。
///
/// 读不到文件、解析不了 JSON 时用 `Manifest::default()`（空 = 不属于本包），
/// 宁可少算一份，也不要把别人的缓存算进来或者删掉。
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

    /// 这份目录的 `_npx.packages` 里逐字记着 `spec`（最精确的命中）。
    ///
    /// `_npx.packages` 存的是调用时的原始 spec，所以 `@deepseek-ai/dsh` 与
    /// `@deepseek-ai/dsh@next` 在这里是两份不同的目录。
    pub fn exact(&self, spec: &str) -> bool {
        let spec = spec.trim();
        !spec.is_empty()
            && self
                .packages
                .iter()
                .any(|item| item.trim().eq_ignore_ascii_case(spec))
    }

    /// 这份目录是不是 `spec` 对应的那一份（精确优先，包名兜底）。
    ///
    /// `spec` 来自 `launch::npx_spec(version)`。两种命中强度不同：
    /// - `_npx.packages` 里逐字有 `spec`：这就是它（`exact`）；
    /// - `dependencies` 的键等于 `spec`：只在不带版本后缀（自动最新版）时才可能对上，
    ///   且同时可能有多份目录对上，所以只当兜底。调用方要「优先精确」，
    ///   用 `exact` 先筛一遍。
    pub fn uses(&self, spec: &str) -> bool {
        let spec = spec.trim();
        if spec.is_empty() {
            return false;
        }
        self.exact(spec)
            || self
                .dependencies
                .iter()
                .any(|name| name.trim().eq_ignore_ascii_case(spec))
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

/// 一个缓存目录的输入：外壳扫出来的字段，纯逻辑只认这几个。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    /// `_npx` 下的目录名（hash）。
    pub name: String,
    /// 目录 mtime（Unix 秒；读不到时填 0，会被排到最后）。
    pub mtime: i64,
    /// 目录下所有文件的字节数之和（不跟符号链接）。
    pub bytes: u64,
    /// 该目录 `package.json` 的归属字段。
    pub manifest: Manifest,
}

/// 保留 / 可回收的判定结果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CachePlan {
    /// 属于本包的目录个数。
    pub own_count: usize,
    /// 属于本包的目录总字节数（含保留的）。
    pub own_bytes: u64,
    /// 当前启动配置命中的目录名；启动方式不是 npx（或者缓存里没有那一份）时为 None。
    pub current: Option<String>,
    /// 保留的目录名：当前配置那份排第一，其余按 mtime 倒序。
    pub keep: Vec<String>,
    /// 可回收的目录（按 mtime 倒序）。
    pub remove: Vec<DirEntry>,
    /// 可回收字节数（`remove` 里各目录字节数之和）。
    pub reclaimable_bytes: u64,
}

/// 算出保留集合与可回收集合。
///
/// - 不属于本包的目录直接丢弃：不进保留集合，也不进可回收集合（既不计入占用也不删）。
/// - `current_spec` 命中的那份永远保留；`keep_count` 限制保留总份数（0 按 1 处理，
///   至少留下当前那份），多出来的按目录 mtime 倒序成为可回收。
/// - 同 mtime 时按目录名排序，保证同样的输入永远给同样的结果（便于测试与复现）。
pub fn plan(dirs: &[DirEntry], current_spec: Option<&str>, keep_count: usize) -> CachePlan {
    let mut owned: Vec<&DirEntry> = dirs.iter().filter(|dir| dir.manifest.owns()).collect();
    owned.sort_by(|left, right| {
        right
            .mtime
            .cmp(&left.mtime)
            .then_with(|| left.name.cmp(&right.name))
    });

    let keep_count = keep_count.max(1);
    let current = current_spec
        .filter(|spec| !spec.trim().is_empty())
        // 先找 `_npx.packages` 里逐字记着这个 spec 的那份（最精确），
        // 找不到再退回 dependencies 的键（只有不带版本后缀的 spec 才会命中）。
        .and_then(|spec| {
            owned
                .iter()
                .find(|dir| dir.manifest.exact(spec))
                .or_else(|| owned.iter().find(|dir| dir.manifest.uses(spec)))
        })
        .map(|dir| dir.name.clone());

    let mut keep: Vec<String> = Vec::new();
    if let Some(name) = &current {
        keep.push(name.clone());
    }
    for dir in &owned {
        if keep.len() >= keep_count {
            break;
        }
        if keep.iter().any(|kept| kept == &dir.name) {
            continue;
        }
        keep.push(dir.name.clone());
    }

    let mut remove: Vec<DirEntry> = Vec::new();
    let mut own_bytes = 0;
    for dir in &owned {
        own_bytes += dir.bytes;
        if !keep.iter().any(|kept| kept == &dir.name) {
            remove.push((*dir).clone());
        }
    }
    let reclaimable_bytes = remove.iter().map(|dir| dir.bytes).sum();

    CachePlan {
        own_count: owned.len(),
        own_bytes,
        current,
        keep,
        remove,
        reclaimable_bytes,
    }
}

/// 当前启动配置用的 npx spec；启动方式不是「官方 npx 命令」时为 None。
///
/// 自定义命令里可能也写着 `npx @deepseek-ai/dsh@0.2.1-rc.2 …`，但那是用户手写的字符串
/// （可能带 `-p`、`--yes`、另一个包…），从里面猜包规格只会猜错，所以直接不算：
/// 这种情况下只按 mtime 保留（`plan` 会当成「当前那份命中不到」处理）。
/// 非 Windows 宿主（WSL 发行版）的 npm 缓存是另一份，本版不统计，同样不影响这里。
pub fn current_spec(config: &LaunchConfig) -> Option<String> {
    match &config.mode {
        LaunchMode::Npx { version } => Some(launch::npx_spec(version.as_deref())),
        _ => None,
    }
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

/// 界面上给一份缓存目录起个名。
///
/// 目录名是一串 hash，单看没意义；它 `_npx.packages` 里记的 spec 才是人能读的
/// （`@deepseek-ai/dsh@0.2.1-rc.2`）。同一份 spec 可能同时有多份目录，所以后面缀上目录名
/// 的前 8 位以区别于彼此。
pub fn dir_label(dir: &DirEntry) -> String {
    let short: String = dir.name.chars().take(8).collect();
    let spec = dir
        .manifest
        .packages
        .iter()
        .map(|item| item.trim())
        .find(|item| !item.is_empty());
    match spec {
        Some(spec) => format!("{spec}（{short}）"),
        None => short,
    }
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

/// 把字节数写成界面上好读的形式（1024 进制；`B` 取整，其余保留一位小数）。
pub fn human_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let value = bytes as f64;
    let (scaled, unit) = if value < KB * KB {
        (value / KB, "KB")
    } else if value < KB * KB * KB {
        (value / (KB * KB), "MB")
    } else if value < KB * KB * KB * KB {
        (value / (KB * KB * KB), "GB")
    } else {
        (value / (KB * KB * KB * KB), "TB")
    };
    format!("{scaled:.1} {unit}")
}

/// 扫描结果的一行说明。
///
/// `warning` 是读缓存根时的降级说明（`npm config get cache` 没能执行、改用平台默认位置）。
pub fn scan_message(plan: &CachePlan, warning: Option<&str>) -> String {
    let mut text = if plan.own_count == 0 {
        "没找到本包的 npx 缓存：本包还没用 npx 跑过时这里就是空的。只统计明确记录着本包的目录，别的包不计入。".to_string()
    } else if plan.remove.is_empty() {
        format!(
            "本包占用 {}（{} 份），没有可回收的部分：保留份数已经覆盖全部。",
            human_bytes(plan.own_bytes),
            plan.own_count
        )
    } else {
        format!(
            "本包占用 {}（{} 份），可回收 {}（{} 份）。清理会保留当前启动配置对应的那份加最近用过的几份，其余删除；npm 的包体缓存不动，下次启动不用重新下载。",
            human_bytes(plan.own_bytes),
            plan.own_count,
            human_bytes(plan.reclaimable_bytes),
            plan.remove.len()
        )
    };
    if let Some(warning) = warning {
        text.push(' ');
        text.push_str(warning);
    }
    text
}

/// 清理结果的一行说明。
pub fn cleanup_message(removed: usize, freed_bytes: u64, failed: usize) -> String {
    match (removed, failed) {
        (0, 0) => "没有需要清理的目录。".to_string(),
        (0, _) => "这次一个目录都没能清掉，原因见下面的逐条结果。".to_string(),
        (_, 0) => format!(
            "已清掉 {removed} 个目录，释放 {}。",
            human_bytes(freed_bytes)
        ),
        (_, failed) => format!(
            "已清掉 {removed} 个目录，释放 {}；还有 {failed} 个没清掉，原因见下面的逐条结果。",
            human_bytes(freed_bytes)
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str, mtime: i64, bytes: u64, packages: &[&str], deps: &[&str]) -> DirEntry {
        DirEntry {
            name: name.to_string(),
            mtime,
            bytes,
            manifest: Manifest {
                packages: packages.iter().map(|item| item.to_string()).collect(),
                dependencies: deps.iter().map(|item| item.to_string()).collect(),
            },
        }
    }

    /// 本包的一份缓存目录（`_npx.packages` 里登记了本包）。
    fn ours(name: &str, mtime: i64, bytes: u64, spec: &str) -> DirEntry {
        dir(name, mtime, bytes, &[spec], &[NPX_PACKAGE])
    }

    /// 别的包的一份缓存目录。
    fn theirs(name: &str, mtime: i64, bytes: u64) -> DirEntry {
        dir(name, mtime, bytes, &["typescript@5.6.3"], &["typescript"])
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
            let entry = dir("hash", 0, 0, &[spec], &[]);
            assert!(entry.manifest.owns(), "{spec} 应判为本包");
        }
    }

    #[test]
    fn owned_via_dependencies_key_only() {
        // 只看 dependencies 也能认出来：`_npx.packages` 缺失或被清掉时的兜底。
        let entry = dir("hash", 0, 0, &[], &[NPX_PACKAGE]);
        assert!(entry.manifest.owns());
    }

    #[test]
    fn other_packages_are_never_ours() {
        assert!(!theirs("hash", 0, 100).manifest.owns());
        // 同 scope 的另一个包不算：比的是完整包名。
        let sibling = dir(
            "hash",
            0,
            0,
            &["@deepseek-ai/cli@next"],
            &["@deepseek-ai/cli"],
        );
        assert!(!sibling.manifest.owns());
    }

    #[test]
    fn missing_manifest_file_is_not_ours() {
        // 外壳读不到文件时用 default()，空 Manifest 一律不属于本包。
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
    fn uses_prefers_the_exact_spec_over_the_dependency_key() {
        let with_tag = dir("a", 0, 0, &["@deepseek-ai/dsh@next"], &[NPX_PACKAGE]);
        assert!(with_tag.manifest.exact("@deepseek-ai/dsh@next"));
        assert!(!with_tag.manifest.exact("@deepseek-ai/dsh"));
        // dependencies 里是解析后的包名，所以不带后缀的 spec 也能对上（兜底路径）。
        assert!(with_tag.manifest.uses("@deepseek-ai/dsh"));
        let latest = dir("b", 0, 0, &[NPX_PACKAGE], &[NPX_PACKAGE]);
        assert!(latest.manifest.exact("@deepseek-ai/dsh"));
        assert!(!latest.manifest.uses("@deepseek-ai/dsh@next"));
        assert!(!latest.manifest.uses("  "));
    }

    #[test]
    fn exact_spec_wins_when_several_dirs_match() {
        // 同一份包的两个缓存目录：一份是 @next，一份是稳定版。选 next 渠道时必须选
        // `_npx.packages` 逐字记着 @next 的那份，而不是「先扫到的」或「mtime 更新的」。
        let dirs = vec![
            ours("latest", 900, 10, NPX_PACKAGE),
            ours("next", 100, 20, "@deepseek-ai/dsh@next"),
        ];
        let plan = plan(&dirs, Some("@deepseek-ai/dsh@next"), DEFAULT_KEEP);
        assert_eq!(plan.current.as_deref(), Some("next"));
        assert_eq!(plan.keep[0], "next");
    }

    #[test]
    fn current_config_entry_is_kept_even_when_it_is_the_oldest() {
        let dirs = vec![
            ours("old-current", 100, 10, "@deepseek-ai/dsh@next"),
            ours("newest", 900, 20, "@deepseek-ai/dsh@0.2.0"),
            ours("newer", 800, 30, "@deepseek-ai/dsh@0.1.0"),
        ];
        let plan = plan(&dirs, Some("@deepseek-ai/dsh@next"), DEFAULT_KEEP);
        assert_eq!(plan.current.as_deref(), Some("old-current"));
        assert_eq!(
            plan.keep,
            vec!["old-current".to_string(), "newest".to_string()]
        );
        assert_eq!(plan.remove.len(), 1);
        assert_eq!(plan.remove[0].name, "newer");
    }

    #[test]
    fn without_current_match_keeps_n_newest_by_mtime() {
        // 启动方式不是 npx（current_spec 为 None）：只按 mtime 保留 N 份。
        let dirs = vec![
            ours("a", 100, 10, NPX_PACKAGE),
            ours("b", 300, 20, NPX_PACKAGE),
            ours("c", 200, 30, NPX_PACKAGE),
        ];
        let plan = plan(&dirs, None, DEFAULT_KEEP);
        assert_eq!(plan.current, None);
        assert_eq!(plan.keep, vec!["b".to_string(), "c".to_string()]);
        assert_eq!(plan.remove.len(), 1);
        assert_eq!(plan.remove[0].name, "a");
    }

    #[test]
    fn current_spec_that_matches_nothing_falls_back_to_mtime_order() {
        let dirs = vec![
            ours("a", 100, 10, NPX_PACKAGE),
            ours("b", 300, 20, NPX_PACKAGE),
        ];
        let plan = plan(&dirs, Some("@deepseek-ai/dsh@9.9.9"), DEFAULT_KEEP);
        assert_eq!(plan.current, None);
        assert_eq!(plan.keep, vec!["b".to_string(), "a".to_string()]);
        assert!(plan.remove.is_empty());
    }

    #[test]
    fn keep_count_larger_than_total_keeps_everything() {
        let dirs = vec![
            ours("a", 100, 10, NPX_PACKAGE),
            ours("b", 200, 20, NPX_PACKAGE),
        ];
        let plan = plan(&dirs, None, 10);
        assert_eq!(plan.keep.len(), 2);
        assert!(plan.remove.is_empty());
        assert_eq!(plan.reclaimable_bytes, 0);
        assert_eq!(plan.own_bytes, 30);
    }

    #[test]
    fn keep_count_below_one_still_keeps_the_current_one() {
        let dirs = vec![
            ours("a", 100, 10, "@deepseek-ai/dsh@next"),
            ours("b", 200, 20, NPX_PACKAGE),
        ];
        let plan = plan(&dirs, Some("@deepseek-ai/dsh@next"), 0);
        assert_eq!(plan.keep, vec!["a".to_string()]);
        assert_eq!(plan.remove.len(), 1);
        assert_eq!(plan.reclaimable_bytes, 20);
    }

    #[test]
    fn other_packages_are_neither_counted_nor_removed() {
        let dirs = vec![
            ours("a", 100, 10, NPX_PACKAGE),
            theirs("b", 200, 9999),
            ours("c", 50, 30, NPX_PACKAGE),
            ours("d", 40, 40, NPX_PACKAGE),
        ];
        let plan = plan(&dirs, None, 1);
        assert_eq!(plan.own_count, 3);
        // 别包的 9999 字节不进占用统计。
        assert_eq!(plan.own_bytes, 80);
        assert_eq!(plan.keep, vec!["a".to_string()]);
        let removed: Vec<&str> = plan.remove.iter().map(|dir| dir.name.as_str()).collect();
        assert_eq!(removed, vec!["c", "d"], "只删本包的，且按 mtime 倒序");
        assert_eq!(plan.reclaimable_bytes, 70);
    }

    #[test]
    fn reclaimable_bytes_is_the_sum_of_removable_dirs() {
        let dirs = vec![
            ours("a", 500, 1_000, NPX_PACKAGE),
            ours("b", 400, 2_000, NPX_PACKAGE),
            ours("c", 300, 3_000, NPX_PACKAGE),
            ours("d", 200, 4_000, NPX_PACKAGE),
        ];
        let plan = plan(&dirs, None, DEFAULT_KEEP);
        assert_eq!(plan.keep, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(plan.reclaimable_bytes, 7_000);
        assert_eq!(plan.own_bytes, 10_000);
    }

    #[test]
    fn empty_cache_plans_nothing() {
        let plan = plan(&[], Some(NPX_PACKAGE), DEFAULT_KEEP);
        assert_eq!(plan, CachePlan::default());
    }

    #[test]
    fn ties_are_broken_by_name_so_results_are_stable() {
        let dirs = vec![
            ours("b", 100, 1, NPX_PACKAGE),
            ours("a", 100, 1, NPX_PACKAGE),
        ];
        let plan = plan(&dirs, None, 1);
        assert_eq!(plan.keep, vec!["a".to_string()]);
    }

    #[test]
    fn current_spec_only_comes_from_the_official_npx_mode() {
        let npx = |version: Option<&str>| LaunchConfig {
            mode: LaunchMode::Npx {
                version: version.map(|text| text.to_string()),
            },
            runtime: crate::launch::Runtime::Default,
            extra_args: Vec::new(),
            port: None,
        };
        // 不选版本时 npx 跟 npm 的 latest 标签，spec 就是裸包名。
        assert_eq!(current_spec(&npx(None)).as_deref(), Some(NPX_PACKAGE));
        assert_eq!(
            current_spec(&npx(Some("0.2.1-rc.2"))).as_deref(),
            Some("@deepseek-ai/dsh@0.2.1-rc.2")
        );
        let custom = LaunchConfig {
            mode: LaunchMode::Custom {
                command: "npx --yes @deepseek-ai/dsh@0.2.1-rc.2 web".to_string(),
            },
            runtime: crate::launch::Runtime::Default,
            extra_args: Vec::new(),
            port: None,
        };
        assert_eq!(current_spec(&custom), None, "手写的命令行里不猜包规格");
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

    #[test]
    fn dir_label_prefers_the_recorded_spec_and_falls_back_to_the_hash() {
        let tagged = ours("1a2b3c4d5e6f", 0, 0, "@deepseek-ai/dsh@next");
        assert_eq!(dir_label(&tagged), "@deepseek-ai/dsh@next（1a2b3c4d）");
        // 只有 dependencies 的目录读不出 spec，用 hash 前 8 位，不要凭猜写字串。
        let bare = DirEntry {
            name: "deadbeefcafe".to_string(),
            mtime: 0,
            bytes: 0,
            manifest: Manifest {
                packages: Vec::new(),
                dependencies: vec![NPX_PACKAGE.to_string()],
            },
        };
        assert_eq!(dir_label(&bare), "deadbeef");
    }

    #[test]
    fn human_bytes_uses_1024_steps() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(1023), "1023 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(1536), "1.5 KB");
        assert_eq!(human_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(human_bytes(1024 * 1024 * 1024), "1.0 GB");
        assert_eq!(
            human_bytes(1024_u64 * 1024 * 1024 * 1024),
            "1.0 TB",
            "再大也不该回退成字节数"
        );
    }

    #[test]
    fn scan_message_covers_the_three_situations() {
        let empty = plan(&[], None, DEFAULT_KEEP);
        assert!(scan_message(&empty, None).contains("没找到本包的 npx 缓存"));

        let kept_only = plan(&[ours("a", 1, 2048, NPX_PACKAGE)], None, DEFAULT_KEEP);
        let text = scan_message(&kept_only, None);
        assert!(text.contains("2.0 KB"), "{text}");
        assert!(text.contains("没有可回收"), "{text}");

        let reclaimable = plan(
            &[
                ours("a", 300, 2048, NPX_PACKAGE),
                ours("b", 200, 4096, NPX_PACKAGE),
                ours("c", 100, 1024, NPX_PACKAGE),
            ],
            None,
            DEFAULT_KEEP,
        );
        let text = scan_message(&reclaimable, None);
        assert!(text.contains("7.0 KB"), "{text}");
        assert!(text.contains("可回收 1.0 KB"), "{text}");
    }

    #[test]
    fn scan_message_appends_the_fallback_warning() {
        let plan = plan(&[], None, DEFAULT_KEEP);
        let text = scan_message(&plan, Some("（没能读到 npm 的缓存目录，按默认位置统计。）"));
        assert!(text.contains("默认位置"), "{text}");
    }

    #[test]
    fn cleanup_message_covers_all_outcomes() {
        assert_eq!(cleanup_message(0, 0, 0), "没有需要清理的目录。");
        assert!(cleanup_message(0, 0, 2).contains("一个目录都没能清掉"));
        assert_eq!(
            cleanup_message(2, 3072, 0),
            "已清掉 2 个目录，释放 3.0 KB。"
        );
        let partial = cleanup_message(1, 1024, 1);
        assert!(partial.contains("已清掉 1 个目录"), "{partial}");
        assert!(partial.contains("1 个没清掉"), "{partial}");
    }
}
