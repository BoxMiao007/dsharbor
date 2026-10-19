//! 补丁层（`cordis.patch.yml`）的备份与还原（外壳侧）。
//!
//! 为什么单开一个模块：桥接插件那套备份（`plugin.rs`）备的是 pnpm 会改写的四个
//! 文件，属于「装/卸载插件的保险」；这里备的只是用户手写的补丁层，动机也不同
//! ——用户要自己改补丁层时先按一下备份，改坏了再退回去。两套备份的文件、
//! 存放位置、保留策略都要能分开看，所以不塞进同一堆目录。
//!
//! 存放位置：`<应用数据目录>/backups/patch/<目标>/<环境>/patch-<unix 秒>.yml`。
//! 按目标（Windows 宿主 / 某个 WSL 发行版）和环境各分一层，是因为同名环境在宿主
//! 与发行版里可能都存在，混在一起会出现「在 Windows 上还原了 WSL 的补丁层」。
//!
//! 命名、时间序、保留份数与文案都在 `dsharbor_core::patch_layer` 里算好（有单测），
//! 这里只做读写文件与拼路径。

use std::path::{Path, PathBuf};

use dsharbor_core::launch::LaunchConfig;
use dsharbor_core::patch_layer::{self, PatchBackup};
use dsharbor_core::profiles;
use serde::Serialize;
use tauri::AppHandle;

use crate::plugin::{backups_root, join_path, profile_dir, read_file, write_file, Target};

/// 备份根下的子目录名（与桥接插件那套备份分开）。
const STORE_DIR: &str = "patch";

/// 一次备份/还原的结果：说明文案 + 本次产出的文件 + 刷新后的备份清单。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchOutcome {
    /// 给用户看的中文说明（含路径，失败原因不吞）。
    pub message: String,
    /// 本次产出的备份文件的完整路径（备份＝新备份；还原＝还原前另存的副本）。
    pub path: String,
    /// 该环境现有的补丁层备份，最旧在前。
    pub backups: Vec<PatchBackup>,
}

/// 目标在备份目录里的那一层名字：宿主固定 `host`，WSL 用发行版名（非法字符换掉，
/// 免得发行版名里的斜杠把路径拼歪）。
fn target_key(target: &Target) -> String {
    match target {
        Target::Host => "host".to_string(),
        Target::Wsl { distro } => {
            let safe: String = distro
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                        ch
                    } else {
                        '_'
                    }
                })
                .collect();
            format!("wsl-{safe}")
        }
    }
}

/// 某个环境下补丁层备份的存放目录（不创建）。
fn store_path(app: &AppHandle, target: &Target, profile: &str) -> Result<PathBuf, String> {
    profiles::validate_name(profile)?;
    Ok(backups_root(app)?
        .join(STORE_DIR)
        .join(target_key(target))
        .join(profile))
}

/// 同上，顺带把目录建出来（备份要用）。
fn store_dir(app: &AppHandle, target: &Target, profile: &str) -> Result<PathBuf, String> {
    let dir = store_path(app, target, profile)?;
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("创建补丁层备份目录失败（{}）：{err}", dir.display()))?;
    Ok(dir)
}

/// 目录里的文件名（只看文件，不递归）。
fn store_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect()
}

/// 把文件名变成界面能直接渲染的清单（最旧在前）。
fn collect(dir: &Path, names: &[String]) -> Vec<PatchBackup> {
    let entries = names
        .iter()
        .filter_map(|name| {
            patch_layer::stamp_of(name).map(|stamp| PatchBackup {
                name: name.clone(),
                path: dir.join(name).to_string_lossy().to_string(),
                stamp,
            })
        })
        .collect();
    patch_layer::sort_backups(entries)
}

/// 当前时刻的 unix 秒（备份文件名只到秒）。
fn now_stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|span| span.as_secs())
        .unwrap_or(0)
}

/// 按保留份数删掉多余备份，返回真正删掉的文件名。
///
/// `protect` 是还原时正在读的那一份：先另存当前版本会让份数超上限，
/// 而最旧的恰好可能是用户刚选中的备份——删了它等于「刚点的备份消失了」。
fn prune(dir: &Path, names: &[String], protect: Option<&str>) -> Vec<String> {
    let plan = match protect {
        Some(name) => patch_layer::prune_plan_protecting(names, patch_layer::BACKUP_KEEP, name),
        None => patch_layer::prune_plan(names, patch_layer::BACKUP_KEEP),
    };
    let mut removed = Vec::new();
    for name in plan {
        let path = dir.join(&name);
        match std::fs::remove_file(&path) {
            Ok(()) => removed.push(name),
            // 删不掉旧备份不该让这次操作失败：备份/还原本身已经成功。
            Err(err) => eprintln!("清理旧补丁层备份失败（{}）：{err}", path.display()),
        }
    }
    removed
}

/// 环境里补丁层文件的位置。
fn patch_path(target: &Target, profile: &str) -> Result<String, String> {
    let dir = profile_dir(target, profile)?;
    Ok(join_path(target, &dir, patch_layer::PATCH_FILE))
}

/// 列出某个环境现有的补丁层备份（最旧在前）。
pub fn list(
    app: &AppHandle,
    config: &LaunchConfig,
    profile: &str,
) -> Result<Vec<PatchBackup>, String> {
    let target = Target::of(config);
    let dir = store_path(app, &target, profile)?;
    Ok(collect(&dir, &store_names(&dir)))
}

/// 备份补丁层：读当前 `cordis.patch.yml`，另存一份带时间戳的副本。
///
/// 读不到原文件就报错（含路径与原始错误）：这时用户的意图是「改前留个底」，
/// 静默成功会让人以为有备份、其实一份都没有。
pub fn backup(
    app: &AppHandle,
    config: &LaunchConfig,
    profile: &str,
) -> Result<PatchOutcome, String> {
    let target = Target::of(config);
    let source = patch_path(&target, profile)?;
    let content = read_file(&target, &source)
        .map_err(|err| patch_layer::read_failed(profile, &source, &err))?;

    let dir = store_dir(app, &target, profile)?;
    let names = store_names(&dir);
    // 同一秒内连点两下也必须各存一份，不能互相覆盖。
    let stamp = patch_layer::next_stamp(&names, now_stamp());
    let name = patch_layer::backup_file_name(stamp);
    let path = dir.join(&name);
    std::fs::write(&path, content.as_bytes())
        .map_err(|err| format!("写入补丁层备份失败（{}）：{err}", path.display()))?;

    let mut after = names;
    after.push(name.clone());
    let removed = prune(&dir, &after, Some(&name));
    let path = path.to_string_lossy().to_string();
    Ok(PatchOutcome {
        message: patch_layer::backup_message(profile, &target.label(), &path, &removed),
        path,
        backups: collect(&dir, &store_names(&dir)),
    })
}

/// 还原到某一份备份。
///
/// 顺序是「先读备份内容 → 再把当前版本另存一份 → 最后写回」：先另存是为了
/// 让还原本身也能反悔（票据要求），但另存的文件名取 `max(现在, 最新+1)`，
/// 不会盖住将要读的那份备份。
pub fn restore(
    app: &AppHandle,
    config: &LaunchConfig,
    profile: &str,
    name: &str,
) -> Result<PatchOutcome, String> {
    // 名字来自界面，先确认它确实是我们产出的备份名：顺手挡掉路径穿越（`../x`）。
    if patch_layer::stamp_of(name).is_none() {
        return Err(format!("不是有效的补丁层备份文件名：{name}"));
    }
    let target = Target::of(config);
    let dir = store_path(app, &target, profile)?;
    let source = dir.join(name);
    let content = std::fs::read_to_string(&source)
        .map_err(|err| format!("读不到补丁层备份（{}）：{err}", source.display()))?;

    // 还原前先把当前版本另存一份（文件不存在就没有可存的东西）。
    let mut names = store_names(&dir);
    let saved = match read_file(&target, &patch_path(&target, profile)?) {
        Ok(current) => {
            let stamp = patch_layer::next_stamp(&names, now_stamp());
            let saved_name = patch_layer::backup_file_name(stamp);
            let saved_path = dir.join(&saved_name);
            std::fs::write(&saved_path, current.as_bytes()).map_err(|err| {
                format!(
                    "还原前另存当前补丁层失败（{}）：{err}",
                    saved_path.display()
                )
            })?;
            names.push(saved_name);
            Some(saved_path.to_string_lossy().to_string())
        }
        Err(_) => None,
    };

    let target_path = patch_path(&target, profile)?;
    write_file(&target, &target_path, &content)?;
    // 正在读的那份备份受保护：刚点的备份不能在这次操作里被清理掉。
    prune(&dir, &names, Some(name));

    Ok(PatchOutcome {
        message: patch_layer::restore_message(
            profile,
            &target.label(),
            &source.to_string_lossy(),
            saved.as_deref(),
        ),
        path: saved.unwrap_or_default(),
        backups: collect(&dir, &store_names(&dir)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_key_separates_host_from_wsl_distros() {
        assert_eq!(target_key(&Target::Host), "host");
        assert_eq!(
            target_key(&Target::Wsl {
                distro: "Ubuntu-22.04".to_string()
            }),
            "wsl-Ubuntu-22.04"
        );
        // 发行版名里的斜杠、空格不能拼进路径，否则会写到别的目录去。
        assert_eq!(
            target_key(&Target::Wsl {
                distro: "../etc/passwd".to_string()
            }),
            "wsl-.._etc_passwd"
        );
    }
}
