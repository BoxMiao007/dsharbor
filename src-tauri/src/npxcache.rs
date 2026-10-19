//! npx 缓存的外壳侧：找缓存根、量目录大小、删目录。
//!
//! 归属判定、保留集合、可回收量、界面文案全是纯计算，在核心库的
//! `dsharbor_core::npx_cache` 里并有单元测试；这里只做三件与操作系统打交道的事：
//! 问 npm 缓存根在哪、递归 stat 目录、`remove_dir_all`。
//!
//! 为什么缓存根要问 npm 而不是写死 `%LOCALAPPDATA%\npm-cache`：用户可能用 `npm config
//! set cache` 或 `.npmrc` 改过（换到大盘、放进项目目录）。写死会让「占用」显示 0 而实际
//! 有一堆目录没管，也会把清理按钮做成假的。问不到时才退回平台默认位置，并在界面上说明。

use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use dsharbor_core::launch::LaunchConfig;
use dsharbor_core::npx_cache;
use serde::Serialize;

/// `npm config get cache` 正常几十毫秒；npx 冷启动时会先在壳里跑一次，给足余量。
const NPM_TIMEOUT: Duration = Duration::from_secs(30);

/// 一份缓存目录在界面上的样子。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheDir {
    /// `_npx` 下的目录名（hash）。
    pub name: String,
    /// 给人看的名字：`_npx.packages` 里的 spec 加 hash 前 8 位。
    pub label: String,
    /// 目录下所有文件字节数之和。
    pub bytes: u64,
    /// 上面那个数给界面直接显示的形式（`1.8 GB`）。
    pub bytes_text: String,
    /// 这一份会不会被保留。
    pub keep: bool,
    /// 是不是当前启动配置对应的那一份。
    pub current: bool,
}

/// 「集成」卡缓存段的完整状态。界面只读它，不自己算大小。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheState {
    /// 本版只支持 Windows 宿主：WSL 发行版里 npm 的缓存是另一份，不在这里统计。
    pub supported: bool,
    /// 缓存根（`_npx` 的父目录）；问不到、目录不存在时为空。
    pub root: Option<String>,
    /// 缓存根是从哪来的：`npm`（问 npm 得到）/ `fallback`（平台默认位置）。
    pub root_source: String,
    /// 本包占用字节数（只含明确记录着本包的目录）。
    pub own_bytes: u64,
    /// 本包占用给界面直接显示的形式（`1.8 GB`）。
    pub own_bytes_text: String,
    /// 本包占用的目录份数。
    pub own_count: usize,
    /// 可回收字节数。
    pub reclaimable_bytes: u64,
    /// 可回收量给界面直接显示的形式（`412.3 MB`）。
    pub reclaimable_bytes_text: String,
    /// 可回收的目录份数。
    pub removable_count: usize,
    /// 保留份数上限（当前配置那份 + 最近用过的几份）。
    pub keep_count: usize,
    /// 当前启动配置命中的目录名；没命中（或启动方式不是 npx）时为空。
    pub current: Option<String>,
    /// 本包占用与可回收量的说明文字。
    pub message: String,
    /// 缓存根的降级说明（问不到 npm 时用平台默认位置）。
    pub warning: Option<String>,
    /// 属于本包的目录，保留的在前。
    pub dirs: Vec<CacheDir>,
}

impl CacheState {
    /// 「本版不支持」的空状态（非 Windows 宿主）。
    fn unsupported() -> Self {
        Self {
            supported: false,
            root: None,
            root_source: String::new(),
            own_bytes: 0,
            own_bytes_text: npx_cache::human_bytes(0),
            own_count: 0,
            reclaimable_bytes: 0,
            reclaimable_bytes_text: npx_cache::human_bytes(0),
            removable_count: 0,
            keep_count: npx_cache::DEFAULT_KEEP,
            current: None,
            message: "缓存盘面仅在 Windows 宿主可用。".to_string(),
            warning: None,
            dirs: Vec::new(),
        }
    }
}

/// 清理掉的一份目录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanedDir {
    pub label: String,
    pub bytes: u64,
    /// 释放量给界面直接显示的形式（`412.3 MB`）。
    pub bytes_text: String,
}

/// 没清掉的一份目录及原因。
///
/// 为什么要把 `path` 也带上：失败原因往往是「被占用」，用户要知道是哪个路径被谁占着，
/// 只报一个 hash 目录名没法去排查。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFailure {
    pub label: String,
    pub path: String,
    pub reason: String,
}

/// 一次「立即清理」的结果：逐条列出了清掉什么、没清掉什么，以及刷新后的占用数字。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub removed: Vec<CleanedDir>,
    pub failed: Vec<CleanupFailure>,
    pub freed_bytes: u64,
    /// 清理结果的说明文字。
    pub message: String,
    /// 清理完成后重新扫出来的状态（界面拿它刷新数字）。
    pub state: CacheState,
}

/// 扫一遍缓存（只读：只 stat，不写不删）。
pub fn scan(config: &LaunchConfig) -> CacheState {
    if !cfg!(windows) {
        return CacheState::unsupported();
    }
    let resolved = resolve_root();
    scan_at(
        resolved.root.as_deref(),
        &resolved.source,
        resolved.warning,
        config,
    )
}

/// 「立即清理」：删掉核心库判定为可回收的目录，再重新扫一遍。
///
/// 任何一份删不掉都不中断其余的删除，原因逐条收集到 `failed` 里返回；
/// 只有缓存根本身定位失败时才返回 `Err`（那种情况下没有可操作的对象）。
pub fn cleanup(config: &LaunchConfig) -> Result<CleanupResult, String> {
    if !cfg!(windows) {
        return Ok(CleanupResult {
            removed: Vec::new(),
            failed: Vec::new(),
            freed_bytes: 0,
            message: "缓存盘面仅在 Windows 宿主可用。".to_string(),
            state: CacheState::unsupported(),
        });
    }
    let resolved = resolve_root();
    let root = resolved.root.clone().ok_or_else(|| {
        resolved
            .warning
            .clone()
            .unwrap_or_else(|| "找不到 npm 缓存目录".to_string())
    })?;
    Ok(cleanup_at(
        &root,
        &resolved.source,
        resolved.warning,
        config,
    ))
}

/// 在给定缓存根上执行清理（与 `cleanup` 分离，便于用临时目录测）。
fn cleanup_at(
    root: &Path,
    source: &str,
    warning: Option<String>,
    config: &LaunchConfig,
) -> CleanupResult {
    let npx_dir = root.join(npx_cache::NPX_DIR_NAME);
    let entries = read_entries(&npx_dir);
    let plan = build_plan(&entries, config);

    let mut removed: Vec<CleanedDir> = Vec::new();
    let mut failed: Vec<CleanupFailure> = Vec::new();
    let mut freed_bytes = 0_u64;
    for dir in &plan.remove {
        let path = npx_dir.join(&dir.name);
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {
                freed_bytes += dir.bytes;
                removed.push(CleanedDir {
                    label: npx_cache::dir_label(dir),
                    bytes: dir.bytes,
                    bytes_text: npx_cache::human_bytes(dir.bytes),
                });
            }
            Err(err) => failed.push(CleanupFailure {
                label: npx_cache::dir_label(dir),
                path: path.display().to_string(),
                reason: describe_io_error(&err),
            }),
        }
    }

    CleanupResult {
        message: npx_cache::cleanup_message(removed.len(), freed_bytes, failed.len()),
        removed,
        failed,
        freed_bytes,
        state: scan_at(Some(root), source, warning, config),
    }
}

/// 缓存根的来源与降级说明。
struct RootResolution {
    root: Option<PathBuf>,
    source: String,
    warning: Option<String>,
}

/// 问 npm 缓存根在哪；问不到就退回平台默认位置。
fn resolve_root() -> RootResolution {
    match npm_cache_root() {
        Ok(root) => RootResolution {
            root: Some(root),
            source: "npm".to_string(),
            warning: None,
        },
        Err(err) => {
            let fallback = default_cache_root();
            RootResolution {
                warning: Some(format!(
                    "没问出 npm 的缓存位置（{err}），已按平台默认位置统计：{}。",
                    fallback.display()
                )),
                root: Some(fallback),
                source: "fallback".to_string(),
            }
        }
    }
}

/// 跑 `npm config get cache` 拿缓存根。
///
/// 输出里可能混着 npm 的升级提示，解析交给核心库（`npx_cache::parse_cache_root`），
/// 那里有单测。
fn npm_cache_root() -> Result<PathBuf, String> {
    let text = crate::plugin::run_capture(npm_command(), NPM_TIMEOUT)?.1;
    let path =
        npx_cache::parse_cache_root(&text).ok_or_else(|| "npm 没有输出缓存路径".to_string())?;
    Ok(PathBuf::from(path))
}

/// 组装 `npm config get cache` 命令。
///
/// Windows 上 npm 是 `npm.cmd`，必须经 cmd.exe 才能拉起（直接 CreateProcess 一个 .cmd
/// 会得到「不是有效的应用程序」）。与查询 npm 源时同一种做法。
fn npm_command() -> std::process::Command {
    let mut command = if cfg!(windows) {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "npm"]);
        command
    } else {
        std::process::Command::new("npm")
    };
    command.args(["config", "get", "cache"]);
    command
}

/// 问不到 npm 时按平台默认位置猜。
///
/// 只用于「npm 命令本身跑不起来」的降级；正常的机器上永远走 npm 那条路。
fn default_cache_root() -> PathBuf {
    if cfg!(windows) {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if !local.trim().is_empty() {
                return PathBuf::from(local).join("npm-cache");
            }
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join(".npm");
        }
    }
    PathBuf::from(".npm")
}

/// 在给定缓存根上扫一遍并组装状态。
fn scan_at(
    root: Option<&Path>,
    source: &str,
    warning: Option<String>,
    config: &LaunchConfig,
) -> CacheState {
    let root = match root {
        Some(root) => root,
        None => {
            return CacheState {
                supported: true,
                message: npx_cache::scan_message(
                    &npx_cache::CachePlan::default(),
                    warning.as_deref(),
                ),
                warning,
                root_source: source.to_string(),
                ..CacheState::unsupported()
            };
        }
    };
    let npx_dir = root.join(npx_cache::NPX_DIR_NAME);
    let entries = read_entries(&npx_dir);
    let plan = build_plan(&entries, config);
    let dirs = collect_dirs(&entries, &plan);
    CacheState {
        supported: true,
        root: Some(root.display().to_string()),
        root_source: source.to_string(),
        own_bytes: plan.own_bytes,
        own_bytes_text: npx_cache::human_bytes(plan.own_bytes),
        own_count: plan.own_count,
        reclaimable_bytes: plan.reclaimable_bytes,
        reclaimable_bytes_text: npx_cache::human_bytes(plan.reclaimable_bytes),
        removable_count: plan.remove.len(),
        keep_count: npx_cache::DEFAULT_KEEP,
        current: plan.current.clone(),
        message: npx_cache::scan_message(&plan, warning.as_deref()),
        warning,
        dirs,
    }
}

/// 读 `_npx` 下每个子目录的原始项，交给核心库算出保留 / 可回收结果。
fn build_plan(entries: &[npx_cache::DirEntry], config: &LaunchConfig) -> npx_cache::CachePlan {
    let spec = npx_cache::current_spec(config);
    npx_cache::plan(entries, spec.as_deref(), npx_cache::DEFAULT_KEEP)
}

/// `_npx` 下每个子目录的 `{名字, mtime, 字节数, 归属字段}`。
///
/// 读不到的目录跳过：`npx` 正在用的目录可能刚被创建、还没写 `package.json`，
/// 这种半成品既不该算占用，也不该被删。
fn read_entries(npx_dir: &Path) -> Vec<npx_cache::DirEntry> {
    let mut entries: Vec<npx_cache::DirEntry> = Vec::new();
    let Ok(listing) = std::fs::read_dir(npx_dir) else {
        return entries;
    };
    for item in listing.flatten() {
        let path = item.path();
        // 只认真目录：符号链接 / junction 一律跳过（可能是别人放的指针，跟进去会重复统计）。
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let manifest = read_manifest(&path.join("package.json"));
        entries.push(npx_cache::DirEntry {
            name: name.to_string(),
            mtime: modified_secs(&meta),
            bytes: dir_bytes(&path),
            manifest,
        });
    }
    entries
}

/// 读一份 `package.json` 的归属字段；读不到 / 解析不了按「不属于本包」处理。
fn read_manifest(path: &Path) -> npx_cache::Manifest {
    let Ok(text) = std::fs::read_to_string(path) else {
        return npx_cache::Manifest::default();
    };
    npx_cache::parse_manifest(&text).unwrap_or_default()
}

/// 目录 mtime（Unix 秒）；读不到或早于 1970 时给 0（排到最后）。
fn modified_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// 递归累加文件字节数。
///
/// 不跟符号链接 / junction：`npx` 会把包体硬链或软链到 `_cacache`，
/// 跟进去既可能重复统计，也可能绕成死循环。读不到的节点直接跳过（大小是估值，
/// 不该因为一个没权限的文件就让整张卡报错）。
fn dir_bytes(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let Ok(listing) = std::fs::read_dir(path) else {
        return 0;
    };
    listing
        .flatten()
        .map(|item| dir_bytes(&item.path()))
        .sum::<u64>()
}

/// 把 `_npx` 下的判定结果整理成界面要的行。
fn collect_dirs(entries: &[npx_cache::DirEntry], plan: &npx_cache::CachePlan) -> Vec<CacheDir> {
    let mut rows: Vec<CacheDir> = entries
        .iter()
        .filter(|dir| dir.manifest.owns())
        .map(|dir| CacheDir {
            name: dir.name.clone(),
            label: npx_cache::dir_label(dir),
            bytes: dir.bytes,
            bytes_text: npx_cache::human_bytes(dir.bytes),
            keep: plan.keep.iter().any(|kept| kept == &dir.name),
            current: plan.current.as_deref() == Some(dir.name.as_str()),
        })
        .collect();
    // 保留的在前；同组内按大小倒序（大的更值得注意，也与核心库的 mtime 顺序一致）。
    rows.sort_by(|left, right| {
        right
            .keep
            .cmp(&left.keep)
            .then_with(|| right.bytes.cmp(&left.bytes))
            .then_with(|| left.name.cmp(&right.name))
    });
    rows
}

/// 把 `io::Error` 翻成用户能读的原因。
///
/// Windows 上最常见的失败是被占用（DSH 正在跑、编辑器开着某个文件），
/// 直接抛 `Raw OS error 32` 用户看不懂，所以给一句人话再附上原文。
fn describe_io_error(err: &std::io::Error) -> String {
    let text = err.to_string();
    if text.contains("being used by another process") || text.contains("(os error 32)") {
        return format!("文件被占用（可能 DSH 正在运行）：{text}");
    }
    if text.contains("Access is denied") || text.contains("(os error 5)") {
        return format!("没有权限删除：{text}");
    }
    if err.kind() == std::io::ErrorKind::NotFound {
        return "目录已经不存在（可能刚被别处清掉）".to_string();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_io_error_explains_the_common_windows_failures() {
        let busy = std::io::Error::other("The process cannot access the file because it is being used by another process. (os error 32)");
        assert!(describe_io_error(&busy).contains("文件被占用"));
        let denied = std::io::Error::other("Access is denied. (os error 5)");
        assert!(describe_io_error(&denied).contains("没有权限"));
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(describe_io_error(&missing).contains("已经不存在"));
        let other = std::io::Error::other("磁盘错误");
        assert_eq!(describe_io_error(&other), "磁盘错误");
    }

    #[test]
    fn npm_command_asks_config_get_cache() {
        let command = npm_command();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        let joined = args.join(" ");
        assert!(joined.contains("config get cache"), "{joined}");
    }

    // ---- 用临时目录跑整条链路（扫 → 清 → 再扫） ----

    use dsharbor_core::launch::{Channel, LaunchMode, Runtime};

    fn temp_root(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("dsharbor-npxcache-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("_npx")).unwrap();
        root
    }

    /// 在 `_npx` 下造一份缓存目录（`packages` 写进 `_npx.packages`，`size` 字节的填充文件）。
    fn make_dir(root: &Path, name: &str, packages: &[&str], deps: &[&str], size: usize) {
        let dir = root.join("_npx").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = serde_json::json!({
            "dependencies": deps
                .iter()
                .map(|name| (name.to_string(), serde_json::json!("^1.0.0")))
                .collect::<serde_json::Map<String, serde_json::Value>>(),
            "_npx": { "packages": packages },
        });
        std::fs::write(dir.join("package.json"), manifest.to_string()).unwrap();
        if size > 0 {
            std::fs::write(dir.join("blob.bin"), vec![0_u8; size]).unwrap();
        }
    }

    fn npx_latest() -> LaunchConfig {
        LaunchConfig {
            mode: LaunchMode::Npx {
                channel: Channel::Latest,
                version: None,
            },
            runtime: Runtime::Default,
            extra_args: Vec::new(),
            port: None,
        }
    }

    #[test]
    fn scan_counts_only_our_package_and_cleanup_keeps_the_current_one() {
        let root = temp_root("scan");
        // 稳定版那一份是当前配置对应的：即使 mtime 最旧也必须保住。
        make_dir(
            &root,
            "aaa-stable",
            &["@deepseek-ai/dsh"],
            &["@deepseek-ai/dsh"],
            100,
        );
        make_dir(
            &root,
            "mmm-rc",
            &["@deepseek-ai/dsh@0.2.1-rc.2"],
            &["@deepseek-ai/dsh"],
            300,
        );
        // 最新用过的这一份（最后创建）：名字排得靠前，这样即使连续建目录跨了秒边界，
        // 「最旧的」仍是 mmm-rc，结果不靠运气。
        make_dir(
            &root,
            "bbb-next",
            &["@deepseek-ai/dsh@next"],
            &["@deepseek-ai/dsh"],
            200,
        );
        // 别的包的缓存：不计入、也不能被删。
        make_dir(&root, "other-tool", &["skills@latest"], &["skills"], 400);
        // 同 scope 的另一个包：不是本包。
        make_dir(
            &root,
            "sibling",
            &["@deepseek-ai/cli"],
            &["@deepseek-ai/cli"],
            50,
        );

        let state = scan_at(Some(&root), "npm", None, &npx_latest());
        assert!(state.supported);
        assert_eq!(state.own_count, 3, "只算本包的三份：{:#?}", state.dirs);
        // 占用 = 三份本包目录的文件字节之和（含各自的 package.json），别的包一份不算。
        let expected: u64 = ["aaa-stable", "mmm-rc", "bbb-next"]
            .iter()
            .map(|name| dir_bytes(&root.join("_npx").join(name)))
            .sum();
        assert_eq!(state.own_bytes, expected);
        assert_eq!(state.dirs.len(), 3);
        assert!(state.dirs.iter().all(|dir| !dir.name.contains("other")));
        assert!(state.dirs.iter().all(|dir| !dir.name.contains("sibling")));
        // 当前配置那份被认出来了，并且标成了保留（保留的排在可回收的前面）。
        assert_eq!(state.current.as_deref(), Some("aaa-stable"));
        assert!(
            state
                .dirs
                .iter()
                .any(|dir| dir.name == "aaa-stable" && dir.keep && dir.current),
            "{:#?}",
            state.dirs
        );
        assert!(state.dirs[0].keep, "{:#?}", state.dirs);
        // 保留 2 份，所以只有 1 份可回收。
        assert_eq!(state.removable_count, 1, "{:#?}", state.dirs);
        assert!(state.message.contains("可回收"), "{}", state.message);

        let result = cleanup_at(&root, "npm", None, &npx_latest());
        assert_eq!(result.removed.len(), 1, "{:#?}", result.failed);
        assert!(result.failed.is_empty(), "{:#?}", result.failed);
        // 被删掉的是既不是当前那份、也不是最新那份的那一份。
        assert!(result.removed[0].label.contains("0.2.1-rc.2"));
        let kept = dir_bytes(&root.join("_npx").join("aaa-stable"))
            + dir_bytes(&root.join("_npx").join("bbb-next"));
        assert_eq!(result.freed_bytes, expected - kept);
        assert!(!root.join("_npx").join("mmm-rc").exists());
        // 当前那份与另一份保留着。
        assert!(root.join("_npx").join("aaa-stable").exists());
        assert!(root.join("_npx").join("bbb-next").exists());
        // 别的包一份不少。
        assert!(root.join("_npx").join("other-tool").exists());
        assert!(root.join("_npx").join("sibling").exists());
        // 刷新后的数字：本包只剩两份、没有可回收的了。
        assert_eq!(result.state.own_count, 2);
        assert_eq!(result.state.reclaimable_bytes, 0);
        assert!(
            result.message.contains("已清掉 1 个目录"),
            "{}",
            result.message
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_dir_without_a_readable_manifest_is_neither_counted_nor_deleted() {
        let root = temp_root("broken");
        make_dir(
            &root,
            "ours",
            &["@deepseek-ai/dsh"],
            &["@deepseek-ai/dsh"],
            10,
        );
        // 没写 package.json 的半成品目录（npx 正在跑的时候常见）。
        std::fs::create_dir_all(root.join("_npx").join("half-baked")).unwrap();
        std::fs::write(
            root.join("_npx").join("half-baked").join("x.bin"),
            vec![0_u8; 999],
        )
        .unwrap();
        // 写坏的 JSON。
        let broken = root.join("_npx").join("broken-json");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("package.json"), "{ not json").unwrap();

        let state = scan_at(Some(&root), "npm", None, &npx_latest());
        assert_eq!(state.own_count, 1, "{:#?}", state.dirs);
        assert!(state.own_bytes < 999, "{}", state.own_bytes);
        let result = cleanup_at(&root, "npm", None, &npx_latest());
        // 保留份数还没满，所以什么都不删；两个无法判定的目录也原样留着。
        assert!(result.removed.is_empty(), "{:#?}", result.removed);
        assert!(root.join("_npx").join("half-baked").exists());
        assert!(root.join("_npx").join("broken-json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dir_bytes_skips_links_and_sums_files() {
        let root = std::env::temp_dir().join(format!("dsharbor-size-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("inner")).unwrap();
        std::fs::write(root.join("a.bin"), vec![7_u8; 100]).unwrap();
        std::fs::write(root.join("inner/b.bin"), vec![7_u8; 24]).unwrap();
        assert_eq!(dir_bytes(&root), 124);
        // 不存在的路径算 0，不 panic。
        assert_eq!(dir_bytes(&root.join("nope")), 0);
        let _ = std::fs::remove_dir_all(&root);
    }
}
