/**
 * 前端接缝测试：插件更新（检查结果行内渲染 + 单个/全部更新 + 工具条互斥）。
 *
 * 只测四个接缝——插件卡里更新功能露在界面上的部分：
 *  1. 检查过后行内出现版本号；有更新的行是「旧版本 → 新版本（绿徽章）」加「更新」文字按钮
 *     （目标版本在新徽章与按钮气泡里，含预发布）；registry 查不到的行按两种样子亮出错误——
 *     版本读不出的亮「版本未知」、读得出的在版本号旁亮「检查失败」，原因都收进 title；
 *     官方骨架包与桥接插件不出现在更新范围里（行内没有版本号）。版本徽章挤在包名末尾同行，
 *     插件自带的说明单独一行。
 *  2. 点单个「更新」：按钮走忙态，完成后该行按钮消失、版本号变成目标版本，汇总提示出现；
 *     停用中的插件更新后保持停用，并出现「新版本若改了挂载点，停用可能失效」的提醒。
 *  3. 「全部更新」：把剩余有更新的插件逐个升级，提示写明成功清单；没有可更新的插件时
 *     按钮置灰、徽章归零。
 *  4. 工具条是两枚图标方钮（悬停气泡写功能名）；任一动作进行中，检查/全部更新/行内
 *     更新/开关全部锁死（互斥），发起动作的那枚图标转圈，做完恢复。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/plugin-update.test.mjs`
 *
 * 注意：预览台的假数据烙在 mock.html 里，每开一个新页都从初始状态开始——所以每个测试
 * 都自包含（一页之内做完自己的完整流程），互相不依赖执行顺序。
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
const PORT = 8211; // 独占端口：log 8207 / switch 8208 / picker 8209 / toolbar 8210，node --test 并行跑会同时起预览台
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
 * （徽章出现「N 个可更新」）。自动检查失败时这个等待会超时——那本身就是失败信号。
 * `state` 会拼到 URL 的 ?state= 上（预览台在首轮渲染前覆盖假状态），
 * 互斥测试用它给假命令加人工延时，拿到确定的忙态窗口。
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
  await sleep(150);
  return page;
}

/** 读一行（按插件名）的更新相关渲染：版本号、版本未知提示、更新按钮。 */
function readUpdateCell(page, name) {
  return page.evaluate((plugin) => {
    const row = document.querySelector(`#plugin-list [data-row="${plugin}"]`);
    if (!row) return null;
    const ver = row.querySelector(".plugin-ver");
    const bad = row.querySelector(".plugin-ver-bad");
    const verNew = row.querySelector(".plugin-ver-new");
    const arrow = row.querySelector(".plugin-ver-arrow");
    const btn = row.querySelector(".plugin-update");
    return {
      ver: ver ? ver.textContent : null,
      badText: bad ? bad.textContent : null,
      badTitle: bad ? bad.getAttribute("title") : null,
      verNew: verNew ? verNew.textContent : null,
      arrow: arrow ? arrow.textContent : null,
      btnText: btn ? btn.textContent : null,
      btnTitle: btn ? btn.getAttribute("title") : null,
      btnDisabled: btn ? btn.disabled : null,
      off: row.classList.contains("is-off"),
    };
  }, name);
}

/** 读工具条两枚按钮的可用状态与徽章/提示/警示文案。 */
function readPanelState(page) {
  return page.evaluate(() => ({
    checkDisabled: document.querySelector("#btn-plugin-check-updates").disabled,
    allDisabled: document.querySelector("#btn-plugin-update-all").disabled,
    summary: document.querySelector("#plugin-summary").textContent,
    note: document.querySelector("#plugin-note").textContent,
    warning: document.querySelector("#plugin-warning").textContent,
    updateButtons: document.querySelectorAll("#plugin-list .plugin-update").length,
  }));
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

test("检查后行内出现版本号与更新按钮；范围外插件与查不到的行各按各自的样子渲染", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    // 有更新的行：旧版本 → 新版本（新版本绿徽章），按钮就「更新」两个字，目标版本在气泡里。
    const updatable = await readUpdateCell(page, "billion-context");
    assert.equal(updatable.ver, "v2.1.0", "已装版本应显示在行内");
    assert.equal(updatable.verNew, "v2.3.0-rc.1", "新版本徽章应显示目标版本（含预发布）");
    assert.equal(updatable.arrow, "→", "新旧版本之间应有箭头");
    assert.equal(updatable.btnText, "更新", "更新按钮就「更新」两个字");
    assert.match(updatable.btnTitle, /v2\.3\.0-rc\.1/, "目标版本应收在按钮气泡里");
    assert.equal(updatable.btnDisabled, false, "更新按钮默认可用");

    // 已最新的行：只有版本号，没有按钮。
    const latest = await readUpdateCell(page, "dsh-context");
    assert.equal(latest.ver, "v0.4.2");
    assert.equal(latest.btnText, null, "已最新不该出现更新按钮");

    // registry 查不到的行：亮「版本未知」，错误收进 title 悬停可见。
    const unknown = await readUpdateCell(page, "dsh-free-search");
    assert.equal(unknown.badText, "版本未知");
    assert.ok(unknown.badTitle.includes("E404"), "title 里应带上查询失败的原因");

    // 版本读得出但查询失败（本地 tgz、私有包装出来的插件就是这个形状）：
    // 版本号照显，旁边亮「检查失败」——错误不能因为 current 有值就被吞掉。
    const broken = await readUpdateCell(page, "dsh-local-tools");
    assert.equal(broken.ver, "v0.9.0", "已装版本仍应显示");
    assert.equal(broken.badText, "检查失败", "查询失败必须露出来，不能只留版本号");
    assert.ok(broken.badTitle.includes("E404"), "title 里应带上查询失败的原因");
    assert.equal(broken.btnText, null, "查不到目标版本就不该出现更新按钮");

    // 官方骨架包与桥接插件不在更新范围：列表里根本没有它们的行（只列可管理的插件）。
    for (const out of ["@deepseek-ai/dsh-base", "dsharbor-bridge"]) {
      const cell = await readUpdateCell(page, out);
      assert.equal(cell, null, `${out} 不该出现在插件列表里`);
    }

    // 版本徽章挤在包名末尾的标题行里；插件自带的说明（description）单独一行，
    // 悬停看全文；工具条是两枚图标方钮，功能名走气泡（aria-label 与 title 一致）。
    const layout = await page.evaluate(() => {
      const row = document.querySelector('#plugin-list [data-row="billion-context"]');
      const badge = row.querySelector(".plugin-ver");
      const title = row.querySelector(".plugin-title");
      const desc = row.querySelector(".plugin-desc");
      const icons = ["#btn-plugin-check-updates", "#btn-plugin-update-all"].map((sel) => {
        const btn = document.querySelector(sel);
        return { hasSvg: Boolean(btn.querySelector("svg")), label: btn.getAttribute("aria-label") };
      });
      return {
        badgeInTitle: Boolean(badge && title && title.contains(badge)),
        descText: desc ? desc.textContent : null,
        descTitle: desc ? desc.getAttribute("title") : null,
        icons,
        allBadge: document.querySelector("#plugin-update-all-badge")?.textContent ?? null,
      };
    });
    assert.equal(layout.badgeInTitle, true, "版本徽章应在包名末尾的标题行里");
    assert.ok(layout.descText && layout.descText.length > 0, "插件自带的说明应显示出来");
    assert.equal(layout.descText, layout.descTitle, "说明全文应收在 title 里（悬停可看）");
    assert.equal(layout.allBadge, "3", "「全部更新」右上角微标应显示可更新的插件数");
    assert.deepEqual(
      layout.icons,
      [
        { hasSvg: true, label: "检查更新" },
        { hasSvg: true, label: "全部更新" },
      ],
      "工具条应是两枚图标钮，气泡写功能名",
    );

    const state = await readPanelState(page);
    assert.match(state.summary, /3 个可更新/, `徽章应报 3 个可更新，实际「${state.summary}」`);
    assert.equal(state.allDisabled, false, "有可更新插件时「全部更新」应可用");
    assert.equal(state.updateButtons, 3, "行内应有 3 枚更新按钮");
  } finally {
    await page.close();
  }
});

test("单个更新：完成后按钮消失、版本号变成目标版本、提示汇总", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    await page.click('#plugin-list [data-row="billion-context"] .plugin-update');
    await sleep(900); // 更新是异步的（执行命令+回读校验+重查清单）

    const row = await readUpdateCell(page, "billion-context");
    assert.equal(row.btnText, null, "更新完成后按钮应消失");
    assert.equal(row.ver, "v2.3.0-rc.1", "行内版本号应变成装上的目标版本");

    const state = await readPanelState(page);
    assert.match(
      state.note,
      /已把「billion-context」更新到 2\.3\.0-rc\.1。重启 DSH 后生效/,
      `提示应汇总单个更新结果，实际「${state.note}」`,
    );
    assert.match(state.summary, /2 个可更新/, `徽章应减到 2 个，实际「${state.summary}」`);
    assert.equal(state.allDisabled, false, "还有可更新插件时「全部更新」仍应可用");

    // 更新不碰补丁层：启用状态原样保留（billion-context 本来就是启用的）。
    assert.equal(row.off, false, "启用的插件更新后不应变成停用");
  } finally {
    await page.close();
  }
});

test("停用中的插件也能更新：保持停用并出现挂载点提醒", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    const before = await readUpdateCell(page, "dsh-better-sidebar");
    assert.equal(before.off, true, "该插件在假数据里应是停用状态");
    await page.click('#plugin-list [data-row="dsh-better-sidebar"] .plugin-update');
    await sleep(900);

    const row = await readUpdateCell(page, "dsh-better-sidebar");
    assert.equal(row.ver, "v3.2.0", "停用插件的版本号也应更新");
    assert.equal(row.off, true, "更新后必须保持停用");

    const state = await readPanelState(page);
    assert.match(
      state.warning,
      /「dsh-better-sidebar」目前处于停用状态，更新后保持停用；若新版本改了挂载点，停用可能失效/,
      `应出现停用插件更新提醒，实际「${state.warning}」`,
    );
    assert.match(state.summary, /2 个可更新/, `徽章应减到 2 个，实际「${state.summary}」`);
  } finally {
    await page.close();
  }
});

test("全部更新：逐个升级并汇总成功清单；没有可更新的之后按钮置灰", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser);
  try {
    await page.click("#btn-plugin-update-all");
    await sleep(1200); // 三个插件逐个更新，比单个更慢，多等一会

    const state = await readPanelState(page);
    assert.match(
      state.note,
      /全部更新完成：成功 3 个/,
      `应汇总批量更新结果，实际「${state.note}」`,
    );
    assert.match(state.note, /dsh-skill-mcp-panel@1\.1\.0/, "成功清单应列出插件@版本");
    assert.equal(state.updateButtons, 0, "全部更新后行内不应再有更新按钮");
    assert.match(state.summary, /0 个可更新/, `徽章应归零，实际「${state.summary}」`);
    assert.equal(state.allDisabled, true, "没有可更新插件时「全部更新」应置灰");
    const badgeAfter = await page.evaluate(() => {
      const badge = document.querySelector("#plugin-update-all-badge");
      return { text: badge?.textContent ?? null, hidden: badge?.classList.contains("hidden") };
    });
    assert.equal(
      badgeAfter.text === "" && badgeAfter.hidden === true,
      true,
      "全部更新完成后微标应收掉",
    );
  } finally {
    await page.close();
  }
});

test("工具条互斥：任一动作进行中全部操作锁死，发起的那枚图标转圈，做完恢复", { skip: skipReason }, async () => {
  // 假命令带 600ms 人工延时（URL ?state= 覆盖），拿到确定的忙态窗口。
  // 元素全部可选链：行内更新按钮在更新完成后会被合法移除，读不到不报错。
  // 页面显式传入：两段流程各开一页，闭包抓死第一页的引用会读到已关闭的帧。
  const busyState = (page2) =>
    page2.evaluate(() => {
      const q = (sel) => document.querySelector(sel);
      const spin = (sel) => q(sel)?.classList.contains("is-spinning") ?? false;
      return {
        checkDisabled: q("#btn-plugin-check-updates")?.disabled ?? null,
        checkSpinning: spin("#btn-plugin-check-updates"),
        allDisabled: q("#btn-plugin-update-all")?.disabled ?? null,
        allSpinning: spin("#btn-plugin-update-all"),
        rowBtnGone: !q('#plugin-list [data-row="billion-context"] .plugin-update'),
        switchDisabled: q('#plugin-list [data-row="billion-context"] .switch')?.disabled ?? null,
      };
    });
  const waitSpin = (page2, sel, want) =>
    page2.waitForFunction(
      (sel2, want2) =>
        Boolean(document.querySelector(sel2)?.classList.contains("is-spinning")) === want2,
      { timeout: 3000 },
      sel,
      want,
    );

  // 「全部更新」进行中：另一枚图标、行内更新按钮、开关全部锁死；只有它自己转圈。
  const page = await openPluginPanel(browser, { pluginUpdateDelay: 600 });
  try {
    await page.click("#btn-plugin-update-all");
    await waitSpin(page, "#btn-plugin-update-all", true);
    const busy = await busyState(page);
    assert.equal(busy.checkDisabled, true, "全部更新期间「检查更新」应锁死");
    assert.equal(busy.allDisabled, true, "全部更新期间按钮本身应置灰");
    assert.equal(busy.allSpinning, true, "「全部更新」自己的图标应转圈");
    assert.equal(busy.checkSpinning, false, "「检查更新」不该跟着转圈");
    assert.equal(busy.rowBtnGone, false, "行内更新按钮应还在（只是锁死）");
    assert.equal(busy.switchDisabled, true, "开关应锁死");

    await waitSpin(page, "#btn-plugin-update-all", false);
    const done = await busyState(page);
    assert.equal(done.checkDisabled, false, "做完「检查更新」应解锁");
    assert.equal(done.switchDisabled, false, "做完开关应解锁");
  } finally {
    await page.close();
  }

  // 「检查更新」进行中：同样的互斥面，转圈的是检查这枚。
  const page2 = await openPluginPanel(browser, { pluginCheckDelay: 600 });
  try {
    await page2.click("#btn-plugin-check-updates");
    await waitSpin(page2, "#btn-plugin-check-updates", true);
    const busy = await busyState(page2);
    assert.equal(busy.checkSpinning, true, "「检查更新」的图标应转圈");
    assert.equal(busy.allDisabled, true, "检查期间「全部更新」应锁死");
    assert.equal(busy.rowBtnGone, false, "检查期间行内更新按钮应锁死");
    assert.equal(busy.switchDisabled, true, "检查期间开关应锁死");

    await waitSpin(page2, "#btn-plugin-check-updates", false);
    const done = await busyState(page2);
    assert.equal(done.checkDisabled, false, "做完应解锁");
    assert.equal(done.switchDisabled, false, "做完开关应解锁");
  } finally {
    await page2.close();
  }
});
