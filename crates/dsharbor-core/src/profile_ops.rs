//! 环境的生命周期动作（新建 / 复制 / 重命名 / 删除）的纯逻辑。
//!
//! 这里只吃字符串、吐字符串：骨架文件长什么样、复制时哪些条目要排除、
//! 换了名字之后清单里哪一行要跟着改、以及每个动作在什么情况下必须拒绝。
//! 真正的建目录、递归复制、改名、删目录都在壳那一层（`src-tauri`），
//! 于是这些规则可以在开发机上跑全自动测试，不需要在 Windows 上装 DSH。

use crate::profiles::{validate_name, DESKTOP_PROFILE, WEB_APP_BUNDLE};

/// DSH 环境包清单里必有的基础 bundle（新环境都从它起步）。
pub const BASE_BUNDLE: &str = "@deepseek-ai/dsh-base";

/// 依赖目录：复制时整份跳过（几百 MB，复制出来的环境要自己装依赖）。
pub const NODE_MODULES_DIR: &str = "node_modules";

/// 插件管理器的运行时状态目录：里面有进程 pid 与操作日志，
/// 复制到新环境只会让人误以为那边也有个进程在跑。
pub const PLUGIN_MANAGER_DIR: &str = ".plugin-manager";

/// 锁文件：里面的解析结果按原环境的目录算，照抄过去是错的。
pub const LOCK_FILES: [&str; 2] = ["pnpm-lock.yaml", "package.json.lock"];

/// 一份环境目录里的骨架文件（新建时逐个写出来；复制时空环境也是这四个）。
pub const SKELETON_FILES: [&str; 4] = [
    "package.json",
    "pnpm-workspace.yaml",
    "cordis.yml",
    "cordis.patch.yml",
];

const WORKSPACE_YAML: &str = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";

const CORDIS_YML: &str =
    "# dsh profile root — an empty entry list. The tree is composed as patches:\n\
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n\
# --patch overlays. Edit cordis.patch.yml, not this file.\n\
[]\n";

const CORDIS_PATCH_YML: &str =
    "# Your patch layer for this dsh profile, applied after every bundle layer:\n\
# a top-level YAML array of loader patch entries (id-targeted config\n\
# overrides, disables, and insert lists; `!!js` expressions allowed).\n\
[]\n";

/// 这个子目录要不要复制过去。
pub fn is_excluded_dir(name: &str) -> bool {
    name == NODE_MODULES_DIR || name == PLUGIN_MANAGER_DIR
}

/// 这个文件要不要复制过去。
pub fn is_lock_file(name: &str) -> bool {
    LOCK_FILES.contains(&name)
}

/// 复制时该跳过的顶层条目（宿主与 WSL 两条路径都按同一份清单拼过滤规则）。
pub fn skipped_entries() -> Vec<&'static str> {
    vec![
        NODE_MODULES_DIR,
        PLUGIN_MANAGER_DIR,
        LOCK_FILES[0],
        LOCK_FILES[1],
    ]
}

/// 复制时的总判定：目录看目录规则，文件看文件规则。
pub fn should_copy(name: &str, is_dir: bool) -> bool {
    if is_dir {
        !is_excluded_dir(name)
    } else {
        !is_lock_file(name)
    }
}

/// 环境清单里 `package.json` 的包名约定（DSH 自己建环境时也是这么写的）。
pub fn manifest_name(profile: &str) -> String {
    format!("dsh-profile-{profile}")
}

/// 新建空白环境时写出的四个文件（名字 → 内容）。
///
/// 内容与 DSH 自己 `--from-default-profile web` 产生的模板逐字一致：
/// 只有基础与网页两个 bundle、空的依赖表、空的补丁层，所以新环境里
/// 没有插件、能起网页界面，装依赖之前也占不了几十 MB。
pub fn skeleton_files(name: &str) -> Result<Vec<(&'static str, String)>, String> {
    validate_name(name)?;
    let package_json = format!(
        "{{\n  \"name\": \"{}\",\n  \"private\": true,\n  \"dependencies\": {{}},\n  \
         \"dsh\": {{\n    \"profile\": {{\n      \"bundles\": [\n        \"{BASE_BUNDLE}\",\n        \
         \"{WEB_APP_BUNDLE}\"\n      ]\n    }}\n  }}\n}}\n",
        manifest_name(name)
    );
    Ok(vec![
        (SKELETON_FILES[0], package_json),
        (SKELETON_FILES[1], WORKSPACE_YAML.to_string()),
        (SKELETON_FILES[2], CORDIS_YML.to_string()),
        (SKELETON_FILES[3], CORDIS_PATCH_YML.to_string()),
    ])
}

/// 清单改写的结果：新内容 + 被丢掉的那些依赖（界面用它说明复制时做了什么）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestRewrite {
    pub json: String,
    /// 因指向源环境目录而被丢掉的依赖名。
    pub dropped_dependencies: Vec<String>,
}

/// 把一份环境的清单搬到一个新名字上（复制与重命名共用）。
///
/// 两条规则：
/// 1. 包名：只有本来就是 DSH 约定的 `dsh-profile-<名字>` 才跟着换成新名字，
///    用户自己改过的包名不动——那是他的东西。
/// 2. 依赖：`file:` / `link:` 规格如果指进源环境目录（例如桥接插件装的那条
///    `file:<原来的环境>/…`），在新环境里要么指向别处要么已经不存在，直接去掉。
///    其它依赖原样保留，复制出来的环境照样知道自己该装什么。
pub fn retarget_manifest(
    package_json: &str,
    new_name: &str,
    source_dir: &str,
) -> Result<ManifestRewrite, String> {
    validate_name(new_name)?;
    let mut value: serde_json::Value = serde_json::from_str(package_json)
        .map_err(|err| format!("环境的 package.json 不是合法 JSON，无法改写：{err}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "环境的 package.json 顶层不是 JSON 对象，无法改写".to_string())?;

    if let Some(current) = object.get("name").and_then(|name| name.as_str()) {
        if current.starts_with("dsh-profile-") {
            object.insert(
                "name".into(),
                serde_json::Value::String(manifest_name(new_name)),
            );
        }
    }

    let source = normalize_path(source_dir);
    let mut dropped: Vec<String> = Vec::new();
    if let Some(dependencies) = object
        .get_mut("dependencies")
        .and_then(|deps| deps.as_object_mut())
    {
        for (dependency, spec) in dependencies.iter() {
            if spec_points_into(spec, &source) {
                dropped.push(dependency.clone());
            }
        }
        for dependency in &dropped {
            dependencies.remove(dependency);
        }
    }
    dropped.sort();

    let mut json = serde_json::to_string_pretty(&value)
        .map_err(|err| format!("改写后的 package.json 序列化失败：{err}"))?;
    json.push('\n');
    Ok(ManifestRewrite {
        json,
        dropped_dependencies: dropped,
    })
}

/// 路径比较用的归一化：统一分隔符、统一大小写（Windows 路径不区分大小写）。
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// 依赖规格是不是指进了某个目录（`file:` / `link:` 且路径包含该目录）。
fn spec_points_into(spec: &serde_json::Value, normalized_dir: &str) -> bool {
    let Some(spec) = spec.as_str() else {
        return false;
    };
    let Some(target) = spec
        .strip_prefix("file:")
        .or_else(|| spec.strip_prefix("link:"))
    else {
        return false;
    };
    if normalized_dir.is_empty() {
        return false;
    }
    normalize_path(target).contains(normalized_dir)
}

/// 新建环境的守卫。`exists` 由壳按磁盘实际情况传入。
pub fn guard_create(name: &str, exists: bool) -> Result<(), String> {
    validate_name(name)?;
    if name == DESKTOP_PROFILE {
        return Err(format!(
            "「{DESKTOP_PROFILE}」是官方桌面端独占的环境名，换一个名字。"
        ));
    }
    if exists {
        return Err(format!("环境「{name}」已经存在，换个名字或改用复制。"));
    }
    Ok(())
}

/// 复制环境的守卫。源可以是被壳隐藏的桌面端环境（复制只是读它）。
pub fn guard_copy(source: &str, name: &str, exists: bool) -> Result<(), String> {
    validate_name(source)?;
    guard_create(name, exists)?;
    if source == name {
        return Err(format!("源环境与目标环境的同名了：「{name}」。"));
    }
    Ok(())
}

/// 重命名环境的守卫。`new_exists` 由壳按磁盘实际情况传入。
pub fn guard_rename(old: &str, new: &str, new_exists: bool) -> Result<(), String> {
    validate_name(old)?;
    validate_name(new)?;
    if old == DESKTOP_PROFILE {
        return Err(format!(
            "「{DESKTOP_PROFILE}」属于官方桌面端，DSHarbor 不改它的名字。"
        ));
    }
    if old == new {
        return Err(format!("新旧环境名相同：「{new}」，没有需要改的地方。"));
    }
    guard_create(new, new_exists)
}

/// 删除环境的守卫：当前启动用的环境、官方桌面端目录都不许删，并说清原因。
pub fn guard_delete(name: &str, current: &str) -> Result<(), String> {
    validate_name(name)?;
    if name == DESKTOP_PROFILE {
        return Err(format!(
            "「{DESKTOP_PROFILE}」属于官方桌面端，不是 DSHarbor 管的环境，不能删除。"
        ));
    }
    if name == current {
        return Err(format!(
            "「{name}」是当前启动用的环境，先在「启动用环境」里切到别的环境再删除。"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> String {
        format!(
            "{{\n  \"name\": \"dsh-profile-web\",\n  \"private\": true,\n  \
             \"dependencies\": {{\n    \"left-pad\": \"^1.3.0\",\n    \
             \"staged-plugin\": \"file:C:/Users/x/.dsh/profiles/web/staging/plugin-1.0.0.tgz\",\n    \
             \"dsharbor-bridge\": \"file:C:/Users/x/AppData/Roaming/DSHarbor/cache/dsharbor-bridge-0.1.0.tgz\"\n  }},\n  \
             \"dsh\": {{ \"profile\": {{ \"bundles\": [\"{BASE_BUNDLE}\", \"{WEB_APP_BUNDLE}\", \"dsharbor-bridge\"] }} }}\n}}\n"
        )
    }

    #[test]
    fn dependency_directories_and_lock_files_are_not_copied() {
        assert!(!should_copy("node_modules", true));
        assert!(!should_copy(".plugin-manager", true));
        assert!(!should_copy("pnpm-lock.yaml", false));
        assert!(!should_copy("package.json.lock", false));
    }

    #[test]
    fn skipped_entries_lists_both_kinds() {
        let skipped = skipped_entries();
        assert_eq!(
            skipped,
            vec![
                NODE_MODULES_DIR,
                PLUGIN_MANAGER_DIR,
                LOCK_FILES[0],
                LOCK_FILES[1]
            ]
        );
        for dir in [NODE_MODULES_DIR, PLUGIN_MANAGER_DIR] {
            assert!(!should_copy(dir, true), "{dir}");
        }
        for lock in LOCK_FILES {
            assert!(!should_copy(lock, false), "{lock}");
        }
    }

    #[test]
    fn ordinary_profile_content_is_copied() {
        for name in [
            "package.json",
            "cordis.yml",
            "cordis.patch.yml",
            "hub-settings.json",
        ] {
            assert!(should_copy(name, false), "{name} 应该复制");
        }
        for name in ["cache", ".dsh-market", ".agents"] {
            assert!(should_copy(name, true), "{name} 应该复制");
        }
    }

    #[test]
    fn skeleton_has_the_four_files_dsh_itself_writes() {
        let files = skeleton_files("lab").unwrap();
        let names: Vec<&str> = files.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, SKELETON_FILES.to_vec());
        let package_json = &files[0].1;
        let value: serde_json::Value = serde_json::from_str(package_json).unwrap();
        assert_eq!(value["name"], "dsh-profile-lab");
        assert_eq!(value["private"], true);
        assert_eq!(value["dependencies"], serde_json::json!({}));
        let bundles = value["dsh"]["profile"]["bundles"].as_array().unwrap();
        assert_eq!(
            bundles,
            &vec![
                serde_json::Value::String(BASE_BUNDLE.into()),
                serde_json::Value::String(WEB_APP_BUNDLE.into())
            ]
        );
        // 空环境也能起网页界面，否则新建完在下拉里看不到它。
        let summary = crate::profiles::summarize("lab", package_json).unwrap();
        assert!(summary.is_selectable());
        assert_eq!(summary.plugins, 2);
    }

    #[test]
    fn skeleton_workspace_and_patch_files_are_the_expected_yaml() {
        let files = skeleton_files("lab").unwrap();
        assert_eq!(
            files[1].1,
            "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n"
        );
        assert!(files[2].1.starts_with("# dsh profile root"));
        assert!(files[2].1.ends_with("[]\n"));
        assert!(files[3]
            .1
            .starts_with("# Your patch layer for this dsh profile"));
        assert!(files[3].1.ends_with("[]\n"));
    }

    #[test]
    fn skeleton_refuses_illegal_names() {
        let err = skeleton_files("a b").unwrap_err();
        assert!(err.contains("不允许的字符"), "{err}");
    }

    #[test]
    fn manifest_name_follows_the_dsh_convention() {
        assert_eq!(manifest_name("lab"), "dsh-profile-lab");
    }

    #[test]
    fn retarget_renames_the_package_and_drops_paths_into_the_source() {
        let rewrite =
            retarget_manifest(&manifest(), "lab", "C:\\Users\\x\\.dsh\\profiles\\web").unwrap();
        let value: serde_json::Value = serde_json::from_str(&rewrite.json).unwrap();
        assert_eq!(value["name"], "dsh-profile-lab");
        // 指进源环境的 file: 依赖被丢掉；普通依赖与源环境之外的路径依赖保留。
        assert!(value["dependencies"].get("left-pad").is_some());
        assert!(value["dependencies"].get("dsharbor-bridge").is_some());
        assert!(value["dependencies"].get("staged-plugin").is_none());
        assert_eq!(
            rewrite.dropped_dependencies,
            vec!["staged-plugin".to_string()]
        );
        // bundles 是插件登记表，一个都不能变。
        assert_eq!(
            value["dsh"]["profile"]["bundles"].as_array().unwrap().len(),
            3
        );
    }

    #[test]
    fn retarget_keeps_absolute_dependencies_that_are_not_the_source_dir() {
        let json = "{\"dependencies\":{\"local\":\"file:D:/pkgs/local-1.0.0.tgz\"}}";
        let rewrite = retarget_manifest(json, "lab", "C:/Users/x/.dsh/profiles/web").unwrap();
        assert!(rewrite.dropped_dependencies.is_empty());
        let value: serde_json::Value = serde_json::from_str(&rewrite.json).unwrap();
        assert_eq!(
            value["dependencies"]["local"],
            "file:D:/pkgs/local-1.0.0.tgz"
        );
    }

    #[test]
    fn retarget_keeps_a_users_own_package_name() {
        let json = "{\"name\":\"my-weird-profile\",\"dependencies\":{}}";
        let rewrite = retarget_manifest(json, "lab", "C:/x").unwrap();
        let value: serde_json::Value = serde_json::from_str(&rewrite.json).unwrap();
        assert_eq!(value["name"], "my-weird-profile");
    }

    #[test]
    fn retarget_survives_a_manifest_without_dependencies() {
        let rewrite = retarget_manifest("{\"name\":\"dsh-profile-a\"}", "b", "C:/x").unwrap();
        let value: serde_json::Value = serde_json::from_str(&rewrite.json).unwrap();
        assert_eq!(value["name"], "dsh-profile-b");
        assert!(rewrite.dropped_dependencies.is_empty());
    }

    #[test]
    fn retarget_reports_broken_json() {
        let err = retarget_manifest("{oops", "lab", "C:/x").unwrap_err();
        assert!(err.contains("不是合法 JSON"), "{err}");
        let err = retarget_manifest("[1,2]", "lab", "C:/x").unwrap_err();
        assert!(err.contains("不是 JSON 对象"), "{err}");
    }

    #[test]
    fn copying_onto_an_existing_name_is_refused() {
        let err = guard_copy("web", "lab", true).unwrap_err();
        assert!(err.contains("已经存在"), "{err}");
        assert!(guard_copy("web", "lab", false).is_ok());
    }

    #[test]
    fn copying_onto_the_source_name_is_refused() {
        let err = guard_copy("web", "web", false).unwrap_err();
        assert!(err.contains("同名"), "{err}");
    }

    #[test]
    fn desktop_is_hidden_from_create_and_delete_but_allowed_as_a_copy_source() {
        assert!(guard_copy(DESKTOP_PROFILE, "mine", false).is_ok());
        let err = guard_create(DESKTOP_PROFILE, false).unwrap_err();
        assert!(err.contains(DESKTOP_PROFILE), "{err}");
        let err = guard_delete(DESKTOP_PROFILE, "web").unwrap_err();
        assert!(err.contains("官方桌面端"), "{err}");
        let err = guard_rename(DESKTOP_PROFILE, "mine2", false).unwrap_err();
        assert!(err.contains("官方桌面端"), "{err}");
    }

    #[test]
    fn the_environment_in_use_cannot_be_deleted() {
        let err = guard_delete("web", "web").unwrap_err();
        assert!(err.contains("当前启动用"), "{err}");
        assert!(err.contains("web"), "{err}");
        assert!(guard_delete("web", "lab").is_ok());
    }

    #[test]
    fn renaming_checks_the_new_name_like_creating_one() {
        assert!(guard_rename("web", "lab", false).is_ok());
        let err = guard_rename("web", "web", false).unwrap_err();
        assert!(err.contains("相同"), "{err}");
        let err = guard_rename("web", "lab", true).unwrap_err();
        assert!(err.contains("已经存在"), "{err}");
        let err = guard_rename("web", "环境", false).unwrap_err();
        assert!(err.contains("环境名"), "{err}");
    }

    #[test]
    fn illegal_names_get_readable_reasons_on_every_action() {
        for name in ["", "a b", "a/b", "../x"] {
            assert!(guard_create(name, false).is_err(), "{name:?}");
            assert!(guard_delete(name, "web").is_err(), "{name:?}");
            assert!(guard_rename("web", name, false).is_err(), "{name:?}");
        }
        let err = guard_create("a b", false).unwrap_err();
        assert!(err.contains("' '"), "{err}");
    }
}
