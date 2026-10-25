/**
 * 前端接缝测试：确认浮窗（删除 / 重命名 / 桥接插件 / 补丁层）的进出场与焦点。
 *
 * 只测用户能感觉到的行为，不断言毫秒数与 keyframes：
 *  1. 打开时浮窗与遮罩都显示出来，且各自有一段动画（不是硬蹦出来）。
 *  2. 焦点落进面板：桥接 / 补丁落在第一颗按钮（右上角关闭），重命名落在输入框，
 *     删除落在「取消」。
 *  3. Esc 与点遮罩都能关：面板与遮罩都回到隐藏，焦点回到触发的那颗按钮
 *     （三点菜单触发的回到那颗三点按钮，即使切换环境重建过卡片）。
 *  4. 关掉动效（html[data-motion="off"]）后进出瞬时完成，焦点行为不变。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/motion-modal.test.mjs`
 *
 * puppeteer-core 用本机绝对路径：仓库没装它（pnpm 商店锁写不进），这台机器上唯一的一份在
 * .pi 下。换机器时用环境变量 DSHARBOR_PUPPETEER / DSHARBOR_BROWSER 指过去，否则整组跳过。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);

const PUPPETEER_CORE = process.env.DSHARBOR_PUPPETEER || "C:/Users/BOXMIAO/.pi/agent/npm/node_modules/puppeteer-core";
const BROWSER = process.env.DSHARBOR_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
// 独占端口：log 8207 / switch 8208 / picker 8209 / toolbar 8210 / update 8211 / notice-hint 8212 /
// badge-color 8213 / danger-surface 8214 / motion-pref 8215 / motion-interactions 8216 /
// motion-tooltip 8217 / motion-theme 8218 / motion-panels 8219 / 本文件 8220
const PORT = 8220;
const PAGE_URL = `http://127.0.0.1:${PORT}/mock.html`;

const skipReason = !existsSync(PUPPETEER_CORE)
  ? `找不到 puppeteer-core：${PUPPETEER_CORE}（用 DSHARBOR_PUPPETEER 指定）`
  : !existsSync(BROWSER)
    ? `找不到浏览器：${BROWSER}（用 DSHARBOR_BROWSER 指定）`
    : false;

/** 假后端预览台：它会顺带重新生成 dist/mock.html。 */
function startPreview() {
  if (!existsSync(join(root, "dist/index.html"))) {
    throw new Error("dist/index.html 不存在：先跑 pnpm build");
  }
  const child = spawn(process.execPath, ["scripts/mock-preview.mjs", "--port", String(PORT)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("预览台 10 秒内没起来")), 10_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("假数据预览")) {
        clearTimeout(timer);
        resolveReady(child);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`预览台退出（code ${code}）`));
    });
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 打开一页并停在「环境/插件」分区，等环境卡渲染出来。 */
async function openEnvPanel(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-panel-btn="env"]');
  await page.click('[data-panel-btn="env"]');
  await page.waitForSelector(".env-card", { timeout: 5000 });
  await sleep(150);
  return page;
}

/** 从某个环境的三点菜单里点一项（rename / delete / patch…）。 */
async function pickEnvMenu(page, envName, act) {
  await page.click(`[data-env-more="${envName}"]`);
  await page.waitForSelector(`#env-menu [data-env-act="${act}"]`, { visible: true, timeout: 4000 });
  await page.click(`#env-menu [data-env-act="${act}"]`);
}

/**
 * 从这一刻起记录页面里每一次动画开播（目标元素 id + 动画名），放进 window.__animLog。
 * 事后读日志判断「进场/出场动画到底有没有跑」，比当场读 getAnimations() 稳：
 * 短动画可能在断言前就播完了，动画启动事件却一定会被记下来。
 */
async function watchAnimations(page) {
  await page.evaluate(() => {
    window.__animLog = [];
    document.addEventListener(
      "animationstart",
      (event) => {
        const target = event.target;
        window.__animLog.push({
          id: target instanceof Element ? target.id : "",
          name: event.animationName,
        });
      },
      true,
    );
  });
}

/** 清空动画日志：每轮开合之前调用，只看这一轮的动画。 */
async function resetAnimations(page) {
  await page.evaluate(() => {
    window.__animLog.length = 0;
  });
}

/** 等某个元素（按 id）的动画开播；超时说明它压根没动画（硬蹦出来）。
 *  从 Node 侧轮询日志：puppeteer 的 waitForFunction 跑在隔离世界，看不到主世界的 window 属性。 */
async function waitAnimation(page, id, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const started = await page.evaluate(
      (want) => window.__animLog.some((entry) => entry.id === want),
      id,
    );
    if (started) return;
    await sleep(16);
  }
  const seen = await page.evaluate(() =>
    window.__animLog.map((entry) => `${entry.id || "(匿名)"}:${entry.name}`),
  );
  throw new Error(`没等到 #${id} 的动画开播；本轮记录：${seen.join("、") || "（无动画）"}`);
}

/** 等浮窗显示出来，并读回它此刻的状态（可见性、焦点、不透明度）。 */
async function readOpenState(page, selector) {
  await page.waitForSelector(`${selector}:not(.hidden)`, { timeout: 4000 });
  return page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    const scrim = document.querySelector("#modal-scrim");
    const nodes = [
      ...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    ];
    const first = nodes.find((el) => !el.hasAttribute("disabled") && el.offsetParent !== null) ?? panel;
    const active = document.activeElement;
    return {
      panelVisible: getComputedStyle(panel).display !== "none",
      scrimVisible: scrim !== null && getComputedStyle(scrim).display !== "none",
      focusInPanel: panel.contains(active),
      activeId: active?.id ?? "",
      activeClose: active instanceof HTMLElement && active.hasAttribute("data-modal-close"),
      firstIsActive: active === first,
      panelOpacity: getComputedStyle(panel).opacity,
    };
  }, selector);
}

/** 等浮窗与遮罩的动画都播完（入场结束再点关闭，避免读到动画中途状态）。 */
async function waitSettled(page, selector) {
  await page.waitForFunction(
    (sel) => {
      const panel = document.querySelector(sel);
      const scrim = document.querySelector("#modal-scrim");
      const list = [...panel.getAnimations(), ...(scrim ? scrim.getAnimations() : [])];
      return list.every((a) => a.playState === "finished" || a.playState === "idle");
    },
    { timeout: 3000 },
    selector,
  );
}

/** 断言浮窗与遮罩都真的隐藏了，不只是透明度归零。 */
async function assertClosed(page, selector) {
  await page.waitForSelector(selector, { hidden: true, timeout: 2000 });
  await page.waitForSelector("#modal-scrim", { hidden: true, timeout: 2000 });
  const state = await page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    const scrim = document.querySelector("#modal-scrim");
    return {
      panelDisplay: getComputedStyle(panel).display,
      scrimDisplay: getComputedStyle(scrim).display,
      panelClosing: panel.classList.contains("is-closing"),
      scrimClosing: scrim.classList.contains("is-closing"),
      bodyText: document.body.innerText,
    };
  }, selector);
  assert.equal(state.panelDisplay, "none", `${selector} 关闭后应隐藏`);
  assert.equal(state.scrimDisplay, "none", "遮罩关闭后应隐藏，不残留");
  assert.equal(state.panelClosing, false, "关闭完成后不应留 is-closing 类");
  assert.equal(state.scrimClosing, false, "遮罩上不应留 is-closing 类");
}

/** 读当前焦点元素的关键身份。 */
function readActive(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    return {
      id: el?.id ?? "",
      envMore: el instanceof HTMLElement ? el.getAttribute("data-env-more") : null,
      text: (el?.textContent ?? "").trim(),
      inModal: el instanceof HTMLElement ? el.closest(".modal") !== null : false,
    };
  });
}

let preview = null;
let browser = null;

before(async () => {
  if (skipReason) return;
  preview = await startPreview();
  const puppeteer = require(PUPPETEER_CORE);
  browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: true,
    args: ["--no-sandbox"],
    defaultViewport: { width: 1240, height: 900 },
  });
});

after(async () => {
  await browser?.close();
  preview?.kill();
});

test("四个浮窗打开时都有进出场动画、焦点进面板，关闭后焦点回到触发按钮", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser);
  await watchAnimations(page);
  try {
    // 顺序有讲究：补丁层会把「管理目标」切到那个环境，切完就不能再删它了，所以删除排在前面。
    const cases = [
      {
        name: "桥接插件",
        open: () => page.click("#btn-bridge"),
        panel: "#modal-bridge",
        focus: "first",
        trigger: { id: "btn-bridge" },
      },
      {
        name: "重命名",
        open: () => pickEnvMenu(page, "desktop", "rename"),
        panel: "#modal-name",
        focus: "profile-manage-name",
        trigger: { envMore: "desktop" },
      },
      {
        name: "删除",
        open: () => pickEnvMenu(page, "desktop", "delete"),
        panel: "#modal-name",
        focus: "btn-name-cancel",
        trigger: { envMore: "desktop" },
      },
      {
        name: "补丁层",
        open: () => pickEnvMenu(page, "headless", "patch"),
        panel: "#modal-patch",
        focus: "first",
        trigger: { envMore: "headless" },
      },
    ];

    for (const item of cases) {
      const panelId = item.panel.slice(1);
      await resetAnimations(page);
      await item.open();
      // 进场：面板与遮罩各有一段动画（不是硬蹦出来）。
      await waitAnimation(page, panelId);
      await waitAnimation(page, "modal-scrim");

      const state = await readOpenState(page, item.panel);
      assert.equal(state.panelVisible, true, `${item.name}：浮窗应显示`);
      assert.equal(state.scrimVisible, true, `${item.name}：遮罩应显示`);
      assert.equal(state.focusInPanel, true, `${item.name}：焦点应落进浮窗`);

      if (item.focus === "first") {
        assert.equal(state.firstIsActive, true, `${item.name}：焦点应落在面板内第一颗按钮`);
      } else {
        assert.equal(state.activeId, item.focus, `${item.name}：焦点应落在 #${item.focus}`);
      }

      await waitSettled(page, item.panel);
      // 动画收尾必须停在完全可见，不能停在半透明。
      const settled = await readOpenState(page, item.panel);
      assert.equal(settled.panelOpacity, "1", `${item.name}：入场结束后浮窗应完全不透明`);

      // 出场：关闭时面板与遮罩也要走一段更快的淡出，再真正隐藏。
      await resetAnimations(page);
      await page.keyboard.press("Escape");
      await waitAnimation(page, panelId);
      await waitAnimation(page, "modal-scrim");
      await assertClosed(page, item.panel);

      const active = await readActive(page);
      if (item.trigger.id) {
        assert.equal(active.id, item.trigger.id, `${item.name}：关闭后焦点应回到 #${item.trigger.id}`);
      } else {
        assert.equal(
          active.envMore,
          item.trigger.envMore,
          `${item.name}：关闭后焦点应回到「${item.trigger.envMore}」的三点按钮，实测 ${JSON.stringify(active)}`,
        );
      }
    }
  } finally {
    await page.close();
  }
});

test("点遮罩也能关：面板与遮罩都不残留，焦点回到触发按钮", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser);
  await watchAnimations(page);
  try {
    await page.click("#btn-bridge");
    const opened = await readOpenState(page, "#modal-bridge");
    assert.equal(opened.panelVisible, true, "点遮罩前浮窗应已打开");
    await waitSettled(page, "#modal-bridge");

    // 点左上角：那里只有遮罩，不会落到面板上。
    await resetAnimations(page);
    await page.mouse.click(8, 8);
    await waitAnimation(page, "modal-bridge");
    await waitAnimation(page, "modal-scrim");
    await assertClosed(page, "#modal-bridge");

    const active = await readActive(page);
    assert.equal(active.id, "btn-bridge", "点遮罩关闭后焦点应回到「桥接插件」按钮");
  } finally {
    await page.close();
  }
});

test("关掉动效后：进出瞬时完成，焦点行为不变", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser);
  try {
    await page.evaluate(() => {
      document.documentElement.dataset.motion = "off";
    });

    await pickEnvMenu(page, "desktop", "delete");
    // 不等待动画：关掉动效时应该已经直接可见。
    const opened = await page.evaluate(() => {
      const panel = document.querySelector("#modal-name");
      const scrim = document.querySelector("#modal-scrim");
      return {
        panelDisplay: getComputedStyle(panel).display,
        panelOpacity: getComputedStyle(panel).opacity,
        scrimDisplay: getComputedStyle(scrim).display,
        focusId: document.activeElement?.id ?? "",
      };
    });
    assert.equal(opened.panelDisplay, "flex", "关掉动效时浮窗应瞬时显示");
    assert.equal(opened.panelOpacity, "1", "关掉动效时浮窗应直接完全不透明");
    assert.equal(opened.scrimDisplay, "block", "关掉动效时遮罩应瞬时显示");
    assert.equal(opened.focusId, "btn-name-cancel", "关掉动效时删除浮窗的焦点仍应落在「取消」");

    await page.keyboard.press("Escape");
    const closed = await page.evaluate(() => {
      const panel = document.querySelector("#modal-name");
      const scrim = document.querySelector("#modal-scrim");
      return {
        panelDisplay: getComputedStyle(panel).display,
        scrimDisplay: getComputedStyle(scrim).display,
        focusEnvMore: document.activeElement instanceof HTMLElement
          ? document.activeElement.getAttribute("data-env-more")
          : null,
      };
    });
    assert.equal(closed.panelDisplay, "none", "关掉动效时浮窗应瞬时隐藏");
    assert.equal(closed.scrimDisplay, "none", "关掉动效时遮罩应瞬时隐藏");
    assert.equal(closed.focusEnvMore, "desktop", "关掉动效时关闭后焦点仍应回到触发按钮");
  } finally {
    await page.close();
  }
});
