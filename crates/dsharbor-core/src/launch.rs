//! 启动器纯逻辑：四种启动方式的配置模型、输入校验与命令构造。
//!
//! 为什么这些放在核心库而不是外壳：命令构造（尤其是经 shell 拼接的命令行）
//! 是最容易出安全问题的部分，放这里后可以在开发机上全自动测试，
//! 覆盖注入防护、跨系统参数拼接等边界。

use serde::{Deserialize, Serialize};

/// 默认 npx 命令行。
/// `--yes`：npx 首次下载包时会交互确认；壳的子进程没有终端，不加会直接卡住。
pub const NPX_COMMAND: &str = "npx --yes @deepseek-ai/dsh web";
/// 系统全局命令（用户已 `npm install -g` 的场景）。
pub const SYSTEM_COMMAND: &str = "dsh web";
/// WSL 模式下的默认内部命令（与 npx 模式一致，但在发行版内部执行）。
pub const WSL_DEFAULT_INNER: &str = "npx --yes @deepseek-ai/dsh web";
/// 二进制模式默认附加的子命令（DSH 的 web 子命令）。
pub const BINARY_BASE_ARGS: [&str; 1] = ["web"];
/// 壳为每次 DSH 启动追加的应用参数：禁用 DSH 自带的「启动后打开系统浏览器」。
/// 需求：DSH 界面只出现在壳自己的窗口里（点「打开 DSH 界面」），不调用用户安装的
/// 浏览器（浏览器占内存大）。DSH 默认 openBrowser=true 会自己拉一次默认浏览器，
/// 必须显式关掉；用户附加参数里已写了 `--no-open` 时不重复追加。
pub const DEFAULT_APP_ARGS: [&str; 1] = ["--no-open"];
/// npx 前缀（不含子命令）：插件管理等其它 `dsh` 子命令复用。
pub const NPX_DSH: &str = "npx --yes @deepseek-ai/dsh";
/// 系统命令前缀（不含子命令）。
pub const SYSTEM_DSH: &str = "dsh";
/// v1 固定使用的 DSH profile 名（用户已有的 web 环境）。
pub const PROFILE_NAME: &str = "web";
// 关于 WSL 的 PATH 污染（清理不放在本库、也不放进 inner 命令）：
//
// 通过 `wsl.exe` 从 Windows 侧启动发行版时，Windows 的 PATH 会以
// `/mnt/c/...`、`/mnt/d/...` 形式出现在发行版 PATH 里。当发行版内没有某个
// 工具时（例如 pnpm 装在 `~/.local/share/pnpm/bin`，只在交互式登录 shell 的
// PATH 里），就会误用 Windows 版同名二进制——实机症状：DSH 的 plugin-manager
// 调到 Windows 版 pnpm，在 Linux 工作目录下直接崩溃
// `current dir is an absolute path with drive letter`。
//
// 修复放在外壳侧（src-tauri）：先取一份发行版的干净 PATH，再以 `env PATH=...`
// 作为 argv 前缀注入。不要往 inner 命令里塞 shell 清理脚本——实测 wsl.exe
// 会破坏参数中的引号（`echo X"Y"Z` 变成 `XYZ`），含引号的脚本必被改坏。

/// 启动方式（对应配置界面上的四个选项）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LaunchMode {
    /// 官方 npx 命令（未全局安装 DSH 时最省事）。
    Npx,
    /// 系统 PATH 里的 dsh 命令。
    System,
    /// 指定可执行文件/脚本的绝对路径。
    Binary { path: String },
    /// 通过 wsl.exe 在 WSL 发行版内部启动（Windows 壳启动 WSL 里的 DSH）。
    Wsl { distro: String, inner: String },
}

/// 完整启动配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    pub mode: LaunchMode,
    /// 追加到启动命令末尾的额外参数（逐 token 校验）。
    #[serde(default)]
    pub extra_args: Vec<String>,
    /// 端口覆盖：None = 跟随 DSH 自身配置（托管值）；Some(P) = 壳注入
    /// launcher 层 patch，把 webserver 端口覆盖为 P（不改用户任何文件）。
    #[serde(default)]
    pub port: Option<u16>,
}

/// 构造好的启动计划。外壳按平台把 Script/ShellLine/Wsl 翻译成具体的进程与参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnPlan {
    /// 直接启动可执行文件，不经过 shell（最可靠、无注入面）。
    Direct { program: String, args: Vec<String> },
    /// 脚本文件（.cmd/.bat）：不能直接 CreateProcess，必须经命令行解释器执行。
    /// 程序路径与参数分开作为 argv 传递，绝不拼成一整行字符串——
    /// 整行字符串在 `cmd /C` 下会踩引号解析的坑：外壳层给含空格的参数加引号，
    /// 与行内已有的路径引号叠加后，cmd 会把字面引号当成文件名的一部分
    /// （实机症状：`'\"D:\...\dsh.cmd\"' 不是内部或外部命令`）。
    Script { program: String, args: Vec<String> },
    /// 经命令行解释器执行（Windows: cmd /C；POSIX: /bin/sh -c）。
    ShellLine { line: String, wrap: ShellWrap },
    /// 经 wsl.exe 在发行版内执行：wsl.exe -d <distro> -- bash -lc <inner>。
    /// 直接传 argv 数组、不再拼接 shell 引用，天然规避跨系统注入。
    Wsl { distro: String, inner: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellWrap {
    Cmd,
    Posix,
}

/// 完整启动计划：要执行的进程 + 要注入的环境变量。
///
/// 环境变量单独携带而不是塞进 `SpawnPlan` 的变体里：WSL 变体必须把变量以
/// argv 形式送进发行版内部（`env K=V bash -lc ...`），宿主侧
/// `Command::envs` 只影响 wsl.exe 自己、到不了发行版里面。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub spawn: SpawnPlan,
    pub env: Vec<(String, String)>,
}

/// 校验要注入的环境变量（键是常规标识符；值禁止 NUL 与换行）。
pub fn validate_env(env: &[(String, String)]) -> Result<(), String> {
    for (key, value) in env {
        if key.is_empty()
            || key.len() > 64
            || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err(format!("环境变量名不合法：{key:?}"));
        }
        if value.contains('\0') || value.contains('\n') || value.contains('\r') {
            return Err(format!("环境变量 {key} 的值包含控制字符"));
        }
    }
    Ok(())
}

/// 构造带环境变量的完整启动计划（壳用它把桥接 nonce 注入 DSH 进程、
/// 并在需要时追加端口覆盖等 launcher 层参数）。
pub fn build_launch_plan(
    config: &LaunchConfig,
    env: &[(String, String)],
    launcher_args: &[String],
) -> Result<LaunchPlan, String> {
    validate_env(env)?;
    Ok(LaunchPlan {
        spawn: build_spawn_plan_with_launcher_args(config, launcher_args)?,
        env: env.to_vec(),
    })
}

/// 附加参数白名单字符。
/// 明确排除 shell 危险面：引号、& | < > ^ % ! $ ( ) ` ; \ 以及换行等。
/// 反斜杠也排除：它在 POSIX shell 里是转义符，允许它会让参数边界语义变得含糊。
fn allowed_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':' | '=' | '@' | '+' | ' ')
}

/// 校验单个参数 token（附加参数、WSL 内部命令的每个词）。
pub fn validate_argument(token: &str) -> Result<(), String> {
    if token.is_empty() {
        return Err("参数不能为空".into());
    }
    if token.len() > 256 {
        return Err(format!("参数过长（最多 256 字符）：{token}"));
    }
    if token.trim() != token {
        return Err(format!("参数首尾不能有空白：{token:?}"));
    }
    if let Some(bad) = token.chars().find(|c| !allowed_char(*c)) {
        return Err(format!(
            "参数包含不允许的字符 {bad:?}：{token}（仅允许字母数字、- _ . / : = @ + 与中间空格）"
        ));
    }
    Ok(())
}

/// 校验 WSL 发行版名（如 Ubuntu-24.04）。
fn validate_distro(distro: &str) -> Result<(), String> {
    if distro.is_empty() || distro.len() > 64 {
        return Err("WSL 发行版名不能为空且不超过 64 字符".into());
    }
    if let Some(bad) = distro
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
    {
        return Err(format!("WSL 发行版名包含不允许的字符 {bad:?}：{distro}"));
    }
    Ok(())
}

/// 校验二进制路径：必须像绝对路径、扩展名受支持、不含会破坏命令行引用的字符。
fn validate_binary_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 1024 {
        return Err("程序路径不能为空且不超过 1024 字符".into());
    }
    let looks_absolute = path.starts_with('/')
        || path.starts_with("\\\\")
        || (path.len() >= 3
            && path.as_bytes()[1] == b':'
            && matches!(path.as_bytes()[2], b'\\' | b'/'));
    if !looks_absolute {
        return Err(format!("请填写完整路径（如 D:\\tools\\dsh.cmd）：{path}"));
    }
    if path.contains('"') || path.contains('%') || path.contains('\n') || path.contains('\r') {
        return Err(format!("程序路径包含不允许的字符：{path}"));
    }
    let lower = path.to_ascii_lowercase();
    if !(lower.ends_with(".exe") || lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        return Err(format!("只支持 .exe / .cmd / .bat：{path}"));
    }
    Ok(())
}

/// 校验整个启动配置。
pub fn validate(config: &LaunchConfig) -> Result<(), String> {
    for arg in &config.extra_args {
        validate_argument(arg)?;
    }
    // 端口 0 用来让操作系统自选（对壳没有意义：登录链接解析依赖真实端口），直接拒绝。
    if config.port == Some(0) {
        return Err("端口必须是 1-65535 的整数（留空表示跟随 DSH 配置）".into());
    }
    match &config.mode {
        LaunchMode::Npx | LaunchMode::System => Ok(()),
        LaunchMode::Binary { path } => validate_binary_path(path),
        LaunchMode::Wsl { distro, inner } => {
            validate_distro(distro)?;
            let tokens = split_line(inner);
            if tokens.is_empty() {
                return Err("WSL 内部命令不能为空".into());
            }
            for token in &tokens {
                validate_argument(token)?;
            }
            Ok(())
        }
    }
}

fn split_line(line: &str) -> Vec<String> {
    line.split_whitespace().map(str::to_string).collect()
}

/// 把 token 列表拼成 shell 命令行：含空格的 token 加双引号。
/// 安全性依赖白名单校验：token 内不可能出现引号或其他可逃逸字符。
fn join_shell_line(tokens: &[String]) -> String {
    tokens
        .iter()
        .map(|t| {
            if t.contains(' ') {
                format!("\"{t}\"")
            } else {
                t.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 是否是需要经 cmd.exe 执行的脚本（.cmd/.bat 不能被 CreateProcess 直接启动）。
pub fn is_script_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// 校验壳内部追加的 launcher 参数（如 `--patch <路径>`）。
///
/// 与用户参数不同：允许反斜杠（Windows 路径必须），但仍禁止一切 shell 元字符——
/// 这些参数会进入 shell 命令行（ShellLine 模式），不能留注入面。
fn validate_launcher_arg(arg: &str) -> Result<(), String> {
    if arg.is_empty() || arg.len() > 1024 {
        return Err("内部启动参数长度不合法（1-1024 字符）".into());
    }
    const BANNED: [char; 17] = [
        '"', '\'', '\n', '\r', '\t', '&', '|', '<', '>', '^', '%', '!', '(', ')', '`', '$', ';',
    ];
    if let Some(bad) = arg.chars().find(|c| BANNED.contains(c)) {
        return Err(format!("内部启动参数包含不允许的字符 {bad:?}：{arg}"));
    }
    Ok(())
}

/// 构造启动计划。调用前会先做完整校验。
pub fn build_spawn_plan(config: &LaunchConfig) -> Result<SpawnPlan, String> {
    build_spawn_plan_with_launcher_args(config, &[])
}

/// 构造启动计划，并在用户附加参数之前插入壳内部的 launcher 层参数。
///
/// 顺序很关键：DSH 启动器只解析命令行**头部**自己的旗标（`--patch` 等），
/// 遇到第一个应用参数就停——所以内部参数必须排在用户附加参数（app 参数）前面。
pub fn build_spawn_plan_with_launcher_args(
    config: &LaunchConfig,
    launcher_args: &[String],
) -> Result<SpawnPlan, String> {
    validate(config)?;
    for arg in launcher_args {
        validate_launcher_arg(arg)?;
    }
    let mut extra: Vec<String> = launcher_args
        .iter()
        .cloned()
        .chain(config.extra_args.iter().cloned())
        .collect();
    // 保证 DSH 不弹系统浏览器（用户已写 --no-open 时不重复）。
    for arg in DEFAULT_APP_ARGS {
        if !extra.iter().any(|existing| existing == arg) {
            extra.push(arg.to_string());
        }
    }
    let extra = &extra;
    Ok(match &config.mode {
        LaunchMode::Npx => {
            let mut tokens = split_line(NPX_COMMAND);
            tokens.extend(extra.iter().cloned());
            SpawnPlan::ShellLine {
                line: join_shell_line(&tokens),
                wrap: ShellWrap::Cmd,
            }
        }
        LaunchMode::System => {
            let mut tokens = split_line(SYSTEM_COMMAND);
            tokens.extend(extra.iter().cloned());
            SpawnPlan::ShellLine {
                line: join_shell_line(&tokens),
                wrap: ShellWrap::Cmd,
            }
        }
        LaunchMode::Binary { path } => {
            let mut args: Vec<String> = BINARY_BASE_ARGS.iter().map(|s| s.to_string()).collect();
            args.extend(extra.iter().cloned());
            if is_script_path(path) {
                // .cmd/.bat 经解释器执行；路径与参数分开传递，不拼整行字符串。
                SpawnPlan::Script {
                    program: path.clone(),
                    args,
                }
            } else {
                SpawnPlan::Direct {
                    program: path.clone(),
                    args,
                }
            }
        }
        LaunchMode::Wsl { distro, inner } => {
            let mut tokens = split_line(inner);
            tokens.extend(extra.iter().cloned());
            SpawnPlan::Wsl {
                distro: distro.clone(),
                inner: join_shell_line(&tokens),
            }
        }
    })
}

/// 从命令输出里辨认 DSH 版本号（`dsh <…> web --version` 的输出）。
///
/// 取最后一行「整行就是版本号」的内容，而不是第一行：WSL 模式下经 `bash -lc`
/// 启动，登录脚本 / MOTD 可能先往 stdout 打字，启动日志也可能混进来。
pub fn parse_version_output(output: &str) -> Option<String> {
    output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| looks_like_version(line))
        .map(str::to_string)
}

/// 版本号形态：首字符是数字或 `v`，整行只含版本号允许的字符（`0.2.0-rc.2`、`v0.2.0`）。
fn looks_like_version(line: &str) -> bool {
    if line.is_empty() || line.len() > 64 {
        return false;
    }
    let first = line.chars().next().unwrap_or(' ');
    if !(first.is_ascii_digit() || first == 'v') {
        return false;
    }
    line.contains(|c: char| c.is_ascii_digit())
        && line
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'))
}

/// 插件管理操作（桥接插件的安装/卸载；经官方 `dsh plugin` 子命令）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginOp {
    /// 安装一个包引用（如 `file:/path/to/dsharbor-bridge-0.1.0.tgz`）。
    Install { package: String },
    /// 卸载一个已安装的包（按包名）。
    Uninstall { name: String },
}

/// 构造插件管理命令：复用当前启动方式的前缀，但把 `web` 子命令换成
/// `plugin --profile web <add|remove> ...`（官方插件机制，会自动登记/摘除
/// `dsh.profile.bundles`，不手工编辑用户配置）。
pub fn build_plugin_plan(config: &LaunchConfig, op: &PluginOp) -> Result<SpawnPlan, String> {
    validate(config)?;
    let mut args: Vec<String> = vec!["plugin".into(), "--profile".into(), PROFILE_NAME.into()];
    match op {
        PluginOp::Install { package } => {
            validate_package_ref(package)?;
            args.push("add".into());
            args.push(package.clone());
        }
        PluginOp::Uninstall { name } => {
            validate_package_ref(name)?;
            args.push("remove".into());
            args.push(name.clone());
        }
    }
    Ok(match &config.mode {
        LaunchMode::Npx => {
            let mut tokens = split_line(NPX_DSH);
            tokens.extend(args);
            SpawnPlan::ShellLine {
                line: join_shell_line(&tokens),
                wrap: ShellWrap::Cmd,
            }
        }
        LaunchMode::System => {
            let mut tokens = split_line(SYSTEM_DSH);
            tokens.extend(args);
            SpawnPlan::ShellLine {
                line: join_shell_line(&tokens),
                wrap: ShellWrap::Cmd,
            }
        }
        LaunchMode::Binary { path } => {
            if is_script_path(path) {
                SpawnPlan::Script {
                    program: path.clone(),
                    args,
                }
            } else {
                SpawnPlan::Direct {
                    program: path.clone(),
                    args,
                }
            }
        }
        LaunchMode::Wsl { distro, inner } => {
            let mut tokens = wsl_plugin_prefix(inner);
            tokens.extend(args);
            SpawnPlan::Wsl {
                distro: distro.clone(),
                inner: join_shell_line(&tokens),
            }
        }
    })
}

/// WSL 内部命令去掉尾部的 `web` 子命令，得到插件管理前缀。
/// 默认 inner 是 `npx --yes @deepseek-ai/dsh web`，也有用户写 `dsh web`。
fn wsl_plugin_prefix(inner: &str) -> Vec<String> {
    let mut tokens = split_line(inner);
    if tokens.last().map(|token| token == "web").unwrap_or(false) {
        tokens.pop();
    }
    tokens
}

/// 校验插件包引用（`file:<tgz 路径>` 或包名）。
/// 这些字符串会进入 shell 命令行（npx/系统命令模式）与 WSL 内部命令，
/// 虽然是壳自己的资源路径，仍做防御性校验。
fn validate_package_ref(package: &str) -> Result<(), String> {
    if package.is_empty() || package.len() > 512 {
        return Err("插件包引用不能为空且不超过 512 字符".into());
    }
    // 空格不是 shell 转义问题（本模块自己加引号），而是 pnpm 的 `file:` 规格解析问题：
    // 实测含空格的规格会在空格处被截断（`file:D:\Program`）后当包名去 registry 查，
    // 报 ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST。调用方必须先把 tgz 暂存到无空格路径。
    if package.contains(' ') {
        return Err(format!(
            "插件包引用不能包含空格（pnpm 无法解析 file: 规格，请先把插件包复制到无空格路径）：{package}"
        ));
    }
    let banned = [
        '"', '\'', '\n', '\r', '&', '|', '<', '>', '^', '%', '!', '(', ')', '`', '$', ';',
    ];
    if let Some(bad) = package.chars().find(|c| banned.contains(c)) {
        return Err(format!("插件包引用包含不允许的字符 {bad:?}：{package}"));
    }
    Ok(())
}

/// 从附加参数里找用户显式指定的端口（`--port 3081` 或 `--port=3081`）。
/// 桥接通道在日志公告出现前就用它提前探测；找不到时等日志解析出端口。
pub fn extract_configured_port(args: &[String]) -> Option<u16> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--port" {
            if let Some(value) = iter.next() {
                return value.parse().ok();
            }
        } else if let Some(value) = arg.strip_prefix("--port=") {
            return value.parse().ok();
        }
    }
    None
}

/// 从 DSH 输出的 URL 中解析端口（形如 `http://127.0.0.1:3080/?token=...`）。
pub fn extract_port(line: &str) -> Option<u16> {
    let scheme = line.find("://")? + 3;
    let rest = &line[scheme..];
    let end = rest
        .find(['/', '?', ' ', '\n', '\r', '\t'])
        .unwrap_or(rest.len());
    let host_port = &rest[..end];
    let (_, port) = host_port.rsplit_once(':')?;
    port.parse::<u16>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(mode: LaunchMode, extra: &[&str]) -> LaunchConfig {
        LaunchConfig {
            mode,
            extra_args: extra.iter().map(|s| s.to_string()).collect(),
            port: None,
        }
    }

    #[test]
    fn npx_default_plan() {
        let plan = build_spawn_plan(&cfg(LaunchMode::Npx, &[])).unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx --yes @deepseek-ai/dsh web --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn npx_with_extra_args() {
        let plan =
            build_spawn_plan(&cfg(LaunchMode::Npx, &["--port", "3081", "--no-open"])).unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx --yes @deepseek-ai/dsh web --port 3081 --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn system_default_plan() {
        let plan = build_spawn_plan(&cfg(LaunchMode::System, &[])).unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "dsh web --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn binary_exe_is_direct() {
        let plan = build_spawn_plan(&cfg(
            LaunchMode::Binary {
                path: "D:\\tools\\dsh.exe".into(),
            },
            &["--port", "3082"],
        ))
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::Direct {
                program: "D:\\tools\\dsh.exe".into(),
                args: vec![
                    "web".into(),
                    "--port".into(),
                    "3082".into(),
                    "--no-open".into()
                ]
            }
        );
    }

    #[test]
    fn binary_cmd_uses_script_plan() {
        let plan = build_spawn_plan(&cfg(
            LaunchMode::Binary {
                path: "C:\\Program Files\\dsh.cmd".into(),
            },
            &[],
        ))
        .unwrap();
        // 程序与参数分开传递（不拼整行），引号交给外壳层的参数转义规则各管各的。
        assert_eq!(
            plan,
            SpawnPlan::Script {
                program: "C:\\Program Files\\dsh.cmd".into(),
                args: vec!["web".into(), "--no-open".into()]
            }
        );
    }

    #[test]
    fn wsl_default_plan() {
        let plan = build_spawn_plan(&cfg(
            LaunchMode::Wsl {
                distro: "Ubuntu-24.04".into(),
                inner: WSL_DEFAULT_INNER.into(),
            },
            &[],
        ))
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::Wsl {
                distro: "Ubuntu-24.04".into(),
                inner: "npx --yes @deepseek-ai/dsh web --no-open".into()
            }
        );
    }

    #[test]
    fn wsl_custom_inner_with_extra_args() {
        let plan = build_spawn_plan(&cfg(
            LaunchMode::Wsl {
                distro: "Debian".into(),
                inner: "dsh web".into(),
            },
            &["--port", "3083"],
        ))
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::Wsl {
                distro: "Debian".into(),
                inner: "dsh web --port 3083 --no-open".into()
            }
        );
    }

    #[test]
    fn rejects_shell_injection_attempts() {
        for bad in [
            "web; rm -rf /",
            "a & b",
            "a | b",
            "a > out.txt",
            "`rm -rf /`",
            "$(reboot)",
            "\"quoted\"",
            "'quoted'",
            "a^b",
            "%PATH%",
            "a!b",
            "a(b)",
            "a\\b",
            "a\tb",
        ] {
            let err = build_spawn_plan(&cfg(LaunchMode::Npx, &[bad]));
            assert!(err.is_err(), "注入样例应被拒绝: {bad:?}");
        }
    }

    #[test]
    fn rejects_malformed_args() {
        for bad in ["", " leading", "trailing ", "中文参数"] {
            assert!(
                build_spawn_plan(&cfg(LaunchMode::Npx, &[bad])).is_err(),
                "应被拒绝: {bad:?}"
            );
        }
    }

    #[test]
    fn arg_with_inner_space_is_quoted() {
        let plan = build_spawn_plan(&cfg(LaunchMode::Npx, &["a b"])).unwrap();
        match plan {
            SpawnPlan::ShellLine { line, .. } => {
                assert_eq!(line, "npx --yes @deepseek-ai/dsh web \"a b\" --no-open")
            }
            other => panic!("unexpected plan: {other:?}"),
        }
    }

    #[test]
    fn no_open_is_appended_once() {
        // 默认追加 --no-open（不弹系统浏览器）。
        let plan = build_spawn_plan(&cfg(LaunchMode::Npx, &[])).unwrap();
        match plan {
            SpawnPlan::ShellLine { line, .. } => assert!(line.ends_with(" --no-open"), "{line}"),
            other => panic!("unexpected plan: {other:?}"),
        }
        // 用户自己写了 --no-open 时不重复。
        let plan = build_spawn_plan(&cfg(LaunchMode::Npx, &["--no-open"])).unwrap();
        match plan {
            SpawnPlan::ShellLine { line, .. } => {
                assert_eq!(line.matches("--no-open").count(), 1, "{line}")
            }
            other => panic!("unexpected plan: {other:?}"),
        }
    }

    #[test]
    fn rejects_bad_paths() {
        assert!(build_spawn_plan(&cfg(
            LaunchMode::Binary {
                path: "dsh.exe".into()
            },
            &[]
        ))
        .is_err());
        assert!(build_spawn_plan(&cfg(
            LaunchMode::Binary {
                path: "D:\\tools\\dsh.sh".into()
            },
            &[]
        ))
        .is_err());
        assert!(build_spawn_plan(&cfg(
            LaunchMode::Binary {
                path: "D:\\tools\\d\"sh.exe".into()
            },
            &[]
        ))
        .is_err());
        assert!(build_spawn_plan(&cfg(
            LaunchMode::Binary {
                path: "D:\\100%\\dsh.exe".into()
            },
            &[]
        ))
        .is_err());
    }

    #[test]
    fn rejects_bad_distro() {
        assert!(build_spawn_plan(&cfg(
            LaunchMode::Wsl {
                distro: "a b".into(),
                inner: WSL_DEFAULT_INNER.into()
            },
            &[]
        ))
        .is_err());
        assert!(build_spawn_plan(&cfg(
            LaunchMode::Wsl {
                distro: String::new(),
                inner: WSL_DEFAULT_INNER.into()
            },
            &[]
        ))
        .is_err());
        assert!(build_spawn_plan(&cfg(
            LaunchMode::Wsl {
                distro: "ok".into(),
                inner: "  ".into()
            },
            &[]
        ))
        .is_err());
    }

    #[test]
    fn extracts_port_from_dsh_url() {
        assert_eq!(
            extract_port("dsh web: http://127.0.0.1:3080/?token=abc"),
            Some(3080)
        );
        assert_eq!(extract_port("dsh web: http://127.0.0.1:3080/?token=abc (LAN: http://192.168.1.5:3080/?token=abc)"), Some(3080));
        assert_eq!(extract_port("http://[::1]:3085/?token=x"), Some(3085));
        assert_eq!(extract_port("no url here"), None);
    }

    #[test]
    fn launch_plan_carries_env() {
        let plan = build_launch_plan(
            &cfg(LaunchMode::Npx, &[]),
            &[("DSHARBOR_BRIDGE_NONCE".into(), "ab12".into())],
            &[],
        )
        .unwrap();
        assert_eq!(
            plan.spawn,
            SpawnPlan::ShellLine {
                line: "npx --yes @deepseek-ai/dsh web --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
        assert_eq!(plan.env.len(), 1);
        assert_eq!(plan.env[0].1, "ab12");
    }

    #[test]
    fn rejects_bad_env() {
        let config = cfg(LaunchMode::Npx, &[]);
        assert!(build_launch_plan(&config, &[("bad-key".into(), "v".into())], &[]).is_err());
        assert!(build_launch_plan(&config, &[("K".into(), "a\nb".into())], &[]).is_err());
    }

    #[test]
    fn launcher_args_precede_user_args() {
        let plan = build_spawn_plan_with_launcher_args(
            &cfg(LaunchMode::Npx, &["--no-open"]),
            &["--patch".into(), "C:\\x\\port-overlay.yml".into()],
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx --yes @deepseek-ai/dsh web --patch C:\\x\\port-overlay.yml --no-open"
                    .into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn launcher_args_wsl_placement() {
        let plan = build_spawn_plan_with_launcher_args(
            &cfg(
                LaunchMode::Wsl {
                    distro: "Ubuntu-24.04".into(),
                    inner: WSL_DEFAULT_INNER.into(),
                },
                &["--no-open"],
            ),
            &["--patch".into(), "/mnt/c/x/port-overlay.yml".into()],
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::Wsl {
                distro: "Ubuntu-24.04".into(),
                inner: "npx --yes @deepseek-ai/dsh web --patch /mnt/c/x/port-overlay.yml --no-open"
                    .into()
            }
        );
    }

    #[test]
    fn launcher_arg_rejects_shell_metachars() {
        for bad in ["a;b", "a&b", "a\"b", "$(x)", "a`b"] {
            assert!(
                build_spawn_plan_with_launcher_args(&cfg(LaunchMode::Npx, &[]), &[bad.into()])
                    .is_err(),
                "内部参数应拒绝元字符: {bad:?}"
            );
        }
        // 路径里的反斜杠与空格是允许的（Windows 路径必须能过）。
        assert!(build_spawn_plan_with_launcher_args(
            &cfg(LaunchMode::Npx, &[]),
            &["--patch".into(), "C:\\Program Files\\x.yml".into()]
        )
        .is_ok());
    }

    #[test]
    fn port_is_validated() {
        let mut config = cfg(LaunchMode::Npx, &[]);
        config.port = Some(0);
        assert!(validate(&config).is_err());
        config.port = Some(1);
        assert!(validate(&config).is_ok());
        config.port = Some(65535);
        assert!(validate(&config).is_ok());
    }

    #[test]
    fn port_round_trips_through_serde() {
        let mut config = cfg(LaunchMode::Npx, &["--no-open"]);
        config.port = Some(3099);
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("\"port\":3099"));
        let back: LaunchConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, config);
        // 旧配置（没有 port 字段）仍能反序列化。
        let legacy: LaunchConfig =
            serde_json::from_str(r#"{"mode":{"kind":"npx"},"extraArgs":[]}"#).unwrap();
        assert_eq!(legacy.port, None);
    }

    #[test]
    fn plugin_install_npx_plan() {
        let plan = build_plugin_plan(
            &cfg(LaunchMode::Npx, &[]),
            &PluginOp::Install {
                package: "file:/tmp/dsharbor-bridge-0.1.0.tgz".into(),
            },
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx --yes @deepseek-ai/dsh plugin --profile web add file:/tmp/dsharbor-bridge-0.1.0.tgz".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn plugin_uninstall_system_plan() {
        let plan = build_plugin_plan(
            &cfg(LaunchMode::System, &[]),
            &PluginOp::Uninstall {
                name: "dsharbor-bridge".into(),
            },
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "dsh plugin --profile web remove dsharbor-bridge".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn plugin_install_binary_cmd_is_script() {
        let plan = build_plugin_plan(
            &cfg(
                LaunchMode::Binary {
                    path: "C:\\Program Files\\dsh.cmd".into(),
                },
                &[],
            ),
            &PluginOp::Install {
                package: "file:C:/x/dsharbor-bridge-0.1.0.tgz".into(),
            },
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::Script {
                program: "C:\\Program Files\\dsh.cmd".into(),
                args: vec![
                    "plugin".into(),
                    "--profile".into(),
                    "web".into(),
                    "add".into(),
                    "file:C:/x/dsharbor-bridge-0.1.0.tgz".into()
                ]
            }
        );
    }

    #[test]
    fn plugin_install_wsl_drops_web_subcommand() {
        let plan = build_plugin_plan(
            &cfg(
                LaunchMode::Wsl {
                    distro: "Ubuntu-24.04".into(),
                    inner: WSL_DEFAULT_INNER.into(),
                },
                &[],
            ),
            &PluginOp::Install {
                package: "file:/mnt/c/Users/x/dsharbor-bridge-0.1.0.tgz".into(),
            },
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::Wsl {
                distro: "Ubuntu-24.04".into(),
                inner: "npx --yes @deepseek-ai/dsh plugin --profile web add file:/mnt/c/Users/x/dsharbor-bridge-0.1.0.tgz".into()
            }
        );
    }

    #[test]
    fn plugin_install_wsl_with_custom_inner() {
        let plan = build_plugin_plan(
            &cfg(
                LaunchMode::Wsl {
                    distro: "Ubuntu-24.04".into(),
                    inner: "dsh web".into(),
                },
                &[],
            ),
            &PluginOp::Uninstall {
                name: "dsharbor-bridge".into(),
            },
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::Wsl {
                distro: "Ubuntu-24.04".into(),
                inner: "dsh plugin --profile web remove dsharbor-bridge".into()
            }
        );
    }

    #[test]
    fn plugin_package_ref_rejects_injection() {
        for bad in ["file:a;reboot", "file:a&b", "file:a`b", "file:a$b"] {
            assert!(
                build_plugin_plan(
                    &cfg(LaunchMode::Npx, &[]),
                    &PluginOp::Install {
                        package: bad.into()
                    }
                )
                .is_err(),
                "应被拒绝：{bad}"
            );
        }
    }

    #[test]
    fn plugin_package_ref_rejects_space_in_file_spec() {
        // 回归（v0.1.0 实机缺陷）：安装目录含空格（D:\Program Files\DSHarbor）时，
        // pnpm 会把 `file:D:\Program` 当包名去 registry 查 → 404，安装必失败。
        let err = build_plugin_plan(
            &cfg(LaunchMode::Npx, &[]),
            &PluginOp::Install {
                package: "file:D:\\Program Files\\DSHarbor\\resources\\dsharbor-bridge-0.1.0.tgz"
                    .into(),
            },
        )
        .unwrap_err();
        assert!(err.contains("空格"), "错误信息应说明空格问题：{err}");
    }

    #[test]
    fn extracts_configured_port() {
        let args = |raw: &[&str]| raw.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            extract_configured_port(&args(&["--port", "3081"])),
            Some(3081)
        );
        assert_eq!(extract_configured_port(&args(&["--port=3082"])), Some(3082));
        assert_eq!(extract_configured_port(&args(&["--no-open"])), None);
        assert_eq!(extract_configured_port(&args(&["--port", "abc"])), None);
    }

    #[test]
    fn parses_dsh_version_output() {
        assert_eq!(
            parse_version_output("0.2.0-rc.2"),
            Some("0.2.0-rc.2".to_string())
        );
        // 行尾可能带回车（Windows 侧的 cmd / wsl.exe 输出）。
        assert_eq!(
            parse_version_output("v0.2.0\r\n"),
            Some("v0.2.0".to_string())
        );
        // 取最后一行：WSL 的登录脚本噪声排在版本号前面。
        assert_eq!(
            parse_version_output("Welcome to Ubuntu 24.04.1 LTS\n0.2.0-rc.2\n"),
            Some("0.2.0-rc.2".to_string())
        );
    }

    #[test]
    fn ignores_output_without_version() {
        assert_eq!(parse_version_output(""), None);
        assert_eq!(parse_version_output("Welcome to Ubuntu 24.04.1 LTS"), None);
        assert_eq!(parse_version_output("启动失败：找不到命令 dsh"), None);
        // 超长行不当版本号（防御乱码/日志刷屏）。
        assert_eq!(parse_version_output(&"1".repeat(65)), None);
    }
}
