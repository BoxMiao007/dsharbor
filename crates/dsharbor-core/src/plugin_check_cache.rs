//! 插件更新检查结果的落盘缓存（纯逻辑：形状、新鲜度、过期清理）。
//!
//! 为什么要有它：检查更新要对每个第三方插件各发一条 `npm view`（Windows 上实测
//! 约 1.5 秒一条，十几个插件并发 4 路也要好几秒），而启动时要自动查一遍给环境卡
//! 挂「可更新数」。只放内存的话，每次重启壳都要把这十几条网络查询重打一遍。把
//! 上次查到的目标版本连同时间戳落盘，启动时先用新鲜的那份，只有过期或查不到的
//! 才真发网络——「检查更新」按钮永远强制重查，所以不会挡住「刚就该看到新版本」。
//!
//! 这里不碰文件系统与 npm：读盘、写盘、发查询都在外壳 crate。

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 缓存有效期。
///
/// 30 分钟是取舍后的折中：关掉再开、开发时反复重启这类常见场景都落在窗口内，
/// 不会每次启动都重打一遍网络；隔了很久再开才会补查一次。用户主动点「检查更新」
/// 始终走强制重查，不受这个 TTL 影响。
pub const TTL: Duration = Duration::from_secs(30 * 60);

/// 一条查询结果。
///
/// 成功与失败分开存：断网、私有包 404 这类原因在重启后还要能原样显示，不能被
/// 说成「registry 上查不到这个包的任何版本」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckValue {
    /// 查询成功：目标版本（含预发布）。registry 上一个可用版本都没有时是 `None`。
    Target {
        #[serde(default)]
        version: Option<String>,
    },
    /// 查询失败：原因原样留给界面显示。
    Failed { error: String },
}

impl CheckValue {
    /// 失败时带上原因，成功时带目标版本（可能为空）。
    pub fn target(version: Option<String>) -> Self {
        Self::Target { version }
    }

    pub fn failed(error: String) -> Self {
        Self::Failed { error }
    }
}

/// 一条缓存记录：结果 + 查询时刻（Unix 秒）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedCheck {
    pub value: CheckValue,
    /// 查询时刻（Unix 秒）。时钟回拨时按「0 秒前」算——宁可用旧结果，也别因为
    /// 系统时间不对把整份缓存判成过期、启动再打一遍网络。
    pub fetched_at: u64,
}

/// 整份缓存文件。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckCache {
    #[serde(default)]
    pub entries: BTreeMap<String, CachedCheck>,
}

impl CheckCache {
    /// 读一份缓存文件内容；坏掉的 JSON 当成空缓存——缓存只负责加速，读不懂就重查，
    /// 不该让启动失败。
    pub fn parse(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or_default()
    }

    /// 序列化成写盘用的一行 JSON（元素顺序固定，便于肉眼比 diff）。
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| r#"{"entries":{}}"#.to_string())
    }

    /// 取一条仍然新鲜的记录；缺失或已过期返回 `None`（调用方据此决定要不要真发查询）。
    pub fn fresh(&self, key: &str, now: u64) -> Option<&CheckValue> {
        let entry = self.entries.get(key)?;
        is_fresh(entry.fetched_at, now).then_some(&entry.value)
    }

    /// 写入/覆盖一条记录，并顺手清掉过期条目，缓存文件不会越攒越大。
    pub fn put(&mut self, key: String, value: CheckValue, now: u64) {
        self.entries.insert(
            key,
            CachedCheck {
                value,
                fetched_at: now,
            },
        );
        self.prune(now);
    }

    /// 挪掉一条记录（更新成功、装完回查时用：旧目标版本不能再当新鲜结论）。
    pub fn remove(&mut self, key: &str) {
        self.entries.remove(key);
    }

    /// 清掉所有过期条目。
    pub fn prune(&mut self, now: u64) {
        self.entries
            .retain(|_, entry| is_fresh(entry.fetched_at, now));
    }
}

/// 一条记录是否还在有效期内。
///
/// `saturating_sub` 兜住「系统时钟回拨」：`fetched_at` 在未来时差值是 0 秒，
/// 算新鲜——缓存早过期一点无害，误判过期会让每次启动都重打一遍网络。
fn is_fresh(fetched_at: u64, now: u64) -> bool {
    now.saturating_sub(fetched_at) < TTL.as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache(entries: &[(&str, CheckValue, u64)]) -> CheckCache {
        let mut cache = CheckCache::default();
        for (key, value, fetched_at) in entries {
            cache.entries.insert(
                (*key).to_string(),
                CachedCheck {
                    value: value.clone(),
                    fetched_at: *fetched_at,
                },
            );
        }
        cache
    }

    #[test]
    fn fresh_returns_entries_inside_the_ttl_only() {
        let now = 1_000_000u64;
        let entries = cache(&[
            (
                "fresh",
                CheckValue::target(Some("1.2.3".to_string())),
                now - TTL.as_secs() + 1,
            ),
            (
                "expired",
                CheckValue::target(Some("1.2.3".to_string())),
                now - TTL.as_secs(),
            ),
        ]);
        assert_eq!(
            entries.fresh("fresh", now),
            Some(&CheckValue::target(Some("1.2.3".to_string())))
        );
        assert_eq!(entries.fresh("expired", now), None);
        assert_eq!(entries.fresh("missing", now), None, "没查过的键要重查");
    }

    #[test]
    fn clock_rollback_still_counts_as_fresh() {
        // fetched_at 在未来（用户把系统时间往回改了）：别判过期，否则每次启动都重查。
        let now = 1_000u64;
        let entries = cache(&[(
            "future",
            CheckValue::target(Some("2.0.0".to_string())),
            now + 10_000,
        )]);
        assert_eq!(
            entries.fresh("future", now),
            Some(&CheckValue::target(Some("2.0.0".to_string())))
        );
    }

    #[test]
    fn put_prunes_expired_entries_and_keeps_the_rest() {
        let now = 1_000_000u64;
        let mut entries = cache(&[
            (
                "old",
                CheckValue::target(Some("1.0.0".to_string())),
                now - TTL.as_secs() - 1,
            ),
            ("kept", CheckValue::failed("E404".to_string()), now - 10),
        ]);
        entries.put(
            "new".to_string(),
            CheckValue::target(Some("2.0.0".to_string())),
            now,
        );
        assert!(entries.entries.contains_key("new"));
        assert!(entries.entries.contains_key("kept"));
        assert!(!entries.entries.contains_key("old"), "过期条目要顺手清掉");
    }

    #[test]
    fn remove_drops_one_entry_only() {
        let now = 1_000_000u64;
        let mut entries = cache(&[
            ("a", CheckValue::target(Some("1.0.0".to_string())), now),
            ("b", CheckValue::failed("E404".to_string()), now),
        ]);
        entries.remove("a");
        assert!(!entries.entries.contains_key("a"));
        assert!(entries.entries.contains_key("b"));
    }

    #[test]
    fn json_round_trips_both_value_shapes() {
        let now = 1_000u64;
        let entries = cache(&[
            (
                "ok",
                CheckValue::target(Some("2.0.0-rc.1".to_string())),
                now,
            ),
            ("empty", CheckValue::target(None), now),
            ("bad", CheckValue::failed("断网".to_string()), now),
        ]);
        let back = CheckCache::parse(&entries.to_json());
        assert_eq!(back, entries);
    }

    #[test]
    fn broken_files_read_as_an_empty_cache() {
        for text in ["", "{", "null", "[]", r#"{"entries":{"x":{}}}"#] {
            let cache = CheckCache::parse(text);
            assert!(
                cache.entries.is_empty(),
                "坏内容应读成空缓存，实际不是：{text}"
            );
        }
    }
}
