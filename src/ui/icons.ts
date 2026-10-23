/* 全部内联 SVG 图标、左栏分区表 PANELS、未读徽章 HTML —— 自 main.ts 原样搬出（2026-10 模块化拆分），声明加 export，其余未改。 */

import iconDs from "../assets/dsh-mark.svg";
import type { PanelKey } from "./types";

/** 左侧导航的分区图标：统一 24 单位视框、描边 1.55，与左栏底部的浅/深图标同源。 */
export const ICON_LAUNCH = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 16.5 3 21l4.5-1.5" /><path d="M14 4c3.5-1 6 1.5 5 5-1.2 4.2-5.6 7.6-8.4 9.1L8 15.4C9.5 12.6 11.3 5.2 14 4Z" /><circle cx="14.6" cy="9.4" r="1.6" /></svg>`;
export const ICON_ENV = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" /><path d="m4 7.5 8 4.5 8-4.5" /><path d="M12 12v9" /></svg>`;
export const ICON_INTEG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" rx="2.5" /><path d="m6.5 10 2.5 2.5L6.5 15" /><path d="M12 15.5h5" /></svg>`;
export const ICON_TRAYNET = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="10" r="6.5" /><path d="M5.5 10h13" /><path d="M12 3.5a10.5 10.5 0 0 1 2.6 6.5 10.5 10.5 0 0 1-2.6 6.5 10.5 10.5 0 0 1-2.6-6.5A10.5 10.5 0 0 1 12 3.5z" /><path d="M4 19.5h4l1.2 2h5.6l1.2-2h4" /></svg>`;
export const ICON_ABOUT = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><circle cx="12" cy="7.9" r="0.9" fill="currentColor" stroke="none" /></svg>`;
/** 日志分区：方块里几行字——与「集成」的终端框区分开（那边有 > 与下划线）。 */
export const ICON_LOG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M6.6 9.4h10.8" /><path d="M6.6 12.4h10.8" /><path d="M6.6 15.4h6" /></svg>`;

/** 浅/深切换的两颗图标：显示的是「点下去会变成什么」，不是当前状态。
    两颗同时常驻切换按钮（见 .theme-morph），由 html[data-mode] 决定谁在场、谁退场
    ——可见性与对转全靠 CSS 的 opacity/transform，不在 JS 里换图标，所以过渡能完整
    跑完、连点也不会卡中间。类名 ico-sun / ico-moon 是 CSS 与测试的接缝。 */
export const ICON_SUN = `<svg class="ico-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" /></svg>`;
export const ICON_MOON = `<svg class="ico-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></svg>`;

/** 左侧导航的分区：导航按钮与面板标题都按这份表生成，顺序即显示顺序。 */
export const PANELS: ReadonlyArray<{ key: PanelKey; label: string; icon: string }> = [
  { key: "launch", label: "启动方式", icon: ICON_LAUNCH },
  { key: "env", label: "环境/插件", icon: ICON_ENV },
  { key: "integ", label: "集成", icon: ICON_INTEG },
  { key: "traynet", label: "托盘与网络", icon: ICON_TRAYNET },
  { key: "log", label: "日志", icon: ICON_LOG },
  { key: "about", label: "关于", icon: ICON_ABOUT },
];

/**
 * 左栏「日志」条目上的未读数字。
 *
 * 只有「日志」这一项带它：别的分区没有持续冒出来的新内容。默认空着——空内容由 CSS 的
 * `:empty` 收成不渲染，不需要额外的隐藏类；数字总是走 `textContent` 写入，不做 HTML 拼接。
 */
export const UNREAD_BADGE_HTML = `<span id="log-unread" class="ico-count"></span>`;

/** 三只窗口按钮的图标：10px 见方的细线 SVG，形状统一收在 9px 见方内、
    描边 1.2px（见 .win-btn svg），描边色跟 currentColor——改用矢量后
    不再依赖字体里的 – □ ✕ 字形（那三个字形粗细大小都不一致）。
    最大化与还原是两个图标，按窗口状态切换。 */
export const ICON_MINIMIZE = `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 5h9" /></svg>`;
export const ICON_MAXIMIZE = `<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0.6" y="0.6" width="8.8" height="8.8" rx="1.4" /></svg>`;
export const ICON_RESTORE = `<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0.6" y="2.6" width="6.8" height="6.8" rx="1.3" /><path d="M3 2.6V1.6h5.4a1 1 0 0 1 1 1v5.4H8.4" /></svg>`;
export const ICON_CLOSE = `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 9 9M9 1 1 9" /></svg>`;

/** 会话按钮的图标：默认描边风格跟随系统线条（描边参数在 style.css 的 .btn-ico 统一给）；
 *  例外：停止图标是实心方块（维护者要求），填充与几何尺寸见 ICON_STOP 自己的注释。 */
/* 方块几何尺寸比另外三颗的描边图标大一圈（11→16）：描边图标外沿约 19.8/24 单位，
   实心方块若同为 11 视觉只有约 12.8 单位（11 + 1.8 描边外扩），维护者要求大到与其它三颗一致。

   矩形本身只占 13.6 单位（4→5.2、16→13.6）：悬停闪动闪到空心那半拍时只剩描边，
   描边默认向内外各外扩一半（2.4/2 = 1.2），13.6 + 2.4 正好还是 16——
   实心与空心两拍外沿一样大，闪动时方块不涨缩。（描边参数在 60-controls.css） */
export const ICON_STOP = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5.2" y="5.2" width="13.6" height="13.6" rx="2" /></svg>`;
export const ICON_RESTART = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" /><path d="M21 3v5h-5" /></svg>`;
export const ICON_OPEN_APP = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15" rx="2" /><path d="M2.5 9h19" /><path d="M6.5 4.5V9" /><path d="M10.5 4.5V9" /></svg>`;
export const ICON_OPEN_BROWSER = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M2.5 12h19" /><path d="M12 2.5a14.7 14.7 0 0 1 3.8 9.5 14.7 14.7 0 0 1-3.8 9.5 14.7 14.7 0 0 1-3.8-9.5A14.7 14.7 0 0 1 12 2.5z" /></svg>`;
/** 左栏底部的「GitHub 仓库」入口与打开方式里的「复制登录链接」共用这颗代码括号图标。 */
export const ICON_CODE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 7.5-5 4.5 5 4.5" /><path d="m15.5 7.5 5 4.5-5 4.5" /><path d="M13.5 4.5 10.5 19.5" /></svg>`;
/** 左栏底部的「DSH 官网」入口：DeepSeek 官方 mark（单条 path，品牌蓝）。 */
export const ICON_DSH_SITE = `<img src="${iconDs}" alt="" draggable="false" />`;
/**
 * 左栏底部的「GitHub 仓库」入口：GitHub 官方 mark。
 *
 * 内联而不是引 .svg 文件：`<img>` 里的 `currentColor` 拿不到页面颜色，深色外观下会画成
 * 黑色、几乎看不见。内联 path 才能跟着按钮文字色走。
 */
export const ICON_GITHUB = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" stroke="none" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>`;
/** 环境大按钮后面的横向三点：展开重命名 / 复制 / 删除 / 安装依赖 / 打开目录。
    横排而非竖排：竖排三点在窄卡片右上角会被读成「拖拽把手」。
    实心（fill 由 80-env-cards.css 给 currentColor）：空心环在 15px 下只剩一圈细线，
    与旁边实心的加号、开关圆头不像同一套图标。 */
export const ICON_MORE = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>`;

/** 版本列表右侧方钮：一圈带箭头的回转，配「重新获取官方版本列表」气泡。 */
export const ICON_REFRESH = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" /><path d="M20.5 4.4V10H15" /></svg>`;

/** 插件工具条「全部更新」：升起的箭头 + 底线（升级、批量到位），与「检查更新」的回转刷新区分开。 */
export const ICON_UPDATE_ALL = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18.5v-13" /><path d="m6.5 11 5.5-5.5L17.5 11" /><path d="M5.5 21h13" /></svg>`;

/** 「指定程序路径」方钮里的文件夹：点开系统「打开文件」框。 */
export const ICON_FOLDER = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.2 7a2 2 0 0 1 2-2h3.4l1.9 2.4H18.8a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5.2a2 2 0 0 1-2-2Z" /></svg>`;

/** 端口「还原」方钮：向左回转的箭头（与版本列表的刷新图标区分开，两颗不重样）。 */
export const ICON_REVERT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.6 9.2h11.6a4.6 4.6 0 0 1 0 9.2H9" /><path d="m8.6 4.6-4.4 4.6 4.4 4.6" /></svg>`;
/** 浮窗右上角的关闭叉（比三颗窗口按钮的 ICON_CLOSE 大一圈，用 24 视框）。 */
export const ICON_MODAL_CLOSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></svg>`;
/** 打开方式两段式按钮右侧那颗小三角。 */
export const ICON_CHEVRON_DOWN = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9.5 6 6 6-6" /></svg>`;
const COPY_BODY = `<rect x="9" y="9" width="11" height="11" rx="2.2" /><path d="M15 6.5A2.5 2.5 0 0 0 12.5 4H6.5A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15" />`;
export const ICON_COPY = `<svg viewBox="0 0 24 24" aria-hidden="true">${COPY_BODY}</svg>`;

/** 复制按钮里与勾叠放的「复制」形（#35）：带 .i-copy 类，供复制反馈切换可见性。
 *  与 ICON_COPY 同一条路径，只多一个类名——按钮态与菜单图标不会画成两种复制形。 */
export const ICON_COPY_MORPH = `<svg class="i-copy" viewBox="0 0 24 24" aria-hidden="true">${COPY_BODY}</svg>`;

/** 完成勾（#35）：方钮的 0.9s 完成态与复制按钮的成功态共用这一枚，别再画第二个勾。
 *  与 ICON_COPY 同视框、同描边参数，两枚叠放切换时视觉重心不跳。 */
export const ICON_CHECK = `<svg class="i-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7" /></svg>`;
