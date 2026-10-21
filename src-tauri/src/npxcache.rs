//! npx 缓存的外壳侧：找缓存根、量目录大小、删目录。
//!
//! 归属判定、保留集合、可回收量、界面文案全是纯计算，在核心库的
//! `dsharbor_core::npx_cache` 里并有单元测试；这里只做三件与操作系统打交道的事：
//! 问 npm 缓存根在哪、递归 stat 目录、`remove_dir_all`。
//!
//! 为什么缓存根要问 npm 而不是写死 `%LOCALAPPDATA%\npm-cache`：用户可能用 `npm config
//! set cache` 或 `.npmrc` 改过（换到大盘、放进项目目录）。写死会让「占用」显示 0 而实际
//! 有一堆目录没管，也会把清理按钮做成假的。问不到时才退回平台默认位置，并在界面上说明。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, UNIX_EPOCH};

use dsharbor_core::launch::{self, LaunchConfig, Runtime};
use dsharbor_core::npx_cache;
use serde::Serialize;

use crate::launcher::{apply_no_window, spawn_line_reader};

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

/// npx 缓存里已经缓存过的本包版本号（界面的「已缓存」徽章）。
///
/// 为什么要有这个：选版本下拉列的是 npm 上的全部版本，但哪些版本不用等下载
/// 只有本地知道——`_npx/<hash>` 目录就是 npx 按 spec 下载下来的那份依赖。
///
/// 只在 Windows 宿主上扫：非 Windows 宿主上 npx 缓存盘面本来就不支持
/// （同 `scan`），这里返回空列表而不是报错——「一个都没缓存」是能算出来的
/// 诚实答案，界面也不必为此分平台。
pub fn cached_versions(runtime: &Runtime) -> Result<Vec<String>, String> {
    if !cfg!(windows) {
        return Ok(Vec::new());
    }
    let entries = match runtime {
        Runtime::Default => host_entries()?,
        Runtime::Wsl { distro } => wsl_entries(distro)?,
    };
    Ok(npx_cache::cached_versions(entries.iter().map(
        |(resolved, specs)| (resolved.as_deref(), specs.as_slice()),
    )))
}

/// 一份 `_npx` 目录读出来的 `(解析到的版本, manifest 里的 spec 列表)`。
type CacheEntry = (Option<String>, Vec<String>);

/// 宿主 npm 缓存里每份 `_npx` 目录的 `(解析到的版本, manifest 里的 spec 列表)`。
///
/// 顺序固定：先读 `node_modules/@deepseek-ai/dsh/package.json` 的 version（真实解析到
/// 的那一版），读不到才退回目录 manifest 的 `_npx.packages` 后缀。反过来的话，
/// 老目录 manifest 里记着的 spec（比如装完后又被换过版本）会盖掉真正在盘上的版本。
fn host_entries() -> Result<Vec<CacheEntry>, String> {
    let resolution = resolve_root();
    let root = resolution.root.ok_or_else(|| {
        format!(
            "找不到 npm 缓存目录：{}",
            resolution
                .warning
                .unwrap_or_else(|| "npm 没有给出缓存位置".to_string())
        )
    })?;
    let npx_dir = root.join(npx_cache::NPX_DIR_NAME);
    if !npx_dir.is_dir() {
        // 还没跑过 npx：这就是「一个版本都没缓存」，不是错误。
        return Ok(Vec::new());
    }
    let mut entries: Vec<(Option<String>, Vec<String>)> = Vec::new();
    let listing = std::fs::read_dir(&npx_dir)
        .map_err(|err| format!("读取 npx 缓存目录失败（{}）：{err}", npx_dir.display()))?;
    for item in listing.flatten() {
        let path = item.path();
        // 与扫缓存占用同一套口径：只认真目录，符号链接 / junction 跳过。
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        entries.push(entry_of(&path));
    }
    Ok(entries)
}

/// 一份缓存目录的两个版本来源（都读不到就是 `(None, 空)`，由核心库判为「不是我们的」）。
fn entry_of(dir: &Path) -> (Option<String>, Vec<String>) {
    let resolved = read_version_file(
        &dir.join("node_modules")
            .join(launch::NPX_PACKAGE)
            .join("package.json"),
    );
    let specs = read_manifest(&dir.join("package.json")).packages;
    (resolved, specs)
}

/// 读某个包的 `package.json` 取 `version` 字段；读不到 / 写坏都返回 None。
fn read_version_file(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

/// 在发行版内部扫同一套东西：`bash -s` 从 stdin 读脚本，输出一段 JSON。
///
/// 为什么不照 `registry::build_command` 那样把整条命令塞进单个 argv：那个脚本只有
/// `npm view …` 这一行固定字面量，而这支脚本要嵌进缓存根与包名——wsl.exe 会吃掉
/// argv 里的引号，再在外面裹一层引号就是注入面。改成把脚本写进子进程的 stdin
/// （`bash -s`），argv 里只剩 `bash -s` 两个固定字面量，含空格和引号的路径也安全。
fn wsl_entries(distro: &str) -> Result<Vec<CacheEntry>, String> {
    let mut command = Command::new("wsl.exe");
    command.args(["-d", distro, "--"]);
    // PATH 用发行版里的干净 PATH：Windows 的 PATH 混进去会让 node 找不到依赖。
    match crate::wsl::clean_path(distro) {
        Ok(path) => {
            command.arg("env");
            command.arg(format!("PATH={path}"));
        }
        Err(err) => eprintln!("[dsharbor] 读取 WSL PATH 失败，直接执行：{err}"),
    }
    command.args(["bash", "-s"]);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("在 WSL 发行版 {distro} 里执行失败：{err}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(wsl_script().as_bytes())
            .map_err(|err| format!("把扫描脚本送进 WSL 发行版 {distro} 失败：{err}"))?;
    }
    // 关掉 stdin：`bash -s` 读到 EOF 才会结束。
    drop(child.stdin.take());

    let buffer = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let push = {
        let buffer = buffer.clone();
        move |line: String| {
            if let Ok(mut guard) = buffer.lock() {
                guard.push_str(&line);
                guard.push('\n');
            }
        }
    };
    if let Some(stdout) = child.stdout.take() {
        spawn_line_reader(stdout, push.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_line_reader(stderr, push);
    }
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() > NPM_TIMEOUT {
                    let _ = child.kill();
                    return Err(format!(
                        "在 WSL 发行版 {distro} 里读取 npx 缓存超时（{} 秒未结束）",
                        NPM_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(err) => return Err(format!("等待 WSL 命令结束失败：{err}")),
        }
    };
    // 输出线程还在处理管道里最后几行，稍等片刻再取结果。
    std::thread::sleep(Duration::from_millis(150));
    let text = buffer.lock().map(|guard| guard.clone()).unwrap_or_default();
    if !status.success() {
        return Err(format!(
            "在 WSL 发行版 {distro} 里读取 npx 缓存失败（退出码 {}）：{}",
            status.code().unwrap_or(-1),
            text.trim()
        ));
    }
    parse_wsl_entries(&text)
}

/// 解析 WSL 侧脚本吐出的 JSON（`{"specs":[…],"resolved":[…]}`，两个数组按下标对应）。
fn parse_wsl_entries(text: &str) -> Result<Vec<CacheEntry>, String> {
    // 发行版里的登录脚本可能先吐 MOTD，所以整段里找第一个 `{` 起的 JSON。
    let start = text.find('{').ok_or_else(|| {
        format!(
            "WSL 里没有返回缓存清单（输出：{}）",
            text.trim().chars().take(200).collect::<String>()
        )
    })?;
    let value: serde_json::Value = serde_json::from_str(text[start..].trim()).map_err(|err| {
        format!(
            "WSL 返回的缓存清单不是合法 JSON（{err}）：{}",
            text.trim().chars().take(200).collect::<String>()
        )
    })?;
    let strings = |key: &str| -> Vec<String> {
        value
            .get(key)
            .and_then(|item| item.as_array())
            .map(|items| {
                items
                    .iter()
                    .map(|item| item.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default()
    };
    let specs = strings("specs");
    let resolved = strings("resolved");
    // 两个数组按下标对应：脚本对每个目录都写一项（读不到就是空串），
    // 所以长度对不上说明输出被截断了，这时宁可不报「已缓存」也别错位。
    if specs.len() != resolved.len() {
        return Err(format!(
            "WSL 返回的缓存清单不完整（spec {} 条 / 解析结果 {} 条）",
            specs.len(),
            resolved.len()
        ));
    }
    Ok(specs
        .into_iter()
        .zip(resolved)
        .map(|(spec, resolved)| {
            let resolved = if resolved.is_empty() {
                None
            } else {
                Some(resolved)
            };
            let specs = if spec.is_empty() {
                Vec::new()
            } else {
                vec![spec]
            };
            (resolved, specs)
        })
        .collect())
}

/// 在发行版里扫 `_npx` 的脚本：打印 `{specs, resolved}`。
///
/// 为什么用 node 而不是用 shell 拼 grep/sed：`package.json` 是 JSON，用 shell
/// 正则去抠字段会在转义上出错；node 本来就在 npm 的环境里，一定可用。
/// 脚本里单引号只出现在 `'utf8'`、`'./'` 这类固定字面量上，拼进 Rust 的字符串
/// 不含任何插值，路径与包名都写死在字面量里。
///
/// 占位符用 `replace` 而不是 `format!`：下面这段 JS 里遍布 `{` `}`，逐个写成
/// `{{` `}}` 既难读又容易漏（漏一个要么编译不过，要么被 `format!` 当插值吃掉）。
fn wsl_script() -> String {
    const TEMPLATE: &str = r#"ROOT="$(npm config get cache 2>/dev/null)"
if [ -z "$ROOT" ]; then echo "npm 没有输出缓存路径" >&2; exit 3; fi
if [ ! -d "$ROOT/__NPX_DIR__" ]; then printf '{"specs":[],"resolved":[]}'; exit 0; fi
cd "$ROOT/__NPX_DIR__" || exit 4
exec node -e '
const fs = require("fs");
const path = require("path");
const specs = [];
const resolved = [];
for (const name of fs.readdirSync(".")) {
  let stat;
  try { stat = fs.lstatSync(name); } catch (err) { continue; }
  if (!stat.isDirectory()) continue;
  const manifest = path.join(name, "package.json");
  let entries = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (parsed && parsed._npx && Array.isArray(parsed._npx.packages)) entries = parsed._npx.packages;
  } catch (err) { entries = []; }
  let version = "";
  try {
    version = JSON.parse(fs.readFileSync(path.join(name, "node_modules", "__PACKAGE__", "package.json"), "utf8")).version || "";
  } catch (err) { version = ""; }
  for (const entry of entries) {
    specs.push(typeof entry === "string" ? entry : "");
    resolved.push(version);
  }
}
process.stdout.write(JSON.stringify({ specs, resolved }));
'
"#;
    TEMPLATE
        .replace("__NPX_DIR__", npx_cache::NPX_DIR_NAME)
        .replace("__PACKAGE__", launch::NPX_PACKAGE)
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

    use dsharbor_core::launch::{LaunchMode, Runtime};

    fn temp_root(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("dsharbor-npxcache-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("_npx")).unwrap();
        root
    }

    /// 在 `_npx` 下造一条「缓存过的本包版本」：目录 manifest 记 spec，
    /// `resolved` 有值时再写一份 `node_modules/@deepseek-ai/dsh/package.json`。
    fn make_cached(root: &Path, name: &str, spec: &str, resolved: Option<&str>) {
        let dir = root.join("_npx").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            serde_json::json!({ "_npx": { "packages": [spec] } }).to_string(),
        )
        .unwrap();
        if let Some(version) = resolved {
            let package = dir.join("node_modules").join("@deepseek-ai").join("dsh");
            std::fs::create_dir_all(&package).unwrap();
            std::fs::write(
                package.join("package.json"),
                serde_json::json!({ "name": "@deepseek-ai/dsh", "version": version }).to_string(),
            )
            .unwrap();
        }
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
            mode: LaunchMode::Npx { version: None },
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

    // ---- npx 缓存里已缓存的本包版本（界面「已缓存」徽章） ----

    /// 用临时缓存根跑整条链路。
    ///
    /// 靠 `npm_config_cache` 把 `npm config get cache` 引到临时目录，而不是给
    /// `resolve_root` 开后门：这样被测的还是真实的「问 npm → 扫目录」那条路。
    /// 串行跑：`npm_config_cache` 是进程级环境变量，与别的用例并发会互相看见对方的根。
    #[test]
    #[cfg(windows)]
    fn cached_versions_lists_only_our_own_resolved_versions() {
        let root = temp_root("cached-versions");
        make_cached(&root, "auto-latest", "@deepseek-ai/dsh", Some("0.2.0"));
        make_cached(
            &root,
            "pinned-old",
            "@deepseek-ai/dsh@0.2.1-rc.2",
            Some("0.2.1-rc.2"),
        );
        // spec 与真正解析到的版本不一致：按盘上那份算（0.3.0），不按 spec。
        make_cached(
            &root,
            "resolved-wins",
            "@deepseek-ai/dsh@0.2.1-rc.2",
            Some("0.3.0"),
        );
        // 只有 manifest 没有解析结果：退回 spec 后缀。
        make_cached(&root, "spec-only", "@deepseek-ai/dsh@0.1.9", None);
        // 别人的包、只有 dist-tag 的目录，都不算「本包已缓存」。
        make_cached(&root, "other-package", "lodash@4.17.21", Some("4.17.21"));
        make_cached(&root, "tag-only", "@deepseek-ai/dsh@next", None);
        // 半成品目录（npx 正在跑的时候常见）：不能让它把整条命令搞崩。
        std::fs::create_dir_all(root.join("_npx").join("half-baked")).unwrap();

        let previous = std::env::var("npm_config_cache").ok();
        std::env::set_var("npm_config_cache", &root);
        let versions = cached_versions(&Runtime::Default);
        match previous {
            Some(value) => std::env::set_var("npm_config_cache", value),
            None => std::env::remove_var("npm_config_cache"),
        }

        assert_eq!(
            versions.unwrap(),
            vec!["0.3.0", "0.2.1-rc.2", "0.2.0", "0.1.9"],
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(windows)]
    fn cached_versions_is_empty_when_nothing_was_ever_cached() {
        let root = temp_root("cached-empty");
        // `_npx` 在但没有本包目录：空列表，不是错误。
        make_cached(&root, "other-package", "lodash@4.17.21", None);
        let previous = std::env::var("npm_config_cache").ok();
        std::env::set_var("npm_config_cache", &root);
        let versions = cached_versions(&Runtime::Default);
        match previous {
            Some(value) => std::env::set_var("npm_config_cache", value),
            None => std::env::remove_var("npm_config_cache"),
        }
        assert!(versions.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn wsl_output_is_parsed_into_spec_and_resolved_pairs() {
        let json = r#"{"specs":["@deepseek-ai/dsh@0.2.1-rc.2","@deepseek-ai/dsh"],"resolved":["0.2.1-rc.2",""]}"#;
        let entries = parse_wsl_entries(json).unwrap();
        assert_eq!(
            entries,
            vec![
                (
                    Some("0.2.1-rc.2".to_string()),
                    vec!["@deepseek-ai/dsh@0.2.1-rc.2".to_string()]
                ),
                (None, vec!["@deepseek-ai/dsh".to_string()]),
            ]
        );
        // 登录脚本先吐 MOTD 时，只用第一个 `{` 起的 JSON。
        let noisy = format!("Welcome to Ubuntu\n{json}\n");
        assert_eq!(parse_wsl_entries(&noisy).unwrap(), entries);
    }

    #[test]
    fn broken_wsl_output_says_what_went_wrong_instead_of_reporting_versions() {
        let truncated = r#"{"specs":["@deepseek-ai/dsh@0.2.1-rc.2"],"resolved":[]}"#;
        let err = parse_wsl_entries(truncated).unwrap_err();
        assert!(err.contains("不完整"), "{err}");
        let err = parse_wsl_entries("没有任何 JSON").unwrap_err();
        assert!(err.contains("没有返回缓存清单"), "{err}");
        let err = parse_wsl_entries("{ not json").unwrap_err();
        assert!(err.contains("不是合法 JSON"), "{err}");
    }
}
