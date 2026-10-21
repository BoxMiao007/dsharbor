/* HTML 拼装小工具：转义、面板/卡片骨架 —— 自 main.ts 模块化拆分搬出，声明加 export。 */

import type { PanelKey } from "./types";

/** 候选文案来自后端（发行版名），插进 innerHTML 前统一转义。 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
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

