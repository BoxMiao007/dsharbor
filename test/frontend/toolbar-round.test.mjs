/**
 * 前端接缝测试：顶栏「停止 / 重启 DSH」的圆形图标钮。
 *
 * 只测这一个接缝——运行态与停止态下 `#btn-toggle`、`#btn-restart` 的形状与可见性：
 *  1. 运行态：两颗都是圆形图标钮（宽 = 高、`border-radius: 50%`），圆钮里没有可见文字，
 *     名字只靠 aria-label、操作说明走自绘气泡（data-tip）；「停止」是实心方块图标，且描边在场
 *     （悬停闪动的空心那半拍只有描边能留下轮廓，stroke: none 时那一拍方块会整个消失）。
 *  2. 停止态：只剩蓝色长条「启动 DSH」，「重启 DSH」必须真的不显示（rect 为 0×0）。
 *     这条是回归点：`.round` 的 `display: grid` 曾用 ID 选择器写成 (1,0,0)，
 *     压过 99-hidden.css 里 `.hidden` 的 (0,1,0)，停止态两颗按钮一起露出来。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/toolbar-round.test.mjs`
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
const PORT = 8210;
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

/** 打开一页并把假状态定死（预览台支持 ?state=<JSON>）。 */
async function openPage(browser, state) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  await page.goto(`${PAGE_URL}?state=${encodeURIComponent(JSON.stringify(state))}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#btn-toggle");
  // 首轮 dsh_status 渲染完再量（渲染后按钮形态才定）。
  await page.waitForFunction(() => document.querySelectorAll("[data-panel]").length > 0);
  await sleep(150);
  return page;
}

/** 量一颗按钮：可见性、矩形、圆角、圆钮里有没有可见文字、图标自身的填充与描边。 */
function readButton(page, id) {
  return page.evaluate((btnId) => {
    const el = document.getElementById(btnId);
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const texts = Array.from(el.querySelectorAll(".btn-text, .text-window")).map((t) => ({
      text: t.textContent.trim(),
      width: t.getBoundingClientRect().width,
    }));
    const svg = el.querySelector("svg");
    const svgStyle = svg ? getComputedStyle(svg) : null;
    return {
      className: el.className,
      visible: rect.width > 0 && rect.height > 0,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      radius: style.borderRadius,
      background: style.backgroundColor,
      label: el.getAttribute("aria-label") ?? "",
      title: el.getAttribute("title") ?? "",
      tip: el.getAttribute("data-tip") ?? "",
      ariaBusy: el.getAttribute("aria-busy") ?? "",
      /* 「启动中」那只细环：有它就说明走的是过渡态而不是停止态长条。 */
      spin: el.querySelectorAll(".launch-spin").length,
      texts,
      svgRect: svg
        ? (() => {
            const r = svg.getBoundingClientRect();
            return { width: Math.round(r.width), height: Math.round(r.height) };
          })()
        : null,
      svgFill: svgStyle?.fill ?? null,
      svgStroke: svgStyle?.stroke ?? null,
      svgStrokeWidth: svgStyle?.strokeWidth ?? null,
    };
  }, id);
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

test("运行态：停止与重启都是圆形图标钮，钮里没有文字", { skip: skipReason }, async () => {
  const page = await openPage(browser, { session: "running" });
  try {
    const stop = await readButton(page, "btn-toggle");
    const restart = await readButton(page, "btn-restart");

    for (const [name, btn] of [["停止", stop], ["重启 DSH", restart]]) {
      assert.equal(btn.visible, true, `运行态「${name}」应可见`);
      assert.equal(btn.radius, "50%", `「${name}」应是圆钮`);
      assert.equal(btn.width, btn.height, `「${name}」宽高应相等（正圆），实际 ${btn.width}×${btn.height}`);
      const visibleText = btn.texts.filter((t) => t.width > 0 && t.text.length > 0);
      assert.deepEqual(visibleText, [], `「${name}」圆钮里不该有可见文字，实际 ${JSON.stringify(btn.texts)}`);
      assert.ok(btn.svgRect && btn.svgRect.width > 0, `「${name}」应有图标`);
    }

    // 圆钮没有可见文字：可访问名靠 aria-label，操作说明走自绘气泡（data-tip），不再用原生 title。
    assert.match(stop.label, /停止/, "停止钮的 aria-label 应说明这是「停止」");
    assert.equal(stop.title, "", "停止钮不该再有原生 title（改用自绘气泡 data-tip）");
    assert.match(stop.tip, /停止/, "停止钮的 data-tip 气泡应说明这是「停止」");
    assert.equal(restart.label, "重启 DSH");
    assert.equal(restart.title, "", "重启钮不该再有原生 title（改用自绘气泡 data-tip）");
    assert.match(restart.tip, /重启/, "重启钮的 data-tip 气泡应说明这是「重启 DSH」");

    // 回归点：悬停闪动的空心那半拍只靠描边留下方框轮廓。stroke 若退回 none，
    // 那一拍整个方块会消失（填充分与描边分同时为「无」），看上去像图标没了。
    assert.notEqual(stop.svgFill, "none", "停止图标常态应是实心（fill 跟随 currentColor）");
    assert.notEqual(stop.svgStroke, "none", "停止图标必须带描边，空心那半拍才有轮廓");
    assert.ok(
      Number.parseFloat(stop.svgStrokeWidth) > 0,
      `停止图标的描边宽度应大于 0，实际 ${stop.svgStrokeWidth}`,
    );
  } finally {
    await page.close();
  }
});

test("停止态：只剩「启动 DSH」，「重启 DSH」真的不显示", { skip: skipReason }, async () => {
  const page = await openPage(browser, { session: "stopped" });
  try {
    const toggle = await readButton(page, "btn-toggle");
    const restart = await readButton(page, "btn-restart");

    assert.equal(toggle.visible, true, "停止态应看到「启动 DSH」");
    assert.notEqual(toggle.radius, "50%", "停止态是长条按钮，不是圆钮");
    assert.ok(
      toggle.texts.some((t) => t.text.includes("启动")),
      `停止态按钮里应有「启动 DSH」文字，实际 ${JSON.stringify(toggle.texts)}`,
    );

    // 回归点：`.round` 的 display 用过 ID 特指度，把 .hidden 顶掉后这颗钮会一直露出来。
    assert.equal(restart.visible, false, "停止态「重启 DSH」必须隐藏（0×0）");
    assert.equal(restart.className.includes("hidden"), true, "停止态「重启 DSH」应带 .hidden");
  } finally {
    await page.close();
  }
});

test("启动中：同一根长条换成「启动中…」+ 细环，重启仍不出现，尺寸与停止态一致", { skip: skipReason }, async () => {
  // 启动中 = 进程起来了、登录链接还没就绪（isStarting）。假后端用 loginPending 造这个态。
  const page = await openPage(browser, { session: "running", loginPending: true });
  try {
    const busy = await readButton(page, "btn-toggle");
    const restart = await readButton(page, "btn-restart");
    const stoppedWidth = 127; // --btn-w

    assert.equal(busy.visible, true, "启动中应看到按钮");
    assert.ok(busy.className.includes("busy"), `启动中应挂 .busy，实际 ${busy.className}`);
    assert.equal(busy.className.includes("round"), false, "启动中不该变圆钮（圆钮是运行态）");
    assert.notEqual(busy.radius, "50%", "启动中仍是长条按钮");
    assert.ok(
      busy.texts.some((t) => t.text.includes("启动中")),
      `启动中应显示「启动中…」，实际 ${JSON.stringify(busy.texts)}`,
    );
    assert.equal(busy.spin, 1, "启动中应有一只 .launch-spin 细环");
    assert.equal(busy.ariaBusy, "true", "启动中应给读屏 aria-busy=true");
    assert.match(busy.label, /停止/, `启动中的可访问名应说明还能点成停止，实际「${busy.label}」`);
    // 尺寸与停止态一致：形态切换不许让整排按钮跳位。
    assert.equal(busy.width, stoppedWidth, `启动中宽度应与停止态一致（${stoppedWidth}px），实际 ${busy.width}`);
    assert.equal(busy.height, 34, `启动中高度应为 --btn-h，实际 ${busy.height}`);

    // 关键回归点：登录链接没就绪之前，「重启 DSH」不能提前蹦出来。
    assert.equal(restart.visible, false, "启动中「重启 DSH」必须仍隐藏（0×0）");
    assert.equal(restart.className.includes("hidden"), true, "启动中「重启 DSH」应带 .hidden");
  } finally {
    await page.close();
  }
});
