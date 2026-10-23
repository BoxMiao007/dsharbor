/**
 * 前端接缝测试：徽章底色不随垫面漂移、计数微标在深浅两套里都看得清。
 *
 * 只测两个接缝（都是「同一套样式变量在浅色/深色下算出来对不对」这种只有浏览器能说清的事）：
 *  1. 状态徽章（.badge-running / .badge-warn）的底色一律混的是不透明实底，不混 transparent。
 *     混 transparent 时，同一个徽章垫在白卡上（插件卡头）和垫在灰面上（侧栏/工具条）会算出
 *     两种深浅——浅色下实测过 #e2ede9 与 #d3e0de 两个绿。这里直接量同一个类在两个垫面上的
 *     计算底色，要求完全相同；深浅两套都要成立。
 *  2. 可更新计数微标（.plugin-head-actions .btn-badge）用 --accent-fill 做底 + 白字。
 *     深色下 --accent 是浅蓝 #7fb2ff，白字压上去只有 2.16:1（几乎糊掉）；换成 --accent-fill
 *     才够黑。这里按 WCAG 算对比度，深浅两套都要 ≥ 4.5:1。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/badge-color.test.mjs`
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
const PORT = 8213; // 独占端口：log 8207 / switch 8208 / picker 8209 / toolbar 8210 / update 8211 / 本文件 8213
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
 * 打开一页并停在「环境/插件」分区，等插件清单渲染、自动检查更新完成
 * （徽章出现「N 个可更新」）。`state` 拼到 URL 的 ?state= 上覆盖假状态。
 */
async function openPluginPanel(browser, state = null) {
  const url = state ? `${PAGE_URL}?state=${encodeURIComponent(JSON.stringify(state))}` : PAGE_URL;
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-panel-btn="env"]');
  await page.click('[data-panel-btn="env"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#plugin-list .plugin-row").length > 0 &&
      document.querySelector("#plugin-summary").textContent.includes("个可更新"),
    { timeout: 5000 },
  );
  await sleep(200); // 等自动检查更新的结果落进徽章、样式重算完
  return page;
}

/** 读一个元素的计算底色与类名。 */
function readBadge(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { className: el.className, background: cs.backgroundColor, color: cs.color };
  }, selector);
}

/** 读可更新计数微标：底色、字色、字重与可见文本。 */
function readCountBadge(page) {
  return page.evaluate(() => {
    const btn = document.querySelector("#btn-plugin-update-all");
    const badge = btn ? btn.querySelector(".btn-badge") : null;
    if (!badge) return null;
    const cs = getComputedStyle(badge);
    return {
      hidden: badge.classList.contains("hidden"),
      text: badge.textContent,
      background: cs.backgroundColor,
      color: cs.color,
    };
  });
}

/** "rgb(r, g, b)" / "rgba(r, g, b, a)" → [r, g, b]。 */
function parseRgb(value) {
  const m = String(value).match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`看不懂的颜色值：${value}`);
  const [r, g, b] = m[1].split(",").map((part) => Number.parseFloat(part));
  return [r, g, b];
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

/** 把页面切到指定外观（只改 <html data-mode>，界面不重建）。 */
async function applyMode(page, mode) {
  await page.evaluate((next) => {
    document.documentElement.dataset.mode = next;
  }, mode);
  await sleep(120); // 等 CSS 变量重算
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

test("状态徽章底色不随垫面漂移：同样一类在插件卡头与侧栏上算出来同一个色（深浅两套）", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser, { bridgeInstalls: 1 });
  try {
    for (const mode of ["dark", "light"]) {
      await applyMode(page, mode);

      // 侧栏顶部的桥接徽章与插件卡头的摘要徽章都是 .badge-running，但垫在不同容器上。
      const login = await readBadge(page, "#login-badge");
      const summary = await readBadge(page, "#plugin-summary");
      assert.ok(login, `${mode}：应能读到 #login-badge`);
      assert.ok(summary, `${mode}：应能读到 #plugin-summary`);
      assert.match(login.className, /badge-running/, `${mode}：桥接徽章应是运行态（前置假状态没生效？）`);
      assert.match(summary.className, /badge-running/, `${mode}：插件摘要徽章应是运行态`);

      assert.equal(
        login.background,
        summary.background,
        `${mode}：同样一类徽章在不同垫面上应算同一个底色，实测 ${login.background} vs ${summary.background}`,
      );
      // 底色必须不透明——一旦混进 transparent，上面那条「两种深浅」的回归就会重新出现。
      assert.doesNotMatch(login.background, /rgba\(\s*[^)]*,\s*0?\.\d+\s*\)/, `${mode}：徽章底色应不透明`);
    }
  } finally {
    await page.close();
  }
});

test("可更新计数微标：--accent-fill 做底 + 白字，深浅两套对比度都 ≥ 4.5", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    for (const mode of ["dark", "light"]) {
      await applyMode(page, mode);
      const badge = await readCountBadge(page);
      assert.ok(badge, `${mode}：应能读到「全部更新」上的计数微标`);
      assert.equal(badge.hidden, false, `${mode}：有可更新插件时计数微标应显示`);
      assert.match(badge.text.trim(), /^\d+$/, `${mode}：计数微标里应是数字`);

      const ratio = contrast(parseRgb(badge.color), parseRgb(badge.background));
      assert.ok(
        ratio >= 4.5,
        `${mode}：计数微标白字对比度应 ≥ 4.5:1，实测 ${ratio.toFixed(2)}:1（底色 ${badge.background}，字色 ${badge.color}）`,
      );
    }
  } finally {
    await page.close();
  }
});
