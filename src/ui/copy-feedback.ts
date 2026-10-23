/* 复制类按钮的统一反馈（#35）：图标「复制 → 勾」、文案上下滑换「已复制」、边框短暂转成功色，
   约 1.4s 后复原；复制失败时在按钮内换成「复制失败」的红态（全局提示归 #34，这里不重复）。
   日志「复制日志」、命令行「手动命令」「垫片内容」、登录链接四处共用这一套。

   文案层的三行（原文案 / 已复制 / 复制失败）叠在同一个网格格里：
   网格轨道的宽度取三者里最宽的一行，所以无论切到哪个状态，按钮宽度与周围元素都不动。
   失败文案比「已复制」宽，若只按「复制 / 已复制」定宽，失败那一下仍会跳一下，故一并计入。 */

import { ICON_COPY_MORPH, ICON_CHECK } from "./icons";
import { escapeHtml } from "./markup";

/** 反馈停留时长：设计稿 03-feedback.html 第 4 组定 1.4s。 */
export const COPY_FEEDBACK_MS = 1400;

/** 视觉隐藏的全局播报区：#app 挂载完成后按需创建，所有复制按钮共用一处。
 *  不把 aria-live 加在按钮本身——那会把整颗按钮（图标 + 三段文案）重读一遍。 */
let statusEl: HTMLElement | null = null;

function ensureStatus(): HTMLElement {
  if (statusEl && statusEl.isConnected) return statusEl;
  const el = document.createElement("span");
  el.id = "copy-status";
  el.className = "sr-only";
  el.setAttribute("role", "status");
  // 只播报本次结果，不与上一次内容拼读。
  el.setAttribute("aria-atomic", "true");
  document.body.appendChild(el);
  statusEl = el;
  return el;
}

/** 按钮内的图标叠层：复制形与勾同尺寸叠放，靠 .copied 切可见性，不换 DOM。 */
export function copyIconStack(): string {
  return `<span class="copy-ico" aria-hidden="true">${ICON_COPY_MORPH}${ICON_CHECK}</span>`;
}

/** 按钮内的文案叠层：三行同格叠放（定宽原理见文件头）。
 *  `idle` 是常态文案，由调用方给（「复制」「复制日志」「复制登录链接」…）。 */
export function copyTextChrome(idle: string): string {
  return (
    `<span class="copy-txt" aria-hidden="true">` +
    `<span class="t-cur">${escapeHtml(idle)}</span>` +
    `<span class="t-next">已复制</span>` +
    `<span class="t-fail">复制失败</span>` +
    `</span>`
  );
}

/**
 * 给一颗复制按钮装上反馈结构：图标叠层 + 文案叠层，并把可访问名固定成常态文案
 * （按钮内容里的文字带 aria-hidden，避免读屏把三段叠放的文案连起来念）。
 * 重复调用无副作用。
 */
export function prepareCopyButton(button: HTMLButtonElement, idle: string): void {
  if (button.dataset.copyReady === "1") return;
  button.dataset.copyReady = "1";
  button.classList.add("copy-btn");
  button.setAttribute("aria-label", idle);
  button.innerHTML = copyIconStack() + copyTextChrome(idle);
  ensureStatus();
}

/** 每颗按钮的收尾定时器：连点时先清旧的，避免几段倒计时叠着跑。 */
const holdTimers = new WeakMap<HTMLElement, number>();

/** 推进到「已复制 / 复制失败」态并播报；约 1.4s 后自动复原。
 *  登录链接按钮也走这里（它由 paintOpenMode 单独装态，见 main.ts）。 */
export function flashCopy(button: HTMLElement, ok: boolean): void {
  button.classList.toggle("copied", ok);
  button.classList.toggle("copy-failed", !ok);

  const live = ensureStatus();
  // 先清空再写：同一个「已复制」连续点击两次，读屏才会重新播报。
  live.textContent = "";
  live.textContent = ok ? "已复制" : "复制失败";

  const prev = holdTimers.get(button);
  if (prev !== undefined) window.clearTimeout(prev);
  holdTimers.set(
    button,
    window.setTimeout(() => {
      holdTimers.delete(button);
      button.classList.remove("copied", "copy-failed");
      // 复原即清掉播报，免得焦点移回时又念一次旧结果。
      live.textContent = "";
    }, COPY_FEEDBACK_MS),
  );
}
