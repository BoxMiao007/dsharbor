/* 动作回执 Toast（#34）：右下角堆叠、最多 3 条、几秒后自己退场，也能手动关掉。
   只收「动作做完了 / 没做成」的回执；卡内本来就在显示的状态（加载中、字段校验、
   当前值）留在原处，不往这里搬——同一句话在界面上出现两次纯属噪音。

   动效走 --m-enter / --m-exit 令牌；关动效时 99-hidden.css 把时长压到 0，
   于是它瞬时出现（照样看得见）、瞬时退场，行为不变。 */

export type ToastKind = "ok" | "error" | "info";

/** 同时最多几条：第 4 条进来时把最旧的那条挤掉（工单给的效果 demo 就是这么做的）。 */
const MAX_STACK = 3;
/** 出现后多久自动消失。同一句文案重复触发时只刷新这条的计时，不叠新条。 */
const HOLD_MS = 3600;
/** 退场动画（--m-exit 130ms）放完再摘节点；关动效时也是这一档，最多多留 200ms。 */
const LEAVE_MS = 200;

/** 三种语气的图标：勾 / 感叹号 / i。颜色由 CSS 按 data-kind 给（色值只在 00-tokens.css）。 */
const ICONS: Record<ToastKind, string> = {
  ok: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.4 6.2 2.4 2.5 4.8-5" /></svg>',
  error:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2.4v4.4" /><circle cx="6" cy="9.2" r="0.8" fill="currentColor" stroke="none" /></svg>',
  info:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.4" /><path d="M6 5.5v3.1" /><circle cx="6" cy="3.5" r="0.7" fill="currentColor" stroke="none" /></svg>',
};

interface LiveToast {
  el: HTMLElement;
  message: string;
  timer: number;
}

/** 当前还在栈里的条。正在退场的那条先摘掉，所以这个长度就是「看得见的」条数。 */
const stack: LiveToast[] = [];

/**
 * 收一条动作回执。`message` 为空（后端偶尔回空串）就什么也不做：
 * 一条空白 toast 只会让人以为界面卡了一下。
 *
 * 同一句文案还在屏幕上时不再叠新条，只把它的计时重新起一遍——这类重复多半来自
 * 连点（「切换失败」点两次是同一句），堆两条纯属噪音。
 */
export function showToast(message: string, kind: ToastKind = "info"): void {
  const text = message.trim();
  const host = document.getElementById("toasts");
  if (!text || !host) {
    return;
  }
  const same = stack.find((item) => item.message === text);
  if (same) {
    // 挪到最下面再重新计时：看起来就是「刚发生的那一条」，后面真挤条时也不算最旧。
    host.appendChild(same.el);
    stack.splice(stack.indexOf(same), 1);
    stack.push(same);
    restart(same);
    return;
  }
  const el = buildToast(text, kind);
  host.appendChild(el);
  const entry: LiveToast = { el, message: text, timer: 0 };
  stack.push(entry);
  restart(entry);
  // 超出上限：把最旧的挤掉（先放退场动画，再从栈里摘）。
  while (stack.length > MAX_STACK) {
    const oldest = stack[0];
    if (!oldest) {
      break;
    }
    leave(oldest);
  }
}

/** 重新起这条的自动消失计时。 */
function restart(entry: LiveToast): void {
  window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => leave(entry), HOLD_MS);
}

/** 退场：先从栈里摘（条数立刻减一），挂上退场动画，动画放完再摘节点。 */
function leave(entry: LiveToast): void {
  window.clearTimeout(entry.timer);
  const index = stack.indexOf(entry);
  if (index >= 0) {
    stack.splice(index, 1);
  }
  entry.el.classList.add("is-leaving");
  window.setTimeout(() => entry.el.remove(), LEAVE_MS);
}

/** 一条 toast 的 DOM：图标 + 正文 + 关闭按钮（关闭按钮的可访问名固定为「关闭提示」）。 */
function buildToast(text: string, kind: ToastKind): HTMLElement {
  const el = document.createElement("div");
  el.className = "toast";
  el.dataset.kind = kind;
  // 图标是静态 SVG，正文一律用 textContent 写，后端回来的文字不参与拼 HTML。
  el.innerHTML = `<span class="toast-ico">${ICONS[kind]}</span><span class="toast-body"></span>`;
  const body = el.querySelector(".toast-body");
  if (body) {
    body.textContent = text;
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.title = "关闭提示";
  close.setAttribute("aria-label", "关闭提示");
  close.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 2.6l6.8 6.8M9.4 2.6 2.6 9.4" /></svg>';
  close.addEventListener("click", () => {
    const entry = stack.find((item) => item.el === el);
    if (entry) {
      leave(entry);
    } else {
      el.remove();
    }
  });
  el.appendChild(close);
  return el;
}
