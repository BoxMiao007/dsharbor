//! 桥接插件的安装 / 卸载 / 备份与恢复（外壳侧）。
//!
//! 设计（为什么这样做）：
//! - 安装走 DSH 官方命令 `dsh plugin --profile web add file:<tgz>`。官方
//!   plugin-manager 在 pnpm 安装完成后会读取包的 `dsh.bundle` 声明，自动把
//!   包名登记进 profile 的 `dsh.profile.bundles`；`remove` 时自动摘除。
//!   这就是「一键安装 / 一键卸载」的官方语义——壳不手改用户配置文件，
//!   也不碰标注「托管，勿改」的块。
//! - 操作前先把 profile 目录里 pnpm 会改写的文件备份到应用数据目录
//!   （时间戳目录 + 内容哈希清单），失败或想回滚时可整体恢复。
//! - 目标环境跟随当前启动方式：Npx/System/Binary → Windows 宿主文件系统；
//!   Wsl → 经 `wsl.exe -d <distro> --` 在发行版内部读写。插件包（tgz）位于
//!   Windows 磁盘上的应用资源目录，WSL 场景装换为 /mnt/<盘>/… 路径交给发行版。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dsharbor_core::launch::{
    build_plugin_plan, runtime_of, LaunchConfig, LaunchPlan, PluginOp, Runtime,
};
use dsharbor_core::paths::windows_path_to_wsl;
use dsharbor_core::profiles::{self, ProfileListing};
use serde::Serialize;
use tauri::Manager;

use crate::launcher::{apply_no_window, command_for_plan, spawn_line_reader};

/// profile 目录里需要备份的文件（pnpm 会改写前三个；patch 文件一并存证）。
const BACKUP_FILES: [&str; 4] = [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "cordis.patch.yml",
];
/// 安装/卸载/更新命令的超时（首次可能触发 pnpm 解析依赖，给足时间）。
pub(crate) const PLUGIN_OP_TIMEOUT: Duration = Duration::from_secs(240);
/// 备份保留份数上限（维护者要求 5 份）：超出后自动删掉最旧的，避免无限累积。
const BACKUP_KEEP: usize = 5;

/// 插件操作的目标环境。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// Windows 宿主文件系统。
    Host,
    /// WSL 发行版内部。
    Wsl { distro: String },
}

impl Target {
    pub fn of(config: &LaunchConfig) -> Target {
        // 按「实际生效」的运行环境判断：官方 npx 与自定义命令都能跑在发行版里，
        // 插件要装到 DSH 真正运行的那一侧文件系统；系统全局命令与指定程序路径
        // 恒为 Windows 宿主。所以这里走 `launch::runtime_of`，不直接读
        // `config.runtime`——后者可能残留旧启动方式下的 WSL 值。
        match runtime_of(config) {
            Runtime::Wsl { distro } => Target::Wsl {
                distro: distro.clone(),
            },
            Runtime::Default => Target::Host,
        }
    }

    pub fn label(&self) -> String {
        match self {
            Target::Host => "Windows".to_string(),
            Target::Wsl { distro } => format!("WSL（{distro}）"),
        }
    }
}

/// 安装/卸载的结果（回给界面直接展示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeOutcome {
    pub ok: bool,
    pub message: String,
    /// 本次操作前的备份目录（恢复时的依据）。
    pub backup_dir: String,
}

/// 桥接插件在当前目标环境中的状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeState {
    pub installed: bool,
    pub target: String,
    pub profile_dir: String,
    pub detail: String,
    pub latest_backup: Option<String>,
}

// ---------------------------------------------------------------------------
// 目标环境访问（宿主直连 / WSL 内经 wsl.exe）
// ---------------------------------------------------------------------------

/// DSH 主目录（宿主直连时用）。「关于」面板要打开它的 logs 子目录，所以对外可见。
pub(crate) fn host_dsh_home() -> Result<String, String> {
    if let Ok(custom) = std::env::var("DSH_HOME") {
        if !custom.trim().is_empty() {
            return Ok(custom);
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "找不到用户主目录（USERPROFILE / HOME 都未设置）".to_string())?;
    let sep = if cfg!(windows) { '\\' } else { '/' };
    Ok(format!("{home}{sep}.dsh"))
}

/// WSL 发行版里的 DSH 主目录（尊重发行版内部的 DSH_HOME）。
fn wsl_dsh_home(distro: &str) -> Result<String, String> {
    let out = wsl_run(
        distro,
        "printf %s \"${DSH_HOME:-$HOME/.dsh}\"",
        Duration::from_secs(30),
    )?;
    let home = out.trim();
    if home.is_empty() {
        return Err(format!("无法在 WSL 发行版 {distro} 中确定 DSH 主目录"));
    }
    Ok(home.to_string())
}

/// 目标环境下某个 profile 的目录（`<DSH 主目录>/profiles/<名字>`）。
///
/// 名字既拼路径又进命令行，所以先过一遍合法性：非法名字直接报错，
/// 不静默退回默认环境——静默退回会让用户以为切了其实没切。
pub fn profile_dir(target: &Target, profile: &str) -> Result<String, String> {
    profiles::validate_name(profile)?;
    match target {
        Target::Host => {
            let home = host_dsh_home()?;
            let sep = if cfg!(windows) { '\\' } else { '/' };
            Ok(format!("{home}{sep}profiles{sep}{profile}"))
        }
        Target::Wsl { distro } => Ok(format!("{}/profiles/{profile}", wsl_dsh_home(distro)?)),
    }
}

/// 目标环境下 DSH 已有的全部 profile（含不能列进下拉的，由核心库标记）。
///
/// 读盘/枚举留在这一层，只把内容拼成 `名字<TAB>package.json` 的文本交给
/// 核心库的 `profiles::parse_listing` 判定——「哪个环境能列出来」不在这里重复一遍。
///
/// 非 Windows 宿主直接回一个带 `supported: false` 的空清单：`~/.dsh/profiles`
/// 这套布局与枚举方式只对 Windows 宿主成立，在不支持的平台上装作「读到 0 个环境」
/// 会让人以为是环境全丢了。
pub fn list_profiles(config: &LaunchConfig) -> Result<ProfileListing, String> {
    if !cfg!(windows) {
        return Ok(ProfileListing::unsupported());
    }
    let target = Target::of(config);
    let profiles = profiles::parse_listing(&read_listing(&target)?);
    Ok(ProfileListing::new(true, profiles))
}

/// 读「名字<TAB>单行 package.json」清单（宿主直连与 WSL 各一条路径）。
///
/// 缺 `package.json` 的目录跳过：那不是 DSH 初始化好的环境，壳也不会去碰它。
fn read_listing(target: &Target) -> Result<String, String> {
    match target {
        Target::Host => {
            let home = host_dsh_home()?;
            let sep = if cfg!(windows) { '\\' } else { '/' };
            let root = format!("{home}{sep}profiles");
            let entries = match std::fs::read_dir(&root) {
                Ok(entries) => entries,
                // 还没建过任何环境：空列表，不是错误。
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
                Err(err) => return Err(format!("读取环境目录 {root} 失败：{err}")),
            };
            let mut listing = String::new();
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                let Ok(package_json) = std::fs::read_to_string(path.join("package.json")) else {
                    continue;
                };
                // 清单一行一个环境：压成一行的 JSON 才能按行切回来。
                // 中间一列是「依赖装过没」——新建/复制出来的环境没有 node_modules，
                // 界面靠它标「依赖未安装」，不需要为每个环境再跑一趟 IPC。
                let deps = if path.join("node_modules").is_dir() {
                    "1"
                } else {
                    "0"
                };
                let one_line = package_json.replace(['\n', '\r'], " ");
                listing.push_str(&format!("{name}\t{deps}\t{one_line}\n"));
            }
            Ok(listing)
        }
        Target::Wsl { distro } => {
            let home = wsl_dsh_home(distro)?;
            // 逐目录拼 `名字<TAB>依赖标记<TAB>内容`；用 bash 的 glob 而不是 find，
            // 避免为不存在的目录报错。
            let script = format!(
                "for d in '{home}'/profiles/*/; do \
                 [ -d \"$d\" ] || continue; \
                 p=\"$d/package.json\"; \
                 [ -f \"$p\" ] || continue; \
                 deps=0; [ -d \"$d/node_modules\" ] && deps=1; \
                 printf '%s\\t%s\\t%s\\n' \"$(basename \"$d\")\" \"$deps\" \"$(tr '\\n' ' ' < \"$p\")\"; \
                 done"
            );
            wsl_run(distro, &script, Duration::from_secs(30))
        }
    }
}

pub(crate) fn join_path(target: &Target, dir: &str, name: &str) -> String {
    match target {
        Target::Host => PathBuf::from(dir).join(name).to_string_lossy().to_string(),
        Target::Wsl { .. } => format!("{dir}/{name}"),
    }
}

/// 在 WSL 发行版里跑一条 bash 脚本并返回 stdout+stderr。
pub(crate) fn wsl_script(distro: &str, script: &str, timeout: Duration) -> Result<String, String> {
    wsl_run(distro, script, timeout)
}

fn wsl_run(distro: &str, script: &str, timeout: Duration) -> Result<String, String> {
    let mut command = Command::new("wsl.exe");
    command.args(["-d", distro, "--", "bash", "-lc", script]);
    let (code, output) = run_capture(command, timeout)?;
    if code != 0 {
        return Err(format!(
            "WSL（{distro}）命令失败（退出码 {code}）：{}",
            tail_chars(&output, 600)
        ));
    }
    Ok(output)
}

/// 读文件（跨目标环境）。
pub(crate) fn read_file(target: &Target, path: &str) -> Result<String, String> {
    match target {
        Target::Host => {
            std::fs::read_to_string(path).map_err(|err| format!("读取 {path} 失败：{err}"))
        }
        Target::Wsl { distro } => {
            wsl_run(distro, &format!("cat -- '{path}'"), Duration::from_secs(30))
        }
    }
}

/// 写文件（跨目标环境；WSL 经 stdin 送内容，避免命令行长度与转义问题）。
///
/// 两侧都是「原子替换」：先写临时文件，成功了再改名盖住目标。直接覆盖的话，
/// 写到一半被中断（壳被强杀、断电、磁盘满）就把用户的 `package.json` /
/// `cordis.patch.yml` 留成空文件或半截，那是一个再也起不来的 DSH 环境。
pub(crate) fn write_file(target: &Target, path: &str, content: &str) -> Result<(), String> {
    match target {
        Target::Host => crate::atomic::write_host(Path::new(path), content.as_bytes())
            .map_err(|err| format!("写入 {path} 失败：{err}")),
        Target::Wsl { distro } => {
            use std::io::Write;
            let mut command = Command::new("wsl.exe");
            command.args(["-d", distro, "--", "bash", "-lc"]);
            command.arg(crate::atomic::wsl_script(path));
            let mut child = command
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|err| format!("启动 WSL 写入命令失败：{err}"))?;
            if let Some(stdin) = child.stdin.as_mut() {
                stdin
                    .write_all(content.as_bytes())
                    .map_err(|err| format!("写入 WSL 文件失败：{err}"))?;
            }
            drop(child.stdin.take());
            let status = child
                .wait()
                .map_err(|err| format!("等待 WSL 写入结束失败：{err}"))?;
            if !status.success() {
                return Err(format!("WSL 写入 {path} 失败（{status}）"));
            }
            Ok(())
        }
    }
}

/// 运行一条一次性命令：限时等待，收集解码后的输出（stdout+stderr 合并）。
pub(crate) fn run_capture(
    mut command: Command,
    timeout: Duration,
) -> Result<(i32, String), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("执行命令失败：{err}"))?;
    let buffer = Arc::new(Mutex::new(String::new()));
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
        let push = push.clone();
        spawn_line_reader(stdout, push);
    }
    if let Some(stderr) = child.stderr.take() {
        let push = push.clone();
        spawn_line_reader(stderr, push);
    }
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(format!("命令超时（{} 秒未结束）", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(err) => return Err(format!("等待命令结束失败：{err}")),
        }
    };
    // 输出线程还在处理管道里最后几行，稍等片刻再取结果。
    std::thread::sleep(Duration::from_millis(150));
    let text = buffer.lock().map(|guard| guard.clone()).unwrap_or_default();
    Ok((status.code().unwrap_or(-1), text.trim_end().to_string()))
}

pub(crate) fn tail_chars(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        text.to_string()
    } else {
        text.chars().skip(count - max).collect()
    }
}

// ---------------------------------------------------------------------------
// 安装 / 卸载 / 备份 / 恢复
// ---------------------------------------------------------------------------

/// 去掉 Windows 扩展长度前缀（`\\?\`）。
/// Tauri 的 resource_dir 在 Windows 上可能返回带 `\\?\` 前缀的路径，
/// 而 pnpm/npm 读本地 tarball 不接受它（实机症状：os error 123
/// 「文件名、目录名或卷标语法不正确」）。`\\?\UNC\` 还原成 `\\` 形式。
pub(crate) fn strip_extended_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// 在应用资源目录里找桥接插件包（`dsharbor-bridge-*.tgz`）。
fn find_bridge_tgz(app: &tauri::AppHandle) -> Result<String, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|err| format!("找不到应用资源目录：{err}"))?;
    let candidates = [resource_dir.clone(), resource_dir.join("resources")];
    for dir in &candidates {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("dsharbor-bridge-") && name.ends_with(".tgz") {
                return Ok(strip_extended_prefix(&entry.path().to_string_lossy()));
            }
        }
    }
    Err("找不到桥接插件包（dsharbor-bridge-*.tgz）。\
         请确认安装包完整，或在源码仓库先执行 pnpm pack:bridge。"
        .to_string())
}

/// 备份目录（`app_data_root/backups`）：安装/卸载前的回滚备份都放这里，
/// 也是界面「打开备份目录」按钮的目标目录（见 `open_shell_dir`）。
pub(crate) fn backups_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::app_data_root(app)?.join("backups"))
}

/// 备份目录名列表，按名字升序（目录名是 `backup-<unix 秒>`，字典序即时间序）。
fn backup_dir_names(root: &std::path::Path) -> std::io::Result<Vec<String>> {
    let mut names: Vec<String> = std::fs::read_dir(root)?
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    Ok(names)
}

/// 按上限清理最旧的备份，返回被删掉的备份名。
/// 清理失败只记日志：备份本身已经写成，不该因为删不掉旧目录让安装/卸载失败。
fn prune_backups(app: &tauri::AppHandle) -> Vec<String> {
    let Ok(root) = backups_root(app) else {
        return Vec::new();
    };
    let Ok(names) = backup_dir_names(&root) else {
        return Vec::new();
    };
    if names.len() <= BACKUP_KEEP {
        return Vec::new();
    }
    let mut removed = Vec::new();
    for name in &names[..names.len() - BACKUP_KEEP] {
        let path = root.join(name);
        match std::fs::remove_dir_all(&path) {
            Ok(()) => removed.push(name.clone()),
            Err(err) => eprintln!("清理旧备份失败（{}）：{err}", path.display()),
        }
    }
    removed
}

/// 一次备份的结果：新备份目录 + 因超出上限被清理掉的旧备份名。
pub(crate) struct BackupResult {
    pub dir: String,
    pub pruned: Vec<String>,
}

/// 备份 profile 目录里会被 pnpm 改写的文件（含内容哈希清单），返回备份结果。
pub(crate) fn backup_profile(
    app: &tauri::AppHandle,
    target: &Target,
    profile: &str,
) -> Result<BackupResult, String> {
    let dir = profile_dir(target, profile)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup_dir = backups_root(app)?.join(format!("backup-{stamp}"));
    std::fs::create_dir_all(&backup_dir).map_err(|err| format!("创建备份目录失败：{err}"))?;

    let mut manifest = String::new();
    for name in BACKUP_FILES {
        let source = join_path(target, &dir, name);
        match read_file(target, &source) {
            Ok(content) => {
                std::fs::write(backup_dir.join(name), &content)
                    .map_err(|err| format!("写入备份失败：{err}"))?;
                manifest.push_str(&format!(
                    "{name}\t已备份\t{}\n",
                    dsharbor_core::fnv1a64_hex(content.as_bytes())
                ));
            }
            Err(_) => manifest.push_str(&format!("{name}\t不存在\n")),
        }
    }
    std::fs::write(backup_dir.join("manifest.txt"), &manifest)
        .map_err(|err| format!("写入备份清单失败：{err}"))?;
    let pruned = prune_backups(app);
    Ok(BackupResult {
        dir: backup_dir.to_string_lossy().to_string(),
        pruned,
    })
}

/// 按上限清理旧备份的说明（拼进安装/卸载/更新输出；没清理就为空）。
pub(crate) fn prune_note(pruned: &[String]) -> String {
    if pruned.is_empty() {
        return String::new();
    }
    format!(
        "\n旧备份清理：删除了 {} 份（只保留最近 {BACKUP_KEEP} 份）：{}",
        pruned.len(),
        pruned.join("、")
    )
}

fn latest_backup(app: &tauri::AppHandle) -> Option<String> {
    let root = backups_root(app).ok()?;
    let names = backup_dir_names(&root).ok()?;
    names
        .last()
        .map(|name| root.join(name).to_string_lossy().to_string())
}

/// 读 profile 的 package.json，检查 dsharbor-bridge 是否登记进了 bundles。
fn is_installed(target: &Target, profile: &str) -> Result<bool, String> {
    let package_json = read_file(target, &join_path(target, profile, "package.json"))?;
    let value: serde_json::Value = serde_json::from_str(&package_json)
        .map_err(|err| format!("profile 的 package.json 不是合法 JSON：{err}"))?;
    let in_bundles = value
        .get("dsh")
        .and_then(|dsh| dsh.get("profile"))
        .and_then(|profile| profile.get("bundles"))
        .and_then(|bundles| bundles.as_array())
        .map(|bundles| {
            bundles
                .iter()
                .any(|item| item.as_str() == Some(profiles::BRIDGE_PLUGIN))
        })
        .unwrap_or(false);
    Ok(in_bundles)
}

// ---------------------------------------------------------------------------
// 保留名环境的 CLI 别名（desktop）
// ---------------------------------------------------------------------------

/// 确保保留名环境（`desktop`）的别名目录存在。
///
/// `dsh` 在参数解析阶段就拒掉 `plugin --profile desktop`（"managed exclusively by
/// the Electron application"），而它只按名字找环境、没有「传目录」的入口。绕法是
/// 在同一个 `profiles/` 下给它一条指向真实目录的链接，命令改走那个名字（名字由
/// `dsharbor_core::profiles::cli_profile_name` 决定）。链接用 Windows 的 junction：
/// 目录符号链接要管理员或开发者模式，junction 普通用户就能建，`dsh` 读起来一样。
///
/// 非保留名直接放行——绝大多数操作走这里，不碰磁盘。
fn ensure_cli_alias(target: &Target, profile: &str) -> Result<(), String> {
    if !profiles::is_reserved(profile) {
        return Ok(());
    }
    match target {
        Target::Host => {
            let root = PathBuf::from(host_dsh_home()?).join("profiles");
            ensure_alias_at(&root, profile)
        }
        // WSL 里没有官方桌面端，`desktop` 只可能是手建的目录：那里不建链接，
        // 免得 CLI 真的在发行版里就地初始化出一份同名的空环境。
        Target::Wsl { distro } => Err(format!(
            "WSL（{distro}）里的 {profile} 环境不能从壳里管理插件：\
             官方 CLI 只允许桌面端自己管它"
        )),
    }
}

/// 在 `root` 下确保 `<root>/<别名>` 指向 `<root>/<profile>`。
///
/// 幂等：已经是正确链接就直接返回；那里有别的实体（真目录、指向别处的链接）就
/// 报错而不去动它——那是用户的东西，壳只建自己该建的那一条。
fn ensure_alias_at(root: &Path, profile: &str) -> Result<(), String> {
    let real = root.join(profile);
    if !real.join("package.json").is_file() {
        return Err(format!(
            "{} 环境还没初始化（{} 里没有 package.json）：先在官方桌面端里启动它一次，再回来管插件",
            profile,
            real.display()
        ));
    }
    let alias = root.join(profiles::alias_profile_name(profile));
    if std::fs::symlink_metadata(&alias).is_err() {
        return create_alias_link(&alias, &real);
    }
    // 已经在了：比对真实路径，确认指向的就是这份环境。
    let want = std::fs::canonicalize(&real)
        .map_err(|err| format!("解析 {} 失败：{err}", real.display()))?;
    match std::fs::canonicalize(&alias) {
        Ok(got) if got == want => Ok(()),
        _ => Err(format!(
            "别名目录 {} 已存在，但不是指向 {} 的链接；先手动处理掉它再重试",
            alias.display(),
            real.display()
        )),
    }
}

/// 建一条指向真实环境目录的链接（Windows 用 mklink 建 junction）。
#[cfg(windows)]
fn create_alias_link(alias: &Path, real: &Path) -> Result<(), String> {
    // std 没有建 junction 的 API（`symlink_dir` 是符号链接、要提权），mklink 是
    // cmd 的内建命令。参数逐个交给 argv，不要自己拼成一整串：Rust 拼命令行时会把
    // 内含的引号转义成 `\"`，cmd 不认这种写法，会把路径读成非法字符而报
    // 「文件名、目录名或卷标语法不正确」。
    let mut command = Command::new("cmd");
    command
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(alias)
        .arg(real);
    let (code, output) = run_capture(command, Duration::from_secs(30))
        .map_err(|err| format!("建别名目录 {} 失败：{err}", alias.display()))?;
    if code != 0 || std::fs::symlink_metadata(alias).is_err() {
        return Err(format!(
            "建别名目录 {} 失败（mklink 退出码 {code}）：{}",
            alias.display(),
            tail_chars(&output, 600)
        ));
    }
    Ok(())
}

/// 建一条指向真实环境目录的符号链接（非 Windows 平台）。
#[cfg(not(windows))]
fn create_alias_link(alias: &Path, real: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(real, alias)
        .map_err(|err| format!("建别名目录 {} 失败：{err}", alias.display()))
}

/// 命令回显里该写的环境名：保留名换成实际用的别名，并注明它指向谁，
/// 用户照着这一行原样执行时不会再撞上 CLI 的保留名拒绝。
pub(crate) fn cli_profile_label(profile: &str) -> String {
    let cli = profiles::cli_profile_name(profile);
    if cli == profile {
        profile.to_string()
    } else {
        format!("{cli}（别名 → {profile}）")
    }
}

/// 组装插件安装/卸载命令。
///
/// `env` 是下载源与代理算出的环境变量（`dsharbor_core::net::plan_env` 的产物）：
/// 插件是经 pnpm 从 registry 拉的，装的时候同样要受代理与源影响，
/// 与版本查询、拉起 DSH 走的是同一份计划，不各拼一套。
pub(crate) fn plugin_command(
    config: &LaunchConfig,
    profile: &str,
    op: &PluginOp,
    env: &[(String, String)],
) -> Result<Command, String> {
    // 保留名环境的命令会落到别名目录上，所以别名必须先存在（在真跑命令之前失败，
    // 免得 CLI 拿别名名字在别处初始化出一份空环境）。
    ensure_cli_alias(&Target::of(config), profile)?;
    let spawn = build_plugin_plan(config, profile, op)?;
    Ok(command_for_plan(&LaunchPlan {
        spawn,
        env: env.to_vec(),
    }))
}

/// 与 [`plugin_command`] 同一套计划算出的命令行回显（不执行）。失败回执等
/// 要给用户看「到底跑了什么」的场合用它，避免文案里硬编码 `dsh` 与实际
/// 启动方式（npx / 全局 / 二进制 / WSL）对不上。
pub(crate) fn plugin_command_line(
    config: &LaunchConfig,
    profile: &str,
    op: &PluginOp,
) -> Result<String, String> {
    ensure_cli_alias(&Target::of(config), profile)?;
    let spawn = build_plugin_plan(config, profile, op)?;
    Ok(match spawn {
        dsharbor_core::launch::SpawnPlan::ShellLine { line, .. } => line,
        other => format!("{other:?}"),
    })
}

/// 暂存目录：pnpm 会把含空格的 `file:` 规格在空格处截断（`file:D:\Program` → 当包名
/// 去 registry 查 → 404），而默认安装目录 `D:\Program Files\DSHarbor` 就含空格，
/// 所以插件包必须先复制到一个不含空格的路径再安装。
///
/// 候选按「用户可写程度」排序：应用数据目录（最正常）→ 用户 TEMP → 系统
/// ProgramData（用户名本身带空格时，前两个都会含空格）→ 系统盘根目录兜底。
/// 都不可写才报错，避免「用户名是 John Doe 就装不了插件」。
fn staging_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut candidates = vec![crate::app_data_root(app)?.join("cache")];
    if let Ok(temp) = std::env::var("TEMP") {
        candidates.push(PathBuf::from(temp).join("dsharbor-cache"));
    }
    if let Ok(program_data) = std::env::var("ProgramData") {
        candidates.push(PathBuf::from(program_data).join("DSHarbor").join("cache"));
    }
    if let Ok(system_drive) = std::env::var("SystemDrive") {
        candidates.push(PathBuf::from(format!("{system_drive}\\")).join("DSHarborCache"));
    }
    let mut tried: Vec<String> = Vec::new();
    for dir in candidates {
        let display = dir.display().to_string();
        if display.contains(' ') {
            tried.push(format!("{display}（路径含空格）"));
            continue;
        }
        // 目录存在还不够：真正卡住用户的是「写不进去」，所以这里就试着建目录。
        if let Err(err) = std::fs::create_dir_all(&dir) {
            tried.push(format!("{display}（{err}）"));
            continue;
        }
        return Ok(dir);
    }
    Err(format!(
        "找不到可写且不含空格的暂存目录（pnpm 无法解析含空格的插件包路径）。\
         已尝试：{}。可把 TEMP 指向不含空格的目录后重试。",
        tried.join("；")
    ))
}

/// 把桥接插件包暂存到无空格位置，返回可交给 `pnpm add file:` 的路径
/// （宿主 → Windows 路径；WSL → 发行版内路径）。
fn stage_bridge_tgz(app: &tauri::AppHandle, target: &Target, tgz: &str) -> Result<String, String> {
    let name = std::path::Path::new(tgz)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| format!("插件包路径缺少文件名：{tgz}"))?;
    match target {
        Target::Host => {
            let dest = staging_dir(app)?.join(&name);
            std::fs::copy(tgz, &dest)
                .map_err(|err| format!("复制插件包到暂存目录失败（{}）：{err}", dest.display()))?;
            Ok(strip_extended_prefix(&dest.to_string_lossy()))
        }
        Target::Wsl { distro } => {
            let source = windows_path_to_wsl(tgz).ok_or_else(|| {
                format!("插件包路径无法转换为 WSL 路径（需位于 Windows 盘符）：{tgz}")
            })?;
            if source.contains('\'') || name.contains('\'') {
                return Err(format!("插件包路径包含不允许的字符 '：{source}"));
            }
            let dir = "/tmp/dsharbor-bridge";
            let script = format!("/bin/mkdir -p {dir} && /bin/cp -- '{source}' '{dir}/{name}'");
            wsl_run(distro, &script, PLUGIN_OP_TIMEOUT)?;
            Ok(format!("{dir}/{name}"))
        }
    }
}

/// 这次插件操作要注入的环境变量：当前设置里的下载源 + 代理。
pub(crate) fn plugin_env(app: &tauri::AppHandle) -> Vec<(String, String)> {
    let prefs = crate::settings::load(app).prefs;
    crate::proxy::child_env(&prefs, prefs.download_source)
}

/// 安装桥接插件（先备份、再走官方 plugin add、最后校验 bundles 登记）。
pub fn install(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    profile: &str,
) -> Result<BridgeOutcome, String> {
    let target = Target::of(config);
    let dir = profile_dir(&target, profile)?;
    if is_installed(&target, &dir).unwrap_or(false) {
        return Ok(BridgeOutcome {
            ok: true,
            message: format!(
                "{} 上的环境 {profile} 已经安装过桥接插件（dsh.profile.bundles 已登记），未重复操作。",
                target.label()
            ),
            backup_dir: latest_backup(app).unwrap_or_default(),
        });
    }

    let tgz = find_bridge_tgz(app)?;
    let BackupResult {
        dir: backup_dir,
        pruned,
    } = backup_profile(app, &target, profile)?;
    // 先暂存到无空格路径：pnpm 无法解析含空格的 `file:` 规格（见 stage_bridge_tgz）。
    let package_ref = stage_bridge_tgz(app, &target, &tgz)?;

    let op = PluginOp::Install {
        package: format!("file:{package_ref}"),
    };
    let command = plugin_command(config, profile, &op, &plugin_env(app))?;
    let (code, output) = run_capture(command, PLUGIN_OP_TIMEOUT)?;
    let installed = is_installed(&target, &dir).unwrap_or(false);
    let ok = code == 0 && installed;
    let verify = if installed {
        "已登记 dsh.profile.bundles ✓"
    } else {
        "未在 dsh.profile.bundles 中找到 dsharbor-bridge ✗（安装可能未生效）"
    };
    let message = format!(
        "安装命令：dsh plugin --profile {} add file:{package_ref}（经 {}）\n\
         插件包：{tgz}\n\
         暂存路径：{package_ref}\n\
         退出码：{code}\n\
         校验：{verify}\n\
         输出：\n{}\n\
         备份目录：{backup_dir}{}",
        cli_profile_label(profile),
        target.label(),
        tail_chars(&output, 4000),
        prune_note(&pruned)
    );
    Ok(BridgeOutcome {
        ok,
        message,
        backup_dir,
    })
}

/// 卸载桥接插件（先备份、再走官方 plugin remove、最后校验 bundles 已摘除）。
pub fn uninstall(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    profile: &str,
) -> Result<BridgeOutcome, String> {
    let target = Target::of(config);
    let dir = profile_dir(&target, profile)?;
    if !is_installed(&target, &dir).unwrap_or(false) {
        return Ok(BridgeOutcome {
            ok: true,
            message: format!(
                "{} 上的环境 {profile} 未安装桥接插件，无需卸载。",
                target.label()
            ),
            backup_dir: latest_backup(app).unwrap_or_default(),
        });
    }

    let BackupResult {
        dir: backup_dir,
        pruned,
    } = backup_profile(app, &target, profile)?;
    let op = PluginOp::Uninstall {
        name: profiles::BRIDGE_PLUGIN.to_string(),
    };
    let command = plugin_command(config, profile, &op, &plugin_env(app))?;
    let (code, output) = run_capture(command, PLUGIN_OP_TIMEOUT)?;
    let still_installed = is_installed(&target, &dir).unwrap_or(false);
    let ok = code == 0 && !still_installed;
    let verify = if still_installed {
        "bundles 中仍能找到 dsharbor-bridge ✗（卸载可能未生效）"
    } else {
        "已从 dsh.profile.bundles 摘除 ✓"
    };
    let message = format!(
        "卸载命令：dsh plugin --profile {} remove dsharbor-bridge（经 {}）\n\
         退出码：{code}\n\
         校验：{verify}\n\
         输出：\n{}\n\
         备份目录：{backup_dir}{}",
        cli_profile_label(profile),
        target.label(),
        tail_chars(&output, 4000),
        prune_note(&pruned)
    );
    Ok(BridgeOutcome {
        ok,
        message,
        backup_dir,
    })
}

/// 从备份目录恢复 profile 文件（回滚演示与失败兜底用）。
pub fn restore(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    profile: &str,
    backup_dir: &str,
) -> Result<String, String> {
    let root = backups_root(app)?;
    let candidate = PathBuf::from(backup_dir)
        .canonicalize()
        .map_err(|err| format!("备份目录不可用：{err}"))?;
    let root = root
        .canonicalize()
        .map_err(|err| format!("备份根目录不可用：{err}"))?;
    if !candidate.starts_with(&root) {
        return Err("只允许恢复本应用创建的备份（必须在应用数据目录内）".to_string());
    }

    let target = Target::of(config);
    let dir = profile_dir(&target, profile)?;
    let mut restored: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for name in BACKUP_FILES {
        let source = candidate.join(name);
        if !source.is_file() {
            skipped.push(name.to_string());
            continue;
        }
        let content = std::fs::read_to_string(&source)
            .map_err(|err| format!("读取备份文件 {name} 失败：{err}"))?;
        write_file(&target, &join_path(&target, &dir, name), &content)?;
        restored.push(name.to_string());
    }
    if restored.is_empty() {
        return Err("这个备份里没有任何可恢复的文件。".to_string());
    }
    let mut message = format!(
        "已恢复 {} 上的环境 {profile} 的 profile 文件：{}",
        target.label(),
        restored.join("、")
    );
    if !skipped.is_empty() {
        message.push_str(&format!("（备份中不存在、未处理：{}）", skipped.join("、")));
    }
    message.push_str("。恢复后建议重启 DSH 使配置生效。");
    Ok(message)
}

/// 查询桥接插件状态（界面展示用）。
pub fn state(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    profile: &str,
) -> Result<BridgeState, String> {
    let target = Target::of(config);
    let dir = profile_dir(&target, profile)?;
    let installed = is_installed(&target, &dir).unwrap_or(false);
    let detail = if installed {
        "dsh.profile.bundles 已登记 dsharbor-bridge：DSH 启动时插件会自动挂载，\
         壳经 /dsharbor-bridge/url 取登录链接。"
            .to_string()
    } else {
        "未安装：壳将退化为从启动日志解析登录链接（可用但依赖日志格式）。".to_string()
    };
    Ok(BridgeState {
        installed,
        target: target.label(),
        profile_dir: dir,
        detail,
        latest_backup: latest_backup(app),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一份最小环境：`<tmp>/desktop/package.json`，每个用例独立目录。
    fn scratch(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("dsharbor-alias-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("desktop")).unwrap();
        std::fs::write(root.join("desktop").join("package.json"), "{}").unwrap();
        root
    }

    #[test]
    fn alias_is_created_once_and_reads_the_same_profile() {
        let root = scratch("create");
        ensure_alias_at(&root, "desktop").unwrap();
        let alias = root.join(".dsh-alias-desktop");
        assert!(
            alias.join("package.json").is_file(),
            "通过别名要能读到同一份环境"
        );
        // 幂等：再调一次不报错，也不把链接重建一遍。
        ensure_alias_at(&root, "desktop").unwrap();
        // 摘链接用 remove_dir，别碰目标目录。
        std::fs::remove_dir(&alias).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn alias_is_refused_before_any_link_when_the_profile_is_uninitialised() {
        let root = scratch("missing");
        std::fs::remove_dir_all(root.join("desktop")).unwrap();
        let err = ensure_alias_at(&root, "desktop").unwrap_err();
        assert!(err.contains("还没初始化"), "{err}");
        assert!(std::fs::symlink_metadata(root.join(".dsh-alias-desktop")).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_foreign_entry_at_the_alias_path_is_left_alone() {
        let root = scratch("conflict");
        std::fs::create_dir_all(root.join(".dsh-alias-desktop")).unwrap();
        let err = ensure_alias_at(&root, "desktop").unwrap_err();
        assert!(err.contains("先手动处理掉它"), "{err}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn non_reserved_profiles_go_straight_through() {
        // 绝大多数操作走这条：既不建链接，也不碰磁盘。
        assert_eq!(cli_profile_label("web"), "web");
        assert_eq!(
            cli_profile_label("desktop"),
            ".dsh-alias-desktop（别名 → desktop）"
        );
    }
}
