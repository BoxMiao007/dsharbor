//! 启动器（外壳侧）：把核心库构造的启动计划变成真实进程，维护状态、输出与停止。
//!
//! 关键决策：
//! - 子进程一律带 `CREATE_NO_WINDOW`（GUI 程序拉控制台子进程会闪黑框）和
//!   `CREATE_NEW_PROCESS_GROUP`（不被宿主进程的控制台事件波及）。
//! - 停止用 `taskkill /PID <pid> /T /F` 杀整棵进程树（cmd → npx → node）。
//! - stdout / stderr 各起一个读取线程，按行入环形日志并顺带解析端口；
//!   线程随管道 EOF 自然结束，不需要 join。
//! - WSL 模式用 `wsl.exe -d <distro> -- bash -lc <inner>`，参数以 argv 直传、
//!   不做二次字符串拼接，天然规避跨系统注入。已知限制：taskkill 只能杀掉
//!   宿主侧的 wsl.exe，发行版内的进程依赖 WSL 会话断开时回收（票 #6 健壮性
//!   里再补发行版内的二次清理）。

use std::collections::VecDeque;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dsharbor_core::bridge::{
    fetch_with_retry, generate_nonce, BridgeClient, BridgeError, NONCE_ENV,
};
use dsharbor_core::console::ConsoleDecoder;
use dsharbor_core::endpoint::Endpoint;
use dsharbor_core::launch::{
    build_launch_plan, extract_port, LaunchConfig, LaunchPlan, ShellWrap, SpawnPlan,
};
use dsharbor_core::logparse::{parse_announcement, Announcement};
use serde::Serialize;

/// 环形日志容量（行）。
const LOG_CAPACITY: usize = 400;
/// 状态查询返回给界面的日志行数。
const LOG_TAIL_LINES: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Stopped,
    Running,
    Failed,
}

/// 登录链接来自哪条通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoginChannel {
    /// 桥接插件（首选）。
    Bridge,
    /// 启动日志解析（兜底）。
    Log,
}

/// 已取到的登录链接（只驻内存；token 不落盘）。
#[derive(Debug, Clone)]
struct Login {
    url: String,
    channel: LoginChannel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub state: SessionState,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub error: Option<String>,
    pub log_tail: Vec<String>,
    /// 登录链接是否已就绪（就绪时前端可打开 DSH 窗口）。
    pub login_ready: bool,
    /// 登录链接来自哪条通道。
    pub login_channel: Option<LoginChannel>,
    /// 取链接失败原因（超时等）。
    pub login_error: Option<String>,
    /// 最近一次成功启动的 DSH 版本号（由外壳在启动后异步查询并注入）。
    pub dsh_version: Option<String>,
}

impl SessionStatus {
    pub fn stopped() -> Self {
        Self {
            state: SessionState::Stopped,
            pid: None,
            port: None,
            error: None,
            log_tail: Vec::new(),
            login_ready: false,
            login_channel: None,
            login_error: None,
            dsh_version: None,
        }
    }
}

/// 进程间共享的运行时信息（读取线程写、状态查询读）。
struct Shared {
    port: Mutex<Option<u16>>,
    log: Mutex<VecDeque<String>>,
    /// 日志里解析到的公告（兜底通道的候选）。
    announcement: Mutex<Option<Announcement>>,
    /// 已取到的登录链接（桥接或日志通道）。
    login: Mutex<Option<Login>>,
    /// 取链接失败原因（超时等）。
    login_error: Mutex<Option<String>>,
    /// 会话被主动停止后置位：让取链接线程尽快退出。
    cancelled: AtomicBool,
}

impl Shared {
    fn new() -> Self {
        Self {
            port: Mutex::new(None),
            log: Mutex::new(VecDeque::new()),
            announcement: Mutex::new(None),
            login: Mutex::new(None),
            login_error: Mutex::new(None),
            cancelled: AtomicBool::new(false),
        }
    }

    fn push_line(&self, line: &str, from_stdout: bool) {
        if from_stdout {
            if let Ok(mut port) = self.port.lock() {
                if port.is_none() {
                    if let Some(found) = extract_port(line) {
                        *port = Some(found);
                    }
                }
            }
            if let Some(announcement) = parse_announcement(line) {
                if let Ok(mut slot) = self.announcement.lock() {
                    if slot.is_none() {
                        *slot = Some(announcement);
                    }
                }
            }
        }
        if let Ok(mut log) = self.log.lock() {
            if log.len() >= LOG_CAPACITY {
                log.pop_front();
            }
            log.push_back(line.to_string());
        }
    }

    /// 往日志里插一条壳自己的说明（前缀 [dsharbor]，供界面排查）。
    fn push_note(&self, text: &str) {
        self.push_line(&format!("[dsharbor] {text}"), false);
    }

    fn port(&self) -> Option<u16> {
        self.port.lock().ok().and_then(|guard| *guard)
    }

    fn announcement(&self) -> Option<Announcement> {
        self.announcement
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    fn login(&self) -> Option<Login> {
        self.login.lock().ok().and_then(|guard| guard.clone())
    }

    fn set_login(&self, url: String, channel: LoginChannel) {
        if let Ok(mut slot) = self.login.lock() {
            *slot = Some(Login { url, channel });
        }
    }

    fn set_login_error(&self, message: &str) {
        if let Ok(mut slot) = self.login_error.lock() {
            if slot.is_none() {
                *slot = Some(message.to_string());
            }
        }
        self.push_note(message);
    }

    fn login_error(&self) -> Option<String> {
        self.login_error.lock().ok().and_then(|guard| guard.clone())
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    fn log_tail(&self) -> Vec<String> {
        self.log
            .lock()
            .map(|log| {
                log.iter()
                    .rev()
                    .take(LOG_TAIL_LINES)
                    .rev()
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 最近若干条非空输出，连接成一行（供启动失败提示使用，多行错误也能看全）。
    fn last_lines(&self, count: usize) -> String {
        self.log
            .lock()
            .map(|log| {
                let mut lines: Vec<String> = log
                    .iter()
                    .rev()
                    .filter(|line| !line.trim().is_empty())
                    .take(count)
                    .cloned()
                    .collect();
                lines.reverse();
                lines.join(" ")
            })
            .unwrap_or_default()
    }
}

/// 一个由本壳拉起的 DSH 会话。
pub struct SessionHandle {
    child: Child,
    pid: u32,
    stop_requested: bool,
    shared: Arc<Shared>,
}

impl SessionHandle {
    /// 进程是否仍存活（顺带回收已退出的子进程，避免僵尸）。
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// 当前状态快照（每次调用都会检查进程是否已退出）。
    pub fn status(&mut self) -> SessionStatus {
        let log_tail = self.shared.log_tail();
        let login = self.shared.login();
        let login_ready = login.is_some();
        let login_channel = login.as_ref().map(|entry| entry.channel);
        let login_error = self.shared.login_error();
        match self.child.try_wait() {
            Ok(None) => SessionStatus {
                state: SessionState::Running,
                pid: Some(self.pid),
                port: self.shared.port(),
                error: None,
                log_tail,
                login_ready,
                login_channel,
                login_error,
                dsh_version: None,
            },
            Ok(Some(exit)) => {
                if self.stop_requested {
                    return SessionStatus {
                        state: SessionState::Stopped,
                        pid: None,
                        port: None,
                        error: None,
                        log_tail,
                        login_ready,
                        login_channel,
                        login_error,
                        dsh_version: None,
                    };
                }
                let status_text = exit
                    .code()
                    .map(|code| format!("退出代码 {code}"))
                    .unwrap_or_else(|| "未知状态".into());
                let last = self.shared.last_lines(3);
                let hint = if last.is_empty() {
                    String::new()
                } else {
                    format!("；最近输出：{last}")
                };
                SessionStatus {
                    state: SessionState::Failed,
                    pid: None,
                    port: self.shared.port(),
                    error: Some(format!("DSH 进程已退出（{status_text}）{hint}")),
                    log_tail,
                    login_ready,
                    login_channel,
                    login_error,
                    dsh_version: None,
                }
            }
            Err(err) => SessionStatus {
                state: SessionState::Failed,
                pid: None,
                port: None,
                error: Some(format!("查询 DSH 进程状态失败：{err}")),
                log_tail,
                login_ready,
                login_channel,
                login_error,
                dsh_version: None,
            },
        }
    }

    /// 当前登录链接（「打开 DSH 界面」用；还没取到时返回 None）。
    pub fn login_url(&self) -> Option<String> {
        self.shared.login().map(|entry| entry.url)
    }

    /// 停止整个进程树并确认退出；最多等 5 秒。
    pub fn stop(&mut self) -> Result<(), String> {
        if matches!(self.child.try_wait(), Ok(Some(_)) | Err(_)) {
            return Ok(());
        }
        self.stop_requested = true;
        self.shared.cancel();
        kill_tree(self.pid)?;
        for _ in 0..50 {
            if matches!(self.child.try_wait(), Ok(Some(_)) | Err(_)) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        Err("停止 DSH 超时：进程可能仍在运行，请到任务管理器确认".into())
    }
}

/// 按启动计划拉起 DSH 进程，并启动登录链接获取线程（桥接优先、日志兜底）。
///
/// `launcher_args`：壳内部追加的启动器层参数（如端口覆盖的 `--patch <文件>`），
/// 由 lib.rs 在启动前准备好；没有时传空数组。
/// `env`：要注入 DSH 进程的额外环境变量（下载源 + 代理），同样由调用方用
/// `dsharbor_core::net::plan_env` 算好——三条注入路径共用一份计划。
pub fn spawn(
    config: &LaunchConfig,
    profile: &str,
    launcher_args: &[String],
    env: &[(String, String)],
    bridge_endpoint: Endpoint,
) -> Result<SessionHandle, String> {
    // 每次启动现生成 nonce，经环境变量注入 DSH 进程；桥接插件在运行时从
    // process.env 读取它（见插件的 dsh.bundle.patch.yml）。nonce 不落盘。
    let nonce = generate_nonce()?;
    // nonce 与代理/源一起进同一个环境变量列表：WSL 下它们都会变成 `env K=V` 的 argv，
    // 分两次注入反而容易漏掉其中一份。
    let mut injected = vec![(NONCE_ENV.to_string(), nonce.clone())];
    injected.extend_from_slice(env);
    let plan = build_launch_plan(config, profile, &injected, launcher_args)?;
    let mut command = command_for_plan(&plan);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("启动 DSH 失败：{err}"))?;
    let pid = child.id();
    let shared = Arc::new(Shared::new());
    if let Some(stdout) = child.stdout.take() {
        pump(stdout, shared.clone(), true);
    }
    if let Some(stderr) = child.stderr.take() {
        pump(stderr, shared.clone(), false);
    }
    let shared_for_login = shared.clone();
    // 桥接探测地址直接用 detect::effective_endpoint 算好的端点：host 跟随 profile
    // （LAN 绑定时回环连不进去），端口沿用 detect::resolved_port 的优先级链
    // （界面自定义端口 > profile 写死的端口 > 附加参数 --port > 3080），
    // 与后续探测保持一致；只认附加参数里的 --port 会压过更高优先级的来源。
    std::thread::spawn(move || acquire_login(shared_for_login, nonce, bridge_endpoint));
    Ok(SessionHandle {
        child,
        pid,
        stop_requested: false,
        shared,
    })
}

/// 取登录链接：桥接通道优先，日志解析兜底。
///
/// 时间线：DSH 起来后要么被提前探测到端口（用户配了 --port），要么从日志
/// 公告里解析出端口与链接。桥接一旦可用就用它（官方接口、不依赖日志格式）；
/// 桥接被判定不可用（503 未注入 nonce / 403 端口被旧进程占用）立即降级；
/// 桥接迟迟没有结果时，公告出现 5 秒宽限后也降级——保证界面最终拿得到链接。
fn acquire_login(shared: Arc<Shared>, nonce: String, endpoint: Endpoint) {
    const OVERALL_TIMEOUT: Duration = Duration::from_secs(90);
    const BRIDGE_GRACE: Duration = Duration::from_secs(5);
    const POLL: Duration = Duration::from_millis(250);

    let started = Instant::now();
    let mut bridge_unusable = false;
    let mut grace_deadline: Option<Instant> = None;

    loop {
        if shared.cancelled() {
            return;
        }
        if started.elapsed() > OVERALL_TIMEOUT {
            shared.set_login_error("等待登录链接超时：桥接与日志两条通道都没有结果");
            return;
        }

        // 1) 桥接尝试（每次最多 ~1.2 秒的短重试，启动早期的瞬时失败自愈）。
        if !bridge_unusable {
            // 端口优先用日志里解析出的实际端口（npx 默认可能不是 3080），host 跟着 profile 走。
            let target = Endpoint::new(&endpoint.host, shared.port().unwrap_or(endpoint.port));
            if grace_deadline.is_none() {
                grace_deadline = Some(Instant::now() + BRIDGE_GRACE);
            }
            let client = BridgeClient::new(target, nonce.clone());
            match fetch_with_retry(
                || client.fetch(),
                std::thread::sleep,
                6,
                Duration::from_millis(200),
            ) {
                Ok(url) => {
                    shared.push_note("已通过桥接插件取到登录链接");
                    shared.set_login(url, LoginChannel::Bridge);
                    return;
                }
                Err(BridgeError::Disabled(reason)) => {
                    bridge_unusable = true;
                    shared.push_note(&format!("桥接插件未启用（{reason}），改用日志解析兜底"));
                }
                Err(err) if !err.retriable() => {
                    bridge_unusable = true;
                    shared.push_note(&format!(
                        "桥接通道不可用（{}），改用日志解析兜底",
                        err.message()
                    ));
                }
                Err(_) => {}
            }
        }

        // 2) 日志兜底：桥接已判定不可用，或公告出现后宽限期已过。
        if let Some(announcement) = shared.announcement() {
            let grace_over = grace_deadline.map_or(true, |deadline| Instant::now() >= deadline);
            if bridge_unusable || grace_over {
                shared.push_note("已从启动日志解析到登录链接（兜底通道）");
                shared.set_login(announcement.local_url, LoginChannel::Log);
                return;
            }
        }

        std::thread::sleep(POLL);
    }
}

/// 把启动计划翻译成 Command（含环境变量；WSL 变体在发行版内部注 env）。
pub(crate) fn command_for_plan(plan: &LaunchPlan) -> Command {
    let mut command = match &plan.spawn {
        SpawnPlan::Direct { program, args } => {
            let mut command = Command::new(program);
            command.args(args);
            command
        }
        SpawnPlan::Script { program, args } => {
            // .cmd/.bat 不能被 CreateProcess 直接执行，必须经 cmd.exe。
            // 关键：程序与参数分开作为 argv 交给 cmd，不拼"整行字符串"——
            // 整行方案里 Rust 的参数引号规则会和 cmd 的 /C 解析规则叠加，
            // 路径引号会被当成文件名的一部分（实机症状：'\"D:\...\dsh.cmd\"' 不是内部或外部命令）。
            #[cfg(windows)]
            {
                let mut command = Command::new("cmd");
                command.arg("/C").arg(program).args(args);
                command
            }
            #[cfg(not(windows))]
            {
                let mut command = Command::new("/bin/sh");
                command.arg(program).args(args);
                command
            }
        }
        SpawnPlan::ShellLine { line, wrap } => match wrap {
            ShellWrap::Cmd => {
                let mut command = Command::new("cmd");
                command.arg("/C").arg(line);
                command
            }
            ShellWrap::Posix => {
                let mut command = Command::new("/bin/sh");
                command.arg("-c").arg(line);
                command
            }
        },
        SpawnPlan::Wsl { distro, inner } => {
            let mut command = Command::new("wsl.exe");
            command.args(["-d", distro, "--"]);
            // PATH 修复：wsl.exe 会把 Windows 侧 PATH（/mnt/d/… 里的 Windows 版
            // pnpm 等）带进发行版，DSH 的插件管理执行裸 `pnpm` 时误用 Windows
            // 版并崩溃（current dir is an absolute path with drive letter）。
            // 先取一份发行版干净 PATH 并补上用户级工具目录、显式注入；取不到则
            // 退回继承值。
            // 注意：整个 `env` 前缀都以独立 argv 传递、不含引号（wsl.exe 会破坏
            // 参数里的引号；PATH 条目已在 core 的 sanitize_wsl_path 里过滤）。
            let clean_path = crate::wsl::clean_path(distro).ok();
            if clean_path.is_none() && plan.env.is_empty() {
                command.args(["bash", "-lc", inner]);
            } else {
                // 环境变量必须送进发行版内部：宿主侧 Command::envs 只影响
                // wsl.exe 自己，发行版里的进程读不到。argv 直传、无注入面。
                command.arg("env");
                if let Some(path) = &clean_path {
                    command.arg(format!("PATH={path}"));
                }
                for (key, value) in &plan.env {
                    command.arg(format!("{key}={value}"));
                }
                command.args(["bash", "-lc", inner]);
            }
            command
        }
    };
    // 宿主侧直接启动的变体（Direct/Script/ShellLine）统一走 Command::envs。
    if !matches!(plan.spawn, SpawnPlan::Wsl { .. }) {
        for (key, value) in &plan.env {
            command.env(key, value);
        }
    }
    command
}

/// GUI 程序拉控制台子进程时加 Windows 专用标志（不闪黑框、独立进程组）。
pub(crate) fn apply_no_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// 后台读取一条输出流：解码、按行入日志、顺带解析端口/公告。
fn pump<R: Read + Send + 'static>(reader: R, shared: Arc<Shared>, from_stdout: bool) {
    spawn_line_reader(reader, move |line| shared.push_line(&line, from_stdout));
}

/// 从一个输出流按行读取（自动探测 UTF-16/UTF-8/GBK 编码），每行回调一次。
/// 抽出来给插件安装等一次性命令共用（读它们的 stdout/stderr）。
pub(crate) fn spawn_line_reader<R: Read + Send + 'static>(
    mut reader: R,
    mut on_line: impl FnMut(String) + Send + 'static,
) {
    std::thread::spawn(move || {
        let mut decoder = ConsoleDecoder::new();
        let mut buffer = [0u8; 4096];
        let mut carry = String::new();
        loop {
            let count = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            carry.push_str(&decoder.feed(&buffer[..count]));
            while let Some(index) = carry.find('\n') {
                let raw: String = carry.drain(..=index).collect();
                let line = raw.trim_end_matches(['\r', '\n']).to_string();
                if !line.is_empty() {
                    on_line(line);
                }
            }
            // 防御：某条输出特别长又迟迟没有换行时，先落一行，保证内存有界。
            if carry.len() > 16 * 1024 {
                let line = std::mem::take(&mut carry);
                on_line(line);
            }
        }
        let tail = carry.trim_end_matches(['\r', '\n']).to_string();
        if !tail.is_empty() {
            on_line(tail);
        }
    });
}

/// 杀进程树。Windows 上用 taskkill /T（覆盖 cmd → npx → node 整条链）。
pub(crate) fn kill_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|err| format!("调用 taskkill 失败：{err}"))?;
        if status.success() {
            return Ok(());
        }
        Err(format!("taskkill 返回失败（{status}），进程可能已自行退出"))
    }
    #[cfg(not(windows))]
    {
        let status = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|err| format!("调用 kill 失败：{err}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("kill 返回失败（{status}），进程可能已自行退出"))
        }
    }
}
