//! 「启动后自动清理 npx 缓存」的两条纯规则：什么时候该跑、跑完了怎么说给用户听。
//!
//! 为什么单独成一个模块：真正删目录的是外壳（`src-tauri/src/npxcache.rs` 的 `cleanup`），
//! 但「该不该删」是能被单元测试钉住的判断——它同时受两个开关约束（用户开关 + 这次启动
//! 到底有没有真拉起进程），写成纯函数就不用为了验证这两条去动真缓存目录。
//!
//! 清理算法本身不在这里：保留哪几份、删哪几份、释放多少，全在 `crate::npx_cache` 里，
//! 与「立即清理」按钮走的完全是同一套判定，自动清理只是换了个触发时机。

use crate::npx_cache;

/// 启动成功后是否该跑一次自动清理。
///
/// 两个条件缺一不可：
/// - `cache_cleanup`：用户在「集成」卡里把开关打开了。默认是关的，这是有意的——自动删
///   东西的风险高于省下的那点磁盘，先让用户看清楚可回收多少，再自己决定要不要开。
/// - `spawned_child`：这一次启动**真的拉起了一个 DSH 进程**。壳外已经有 DSH 在跑时
///   启动命令也返回成功，但那次启动什么也没起，不该顺手删缓存：那不是用户刚点出来的
///   一次启动，也没有「刚用过这份缓存」的说法。启动失败同理（失败时根本没有这次调用）。
pub fn should_run(cache_cleanup: bool, spawned_child: bool) -> bool {
    cache_cleanup && spawned_child
}

/// 自动清理结果的一句话说明。
///
/// 在「立即清理」的既有文案前加一句「启动后自动清理」，让用户知道这次删东西不是自己点的：
/// 打开卡时突然少了几个目录，不说清来源就成了「谁动了我的缓存」。
pub fn auto_message(removed: usize, freed_bytes: u64, failed: usize) -> String {
    format!(
        "启动后自动清理：{}",
        npx_cache::cleanup_message(removed, freed_bytes, failed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_only_when_the_switch_is_on_and_a_process_was_really_started() {
        // 默认关：关着就算真拉起了进程也不删。
        assert!(!should_run(false, true));
        // 这次启动没拉起进程（壳外已有 DSH / 启动失败）：开着也不删。
        assert!(!should_run(true, false));
        // 两个条件都满足才跑。
        assert!(should_run(true, true));
        assert!(!should_run(false, false));
    }

    #[test]
    fn auto_message_says_it_was_automatic() {
        let text = auto_message(2, 3072, 0);
        assert!(text.starts_with("启动后自动清理："), "{text}");
        // 后半段与「立即清理」完全同一套文案，两种触发时机说法一致。
        assert!(text.contains("已清掉 2 个目录，释放 3.0 KB"), "{text}");
    }

    #[test]
    fn auto_message_covers_nothing_to_do_and_failures() {
        let empty = auto_message(0, 0, 0);
        assert!(empty.starts_with("启动后自动清理："), "{empty}");
        assert!(empty.contains("没有需要清理的目录"), "{empty}");

        let failed = auto_message(0, 0, 1);
        assert!(failed.contains("一个目录都没能清掉"), "{failed}");

        let partial = auto_message(1, 1024, 1);
        assert!(partial.contains("已清掉 1 个目录"), "{partial}");
        assert!(partial.contains("1 个没清掉"), "{partial}");
    }
}
