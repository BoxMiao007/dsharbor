/* 「重启 DSH」点击后的图标持续转动状态机（含状态刷新钩子注入） —— 自 main.ts 原样搬出（2026-10 模块化拆分），声明加 export，其余未改。 */

import type { SessionStatus } from "./types";

/**
 * 「重启 DSH」点击后的持续转动（2026-10-17 维护者规格）：点击瞬间就锁在悬停终态（文字推出、
 * 图标板铺满）并按徽章「启动中」的节拍（--spin-ms）无限转，鼠标移开也不归位。
 * 收场信号：徽章离开「启动中」（运行中就绪 / 启动失败）→ 正常收工；点「停止」主动打断 → 立即停；
 * 30 秒上限 → 兜底停（登录链接一直不就绪时别转下去）。
 * 最短转满 700ms：重启快到轮询都没看见「启动中」时也至少给出一圈反馈。
 * 状态放模块级：界面元素可能被重建，转动要跨重建继续，计时不重来。
 */
// 与 src/style.css 的 --spin-ms（700ms）同值不同责：那边是一圈转动的时长，这里是收场前给足的最短反馈；
// 改转速时两处一起检查。
export const RESTART_SPIN_MIN_MS = 700;
export const RESTART_SPIN_MAX_MS = 30_000;
/** 「已停止」会出现在重启「先停旧、再起新」的缝隙里，这个时长内不收场，免得转动一闪而过。 */
export const RESTART_SPIN_STOP_GRACE_MS = 3_000;

let restartSpin: { startedAt: number; sawStarting: boolean } | null = null;
/** 最短时长补收定时器（条件提前满足时到点收场）。 */
let restartSpinTimer: number | undefined;
/** 30 秒上限的独立兜底定时器：不搭轮询便车——dsh_status 一直报错时也得停转。 */
let restartSpinCapTimer: number | undefined;

/** 由 mount 注入「重新查询一次状态」，供上面最短时长的定时器到点补一拍（render 每秒也会跑）。 */
let requestStatusRefresh: () => Promise<void> = async () => {};

/* main() 启动后注入真实的状态刷新入口（原来是 main.ts 模块级 let、由 main 赋值）。 */
export function setStatusRefresher(fn: () => Promise<void>): void {
  requestStatusRefresh = fn;
}

/** 把转动状态贴到界面上那颗「重启 DSH」上（切主题后元素会换，所以每次现查）。 */
export function applyRestartSpin(): void {
  document.querySelector<HTMLButtonElement>("#btn-restart")?.classList.toggle("is-restarting", restartSpin !== null);
}

export function beginRestartSpin(): void {
  window.clearTimeout(restartSpinTimer);
  window.clearTimeout(restartSpinCapTimer);
  restartSpinTimer = undefined;
  restartSpinCapTimer = undefined;
  restartSpin = { startedAt: Date.now(), sawStarting: false };
  applyRestartSpin();
  // 30 秒必停：只要点过重启就有这条兜底，不依赖后续任何轮询成功。
  restartSpinCapTimer = window.setTimeout(() => {
    restartSpinCapTimer = undefined;
    endRestartSpin();
    void requestStatusRefresh();
  }, RESTART_SPIN_MAX_MS);
}

export function endRestartSpin(): void {
  if (restartSpin === null) return;
  restartSpin = null;
  window.clearTimeout(restartSpinTimer);
  window.clearTimeout(restartSpinCapTimer);
  restartSpinTimer = undefined;
  restartSpinCapTimer = undefined;
  applyRestartSpin();
}

/** render 每次拿到状态就过一遍收场条件；条件满足但还没转满最短时长时，挂个到点的定时器补收
 * （到点直接收场 + 补一拍刷新，刷新失败也不影响收场这件事本身）。 */
export function updateRestartSpin(status: SessionStatus, starting: boolean): void {
  const spin = restartSpin;
  if (spin === null) return;
  const elapsed = Date.now() - spin.startedAt;
  if (starting) spin.sawStarting = true;
  const failed = status.state === "failed";
  const settled =
    failed ||
    (status.state === "running" && !starting) ||
    (status.state === "stopped" && (spin.sawStarting || elapsed >= RESTART_SPIN_STOP_GRACE_MS));
  if (!settled) return;
  const remaining = RESTART_SPIN_MIN_MS - elapsed;
  if (failed || remaining <= 0) {
    endRestartSpin();
    return;
  }
  window.clearTimeout(restartSpinTimer);
  restartSpinTimer = window.setTimeout(() => {
    restartSpinTimer = undefined;
    endRestartSpin();
    void requestStatusRefresh();
  }, remaining);
}
