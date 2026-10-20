/**
 * 前端接缝测试：左栏「日志」上的未读数字（票12）。
 *
 * 只测一个接缝——渲染后的左栏条目 `[data-panel-btn="log"]` 里的数字容器 `#log-unread`：
 * 可见性、文案、动画类、条目高度。跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），
 * 不起 Tauri 窗口。
 *
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/log-unread.test.mjs`
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
const PORT = 8207;
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

/** 把 URL 上的假状态预置成想要的场景（预览台支持 ?state=<JSON>）。 */
function urlWithState(state) {
  return `${PAGE_URL}?state=${encodeURIComponent(JSON.stringify(state))}`;
}

/** 打开一页：先定死假状态，再等左栏渲染出来。 */
async function openPage(browser, state) {
  const page = await browser.newPage();
  // 分区选择记在 localStorage 里，同源的所有页共享——不清掉就会把上一个用例的「当前停在日志」
  // 带进来。在页面脚本跑之前抹掉，保证每个用例都从默认分区起手。
  await page.evaluateOnNewDocument(() => {
    try {
      window.localStorage.removeItem("dsharbor.ui.panel");
    } catch {
      // 存储被禁用：本来就存不住。
    }
  });
  await page.goto(urlWithState(state), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-panel-btn="log"]');
  // 首轮 dsh_status 已经渲染过（启动方式分区出现即可认为界面就绪）。
  await page.waitForFunction(() => document.querySelectorAll("[data-panel]").length > 0);
  return page;
}

/** 读一次左栏「日志」条目的样子：数字容器的可见性 / 文案 / 动画类，以及条目高度。 */
function readLogEntry(page) {
  return page.evaluate(() => {
    const item = document.querySelector('[data-panel-btn="log"]');
    const badge = document.querySelector("#log-unread");
    const rect = badge.getBoundingClientRect();
    return {
      panel: document.querySelector('[data-panel-btn][aria-current="true"]').dataset.panelBtn,
      itemHeight: item.getBoundingClientRect().height,
      visible: rect.width > 0 && rect.height > 0,
      text: badge.textContent,
      bumpClass: badge.classList.contains("ico-count-bump"),
      animationName: getComputedStyle(badge).animationName,
    };
  });
}

/** 点工具条主按钮（停止态是「启动 DSH」，运行态是「停止」）。 */
async function clickToggle(page) {
  await page.click("#btn-toggle");
  // 等命令落地 + 一次状态刷新。
  await page.waitForFunction(() => !document.querySelector("#btn-toggle").classList.contains("spinning"), { timeout: 5000 }).catch(() => {});
  await new Promise((done) => setTimeout(done, 150));
}

/** 轮询数字容器的文案，返回「去重后的递增序列」。 */
async function sampleBadgeText(page, durationMs) {
  const seen = [];
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const text = await page.$eval("#log-unread", (el) => el.textContent);
    if (seen[seen.length - 1] !== text) seen.push(text);
    await new Promise((done) => setTimeout(done, 25));
  }
  return seen;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
    defaultViewport: { width: 1240, height: 800 },
  });
});

after(async () => {
  await browser?.close();
  preview?.kill();
});

test("启动动作不再抢画面，未读数按新增行累加到终值", { skip: skipReason }, async () => {
  const page = await openPage(browser, { session: "stopped", counter: 0, freezeLog: true });
  try {
    const beforeClick = await readLogEntry(page);
    assert.equal(beforeClick.panel, "launch", "初始应停在启动方式分区");
    assert.equal(beforeClick.visible, false, "没有未读时数字容器不该出现");
    assert.equal(beforeClick.itemHeight, 44, "条目高度基线是 44px");

    await clickToggle(page);
    // 启动后 mock 的尾巴长到 2 行：不切分区，数字逐个上拍走到 2。
    await sleep(1400);

    const afterClick = await readLogEntry(page);
    assert.equal(afterClick.panel, "launch", "启动后仍应停在启动方式分区");
    assert.equal(afterClick.visible, true, "有未读时数字容器应出现");
    assert.equal(afterClick.text, "2", "未读数按新增行累加到终值");
  } finally {
    await page.close();
  }
});

test("未读数逐个上拍，不做一步跳到终值", { skip: skipReason }, async () => {
  const page = await openPage(browser, { session: "stopped", counter: 0, freezeLog: true });
  try {
    // 多次启停，让一批 12 行一次性落进日志（12 拍 × 90ms ≈ 1.1 秒走完）。
    for (let i = 0; i < 3; i += 1) {
      await clickToggle(page);
      await clickToggle(page);
    }
    await clickToggle(page);

    const seen = await sampleBadgeText(page, 2000);
    const numbers = seen.map((text) => Number(text)).filter((value) => Number.isFinite(value));
    assert.ok(numbers.length >= 3, `应能看到多个中间值，实际只看到 ${JSON.stringify(seen)}`);
    for (let i = 1; i < numbers.length; i += 1) {
      assert.ok(numbers[i] > numbers[i - 1], `数字必须严格递增，实际 ${JSON.stringify(seen)}`);
    }

    await sleep(600);
    const settled = await readLogEntry(page);
    assert.equal(settled.visible, true, "走完后数字仍在");
    assert.equal(Number(settled.text), numbers[numbers.length - 1], "终值不再变化");
    assert.ok(settled.bumpClass, "数字变化时带弹动动画类");
  } finally {
    await page.close();
  }
});

test("点进日志分区即归零并隐藏数字", { skip: skipReason }, async () => {
  const page = await openPage(browser, { session: "stopped", counter: 0, freezeLog: true });
  try {
    await clickToggle(page);
    await sleep(1400);
    assert.equal((await readLogEntry(page)).visible, true, "先攒出未读");

    await page.click('[data-panel-btn="log"]');
    await sleep(120);

    const afterOpen = await readLogEntry(page);
    assert.equal(afterOpen.panel, "log", "应切到日志分区");
    assert.equal(afterOpen.visible, false, "点进日志后数字隐藏");
    assert.equal(afterOpen.text, "", "归零后不显示数字");
  } finally {
    await page.close();
  }
});

test("停在日志分区期间新日志不计未读", { skip: skipReason }, async () => {
  const page = await openPage(browser, { session: "stopped", counter: 0, freezeLog: false });
  try {
    await page.click('[data-panel-btn="log"]');
    await sleep(120);

    await clickToggle(page);
    // 运行中日志每秒长一行：等两拍，这期间产生的行都不该计未读。
    await sleep(2200);

    const entry = await readLogEntry(page);
    assert.equal(entry.panel, "log", "仍停在日志分区");
    assert.equal(entry.visible, false, "停在日志页时数字保持隐藏");
  } finally {
    await page.close();
  }
});

test("首段历史尾巴不产生未读", { skip: skipReason }, async () => {
  // 一开窗后端就有一堆历史输出：整段历史尾巴算「已读」，不许冒未读。
  const page = await openPage(browser, { session: "running", counter: 8, freezeLog: true });
  try {
    await sleep(1400);
    const entry = await readLogEntry(page);
    assert.equal(entry.panel, "launch", "初始停在启动方式分区");
    assert.equal(entry.visible, false, "整段历史尾巴不该产生未读");
  } finally {
    await page.close();
  }
});

test("清空日志后重新落回的那段尾巴不算未读", { skip: skipReason }, async () => {
  // 清空会把「上一轮尾巴」抹成 null，下一次同步走的是「整段历史」分支；紧接着切走分区，
  // 那一段重新落回日志的历史行不该把数字抬起来（清空本身也不动计数）。
  const page = await openPage(browser, { session: "running", counter: 8, freezeLog: true });
  try {
    await sleep(1200);
    await page.click('[data-panel-btn="log"]');
    await sleep(120);
    await page.click("#btn-clear-log");
    // 不等下一次轮询（每秒一次）就切走：同步会在「启动方式」分区里跑那一段历史分支。
    await page.click('[data-panel-btn="launch"]');
    await sleep(1600);

    const entry = await readLogEntry(page);
    assert.equal(entry.panel, "launch", "已切回启动方式分区");
    assert.equal(entry.visible, false, "清空后重新落回的历史行不产生未读");
  } finally {
    await page.close();
  }
});

test("数字出现前后条目高度都保持 44px", { skip: skipReason }, async () => {
  const page = await openPage(browser, { session: "stopped", counter: 0, freezeLog: true });
  try {
    const beforeClick = await readLogEntry(page);
    await clickToggle(page);
    await sleep(1400);
    const afterClick = await readLogEntry(page);
    assert.equal(beforeClick.visible, false);
    assert.equal(afterClick.visible, true);
    assert.equal(beforeClick.itemHeight, 44, "没有数字时条目高 44px");
    assert.equal(afterClick.itemHeight, 44, "有数字时条目仍是 44px，不推挤相邻条目");
  } finally {
    await page.close();
  }
});

test("prefers-reduced-motion 下不做弹动", { skip: skipReason }, async () => {
  const page = await openPage(browser, { session: "stopped", counter: 0, freezeLog: true });
  try {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await clickToggle(page);
    await sleep(1400);
    const entry = await readLogEntry(page);
    assert.equal(entry.visible, true, "数字照常出现");
    assert.equal(entry.animationName, "none", "减少动态效果时不做弹动");
  } finally {
    await page.close();
  }
});
