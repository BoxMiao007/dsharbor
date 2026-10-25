/**
 * 前端接缝测试：插件行的右键跨环境搬运 + 换环境后更新进度不丢。
 *
 * 只测两个接缝：
 *  1. 右键插件行弹出「装进另一个环境」：标题是固定文案（不重复插件名），列出除当前环境
 *     之外的所有环境；缺依赖的环境置灰标「缺依赖」，目标环境已经有同名插件的置灰标
 *     「已装 v…」（任何版本都不许重复装）。点目标环境后该行转淡并显示转环（忙态），
 *     完成后动作回执说明装去了哪里；点菜单以外或按 Esc 收起菜单。
 *  2. 换环境不清更新进度：一趟「全部更新」跑到一半切到别的环境再切回来，顶部进度条、
 *     汇总文案与行级状态（已更新 / 更新中 / 排队）都还在，进度继续往下走。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/plugin-transfer.test.mjs`
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
const PORT = 8226; // 独占端口:见 AGENTS.md「容易踩的」里的端口表
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

/** 打开一页并停在「环境/插件」分区，等插件清单与自动检查更新都就位。 */
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
  await sleep(150);
  return page;
}

/** 在某一行的正中右键：走真的 contextmenu 事件，菜单定位才拿得到坐标。 */
async function rightClickRow(page, plugin) {
  await page.evaluate((name) => {
    const row = document.querySelector(`#plugin-list [data-row="${name}"]`);
    if (!row) throw new Error(`找不到插件行：${name}`);
    const box = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(box.left + box.width / 2),
        clientY: Math.round(box.top + box.height / 2),
      }),
    );
  }, plugin);
  await sleep(120);
}

/** 读右键菜单的现状：是否展开、标题、每个目标环境的名字与禁用态。 */
function readMenu(page) {
  return page.evaluate(() => {
    const box = document.getElementById("plugin-menu");
    return {
      hidden: box.classList.contains("hidden"),
      title: document.getElementById("plugin-menu-title").textContent,
      emptyHidden: document.getElementById("plugin-menu-empty").classList.contains("hidden"),
      hintHidden: document.getElementById("plugin-menu-hint").classList.contains("hidden"),
      targets: [...document.querySelectorAll("#plugin-menu-targets [data-plugin-target]")].map((btn) => ({
        label: btn.dataset.pluginTarget,
        disabled: btn.disabled,
        note: btn.querySelector(".plugin-target-note")?.textContent ?? null,
        // 提示走自绘气泡（.has-tip + data-tip），不是原生 title——置灰按钮不弹原生 title。
        tip: btn.dataset.tip ?? null,
        hasTip: btn.classList.contains("has-tip"),
      })),
    };
  });
}

/** 所有的动作回执文案。 */
function readToasts(page) {
  return page.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map((item) => item.textContent.trim()));
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

test("右键插件行列出其它环境；缺依赖与已装的置灰；点别处或 Esc 收起菜单", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    assert.equal((await readMenu(page)).hidden, true, "没右键之前菜单是收着的");

    await rightClickRow(page, "billion-context");
    await page.waitForFunction(
      () => document.querySelectorAll("#plugin-menu-targets [data-plugin-target]").length > 0,
      { timeout: 3000 },
    );
    const menu = await readMenu(page);
    assert.equal(menu.hidden, false, "右键后菜单应展开");
    assert.equal(menu.title.trim(), "装进另一个环境", "标题只说明这是什么菜单，不重复插件名");
    assert.equal(menu.hintHidden, true, "现状回来之后过渡文案应收起");
    assert.equal(menu.emptyHidden, true, "有别的环境时不该出「没有别的环境」");
    // 当前是 web：另外三个环境都在，当前这个不列（装给自己没意义）。
    assert.deepEqual(
      menu.targets.map((item) => item.label),
      ["lab", "headless", "desktop"],
      "应列出除当前环境之外的全部环境",
    );
    const headless = menu.targets.find((item) => item.label === "headless");
    assert.equal(headless.disabled, true, "没装依赖的环境不能作为目标");
    assert.equal(headless.note, "缺依赖", "缺依赖的环境要写明原因");
    // desktop 里预置了同一份插件：任何版本都不许重复装，徽章要写出装的是哪版。
    const desktop = menu.targets.find((item) => item.label === "desktop");
    assert.equal(desktop.disabled, true, "目标环境已有同名插件就不能再装");
    assert.equal(desktop.note, "已装 v2.1.0", "重复的那一行要写清已装版本");
    // 置灰行用不了原生 title（Chromium / WebView2 对 disabled 元素不弹），必须走自绘气泡。
    assert.equal(desktop.hasTip, true, "置灰行也要能弹出说明，不能靠原生 title");
    assert.match(desktop.tip, /环境「desktop」已经有这个插件/, "提示要说清为什么不能选");
    assert.match(desktop.tip, /想换版本请到环境「desktop」里更新/, "提示要指出该去哪个环境换版本");
    assert.equal(menu.targets.find((item) => item.label === "lab").disabled, false, "装过依赖的环境可选");

    // 点菜单以外的地方：收起。
    await page.evaluate(() => document.body.click());
    await sleep(120);
    assert.equal((await readMenu(page)).hidden, true, "点别处应收起菜单");

    // 再开一次，用 Esc 收起。
    await rightClickRow(page, "billion-context");
    await page.waitForFunction(
      () => document.querySelectorAll("#plugin-menu-targets [data-plugin-target]").length > 0,
      { timeout: 3000 },
    );
    await page.keyboard.press("Escape");
    await sleep(120);
    assert.equal((await readMenu(page)).hidden, true, "Esc 应收起菜单");
  } finally {
    await page.close();
  }
});

test("选定目标环境后有行内忙态与回执；装完那一行就变成不可再装", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser, { pluginTransferDelay: 500 });
  try {
    await rightClickRow(page, "dsh-context");
    await page.waitForFunction(
      () => document.querySelectorAll("#plugin-menu-targets [data-plugin-target]").length > 0,
      { timeout: 3000 },
    );
    await page.evaluate(() => {
      document.querySelector('#plugin-menu-targets [data-plugin-target="desktop"]').click();
    });
    // 搬运期间：菜单收起、那一行转淡并挂转环。
    await page.waitForFunction(() => !!document.querySelector("#plugin-list .plugin-row.is-transferring"), {
      timeout: 3000,
    });
    const busy = await page.evaluate(() => ({
      menuHidden: document.getElementById("plugin-menu").classList.contains("hidden"),
      spin: !!document.querySelector("#plugin-list .plugin-row.is-transferring .plugin-transfer-spin"),
      row: document.querySelector("#plugin-list .plugin-row.is-transferring")?.dataset.row,
    }));
    assert.equal(busy.menuHidden, true, "点了目标环境菜单就该收起");
    assert.equal(busy.row, "dsh-context", "忙态应挂在被搬的那一行");
    assert.equal(busy.spin, true, "忙态行右端要有转环");

    await page.waitForFunction(() => !document.querySelector("#plugin-list .plugin-row.is-transferring"), {
      timeout: 5000,
    });
    const toasts = await readToasts(page);
    assert.ok(
      toasts.some((text) => text.includes("装进「desktop」")),
      `回执应说明装进了哪个环境，实际：${JSON.stringify(toasts)}`,
    );

    // 再右键一次：desktop 现在已经有它了，那一行置灰并标出已装版本。
    await rightClickRow(page, "dsh-context");
    await page.waitForFunction(
      () => document.querySelectorAll("#plugin-menu-targets [data-plugin-target]").length > 0,
      { timeout: 3000 },
    );
    const again = (await readMenu(page)).targets.find((item) => item.label === "desktop");
    assert.equal(again.disabled, true, "装过之后不许再重复装");
    assert.match(again.note ?? "", /^已装 v/, `那一行应标出已装版本，实际：${again.note}`);
  } finally {
    await page.close();
  }
});

test("换环境再切回来，更新进度与行级状态都还在", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser, { pluginUpdateDelay: 50, pluginUpdateStepDelay: 1200 });
  try {
    await page.click("#btn-plugin-update-all");
    // 等第一个插件进「更新中」：此时有确定的中途状态可对照。
    await page.waitForFunction(
      () => document.querySelectorAll('#plugin-list [data-phase="busy"]').length > 0,
      { timeout: 5000 },
    );
    const before = await readProgress(page);
    assert.equal(before.hidden, false, "更新中进度条应可见");
    assert.match(before.sum, /正在更新/, "更新中汇总写「正在更新」");

    // 切到 headless（零插件环境），再切回 web。
    await page.click('[data-env-pick="headless"]');
    await page.waitForFunction(() => document.querySelectorAll("#plugin-list .plugin-row").length === 0, {
      timeout: 5000,
    });
    await page.click('[data-env-pick="web"]');
    await page.waitForFunction(() => document.querySelectorAll("#plugin-list .plugin-row").length > 0, {
      timeout: 8000,
    });
    // 行刚铺上时进度可能还差一拍（清单与进度是两条链路），给它一点时间对齐。
    await sleep(300);
    const back = await readProgress(page);
    assert.equal(back.hidden, false, "切回来后进度条不该消失");
    assert.ok(back.chips.length > 0, "切回来后行级状态（已更新/更新中/排队）应还在");

    // 这一趟最终能跑完，汇总落到「已更新 N/N」。
    await page.waitForFunction(
      () => /已更新 \d+\/\d+/.test(document.getElementById("plugin-progress-sum").textContent),
      { timeout: 12000 },
    );
    const done = await readProgress(page);
    assert.match(done.sum, /已更新 3\/3/, `收尾汇总应写完成数，实际：${done.sum}`);
  } finally {
    await page.close();
  }
});

test("读不到现状的环境只说「读不到」，不冒充「已装」", { skip: skipReason }, async () => {
  // desktop 里预置了 billion-context，但让后端报读失败：这时「已装」是猜的，应让位给「读不到」。
  const page = await openPluginPanel(browser, { pluginTargetsError: ["desktop"] });
  try {
    await rightClickRow(page, "billion-context");
    await page.waitForFunction(
      () => document.querySelectorAll("#plugin-menu-targets [data-plugin-target]").length > 0,
      { timeout: 3000 },
    );
    const desktop = (await readMenu(page)).targets.find((item) => item.label === "desktop");
    assert.equal(desktop.disabled, true, "读不到现状的环境不能选");
    assert.equal(desktop.note, "读不到", `读失败时不该写「已装」，实际：${desktop.note}`);
    assert.match(desktop.tip, /读环境「desktop」出错/, "提示要带上读失败的原因");
  } finally {
    await page.close();
  }
});

/** 读顶部进度条与行级状态。 */
function readProgress(page) {
  return page.evaluate(() => ({
    hidden: document.getElementById("plugin-progress").classList.contains("hidden"),
    sum: document.getElementById("plugin-progress-sum").textContent,
    chips: [...document.querySelectorAll("#plugin-list .plugin-phase")].map((chip) => chip.textContent.trim()),
  }));
}
