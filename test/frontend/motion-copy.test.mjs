/**
 * 前端接缝测试：复制按钮的完整反馈（#35）。
 *
 * 覆盖工单验收里「浏览器里才说得清」的几条：
 *  1. 点下去进入「已复制」态：按钮挂 .copied，文案层当前行换成「已复制」（图标换 .i-check 由 CSS 驱动）。
 *  2. 换文案时按钮宽度不变（比较切换前后的 getBoundingClientRect().width，容差 1px）。
 *  3. 约 1.4s 后自动复原（轮询等待，不写死 sleep）。
 *  4. 存在视觉隐藏的 role="status"，且点完就把结果写进去；复原后清空。
 *  5. 复制失败时按钮内换成「复制失败」（不再依赖 toast）。
 *  6. data-motion="off" 下反馈同样可见（瞬时切换、不靠动画）。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 预览台给 navigator.clipboard 装了必定成功的替身，测试要验失败态时就地覆写 writeText。
 *
 * 前置：先 `pnpm build`（预览台读 dist/mock.html）。
 * 跑法：`node --test test/frontend/motion-copy.test.mjs`
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
const PORT = 8223; // 独占端口：…8211 / notice-hint 8212 / …8214 / motion-pref 8215 / 本文件 8223
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

/** 新开一页、停到指定分区，并把动效偏好预置成 `motion`（null=清掉，模拟从没存过）。 */
async function openPanel(browser, panel, motion = null) {
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
  await page.waitForSelector(`[data-panel-btn="${panel}"]`);
  await page.click(`[data-panel-btn="${panel}"]`);
  await sleep(150); // 等首帧内联脚本与挂载都跑完、样式重算
  return page;
}

/** 读一颗复制按钮的可见状态快照。 */
function readCopyState(page, selector) {
  return page.evaluate((sel) => {
    const btn = document.querySelector(sel);
    if (!btn) return null;
    const text = (sub) => btn.querySelector(`.copy-txt ${sub}`)?.textContent?.trim() ?? null;
    const txt = btn.querySelector(".copy-txt");
    return {
      width: btn.getBoundingClientRect().width,
      copied: btn.classList.contains("copied"),
      failed: btn.classList.contains("copy-failed"),
      cur: text(".t-cur"),
      next: text(".t-next"),
      fail: text(".t-fail"),
      // 文案层当前实际露出来的是哪一行：拿 t-next/t-fail 的透明度当信号。
      shown: btn.classList.contains("copied")
        ? "已复制"
        : btn.classList.contains("copy-failed")
          ? "复制失败"
          : "常态",
      txtHeight: txt ? txt.getBoundingClientRect().height : null,
      // 图标叠层：两颗都在 DOM 里，靠透明度切换。
      iconViews: Array.from(btn.querySelectorAll(".copy-ico svg")).map((svg) => ({
        cls: svg.getAttribute("class"),
        opacity: Number(getComputedStyle(svg).opacity),
      })),
      ariaLabel: btn.getAttribute("aria-label"),
    };
  }, selector);
}

/** 视觉隐藏的播报区：必须存在、role=status、且真的不在视觉里（1px + clip）。 */
function readStatus(page) {
  return page.evaluate(() => {
    const el = document.querySelector("#copy-status");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      role: el.getAttribute("role"),
      text: el.textContent ?? "",
      width: el.getBoundingClientRect().width,
      height: el.getBoundingClientRect().height,
      position: cs.position,
      clip: cs.clip,
      overflow: cs.overflow,
    };
  });
}

/** 点一颗按钮并等它进入反馈态。 */
async function clickAndWait(page, selector, state) {
  await page.click(selector);
  await page.waitForFunction(
    (sel, want) => document.querySelector(sel)?.classList.contains(want),
    { timeout: 3000 },
    selector,
    state,
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

test("日志「复制日志」：点后进入已复制态，宽度不变，1.4s 后复原", { skip: skipReason }, async () => {
  const page = await openPanel(browser, "log");
  try {
    await page.waitForSelector("#btn-copy-log.copy-btn");
    const before = await readCopyState(page, "#btn-copy-log");
    assert.equal(before.copied, false, "初始不该是已复制态");
    assert.equal(before.cur, "复制日志", "常态文案应是「复制日志」");
    assert.equal(before.shown, "常态");

    await clickAndWait(page, "#btn-copy-log", "copied");
    const after1 = await readCopyState(page, "#btn-copy-log");
    assert.equal(after1.shown, "已复制", "点后应切到「已复制」那行");
    // 图标叠层真的换过：复制形淡出、勾淡入（透明度是过渡终点，等过渡跑完再读）。
    await sleep(320);
    const mid = await readCopyState(page, "#btn-copy-log");
    const copySvg = mid.iconViews.find((v) => v.cls === "i-copy");
    const checkSvg = mid.iconViews.find((v) => v.cls === "i-check");
    assert.ok(copySvg && checkSvg, "图标叠层应同时含 .i-copy 与 .i-check");
    assert.ok(copySvg.opacity < 0.05, `.i-copy 应已淡出，实测 opacity=${copySvg.opacity}`);
    assert.ok(checkSvg.opacity > 0.95, `.i-check 应已现出，实测 opacity=${checkSvg.opacity}`);

    // 宽度切换前后不变（含成功态的底色/边框变化也不能撑宽）。
    assert.ok(
      Math.abs(after1.width - before.width) <= 1,
      `切换文案时按钮宽度应不变：前 ${before.width} / 后 ${after1.width}`,
    );

    // 约 1.4s 后复原（轮询，不写死）。
    await page.waitForFunction(
      () => !document.querySelector("#btn-copy-log")?.classList.contains("copied"),
      { timeout: 4000, polling: 100 },
    );
    const back = await readCopyState(page, "#btn-copy-log");
    assert.equal(back.shown, "常态", "1.4s 后应复原成常态");
    assert.ok(Math.abs(back.width - before.width) <= 1, "复原后宽度仍应与初始一致");
  } finally {
    await page.close();
  }
});

test("播报区：视觉隐藏的 role=status，点后写入结果，复原后清空", { skip: skipReason }, async () => {
  const page = await openPanel(browser, "log");
  try {
    await page.waitForSelector("#btn-copy-log.copy-btn");
    const idle = await readStatus(page);
    assert.ok(idle, "应存在 #copy-status 播报区");
    assert.equal(idle.role, "status", "播报区应是 role=status");
    assert.equal(idle.text, "", "初始播报区应为空");
    // 视觉隐藏：1px 见方 + 绝对定位 + clip（不是 display:none，读屏仍可读）。
    assert.ok(idle.width <= 1.5 && idle.height <= 1.5, `播报区应视觉隐藏，实测 ${idle.width}×${idle.height}`);
    assert.equal(idle.position, "absolute");
    assert.match(idle.clip, /rect\(0(px)?[, ]+0(px)?[, ]+0(px)?[, ]+0(px)?\)/);

    await clickAndWait(page, "#btn-copy-log", "copied");
    const said = await readStatus(page);
    assert.equal(said.text, "已复制", "点成功后应播报「已复制」");

    await page.waitForFunction(
      () => (document.querySelector("#copy-status")?.textContent ?? "") === "",
      { timeout: 4000, polling: 100 },
    );
  } finally {
    await page.close();
  }
});

test("三处调用点走同一套反馈：集成分区的「手动命令」「垫片内容」", { skip: skipReason }, async () => {
  const page = await openPanel(browser, "integ");
  try {
    // 垫片按钮住在默认收起的 <details> 里，先展开再量宽度、再点。
    const shimSelector = "#btn-cli-copy-shim";
    await page.evaluate((sel) => {
      document.querySelector(sel)?.closest("details")?.setAttribute("open", "");
    }, shimSelector);
    await sleep(120);

    for (const sel of ["#btn-cli-copy", shimSelector]) {
      const before = await readCopyState(page, sel);
      assert.ok(before, `应能读到 ${sel}`);
      assert.equal(before.copied, false, `${sel} 初始不该是已复制态`);
      await clickAndWait(page, sel, "copied");
      const after = await readCopyState(page, sel);
      assert.equal(after.shown, "已复制", `${sel} 点后应切到「已复制」`);
      assert.ok(
        Math.abs(after.width - before.width) <= 1,
        `${sel} 宽度应不变：前 ${before.width} / 后 ${after.width}`,
      );
      await page.waitForFunction(
        (s) => !document.querySelector(s)?.classList.contains("copied"),
        { timeout: 4000, polling: 100 },
        sel,
      );
    }
  } finally {
    await page.close();
  }
});

test("复制失败：按钮内换成「复制失败」，同样自动复原", { skip: skipReason }, async () => {
  const page = await openPanel(browser, "log");
  try {
    await page.waitForSelector("#btn-copy-log.copy-btn");
    // 覆写预览台给的替身，让这次复制必定失败（writeText 抛错 → 兜底 execCommand 也拿不到文本）。
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("mock: clipboard denied");
          },
        },
      });
      document.execCommand = () => false;
    });
    const before = await readCopyState(page, "#btn-copy-log");
    await clickAndWait(page, "#btn-copy-log", "copy-failed");
    const after = await readCopyState(page, "#btn-copy-log");
    assert.equal(after.shown, "复制失败", "失败时应切到「复制失败」那行");
    assert.equal(after.copied, false, "失败态不应同时带 .copied");
    assert.ok(
      Math.abs(after.width - before.width) <= 1,
      `失败态宽度也应不变：前 ${before.width} / 后 ${after.width}`,
    );
    const said = await readStatus(page);
    assert.equal(said.text, "复制失败", "失败也应播报「复制失败」");

    await page.waitForFunction(
      () => !document.querySelector("#btn-copy-log")?.classList.contains("copy-failed"),
      { timeout: 4000, polling: 100 },
    );
    const back = await readCopyState(page, "#btn-copy-log");
    assert.equal(back.shown, "常态", "失败态 1.4s 后也应复原");
  } finally {
    await page.close();
  }
});

test("登录链接（打开方式=复制）也用同一套反馈", { skip: skipReason }, async () => {
  const page = await openPanel(browser, "log");
  try {
    // 打开方式选「复制登录链接」，并启动会话让按钮获得可点的登录链接。
    await page.evaluate(() => window.localStorage.setItem("dsharbor.ui.openMode", "copy"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-toggle");
    await page.click("#btn-toggle");
    await page.waitForFunction(() => document.querySelector("#btn-open")?.disabled === false, { timeout: 4000 });
    const before = await readCopyState(page, "#btn-open");
    assert.ok(before, "应能读到 #btn-open");
    assert.ok(before.cur === "复制登录链接", `复制方式下常态文案应是「复制登录链接」，实测 ${before.cur}`);
    await clickAndWait(page, "#btn-open", "copied");
    const after = await readCopyState(page, "#btn-open");
    assert.equal(after.shown, "已复制", "点后应切到「已复制」");
    assert.ok(
      Math.abs(after.width - before.width) <= 1,
      `主按钮宽度应不变：前 ${before.width} / 后 ${after.width}`,
    );
    await page.waitForFunction(
      () => !document.querySelector("#btn-open")?.classList.contains("copied"),
      { timeout: 4000, polling: 100 },
    );
  } finally {
    await page.close();
  }
});

test("登录链接复制失败：按钮内红态之外，也补一条 error toast（与另外三颗一致）", { skip: skipReason }, async () => {
  const page = await openPanel(browser, "log");
  try {
    await page.evaluate(() => window.localStorage.setItem("dsharbor.ui.openMode", "copy"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-toggle");
    await page.click("#btn-toggle");
    await page.waitForFunction(() => document.querySelector("#btn-open")?.disabled === false, { timeout: 4000 });

    // 让这次复制必定失败：writeText 抛错，兜底 execCommand 也拿不到文本。
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("mock: clipboard denied");
          },
        },
      });
      document.execCommand = () => false;
    });

    await clickAndWait(page, "#btn-open", "copy-failed");
    const after = await readCopyState(page, "#btn-open");
    assert.equal(after.shown, "复制失败", "失败时按钮内应切到「复制失败」那行");

    // 除了按钮内红态，还要有一条 error toast——否则这颗按钮与另外三颗表现不一致。
    await page.waitForSelector("#toasts .toast:not(.is-leaving)", { timeout: 4000 });
    const toast = await page.evaluate(() => {
      const el = document.querySelector("#toasts .toast:not(.is-leaving)");
      return {
        text: (el?.querySelector(".toast-body")?.textContent ?? "").trim(),
        kind: el?.dataset.kind ?? null,
      };
    });
    assert.match(toast.text, /复制失败/, `toast 文案应说明复制失败，实际「${toast.text}」`);
    assert.equal(toast.kind, "error", `失败回执语气应是 error，实际 ${toast.kind}`);
  } finally {
    await page.close();
  }
});

test("data-motion=off 下反馈同样可见（瞬时切换，不靠动画）", { skip: skipReason }, async () => {
  const page = await openPanel(browser, "log", "off");
  try {
    await page.waitForSelector("#btn-copy-log.copy-btn");
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-motion")), "off");
    const before = await readCopyState(page, "#btn-copy-log");
    await clickAndWait(page, "#btn-copy-log", "copied");
    const after = await readCopyState(page, "#btn-copy-log");
    assert.equal(after.shown, "已复制", "关动效后仍应切到「已复制」");
    assert.ok(
      Math.abs(after.width - before.width) <= 1,
      `关动效后宽度也应不变：前 ${before.width} / 后 ${after.width}`,
    );
    // 瞬时：过渡时长被压平后，勾应立刻可见（不需要等 200ms）。
    const checkSvg = after.iconViews.find((v) => v.cls === "i-check");
    assert.ok(checkSvg && checkSvg.opacity > 0.95, "关动效后勾应立即可见（不靠动画）");

    await page.waitForFunction(
      () => !document.querySelector("#btn-copy-log")?.classList.contains("copied"),
      { timeout: 4000, polling: 100 },
    );
  } finally {
    await page.close();
  }
});
