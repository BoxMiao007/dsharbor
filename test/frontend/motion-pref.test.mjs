/**
 * 前端接缝测试：动效偏好开关 + 全局中和（#27）。
 *
 * 只测四个「浏览器里才说得清」的接缝：
 *  1. 默认开：没存过偏好时，<html> 上没有 data-motion，开关是 aria-checked=true。
 *  2. 关掉后根元素属性落地：切一下开关，data-motion="off"，并写进 localStorage。
 *  3. 重载仍关：整页重新加载后仍是关闭态（首帧就静态）。
 *  4. 系统 prefers-reduced-motion: reduce 不影响本项目：模拟系统偏好，本项目照常有动效。
 * 另抽查三处「关掉后确实被中和」：重启的无限转圈、计数弹跳、通用过渡时长。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/mock.html）。
 * 跑法：`node --test test/frontend/motion-pref.test.mjs`
 *
 * puppeteer-core 用本机绝对路径：仓库没装它。换机器时用环境变量
 * DSHARBOR_PUPPETEER / DSHARBOR_BROWSER 指过去，否则整组跳过。
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
const PORT = 8215; // 独占端口：log 8207 / switch 8208 / picker 8209 / toolbar 8210 / update 8211 / badge 8213 / danger 8214 / 本文件 8215
const MOTION_KEY = "dsharbor.ui.motion";
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

/** 新开一页、停在「托盘与网络」分区，并把偏好预置成 `motion`（null=清掉，模拟从没存过）。 */
async function openTraynet(browser, motion) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    (key, value) => {
      window.localStorage.removeItem(key);
      if (value !== null) window.localStorage.setItem(key, value);
    },
    MOTION_KEY,
    motion,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-panel-btn="traynet"]');
  await page.click('[data-panel-btn="traynet"]');
  await page.waitForSelector("#motion-toggle");
  await sleep(150); // 等首帧内联脚本与挂载都跑完、样式重算
  return page;
}

/** 读「动效」开关与根元素的落点。 */
function readMotionState(page) {
  return page.evaluate(
    (key) => ({
      attr: document.documentElement.getAttribute("data-motion"),
      ariaChecked: document.querySelector("#motion-toggle")?.getAttribute("aria-checked") ?? null,
      stored: window.localStorage.getItem(key),
    }),
    MOTION_KEY,
  );
}

/** 读某个选择器的计算样式字段。 */
function computed(page, selector, props) {
  return page.evaluate(
    (sel, list) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const out = {};
      for (const prop of list) out[prop] = cs[prop];
      return out;
    },
    selector,
    props,
  );
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

test("默认开：没存过偏好时根元素没有 data-motion，开关 aria-checked=true", { skip: skipReason }, async () => {
  const page = await openTraynet(browser, null);
  try {
    const state = await readMotionState(page);
    assert.equal(state.attr, null, "默认不该往 <html> 写 data-motion");
    assert.equal(state.ariaChecked, "true", "默认「动效」开关应处于开启态");
  } finally {
    await page.close();
  }
});

test("关掉后根元素属性落地：data-motion=off 并写进 localStorage", { skip: skipReason }, async () => {
  const page = await openTraynet(browser, null);
  try {
    await page.click("#motion-toggle");
    await page.waitForFunction(() => document.documentElement.getAttribute("data-motion") === "off", { timeout: 3000 });
    const state = await readMotionState(page);
    assert.equal(state.attr, "off", "关掉后 <html> 应带 data-motion=off");
    assert.equal(state.ariaChecked, "false", "关掉后开关 aria-checked 应为 false");
    assert.equal(state.stored, "off", "关掉后应把 off 写进 localStorage");
  } finally {
    await page.close();
  }
});

test("重载仍关：整页重新加载后首帧就是关闭态", { skip: skipReason }, async () => {
  const page = await openTraynet(browser, null);
  try {
    await page.click("#motion-toggle");
    await page.waitForFunction(() => document.documentElement.getAttribute("data-motion") === "off", { timeout: 3000 });
    // 重新加载：偏好应被内联脚本首帧读回来，root 属性与开关都保持关闭。
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#motion-toggle");
    await sleep(150);
    const state = await readMotionState(page);
    assert.equal(state.attr, "off", "重载后 <html> 仍应带 data-motion=off（首帧静态）");
    assert.equal(state.ariaChecked, "false", "重载后开关应仍是关闭态");
    assert.equal(state.stored, "off", "重载后 localStorage 应仍是 off");
  } finally {
    await page.close();
  }
});

test("关掉后抽查三处被中和：重启转圈停、计数弹跳停、过渡时长归零", { skip: skipReason }, async () => {
  const page = await openTraynet(browser, "off");
  try {
    // 1) 重启的无限转圈：挂上 is-restarting（元素在 DOM 里），动画应为 none 而不是 1ms 死循环。
    const spin = await page.evaluate(() => {
      const btn = document.querySelector("#btn-restart");
      if (!btn) return null;
      btn.classList.add("is-restarting");
      return getComputedStyle(btn.querySelector("svg")).animationName;
    });
    assert.equal(spin, "none", "关掉动效后重启的转圈应 animation: none（不能压成 1ms 死循环空转）");

    // 2) 计数弹跳：给一个 .ico-count 挂上 bump 类，动画应为 none。
    const bump = await page.evaluate(() => {
      const el = document.querySelector(".ico-count");
      if (!el) return null;
      el.classList.add("ico-count-bump");
      return getComputedStyle(el).animationName;
    });
    assert.equal(bump, "none", "关掉动效后计数弹跳应 animation: none");

    // 3) 通用过渡：开关圆头的 transition 时长应归零。
    const knob = await computed(page, ".switch .switch-knob", ["transitionDuration"]);
    assert.ok(knob, "应能读到 .switch .switch-knob");
    assert.match(knob.transitionDuration, /^0s(,\s*0s)*$/, `关掉动效后过渡时长应归零，实测 ${knob.transitionDuration}`);
  } finally {
    await page.close();
  }
});

test("系统 prefers-reduced-motion: reduce 不影响本项目：动效照常", { skip: skipReason }, async () => {
  const page = await openTraynet(browser, "on");
  try {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    // 停止态下主按钮是 .swap，悬停有抖动动画；系统减少动画开着也应照常出现。
    await page.hover("#btn-toggle.swap");
    await sleep(120);
    const shake = await computed(page, "#btn-toggle.swap", ["animationName"]);
    assert.ok(shake, "应能读到 #btn-toggle.swap");
    assert.equal(
      shake.animationName,
      "dsharbor-shake",
      "系统开启「减少动画」时本项目仍应有动效（不该被系统偏好压成 none）",
    );
    // 通用过渡也不该被系统偏好压掉。
    const knob = await computed(page, ".switch .switch-knob", ["transitionDuration"]);
    assert.ok(knob);
    assert.notEqual(knob.transitionDuration, "0s", "系统「减少动画」下本项目过渡时长不该被压成 0");
  } finally {
    await page.close();
  }
});
