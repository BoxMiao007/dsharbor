/**
 * 前端接缝测试：动态提示胶囊限一行 + 「检查更新」完成的右下角回执。
 *
 *  1. 「本机已经装过」提示（#npx-installed-hint，.hint.notice）正文限一行：
 *     white-space 是 nowrap、放不下时省略号，全文挂 data-tip 走悬停气泡；
 *  2. 用户主动点的「检查更新」完成后，右下角出一条 info toast，文案与日志同句
 *     （「已重新检查插件更新：N 个可更新…」）；toast 不是 ok 也不是 error——
 *     检查本身没有成败之分，数量才是信息。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/notice-hint.test.mjs`
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
const PORT = 8212; // 独占端口:见 AGENTS.md「容易踩的」里的端口表
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

let browser;
let preview;

before(async () => {
  if (skipReason) {
    return;
  }
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

/** 打开一页、等版本列表落定，并选中 0.2.0-rc.2（带「已缓存」徽章、但缓存那份是裸包名
 *  写法留下的——钉版本直接复用的情况已不再出提示行，见 version-picker.test.mjs）。 */
async function openWithCachedVersion(browser) {
  const page = await browser.newPage();
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#npx-version-picker .picker-btn");
  await page.waitForFunction(
    () => document.querySelector("#npx-version-picker .picker-label")?.textContent.includes("自动最新版本"),
    { timeout: 5000 },
  );
  await page.click("#npx-version-picker .picker-btn");
  // 「已缓存」徽章来自异步的 npx 缓存扫描，落地后才有行可点。
  await page.waitForFunction(
    () => [...document.querySelectorAll("#npx-version-picker .picker-badge")].some((b) => b.textContent === "已缓存"),
    { timeout: 5000 },
  );
  await page.evaluate(() => {
    // 0.2.0-rc.2：带「已缓存」徽章、但缓存那份是裸包名写法留下的——钉版本直接复用的情况
    // 已不再出提示行（见 version-picker.test.mjs），要选这一版提示才会出现。
    const row = [...document.querySelectorAll("#npx-version-picker .picker-option")].find(
      (r) => r.querySelector(".picker-badge-cached") && r.querySelector(".text")?.textContent === "0.2.0-rc.2",
    );
    row?.click();
  });
  await page.waitForFunction(() => !document.querySelector("#npx-installed-hint").classList.contains("hidden"), {
    timeout: 3000,
  });
  return page;
}

test("本机已装提示限一行，全文挂 data-tip 走悬停气泡", { skip: skipReason }, async () => {
  const page = await openWithCachedVersion(browser);
  try {
    const look = await page.evaluate(() => {
      const el = document.querySelector("#npx-installed-hint");
      const cs = getComputedStyle(el);
      return {
        text: el.textContent,
        tip: el.dataset.tip ?? "",
        nowrap: cs.whiteSpace === "nowrap",
        ellipsis: cs.textOverflow === "ellipsis",
      };
    });
    assert.ok(look.text.length > 0, "选中有缓存的版本后提示行应当有话");
    assert.equal(look.tip, look.text, "data-tip 应当存着全文，悬停气泡才完整");
    assert.equal(look.nowrap, true, "提示正文应当限一行（white-space: nowrap）");
    assert.equal(look.ellipsis, true, "放不下时应当出现省略号");
  } finally {
    await page.close();
  }
});

test("「检查更新」完成后右下角回执一条 info toast，文案带可更新数", { skip: skipReason }, async () => {
  const page = await browser.newPage();
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  // 等插件卡自动查完（进卡自动查是背景动作，不弹 toast），再点按钮发起强制查。
  await page.waitForFunction(
    () => {
      const btn = document.querySelector("#btn-plugin-check-updates");
      return btn && !btn.disabled;
    },
    { timeout: 8000 },
  );
  await sleep(200);
  await page.evaluate(() => document.querySelector("#btn-plugin-check-updates").click());
  await page.waitForSelector("#toasts .toast:not(.is-leaving)", { timeout: 8000 });
  const toast = await page.evaluate(() => {
    const el = document.querySelector("#toasts .toast:not(.is-leaving)");
    return { text: el?.querySelector(".toast-body")?.textContent ?? "", kind: el?.dataset.kind };
  });
  assert.match(toast.text, /已重新检查插件更新：\d+ 个可更新/, `回执文案不对：「${toast.text}」`);
  assert.equal(toast.kind, "info", `检查更新是数量汇报，语气应是 info，实际 ${toast.kind}`);
  await page.close();
});
