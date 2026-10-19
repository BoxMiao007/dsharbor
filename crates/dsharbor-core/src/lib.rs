//! DSHarbor 核心库：与界面、系统 API 解耦的纯逻辑都放在这里。
//!
//! 设计约束（为什么单独成 crate）：
//! - 外壳要跑在 Windows 上，但开发在 WSL2；把可验证的逻辑提取到这里，
//!   就能在开发机上用 `cargo test` 全自动验证，不依赖 Windows 环境。
//! - 后续的启动命令构造、参数校验、窗口状态机都进这个库。

pub mod bridge;
pub mod console;
pub mod endpoint;
pub mod launch;
pub mod lifecycle;
pub mod links;
pub mod logparse;
pub mod overlay;
pub mod paths;
pub mod prefs;
pub mod registry;

/// 对外展示的应用名（窗口标题、安装包、界面文案共用一个来源）。
pub const APP_NAME: &str = "DSHarbor";

/// 核心库版本，跟随工作区版本号。
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// FNV-1a 64 位哈希的十六进制形式。
/// 用途：备份清单里标注文件内容指纹（只需可比对、不用于安全场景）。
pub fn fnv1a64_hex(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_app_name_and_version() {
        assert_eq!(APP_NAME, "DSHarbor");
        assert!(!version().is_empty());
    }

    #[test]
    fn fnv1a64_matches_reference_values() {
        // 参考值：FNV-1a 64 位的标准测试向量。
        assert_eq!(fnv1a64_hex(b""), "cbf29ce484222325");
        assert_eq!(fnv1a64_hex(b"a"), "af63dc4c8601ec8c");
        assert_eq!(fnv1a64_hex(b"foobar"), "85944171f73967e8");
    }
}
