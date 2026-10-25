/**
 * 前端接缝测试：方钮忙态的环形 spinner 与完成打勾（#29）。
 *
 * 只测四个「浏览器里才说得清」的接缝：
 *  1. 忙态：方钮里出现居中的环形 spinner（[data-busy-spinner]），它自己在匀速转；
 *     原来那枚语义图标（箭头/刷新这类非旋转对称图形）不再处于旋转状态；aria-busy="true"。
 *  2. 完成：忙态结束且成功 → 先落一个勾（.is-done + .sq-check 可见）约 0.9s，再还原成原图标。
 *  3. 失败：读不到版本列表这类失败直接还原原图标，不打勾（不做错误态图标）。
 *  4. 关动效（html[data-motion="off"]）：环形 spinner 仍静态显示、aria-busy 仍在，
 *     不会退化成「看不出在忙」。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/mock.html）。
 * 跑法：`node --test test/frontend/motion-spinner.test.mjs`
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
const PORT = 8221; // 独占端口:见 AGENTS.md「容易踩的」里的端口表
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

/**
 * 打开一页。`panel` 默认停在「环境/插件」分区（方钮工具条在那里）；传 null 则留在默认的
 * 启动分区（版本行的刷新方钮在那里）。`state` 会拼到 URL 的 ?state= 上（预览台在首轮渲染前
 * 覆盖假状态），`motion` 预置动效偏好（null=保持默认开）。加人工延时的假命令给出确定的忙态窗口。
 */
async function openEnvPanel(browser, { state = null, motion = null, panel = "env" } = {}) {
  const url = state ? `${PAGE_URL}?state=${encodeURIComponent(JSON.stringify(state))}` : PAGE_URL;
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
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-panel-btn="env"]');
  if (panel !== null) {
    await page.click(`[data-panel-btn="${panel}"]`);
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#plugin-list .plugin-row").length > 0 &&
        document.querySelector("#plugin-summary").textContent.includes("个可更新"),
      { timeout: 5000 },
    );
    await sleep(150);
  }
  return page;
}

/** 读一枚方钮的忙态/收尾外观：spinner 元素、旋转中的动画名、原语义图标是否还在转、aria-busy。 */
function readBusyLook(page, sel) {
  return page.evaluate((sel2) => {
    const read = (el) => (el ? window.getComputedStyle(el) : null);
    const btn = document.querySelector(sel2);
    if (!btn) return null;
    const spinner = btn.querySelector("[data-busy-spinner]");
    const check = btn.querySelector(".sq-check");
    const icon = btn.querySelector(".sq-icon svg");
    const spinnerStyle = read(spinner);
    const checkStyle = read(check);
    const iconStyle = read(icon);
    return {
      spinningClass: btn.classList.contains("is-spinning"),
      doneClass: btn.classList.contains("is-done"),
      ariaBusy: btn.getAttribute("aria-busy"),
      hasSpinner: Boolean(spinner),
      spinnerAnim: spinnerStyle ? spinnerStyle.animationName : null,
      spinnerDuration: spinnerStyle ? spinnerStyle.animationDuration : null,
      spinnerOpacity: spinnerStyle ? spinnerStyle.opacity : null,
      spinnerVisibility: spinnerStyle ? spinnerStyle.visibility : null,
      checkOpacity: checkStyle ? checkStyle.opacity : null,
      checkVisibility: checkStyle ? checkStyle.visibility : null,
      iconAnim: iconStyle ? iconStyle.animationName : null,
      iconOpacity: iconStyle ? iconStyle.opacity : null,
      // 矩形：环形应该落在方钮正中（读不到就是 0）。
      spinnerBox: spinner
        ? { x: spinner.getBoundingClientRect().x, y: spinner.getBoundingClientRect().y }
        : null,
    };
  }, sel);
}

const waitSpin = (page, sel, want) =>
  page.waitForFunction(
    (sel2, want2) => Boolean(document.querySelector(sel2)?.classList.contains("is-spinning")) === want2,
    { timeout: 3000 },
    sel,
    want,
  );

let preview;
let browser;

before(async () => {
  preview = await startPreview();
  const puppeteer = require(PUPPETEER_CORE);
  browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: true,
    args: ["--no-sandbox"],
  });
});

after(async () => {
  await browser?.close();
  preview?.kill();
});

test("忙态：方钮换成居中的环形 spinner，原语义图标不再转；aria-busy 落地", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser, { state: { pluginCheckDelay: 600 } });
  try {
    await page.click("#btn-plugin-check-updates");
    await waitSpin(page, "#btn-plugin-check-updates", true);
    await sleep(220); // 等 opacity 过渡走完再量

    const look = await readBusyLook(page, "#btn-plugin-check-updates");
    assert.equal(look.hasSpinner, true, "忙态方钮里应有环形 spinner（[data-busy-spinner]）");
    assert.equal(look.ariaBusy, "true", "忙态应标 aria-busy=\"true\"");
    assert.equal(look.spinnerAnim, "spin-turn", `环形应匀速转，实际 animation-name=${look.spinnerAnim}`);
    assert.notEqual(look.spinnerOpacity, "0", "环形应可见");
    assert.notEqual(look.spinnerVisibility, "hidden", "环形应可见");
    // 关键回归：转的不能再是语义图标本身（非旋转对称图形绕盒子中心转会画圈晃）。
    assert.equal(look.iconAnim, "none", `原语义图标不该再转，实际 animation-name=${look.iconAnim}`);

    // 居中：环形的中心要与方钮中心对齐。
    const centers = await page.evaluate(() => {
      const btn = document.querySelector("#btn-plugin-check-updates").getBoundingClientRect();
      const ring = document.querySelector("#btn-plugin-check-updates [data-busy-spinner]").getBoundingClientRect();
      return {
        dx: Math.abs((btn.x + btn.width / 2) - (ring.x + ring.width / 2)),
        dy: Math.abs((btn.y + btn.height / 2) - (ring.y + ring.height / 2)),
      };
    });
    assert.ok(centers.dx <= 1 && centers.dy <= 1, `环形应居中，偏差 ${centers.dx}/${centers.dy}`);

    await waitSpin(page, "#btn-plugin-check-updates", false);
  } finally {
    await page.close();
  }
});

test("完成：先落一个勾约 0.9s，再还原成原图标", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser, { state: { pluginCheckDelay: 400 } });
  try {
    await page.click("#btn-plugin-check-updates");
    await waitSpin(page, "#btn-plugin-check-updates", true);
    await waitSpin(page, "#btn-plugin-check-updates", false);
    await sleep(200); // 勾的 opacity/scale 收场动画

    const during = await readBusyLook(page, "#btn-plugin-check-updates");
    assert.equal(during.doneClass, true, "成功收尾应先落勾（.is-done）");
    assert.equal(during.checkOpacity, "1", `勾应可见，实际 opacity=${during.checkOpacity}`);
    assert.equal(during.ariaBusy, null, "忙态结束应摘掉 aria-busy");
    assert.equal(during.spinningClass, false, "忙态结束应摘掉 .is-spinning");

    await sleep(900); // 0.9s 到点后还原
    const after = await readBusyLook(page, "#btn-plugin-check-updates");
    assert.equal(after.doneClass, false, "勾停留结束后应撤掉 .is-done");
    assert.notEqual(after.iconOpacity, "0", "还原后原语义图标应重新可见");
    assert.equal(after.checkVisibility, "hidden", "还原后勾应收起");
  } finally {
    await page.close();
  }
});

test("失败：读不到版本列表直接还原、不打勾", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser, {
    state: { registry: null, registryDelay: 300 },
    panel: null,
  });
  try {
    await page.waitForFunction(
      () => !document.querySelector("#npx-versions-refresh").disabled,
      { timeout: 5000 },
    );
    // 这颗方钮在可滚动的左栏里，puppeteer 的几何点击偶尔判「不可点」；直接派发 click
    // 事件即可触发同一条绑定（本测试只关心忙态外观，不关心命中测试）。
    await page.evaluate(() => document.querySelector("#npx-versions-refresh").click());
    await waitSpin(page, "#npx-versions-refresh", true);
    await waitSpin(page, "#npx-versions-refresh", false);

    const after = await readBusyLook(page, "#npx-versions-refresh");
    assert.equal(after.doneClass, false, "失败不该落勾");
    assert.equal(after.ariaBusy, null, "失败后应摘掉 aria-busy");
    assert.notEqual(after.iconOpacity, "0", "失败后应还原原图标");
    assert.equal(after.checkVisibility, "hidden", "失败后不应显示勾");
  } finally {
    await page.close();
  }
});

test("关动效：环形 spinner 静态显示、aria-busy 仍在，仍是静态忙态线索", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser, { state: { pluginCheckDelay: 600 }, motion: "off" });
  try {
    await page.click("#btn-plugin-check-updates");
    await waitSpin(page, "#btn-plugin-check-updates", true);

    const look = await readBusyLook(page, "#btn-plugin-check-updates");
    assert.equal(look.hasSpinner, true, "关动效时环形仍应在");
    assert.equal(look.ariaBusy, "true", "关动效时 aria-busy 仍应保留");
    assert.equal(look.spinnerAnim, "none", `关动效时环形的 animation 应为 none，实际 ${look.spinnerAnim}`);
    assert.match(look.spinnerDuration ?? "", /^0s(,\s*0s)*$/, `关动效时环形时长应为 0s，实际 ${look.spinnerDuration}`);
    assert.notEqual(look.spinnerOpacity, "0", "关动效时环形应静态可见（不会看不出在忙）");
    assert.notEqual(look.spinnerVisibility, "hidden", "关动效时环形应静态可见");
  } finally {
    await page.close();
  }
});

test("全部更新：同一套环形 spinner，成功后打勾", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser, { state: { pluginUpdateDelay: 600 } });
  try {
    await page.click("#btn-plugin-update-all");
    await waitSpin(page, "#btn-plugin-update-all", true);
    const busy = await readBusyLook(page, "#btn-plugin-update-all");
    assert.equal(busy.hasSpinner, true, "「全部更新」忙态也应有环形 spinner");
    assert.equal(busy.ariaBusy, "true", "「全部更新」忙态应标 aria-busy");
    assert.equal(busy.iconAnim, "none", "「全部更新」也不该转语义图标");

    await waitSpin(page, "#btn-plugin-update-all", false);
    await sleep(200);
    const done = await readBusyLook(page, "#btn-plugin-update-all");
    assert.equal(done.doneClass, true, "全部更新成功后应落勾");
    assert.equal(done.checkOpacity, "1", "勾应可见");
  } finally {
    await page.close();
  }
});
