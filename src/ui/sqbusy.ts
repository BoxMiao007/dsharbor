/* 方钮（.square-btn）忙态：忙时换成居中的环形 spinner，成功后在原位落一个勾停 0.9s 再还原
   （#29）。三处调用点共用这一套：版本列表刷新、检查更新、全部更新。

   为什么不再转语义图标：那些图标的图形（箭头 + 底线之类）不是旋转对称的、墨迹中心也不在
   盒子中心，绕中心转会画圈晃。所以忙时不碰图标，只把「环形」这一帧单独叠上去转。

   与动效偏好（#27）协作：关动效时环形由 99-hidden.css 点名停掉，不转但仍静态可见，
   配合 aria-busy 仍是「在忙」的静态线索，不会出现看不出在忙的空窗。 */

/** 勾停留时长（演示稿 01-buttons.html 第 4 组：转完 → 勾 0.9s → 复原）。 */
export const SQ_DONE_HOLD_MS = 900;

/** 每枚按钮的收尾定时器：重复触发时先清旧的，免得几个勾叠着倒计时。 */
const doneTimers = new WeakMap<HTMLButtonElement, number>();

/**
 * 声明式反映忙态（渲染函数可每帧调用，幂等）：忙时挂 .is-spinning + aria-busy="true"，
 * 不忙时摘掉。只碰忙碌标记，不碰完成勾（.is-done）——勾由 flashSquareDone 单独控。
 * 若在勾停留期间重新进入忙态，先把勾与它的定时器收掉，避免两种状态叠在一起。
 */
export function setSquareBusy(btn: HTMLButtonElement, busy: boolean): void {
  btn.classList.toggle("is-spinning", busy);
  if (busy) {
    const timer = doneTimers.get(btn);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      doneTimers.delete(btn);
    }
    btn.classList.remove("is-done");
    btn.setAttribute("aria-busy", "true");
  } else {
    btn.removeAttribute("aria-busy");
  }
}

/**
 * 成功收尾：摘掉忙态，落一个勾停 SQ_DONE_HOLD_MS，到点自动撤掉、交回原图标。
 * 失败路径不要调这个——失败直接还原原图标，不做错误态图标。
 */
export function flashSquareDone(btn: HTMLButtonElement): void {
  btn.classList.remove("is-spinning");
  btn.removeAttribute("aria-busy");
  window.clearTimeout(doneTimers.get(btn));
  btn.classList.add("is-done");
  const timer = window.setTimeout(() => {
    doneTimers.delete(btn);
    btn.classList.remove("is-done");
  }, SQ_DONE_HOLD_MS);
  doneTimers.set(btn, timer);
}
