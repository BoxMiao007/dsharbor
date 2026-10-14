//! profile 的 webserver 端口信息，以及「端口覆盖层」的落地。
//!
//! 为什么用 launcher 层 patch 覆盖端口、而不是 `--port` 旗标：
//! 用户 profile 里有第三方插件（remote-web-ui 的 lan-bind）写入的 webserver
//! 固定配置（host 0.0.0.0 / port 3080，标注 managed - do not edit），实测
//! `--port` 打不过它；而 launcher 层 patch（`dsh --patch <文件>`）在所有
//! 配置层之后应用、优先级最高，且只影响本次启动、不改用户的任何文件。
//! 解析与生成都是纯文本逻辑，放在核心库 `dsharbor_core::overlay` 里全自动测试。

use dsharbor_core::launch::LaunchConfig;
use dsharbor_core::overlay::{build_port_overlay, find_webserver_block};
use dsharbor_core::paths::windows_path_to_wsl;
use serde::Serialize;

use crate::plugin::{self, Target};

/// 界面展示用的 webserver 端口信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortHint {
    /// profile 里写死的 host（表达式时为空）。
    pub host: Option<String>,
    /// profile 里写死的端口；None 表示没读到（按 DSH 默认展示）。
    pub port: Option<u16>,
    /// "managed" = 来自 profile 的 webserver 配置块；"default" = 没读到。
    pub source: String,
}

/// 读取当前目标环境 profile 里 webserver 的托管端口信息。
pub fn port_hint(config: &LaunchConfig) -> Result<PortHint, String> {
    let target = Target::of(config);
    match read_profile_patch(&target)
        .as_deref()
        .and_then(find_webserver_block)
    {
        Some(block) => Ok(PortHint {
            host: block.host,
            port: block.port,
            source: "managed".into(),
        }),
        None => Ok(PortHint {
            host: None,
            port: None,
            source: "default".into(),
        }),
    }
}

/// 生成端口覆盖层文件，返回要追加到 dsh 命令上的 launcher 参数。
/// 未设置自定义端口时返回空数组（跟随 DSH 自身配置）。
pub fn port_overlay_args(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
) -> Result<Vec<String>, String> {
    let Some(port) = config.port else {
        return Ok(Vec::new());
    };
    let target = Target::of(config);
    // 尽量照抄现有 webserver 块的字段（保留 host / compression 等）；
    // 读不到块就按出厂形状兜底（见核心库 overlay.rs 的注释）。
    let block = read_profile_patch(&target)
        .as_deref()
        .and_then(find_webserver_block);
    let yaml = build_port_overlay(block.as_ref(), port);
    let dir = crate::app_data_root(app)?.join("runtime");
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建运行目录失败：{err}"))?;
    let path = dir.join("port-overlay.yml");
    std::fs::write(&path, yaml).map_err(|err| format!("写入端口覆盖文件失败：{err}"))?;
    // resource/app 数据目录可能带 \\?\ 扩展前缀（pnpm 与 WSL 都不认），先剥掉。
    let host_path = plugin::strip_extended_prefix(&path.to_string_lossy());
    let launcher_path = match &target {
        Target::Host => host_path,
        Target::Wsl { .. } => windows_path_to_wsl(&host_path)
            .ok_or_else(|| "应用数据目录不在 Windows 盘上，无法转换 WSL 路径".to_string())?,
    };
    Ok(vec!["--patch".into(), launcher_path])
}

/// 读取目标 profile 的 cordis.patch.yml（跨 Windows / WSL 两种目标环境）。
/// 文件不存在或读不动时返回 None（界面回退到默认提示、覆盖层走兜底形状）。
fn read_profile_patch(target: &Target) -> Option<String> {
    let profile = plugin::profile_dir(target).ok()?;
    plugin::read_file(target, &format!("{profile}/cordis.patch.yml")).ok()
}
