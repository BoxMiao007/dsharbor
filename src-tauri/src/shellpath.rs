//! 命令行集成的外壳侧：读写当前用户级 PATH、探测系统 `dsh`、落盘 `dsh.cmd` 垫片。
//!
//! 纯字符串计算（垫片内容、PATH 增删、`reg query` 输出解析）都在核心库的
//! `dsharbor_core::path_shim` 里并有单元测试；这里只做三件与操作系统打交道的事：
//! 起 `reg.exe`、探测可执行文件、写文件。
//!
//! 为什么不用 `setx`：它会把 `%USERPROFILE%` 这类引用展开成硬路径写回去（用户的 PATH
//! 就被改写成了一份「当时」的快照），且超过 1024 字符会截断。`reg add /t REG_EXPAND_SZ`
//! 原样保存字符串，`reg query` 读回时也不做展开。
//!
//! 为什么不动系统级 PATH：改 HKLM 需要管理员权限，而且会影响整机所有用户。

use std::path::PathBuf;
use std::time::Duration;

use dsharbor_core::launch::LaunchConfig;
use dsharbor_core::path_shim;
use serde::Serialize;

/// `reg.exe` 很快（毫秒级）；给足余量但别让界面卡住。
const REG_TIMEOUT: Duration = Duration::from_secs(15);

/// 探测系统全局 `dsh` 时依次尝试的文件名（`where dsh` 的等价物，但能自己控制顺序
/// 且能跳过我们自己的垫片目录）。
const DSH_FILE_NAMES: [&str; 3] = ["dsh.exe", "dsh.cmd", "dsh.bat"];

/// 「集成」卡命令行集成段的完整状态。界面只读它，不自己算路径。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliIntegrationState {
    /// 是否支持自动接入。目前只有 Windows 会改 PATH，其它宿主只给手动命令。
    pub supported: bool,
    /// 配置里的开关值（`cliIntegration`）。
    pub enabled: bool,
    /// 垫片目录（`<配置目录>/bin`）；版本切换只重写这个目录里的文件，PATH 那条不变。
    pub bin_dir: String,
    /// 垫片文件路径（Windows 是 `dsh.cmd`）。
    pub shim_path: String,
    /// 那个目录现在是否真的在用户 PATH 里。
    pub on_path: bool,
    /// 可直接粘进 shell 配置的手动命令（自动接入失败或不支持时的备用路径）。
    pub manual_command: String,
    /// 垫片文件按当前启动配置应该有的内容（预览；写不进去时也照给，便于手抄）。
    pub shim_text: String,
    /// 渲染垫片失败的原因（启动方式还没填完整、路径含不允许的字符等）。
    pub shim_error: Option<String>,
    /// 探测到的系统全局 `dsh` 绝对路径（没有时为 None）。
    pub system_dsh: Option<String>,
    /// PATH 里排在垫片目录之前、会让终端先命中另一份 `dsh` 的那个文件。
    pub shadow: Option<String>,
    /// 一行状态说明。
    pub message: String,
}

/// 垫片目录：固定 `<配置目录>/bin`，与版本目录解耦。
pub fn bin_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::app_data_root(app)?.join("bin"))
}

/// 垫片文件名（Windows 下是 `dsh.cmd`）。
fn shim_name() -> &'static str {
    if cfg!(windows) {
        path_shim::SHIM_NAME_WINDOWS
    } else {
        path_shim::SHIM_NAME_POSIX
    }
}

/// 按当前启动配置渲染垫片正文；非 Windows 渲染 POSIX 形式（只用于展示与手动接入）。
fn render_shim(config: &LaunchConfig, system_dsh: Option<&str>) -> Result<String, String> {
    if cfg!(windows) {
        path_shim::windows_shim(&config.mode, system_dsh)
    } else {
        path_shim::posix_shim(&config.mode, system_dsh)
    }
}

/// 把 PATH 里的 `%VAR%` 展开成实际路径（只在探测文件时用，写回永远用原字符串）。
fn expanded_path(raw: &str) -> String {
    path_shim::expand_env_vars(raw, |name| std::env::var(name).ok())
}

/// 按 PATH 顺序找第一个真实存在的 `dsh`，`skip` 是必须跳过的目录（我们自己的垫片目录）。
fn find_dsh_on_path(path_value: &str, skip: Option<&str>) -> Option<String> {
    let sep = path_shim::platform_path_sep();
    let candidates = path_shim::path_candidates(path_value, &DSH_FILE_NAMES, skip, sep);
    candidates.into_iter().find(|candidate| is_file(candidate))
}

/// 这个路径是不是一个真实存在的文件。
fn is_file(path: &str) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

/// 找「排在垫片目录前面、会盖住垫片」的那一份 `dsh`。
fn find_shadow(path_value: &str, bin_dir: &str) -> Option<String> {
    let sep = path_shim::platform_path_sep();
    let index = path_shim::path_entry_index(path_value, bin_dir, sep)?;
    let candidates = path_shim::path_candidates(path_value, &DSH_FILE_NAMES, None, sep);
    let hit = candidates
        .into_iter()
        .find(|candidate| is_file(candidate))?;
    // 候选路径是由 PATH 条目拼出来的，把它的目录取回来比序号。
    let dir = std::path::Path::new(&hit)
        .parent()
        .map(|dir| dir.display().to_string())?;
    match path_shim::path_entry_index(path_value, &dir, sep) {
        // 命中的就是垫片目录自己（或后面的），不算遮挡。
        Some(hit_index) if hit_index < index => Some(hit),
        _ => None,
    }
}

/// 读当前用户的 PATH（注册表里没有这个值 = 空 PATH）。
#[cfg(windows)]
fn read_user_path() -> Result<String, String> {
    let mut command = std::process::Command::new("reg");
    command.args(["query", r"HKCU\Environment", "/v", "Path"]);
    let (code, output) = crate::plugin::run_capture(command, REG_TIMEOUT)?;
    if code == 0 {
        return path_shim::parse_reg_query_value(&output, "Path")
            .ok_or_else(|| format!("读不懂注册表输出：{}", output.trim()));
    }
    // 键/值不存在（全新用户、PATH 被清空过）当作空 PATH；其它失败要如实报错，
    // 否则会在「读不到」的基础上把整份 PATH 覆盖成只剩垫片目录。
    let lower = output.to_ascii_lowercase();
    if output.contains("找不到") || lower.contains("unable to find") {
        return Ok(String::new());
    }
    Err(format!("读取用户 PATH 失败：{}", output.trim()))
}

/// 写回当前用户的 PATH（`REG_EXPAND_SZ` 原样保存，不做展开）。
#[cfg(windows)]
fn write_user_path(value: &str) -> Result<(), String> {
    let mut command = std::process::Command::new("reg");
    command.args([
        "add",
        r"HKCU\Environment",
        "/v",
        "Path",
        "/t",
        "REG_EXPAND_SZ",
        "/d",
        value,
        "/f",
    ]);
    let (code, output) = crate::plugin::run_capture(command, REG_TIMEOUT)?;
    if code == 0 {
        Ok(())
    } else {
        Err(format!("写入用户 PATH 失败：{}", output.trim()))
    }
}

/// 非 Windows 宿主：不改任何 shell 配置，只返回手动命令。
#[cfg(not(windows))]
fn read_user_path() -> Result<String, String> {
    Ok(std::env::var("PATH").unwrap_or_default())
}

#[cfg(not(windows))]
fn write_user_path(_value: &str) -> Result<(), String> {
    Err("非 Windows 宿主不自动修改 shell 配置，请用界面给出的手动命令接入".to_string())
}

/// 写垫片文件（含非 ASCII 时按 GBK 编码，见 `path_shim::encode_batch_file`）。
fn write_shim(path: &std::path::Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("创建垫片目录失败（{}）：{err}", parent.display()))?;
    }
    std::fs::write(path, path_shim::encode_batch_file(text))
        .map_err(|err| format!("写入垫片失败（{}）：{err}", path.display()))
}

/// 读当前状态。`enabled` 取自配置；`on_path` / `shadow` 取自真实 PATH。
pub fn state(app: &tauri::AppHandle, config: &LaunchConfig, enabled: bool) -> CliIntegrationState {
    let supported = cfg!(windows);
    let bin_dir = bin_dir(app)
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|err| format!("（未知：{err}）"));
    let shim_path = PathBuf::from(&bin_dir).join(shim_name());
    let shim_path_text = shim_path.display().to_string();
    let manual_command = path_shim::manual_command(&bin_dir);

    let raw_path = if supported {
        read_user_path().unwrap_or_default()
    } else {
        String::new()
    };
    let path_for_scan = expanded_path(&raw_path);
    let on_path = path_shim::path_has_entry(&raw_path, &bin_dir);

    // 探测系统全局 dsh 时跳过垫片目录自己，否则「系统全局命令」的垫片会指向自己。
    let system_dsh = if supported {
        find_dsh_on_path(&path_for_scan, Some(&bin_dir))
    } else {
        None
    };
    let shadow = if supported && on_path {
        find_shadow(&path_for_scan, &bin_dir)
    } else {
        None
    };

    let rendered = render_shim(config, system_dsh.as_deref());
    let (shim_text, shim_error) = match &rendered {
        Ok(text) => (text.clone(), None),
        Err(err) => (String::new(), Some(err.clone())),
    };

    // 先把状态装起来，再由它自己算出那句话：两者看的是同一份事实，
    // 免得六个位置参数（且参数顺序肉眼不可辨）一路对下去。
    let mut state = CliIntegrationState {
        supported,
        enabled,
        bin_dir,
        shim_path: shim_path_text,
        on_path,
        manual_command,
        shim_text,
        shim_error,
        system_dsh,
        shadow,
        message: String::new(),
    };
    state.message = state_message(&state);
    state
}

/// 一行状态说明：把「开关 / 真实 PATH / 垫片能不能渲染 / 谁盖住了它」四件事讲清楚。
///
/// 直接读 `CliIntegrationState`：`shim_error` 为空就等价于「垫片渲染得出来」
/// （`state()` 里两者出自同一次 `render_shim`），不需要再传一个布尔。
fn state_message(state: &CliIntegrationState) -> String {
    let supported = state.supported;
    let enabled = state.enabled;
    let on_path = state.on_path;
    let shim_ok = state.shim_error.is_none();

    if !supported {
        return "仅在 Windows 宿主可用：这里不会改动任何 shell 配置，可以复制下面的命令手动接入。"
            .to_string();
    }
    if enabled {
        if let Some(err) = &state.shim_error {
            return format!("垫片暂时写不出来：{err}");
        }
        if !on_path {
            return "开关已打开，但用户 PATH 里没有垫片目录（可能被其它工具改回去了），重新开关一次即可补回。".to_string();
        }
        if let Some(shadow) = &state.shadow {
            return format!(
                "已接入。注意：PATH 里还有一份排在更前面的 {shadow}，终端会先命中它；要改用壳里的这份，把它挪到后面或删掉。"
            );
        }
        return "已接入：新开一个终端后 dsh 命令就指向壳里正在用的那份。".to_string();
    }
    if !shim_ok {
        return "开关已关闭，垫片目录也不在用户 PATH 里。".to_string();
    }
    "开关关闭：终端里的 dsh 与壳无关。".to_string()
}

/// 打开 / 关闭命令行接入：同时处理垫片文件与用户 PATH 的那一条。
///
/// 每一步都按「先把能做的做完、再报错」的顺序走，返回错误时把已经成功的部分也带上，
/// 避免界面停在中间态还显示成功。
pub fn apply(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    enabled: bool,
) -> Result<CliIntegrationState, String> {
    let bin_dir = bin_dir(app)?;
    let bin_dir_text = bin_dir.display().to_string();
    path_shim::validate_dir(&bin_dir_text)?;

    if !cfg!(windows) {
        // 非 Windows：不动任何 shell 配置，状态照实返回（界面只展示手动命令）。
        return Ok(state(app, config, enabled));
    }

    let shim_path = bin_dir.join(shim_name());
    if enabled {
        // 先把垫片写出来：PATH 里那条永远指向这个目录，写不出垫片就白改 PATH。
        let path_value = read_user_path()?;
        let path_for_scan = expanded_path(&path_value);
        let system_dsh = find_dsh_on_path(&path_for_scan, Some(&bin_dir_text));
        let text = render_shim(config, system_dsh.as_deref())?;
        write_shim(&shim_path, &text)?;
        let next = path_shim::path_add_entry(&path_value, &bin_dir_text);
        if next != path_value {
            write_user_path(&next)?;
        }
    } else {
        let path_value = read_user_path()?;
        let next = path_shim::path_remove_entry(&path_value, &bin_dir_text);
        if next != path_value {
            write_user_path(&next)?;
        }
        // 垫片一并删掉：留着也没有 PATH 能命中它，但会在目录里留下无用文件。
        if shim_path.exists() {
            std::fs::remove_file(&shim_path)
                .map_err(|err| format!("移除垫片失败（{}）：{err}", shim_path.display()))?;
        }
    }

    Ok(state(app, config, enabled))
}

/// 壳启动时的刷新：开关为开就按当前配置重写垫片（跟随启动方式变化）。
///
/// 失败只记日志、不阻塞启动——垫片是便利功能，坏掉不该让壳起不来。
pub fn refresh_on_start(app: &tauri::AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let settings = crate::settings::load(app);
    if !settings.prefs.cli_integration {
        return;
    }
    if let Err(err) = apply(app, &settings.launch, true) {
        eprintln!("[dsharbor] 命令行集成：启动刷新垫片失败：{err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只关心那四个事实，其余字段填占位的：`state_message` 只看
    /// supported / enabled / on_path / shim_error / shadow。
    fn fixture(
        supported: bool,
        enabled: bool,
        on_path: bool,
        shim_error: Option<String>,
        shadow: Option<String>,
    ) -> CliIntegrationState {
        CliIntegrationState {
            supported,
            enabled,
            bin_dir: r"C:\Users\me\AppData\Roaming\DSHarbor\bin".to_string(),
            shim_path: r"C:\Users\me\AppData\Roaming\DSHarbor\bin\dsh.cmd".to_string(),
            on_path,
            manual_command: String::new(),
            shim_text: String::new(),
            shim_error,
            system_dsh: None,
            shadow,
            message: String::new(),
        }
    }

    #[test]
    fn message_explains_non_windows_case() {
        let message = state_message(&fixture(false, true, false, None, None));
        assert!(message.contains("仅在 Windows 宿主可用"));
    }

    #[test]
    fn message_reports_render_error_first() {
        let message = state_message(&fixture(true, true, true, Some("坏字符".to_string()), None));
        assert!(message.contains("坏字符"));
    }

    #[test]
    fn message_warns_about_shadowing() {
        let message = state_message(&fixture(
            true,
            true,
            true,
            None,
            Some(r"C:\npm\dsh.cmd".to_string()),
        ));
        assert!(message.contains(r"C:\npm\dsh.cmd"));
        assert!(message.contains("先命中"));
    }

    #[test]
    fn message_stays_quiet_about_render_errors_when_disabled() {
        // 开关关着时启动方式可能还没填完（比如程序路径空着），不该拿「垫片写不出来」吓人。
        let message = state_message(&fixture(
            true,
            false,
            false,
            Some("坏字符".to_string()),
            None,
        ));
        assert!(!message.contains("垫片暂时写不出来"));
    }

    #[test]
    fn message_distinguishes_enabled_and_disabled() {
        assert!(state_message(&fixture(true, true, true, None, None)).contains("新开一个终端"));
        assert!(state_message(&fixture(true, false, false, None, None)).contains("开关关闭"));
        assert!(state_message(&fixture(true, true, false, None, None)).contains("没有垫片目录"));
    }
}
