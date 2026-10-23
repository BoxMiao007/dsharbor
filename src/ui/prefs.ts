/* 持久化偏好（五字段）默认值与读取归一化 —— 自 main.ts 原样搬出（2026-10 模块化拆分），声明加 export，其余未改。 */

import type { DownloadSource, ProxyMode, ShellPrefs } from "./types";

/** 这些字段的默认值：与 Rust 侧 `ShellPrefs::default()` 保持一致。 */
export const DEFAULT_PREFS: ShellPrefs = {
  profile: "web",
  downloadSource: "inherit",
  proxyMode: "system",
  proxyAddress: "",
  cliIntegration: false,
};

/** 后端返回的偏好可能缺字段或带未知枚举值（旧配置、手改坏了）：逐字段兜底，
    不让一个坏值毁掉整份配置。与 Rust 侧宽容读取的语义一致。 */
export function normalizePrefs(raw: Partial<ShellPrefs> | undefined | null): ShellPrefs {
  const prefs = raw ?? {};
  const source = String(prefs.downloadSource);
  const proxy = String(prefs.proxyMode);
  return {
    profile: typeof prefs.profile === "string" && prefs.profile.trim() ? prefs.profile : DEFAULT_PREFS.profile,
    downloadSource:
      source === "mirror" || source === "official" ? (source as DownloadSource) : DEFAULT_PREFS.downloadSource,
    proxyMode: proxy === "manual" || proxy === "off" ? (proxy as ProxyMode) : DEFAULT_PREFS.proxyMode,
    proxyAddress: typeof prefs.proxyAddress === "string" ? prefs.proxyAddress : DEFAULT_PREFS.proxyAddress,
    cliIntegration: prefs.cliIntegration === true,
  };
}
