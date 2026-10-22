//! 插件开关（外壳侧）：读清单、调用核心库算出「启用 / 停用」、改写补丁层。
//!
//! 分工：判断「每个插件现在是什么状态」「该往补丁层写什么」全在
//! `dsharbor_core::plugin_switch` 里（有单测）；这里只做三件与系统相关的事——
//! 找到环境目录、把每个插件的 bundle 补丁文件读出来拼成文本、改写前后读写文件。
//!
//! 宿主与 WSL 两侧读的都是同一套文件名：`dsh.bundle.patch.yml` 与
//! `cordis.patch.yml`。为什么不去解析包 `package.json` 里声明的
//! `dsh.bundle.patch` 路径：WSL 侧只有 bash，解析 JSON 要么引依赖要么写正则，
//! 而实测所有插件都落在两个名字之一；认不出来只会让那一项显示成「不可开关」，
//! 不会误改任何文件。

use dsharbor_core::launch::LaunchConfig;
use dsharbor_core::patch_layer;
use dsharbor_core::plugin_switch::{self, PluginItem};
use dsharbor_core::profiles::BRIDGE_PLUGIN;
use serde::Serialize;
use tauri::AppHandle;

use crate::patch;
use crate::plugin::{join_path, profile_dir, read_file, write_file, wsl_script, Target};

/// 需要扫描的补丁文件名（与核心库里的候选表保持同一来源）。
const PATCH_CANDIDATES: &[&str] = plugin_switch::BUNDLE_PATCH_CANDIDATES;

/// 插件包在环境目录里的根（pnpm 的常规布局）。
const NODE_MODULES: &str = "node_modules";

/// 一次开关的结果：说明文案 + 本次自动备份的位置 + 刷新后的插件清单。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleOutcome {
    /// 给用户看的中文说明（含「重启后生效」的提醒）。
    pub message: String,
    /// 本次开关前自动产生的补丁层备份，完整路径。
    pub backup: String,
    /// 关掉桥接插件时的额外提醒（其它情况没有）。
    pub warning: Option<String>,
    /// 切换后该环境的插件清单。
    pub items: Vec<PluginItem>,
}

/// 只允许安全字符的包名（拼路径用；带引号/空格的直接不发出去）。
///
/// 名字来自用户环境的 `package.json`，会进 bash 脚本与文件路径，所以先过一遍。
/// 不安全的名字只是读不到挂载点，于是那一项显示成「不可开关」。
fn safe_bundle_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '@' | '.' | '_' | '-' | '/'))
        && !name.contains("..")
        && !name.starts_with('/')
}

/// 宿主侧：按「包名 → 候选文件名」把各插件的 bundle 补丁文件拼成一份文本。
///
/// 返回 `@@bundle@@ <包名>` 开头的记录串（解析在核心库的 `mount_points`）。
fn host_bundle_patch_texts(dir: &str, bundles: &[String]) -> String {
    let mut text = String::new();
    for name in bundles {
        if !safe_bundle_name(name) {
            continue;
        }
        for candidate in PATCH_CANDIDATES {
            let path = std::path::PathBuf::from(dir)
                .join(NODE_MODULES)
                .join(name)
                .join(candidate);
            let Ok(body) = std::fs::read_to_string(&path) else {
                continue;
            };
            text.push_str(plugin_switch::BUNDLE_MARKER);
            text.push_str(name);
            text.push('\n');
            text.push_str(&body);
            text.push('\n');
            break;
        }
    }
    text
}

/// WSL 侧：同样的文字，用一条 bash 脚本在发行版里拼出来。
fn wsl_bundle_patch_texts(distro: &str, dir: &str, bundles: &[String]) -> Result<String, String> {
    let safe: Vec<&String> = bundles
        .iter()
        .filter(|name| safe_bundle_name(name))
        .collect();
    if safe.is_empty() {
        return Ok(String::new());
    }
    let names = safe
        .iter()
        .map(|name| format!("'{name}'"))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "for n in {names}; do \
         for c in {candidates}; do \
         f=\"{dir}/node_modules/$n/$c\"; \
         if [ -f \"$f\" ]; then printf '%s%s\\n' '{marker}' \"$n\"; cat -- \"$f\"; printf '\\n'; break; fi; \
         done; done",
        candidates = PATCH_CANDIDATES.join(" "),
        marker = plugin_switch::BUNDLE_MARKER,
    );
    wsl_script(distro, &script, std::time::Duration::from_secs(60))
}

/// 读某个环境里所有插件的挂载点（`包名 → entry id`）。
fn read_mounts(
    target: &Target,
    dir: &str,
    bundles: &[String],
) -> Result<Vec<(String, Vec<String>)>, String> {
    let text = match target {
        Target::Host => host_bundle_patch_texts(dir, bundles),
        Target::Wsl { distro } => wsl_bundle_patch_texts(distro, dir, bundles)?,
    };
    Ok(plugin_switch::mount_points(&text))
}

/// 读环境的 `package.json`。
fn read_manifest(target: &Target, dir: &str) -> Result<String, String> {
    read_file(target, &join_path(target, dir, "package.json"))
}

/// 读补丁层；文件不存在按空串处理（新环境或用户自己删了都算「没有任何禁用表达」）。
fn read_patch_layer(target: &Target, dir: &str) -> Result<String, String> {
    let path = join_path(target, dir, patch_layer::PATCH_FILE);
    match read_file(target, &path) {
        Ok(text) => Ok(text),
        Err(_) => Ok(String::new()),
    }
}

/// 读插件自带的说明文字：包 `package.json` 里的 `description` 字段。
///
/// 清单是展示用途，单个包读失败（没装好、坏 JSON、没这个字段）不拦清单——那一项
/// 少一行说明而已，所以一切失败都静默给 `None`。名字先过 `safe_bundle_name`，
/// 防止拼出奇怪的路径。
fn read_description(target: &Target, dir: &str, name: &str) -> Option<String> {
    if !safe_bundle_name(name) {
        return None;
    }
    let path = join_path(target, dir, &format!("{NODE_MODULES}/{name}/package.json"));
    let text = read_file(target, &path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let desc = value.get("description")?.as_str()?.trim().to_string();
    (!desc.is_empty()).then_some(desc)
}

/// 给清单逐项补上说明文字；其余字段原样保留。
fn with_descriptions(target: &Target, dir: &str, mut items: Vec<PluginItem>) -> Vec<PluginItem> {
    for item in &mut items {
        item.description = read_description(target, dir, &item.name);
    }
    items
}

/// 列出某个环境当前加载的插件（带启用状态、是否桥接、是否可开关）。
pub fn items(
    _app: &AppHandle,
    config: &LaunchConfig,
    profile: &str,
) -> Result<Vec<PluginItem>, String> {
    let target = Target::of(config);
    let dir = profile_dir(&target, profile)?;
    let manifest = read_manifest(&target, &dir)?;
    let bundles = plugin_switch::bundle_names(&manifest)?;
    let mounts = read_mounts(&target, &dir, &bundles)?;
    let patch = read_patch_layer(&target, &dir)?;
    Ok(with_descriptions(
        &target,
        &dir,
        plugin_switch::items(&manifest, &mounts, &patch)?,
    ))
}

/// 开关一个插件：自动备份补丁层 → 改写补丁层 → 回报刷新后的清单。
///
/// `name` 必须是该环境 `dsh.profile.bundles` 里登记过的名字；挂载点读不到（官方
/// 内置骨架包）时明确拒绝，而不是往补丁层里塞一个 DSH 不认识的 id。
pub fn toggle(
    app: &AppHandle,
    config: &LaunchConfig,
    profile: &str,
    name: &str,
    enabled: bool,
) -> Result<ToggleOutcome, String> {
    let target = Target::of(config);
    let dir = profile_dir(&target, profile)?;
    let manifest = read_manifest(&target, &dir)?;
    let bundles = plugin_switch::bundle_names(&manifest)?;
    if !bundles.iter().any(|bundle| bundle == name) {
        return Err(format!(
            "环境「{profile}」里没有登记插件「{name}」，可能是清单刚变过，刷新后再试。"
        ));
    }

    let mounts = read_mounts(&target, &dir, &bundles)?;
    let entries: Vec<String> = mounts
        .iter()
        .find(|(bundle, _)| bundle == name)
        .map(|(_, ids)| ids.clone())
        .unwrap_or_default();
    if entries.is_empty() {
        return Err(format!(
            "读不到「{name}」在补丁层里的挂载点，壳没法安全地开关它（官方内置的骨架包就是这样，它也不会被禁用）。"
        ));
    }

    let patch_path = join_path(&target, &dir, patch_layer::PATCH_FILE);
    let current = read_file(&target, &patch_path)
        .map_err(|err| format!("读不到补丁层，为避免改坏先停下（{patch_path}）：{err}"))?;
    // 先算好新内容再备份：内容算不出来（坏 YAML / 自定义表达式）就不该白白留一份备份，
    // 更不该动文件。
    let updated = plugin_switch::set_disabled(&current, &entries, !enabled)?;

    // 备份必须在写之前（票据要求：每次开关前自动备份一份补丁层）。
    let backup = patch::backup(app, config, profile)?;

    if updated != current {
        write_file(&target, &patch_path, &updated)?;
    }

    // 清单同样要补说明文字：开关回包里的行会整行替换界面上的行，漏了描述
    // 开关一次描述就消失。
    let items = with_descriptions(
        &target,
        &dir,
        plugin_switch::items(&manifest, &mounts, &updated)?,
    );
    let mut message = plugin_switch::toggle_message(name, enabled);
    message.push_str(&format!("已自动备份补丁层：{}", backup.path));
    Ok(ToggleOutcome {
        message,
        backup: backup.path,
        warning: if name == BRIDGE_PLUGIN && !enabled {
            Some(plugin_switch::bridge_off_warning().to_string())
        } else {
            None
        },
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_bundle_names_never_reach_a_path_or_a_shell() {
        assert!(safe_bundle_name("dsharbor-bridge"));
        assert!(safe_bundle_name("@deepseek-ai/dsh-base"));
        assert!(safe_bundle_name("dsh.better_sidebar"));
        assert!(!safe_bundle_name(""));
        assert!(!safe_bundle_name("a b"));
        assert!(!safe_bundle_name("a'b"));
        assert!(!safe_bundle_name("../../etc/passwd"));
        assert!(!safe_bundle_name("/abs"));
        assert!(!safe_bundle_name("a;rm -rf /"));
    }

    #[test]
    fn host_reading_prefers_the_first_existing_candidate_per_bundle() {
        let root =
            std::env::temp_dir().join(format!("dsharbor-plugin-switch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.to_string_lossy().to_string();

        // 一个插件用第一个候选名，另一个只用第二个；第三个装了但没补丁文件。
        let first = root.join(NODE_MODULES).join("dsh-one");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::write(
            first.join(PATCH_CANDIDATES[0]),
            "- insert:\n    - id: one-row\n",
        )
        .unwrap();
        // 第一个候选名也写一份「错的内容」，验证只取第一个存在的候选。
        let second = root.join(NODE_MODULES).join("@scope").join("dsh-two");
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(
            second.join(PATCH_CANDIDATES[1]),
            "- insert:\n    - id: two-row\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join(NODE_MODULES).join("dsh-none")).unwrap();

        let bundles = vec![
            "dsh-one".to_string(),
            "@scope/dsh-two".to_string(),
            "dsh-none".to_string(),
            "a b".to_string(),
        ];
        let mounts = plugin_switch::mount_points(&host_bundle_patch_texts(&dir, &bundles));
        assert_eq!(
            mounts,
            vec![
                ("dsh-one".to_string(), vec!["one-row".to_string()]),
                ("@scope/dsh-two".to_string(), vec!["two-row".to_string()]),
            ],
            "没有补丁文件与名字不安全的包都不该出现"
        );

        // 第一个候选存在时不再看第二个，避免同一个包被两份文件干扰。
        std::fs::write(
            first.join(PATCH_CANDIDATES[1]),
            "- insert:\n    - id: ignored-row\n",
        )
        .unwrap();
        let mounts =
            plugin_switch::mount_points(&host_bundle_patch_texts(&dir, &["dsh-one".to_string()]));
        assert_eq!(mounts[0].1, vec!["one-row".to_string()]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn description_is_read_from_the_package_json_and_failures_stay_silent() {
        let root =
            std::env::temp_dir().join(format!("dsharbor-plugin-desc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.to_string_lossy().to_string();
        let target = Target::Host;

        // 正常路径：package.json 里带 description（含首尾空白，读出来要 trim）。
        let good = root.join(NODE_MODULES).join("dsh-good");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(
            good.join("package.json"),
            r#"{"name":"dsh-good","version":"1.0.0","description":"  给 DSH 加一排侧边栏  "}"#,
        )
        .unwrap();
        assert_eq!(
            read_description(&target, &dir, "dsh-good").as_deref(),
            Some("给 DSH 加一排侧边栏"),
            "描述取 description 字段并去掉首尾空白"
        );

        // 空字符串等于没有描述。
        let empty = root.join(NODE_MODULES).join("dsh-empty-desc");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::write(
            empty.join("package.json"),
            r#"{"name":"dsh-empty-desc","description":"   "}"#,
        )
        .unwrap();
        assert_eq!(read_description(&target, &dir, "dsh-empty-desc"), None);

        // 其余失败都静默给 None：没有 package.json、坏 JSON、没这个字段。
        std::fs::create_dir_all(root.join(NODE_MODULES).join("dsh-no-json")).unwrap();
        std::fs::write(
            root.join(NODE_MODULES)
                .join("dsh-no-json")
                .join("package.json"),
            "{ not json",
        )
        .unwrap();
        std::fs::create_dir_all(root.join(NODE_MODULES).join("dsh-no-desc")).unwrap();
        std::fs::write(
            root.join(NODE_MODULES)
                .join("dsh-no-desc")
                .join("package.json"),
            r#"{"name":"dsh-no-desc"}"#,
        )
        .unwrap();
        assert_eq!(read_description(&target, &dir, "dsh-missing"), None);
        assert_eq!(read_description(&target, &dir, "dsh-no-json"), None);
        assert_eq!(read_description(&target, &dir, "dsh-no-desc"), None);

        // 不安全的包名连路径都不该拼出去。
        assert_eq!(read_description(&target, &dir, "../../etc/passwd"), None);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn descriptions_are_attached_to_items_without_changing_the_rest() {
        let root =
            std::env::temp_dir().join(format!("dsharbor-plugin-desc-rich-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.to_string_lossy().to_string();
        let target = Target::Host;

        let pkg = root.join(NODE_MODULES).join("dsh-rich");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"dsh-rich","description":"带说明的插件"}"#,
        )
        .unwrap();
        std::fs::write(
            pkg.join(PATCH_CANDIDATES[0]),
            "- insert:\n    - id: rich-row\n",
        )
        .unwrap();

        let items = with_descriptions(
            &target,
            &dir,
            vec![
                PluginItem {
                    name: "dsh-rich".to_string(),
                    entries: vec!["rich-row".to_string()],
                    enabled: true,
                    bridge: false,
                    manual: false,
                    switchable: true,
                    description: None,
                },
                PluginItem {
                    name: "dsh-bare".to_string(),
                    entries: vec![],
                    enabled: true,
                    bridge: false,
                    manual: false,
                    switchable: false,
                    description: None,
                },
            ],
        );
        assert_eq!(items[0].description.as_deref(), Some("带说明的插件"));
        assert_eq!(items[1].description, None, "读不到的包留空，不编造");
        assert_eq!(items[0].name, "dsh-rich", "其余字段原样保留");

        let _ = std::fs::remove_dir_all(&root);
    }
}
