/* 浅/深主题：存储键、旧主题名兼容读取、应用到根元素 —— 自 main.ts 原样搬出（2026-10 模块化拆分），声明加 export，其余未改。 */

/* ==================== 浅色 / 深色 ====================
   只有两种外观，差别全在 src/style.css 里的 CSS 变量上：切换时只改
   <html data-mode>，不重建界面、不重载页面。 */

/** 外观模式。 */
export type ThemeId = "dark" | "light";

/** 外观记在 localStorage。index.html 的内联脚本复写了这个键名（静态脚本没法 import），
    改键名或模式名时两处同步。 */
export const THEME_KEY = "dsharbor.ui.theme";

/** 旧版本存的是经典主题名：换版本后沿用用户的明暗偏好，而不是回落到默认。 */
export const LEGACY_DARK_THEMES = new Set(["nativeDark", "native"]);

/** 已保存的外观；没存过、被改坏或存储被禁用时回落到深色。 */
export function readStoredTheme(): ThemeId {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") {
      return saved;
    }
    if (saved !== null && LEGACY_DARK_THEMES.has(saved)) {
      return "dark";
    }
  } catch {
    // 隐私模式等场景下读不到，按默认走。
  }
  return "dark";
}

/** 把外观贴到 <html>：src/style.css 里 html[data-mode="dark"|"light"] 两套变量据此生效。 */
export function applyMode(mode: ThemeId): void {
  document.documentElement.dataset.mode = mode;
}

