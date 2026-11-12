/**
 * 前端接缝测试：启动时的「运行环境」列表（WSL 发行版）。
 *
 * 只测三条接缝——它们都是「启动不能再被 WSL 探测挡住」的可见证据：
 *  1. 有落盘缓存时，界面一挂载就把缓存里的发行版铺进下拉框，不等探测；后台探测
 *     回来再换成新结果（缓存里的旧项消失）。
 *  2. 第一次启动（没有缓存）先显示「（正在读取发行版列表…）」，探测回来换上真列表。
 *  3. 探测失败（超时、发行版起不来）时保留已铺出来的缓存，不把候选清空成失败占位。
 * 另外确认探测变慢不拖累别的初始化：版本列表照常在探测完成前就绪。
 *
 * 背景：冷启动的 `wsl.exe` 要先把整个 WSL 子系统拉起来（实测 8 秒），原来启动时
 * `await` 探测，下拉框就一直卡在「正在读取发行版列表…」，还会挡住后面的初始化。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/distro-cache.test.mjs`
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
const PORT = 8228; // 独占端口:见 AGENTS.md「容易踩的」里的端口表
const PAGE_URL = `http://127.0.0.1:${PORT}/mock.html`;

const skipReason = !existsSync(PUPPETEER_CORE)
  ? `找不到 puppeteer-core：${PUPPETEER_CORE}（用 DSHARBOR_PUPPETEER 指定）`
  : !existsSync(BROWSER)
    ? `找不到浏览器：${BROWSER}（用 DSHARBOR_BROWSER 指定）`
    : false;

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

/** 打开页面，只等骨架挂上——不等任何异步数据，好在「数据还没回来」的窗口里量状态。 */
async function openPage(browser, state) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  await page.goto(`${PAGE_URL}?state=${encodeURIComponent(JSON.stringify(state))}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#npx-runtime-picker .picker-btn");
  return page;
}

/** 运行环境下拉框里的候选文案（列表收着也在 DOM 里，选项由 setChoices 直接铺好）。 */
function optionTexts(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#npx-runtime-picker .picker-option .text")).map(
      (el) => el.textContent ?? "",
    ),
  );
}

/** 等候选里出现某段文字（探测/缓存落地后重铺候选）。 */
function waitOption(page, text, timeout = 6000) {
  return page.waitForFunction(
    (needle) =>
      Array.from(document.querySelectorAll("#npx-runtime-picker .picker-option .text")).some((el) =>
        (el.textContent ?? "").includes(needle),
      ),
    { timeout },
    text,
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

test("有缓存：启动立刻铺出缓存里的发行版，探测回来再换成新结果", { skip: skipReason }, async () => {
  const page = await openPage(browser, {
    distrosCached: [{ distro: "Ubuntu", hasNode: true }],
    distros: [{ distro: "Debian", hasNode: true }],
    distroProbeDelay: 3000,
  });
  try {
    // 探测还挂着（3 秒）的时候，候选已经来自缓存：不该是「正在读取…」占位。
    const early = await optionTexts(page);
    assert.deepEqual(early, ["默认", "WSL - Ubuntu"], `缓存应立刻铺出来，实际 ${JSON.stringify(early)}`);

    // 探测变慢也不拖别的初始化：官方版本列表照常在探测完成前就绪。
    await page.waitForFunction(
      () => document.querySelector("#npx-version-picker .picker-label")?.textContent.includes("自动最新版本"),
      { timeout: 1500 },
    );

    // 后台探测回来，换成它探到的发行版（缓存里的旧项不该留着）。
    await waitOption(page, "WSL - Debian");
    const settled = await optionTexts(page);
    assert.deepEqual(settled, ["默认", "WSL - Debian"], `探测结果应替换缓存，实际 ${JSON.stringify(settled)}`);
  } finally {
    await page.close();
  }
});

test("没有缓存：先显示读取中占位，探测回来换上真列表", { skip: skipReason }, async () => {
  const page = await openPage(browser, {
    distrosCached: null,
    distros: [{ distro: "Ubuntu", hasNode: true }],
    distroProbeDelay: 1200,
  });
  try {
    const early = await optionTexts(page);
    assert.ok(
      early.some((text) => text.includes("正在读取发行版列表")),
      `没有缓存时应显示读取中占位，实际 ${JSON.stringify(early)}`,
    );
    await waitOption(page, "WSL - Ubuntu");
    const settled = await optionTexts(page);
    assert.deepEqual(settled, ["默认", "WSL - Ubuntu"], `探测回来应换成真列表，实际 ${JSON.stringify(settled)}`);
  } finally {
    await page.close();
  }
});

test("探测失败：保留已铺出来的缓存，不把候选清空成失败占位", { skip: skipReason }, async () => {
  const page = await openPage(browser, {
    distrosCached: [{ distro: "Ubuntu", hasNode: true }],
    distroProbeFails: true,
    distroProbeDelay: 300,
  });
  try {
    await sleep(800); // 等失败落地：失败路径只看结果，不对时序作断言
    const texts = await optionTexts(page);
    assert.deepEqual(
      texts,
      ["默认", "WSL - Ubuntu"],
      `探测失败不该抹掉上次的候选，实际 ${JSON.stringify(texts)}`,
    );
    assert.ok(
      !texts.some((text) => text.includes("读取发行版列表失败")),
      "已有缓存时不该退成失败占位",
    );
  } finally {
    await page.close();
  }
});
