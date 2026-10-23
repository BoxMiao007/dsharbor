/* 动效偏好：存储键、读取与应用 —— 全站唯一的「动效开关」出口。
   关闭时给 <html> 写 data-motion="off"，src/styles/99-hidden.css 里的
   html[data-motion="off"] 规则据此把动画/过渡整体中和；开启时不写这个属性，
   界面保持默认动效。 */

/** 动效偏好。 */
export type MotionPref = "on" | "off";

/** 动效记在 localStorage。index.html 的内联脚本复写了这个键名与取值（静态脚本没法
    import），改键名或取值时两处同步。 */
export const MOTION_KEY = "dsharbor.ui.motion";

/** 已保存的动效偏好；没存过、被改坏或存储被禁用时回落到开。 */
export function readStoredMotion(): MotionPref {
  try {
    const saved = window.localStorage.getItem(MOTION_KEY);
    if (saved === "on" || saved === "off") {
      return saved;
    }
  } catch {
    // 隐私模式等场景下读不到，按默认走。
  }
  return "on";
}

/** 写入动效偏好；写不进去（隐私模式、配额满）就算了，本次会话仍按当前值生效。 */
export function saveStoredMotion(pref: MotionPref): void {
  try {
    window.localStorage.setItem(MOTION_KEY, pref);
  } catch {
    // 存不了不影响本次会话的界面表现。
  }
}

/** 把动效偏好贴到 <html>。关闭时才写 data-motion="off"，开启时移除属性
   （而不是写 "on"），这样默认路径下 <html> 上不会留下无意义的属性。 */
export function applyMotion(pref: MotionPref): void {
  const root = document.documentElement;
  if (pref === "off") {
    root.dataset.motion = "off";
  } else {
    delete root.dataset.motion;
  }
}
