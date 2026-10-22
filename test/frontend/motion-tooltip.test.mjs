/**
 * 前端接缝测试：图标钮的自绘气泡（#30）。
 *
 * 只测「浏览器里才说得清」的接缝——原生 title 换成了纯 CSS 的 ::after 气泡，
 * 靠 transition-delay 做「迟进快出」，这类东西只有真浏览器算得出：
 *  1. 悬停后延迟期内不出现：鼠标移到方钮上约 150ms 时气泡仍不可见。
 *  2. 延迟过后出现：同一位置等到 600ms，气泡淡入（opacity 1、visibility visible）。
 *  3. 移开很快消失：移开后约 150ms 时气泡已不可见（快出，不用再等一整个延迟）。
 *  4. 键盘 Tab 聚焦也出现：:focus-visible 触发同一套气泡。
 *  5. 图标钮已无原生 title：方钮与圆钮都不再带 title，避免和自绘气泡叠成两份提示；
 *     可访问名继续由 aria-label 承担，气泡文案在 data-tip（与 aria-label 一致）。
 *
 * 延迟断言用宽松窗口（约 150ms 查「还没出现」、约 600ms 查「出现了」），不卡精确毫秒，
 * 免得 CI 上的计时抖动把测试抖红。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/mock.html）。
 * 跑法：`node --test test/frontend/motion-tooltip.test.mjs`
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
const PORT = 8217; // 独占端口：log 8207 / switch 8208 / picker 8209 / toolbar 8210 / update 8211 / badge 8213 / danger 8214 / motion 8215 / 本文件 8217
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

/** 新开一页、停在「环境/插件」分区（两枚方钮就在这里），等首帧渲染完。 */
async function openPluginPanel(browser, state = null) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  const url = state ? `${PAGE_URL}?state=${encodeURIComponent(JSON.stringify(state))}` : PAGE_URL;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-panel-btn="env"]');
  await page.click('[data-panel-btn="env"]');
  await page.waitForFunction(() => document.querySelectorAll("#plugin-list .plugin-row").length > 0, { timeout: 5000 });
  await sleep(150); // 等首帧内联脚本与挂载都跑完、样式重算
  return page;
}

/** 读某个按钮气泡（::after）的当前落点：opacity、visibility、文案与按钮属性。 */
function readTip(page, id) {
  return page.evaluate((btnId) => {
    const el = document.getElementById(btnId);
    if (!el) return null;
    const cs = getComputedStyle(el, "::after");
    const r = el.getBoundingClientRect();
    return {
      title: el.getAttribute("title"),
      tip: el.dataset.tip ?? null,
      label: el.getAttribute("aria-label") ?? "",
      opacity: cs.opacity,
      visibility: cs.visibility,
      content: cs.content,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    };
  }, id);
}

/** 把鼠标移到某颗按钮中心。 */
async function hoverCenter(page, id) {
  const box = await page.evaluate((btnId) => {
    const r = document.getElementById(btnId).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await page.mouse.move(box.x, box.y);
  return box;
}

/** 气泡当前是否处于「可见」态（淡入后 opacity 接近 1、visibility visible）。 */
function isShown(tip) {
  return tip && tip.visibility === "visible" && Number.parseFloat(tip.opacity) > 0.5;
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

test("悬停方钮：延迟期内不出现，延迟过后淡入，移开后很快消失", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    const idle = await readTip(page, "btn-plugin-check-updates");
    assert.ok(idle, "应能读到「检查更新」方钮");
    assert.equal(isShown(idle), false, "未悬停时气泡不该出现");

    await hoverCenter(page, "btn-plugin-check-updates");

    // 延迟期（约 150ms）：还没到 380ms 的出场延迟，气泡应仍不出现。
    await sleep(150);
    const early = await readTip(page, "btn-plugin-check-updates");
    assert.equal(isShown(early), false, `悬停约 150ms 时气泡还不该出现（迟进），实际 visibility=${early.visibility} opacity=${early.opacity}`);

    // 过了延迟（约 600ms）：淡入完成，气泡应出现。
    await sleep(450);
    const shown = await readTip(page, "btn-plugin-check-updates");
    assert.equal(isShown(shown), true, `悬停约 600ms 后气泡应已淡入出现，实际 visibility=${shown.visibility} opacity=${shown.opacity}`);
    assert.match(shown.content, /检查更新/, "气泡文案应是「检查更新…」");

    // 移开：只等约 150ms（快出 110ms 足够走完），气泡应已不可见——不用再等一整个延迟。
    await page.mouse.move(10, 10);
    await sleep(150);
    const gone = await readTip(page, "btn-plugin-check-updates");
    assert.equal(isShown(gone), false, `移开约 150ms 后气泡应已消失（快出），实际 visibility=${gone.visibility} opacity=${gone.opacity}`);
  } finally {
    await page.close();
  }
});

test("键盘 Tab 聚焦方钮也出现气泡（:focus-visible）", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    // 先用一次 Tab 进入键盘操作模式（:focus-visible 的判定前提），再把焦点落到方钮上。
    await page.keyboard.press("Tab");
    await page.evaluate(() => document.querySelector("#btn-plugin-check-updates").focus());
    await sleep(50);
    const focusVisible = await page.evaluate(() => document.querySelector("#btn-plugin-check-updates").matches(":focus-visible"));
    assert.equal(focusVisible, true, "键盘聚焦时方钮应命中 :focus-visible");

    await sleep(500); // 过延迟后应淡入
    const shown = await readTip(page, "btn-plugin-check-updates");
    assert.equal(isShown(shown), true, `键盘聚焦约 550ms 后气泡应出现，实际 visibility=${shown.visibility} opacity=${shown.opacity}`);
  } finally {
    await page.close();
  }
});

test("图标钮已无原生 title：气泡文案落在 data-tip，可访问名仍是 aria-label", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    // 方钮（环境/插件卡里的两枚）
    for (const id of ["btn-plugin-check-updates", "btn-plugin-update-all"]) {
      const tip = await readTip(page, id);
      assert.equal(tip.title, null, `${id} 不该再有原生 title（避免和自绘气泡叠成两份提示）`);
      assert.ok(tip.tip && tip.tip.length > 0, `${id} 的 data-tip 应带气泡文案`);
      assert.ok(tip.label && tip.label.length > 0, `${id} 的 aria-label 应保留（可访问名）`);
      // 短气泡以功能名开头（文案是「功能名：补充说明」的形状）。
      assert.ok(tip.tip.startsWith(tip.label), `${id} 的 data-tip 应以 aria-label 的功能名开头，实际「${tip.tip}」`);
    }

    // 圆钮（运行态才出现）：切到运行态，「停止 / 重启」两颗圆钮都不该再有原生 title，
    // 「重启 DSH」的气泡文案应落在 data-tip（运行态里它才显示）。
    const running = await openPluginPanel(browser, { session: "running" });
    try {
      const toggleTitle = await running.evaluate(() => document.getElementById("btn-toggle").getAttribute("title"));
      const restartTitle = await running.evaluate(() => document.getElementById("btn-restart").getAttribute("title"));
      assert.equal(toggleTitle, null, "运行态 #btn-toggle（停止圆钮）不该再有原生 title");
      assert.equal(restartTitle, null, "#btn-restart（重启圆钮）不该再有原生 title");
      const restartTip = await running.evaluate(() => document.getElementById("btn-restart").dataset.tip ?? null);
      const restartLabel = await running.evaluate(() => document.getElementById("btn-restart").getAttribute("aria-label"));
      assert.ok(restartTip && restartTip.length > 0, "#btn-restart 的 data-tip 应带气泡文案");
      assert.equal(restartLabel, restartTip, "#btn-restart 的 aria-label 与 data-tip 应一致（气泡与可访问名同源）");
    } finally {
      await running.close();
    }
  } finally {
    await page.close();
  }
});
