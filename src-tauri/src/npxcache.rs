//! npx 缓存里装过哪些 DSH：只读扫描，用来回答「本机装过哪些版本」。
//!
//! 壳不再管理 npx 缓存（不统计占用、不清理）——那不符合本项目定位。现在只用它做两件事：
//! 给版本下拉的「已缓存」徽章列出缓存过的版本号，以及在「DSH 版本」卡里报告 npx 装过哪些版本。
//! 归属判定（哪些目录属于本包、哪个 spec 解析成哪个版本）全在核心库
//! `dsharbor_core::npx_cache`，那里有单测；这里只做与操作系统打交道的事：
//! 问 npm 缓存根在哪、读 `_npx` 下每个目录的 `package.json`。
//!
//! 为什么缓存根要问 npm 而不是写死 `%LOCALAPPDATA%\\npm-cache`：用户可能用 `npm config
//! set cache` 或 `.npmrc` 改过（换到大盘、放进项目目录）。写死会扫错地方。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use dsharbor_core::launch::{self, Runtime};
use dsharbor_core::npx_cache;

use crate::launcher::{apply_no_window, spawn_line_reader};

/// `npm config get cache` 正常几十毫秒；npx 冷启动时会先跑一次，给足余量。
const NPM_TIMEOUT: Duration = Duration::from_secs(30);

/// npx 缓存里的一份本包装。
#[derive(Debug, Clone)]
pub struct NpxInstall {
    /// 目录位置（宿主上是绝对路径；WSL 里是 `<缓存根>/_npx/<目录名>`）。
    pub path: String,
    /// 盘上真正解析到的版本（`node_modules/@deepseek-ai/dsh/package.json` 的 version）。
    pub version: Option<String>,
    /// 目录 manifest 里记的 spec 列表。
    pub specs: Vec<String>,
}

/// 当前运行环境里 npx 装过的所有本包版本（宿主或某个 WSL 发行版）。
pub fn installed(runtime: &Runtime) -> Result<Vec<NpxInstall>, String> {
    if !cfg!(windows) {
        return Ok(Vec::new());
    }
    match runtime {
        Runtime::Default => host_installs(),
        Runtime::Wsl { distro } => wsl_installs(distro),
    }
}

/// 一次扫描算出两份清单（已缓存版本、钉版本可复用版本）。
///
/// 返回 `(已缓存版本, 钉版本可复用版本)`：前者喂界面「已缓存」徽章；后者是前者的子集，
/// 只登记钉版本写法（`@deepseek-ai/dsh@<版本>`）留下的缓存——界面用它区分「选它启动
/// 不会再下载」与「缓存里有、但选了还会再下一份」：npx 按命令写法各存一份缓存，
/// 裸包名写法留下的目录服务不了钉版本的启动命令。
///
/// 两份清单共用一次 `installed()` 扫描：它要全量递归 `_npx`（WSL 下还要起 wsl.exe），
/// 分开各扫一遍只是把这个成本翻倍。
///
/// 只在 Windows 宿主上扫：非 Windows 宿主上 npx 缓存盘面本来就不支持，
/// 这里返回空列表而不是报错——「一个都没缓存」是能算出来的诚实答案。
pub fn cached_and_pin_served(runtime: &Runtime) -> Result<(Vec<String>, Vec<String>), String> {
    if !cfg!(windows) {
        return Ok((Vec::new(), Vec::new()));
    }
    let installs = installed(runtime)?;
    Ok((
        npx_cache::cached_versions(
            installs
                .iter()
                .map(|item| (item.version.as_deref(), item.specs.as_slice())),
        ),
        npx_cache::pin_served_versions(installs.iter().map(|item| item.specs.iter())),
    ))
}

/// 宿主 npm 缓存里每份 `_npx` 目录的安装信息。
///
/// 版本先读 `node_modules/@deepseek-ai/dsh/package.json` 的 version（真实解析到的那一版），
/// 读不到才退回目录 manifest 的 `_npx.packages` 后缀——反过来的话，老目录 manifest 里
/// 记着的 spec（装完后可能又被换过版本）会盖掉真正在盘上的版本。
fn host_installs() -> Result<Vec<NpxInstall>, String> {
    let root = resolve_root().ok_or_else(|| "找不到 npm 缓存目录".to_string())?;
    let npx_dir = root.join(npx_cache::NPX_DIR_NAME);
    if !npx_dir.is_dir() {
        // 还没跑过 npx：这就是「一份都没装过」，不是错误。
        return Ok(Vec::new());
    }
    let mut installs: Vec<NpxInstall> = Vec::new();
    let listing = std::fs::read_dir(&npx_dir)
        .map_err(|err| format!("读取 npx 缓存目录失败（{}）：{err}", npx_dir.display()))?;
    for item in listing.flatten() {
        let path = item.path();
        // 只认真目录：符号链接 / junction 一律跳过（可能是别人放的指针，跟进去会重复统计）。
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        let manifest = read_manifest(&path.join("package.json"));
        // `_npx` 下面还躺着别的包（其它工具、别的服务）的缓存目录。只有 manifest
        // 里明确记着本包的才收进来，否则会把别人的缓存当成「装过 DSH」。
        if !manifest.owns() {
            continue;
        }
        let version = read_version_file(
            &path
                .join("node_modules")
                .join(launch::NPX_PACKAGE)
                .join("package.json"),
        );
        installs.push(NpxInstall {
            path: path.display().to_string(),
            version,
            specs: manifest.packages,
        });
    }
    Ok(installs)
}

/// 读一份目录 manifest；读不到 / 解析不了按空处理（即「不属于本包」）。
fn read_manifest(path: &Path) -> npx_cache::Manifest {
    let Ok(text) = std::fs::read_to_string(path) else {
        return npx_cache::Manifest::default();
    };
    npx_cache::parse_manifest(&text).unwrap_or_default()
}

/// 读某个包的 `package.json` 取 `version` 字段；读不到 / 写坏都返回 None。
fn read_version_file(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

/// 问 npm 缓存根在哪；问不到就退回平台默认位置。
fn resolve_root() -> Option<PathBuf> {
    if let Ok(text) = crate::plugin::run_capture(npm_command(), NPM_TIMEOUT).map(|(_, text)| text) {
        if let Some(path) = npx_cache::parse_cache_root(&text) {
            return Some(PathBuf::from(path));
        }
    }
    Some(default_cache_root())
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

/// 在发行版内部扫同一套东西：`bash -s` 从 stdin 读脚本，输出一段 JSON。
///
/// 为什么不照 `registry::build_command` 那样把整条命令塞进单个 argv：那支脚本要嵌进
/// 缓存根与包名——wsl.exe 会吃掉 argv 里的引号，再在外面裹一层引号就是注入面。改成把
/// 脚本写进子进程的 stdin（`bash -s`），argv 里只剩 `bash -s` 两个固定字面量。
fn wsl_installs(distro: &str) -> Result<Vec<NpxInstall>, String> {
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
    parse_wsl_installs(&text)
}

/// 解析 WSL 侧脚本吐出的 JSON（`{"root":…,"names":[…],"specs":[…],"resolved":[…]}`，三个数组按下标对应）。
fn parse_wsl_installs(text: &str) -> Result<Vec<NpxInstall>, String> {
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
    let root = value
        .get("root")
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_string();
    let names = strings("names");
    let specs = strings("specs");
    let resolved = strings("resolved");
    // 三个数组按下标对应：脚本对每个 spec 都写一项（读不到就是空串），
    // 所以长度对不上说明输出被截断了，这时宁可不报「已装」也别错位。
    if names.len() != specs.len() || specs.len() != resolved.len() {
        return Err(format!(
            "WSL 返回的缓存清单不完整（名字 {} 条 / spec {} 条 / 解析结果 {} 条）",
            names.len(),
            specs.len(),
            resolved.len()
        ));
    }
    Ok(names
        .into_iter()
        .zip(specs)
        .zip(resolved)
        .map(|((name, spec), resolved)| {
            let location = if root.is_empty() {
                name.clone()
            } else {
                format!("{root}/{name}")
            };
            NpxInstall {
                path: location,
                version: if resolved.is_empty() {
                    None
                } else {
                    Some(resolved)
                },
                specs: if spec.is_empty() {
                    Vec::new()
                } else {
                    vec![spec]
                },
            }
        })
        .collect())
}

/// 在发行版里扫 `_npx` 的脚本：打印 `{root,names,specs,resolved}`。
///
/// 为什么用 node 而不是用 shell 拼 grep/sed：`package.json` 是 JSON，用 shell
/// 正则去抠字段会在转义上出错；node 本来就在 npm 的环境里，一定可用。
///
/// 占位符用 `replace` 而不是 `format!`：下面这段 JS 里遍布 `{` `}`，逐个写成
/// `{{` `}}` 既难读又容易漏（漏一个要么编译不过，要么被 `format!` 当插值吃掉）。
fn wsl_script() -> String {
    const TEMPLATE: &str = r#"ROOT="$(npm config get cache 2>/dev/null)"
if [ -z "$ROOT" ]; then echo "npm 没有输出缓存路径" >&2; exit 3; fi
if [ ! -d "$ROOT/__NPX_DIR__" ]; then printf '{"root":"","names":[],"specs":[],"resolved":[]}'; exit 0; fi
cd "$ROOT/__NPX_DIR__" || exit 4
exec node -e '
const fs = require("fs");
const path = require("path");
const PACKAGE = "__PACKAGE__";
// 与核心库的 spec_package_name 同义：去掉末尾的 @版本 只留包名（scope 的 @ 要保留）。
const packageOf = (spec) => {
  const text = String(spec).trim();
  const start = text.startsWith("@") ? 1 : 0;
  const at = text.indexOf("@", start);
  return at < 0 ? text : text.slice(0, at);
};
const names = [];
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
  // 只留本包的 spec：一个目录里可能同时躺着别的包。
  entries = entries.filter((entry) => typeof entry === "string" && packageOf(entry) === PACKAGE);
  if (entries.length === 0) continue;
  let version = "";
  try {
    version = JSON.parse(fs.readFileSync(path.join(name, "node_modules", "__PACKAGE__", "package.json"), "utf8")).version || "";
  } catch (err) { version = ""; }
  for (const entry of entries) {
    names.push(name);
    specs.push(entry);
    resolved.push(version);
  }
}
process.stdout.write(JSON.stringify({ root: process.cwd(), names, specs, resolved }));
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
    fn npm_command_asks_config_get_cache() {
        let command = npm_command();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        let joined = args.join(" ");
        assert!(joined.contains("config get cache"), "{joined}");
    }

    #[test]
    fn wsl_output_is_parsed_into_installs() {
        let json = r#"{"root":"/home/u/.npm/_npx","names":["a1","b2"],"specs":["@deepseek-ai/dsh@0.2.1-rc.2","@deepseek-ai/dsh"],"resolved":["0.2.1-rc.2",""]}"#;
        let installs = parse_wsl_installs(json).unwrap();
        assert_eq!(installs.len(), 2);
        assert_eq!(installs[0].path, "/home/u/.npm/_npx/a1");
        assert_eq!(installs[0].version.as_deref(), Some("0.2.1-rc.2"));
        assert_eq!(installs[0].specs, vec!["@deepseek-ai/dsh@0.2.1-rc.2"]);
        assert_eq!(installs[1].version, None);
        assert_eq!(installs[1].specs, vec!["@deepseek-ai/dsh"]);
        // 登录脚本先吐 MOTD 时，只用第一个 `{` 起的 JSON。
        let noisy = format!("Welcome to Ubuntu\n{json}\n");
        assert_eq!(parse_wsl_installs(&noisy).unwrap().len(), 2);
    }

    #[test]
    fn broken_wsl_output_says_what_went_wrong_instead_of_reporting_versions() {
        let truncated =
            r#"{"root":"/x","names":["a1"],"specs":["@deepseek-ai/dsh@0.2.1-rc.2"],"resolved":[]}"#;
        let err = parse_wsl_installs(truncated).unwrap_err();
        assert!(err.contains("不完整"), "{err}");
        let err = parse_wsl_installs("没有任何 JSON").unwrap_err();
        assert!(err.contains("没有返回缓存清单"), "{err}");
        let err = parse_wsl_installs("{ not json").unwrap_err();
        assert!(err.contains("不是合法 JSON"), "{err}");
    }
}
