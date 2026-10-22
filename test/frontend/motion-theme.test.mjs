/**
 * 前端接缝测试：深浅切换的双图标对转交接（#31）。
 *
 * 只测「浏览器里才说得清」的接缝，不断言毫秒数与 keyframes：
 *  1. 两个图标（太阳 / 月亮）都在 DOM 里，各带 ico-sun / ico-moon 类。
 *  2. 可见性由 <html data-mode> 驱动：深色时太阳在场、月亮退场；浅色反之。
 *  3. 点一下按钮后 data-mode 变化（深→浅、浅→深两套外观都验）。
 *  4. 切到浅色后太阳隐藏、月亮显示（语义仍是「点下去会变成什么」）。
 *  5. 关闭动效（data-motion="off"）后切换无过渡：svg 的 transitionDuration 为 0s，外观仍正确。
 *  6. 连续两次快速点击后最终状态正确：只有一个图标清晰可见，另一个已退场（不卡中间态）。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/mock.html）。
 * 跑法：`node --test test/frontend/motion-theme.test.mjs`
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
const PORT = 8218; // 独占端口：本文件 8218（见 NOTES.md 端口表）
const THEME_KEY = "dsharbor.ui.theme";
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

/** 新开一页，预置外观与动效偏好后重载，等界面挂上。theme=null 时不写外观。 */
async function openPage(browser, { theme = null, motion = null } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    (themeKey, motionKey, themeVal, motionVal) => {
      window.localStorage.removeItem(themeKey);
      window.localStorage.removeItem(motionKey);
      if (themeVal !== null) window.localStorage.setItem(themeKey, themeVal);
      if (motionVal !== null) window.localStorage.setItem(motionKey, motionVal);
    },
    THEME_KEY,
    MOTION_KEY,
    theme,
    motion,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#mode-btn");
  await sleep(180); // 等首帧脚本与挂载跑完、样式重算
  return page;
}

/** 读根元素 data-mode 与两颗图标的计算样式（透明度 / 变换 / 过渡时长）。 */
function readIcons(page) {
  return page.evaluate(() => {
    const mode = document.documentElement.dataset.mode;
    const sun = document.querySelector("#mode-btn .ico-sun");
    const moon = document.querySelector("#mode-btn .ico-moon");
    const pick = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { opacity: parseFloat(cs.opacity), transform: cs.transform, transitionDuration: cs.transitionDuration };
    };
    return { mode, sun: pick(sun), moon: pick(moon) };
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

test("两个图标都在 DOM 里：太阳与月亮各一颗，带 ico-sun / ico-moon 类", { skip: skipReason }, async () => {
  const page = await openPage(browser, { theme: "dark" });
  try {
    const shape = await page.evaluate(() => {
      const svgs = document.querySelectorAll("#mode-btn svg");
      return {
        count: svgs.length,
        hasSun: !!document.querySelector("#mode-btn .ico-sun"),
        hasMoon: !!document.querySelector("#mode-btn .ico-moon"),
      };
    });
    assert.equal(shape.count, 2, "深浅切换按钮里应同时有两个图标");
    assert.ok(shape.hasSun, "应有太阳图标 .ico-sun");
    assert.ok(shape.hasMoon, "应有月亮图标 .ico-moon");
  } finally {
    await page.close();
  }
});

test("可见性由 data-mode 驱动：深色太阳在场、浅色月亮在场", { skip: skipReason }, async () => {
  const page = await openPage(browser, { theme: "dark" });
  try {
    const dark = await readIcons(page);
    assert.equal(dark.mode, "dark");
    assert.ok(dark.sun && dark.moon, "两颗图标都应存在");
    assert.ok(dark.sun.opacity > 0.9, `深色下太阳应清晰可见，实测 ${dark.sun.opacity}`);
    assert.ok(dark.moon.opacity < 0.1, `深色下月亮应已退场，实测 ${dark.moon.opacity}`);

    // 直接改 data-mode，验证可见性确实由它驱动（不依赖按钮点击）。
    await page.evaluate(() => {
      document.documentElement.dataset.mode = "light";
    });
    await sleep(400); // 等过渡走完
    const light = await readIcons(page);
    assert.ok(light.sun.opacity < 0.1, `浅色下太阳应退场，实测 ${light.sun.opacity}`);
    assert.ok(light.moon.opacity > 0.9, `浅色下月亮应清晰可见，实测 ${light.moon.opacity}`);
  } finally {
    await page.close();
  }
});

test("点击后 data-mode 变化：深→浅", { skip: skipReason }, async () => {
  const page = await openPage(browser, { theme: "dark" });
  try {
    assert.equal((await readIcons(page)).mode, "dark");
    await page.click("#mode-btn");
    await page.waitForFunction(() => document.documentElement.dataset.mode === "light", { timeout: 3000 });
    assert.equal((await readIcons(page)).mode, "light");
  } finally {
    await page.close();
  }
});

test("切到浅色后太阳隐、月亮显（语义仍是「点下去会变成什么」）", { skip: skipReason }, async () => {
  const page = await openPage(browser, { theme: "dark" });
  try {
    await page.click("#mode-btn");
    await sleep(400); // 等过渡走完
    const s = await readIcons(page);
    assert.equal(s.mode, "light");
    assert.ok(s.sun.opacity < 0.1, `浅色下太阳应隐藏，实测 ${s.sun.opacity}`);
    assert.ok(s.moon.opacity > 0.9, `浅色下月亮应显示，实测 ${s.moon.opacity}`);
  } finally {
    await page.close();
  }
});

test("从浅色起切到深色也正常：月亮退、太阳进场", { skip: skipReason }, async () => {
  const page = await openPage(browser, { theme: "light" });
  try {
    assert.equal((await readIcons(page)).mode, "light");
    await page.click("#mode-btn");
    await page.waitForFunction(() => document.documentElement.dataset.mode === "dark", { timeout: 3000 });
    await sleep(400);
    const s = await readIcons(page);
    assert.equal(s.mode, "dark");
    assert.ok(s.sun.opacity > 0.9, `切回深色后太阳应显示，实测 ${s.sun.opacity}`);
    assert.ok(s.moon.opacity < 0.1, `切回深色后月亮应隐藏，实测 ${s.moon.opacity}`);
  } finally {
    await page.close();
  }
});

test("关闭动效后切换无过渡（transitionDuration 为 0s）且外观正确", { skip: skipReason }, async () => {
  const page = await openPage(browser, { theme: "dark", motion: "off" });
  try {
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-motion")), "off");
    const before = await readIcons(page);
    assert.match(before.sun.transitionDuration, /^0s(,\s*0s)*$/, `关动效后太阳过渡应为 0s，实测 ${before.sun.transitionDuration}`);
    assert.match(before.moon.transitionDuration, /^0s(,\s*0s)*$/, `关动效后月亮过渡应为 0s，实测 ${before.moon.transitionDuration}`);

    await page.click("#mode-btn");
    await sleep(60); // 关动效应瞬时；短暂等待也足够
    const s = await readIcons(page);
    assert.equal(s.mode, "light", "关动效后点击仍应切换外观");
    assert.ok(s.sun.opacity < 0.1, `关动效后太阳应即时隐藏，实测 ${s.sun.opacity}`);
    assert.ok(s.moon.opacity > 0.9, `关动效后月亮应即时显示，实测 ${s.moon.opacity}`);
  } finally {
    await page.close();
  }
});

test("连续两次快速点击后最终状态正确：只有一个图标清晰，另一个已退场", { skip: skipReason }, async () => {
  const page = await openPage(browser, { theme: "dark" });
  try {
    // 两次点击间隔远小于过渡时长（260ms），模拟手快连点。
    await page.click("#mode-btn");
    await sleep(40);
    await page.click("#mode-btn");
    // 等过渡彻底走完，确认没有卡在中间态。
    await sleep(500);
    const s = await readIcons(page);
    assert.equal(s.mode, "dark", "深→浅→深，最终应回到深色");
    assert.ok(s.sun.opacity > 0.9, `最终太阳应清晰可见，实测 ${s.sun.opacity}`);
    assert.ok(s.moon.opacity < 0.1, `最终月亮应已退场，实测 ${s.moon.opacity}`);
    // 关键是不能两个都半透明卡在中间。
    assert.ok(
      !(s.sun.opacity > 0.5 && s.moon.opacity > 0.5),
      `不应两个图标同时清晰可见，实测 sun=${s.sun.opacity} moon=${s.moon.opacity}`,
    );
  } finally {
    await page.close();
  }
});
