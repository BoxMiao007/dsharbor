//! 补丁层（`cordis.patch.yml`）的备份与还原：文件名、时间序、保留份数、说明文案。
//!
//! 补丁层是用户手写的插件覆盖层，一次误改就可能让 DSH 起不来，所以壳给它
//! 单独一条「备份 → 动手 → 还能退回去」的路。这一层只算纯逻辑（哪个文件名
//! 算备份、该删哪几份、话怎么说），读写文件与跑命令都在外壳那一层，
//! 这样备份规则可以全自动测试，不用碰真实磁盘。

use serde::Serialize;

/// 补丁层文件名（DSH 每次加载 bundle 之后都会叠加它）。
pub const PATCH_FILE: &str = "cordis.patch.yml";

/// 每个环境最多保留几份补丁层备份（与 profile 备份同一套份数，避免无限累积）。
pub const BACKUP_KEEP: usize = 5;

/// 备份文件名前缀（`patch-<unix 秒>.yml`）。
const NAME_PREFIX: &str = "patch-";
/// 备份文件名后缀。
const NAME_SUFFIX: &str = ".yml";

/// 一份补丁层备份（回给界面直接渲染）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchBackup {
    /// 文件名（`patch-<unix 秒>.yml`）。
    pub name: String,
    /// 完整路径（界面要显示出来，用户可能想自己去翻）。
    pub path: String,
    /// 备份时刻（unix 秒）。界面按本地时区渲染成人能读的时间。
    pub stamp: u64,
}

/// 备份文件名：时间戳直接进名字，所以按名字排序＝按时间排序。
pub fn backup_file_name(stamp: u64) -> String {
    format!("{NAME_PREFIX}{stamp}{NAME_SUFFIX}")
}

/// 从文件名反解时间戳；不是本模块产出的名字就返回 `None`。
///
/// 只认 `patch-<纯数字>.yml`：目录里可能混进用户自己丢的文件、编辑器临时文件
/// （`patch-123.yml.swp`）或 profile 备份目录，那些都不该被当成补丁层备份，
/// 更不该被「清理旧备份」删掉。
pub fn stamp_of(file_name: &str) -> Option<u64> {
    let middle = file_name
        .strip_prefix(NAME_PREFIX)?
        .strip_suffix(NAME_SUFFIX)?;
    if middle.is_empty() || !middle.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    middle.parse().ok()
}

/// 名字里的时间戳与名字一起参与排序：同一秒内产出两份时也要有稳定的先后。
fn ordered(names: &[String]) -> Vec<(u64, String)> {
    let mut entries: Vec<(u64, String)> = names
        .iter()
        .filter_map(|name| stamp_of(name).map(|stamp| (stamp, name.clone())))
        .collect();
    entries.sort();
    entries
}

/// 需要删掉的备份名：最旧在前。
///
/// `protect` 指定的那份永不参与——还原时正在读它，清掉它等于让用户刚选的备份消失。
/// 因为被保护的份仍占一份名额，超出部分由次旧的备份顶上去。
fn prune_plan_keeping(names: &[String], keep: usize, protect: Option<&str>) -> Vec<String> {
    let all = ordered(names);
    if all.len() <= keep {
        return Vec::new();
    }
    let excess = all.len() - keep;
    all.into_iter()
        .filter(|(_, name)| Some(name.as_str()) != protect)
        .take(excess)
        .map(|(_, name)| name)
        .collect()
}

/// 超出保留份数时该删掉的备份名，最旧的在前。
///
/// 只清本模块产出的备份：用户自己放的文件既不算数，也不会被删。
pub fn prune_plan(names: &[String], keep: usize) -> Vec<String> {
    prune_plan_keeping(names, keep, None)
}

/// 同上，但保住 `protect` 那一份（还原时正在读它）。
pub fn prune_plan_protecting(names: &[String], keep: usize, protect: &str) -> Vec<String> {
    prune_plan_keeping(names, keep, Some(protect))
}

/// 下一份备份该用的时间戳。
///
/// 备份文件名精确到秒，而「还原前先另存当前版本」很可能就在同一秒内发生：
/// 直接取当前时刻会和刚被还原的那一份撞名，把自己覆盖掉。所以取
/// `max(现在, 最新一份 + 1)`，保证每一份备份都有独立文件名、且排在它后面。
pub fn next_stamp(names: &[String], now: u64) -> u64 {
    match ordered(names).pop() {
        Some((newest, _)) => now.max(newest.saturating_add(1)),
        None => now,
    }
}

/// 最新一份备份的文件名（没有备份就是 `None`）。
pub fn latest_name(names: &[String]) -> Option<String> {
    ordered(names).pop().map(|(_, name)| name)
}

/// 把备份清单排成「最旧 → 最新」，界面照顺序列出来。
pub fn sort_backups(entries: Vec<PatchBackup>) -> Vec<PatchBackup> {
    let mut entries = entries;
    entries.sort_by(|left, right| {
        left.stamp
            .cmp(&right.stamp)
            .then_with(|| left.name.cmp(&right.name))
    });
    entries
}

/// 备份成功后的说明：备份落到哪个文件、保留几份、顺手清了哪些旧备份。
pub fn backup_message(profile: &str, target_label: &str, path: &str, pruned: &[String]) -> String {
    let mut message = format!(
        "已备份环境「{profile}」的补丁层（{PATCH_FILE}，经 {target_label}）到：\n{path}\n\
         每个环境只保留最近 {BACKUP_KEEP} 份补丁层备份。"
    );
    if !pruned.is_empty() {
        message.push_str(&format!(
            "\n旧备份清理：删除了 {} 份：{}",
            pruned.len(),
            pruned.join("、")
        ));
    }
    message
}

/// 还原成功后的说明：还原成哪一份、还原前的版本另存在哪、什么时候生效。
pub fn restore_message(profile: &str, target_label: &str, source: &str, saved: &str) -> String {
    format!(
        "已把环境「{profile}」的补丁层还原成：\n{source}\n（写回 {target_label} 上的 {PATCH_FILE}）\n\
         还原前的版本已另存一份，想反悔就再还原它：\n{saved}\n\
         补丁层要重启 DSH 后才生效。"
    )
}

/// DSH 正在运行时拒绝操作的说明。
///
/// 重装依赖要经 pnpm 写 `node_modules`，还原补丁层要改 DSH 自己加载的文件；
/// 运行中的 DSH 同时读写这两处，谁后写谁赢——所以先停下来，别抢。
pub fn session_busy(action: &str, profile: &str) -> String {
    format!(
        "DSH 正在运行，现在{action}会和运行中的进程争用环境「{profile}」的目录（pnpm 与 DSH 互相覆盖，结果不可预测）。\n请先停止 DSH，再{action}。"
    )
}

/// 读不到补丁层文件时的说明（含具体路径与原始错误，别把原因吞掉）。
pub fn read_failed(profile: &str, path: &str, err: &str) -> String {
    format!("读不到环境「{profile}」的补丁层文件（{path}）：{err}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[u64]) -> Vec<String> {
        list.iter().map(|stamp| backup_file_name(*stamp)).collect()
    }

    #[test]
    fn file_name_round_trips_through_stamp() {
        assert_eq!(backup_file_name(0), "patch-0.yml");
        assert_eq!(backup_file_name(1_717_085_120), "patch-1717085120.yml");
        for stamp in [0_u64, 1, 1_717_085_120, 4_102_444_800] {
            assert_eq!(
                stamp_of(&backup_file_name(stamp)),
                Some(stamp),
                "名字与时间戳必须能互相还原：{stamp}"
            );
        }
    }

    #[test]
    fn stamp_of_rejects_foreign_names() {
        // 补丁层正本、其它备份目录名、编辑器临时文件、非数字、空数字都要拒。
        for name in [
            "cordis.patch.yml",
            "patch-.yml",
            "patch-abc.yml",
            "patch-123.yml.swp",
            "patch-123.txt",
            "backup-1717085120",
            "",
        ] {
            assert_eq!(stamp_of(name), None, "不该当成补丁层备份：{name}");
        }
    }

    #[test]
    fn prune_plan_drops_the_oldest_and_orders_oldest_first() {
        // 故意打乱顺序：清理必须按时间，不按传进来的顺序。
        let mut list = names(&[500, 100, 300, 400, 200, 700, 600]);
        list.reverse();
        let plan = prune_plan(&list, BACKUP_KEEP);
        assert_eq!(plan, names(&[100, 200]), "超出的两份最旧备份先删");
    }

    #[test]
    fn prune_plan_is_empty_within_limit() {
        let list = names(&[100, 200, 300, 400, 500]);
        assert!(prune_plan(&list, BACKUP_KEEP).is_empty(), "刚好 5 份时不动");
        assert!(prune_plan(&[], BACKUP_KEEP).is_empty(), "一份都没有时不动");
        // keep = 0 时全都该删，顺序仍是最旧在前。
        assert_eq!(
            prune_plan(&names(&[200, 100]), 0),
            names(&[100, 200]),
            "keep 为 0 时全部清理"
        );
    }

    #[test]
    fn prune_plan_ignores_foreign_files() {
        // 用户自己丢在备份目录里的文件必须留着——清理只清本模块产出的备份。
        let mut list = names(&[100, 200, 300, 400, 500, 600]);
        list.push("cordis.patch.yml".to_string());
        list.push("手写的注释.txt".to_string());
        list.push("patch-notanumber.yml".to_string());
        let plan = prune_plan(&list, BACKUP_KEEP);
        assert_eq!(plan, names(&[100]), "{plan:?}");
    }

    #[test]
    fn latest_name_picks_the_newest() {
        assert_eq!(
            latest_name(&names(&[300, 100, 200])),
            Some(backup_file_name(300))
        );
        assert_eq!(latest_name(&[]), None);
        assert_eq!(latest_name(&["readme.txt".to_string()]), None);
    }

    #[test]
    fn sort_backups_orders_by_time_and_keeps_paths() {
        let entries = vec![
            PatchBackup {
                name: backup_file_name(300),
                path: "C:/x/patch-300.yml".into(),
                stamp: 300,
            },
            PatchBackup {
                name: backup_file_name(100),
                path: "C:/x/patch-100.yml".into(),
                stamp: 100,
            },
        ];
        let sorted = sort_backups(entries);
        assert_eq!(sorted[0].stamp, 100, "最旧的排最前");
        assert_eq!(sorted[1].path, "C:/x/patch-300.yml", "路径跟着一起走");
    }

    #[test]
    fn next_stamp_never_collides_with_an_existing_backup() {
        // 还原前先另存当前版本，很可能与刚被还原的那一份同秒：必须错开，
        // 否则新备份会盖住它即将读取的源文件。
        assert_eq!(
            next_stamp(&names(&[100, 200]), 100),
            201,
            "不能与最新一份撞名"
        );
        assert_eq!(next_stamp(&names(&[100, 200]), 200), 201, "同秒也要往后错");
        assert_eq!(
            next_stamp(&names(&[100, 200]), 900),
            900,
            "现在更晚就用现在"
        );
        assert_eq!(next_stamp(&[], 900), 900, "一份都没有时直接用现在");
        assert_eq!(
            next_stamp(&["readme.txt".to_string()], 900),
            900,
            "别人的文件不参与"
        );
        // 极端值不能溢出。
        assert_eq!(next_stamp(&names(&[u64::MAX]), 1), u64::MAX);
    }

    #[test]
    fn prune_plan_can_protect_the_backup_being_restored() {
        // 还原时先另存当前版本，备份数会变成 6 份；最旧的那份可能正好是用户刚选中的，
        // 它不能被清理掉（否则「刚选的备份消失了」），改为挤掉次旧的一份。
        let list = names(&[100, 200, 300, 400, 500, 600]);
        // 没有保护时最旧的一份会被删。
        assert_eq!(prune_plan(&list, BACKUP_KEEP), names(&[100]));
        let protected = prune_plan_protecting(&list, BACKUP_KEEP, &backup_file_name(100));
        assert_eq!(
            protected,
            names(&[200]),
            "被保护的那份不参与清理：{protected:?}"
        );
    }

    #[test]
    fn backup_message_mentions_path_keep_and_pruned() {
        let text = backup_message("web", "Windows", "C:/x/patch-1.yml", &[]);
        assert!(text.contains("web"), "{text}");
        assert!(text.contains("C:/x/patch-1.yml"), "{text}");
        assert!(text.contains('5'), "要说明保留份数：{text}");
        assert!(!text.contains("旧备份清理"), "没清理就不该提：{text}");

        let pruned = backup_message(
            "web",
            "WSL（Ubuntu）",
            "C:/x/patch-2.yml",
            &names(&[100, 200]),
        );
        assert!(pruned.contains("旧备份清理"), "{pruned}");
        assert!(pruned.contains(&backup_file_name(100)), "{pruned}");
        assert!(pruned.contains("WSL（Ubuntu）"), "{pruned}");
    }

    #[test]
    fn session_busy_names_the_action_and_the_profile() {
        let text = session_busy("重装依赖", "web");
        assert!(text.contains("重装依赖"), "{text}");
        assert!(text.contains("web"), "{text}");
        assert!(text.contains("先停止 DSH"), "{text}");
        // 文案不能把动作写死成「桥接插件」——同一个提示要能用于三种动作。
        assert!(!text.contains("桥接插件"), "{text}");
    }

    #[test]
    fn restore_message_points_at_the_saved_copy() {
        let text = restore_message("lab", "Windows", "C:/x/patch-1.yml", "C:/x/patch-2.yml");
        assert!(text.contains("lab"), "{text}");
        assert!(text.contains("C:/x/patch-1.yml"), "{text}");
        assert!(
            text.contains("C:/x/patch-2.yml"),
            "还原前另存的副本要说清楚：{text}"
        );
        assert!(text.contains("重启"), "要提醒重启才生效：{text}");
    }

    #[test]
    fn read_failed_carries_path_and_original_error() {
        let text = read_failed(
            "web",
            "C:/dsh/profiles/web/cordis.patch.yml",
            "系统找不到指定的文件",
        );
        assert!(text.contains("web"), "{text}");
        assert!(text.contains("cordis.patch.yml"), "{text}");
        assert!(text.contains("系统找不到指定的文件"), "{text}");
    }
}
