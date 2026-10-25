/**
 * 前端接缝测试：插件名点开主页。
 *
 * 只测一个接缝：插件名在包里带 homepage / repository 时渲染成可点按钮，点下去把
 * 清洗过的地址交给壳（`open_link`）；两个字段都没有的包保持纯文本，不出现空按钮。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/plugin-home.test.mjs`
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
const PORT = 8227; // 独占端口:见 AGENTS.md「容易踩的」里的端口表
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

/** 打开一页并停在「环境/插件」分区，等插件清单就位。 */
async function openPluginPanel(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-panel-btn="env"]');
  await page.click('[data-panel-btn="env"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#plugin-list .plugin-row").length > 0 &&
      document.querySelector("#plugin-summary").textContent.includes("个可更新"),
    { timeout: 5000 },
  );
  await sleep(150);
  return page;
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

test("带主页的插件名是可点按钮，没主页的是纯文本", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    const shape = await page.evaluate(() => {
      const row = (name) => document.querySelector(`#plugin-list [data-row="${name}"]`);
      const read = (name) => {
        const box = row(name);
        const link = box?.querySelector(".plugin-name-link");
        return {
          link: !!link,
          url: link?.dataset.pluginHome ?? null,
          tip: link?.getAttribute("title") ?? null,
          text: box?.querySelector(".plugin-name")?.textContent?.trim() ?? null,
        };
      };
      return {
        withHome: read("billion-context"),
        // 包里既无 homepage 也无 repository：不该出空按钮。
        withoutHome: read("dsh-free-search"),
        bridge: read("dsharbor-bridge"),
      };
    });

    assert.equal(shape.withHome.link, true, "带主页的插件名要是按钮");
    assert.equal(shape.withHome.url, "https://github.com/ranxianglei/billion-context", "地址来自包的 homepage");
    assert.match(shape.withHome.tip ?? "", /billion-context|github\.com/, "气泡要说明这是打开主页");
    assert.equal(shape.withHome.text, "billion-context", "名字本身不变");

    assert.equal(shape.withoutHome.link, false, "没有主页的插件名保持纯文本");
    assert.equal(shape.withoutHome.text, "dsh-free-search", "纯文本也照常显示名字");

    assert.equal(shape.bridge.link, false, "桥接插件没有主页，不该是按钮");
  } finally {
    await page.close();
  }
});

test("点插件名把地址交给壳打开；失败的报错要落到日志与回执", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    // 预览台的 open_link 假命令会把收到的地址记进 calls，这里借它确认参数没被改写。
    await page.evaluate(() => {
      window.__OPENED__ = [];
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        if (cmd === "open_link") {
          window.__OPENED__.push(args?.url ?? null);
          return Promise.resolve();
        }
        return original(cmd, args);
      };
    });
    await page.evaluate(() => {
      document.querySelector('#plugin-list [data-row="billion-context"] .plugin-name-link').click();
    });
    await sleep(200);
    const opened = await page.evaluate(() => window.__OPENED__);
    assert.deepEqual(opened, ["https://github.com/ranxianglei/billion-context"], "应把清洗过的地址原样交给 open_link");

    const logged = await page.evaluate(() => document.getElementById("log").textContent);
    assert.match(logged, /已在浏览器打开插件主页/, "日志里要留一行，事后能查到点了什么");

    // 壳拒绝（比如后端判定不是 http/https）时：日志记全文、回执给首行。
    await page.evaluate(() => {
      window.__TAURI_INTERNALS__.invoke = (cmd) => {
        if (cmd === "open_link") {
          return Promise.reject("只支持 http/https 链接，这个是 file。");
        }
        return Promise.resolve(null);
      };
    });
    await page.evaluate(() => {
      document.querySelector('#plugin-list [data-row="billion-context"] .plugin-name-link').click();
    });
    await sleep(250);
    const toasts = await page.evaluate(() =>
      [...document.querySelectorAll("#toasts .toast")].map((item) => item.textContent.trim()),
    );
    assert.ok(
      toasts.some((text) => text.includes("打开主页失败")),
      `失败要有回执，实际：${JSON.stringify(toasts)}`,
    );
  } finally {
    await page.close();
  }
});
