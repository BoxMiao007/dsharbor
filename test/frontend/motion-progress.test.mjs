/**
 * 前端接缝测试：插件「全部更新」的逐行进度与结果汇总（#33）。
 *
 * 只测一张接缝——批量更新时界面上看得见的那段过程：
 *  1. 点「全部更新」后，每一行按真实进度依次走 排队 → 更新中 → 已更新/失败，
 *     同一时刻只有一行在「更新中」，没参与这轮更新的行不挂任何状态；
 *  2. 顶部那条进度条是**确定**进度：数值随已完成数单调推进，跑完到 100，
 *     不是无限转圈的假进度；
 *  3. 收尾写清「已更新 N/M，K 个失败」，汇总区带 aria-live="polite"（读屏能听到）；
 *  4. 失败行留在列表里、文字写明原因是失败，并且它的「更新」按钮回来可以单独重试
 *     ——已成功的插件不会被重试再更新一遍。
 *
 * 假后端按插件逐个回放进度事件（`pluginUpdateStepDelay` 毫秒一步），所以这里等的是
 * 状态与文案，**不断言毫秒数**：取样只看 `data-phase`、`aria-valuenow` 与文字。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/motion-progress.test.mjs`
 *
 * puppeteer-core 用本机绝对路径：仓库没装它，这台机器上唯一的一份在 .pi 下。
 * 换机器时用环境变量 DSHARBOR_PUPPETEER / DSHARBOR_BROWSER 指过去，否则整组跳过。
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
// 独占端口：log 8207 / switch 8208 / picker 8209 / toolbar 8210 / update 8211 / badge 8213 /
// danger 8214；node --test 并行跑会同时起各自的预览台，端口撞了整组秒挂。
const PORT = 8224;
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

/** 打开一页并停在「环境/插件」分区，等插件清单与自动检查更新都落定。 */
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

/**
 * 读一次进度面：进度条的百分比、汇总文案，以及每一行的状态。
 * `phase` 取自 `data-phase`（没有状态的行是 null——它们不参与这轮更新）。
 */
function readProgress(page) {
  return page.evaluate(() => {
    const card = document.querySelector("#plugin-progress");
    const bar = document.querySelector("#plugin-progress-bar");
    const sum = document.querySelector("#plugin-progress-sum");
    const rows = [...document.querySelectorAll("#plugin-list .plugin-row")].map((row) => {
      const chip = row.querySelector(".plugin-phase");
      const reason = row.querySelector(".plugin-fail");
      const retry = row.querySelector(".plugin-update");
      return {
        name: row.getAttribute("data-row"),
        phase: row.getAttribute("data-phase"),
        chip: chip ? chip.textContent.trim() : null,
        reason: reason ? reason.textContent.trim() : null,
        retry: retry ? { disabled: retry.disabled } : null,
      };
    });
    return {
      present: Boolean(card),
      hidden: card ? card.classList.contains("hidden") : true,
      sum: sum ? sum.textContent.trim() : null,
      live: sum ? sum.getAttribute("aria-live") : null,
      now: bar ? Number(bar.getAttribute("aria-valuenow")) : null,
      rows,
    };
  });
}

/** 到了要停的状态就返回（同时把中间的每一次取样留着，供「依次出现」断言）。 */
async function sampleUntil(page, done, timeoutMs = 8000) {
  const started = Date.now();
  const seen = [];
  while (Date.now() - started < timeoutMs) {
    const snap = await readProgress(page);
    seen.push(snap);
    if (done(snap)) return { seen, last: snap };
    await sleep(45);
  }
  return { seen, last: seen[seen.length - 1] };
}

/** 参与这轮更新的行（挂了 data-phase 的那些）。 */
const activeRows = (snap) => snap.rows.filter((row) => row.phase !== null);
const allDone = (snap) => {
  const rows = activeRows(snap);
  return rows.length > 0 && rows.every((row) => row.phase === "done" || row.phase === "fail");
};

let preview = null;
let browser = null;

before(async () => {
  if (skipReason) return;
  preview = await startPreview();
  const puppeteer = require(PUPPETEER_CORE);
  browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (preview) preview.kill();
});

test("全部更新：逐行依次排队/更新中/已更新，进度条按已完成数推进", { skip: skipReason }, async () => {
  // 一个插件一步 260ms：够在两次取样之间看到中间态，又不至于把整套测试拖慢。
  const page = await openPluginPanel(browser, { pluginUpdateStepDelay: 260 });
  try {
    await page.click("#btn-plugin-update-all");
    const { seen, last } = await sampleUntil(page, allDone);

    // 只有这轮真的在更新的 3 个插件挂状态，其它行保持干净。
    assert.equal(activeRows(last).length, 3, `应只有 3 行有状态，实际 ${JSON.stringify(last.rows)}`);

    // 依次出现：先「排队 + 更新中」共存，再「已更新 + 更新中」共存。
    assert.equal(
      seen.some(
        (snap) =>
          activeRows(snap).some((row) => row.phase === "queue") &&
          activeRows(snap).some((row) => row.phase === "busy"),
      ),
      true,
      "应出现「一行在更新中、其余还在排队」的中间态",
    );
    assert.equal(
      seen.some(
        (snap) =>
          activeRows(snap).some((row) => row.phase === "done") &&
          activeRows(snap).some((row) => row.phase === "busy"),
      ),
      true,
      "应出现「前面已更新、后面还在更新中」的中间态",
    );
    // 同一时刻只有一行在更新中，不能整排一起亮。
    assert.equal(
      seen.every((snap) => activeRows(snap).filter((row) => row.phase === "busy").length <= 1),
      true,
      "同一时刻最多一行处于「更新中」",
    );

    // 行上的字就是这四态的中文说法。
    const queueRow = seen.map((snap) => activeRows(snap).find((row) => row.phase === "queue")).find(Boolean);
    const busyRow = seen.map((snap) => activeRows(snap).find((row) => row.phase === "busy")).find(Boolean);
    assert.equal(queueRow?.chip, "排队");
    assert.equal(busyRow?.chip, "更新中");
    assert.equal(last.rows.find((row) => row.phase === "done")?.chip, "已更新");

    // 确定进度：0 → … → 100，单调不减，且中途出现过真正的中间值。
    const values = seen.map((snap) => snap.now).filter((value) => Number.isFinite(value));
    assert.equal(values.every((value, i) => i === 0 || value >= values[i - 1]), true, `进度不应回退：${values}`);
    assert.equal(
      values.some((value) => value > 0 && value < 100),
      true,
      `进度条应出现中间值，实际 ${values}`,
    );
    assert.equal(last.now, 100, "跑完应到 100");
    assert.equal(last.hidden, false, "更新期间与收尾都应看得见进度条");

    // 收尾汇总：已更新 3/3，0 个失败；汇总区对读屏可见。
    assert.match(last.sum, /已更新 3\/3，0 个失败/, `收尾文案应写清总数，实际「${last.sum}」`);
    assert.equal(last.live, "polite", "汇总区应带 aria-live=polite");
    assert.equal(
      last.rows.every((row) => row.phase !== "queue" && row.phase !== "busy"),
      true,
      "收尾时不应再有排队/更新中的行",
    );
  } finally {
    await page.close();
  }
});

test("整轮在命令级就失败（如 DSH 正在运行）：进度条也要收尾，不悬在「已完成 0/N」", { skip: skipReason }, async () => {
  // 让 DSH 处于「运行中」：批量更新一进来就被后端挡下（命令级抛错），一条进度事件都不会来。
  // 这是最容易让进度条悬着的路径——没有任何行走到 done，只靠已完成数与总数相等收不了尾。
  const page = await openPluginPanel(browser, { session: "running" });
  try {
    await page.click("#btn-plugin-update-all");
    const { last } = await sampleUntil(page, (snap) =>
      /已更新 \d+\/3，\d+ 个失败/.test(String(snap.sum)),
    );

    assert.match(
      last.sum,
      /已更新 0\/3，3 个失败/,
      `命令级失败也要落一句收尾，实际「${last.sum}」`,
    );
    assert.equal(last.now, 100, "收尾时进度条应推到 100，不留在 0");
    assert.equal(
      last.rows.every((row) => row.phase !== "queue" && row.phase !== "busy"),
      true,
      "收尾时不应再有排队/更新中的行",
    );
  } finally {
    await page.close();
  }
});

test("有插件更新失败：收尾写明失败数，失败行留下原因并可单独重试", { skip: skipReason }, async () => {
  // 让 dsh-skill-mcp-panel 这一步失败一次（重试那一遍会成功，模拟偶发故障）。
  const page = await openPluginPanel(browser, {
    pluginUpdateStepDelay: 160,
    pluginUpdateDelay: 200,
    pluginUpdateFail: ["dsh-skill-mcp-panel"],
  });
  try {
    await page.click("#btn-plugin-update-all");
    const { last } = await sampleUntil(page, allDone);

    assert.match(last.sum, /已更新 2\/3，1 个失败/, `失败应计入汇总，实际「${last.sum}」`);

    const failed = last.rows.find((row) => row.name === "dsh-skill-mcp-panel");
    assert.equal(failed?.phase, "fail", "失败的插件行应标成失败");
    assert.equal(failed?.chip, "失败");
    assert.match(String(failed?.reason), /失败/, `失败行应写明原因，实际「${failed?.reason}」`);
    assert.notEqual(failed?.reason, null, "失败行必须留下可见的原因");
    assert.equal(failed?.retry !== null, true, "失败行应留着「更新」按钮供单独重试");
    assert.equal(failed?.retry?.disabled, false, "失败行的重试按钮应可点");

    // 成功的行不会再有更新按钮——重试只会动失败的那一个。
    const doneRows = last.rows.filter((row) => row.phase === "done");
    assert.equal(doneRows.length, 2, `应有 2 行更新成功，实际 ${JSON.stringify(last.rows)}`);
    assert.equal(
      doneRows.every((row) => row.retry === null),
      true,
      "已成功更新的行不应再有更新按钮",
    );

    // 单独重试失败的那一个：行状态重新走一遍忙态，成功后变「已更新」。
    await page.click('#plugin-list [data-row="dsh-skill-mcp-panel"] .plugin-update');
    const { seen, last: retried } = await sampleUntil(
      page,
      (snap) => snap.rows.find((row) => row.name === "dsh-skill-mcp-panel")?.phase === "done",
    );
    assert.equal(
      seen.some((snap) => snap.rows.find((row) => row.name === "dsh-skill-mcp-panel")?.phase === "busy"),
      true,
      "重试也要走一遍「更新中」",
    );
    const retriedRow = retried.rows.find((row) => row.name === "dsh-skill-mcp-panel");
    assert.equal(retriedRow?.phase, "done", "重试成功后该行应变成已更新");
    assert.equal(retriedRow?.retry, null, "重试成功后该行不应再有更新按钮");
  } finally {
    await page.close();
  }
});
