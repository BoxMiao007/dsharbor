/**
 * 前端接缝测试：插件列表的「总开关」与「开关切换时列表不跳」。
 *
 * 只测两个接缝——插件卡里每个插件一行的那个开关：
 *  1. 它管的是**插件整体的启用/停用**（点一下就把这一行的 aria-checked 翻过来、计数跟着变），
 *     不是插件内部的某个子开关；
 *  2. 点开关不引起列表重排：行数、行序、每行 top 与行高都不变（开关只翻 is-off 与 aria-checked，
 *     不重建行 DOM、不插入/删除占位）。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/plugin-switch.test.mjs`
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
const PORT = 8208;
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

/** 打开一页并停在「环境/插件」分区、等插件清单渲染出来。 */
async function openPluginPanel(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-panel-btn="env"]');
  await page.click('[data-panel-btn="env"]');
  await page.waitForFunction(
    () => document.querySelectorAll("#plugin-list .plugin-row").length > 0,
    { timeout: 5000 },
  );
  // 等「正在读取插件清单…」换成真实计数，说明清单与徽章都落好了。
  await page.waitForFunction(
    () => !document.querySelector("#plugin-summary").textContent.includes("正在读取"),
    { timeout: 5000 },
  );
  await sleep(150);
  return page;
}

/** 读一次列表的几何：行数、每行名字/top/高度、开关状态，以及列表有没有横向溢出。 */
function readRows(page) {
  return page.evaluate(() => {
    const list = document.querySelector("#plugin-list");
    const rows = Array.from(list.querySelectorAll(".plugin-row"));
    return {
      count: rows.length,
      names: rows.map((row) => row.querySelector(".plugin-name").textContent),
      tops: rows.map((row) => Math.round(row.getBoundingClientRect().top)),
      heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
      checked: rows.map((row) => row.querySelector(".switch").getAttribute("aria-checked")),
      off: rows.map((row) => row.classList.contains("is-off")),
      overflowX: list.scrollWidth > list.clientWidth,
      summary: document.querySelector("#plugin-summary").textContent,
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

test("开关管的是插件整体：点一下翻这一行的状态并更新计数", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    const before = await readRows(page);
    assert.ok(before.count > 0, "插件列表不该是空的");

    // 拿第一行开刀：记下它的初始状态，点一下应当恰好翻过来。
    const firstBefore = before.checked[0] === "true";
    await page.click(`#plugin-list .plugin-row:nth-child(1) .switch`);
    await sleep(600);

    const after = await readRows(page);
    assert.equal(after.count, before.count, "开关不该改变行数");
    assert.equal(after.checked[0], firstBefore ? "false" : "true", "第一行的开关状态应翻转");
    assert.equal(after.off[0], firstBefore, "行上的 is-off 类应跟着开关状态走");

    // 其余行原封不动——说明点的是这一行自己的总开关，没有串到别的行或插件内部子项上。
    for (let i = 1; i < before.count; i += 1) {
      assert.equal(after.checked[i], before.checked[i], `第 ${i + 1} 行不该被带变`);
    }

    // 计数徽章的分子跟着变。
    const beforeOn = before.checked.filter((v) => v === "true").length;
    const afterOn = after.checked.filter((v) => v === "true").length;
    assert.ok(after.summary.includes(`${afterOn}/${after.count}`), `计数应更新为 ${afterOn}/${after.count}，实际「${after.summary}」`);
    assert.equal(afterOn, beforeOn + (firstBefore ? -1 : 1), "启用数应只差这一行的变化");
  } finally {
    await page.close();
  }
});

test("点开关不引起列表跳动：行数、行序、每行位置与行高都不变", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    const before = await readRows(page);
    assert.ok(before.count > 1, "至少要两行才能看出重排");

    await page.click(`#plugin-list .plugin-row:nth-child(1) .switch`);
    // 开关是异步的（先备份再写补丁层）：给足一轮，期间布局都不该动。
    await sleep(900);

    const after = await readRows(page);
    assert.deepEqual(after.names, before.names, "行序不该变");
    assert.deepEqual(after.tops, before.tops, "每行的纵向位置不该变（无重排/无占位插入）");
    assert.deepEqual(after.heights, before.heights, "每行高度不该变（文案长度不影响行高）");
    assert.equal(after.overflowX, false, "列表不该因为开关而出现横向溢出");
  } finally {
    await page.close();
  }
});

test("连点两次开关后列表仍与初始几何一致", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    const before = await readRows(page);
    const firstIndex = 0;
    await page.click(`#plugin-list .plugin-row:nth-child(${firstIndex + 1}) .switch`);
    await sleep(600);
    await page.click(`#plugin-list .plugin-row:nth-child(${firstIndex + 1}) .switch`);
    await sleep(600);

    const after = await readRows(page);
    assert.deepEqual(after.tops, before.tops, "来回开关两次，行位置仍应回到原样");
    assert.deepEqual(after.heights, before.heights, "来回开关两次，行高仍应不变");
    assert.equal(after.checked[firstIndex], before.checked[firstIndex], "点两次应回到原状态");
  } finally {
    await page.close();
  }
});
