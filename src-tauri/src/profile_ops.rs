//! 环境的生命周期动作（新建 / 复制 / 重命名 / 删除）的外壳侧实现。
//!
//! 划分：规则全在核心库 `dsharbor_core::profile_ops`（复制排除清单、骨架文件内容、
//! 清单改写、四个动作的守卫，都有单测）；这里只做与操作系统打交道的事——
//! 建目录、递归复制、改名、递归删目录，宿主直连与 WSL 各一条路径。
//!
//! 一致的做法：先按守卫算出结论（不合法就早退，一个字节都不碰磁盘），
//! 再做动作，最后把「做了什么」整理成给人看的一句话返回给界面。

use std::path::Path;

use dsharbor_core::launch::{LaunchConfig, PluginOp};
use dsharbor_core::profile_ops;
use dsharbor_core::profiles::{self, ProfileSummary};
use serde::Serialize;

use crate::plugin::{self, Target};

/// 目录/文件操作超时（复制一份不含依赖的环境只有几十 KB，给足余量）。
const PROFILE_FS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// 安装依赖可能要拉几百 MB，给足时间。
const DEPS_INSTALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(900);

/// 生命周期动作的结果：一句话说明 + 新环境摘要（界面据此刷新）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileOutcome {
    /// 动作是否达成（守卫拒绝时是 Err，不走这里）。
    pub ok: bool,
    pub message: String,
    /// 动作涉及的环境名（新建/复制/重命名是新名字，删除是被删的名字）。
    pub name: String,
    /// 动作之后该环境的摘要（删除时为 None）。
    pub summary: Option<ProfileSummary>,
}

/// WSL 里目录存不存在。
///
/// Host 侧的 `Path::is_dir` 在 WSL 上不成立，只能进发行版里问一句；
/// `profile_exists` 与 `deps_installed` 都要问同一件事，写法抽在这里一处。
/// 注意壳只能看 `stdout` 的 `yes`：`wsl.exe` 自身的退出码在这里不代表结果。
fn wsl_dir_exists(distro: &str, dir: &str) -> Result<bool, String> {
    let script = format!("[ -d '{dir}' ] && echo yes || echo no");
    let out = plugin::wsl_script(distro, &script, PROFILE_FS_TIMEOUT)?;
    Ok(out.trim() == "yes")
}

/// 某个环境目录是否存在。
pub fn profile_exists(target: &Target, name: &str) -> Result<bool, String> {
    let dir = plugin::profile_dir(target, name)?;
    match target {
        Target::Host => Ok(Path::new(&dir).is_dir()),
        Target::Wsl { distro } => wsl_dir_exists(distro, &dir),
    }
}

/// 环境目录里有没有装过依赖（决定界面要不要标「依赖未安装」）。
fn deps_installed(target: &Target, dir: &str) -> bool {
    match target {
        Target::Host => Path::new(dir).join("node_modules").is_dir(),
        Target::Wsl { distro } => {
            wsl_dir_exists(distro, &join(target, dir, "node_modules")).unwrap_or(false)
        }
    }
}

/// 读某个环境的摘要（带「依赖装过没」）。
pub fn summarize_dir(target: &Target, name: &str, dir: &str) -> Result<ProfileSummary, String> {
    let package_json = plugin::read_file(target, &join(target, dir, "package.json"))?;
    Ok(profiles::summarize(name, &package_json)?.with_deps(deps_installed(target, dir)))
}

/// 列目录里的顶层条目名（用于复制时决定跳过什么）。
fn list_entries(target: &Target, dir: &str) -> Result<Vec<(String, bool)>, String> {
    match target {
        Target::Host => {
            let entries =
                std::fs::read_dir(dir).map_err(|err| format!("读取目录 {dir} 失败：{err}"))?;
            let mut items = Vec::new();
            for entry in entries.flatten() {
                let Ok(name) = entry.file_name().into_string() else {
                    continue;
                };
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                items.push((name, is_dir));
            }
            Ok(items)
        }
        Target::Wsl { distro } => {
            // 隐藏项也要列（`.npmrc`、`.plugin-manager` 之类要跟着复制）：
            // 多写一条 `.[!.]*` 把它们包含进来。目录还是文件用 `-d` 现场判断，
            // 软链接按文件对待、不跟随——跟随会把用户指向外部的大目录一起复制进来。
            let script = format!(
                "for entry in '{dir}'/* '{dir}'/.[!.]*; do \
                 [ -e \"$entry\" ] || [ -L \"$entry\" ] || continue; \
                 kind=d; [ -d \"$entry\" ] || kind=f; \
                 printf '%s\\t%s\\n' \"$kind\" \"$(basename \"$entry\")\"; \
                 done"
            );
            let out = plugin::wsl_script(distro, &script, PROFILE_FS_TIMEOUT)?;
            Ok(out
                .lines()
                .filter_map(|line| {
                    let (kind, name) = line.split_once('\t')?;
                    Some((name.to_string(), kind.trim() == "d"))
                })
                .collect())
        }
    }
}

fn join(target: &Target, dir: &str, name: &str) -> String {
    match target {
        Target::Host => Path::new(dir).join(name).to_string_lossy().to_string(),
        Target::Wsl { .. } => format!("{dir}/{name}"),
    }
}

// ---------------------------------------------------------------------------
// 新建
// ---------------------------------------------------------------------------

/// 新建一个空白环境：只写 DSH 的四个骨架文件，不装依赖、不调 DSH。
///
/// 为什么不调 `dsh <名字> --from-default-profile web`：那条命令会顺带装依赖
/// （几百 MB、分钟级），而票要求「新建后就能在下拉里看到」；四个骨架文件的内容
/// 在核心库里有单测固定，与 DSH 自己产出的模板逐字一致。
pub fn create(config: &LaunchConfig, name: &str) -> Result<ProfileOutcome, String> {
    let target = Target::of(config);
    let exists = profile_exists(&target, name)?;
    profile_ops::guard_create(name, exists)?;
    let dir = plugin::profile_dir(&target, name)?;
    let files = profile_ops::skeleton_files(name)?;
    ensure_dir(&target, &dir, name)?;
    for (file, content) in files {
        plugin::write_file(&target, &join(&target, &dir, file), &content)?;
    }
    let summary = summarize_dir(&target, name, &dir)?;
    Ok(ProfileOutcome {
        ok: true,
        message: format!(
            "已在 {} 上新建空白环境「{name}」（只写了骨架文件，还没装依赖）。",
            target.label()
        ),
        name: name.to_string(),
        summary: Some(summary),
    })
}

/// 建环境目录；已存在就报错而不是往别人的目录里写文件。
fn ensure_dir(target: &Target, dir: &str, name: &str) -> Result<(), String> {
    match target {
        Target::Host => {
            if Path::new(dir).exists() {
                return Err(format!("环境「{name}」的目录已经存在：{dir}"));
            }
            std::fs::create_dir_all(dir).map_err(|err| format!("创建目录 {dir} 失败：{err}"))
        }
        Target::Wsl { distro } => {
            // `mkdir -p` 先保证 profiles 根目录在（首次使用时可能还不存在），
            // 再用不带 -p 的 `mkdir` 建环境目录——它自带「已存在就失败」，正好是要的语义。
            let root = format!("{dir}/..");
            let script = format!("mkdir -p -- '{root}' && mkdir -- '{dir}'");
            plugin::wsl_script(distro, &script, PROFILE_FS_TIMEOUT).map(|_| ())
        }
    }
}

// ---------------------------------------------------------------------------
// 复制
// ---------------------------------------------------------------------------

/// 复制一份环境：不搬依赖、不搬锁文件，其余（补丁层、插件配置、缓存与数据目录）照搬。
///
/// 复制瞬间完成的关键就是「依赖目录整份跳过」——它占一份环境的 99% 体积；
/// 新环境会在返回结果里被标成「依赖未安装」，界面据此给出「重装依赖」按钮。
pub fn copy(config: &LaunchConfig, source: &str, name: &str) -> Result<ProfileOutcome, String> {
    let target = Target::of(config);
    let exists = profile_exists(&target, name)?;
    profile_ops::guard_copy(source, name, exists)?;
    let source_dir = plugin::profile_dir(&target, source)?;
    if !profile_exists(&target, source)? {
        return Err(format!("找不到要复制的环境「{source}」（{source_dir}）。"));
    }
    let dest_dir = plugin::profile_dir(&target, name)?;
    ensure_dir(&target, &dest_dir, name)?;

    let mut copied = 0usize;
    let mut skipped: Vec<String> = Vec::new();
    for (entry, is_dir) in list_entries(&target, &source_dir)? {
        if !profile_ops::should_copy(&entry, is_dir) {
            skipped.push(entry);
            continue;
        }
        copy_entry(
            &target,
            &join(&target, &source_dir, &entry),
            &join(&target, &dest_dir, &entry),
        )?;
        copied += 1;
    }
    skipped.sort();

    // 清单要换名字，并剔掉指回源环境目录的依赖（例如桥接插件的 file: 规格）。
    let rewrite = retarget(&target, &source_dir, &dest_dir, name)?;
    let summary = summarize_dir(&target, name, &dest_dir)?;
    let mut message = format!(
        "已复制「{source}」为「{name}」（{} 项配置与数据，依赖目录与锁文件未复制）。",
        copied
    );
    if !skipped.is_empty() {
        message.push_str(&format!("跳过：{}。", skipped.join("、")));
    }
    if !rewrite.is_empty() {
        message.push_str(&format!(
            "{} 指回原环境目录，未复制过去。",
            rewrite
                .iter()
                .map(|item| format!("依赖「{item}」"))
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    message.push_str("新环境还没装依赖，点「重装依赖」补齐后才能启动。");
    Ok(ProfileOutcome {
        ok: true,
        message,
        name: name.to_string(),
        summary: Some(summary),
    })
}

/// 复制一个顶层条目（目录递归；宿主与 WSL 各一条路径）。
fn copy_entry(target: &Target, source: &str, dest: &str) -> Result<(), String> {
    match target {
        Target::Host => copy_path_host(Path::new(source), Path::new(dest)),
        Target::Wsl { distro } => {
            // WSL 里用 cp -r：跨发行版内的文件系统复制比逐文件 shell 往返快得多。
            let script = format!("cp -r -- '{source}' '{dest}'");
            plugin::wsl_script(distro, &script, PROFILE_FS_TIMEOUT).map(|_| ())
        }
    }
}

fn copy_path_host(source: &Path, dest: &Path) -> Result<(), String> {
    if source.is_dir() {
        std::fs::create_dir_all(dest)
            .map_err(|err| format!("创建目录 {} 失败：{err}", dest.display()))?;
        let entries = std::fs::read_dir(source)
            .map_err(|err| format!("读取目录 {} 失败：{err}", source.display()))?;
        for entry in entries.flatten() {
            let name = entry.file_name();
            copy_path_host(&source.join(&name), &dest.join(&name))?;
        }
        return Ok(());
    }
    std::fs::copy(source, dest).map_err(|err| {
        format!(
            "复制 {} 到 {} 失败：{err}",
            source.display(),
            dest.display()
        )
    })?;
    Ok(())
}

/// 把源环境的清单改写进目标环境（改包名、剔掉指回源的依赖）。
fn retarget(
    target: &Target,
    source_dir: &str,
    dest_dir: &str,
    name: &str,
) -> Result<Vec<String>, String> {
    let path = join(target, dest_dir, "package.json");
    let package_json = plugin::read_file(target, &path)?;
    let rewrite = profile_ops::retarget_manifest(&package_json, name, source_dir)?;
    plugin::write_file(target, &path, &rewrite.json)?;
    Ok(rewrite.dropped_dependencies)
}

// ---------------------------------------------------------------------------
// 重命名
// ---------------------------------------------------------------------------

/// 重命名：目录名与清单里的名字一起改；选中的是它时由调用方同步配置。
pub fn rename(config: &LaunchConfig, old: &str, new: &str) -> Result<ProfileOutcome, String> {
    let target = Target::of(config);
    let new_exists = profile_exists(&target, new)?;
    profile_ops::guard_rename(old, new, new_exists)?;
    let old_dir = plugin::profile_dir(&target, old)?;
    if !profile_exists(&target, old)? {
        return Err(format!("找不到要重命名的环境「{old}」（{old_dir}）。"));
    }
    let new_dir = plugin::profile_dir(&target, new)?;
    move_dir(&target, &old_dir, &new_dir)?;
    // 目录换好了再改清单里的包名：改了名但目录没搬成会让环境彻底失联。
    // 传旧目录：清单里指回旧目录的依赖（如桥接插件的 file: 规格）随改名失效，直接剔掉。
    let package_json = plugin::read_file(&target, &join(&target, &new_dir, "package.json"))?;
    // 改写失败（清单不是合法 JSON 等）不能静默吞掉：目录已经搬完了，回滚比留着可用，
    // 但必须把「只改了一半」告诉用户，别让界面一边报「都改了」一边留着旧包名。
    let manifest_error = match profile_ops::retarget_manifest(&package_json, new, &old_dir) {
        Ok(rewrite) => {
            plugin::write_file(
                &target,
                &join(&target, &new_dir, "package.json"),
                &rewrite.json,
            )?;
            None
        }
        Err(err) => Some(err),
    };
    let summary = summarize_dir(&target, new, &new_dir)?;
    let message = match manifest_error {
        None => format!("已把「{old}」重命名为「{new}」（目录与清单里的名字都改了）。"),
        Some(err) => format!(
            "已把目录「{old}」改名为「{new}」，但清单里的名字没跟着改：{err}\n现在清单还写着旧名字，需要手动改，否则 DSH 会把这份环境当成另一份。"
        ),
    };
    Ok(ProfileOutcome {
        ok: true,
        message,
        name: new.to_string(),
        summary: Some(summary),
    })
}

fn move_dir(target: &Target, from: &str, to: &str) -> Result<(), String> {
    match target {
        Target::Host => std::fs::rename(from, to)
            .map_err(|err| format!("重命名目录失败（{from} → {to}）：{err}")),
        Target::Wsl { distro } => {
            let script = format!("mv -- '{from}' '{to}'");
            plugin::wsl_script(distro, &script, PROFILE_FS_TIMEOUT).map(|_| ())
        }
    }
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

/// 删除一份环境（递归删目录）。当前启动用的环境与桌面端目录由守卫拒绝。
pub fn delete(config: &LaunchConfig, current: &str, name: &str) -> Result<ProfileOutcome, String> {
    let target = Target::of(config);
    profile_ops::guard_delete(name, current)?;
    let dir = plugin::profile_dir(&target, name)?;
    if !profile_exists(&target, name)? {
        return Err(format!("找不到要删除的环境「{name}」（{dir}）。"));
    }
    remove_dir(&target, &dir)?;
    Ok(ProfileOutcome {
        ok: true,
        message: format!("已删除环境「{name}」（{dir}）。"),
        name: name.to_string(),
        summary: None,
    })
}

fn remove_dir(target: &Target, dir: &str) -> Result<(), String> {
    match target {
        Target::Host => {
            std::fs::remove_dir_all(dir).map_err(|err| format!("删除目录 {dir} 失败：{err}"))
        }
        Target::Wsl { distro } => {
            let script = format!("rm -rf -- '{dir}'");
            plugin::wsl_script(distro, &script, PROFILE_FS_TIMEOUT).map(|_| ())
        }
    }
}

// ---------------------------------------------------------------------------
// 安装依赖
// ---------------------------------------------------------------------------

/// 给一个环境安装依赖（官方 `dsh plugin --profile <名字> install`）。
///
/// 新建与复制出来的环境都缺这一步：骨架里没有 node_modules，DSH 启动时会因为
/// 找不到包直接失败。命令前缀复用当前启动方式（npx 渠道 / 系统命令 / 指定程序），
/// 与桥接插件的安装走同一条路。
pub fn install_deps(
    app: &tauri::AppHandle,
    config: &LaunchConfig,
    name: &str,
) -> Result<ProfileOutcome, String> {
    let target = Target::of(config);
    let dir = plugin::profile_dir(&target, name)?;
    if !profile_exists(&target, name)? {
        return Err(format!("找不到环境「{name}」（{dir}）。"));
    }
    let command = plugin::plugin_command(
        config,
        name,
        &PluginOp::InstallDeps,
        &plugin::plugin_env(app),
    )?;
    let (code, output) = plugin::run_capture(command, DEPS_INSTALL_TIMEOUT)?;
    let summary = summarize_dir(&target, name, &dir).ok();
    let installed = summary.as_ref().map(|s| s.deps_installed).unwrap_or(false);
    let message = format!(
        "重装依赖：dsh plugin --profile {} install（经 {}）\n退出码：{code}\n校验：{}\n输出：\n{}",
        plugin::cli_profile_label(name),
        target.label(),
        if installed {
            "node_modules 已就位 ✓"
        } else {
            "仍未看到 node_modules ✗（安装可能未生效）"
        },
        tail(&output, 4000)
    );
    Ok(ProfileOutcome {
        ok: code == 0 && installed,
        message,
        name: name.to_string(),
        summary,
    })
}

fn tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        text.to_string()
    } else {
        text.chars().skip(count - max).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dsharbor_core::launch::{LaunchConfig, LaunchMode, Runtime};

    /// 宿主路径上把四个动作整体走一遍：新建 → 复制 → 重命名 → 删除。
    ///
    /// 只用一个测试函数：`DSH_HOME` 是进程级环境变量，多个测试并行改它必然互相踩。
    /// 目录全在系统临时目录下本轮独享的子目录里，跑完即删。
    #[test]
    fn host_lifecycle_round_trip() {
        let root =
            std::env::temp_dir().join(format!("dsharbor-profile-ops-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // 安全问题：测试内改进程环境变量，仅本模块这一处改 DSH_HOME。
        unsafe { std::env::set_var("DSH_HOME", &root) };

        let config = LaunchConfig {
            mode: LaunchMode::System,
            runtime: Runtime::Default,
            extra_args: Vec::new(),
            port: None,
        };

        // 新建：四个骨架文件、没有 node_modules。
        let created = create(&config, "lab").unwrap();
        assert!(created.ok);
        assert_eq!(created.name, "lab");
        let summary = created.summary.expect("新建应带回摘要");
        assert!(!summary.deps_installed, "新建出来的环境不该有依赖");
        let dir = root.join("profiles").join("lab");
        for file in profile_ops::SKELETON_FILES {
            assert!(dir.join(file).is_file(), "缺骨架文件 {file}");
        }
        assert!(!dir.join(profile_ops::NODE_MODULES_DIR).exists());

        // 复制：依赖目录与锁文件不复制，清单里的包名换成新名字。
        std::fs::create_dir_all(dir.join(profile_ops::NODE_MODULES_DIR)).unwrap();
        std::fs::write(
            dir.join(profile_ops::LOCK_FILES[0]),
            "lockfileVersion: '9.0'\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("cache")).unwrap();
        std::fs::write(dir.join("cache").join("keep.txt"), "x").unwrap();
        let copied = copy(&config, "lab", "lab2").unwrap();
        assert!(copied.ok, "{}", copied.message);
        let copy_dir = root.join("profiles").join("lab2");
        assert!(!copy_dir.join(profile_ops::NODE_MODULES_DIR).exists());
        assert!(!copy_dir.join(profile_ops::LOCK_FILES[0]).exists());
        assert!(
            copy_dir.join("cache").join("keep.txt").is_file(),
            "普通目录要跟着复制"
        );
        let copied_json = std::fs::read_to_string(copy_dir.join("package.json")).unwrap();
        assert!(
            copied_json.contains("\"dsh-profile-lab2\""),
            "{copied_json}"
        );
        assert!(copied.message.contains("依赖未安装") || copied.message.contains("还没装依赖"));

        // 重命名：目录与清单一起改。
        let renamed = rename(&config, "lab2", "lab3").unwrap();
        assert!(renamed.ok, "{}", renamed.message);
        assert!(!root.join("profiles").join("lab2").exists());
        let renamed_dir = root.join("profiles").join("lab3");
        assert!(renamed_dir.is_dir());
        let renamed_json = std::fs::read_to_string(renamed_dir.join("package.json")).unwrap();
        assert!(
            renamed_json.contains("\"dsh-profile-lab3\""),
            "{renamed_json}"
        );
        assert!(
            renamed.message.contains("目录与清单"),
            "{}",
            renamed.message
        );

        // 重命名时清单改不动（这里是顶层不是对象；真实中的同类是手改坏的 JSON）：
        // 目录已经搬过去了，但仍要把「只改了一半」带到返回的说明里，
        // 不能让界面一边报「名字都改了」一边留着旧包名。
        let broken = "[1, 2, 3]\n";
        std::fs::write(renamed_dir.join("package.json"), broken).unwrap();
        let partial = rename(&config, "lab3", "lab4").expect("目录不合法才会走 Err");
        assert!(partial.ok, "{}", partial.message);
        assert_eq!(partial.name, "lab4");
        assert!(partial.message.contains("lab3"), "{}", partial.message);
        assert!(partial.message.contains("lab4"), "{}", partial.message);
        assert!(partial.message.contains("清单"), "{}", partial.message);
        assert!(
            !partial.message.contains("都改了"),
            "改写失败时不能说成两边都改了：{}",
            partial.message
        );
        let partial_dir = root.join("profiles").join("lab4");
        assert!(partial_dir.is_dir(), "目录搬家本身应该已经完成");
        assert!(!renamed_dir.exists());
        assert_eq!(
            std::fs::read_to_string(partial_dir.join("package.json")).unwrap(),
            broken,
            "改写失败时不该写一半"
        );

        // 删除：当前启动用的环境被拒绝。
        let err = delete(&config, "lab", "lab").unwrap_err();
        assert!(err.contains("当前"), "{err}");
        let deleted = delete(&config, "lab", "lab4").unwrap();
        assert!(deleted.ok, "{}", deleted.message);
        assert!(!partial_dir.exists());

        let _ = std::fs::remove_dir_all(&root);
    }
}
