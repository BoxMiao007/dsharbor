//! 下载源到 npm registry 的映射。
//!
//! 为什么放在核心库：这里只有「哪个选项对应哪个地址」这一张表，是纯字符串逻辑，
//! 放核心库能在开发机上全自动测；真正把算出来的键值对塞进子进程环境变量是外壳的事
//! （`src-tauri/src/registry.rs` 的版本查询、`src-tauri/src/launcher.rs` 的启动）。
//!
//! 枚举复用 `crate::prefs::DownloadSource`：界面下拉、落盘、宽容读取已经在用那一份，
//! 另开一个同形的枚举只会多一处需要对齐的字面量。

use crate::prefs::DownloadSource;

/// npm 官方源。
pub const OFFICIAL_REGISTRY: &str = "https://registry.npmjs.org";

/// 国内镜像源。
pub const MIRROR_REGISTRY: &str = "https://registry.npmmirror.com";

/// 下发 registry 用的环境变量名。
///
/// npm 读环境变量时逐字认这个字面量（大小写敏感的 Unix 侧也一样），所以外壳在两条路径上
/// 都原样注入：主机是 `Command::env`，WSL 是 `env K=V` 的单个 argv。值是不带空格的 URL，
/// 这一写法不需要额外转义。
pub const REGISTRY_ENV: &str = "npm_config_registry";

/// 该下载源对应的 registry 地址；`None` 表示不下发任何 registry 值（沿用 npm 全局配置）。
pub fn registry_of(source: DownloadSource) -> Option<&'static str> {
    match source {
        DownloadSource::Inherit => None,
        DownloadSource::Mirror => Some(MIRROR_REGISTRY),
        DownloadSource::Official => Some(OFFICIAL_REGISTRY),
    }
}

/// 该下载源要注入子进程的环境变量；「沿用 npm 全局配置」时返回空 vec。
///
/// 空 vec 的语义就是「没有这项功能」：调用点拿到空 vec 不做任何注入，
/// 子进程读到的仍是用户自己 `.npmrc` 里的源。
pub fn registry_env(source: DownloadSource) -> Vec<(String, String)> {
    match registry_of(source) {
        Some(url) => vec![(REGISTRY_ENV.to_string(), url.to_string())],
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherit_sends_no_registry_at_all() {
        // 验收标准：选「沿用」时不下发 registry，行为等同于没有这项功能。
        assert_eq!(registry_of(DownloadSource::Inherit), None);
        assert!(registry_env(DownloadSource::Inherit).is_empty());
    }

    #[test]
    fn mirror_and_official_point_at_their_own_registries() {
        assert_eq!(
            registry_of(DownloadSource::Mirror),
            Some("https://registry.npmmirror.com")
        );
        assert_eq!(
            registry_of(DownloadSource::Official),
            Some("https://registry.npmjs.org")
        );
    }

    #[test]
    fn env_carries_one_key_with_the_source_url() {
        // 键名是界面与外壳之间的契约（npm 认这个名字），写死在这里防漂移。
        assert_eq!(
            registry_env(DownloadSource::Mirror),
            vec![(
                "npm_config_registry".to_string(),
                MIRROR_REGISTRY.to_string()
            )]
        );
        assert_eq!(
            registry_env(DownloadSource::Official),
            vec![(
                "npm_config_registry".to_string(),
                OFFICIAL_REGISTRY.to_string()
            )]
        );
        assert_eq!(REGISTRY_ENV, "npm_config_registry");
    }

    #[test]
    fn addresses_are_plain_https_urls_without_spaces() {
        // WSL 分支把键值拼成 `env K=V` 的单个 argv：值里不能有空格，否则 wsl.exe 会把
        // 它拆成两段。地址是写死的常量，这里把约束钉在测试里。
        for url in [MIRROR_REGISTRY, OFFICIAL_REGISTRY] {
            assert!(url.starts_with("https://"), "{url}");
            assert!(!url.contains(char::is_whitespace), "{url}");
            assert!(!url.ends_with('/'), "{url} 不该带尾斜杠");
        }
    }
}
