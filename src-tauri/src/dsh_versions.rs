//! 本机装了哪些 DSH（dsh web）版本，以及删掉其中某一份。
//!
//! 「集成」分区原来的 npx 缓存管理（统计占用、按保留策略清理）不符合本项目的定位：
//! 这个壳是 DSH Web 的启动器/管理器，用户真正关心的是「我本机装了哪几份、分别装在哪、
//! 现在用的是哪一份」，而不是缓存目录占了多少字节。所以这里只做只读检测 + 删除。
//!
//! 只认两类来源（用户指定）：
//! - `npx`：`npm` 的 `_npx` 缓存里跑过的那几份（读 `node_modules/@deepseek-ai/dsh`
//!   的 `package.json` 版本）——这是 `npx --yes @deepseek-ai/dsh` 留下的东西；
//! - `npm`：`npm install -g @deepseek-ai/dsh` 装到全局的那一份（跑 `npm ls -g -p` 问路径）。
//!
//! 不扫 WSL 每个发行版（用户没要）、不认桌面版自带的 CLI（那是壳自己带的运行时，
//! 不是用户装的 DSH Web）。

use std::fs;
use std::time::Duration;

use dsharbor_core::launch::{self, LaunchConfig, LaunchMode, Runtime};
use dsharbor_core::npx_cache;
use serde::Serialize;

use crate::npxcache;
use crate::registry;

/// 跑一次 `npm ls` / `npm uninstall` 的超时。都是本地操作，给 30 秒足够；
/// 真正卡住（npm 在等锁、等在网络上补元数据）时宁可报错也别让界面一直转。
const NPM_TIMEOUT: Duration = Duration::from_secs(30);

/// 界面要展示的一条「已装 DSH」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledDsh {
    /// 版本号；读不到时 None（目录被改坏、`package.json` 里没有 `version`）。
    pub version: Option<String>,
    /// 来源：`"npx"` 或 `"npm"`。界面用它区分「npx 缓存里的」与「npm 全局装的」。
    pub source: String,
    /// 装在哪：npx 给缓存目录，npm 给全局安装目录。
    pub path: String,
    /// 当前启动方式是否就用这一份——界面据此提示「卸载它之后需要换启动方式」。
    pub in_use: bool,
    /// 安装方式（只有 npx 缓存里的份能区分）：`"pinned"` = 用选定的版本号装的，
    /// `"auto"` = 自动最新（裸包名写法）装的。spec 读不到时 None，界面不标。
    /// npm 全局没有这个概念，恒为 None。界面拿它防误删：删掉「自动最新」那份后，
    /// 「自动最新」启动要重新下载。
    pub install_method: Option<&'static str>,
}

/// 扫一遍本机：npx 缓存里的 + npm 全局装的，按版本从新到旧。
///
/// 任一侧查不出来都只是少一块内容，不整体失败：npx 缓存目录不存在不算错误，
/// npm 没装本包时 `npm ls -g -p` 输出为空也不算错误。只有真正跑不起来（npm 不存在、
/// 超时）才把原因带出去，让界面能提示用户。
pub fn scan(config: &LaunchConfig) -> Result<Vec<InstalledDsh>, String> {
    let mut installs: Vec<InstalledDsh> = Vec::new();
    // 按「实际生效」的运行环境扫，不直接读 `config.runtime`：后者可能残留旧启动
    // 方式下的 WSL 值，而「系统全局命令 / 指定程序路径」恒跑在 Windows 宿主上
    // （口径与 `plugin::Target::of` 一致，那里注明了同一个原因）。
    let runtime = launch::runtime_of(config);

    // npx 缓存：复用 npxcache 的扫描（它已经处理了「目录不存在返空」）。
    for item in npxcache::installed(runtime)? {
        installs.push(InstalledDsh {
            in_use: npx_in_use(config, item.version.as_deref()),
            version: item.version,
            source: "npx".to_string(),
            path: item.path,
            install_method: install_method_of(&item.specs),
        });
    }

    // npm 全局：问路径，有路径就算装了；版本从那个目录的 package.json 读。
    if let Some(path) = npm_global_path(runtime)? {
        installs.push(InstalledDsh {
            in_use: matches!(config.mode, LaunchMode::System),
            version: read_version(&path),
            source: "npm".to_string(),
            path,
            install_method: None,
        });
    }

    sort_newest_first(&mut installs);
    Ok(installs)
}

/// 从目录 manifest 记的 npx spec 推「这份是怎么装的」：
/// 登记过钉版本写法（`@deepseek-ai/dsh@<具体版本号>`）就是「版本号安装」；
/// 只有裸包名 / `@标签` 这类写法就是「自动最新」。spec 一条都读不到时给 None——
/// 界面不标，宁可少说也不猜。
fn install_method_of(specs: &[String]) -> Option<&'static str> {
    if specs.is_empty() {
        return None;
    }
    if specs
        .iter()
        .any(|spec| npx_cache::spec_version(spec).is_some())
    {
        Some("pinned")
    } else {
        Some("auto")
    }
}

/// 卸载 npm 全局装的那一份，返回给用户看的结果文案。
///
/// npx 缓存里的那份不在这里删：npx 缓存由 npm 自己按时间回收，本壳不再插手；
/// 真要清，界面上给的是 `npm cache` 那条命令。这里只管 `npm uninstall -g`。
pub fn uninstall_global(runtime: &Runtime) -> Result<String, String> {
    let args = ["uninstall", "-g", dsharbor_core::launch::NPX_PACKAGE];
    let command = registry::npm_command(runtime, &args, &[])?;
    let (code, output) = crate::plugin::run_capture(command, NPM_TIMEOUT)?;
    if code != 0 {
        let detail = output.trim();
        return Err(if detail.is_empty() {
            format!("卸载失败（npm 退出码 {code}）")
        } else {
            format!("卸载失败：{detail}")
        });
    }
    Ok("已卸载全局安装的 DSH。".to_string())
}

/// 删掉 npx 缓存里的某一份，返回给用户看的结果文案。
///
/// 只删「扫描结果里确实存在的那个 `_npx` 目录」：`path` 来自界面，不能当成可信输入
/// 直接 `remove_dir_all`——先重扫一遍本机，确认它正是本包的一份 npx 安装，再删。
/// 这样即使前端传了别的路径，也只会得到「这一份已经不在了」。
pub fn remove_npx(runtime: &Runtime, path: &str) -> Result<String, String> {
    let target = npxcache::installed(runtime)?
        .into_iter()
        .find(|item| item.path == path)
        .ok_or_else(|| "这一份 npx 安装已经不在缓存里了，刷新一下列表。".to_string())?;
    let dir = std::path::Path::new(&target.path);
    // 删之前再确认一次它真的是 `_npx` 下面的目录：重扫与删除之间目录可能被换掉。
    let looks_right = dir
        .parent()
        .and_then(std::path::Path::file_name)
        .map(|name| name == npx_cache::NPX_DIR_NAME)
        .unwrap_or(false);
    if !looks_right {
        return Err(format!(
            "这个路径不在 npx 缓存目录下，不删：{}",
            target.path
        ));
    }
    fs::remove_dir_all(dir).map_err(|err| describe_io_error(&err, &target.path))?;
    Ok(match target.version {
        Some(version) => format!("已删掉 npx 缓存里的 v{version}。"),
        None => "已删掉 npx 缓存里的那一份。".to_string(),
    })
}

/// 把删目录的失败翻译成用户能看懂的原因（沿用原来缓存清理那套说法）。
fn describe_io_error(err: &std::io::Error, path: &str) -> String {
    let text = err.to_string();
    if text.contains("being used by another process") || text.contains("(os error 32)") {
        return format!("文件被占用（可能这个版本的 DSH 正在运行）：{path}");
    }
    if text.contains("Access is denied") || text.contains("(os error 5)") {
        return format!("没有权限删除：{path}");
    }
    if err.kind() == std::io::ErrorKind::NotFound {
        return "目录已经不存在（可能刚被别处清掉）".to_string();
    }
    format!("删除失败（{path}）：{text}")
}

/// 当前启动方式是否就用这个 npx 缓存里的版本。
///
/// 只有在启动方式明确选了具体版本时才能断言；选「自动（最新）」时 npx 会自己去解析，
/// 本壳不猜它这次会命中哪个目录，一律按「不确定」处理（false），避免误报。
fn npx_in_use(config: &LaunchConfig, version: Option<&str>) -> bool {
    match (&config.mode, version) {
        (
            LaunchMode::Npx {
                version: Some(chosen),
            },
            Some(installed),
        ) => chosen == installed,
        _ => false,
    }
}

/// 问出 npm 全局装的 `@deepseek-ai/dsh` 目录；没装返 None。
///
/// 用 `npm ls -g -p --depth=0 <包>`：已装时输出该包的绝对路径，未装时输出为空且退出码 0
/// （实测如此），所以「输出里有没有路径」就是判断依据，不看退出码——`npm ls` 在
/// 「未装任何包」时也可能给出非 0 退出码，靠退出码会误报失败。
fn npm_global_path(runtime: &Runtime) -> Result<Option<String>, String> {
    let args = [
        "ls",
        "-g",
        "-p",
        "--depth=0",
        dsharbor_core::launch::NPX_PACKAGE,
    ];
    let command = registry::npm_command(runtime, &args, &[])?;
    let (code, output) = crate::plugin::run_capture(command, NPM_TIMEOUT)?;
    // 输出形状：正常就是一行路径；被 npm 警告污染时最后一条像路径的行才是。
    if let Some(path) = npx_cache::parse_cache_root(&output) {
        return Ok(Some(path));
    }
    // 没路径：可能是没装，也可能真的报错了。退出码非 0 且输出里有报错内容才当失败。
    if code != 0 {
        let detail = output.trim();
        if !detail.is_empty() {
            return Err(format!("读取 npm 全局安装失败：{detail}"));
        }
    }
    Ok(None)
}

/// 读一个包目录 `package.json` 里的 `version`。
fn read_version(dir: &str) -> Option<String> {
    let text = fs::read_to_string(std::path::Path::new(dir).join("package.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("version")
        .and_then(|version| version.as_str())
        .map(str::to_string)
}

/// 按版本从新到旧排；版本读不到的排最后。复用核心库同一套 semver 排序，
/// 免得 `0.10` 被字典序排到 `0.9` 前面。
fn sort_newest_first(installs: &mut [InstalledDsh]) {
    let mut versions: Vec<String> = installs
        .iter()
        .filter_map(|item| item.version.clone())
        .collect();
    versions.sort();
    versions.dedup();
    dsharbor_core::registry::sort_newest_first(&mut versions);
    let rank = |version: &Option<String>| -> usize {
        match version {
            Some(version) => versions
                .iter()
                .position(|known| known == version)
                .unwrap_or(usize::MAX),
            None => usize::MAX,
        }
    };
    installs.sort_by(|left, right| {
        rank(&left.version)
            .cmp(&rank(&right.version))
            .then_with(|| left.source.cmp(&right.source))
            .then_with(|| left.path.cmp(&right.path))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install(version: Option<&str>, source: &str, path: &str) -> InstalledDsh {
        InstalledDsh {
            version: version.map(str::to_string),
            source: source.to_string(),
            path: path.to_string(),
            in_use: false,
            install_method: None,
        }
    }

    #[test]
    fn install_method_is_read_from_npx_specs() {
        // 钉版本写法 → 版本号安装；只有裸包名 / @标签 → 自动最新；一条 spec 都没有 → 不标。
        assert_eq!(
            install_method_of(&["@deepseek-ai/dsh@0.2.1-rc.2".to_string()]),
            Some("pinned")
        );
        assert_eq!(
            install_method_of(&[
                "@deepseek-ai/dsh".to_string(),
                "@deepseek-ai/dsh@next".to_string()
            ]),
            Some("auto")
        );
        assert_eq!(install_method_of(&[]), None);
    }

    #[test]
    fn semver_order_puts_newest_first_and_unreadable_last() {
        let mut items = vec![
            install(Some("0.9.0"), "npx", "a"),
            install(None, "npm", "b"),
            install(Some("0.10.0"), "npx", "c"),
            install(Some("0.2.1-rc.2"), "npx", "d"),
        ];
        sort_newest_first(&mut items);
        let versions: Vec<Option<&str>> = items.iter().map(|i| i.version.as_deref()).collect();
        assert_eq!(
            versions,
            vec![Some("0.10.0"), Some("0.9.0"), Some("0.2.1-rc.2"), None]
        );
    }

    #[test]
    fn delete_errors_are_translated_into_plain_words() {
        let busy = std::io::Error::other("being used by another process (os error 32)");
        assert!(describe_io_error(&busy, "D:/x").contains("文件被占用"));
        let denied = std::io::Error::other("Access is denied. (os error 5)");
        assert!(describe_io_error(&denied, "D:/x").contains("没有权限删除"));
        let gone = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(describe_io_error(&gone, "D:/x").contains("已经不存在"));
    }

    #[test]
    fn npx_in_use_only_matches_an_explicit_version() {
        let pick = |mode: LaunchMode, version: Option<&str>| {
            let config = LaunchConfig {
                mode,
                runtime: Runtime::Default,
                extra_args: Vec::new(),
                port: None,
            };
            npx_in_use(&config, version)
        };
        assert!(pick(
            LaunchMode::Npx {
                version: Some("0.3.0".into())
            },
            Some("0.3.0")
        ));
        assert!(!pick(
            LaunchMode::Npx {
                version: Some("0.3.0".into())
            },
            Some("0.2.0")
        ));
        // 自动（最新）不猜它这次会命中哪个缓存目录。
        assert!(!pick(LaunchMode::Npx { version: None }, Some("0.3.0")));
        // 非 npx 启动方式与 npx 缓存无关。
        assert!(!pick(LaunchMode::System, Some("0.3.0")));
    }
}
