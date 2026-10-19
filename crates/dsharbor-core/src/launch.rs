//! 启动器纯逻辑：启动方式与运行环境的配置模型、输入校验与命令构造。
//!
//! 为什么这些放在核心库而不是外壳：命令构造（尤其是经 shell 拼接的命令行）
//! 是最容易出安全问题的部分，放这里后可以在开发机上全自动测试，
//! 覆盖注入防护、跨系统参数拼接等边界。

use serde::{Deserialize, Serialize};

/// npx 的固定前缀。
/// `--yes`：npx 首次下载包时会交互确认；壳的子进程没有终端，不加会直接卡住。
pub const NPX_PREFIX: &str = "npx --yes";
/// DSH 包名。渠道 / 版本以 npm 规格的形式接在后面（`@deepseek-ai/dsh@next`）。
pub const NPX_PACKAGE: &str = "@deepseek-ai/dsh";
/// 默认环境名。
///
/// DSH 的命令行把「启动哪个环境」做成了位置参数：`dsh web` 等价于
/// `dsh --profile web`。所以这个位置放的是**环境名**，不是固定的子命令——
/// 用户切到别的环境时，壳把它换成那个环境名。
pub const WEB_SUBCOMMAND: &str = "web";
/// 已下线的「通过 WSL 启动」模式的默认内部命令。
/// 只在迁移旧配置时用来判断该还原成「官方 npx（latest）」还是「自定义命令」。
pub const LEGACY_WSL_INNER: &str = "npx --yes @deepseek-ai/dsh web";
/// 壳为每次 DSH 启动追加的应用参数：禁用 DSH 自带的「启动后打开系统浏览器」。
/// 需求：DSH 界面只出现在壳自己的窗口里（点「打开 DSH 界面」），不调用用户安装的
/// 浏览器（浏览器占内存大）。DSH 默认 openBrowser=true 会自己拉一次默认浏览器，
/// 必须显式关掉；用户附加参数里已写了 `--no-open` 时不重复追加。
pub const DEFAULT_APP_ARGS: [&str; 1] = ["--no-open"];
/// 系统命令前缀（不含子命令）。
pub const SYSTEM_DSH: &str = "dsh";
/// 默认环境名（DSH 自带的 `web` 环境）。首次启动与配置缺项时用它。
pub const PROFILE_NAME: &str = WEB_SUBCOMMAND;
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

/// 运行环境：在 Windows 宿主上执行，还是进某个 WSL 发行版里执行。
///
/// 从 `LaunchMode` 里提出来单独一层：它回答的是「在哪儿执行」，与「执行什么」
/// 正交。界面上「官方 npx 命令」与「自定义命令」两块共用同一个选择，切换启动
/// 方式不会把用户刚选好的发行版弄丢。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Runtime {
    /// Windows 宿主（默认）。
    #[default]
    Default,
    /// 经 wsl.exe 在发行版内部执行。
    Wsl { distro: String },
}

/// npm 渠道。
/// latest / next 是 npm 的 dist-tag，直接跟标签即可；rc / alpha 不是标签而是
/// 版本范围（npm 上没有 rc 标签），这两条渠道必须由版本下拉给出具体版本号。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    Latest,
    Next,
    Rc,
    Alpha,
}

/// 启动方式（对应配置界面上的四个选项）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LaunchMode {
    /// 官方 npx 命令（未全局安装 DSH 时最省事）。
    /// `version` 只对 Rc / Alpha 有意义：Latest / Next 跟的是 dist-tag。
    Npx {
        channel: Channel,
        #[serde(default)]
        version: Option<String>,
    },
    /// 系统 PATH 里的 dsh 命令。
    System,
    /// 指定可执行文件/脚本的绝对路径。
    Binary { path: String },
    /// 自定义命令：整条启动命令行由用户自己写（例如 `npx @deepseek-ai/dsh@next web`）。
    /// 适合官方 npx / 系统命令两种内置写法覆盖不到的场景（指定版本标签、包管理器
    /// 不同、包装脚本等）。壳仍会在末尾追加附加参数与 `--no-open`。
    Custom { command: String },
}

/// 完整启动配置。
///
/// 反序列化走 `LaunchConfigRaw`：旧版本存下来的配置里有已经删掉的
/// `kind:"wsl"` 启动方式、也没有 `channel` / `runtime` 字段，迁移规则集中在
/// `From<LaunchConfigRaw>` 一处，读到旧配置就自动升级成新形态（不主动回写磁盘，
/// 下一次正常保存自然写成新结构）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "LaunchConfigRaw", rename_all = "camelCase")]
pub struct LaunchConfig {
    pub mode: LaunchMode,
    /// 在哪个环境里执行。只对 `Npx` / `Custom` 生效：「系统全局命令」与
    /// 「指定程序路径」的语义本身就是 Windows 侧的 `dsh` / `.exe` / `.cmd`，
    /// 把它们放进发行版没有意义（界面上也不给这两块显示运行环境选择）。
    pub runtime: Runtime,
    /// 追加到启动命令末尾的额外参数（逐 token 校验）。
    #[serde(default)]
    pub extra_args: Vec<String>,
    /// 端口覆盖：None = 跟随 DSH 自身配置（托管值）；Some(P) = 壳注入
    /// launcher 层 patch，把 webserver 端口覆盖为 P（不改用户任何文件）。
    #[serde(default)]
    pub port: Option<u16>,
}

/// 反序列化用的中间形态：字段全部可选，且认得出已删除的 `kind:"wsl"`。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchConfigRaw {
    mode: LaunchModeRaw,
    #[serde(default)]
    runtime: Option<Runtime>,
    #[serde(default)]
    extra_args: Vec<String>,
    #[serde(default)]
    port: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum LaunchModeRaw {
    Npx {
        #[serde(default)]
        channel: Option<Channel>,
        #[serde(default)]
        version: Option<String>,
    },
    System,
    Binary {
        path: String,
    },
    Custom {
        command: String,
    },
    /// 已下线：旧版本的第五种启动方式。
    Wsl {
        distro: String,
        inner: String,
    },
}

impl From<LaunchConfigRaw> for LaunchConfig {
    fn from(raw: LaunchConfigRaw) -> Self {
        let mut runtime = raw.runtime.unwrap_or_default();
        let mode = match raw.mode {
            // 旧配置没有 channel：当年这个选项的行为就是 npx 的 latest。
            LaunchModeRaw::Npx { channel, version } => LaunchMode::Npx {
                channel: channel.unwrap_or(Channel::Latest),
                version,
            },
            LaunchModeRaw::System => LaunchMode::System,
            LaunchModeRaw::Binary { path } => LaunchMode::Binary { path },
            LaunchModeRaw::Custom { command } => LaunchMode::Custom { command },
            LaunchModeRaw::Wsl { distro, inner } => {
                // 旧的「通过 WSL 启动」= 运行环境 + 一条发行版内部命令。
                // 内部命令还是官方默认值就还原成「官方 npx（latest）」（这样用户
                // 还能正常改渠道），否则按自定义命令原样保留。
                runtime = Runtime::Wsl { distro };
                if inner.trim() == LEGACY_WSL_INNER {
                    LaunchMode::Npx {
                        channel: Channel::Latest,
                        version: None,
                    }
                } else {
                    LaunchMode::Custom { command: inner }
                }
            }
        };
        LaunchConfig {
            mode,
            runtime,
            extra_args: raw.extra_args,
            port: raw.port,
        }
    }
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
/// `profile` 是当前选中的环境名，经校验后作为位置参数传给 DSH。
pub fn build_launch_plan(
    config: &LaunchConfig,
    profile: &str,
    env: &[(String, String)],
    launcher_args: &[String],
) -> Result<LaunchPlan, String> {
    validate_env(env)?;
    Ok(LaunchPlan {
        spawn: build_spawn_plan_with_launcher_args(config, profile, launcher_args)?,
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
pub fn validate_distro(distro: &str) -> Result<(), String> {
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

/// 界面「浏览…」选完文件、或输入框失焦时的即时校验：先走启动时那套格式校验（文案一致），
/// 再确认文件存在且不是目录。启动流程仍会独立校验一次，这里只是把反馈提前。
pub fn check_binary_path(path: &str) -> Result<(), String> {
    validate_binary_path(path)?;
    let meta = std::fs::metadata(path).map_err(|_| format!("找不到该文件：{path}"))?;
    if meta.is_dir() {
        return Err(format!("这是一个目录，不是可执行文件：{path}"));
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
        LaunchMode::Npx { channel, version } => {
            match (channel, version) {
                (Channel::Latest | Channel::Next, Some(_)) => {
                    return Err("稳定版与最新尝鲜版跟的是 npm 标签，不能另指定版本号".into())
                }
                (Channel::Rc | Channel::Alpha, Some(version)) => validate_version(version)?,
                (Channel::Rc | Channel::Alpha, None) => {
                    return Err("这条渠道要先选一个具体版本号".into())
                }
                (Channel::Latest | Channel::Next, None) => {}
            };
            // 运行环境只对 npx / 自定义命令有意义；其余两种界面不给选，
            // 但读到一份带了 WSL 运行环境的旧配置时仍要能跑。
            if let Runtime::Wsl { distro } = &config.runtime {
                validate_distro(distro)?;
            }
            Ok(())
        }
        LaunchMode::System => Ok(()),
        LaunchMode::Binary { path } => validate_binary_path(path),
        LaunchMode::Custom { command } => {
            let tokens = split_line(command);
            if tokens.is_empty() {
                return Err("自定义命令不能为空".into());
            }
            // 与附加参数同一套白名单：不许引号、管道、重定向等 shell 元字符，
            // 这条命令会经 cmd /C 执行，留口子等于把注入面交给用户输入。
            for token in &tokens {
                validate_argument(token)?;
            }
            if let Runtime::Wsl { distro } = &config.runtime {
                validate_distro(distro)?;
            }
            Ok(())
        }
    }
}

/// 校验具体版本号：只允许 semver 字符，防止把 `@1.0 && rm -rf` 拼进命令行。
fn validate_version(version: &str) -> Result<(), String> {
    if version.is_empty() || version.len() > 64 {
        return Err("版本号不能为空且不超过 64 字符".into());
    }
    if let Some(bad) = version
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_')))
    {
        return Err(format!("版本号包含不允许的字符 {bad:?}：{version}"));
    }
    Ok(())
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
pub fn build_spawn_plan(config: &LaunchConfig, profile: &str) -> Result<SpawnPlan, String> {
    build_spawn_plan_with_launcher_args(config, profile, &[])
}

/// 官方 npx 命令的包规格：跟 dist-tag 的渠道不加后缀，rc/alpha 跟具体版本号。
pub fn npx_spec(channel: Channel, version: Option<&str>) -> String {
    let suffix = match channel {
        Channel::Latest => String::new(),
        Channel::Next => "@next".to_string(),
        Channel::Rc | Channel::Alpha => match version {
            Some(version) => format!("@{version}"),
            // 没选版本时给个占位，让界面能提前展示命令形态；校验会拦下来。
            None => "@<版本>".to_string(),
        },
    };
    format!("{NPX_PACKAGE}{suffix}")
}

/// 完整 npx 启动命令（含环境名位置参数）。
pub fn npx_web_command(channel: Channel, version: Option<&str>, profile: &str) -> String {
    format!("{NPX_PREFIX} {} {profile}", npx_spec(channel, version))
}

/// 目标环境内要执行的东西：一整行 shell 命令行，或一个直接拉起的程序。
enum BasePlan {
    Line(String),
    Program { program: String, args: Vec<String> },
}

impl BasePlan {
    fn line(tokens: &[String]) -> Self {
        BasePlan::Line(join_shell_line(tokens))
    }
}

/// 这个启动方式实际生效的运行环境。
///
/// 「系统全局命令」与「指定程序路径」固定跑在 Windows 宿主上：界面不给它们选
/// 运行环境，`dsh` 与用户挑的 `.exe` 也都在 Windows 侧。否则用户在「官方 npx」
/// 选了 WSL 再切到「系统全局命令」，就会在发行版里跑 `dsh web`——发行版里未必
/// 装了它，界面上也看不到那个选择。
///
/// 这是「实际生效」的运行环境。外壳判断插件目标环境与探测地址时必须用它，
/// 不要直接读 `config.runtime`：配置文件里可能残留着旧启动方式下的 WSL 值。
pub fn runtime_of(config: &LaunchConfig) -> &Runtime {
    match &config.mode {
        LaunchMode::Npx { .. } | LaunchMode::Custom { .. } => &config.runtime,
        LaunchMode::System | LaunchMode::Binary { .. } => &Runtime::Default,
    }
}

/// 按运行环境把命令包成最终的 `SpawnPlan`。
///
/// 只有 shell 行会被 WSL 包起来；`BasePlan::Program`（「指定程序路径」）只走
/// `Direct` / `Script`——用户填的是 Windows 侧的 `.exe` / `.cmd` 绝对路径，
/// 放进发行版没有意义。调用方对固定跑在 Windows 上的启动方式传入
/// `Runtime::Default`，所以这里只按传入值处理。
fn wrap_plan(runtime: &Runtime, base: BasePlan) -> SpawnPlan {
    match (runtime, base) {
        (Runtime::Wsl { distro }, BasePlan::Line(inner)) => SpawnPlan::Wsl {
            distro: distro.clone(),
            inner,
        },
        (_, BasePlan::Line(line)) => SpawnPlan::ShellLine {
            line,
            wrap: ShellWrap::Cmd,
        },
        (_, BasePlan::Program { program, args }) => {
            if is_script_path(&program) {
                // .cmd/.bat 经解释器执行；路径与参数分开传递，不拼整行字符串。
                SpawnPlan::Script { program, args }
            } else {
                SpawnPlan::Direct { program, args }
            }
        }
    }
}

/// 构造启动计划，并在用户附加参数之前插入壳内部的 launcher 层参数。
///
/// 顺序很关键：DSH 启动器只解析命令行**头部**自己的旗标（`--patch` 等），
/// 遇到第一个应用参数就停——所以内部参数必须排在用户附加参数（app 参数）前面。
///
/// `profile` 是当前选中的环境名，插在包规格后面作为位置参数（`dsh web` 里的那个位置）。
/// 名字先经 `profiles::validate_name` 校验：非法时直接报错，**不静默回退成默认环境**
/// （静默回退会让用户以为切了、其实没切）。
pub fn build_spawn_plan_with_launcher_args(
    config: &LaunchConfig,
    profile: &str,
    launcher_args: &[String],
) -> Result<SpawnPlan, String> {
    validate(config)?;
    crate::profiles::validate_name(profile)?;
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
    let base = match &config.mode {
        LaunchMode::Npx { channel, version } => {
            let mut tokens = split_line(&npx_web_command(*channel, version.as_deref(), profile));
            tokens.extend(extra.iter().cloned());
            BasePlan::line(&tokens)
        }
        LaunchMode::System => {
            let mut tokens = vec![SYSTEM_DSH.to_string(), profile.to_string()];
            tokens.extend(extra.iter().cloned());
            BasePlan::line(&tokens)
        }
        LaunchMode::Binary { path } => {
            let mut args: Vec<String> = vec![profile.to_string()];
            args.extend(extra.iter().cloned());
            BasePlan::Program {
                program: path.clone(),
                args,
            }
        }
        // 自定义命令原样透传：用户可能已经写了 `dsh --profile lab web`
        // 或别的子命令，壳再插一个环境名会改坏语义。
        LaunchMode::Custom { command } => {
            let mut tokens = split_line(command);
            tokens.extend(extra.iter().cloned());
            BasePlan::line(&tokens)
        }
    };
    Ok(wrap_plan(runtime_of(config), base))
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
    /// 安装该环境声明的全部依赖（`dsh plugin --profile <名字> install`）。
    /// 新建 / 复制出来的环境没有依赖，靠它补齐。
    InstallDeps,
}

/// 构造插件管理命令：复用当前启动方式的前缀，但把环境名位置参数换成
/// `plugin --profile <环境名> <add|remove> ...`（官方插件机制，会自动登记/摘除
/// `dsh.profile.bundles`，不手工编辑用户配置）。
///
/// 插件操作永远作用于当前选中的环境，不再固定某一个。
pub fn build_plugin_plan(
    config: &LaunchConfig,
    profile: &str,
    op: &PluginOp,
) -> Result<SpawnPlan, String> {
    validate(config)?;
    crate::profiles::validate_name(profile)?;
    let mut args: Vec<String> = vec!["plugin".into(), "--profile".into(), profile.to_string()];
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
        // `dsh plugin` 把参数转发给 pnpm，所以 `install` 就是 pnpm 的安装。
        PluginOp::InstallDeps => args.push("install".into()),
    }
    Ok(match &config.mode {
        LaunchMode::Npx { channel, version } => {
            // 插件必须装到与启动同一个包/版本上：npx@next 启动时插件也要装进 next。
            let mut tokens = split_line(&format!(
                "{NPX_PREFIX} {}",
                npx_spec(*channel, version.as_deref())
            ));
            tokens.extend(args);
            wrap_plan(&config.runtime, BasePlan::line(&tokens))
        }
        LaunchMode::System => {
            let mut tokens = split_line(SYSTEM_DSH);
            tokens.extend(args);
            wrap_plan(runtime_of(config), BasePlan::line(&tokens))
        }
        LaunchMode::Binary { path } => wrap_plan(
            runtime_of(config),
            BasePlan::Program {
                program: path.clone(),
                args,
            },
        ),
        LaunchMode::Custom { command } => {
            let mut tokens = plugin_prefix(command, profile);
            tokens.extend(args);
            wrap_plan(&config.runtime, BasePlan::line(&tokens))
        }
    })
}

/// 去掉末尾的环境名位置参数，得到插件管理前缀。
///
/// 自定义命令与 WSL 内部命令都遵循 DSH 的 `<启动器> <环境名> [参数]` 写法
/// （界面上的默认值与示例都是），所以换个子命令就能复用同一个启动器：
/// 版本标签（`@next`）、包管理器、发行版内的 PATH 全部保持不变。
fn plugin_prefix(inner: &str, profile: &str) -> Vec<String> {
    let mut tokens = split_line(inner);
    if tokens.last().map(|token| token == profile).unwrap_or(false) {
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

/// 从附加参数里找用户显式指定的绑定地址（`--host 192.168.1.7` 或 `--host=…`）。
///
/// 为什么壳要看它：DSH 的 `--host` 会覆盖 profile 里的 webserver 绑定地址，
/// 壳若只按 profile 探测就会探错地址、误判端口空闲（重复拉起仍是 EADDRINUSE）。
pub fn extract_configured_host(args: &[String]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--host" {
            if let Some(value) = iter.next() {
                return Some(value.to_string());
            }
        } else if let Some(value) = arg.strip_prefix("--host=") {
            return Some(value.to_string());
        }
    }
    None
}

/// 附加参数里是否要求了 TLS（`--tls-cert` / `--tls-key`）。
///
/// 壳的探测与桥接都是明文 HTTP；一旦开了 TLS 就连不上、只能给用户一句
/// 「本壳暂不支持 TLS」的明确提示，而不是含糊的「端口被其他程序占用」。
pub fn has_tls_args(args: &[String]) -> bool {
    args.iter().any(|arg| {
        arg == "--tls-cert"
            || arg == "--tls-key"
            || arg.starts_with("--tls-cert=")
            || arg.starts_with("--tls-key=")
    })
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
            runtime: Runtime::Default,
            extra_args: extra.iter().map(|s| s.to_string()).collect(),
            port: None,
        }
    }

    fn npx(channel: Channel, version: Option<&str>) -> LaunchMode {
        LaunchMode::Npx {
            channel,
            version: version.map(str::to_string),
        }
    }

    fn wsl(distro: &str) -> Runtime {
        Runtime::Wsl {
            distro: distro.into(),
        }
    }

    fn wsl_cfg(mode: LaunchMode, extra: &[&str], distro: &str) -> LaunchConfig {
        let mut config = cfg(mode, extra);
        config.runtime = wsl(distro);
        config
    }

    #[test]
    fn npx_latest_plan() {
        let plan = build_spawn_plan(&cfg(npx(Channel::Latest, None), &[]), PROFILE_NAME).unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx --yes @deepseek-ai/dsh web --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn npx_next_uses_dist_tag() {
        let plan = build_spawn_plan(&cfg(npx(Channel::Next, None), &[]), PROFILE_NAME).unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx --yes @deepseek-ai/dsh@next web --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn npx_rc_pins_exact_version() {
        let plan = build_spawn_plan(
            &cfg(npx(Channel::Rc, Some("0.2.1-rc.2")), &[]),
            PROFILE_NAME,
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx --yes @deepseek-ai/dsh@0.2.1-rc.2 web --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn npx_channel_version_rules() {
        // rc/alpha 没有对应 dist-tag，必须带版本号；latest/next 反过来不许带。
        assert!(validate(&cfg(npx(Channel::Rc, None), &[])).is_err());
        assert!(validate(&cfg(npx(Channel::Alpha, None), &[])).is_err());
        assert!(validate(&cfg(npx(Channel::Latest, Some("0.2.0-rc.2")), &[])).is_err());
        assert!(validate(&cfg(npx(Channel::Next, Some("0.2.1-rc.2")), &[])).is_err());
        assert!(validate(&cfg(npx(Channel::Alpha, Some("0.2.1-alpha.5")), &[])).is_ok());
    }

    #[test]
    fn npx_version_rejects_injection() {
        for bad in ["1.0; rm -rf /", "1.0 && x", "a b", "0.1.0\nwhoami"] {
            assert!(
                build_spawn_plan(&cfg(npx(Channel::Rc, Some(bad)), &[]), PROFILE_NAME).is_err(),
                "应被拒绝: {bad:?}"
            );
        }
        // 空版本号也不行（否则拼出 `@` 结尾的无意义规格）。
        assert!(build_spawn_plan(&cfg(npx(Channel::Rc, Some("")), &[]), PROFILE_NAME).is_err());
    }

    #[test]
    fn npx_spec_and_command_for_ui() {
        assert_eq!(npx_spec(Channel::Latest, None), "@deepseek-ai/dsh");
        assert_eq!(npx_spec(Channel::Next, None), "@deepseek-ai/dsh@next");
        assert_eq!(
            npx_spec(Channel::Rc, Some("0.2.1-rc.2")),
            "@deepseek-ai/dsh@0.2.1-rc.2"
        );
        assert_eq!(
            npx_web_command(Channel::Latest, None, PROFILE_NAME),
            "npx --yes @deepseek-ai/dsh web"
        );
    }

    #[test]
    fn npx_with_extra_args() {
        let plan = build_spawn_plan(
            &cfg(npx(Channel::Latest, None), &["--port", "3081", "--no-open"]),
            PROFILE_NAME,
        )
        .unwrap();
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
        let plan = build_spawn_plan(&cfg(LaunchMode::System, &[]), PROFILE_NAME).unwrap();
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
        let plan = build_spawn_plan(
            &cfg(
                LaunchMode::Binary {
                    path: "D:\\tools\\dsh.exe".into(),
                },
                &["--port", "3082"],
            ),
            PROFILE_NAME,
        )
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
        let plan = build_spawn_plan(
            &cfg(
                LaunchMode::Binary {
                    path: "C:\\Program Files\\dsh.cmd".into(),
                },
                &[],
            ),
            PROFILE_NAME,
        )
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
    fn custom_command_plan() {
        // 用户示例：固定版本标签的启动命令，壳在末尾补 --no-open。
        let plan = build_spawn_plan(
            &cfg(
                LaunchMode::Custom {
                    command: "npx @deepseek-ai/dsh@next web".into(),
                },
                &[],
            ),
            PROFILE_NAME,
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx @deepseek-ai/dsh@next web --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn custom_command_keeps_extra_args_and_rejects_injection() {
        let plan = build_spawn_plan(
            &cfg(
                LaunchMode::Custom {
                    command: "pnpm dlx @deepseek-ai/dsh web".into(),
                },
                &["--port", "3081"],
            ),
            PROFILE_NAME,
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "pnpm dlx @deepseek-ai/dsh web --port 3081 --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
        // 自定义命令同样要过白名单：引号、管道、重定向一律拒绝。
        for bad in ["npx dsh web; rm -rf /", "npx dsh \"web\"", "npx dsh | more"] {
            assert!(
                build_spawn_plan(
                    &cfg(
                        LaunchMode::Custom {
                            command: bad.into()
                        },
                        &[]
                    ),
                    PROFILE_NAME
                )
                .is_err(),
                "应被拒绝: {bad:?}"
            );
        }
        assert!(build_spawn_plan(
            &cfg(
                LaunchMode::Custom {
                    command: "   ".into()
                },
                &[]
            ),
            PROFILE_NAME
        )
        .is_err());
    }

    #[test]
    fn custom_command_plugin_plan_swaps_web_subcommand() {
        // 插件管理复用同一启动器：只把末尾的 web 换成 plugin --profile web add。
        let plan = build_plugin_plan(
            &cfg(
                LaunchMode::Custom {
                    command: "npx @deepseek-ai/dsh@next web".into(),
                },
                &[],
            ),
            PROFILE_NAME,
            &PluginOp::Install {
                package: "file:C:/tmp/x.tgz".into(),
            },
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx @deepseek-ai/dsh@next plugin --profile web add file:C:/tmp/x.tgz".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn wsl_runtime_wraps_npx_line() {
        let mut config = cfg(npx(Channel::Latest, None), &[]);
        config.runtime = wsl("Ubuntu-24.04");
        let plan = build_spawn_plan(&config, PROFILE_NAME).unwrap();
        assert_eq!(
            plan,
            SpawnPlan::Wsl {
                distro: "Ubuntu-24.04".into(),
                inner: "npx --yes @deepseek-ai/dsh web --no-open".into()
            }
        );
    }

    #[test]
    fn wsl_runtime_with_custom_command() {
        let mut config = cfg(
            LaunchMode::Custom {
                command: "dsh web".into(),
            },
            &["--port", "3083"],
        );
        config.runtime = wsl("Debian");
        let plan = build_spawn_plan(&config, PROFILE_NAME).unwrap();
        assert_eq!(
            plan,
            SpawnPlan::Wsl {
                distro: "Debian".into(),
                inner: "dsh web --port 3083 --no-open".into()
            }
        );
    }

    #[test]
    fn wsl_runtime_keeps_channel() {
        // 渠道与运行环境正交：发行版里也能跑 next / 固定版本。
        let mut config = cfg(npx(Channel::Rc, Some("0.2.1-rc.2")), &[]);
        config.runtime = wsl("Ubuntu");
        match build_spawn_plan(&config, PROFILE_NAME).unwrap() {
            SpawnPlan::Wsl { inner, .. } => {
                assert_eq!(inner, "npx --yes @deepseek-ai/dsh@0.2.1-rc.2 web --no-open")
            }
            other => panic!("unexpected plan: {other:?}"),
        }
    }

    #[test]
    fn binary_mode_ignores_wsl_runtime() {
        // 「指定程序路径」在界面里不给选运行环境；即使读到一份带了 WSL
        // 运行环境的配置，也按 Windows 侧直接拉起（否则 wsl.exe 会把
        // `D:\tools\dsh.exe` 当成发行版内的路径）。
        let mut config = cfg(
            LaunchMode::Binary {
                path: "D:\\tools\\dsh.exe".into(),
            },
            &[],
        );
        config.runtime = wsl("Ubuntu");
        assert_eq!(
            build_spawn_plan(&config, PROFILE_NAME).unwrap(),
            SpawnPlan::Direct {
                program: "D:\\tools\\dsh.exe".into(),
                args: vec!["web".into(), "--no-open".into()]
            }
        );
    }

    #[test]
    fn system_mode_ignores_wsl_runtime() {
        // 「系统全局命令」同样固定跑在 Windows 宿主上（界面不给选运行环境）。
        // 用户在「官方 npx」选了 WSL 后再切到「系统全局命令」，不能在发行版里跑
        // `dsh web`——发行版里的 `dsh` 未必存在，用户也看不到那个选择。
        let mut config = cfg(LaunchMode::System, &[]);
        config.runtime = wsl("Ubuntu");
        assert_eq!(
            build_spawn_plan(&config, PROFILE_NAME).unwrap(),
            SpawnPlan::ShellLine {
                line: "dsh web --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn runtime_of_reports_effective_runtime() {
        // 外壳判断插件目标环境与探测地址都走这个公开函数。System / Binary
        // 即使配置里残留 WSL 运行环境也恒为 Windows 宿主；Npx / Custom 则原样
        // 返回用户选的运行环境。
        for mode in [
            LaunchMode::System,
            LaunchMode::Binary {
                path: "D:\\tools\\dsh.exe".into(),
            },
        ] {
            let mut config = cfg(mode, &[]);
            config.runtime = wsl("Ubuntu");
            assert_eq!(runtime_of(&config), &Runtime::Default);
        }

        for mode in [
            npx(Channel::Latest, None),
            LaunchMode::Custom {
                command: "dsh web".into(),
            },
        ] {
            let mut config = cfg(mode, &[]);
            config.runtime = wsl("Ubuntu");
            assert_eq!(runtime_of(&config), &config.runtime);
        }
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
            let err = build_spawn_plan(&cfg(npx(Channel::Latest, None), &[bad]), PROFILE_NAME);
            assert!(err.is_err(), "注入样例应被拒绝: {bad:?}");
        }
    }

    #[test]
    fn rejects_malformed_args() {
        for bad in ["", " leading", "trailing ", "中文参数"] {
            assert!(
                build_spawn_plan(&cfg(npx(Channel::Latest, None), &[bad]), PROFILE_NAME).is_err(),
                "应被拒绝: {bad:?}"
            );
        }
    }

    #[test]
    fn arg_with_inner_space_is_quoted() {
        let plan =
            build_spawn_plan(&cfg(npx(Channel::Latest, None), &["a b"]), PROFILE_NAME).unwrap();
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
        let plan = build_spawn_plan(&cfg(npx(Channel::Latest, None), &[]), PROFILE_NAME).unwrap();
        match plan {
            SpawnPlan::ShellLine { line, .. } => assert!(line.ends_with(" --no-open"), "{line}"),
            other => panic!("unexpected plan: {other:?}"),
        }
        // 用户自己写了 --no-open 时不重复。
        let plan = build_spawn_plan(
            &cfg(npx(Channel::Latest, None), &["--no-open"]),
            PROFILE_NAME,
        )
        .unwrap();
        match plan {
            SpawnPlan::ShellLine { line, .. } => {
                assert_eq!(line.matches("--no-open").count(), 1, "{line}")
            }
            other => panic!("unexpected plan: {other:?}"),
        }
    }

    #[test]
    fn rejects_bad_paths() {
        assert!(build_spawn_plan(
            &cfg(
                LaunchMode::Binary {
                    path: "dsh.exe".into()
                },
                &[]
            ),
            PROFILE_NAME
        )
        .is_err());
        assert!(build_spawn_plan(
            &cfg(
                LaunchMode::Binary {
                    path: "D:\\tools\\dsh.sh".into()
                },
                &[]
            ),
            PROFILE_NAME
        )
        .is_err());
        assert!(build_spawn_plan(
            &cfg(
                LaunchMode::Binary {
                    path: "D:\\tools\\d\"sh.exe".into()
                },
                &[]
            ),
            PROFILE_NAME
        )
        .is_err());
        assert!(build_spawn_plan(
            &cfg(
                LaunchMode::Binary {
                    path: "D:\\100%\\dsh.exe".into()
                },
                &[]
            ),
            PROFILE_NAME
        )
        .is_err());
    }

    #[test]
    fn check_binary_path_reports_missing_dir_and_file() {
        let dir = std::env::temp_dir().join("dsharbor-check-binary-path");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("dsh.exe");
        std::fs::write(&file, b"stub").unwrap();
        // 存在的普通文件：通过。
        assert!(check_binary_path(file.to_str().unwrap()).is_ok());
        // 目录：形状合法（.exe 结尾）但不是文件。
        let dir_like_file = dir.join("dsh-dir.exe");
        std::fs::create_dir_all(&dir_like_file).unwrap();
        let err = check_binary_path(dir_like_file.to_str().unwrap()).unwrap_err();
        assert!(err.contains("目录"), "意外文案：{err}");
        // 不存在的文件。
        let err = check_binary_path(dir.join("nope.exe").to_str().unwrap()).unwrap_err();
        assert!(err.contains("找不到"), "意外文案：{err}");
        // 格式不合规（非绝对路径）沿用启动时的同一套文案。
        let err = check_binary_path("dsh.exe").unwrap_err();
        assert!(err.contains("完整路径"), "意外文案：{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_bad_distro() {
        assert!(build_spawn_plan(
            &wsl_cfg(npx(Channel::Latest, None), &[], "a b"),
            PROFILE_NAME
        )
        .is_err());
        assert!(
            build_spawn_plan(&wsl_cfg(npx(Channel::Latest, None), &[], ""), PROFILE_NAME).is_err()
        );
        // 自定义命令为空同样被拦（与运行环境无关）。
        assert!(build_spawn_plan(
            &wsl_cfg(
                LaunchMode::Custom {
                    command: "  ".into()
                },
                &[],
                "ok"
            ),
            PROFILE_NAME
        )
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
            &cfg(npx(Channel::Latest, None), &[]),
            PROFILE_NAME,
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
        let config = cfg(npx(Channel::Latest, None), &[]);
        assert!(build_launch_plan(
            &config,
            PROFILE_NAME,
            &[("bad-key".into(), "v".into())],
            &[]
        )
        .is_err());
        assert!(
            build_launch_plan(&config, PROFILE_NAME, &[("K".into(), "a\nb".into())], &[]).is_err()
        );
    }

    #[test]
    fn launcher_args_precede_user_args() {
        let plan = build_spawn_plan_with_launcher_args(
            &cfg(npx(Channel::Latest, None), &["--no-open"]),
            PROFILE_NAME,
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
            &wsl_cfg(npx(Channel::Latest, None), &["--no-open"], "Ubuntu-24.04"),
            PROFILE_NAME,
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
                build_spawn_plan_with_launcher_args(
                    &cfg(npx(Channel::Latest, None), &[]),
                    PROFILE_NAME,
                    &[bad.into()]
                )
                .is_err(),
                "内部参数应拒绝元字符: {bad:?}"
            );
        }
        // 路径里的反斜杠与空格是允许的（Windows 路径必须能过）。
        assert!(build_spawn_plan_with_launcher_args(
            &cfg(npx(Channel::Latest, None), &[]),
            PROFILE_NAME,
            &["--patch".into(), "C:\\Program Files\\x.yml".into()]
        )
        .is_ok());
    }

    #[test]
    fn port_is_validated() {
        let mut config = cfg(npx(Channel::Latest, None), &[]);
        config.port = Some(0);
        assert!(validate(&config).is_err());
        config.port = Some(1);
        assert!(validate(&config).is_ok());
        config.port = Some(65535);
        assert!(validate(&config).is_ok());
    }

    #[test]
    fn port_round_trips_through_serialization() {
        let mut config = cfg(npx(Channel::Latest, None), &["--no-open"]);
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
    fn runtime_and_channel_round_trip_through_serde() {
        let mut config = cfg(npx(Channel::Alpha, Some("0.2.1-alpha.5")), &[]);
        config.runtime = wsl("Ubuntu-24.04");
        let json = serde_json::to_string(&config).unwrap();
        // 前端按 camelCase 读；runtime 是独立一层，不再藏在 mode 里。
        assert!(
            json.contains(r#""runtime":{"kind":"wsl","distro":"Ubuntu-24.04"}"#),
            "{json}"
        );
        assert!(
            json.contains(r#""mode":{"kind":"npx","channel":"alpha","version":"0.2.1-alpha.5"}"#),
            "{json}"
        );
        assert_eq!(serde_json::from_str::<LaunchConfig>(&json).unwrap(), config);
        // latest 不写 version 时也是合法输入。
        let parsed: LaunchConfig =
            serde_json::from_str(r#"{"mode":{"kind":"npx","channel":"latest"}}"#).unwrap();
        assert_eq!(parsed.mode, npx(Channel::Latest, None));
        assert_eq!(parsed.runtime, Runtime::Default);
    }

    #[test]
    fn migrates_legacy_configs() {
        // v0.3.x 存的配置没有 runtime / channel：补上默认值。
        let legacy: LaunchConfig =
            serde_json::from_str(r#"{"mode":{"kind":"npx"},"extraArgs":["--port","3099"]}"#)
                .unwrap();
        assert_eq!(legacy.mode, npx(Channel::Latest, None));
        assert_eq!(legacy.runtime, Runtime::Default);
        assert_eq!(legacy.extra_args, vec!["--port", "3099"]);

        // 旧的「通过 WSL 启动」+ 官方默认内部命令 → 官方 npx（latest）+ WSL 运行环境。
        let legacy: LaunchConfig = serde_json::from_str(&format!(
            r#"{{"mode":{{"kind":"wsl","distro":"Ubuntu","inner":"{LEGACY_WSL_INNER}"}}}}"#
        ))
        .unwrap();
        assert_eq!(legacy.mode, npx(Channel::Latest, None));
        assert_eq!(legacy.runtime, wsl("Ubuntu"));
        // 迁移结果必须是可直接启动的：拼出来的就是发行版里跑 npx latest。
        assert_eq!(
            build_spawn_plan(&legacy, PROFILE_NAME).unwrap(),
            SpawnPlan::Wsl {
                distro: "Ubuntu".into(),
                inner: "npx --yes @deepseek-ai/dsh web --no-open".into()
            }
        );

        // 旧的「通过 WSL 启动」+ 自定义内部命令 → 自定义命令 + WSL 运行环境。
        let legacy: LaunchConfig =
            serde_json::from_str(r#"{"mode":{"kind":"wsl","distro":"Debian","inner":"dsh web"}}"#)
                .unwrap();
        assert_eq!(
            legacy.mode,
            LaunchMode::Custom {
                command: "dsh web".into()
            }
        );
        assert_eq!(legacy.runtime, wsl("Debian"));
    }

    #[test]
    fn plugin_install_deps_plan() {
        let plan = build_plugin_plan(&cfg(LaunchMode::System, &[]), "lab", &PluginOp::InstallDeps)
            .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "dsh plugin --profile lab install".into(),
                wrap: ShellWrap::Cmd
            }
        );
        // 自定义命令模式同样复用启动器前缀（末 token 是当前环境名时去掉）。
        let plan = build_plugin_plan(
            &cfg(
                LaunchMode::Custom {
                    command: "npx dsh lab".into(),
                },
                &[],
            ),
            "lab",
            &PluginOp::InstallDeps,
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx dsh plugin --profile lab install".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn plugin_install_npx_plan() {
        let plan = build_plugin_plan(
            &cfg(npx(Channel::Latest, None), &[]),
            PROFILE_NAME,
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
            PROFILE_NAME,
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
            PROFILE_NAME,
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
            &wsl_cfg(npx(Channel::Latest, None), &[], "Ubuntu-24.04"),
            PROFILE_NAME,
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
    fn plugin_install_follows_channel_and_version() {
        // 插件必须装到与启动同一个包上：npx@next / 固定 rc 版本时插件也要跟。
        for (channel, version, expected) in [
            (
                Channel::Next,
                None,
                "npx --yes @deepseek-ai/dsh@next plugin --profile web remove dsharbor-bridge",
            ),
            (
                Channel::Rc,
                Some("0.2.1-rc.2"),
                "npx --yes @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web remove dsharbor-bridge",
            ),
        ] {
            let plan = build_plugin_plan(
                &cfg(npx(channel, version), &[]),
                PROFILE_NAME,
                &PluginOp::Uninstall {
                    name: "dsharbor-bridge".into(),
                },
            )
            .unwrap();
            assert_eq!(
                plan,
                SpawnPlan::ShellLine {
                    line: expected.into(),
                    wrap: ShellWrap::Cmd
                }
            );
        }
    }

    #[test]
    fn plugin_install_wsl_with_custom_inner() {
        let plan = build_plugin_plan(
            &wsl_cfg(
                LaunchMode::Custom {
                    command: "dsh web".into(),
                },
                &[],
                "Ubuntu-24.04",
            ),
            PROFILE_NAME,
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
                    &cfg(npx(Channel::Latest, None), &[]),
                    PROFILE_NAME,
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
            &cfg(npx(Channel::Latest, None), &[]),
            PROFILE_NAME,
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
    fn extracts_configured_host() {
        let args = |raw: &[&str]| raw.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            extract_configured_host(&args(&["--host", "192.168.1.7"])),
            Some("192.168.1.7".to_string())
        );
        assert_eq!(
            extract_configured_host(&args(&["--host=10.0.0.5"])),
            Some("10.0.0.5".to_string())
        );
        assert_eq!(extract_configured_host(&args(&["--no-open"])), None);
    }

    #[test]
    fn detects_tls_args() {
        let args = |raw: &[&str]| raw.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(has_tls_args(&args(&["--tls-cert", "a.pem"])));
        assert!(has_tls_args(&args(&["--tls-key=b.pem"])));
        assert!(!has_tls_args(&args(&["--no-open", "--port", "3099"])));
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

    #[test]
    fn npx_command_follows_the_selected_environment() {
        // `web` 是位置参数形式的环境选择器：换个环境名就换一整份环境。
        let plan = build_spawn_plan(&cfg(npx(Channel::Latest, None), &[]), "lab").unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx --yes @deepseek-ai/dsh lab --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
        assert_eq!(
            npx_web_command(Channel::Next, None, "lab"),
            "npx --yes @deepseek-ai/dsh@next lab"
        );
    }

    #[test]
    fn system_and_binary_commands_follow_the_selected_environment() {
        let plan = build_spawn_plan(&cfg(LaunchMode::System, &[]), "lab").unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "dsh lab --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
        let plan = build_spawn_plan(
            &cfg(
                LaunchMode::Binary {
                    path: "D:\\tools\\dsh.exe".into(),
                },
                &[],
            ),
            "lab",
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::Direct {
                program: "D:\\tools\\dsh.exe".into(),
                args: vec!["lab".into(), "--no-open".into()]
            }
        );
    }

    #[test]
    fn custom_command_is_passed_through_untouched() {
        // 用户可能已经自己写了 `--profile` 或别的子命令，壳不能再往里插环境名。
        let plan = build_spawn_plan(
            &cfg(
                LaunchMode::Custom {
                    command: "npx @deepseek-ai/dsh@next web".into(),
                },
                &[],
            ),
            "lab",
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx @deepseek-ai/dsh@next web --no-open".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn invalid_environment_name_is_rejected_instead_of_falling_back() {
        // 静默回退成默认环境会让用户以为切了、其实没切。
        for bad in ["", "a b", "-x", "../etc"] {
            assert!(
                build_spawn_plan(&cfg(npx(Channel::Latest, None), &[]), bad).is_err(),
                "应被拒绝: {bad:?}"
            );
        }
    }

    #[test]
    fn plugin_plan_targets_the_selected_environment() {
        let plan = build_plugin_plan(
            &cfg(npx(Channel::Latest, None), &[]),
            "lab",
            &PluginOp::Install {
                package: "file:/tmp/x.tgz".into(),
            },
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "npx --yes @deepseek-ai/dsh plugin --profile lab add file:/tmp/x.tgz".into(),
                wrap: ShellWrap::Cmd
            }
        );
        let plan = build_plugin_plan(
            &cfg(LaunchMode::System, &[]),
            "lab",
            &PluginOp::Uninstall {
                name: "dsharbor-bridge".into(),
            },
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "dsh plugin --profile lab remove dsharbor-bridge".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn custom_plugin_prefix_drops_the_current_environment_name() {
        // 自定义命令末尾写的就是当前环境名时才剥掉，返回插件子命令。
        let plan = build_plugin_plan(
            &cfg(
                LaunchMode::Custom {
                    command: "pnpm dlx @deepseek-ai/dsh lab".into(),
                },
                &[],
            ),
            "lab",
            &PluginOp::Install {
                package: "file:/tmp/x.tgz".into(),
            },
        )
        .unwrap();
        assert_eq!(
            plan,
            SpawnPlan::ShellLine {
                line: "pnpm dlx @deepseek-ai/dsh plugin --profile lab add file:/tmp/x.tgz".into(),
                wrap: ShellWrap::Cmd
            }
        );
    }

    #[test]
    fn plugin_plan_rejects_an_invalid_environment_name() {
        assert!(build_plugin_plan(
            &cfg(npx(Channel::Latest, None), &[]),
            "a;b",
            &PluginOp::Uninstall {
                name: "dsharbor-bridge".into(),
            },
        )
        .is_err());
    }
}
