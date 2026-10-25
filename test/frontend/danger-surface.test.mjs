/**
 * 前端接缝测试：删除浮窗「卡中卡」拆层与纯色危险面、深色下卡片层次。
 *
 * 只测两个接缝（都是「同一套样式变量在浅色/深色下算出来对不对」这种只有浏览器能说清的事）：
 *  1. 删除确认浮窗（.modal.modal-danger）：
 *     - 内层 #profile-manage-confirm 不再自成一格——原先它带边框+淡底+内边距，在红浮窗里套出
 *       「卡中卡」；现在应无边框、无底、无内边距、无圆角。
 *     - 浮窗底色是不掺主题底色的纯色（深浅各自一套、不透明），不再是「主题卡底混一点红」。
 *     - 确认文字与下方动作按钮（.modal-foot）左右两端对齐（原先内层框自带 padding，文字比按钮
 *       内缩一截，左右都不齐）。
 *     - 文字对比度在两套外观下都 ≥ 4.5:1。
 *  2. 深色下卡片分得开：
 *     - 深色 .block 的发丝轮廓比浅色更亮（深色里卡片和页面都是近黑，55%×--line 只剩 4% 白，
 *       边界几乎看不见，深色改用 --line-strong 提亮一档）。
 *     - 深色 .block 的柔和阴影多一道 inset 顶部高光（黑压黑的阴影叠不出层次，靠内高光把卡片顶上沿照亮）。
 * 浅色保持原样，不因这次改动回退。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/danger-surface.test.mjs`
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
const PORT = 8214; // 独占端口:见 AGENTS.md「容易踩的」里的端口表
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

/** 打开一页并停在「环境/插件」分区，等环境卡渲染出来。 */
async function openEnvPanel(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-panel-btn="env"]');
  await page.click('[data-panel-btn="env"]');
  await page.waitForSelector(".env-card", { timeout: 5000 });
  await sleep(150);
  return page;
}

/** 从 desktop 环境的三点菜单打开「删除」浮窗（desktop 在假数据里可删）。 */
async function openDeleteModal(page) {
  await page.click('[data-env-more="desktop"]');
  await page.waitForSelector('#env-menu [data-env-act="delete"]', { visible: true, timeout: 4000 });
  await page.click('#env-menu [data-env-act="delete"]');
  await page.waitForSelector("#modal-name:not(.hidden)", { timeout: 4000 });
  await sleep(150);
}

/** 把页面切到指定外观（只改 <html data-mode>，界面不重建）。 */
async function applyMode(page, mode) {
  await page.evaluate((next) => {
    document.documentElement.dataset.mode = next;
  }, mode);
  await sleep(120); // 等 CSS 变量重算
}

/** 读删除浮窗的布局与颜色：浮窗底色/边框、内层确认行的盒模型、文字与动作按钮的左右边。 */
function readDeleteModal(page) {
  return page.evaluate(() => {
    const modal = document.querySelector("#modal-name");
    const confirm = document.querySelector("#profile-manage-confirm");
    const text = document.querySelector("#profile-manage-confirm-text");
    const foot = modal.querySelector(".modal-foot");
    const cs = getComputedStyle(modal);
    const cc = getComputedStyle(confirm);
    const rect = (el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    };
    return {
      isDanger: modal.classList.contains("modal-danger"),
      modalBackground: cs.backgroundColor,
      modalBorder: cs.borderTopColor,
      confirm: {
        borderWidth: cc.borderTopWidth,
        background: cc.backgroundColor,
        padding: cc.padding,
        radius: cc.borderRadius,
      },
      textColor: getComputedStyle(text).color,
      rects: { text: rect(text), foot: rect(foot) },
    };
  });
}

/** 读某个元素的计算底色、上边框色与阴影。 */
function readBox(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { background: cs.backgroundColor, borderTop: cs.borderTopColor, shadow: cs.boxShadow };
  }, selector);
}

/** "rgb(r, g, b)" / "rgba(r, g, b, a)" / "color(srgb r g b / a)" → { rgb:[0..255], alpha }。
 *  现代 Chromium 对 color-mix() 的计算结果会序列化成 color(srgb …)（各通道 0..1），
 *  发丝轮廓就是用 color-mix 算出来的，必须一起认。 */
function parseRgba(value) {
  const text = String(value);
  const legacy = text.match(/rgba?\(([^)]+)\)/);
  if (legacy) {
    const parts = legacy[1].split(",").map((p) => Number.parseFloat(p));
    return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
  }
  const modern = text.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
  if (modern) {
    const rgb = [1, 2, 3].map((i) => Number.parseFloat(modern[i]) * 255);
    return { rgb, alpha: modern[4] === undefined ? 1 : Number.parseFloat(modern[4]) };
  }
  throw new Error(`看不懂的颜色值：${value}`);
}

/** WCAG 相对亮度。 */
function luminance([r, g, b]) {
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/** WCAG 对比度。 */
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
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

test("删除浮窗：内层不再「卡中卡」、底色是纯色、文字与按钮左右对齐（深浅两套）", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser);
  try {
    const backgrounds = {};
    for (const mode of ["dark", "light"]) {
      await applyMode(page, mode);
      await openDeleteModal(page);
      const info = await readDeleteModal(page);
      assert.ok(info.isDanger, `${mode}：删除浮窗应带 modal-danger`);
      await page.keyboard.press("Escape"); // 关掉浮窗，下一轮重新打开量当前外观
      await page.waitForSelector("#modal-name", { hidden: true, timeout: 2000 });

      // 内层确认行：无边框、无底、无内边距、无圆角——不再叠一层小卡。
      assert.equal(info.confirm.borderWidth, "0px", `${mode}：内层确认行不应有边框`);
      assert.equal(info.confirm.background, "rgba(0, 0, 0, 0)", `${mode}：内层确认行不应有底色，实测 ${info.confirm.background}`);
      assert.equal(info.confirm.padding, "0px", `${mode}：内层确认行不应有内边距`);
      assert.equal(info.confirm.radius, "0px", `${mode}：内层确认行不应有圆角`);

      // 浮窗底色是纯色：不透明、不带 alpha（不再混 transparent / 主题卡底）。
      const bg = parseRgba(info.modalBackground);
      assert.equal(bg.alpha, 1, `${mode}：危险浮窗底色应是不透明纯色，实测 ${info.modalBackground}`);
      backgrounds[mode] = info.modalBackground;

      // 确认文字与动作按钮左右两端对齐。
      const { text, foot } = info.rects;
      assert.ok(Math.abs(text.left - foot.left) <= 1, `${mode}：文字左缘应与按钮左缘对齐（${text.left} vs ${foot.left}）`);
      assert.ok(Math.abs(text.right - foot.right) <= 1, `${mode}：文字右缘应与按钮右缘对齐（${text.right} vs ${foot.right}）`);

      // 文字压危险底要够清楚。
      const ratio = contrast(parseRgba(info.textColor).rgb, bg.rgb);
      assert.ok(ratio >= 4.5, `${mode}：危险面文字对比度应 ≥ 4.5:1，实测 ${ratio.toFixed(2)}:1（字 ${info.textColor} 底 ${info.modalBackground}）`);
    }
    // 两套外观各是各自的纯色（深色深红、浅色浅红），不是一个值混出来的。
    assert.notEqual(backgrounds.dark, backgrounds.light, "深色与浅色应有各自的危险面纯色");
  } finally {
    await page.close();
  }
});

test("深色卡片分得开：发丝轮廓比浅色更亮、柔和阴影含顶部内高光（浅色保持原样）", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser);
  try {
    const boxes = {};
    for (const mode of ["dark", "light"]) {
      await applyMode(page, mode);
      const block = await readBox(page, ".block");
      assert.ok(block, `${mode}：应能读到主卡 .block`);
      boxes[mode] = block;
    }

    const darkBorder = parseRgba(boxes.dark.borderTop);
    const lightBorder = parseRgba(boxes.light.borderTop);
    assert.ok(
      darkBorder.alpha > lightBorder.alpha,
      `深色发丝轮廓应比浅色更亮：深色 alpha ${darkBorder.alpha} 应 > 浅色 ${lightBorder.alpha}`,
    );

    assert.match(boxes.dark.shadow, /inset/, `深色柔和阴影应含 inset 顶部内高光，实测 ${boxes.dark.shadow}`);
    assert.doesNotMatch(boxes.light.shadow, /inset/, `浅色柔和阴影不应含 inset（保持原样），实测 ${boxes.light.shadow}`);
  } finally {
    await page.close();
  }
});
