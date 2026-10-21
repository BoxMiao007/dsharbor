/* HTML 拼装小工具：转义、逐字 span、启动按钮双文字动效、面板/卡片骨架 —— 自 main.ts 原样搬出（2026-10 模块化拆分），声明加 export，其余未改。 */

import type { PanelKey } from "./types";
import { TOGGLE_TEXT_REST, TOGGLE_TEXT_HOVER } from "./config";

/** 候选文案来自后端（发行版名），插进 innerHTML 前统一转义。 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

/** 逐字拆成 span；空格用 nbsp，否则在 inline-block 里会被折叠成 0 宽。 */
export function charsToSpans(text: string): string {
  return Array.from(text)
    .map((ch) => `<span>${ch === " " ? "&nbsp;" : ch}</span>`)
    .join("");
}

/**
 * 「启动 / 停止」按钮停止态的内部标记（两组文字做逐字切换，样式见 60-controls.css 的
 * #btn-toggle.swap）。buildHtml 的初始标记必须就用这一形态：-run 轮询 render 前
 * 若按钮先以普通按钮（红底大「启动 DSH」）渲染一帧，开着界面/切主题就会闪一下红。
 */
export function toggleSwapHtml(): string {
  // 逐字 span 会被读屏逐字念出来，故对读屏隐藏画面、用 aria-label 给整体名字。
  return (
    `<span class="text-window" aria-hidden="true">` +
    `<span class="span-mother">${charsToSpans(TOGGLE_TEXT_REST)}</span>` +
    `<span class="span-mother2">${charsToSpans(TOGGLE_TEXT_HOVER)}</span>` +
    `</span>`
  );
}

/** 面板外壳：`<section class="panel" data-panel="…">`，未选中时由 CSS 隐藏。 */
export function panelSection(key: PanelKey, body: string): string {
  return `<section class="panel" data-panel="${key}">
  <div class="panel-body">${body}</div>
</section>`;
}

/**
 * 小卡：主卡里每个条目各装一张小卡（卡中卡）。圆角比主卡收窄两圈，
 * 靠主卡的内边距与 gap 露出主卡底色——露缝，不画分隔线。
 */
export function cell(body: string): string {
  return `<section class="cell">${body}</section>`;
}

/**
 * 主卡：内容区里那张大卡片，里面按顺序摆若干小卡；条目撑高时由主卡自己滚。
 */
export function mainCard(items: string[], extra = ""): string {
  return `<section class="block main-card${extra ? ` ${extra}` : ""}">${items.join("")}</section>`;
}

/** 主卡里并排两张小卡（附加参数│端口、托盘设置│网络与代理）：卡与卡之间同样露缝。 */
export function cellRow(ratio: string, left: string, right: string): string {
  return `<div class="cell-row" data-ratio="${ratio}">${cell(left)}${cell(right)}</div>`;
}

/** 并排两列时的小标题：左列「托盘设置」、右列「网络与代理」，保证两列从同一行起。 */
export function colHead(title: string, extra = ""): string {
  return `<div class="col-head"><span class="col-title">${title}</span>${extra}</div>`;
}

/** 卡片里的一行状态徽章：放在小标题右侧，一眼看到当前状态（启动方式 / 桥接 / 缓存占用）。 */
export function badgeLine(key: string, text: string): string {
  return `<span id="${key}" class="badge badge-stopped panel-badge">${text}</span>`;
}

