/**
 * 前端接缝测试：插件清单的骨架屏与真实行入场（#32）。
 *
 * 只测「等一下才有结果」这一段在界面上看得见的四个接缝：
 *  1. 清单还没回来时，列表区铺三行与真实行同高同结构的骨架，而不是空着等；
 *  2. 数据到达后骨架撤掉、真实行换成真内容，并且逐行错开入场（--i 递增、延迟 40ms 一档）；
 *  3. 骨架有最短展示时间：假后端秒回也不会闪一下就没；
 *  4. 关闭动效时骨架静止（无扫光）、真实行直接落位；读取失败骨架不残留；空列表走空态。
 *
 * 入场标记（`data-enter` / `--i`）只在「骨架 → 真实行」那一次重铺里出现，之后再读就没了，
 * 所以取样器在页面首帧就装好，用 MutationObserver 在行插入的那一刻记下计算样式与序号。
 *
 * 假后端（scripts/mock-preview.mjs）支持 `pluginListDelay`（毫秒，按每条命令计）与
 * `pluginListFails` 两个开关，用来把「加载中」这一段拉长到断言得过来。
 *
 * 跑在普通浏览器里（假后端预览台），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/mock.html）。
 * 跑法：`node --test test/frontend/motion-skeleton.test.mjs`
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
// 独占端口（#32）：8219 已被 motion-panels 占用，这里用 8225。
const PORT = 8225; // 独占端口:见 AGENTS.md「容易踩的」里的端口表
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
 * 打开一页并停在「环境」分区。
 * `motion` 有值时先把它写进 localStorage（"off" 关动效），写在首帧脚本之前；
 * 页面里另外装一台取样器，记录骨架与真实行各自出现的时刻、插入时挂的入场标记。
 */
async function openPluginPanel(browser, { state = null, motion = null, ready = "content" } = {}) {
  const url = state ? `${PAGE_URL}?state=${encodeURIComponent(JSON.stringify(state))}` : PAGE_URL;
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  await page.evaluateOnNewDocument(
    (key, value) => {
      try {
        window.localStorage.removeItem(key);
        if (value !== null) window.localStorage.setItem(key, value);
        // 分区也要清：上一页停在「环境」时，这一页会在首帧就把清单读完，
        // 骨架在点击之前就闪完了，取样器与轮询都等不到它。
        window.localStorage.removeItem("dsharbor.ui.panel");
      } catch {
        // 存储被禁用时按默认走，与产品行为一致。
      }
    },
    MOTION_KEY,
    motion,
  );
  await page.evaluateOnNewDocument(() => {
    /** 计算样式里的时长统一换到毫秒：Chrome 对 0.04s 这种写法回的是秒。 */
    const ms = (value) => (value.endsWith("ms") ? parseFloat(value) : parseFloat(value) * 1000);
    window.__skelTrace = { skeletonAt: null, rowsAt: null, skeletonLines: [], rows: [] };
    const obs = new MutationObserver(() => {
      const list = document.getElementById("plugin-list");
      if (!list) return;
      const trace = window.__skelTrace;
      const skeleton = list.querySelectorAll("[data-skeleton]");
      const rows = list.querySelectorAll(".plugin-row[data-row]");
      if (trace.skeletonAt === null && skeleton.length > 0) {
        trace.skeletonAt = performance.now();
        trace.skeletonLines = [...list.querySelectorAll(".sk-line")].map((el) => {
          const cs = getComputedStyle(el);
          return { anim: cs.animationName, duration: ms(cs.animationDuration) };
        });
      }
      if (trace.rowsAt === null && rows.length > 0) {
        trace.rowsAt = performance.now();
        trace.rows = [...rows].map((row) => {
          const cs = getComputedStyle(row);
          return {
            name: row.getAttribute("data-row"),
            // 入场标记：序号既写在 --i 上（CSS 拿它算延迟），也写在 data-enter 上（稳定钩子）。
            i: row.style.getPropertyValue("--i").trim(),
            enter: row.getAttribute("data-enter"),
            anim: cs.animationName,
            duration: ms(cs.animationDuration),
            delay: ms(cs.animationDelay),
          };
        });
        obs.disconnect();
      }
    });
    obs.observe(document, { childList: true, subtree: true });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-panel-btn="env"]');
  await page.click('[data-panel-btn="env"]');
  // ready="skeleton"：调用方给足了清单延时、断言骨架，必须等骨架真的挂上；
  // ready="content"：骨架或真实行都算（秒回那种没赶上骨架也无所谓）。
  // 只等骨架的调用一定要把延时开到远超机器负载（并行跑全套时定时器会被拖慢）。
  if (ready === "skeleton") {
    await waitSkeleton(page, 20000);
  } else {
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#plugin-list [data-skeleton], #plugin-list .plugin-row[data-row]").length > 0,
      { timeout: 20000 },
    );
  }
  return page;
}

/** 等骨架挂上：只在状态里给的清单延时足够长（≥3000ms）时可靠。 */
async function waitSkeleton(page, timeout = 8000) {
  await page.waitForFunction(() => document.querySelectorAll("#plugin-list [data-skeleton]").length > 0, { timeout });
}

/** 等真实行出现（骨架→真实行那一次重铺）。 */
async function waitRealRows(page, timeout = 8000) {
  await page.waitForFunction(() => document.querySelectorAll("#plugin-list .plugin-row[data-row]").length > 0, { timeout });
}

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

test("读取中铺三行骨架，数据到达换成真实行并逐行错开入场", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser, { state: { pluginListDelay: 4000 }, ready: "skeleton" });
  try {
    // 加载中：三行骨架，每行都有灰条；高度与真实行对齐（后面比）。
    const loading = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#plugin-list [data-skeleton]")];
      return {
        count: rows.length,
        lines: rows.map((row) => row.querySelectorAll(".sk-line").length),
        heights: rows.map((row) => row.offsetHeight),
        summary: document.querySelector("#plugin-summary").textContent,
        emptyHidden: document.querySelector("#plugin-empty").classList.contains("hidden"),
      };
    });
    assert.equal(loading.count, 3, "读取中应铺三行骨架");
    assert.equal(
      loading.lines.every((n) => n >= 3),
      true,
      `每行骨架应由多条灰条组成（圆点位 + 长短两三条），实际 ${JSON.stringify(loading.lines)}`,
    );
    assert.equal(
      loading.heights.every((h) => h > 0),
      true,
      "骨架行要有高度（不能塌成 0）",
    );
    assert.equal(loading.emptyHidden, true, "加载中不应把骨架当成空态，空态仍收着");
    assert.match(loading.summary, /正在读取/, "加载中徽章仍说正在读取");

    // 数据到达：骨架撤掉、真实行出现。
    await waitRealRows(page);
    const loaded = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#plugin-list .plugin-row")];
      return {
        skeletons: document.querySelectorAll("#plugin-list [data-skeleton]").length,
        rows: rows.length,
        heights: rows.map((row) => row.offsetHeight),
        names: rows.map((row) => row.getAttribute("data-row")),
      };
    });
    assert.equal(loaded.skeletons, 0, "数据到达后骨架不应残留");
    assert.equal(loaded.rows >= 3, true, `应出现真实插件行，实际 ${loaded.rows}`);
    assert.equal(
      loaded.names.every((name) => Boolean(name)),
      true,
      "真实行应带 data-row 包名",
    );
    // 高度对齐：骨架行与真实行同高（真实行带说明，两行内容），切换时版面不跳。
    const skeletonH = loading.heights[0];
    const realH = loaded.heights[0];
    assert.equal(
      Math.abs(skeletonH - realH) <= 2,
      true,
      `骨架行与真实行高度应接近，实际骨架 ${skeletonH}px / 真实 ${realH}px`,
    );

    // 入场标记：插入那一刻就挂着 --i 序号（0 起递增）与 data-enter，动画按序号错开。
    const trace = await page.evaluate(() => window.__skelTrace);
    assert.equal(trace.skeletonAt !== null, true, "取样器应记到骨架出现的时刻");
    assert.equal(trace.rowsAt !== null, true, "取样器应记到真实行出现的时刻");
    assert.equal(trace.rows.length >= 3, true, `取样器应至少记到 3 行，实际 ${trace.rows.length}`);
    assert.deepEqual(
      trace.rows.slice(0, 3).map((row) => row.i),
      ["0", "1", "2"],
      "真实行的 --i 应从 0 起逐行递增",
    );
    assert.deepEqual(
      trace.rows.slice(0, 3).map((row) => row.enter),
      ["0", "1", "2"],
      "真实行的 data-enter 应逐行递增",
    );
    assert.equal(
      trace.rows.every((row) => row.anim.includes("plugin-row-in")),
      true,
      `真实行应挂入场动画，实际 ${JSON.stringify(trace.rows.map((row) => row.anim))}`,
    );
    assert.deepEqual(
      trace.rows.slice(0, 3).map((row) => row.delay),
      [0, 40, 80],
      "入场延迟每行错开 40ms",
    );
    assert.equal(
      trace.rows.every((row) => row.duration > 0 && row.duration <= 300),
      true,
      `单次入场动画时长应在 300ms 内，实际 ${JSON.stringify(trace.rows.map((row) => row.duration))}`,
    );
  } finally {
    await page.close();
  }
});

test("骨架最短展示约 300ms：假后端秒回也不闪一下就没", { skip: skipReason }, async () => {
  // pluginListDelay 默认 0：假后端同步回话，全靠前端自己的最短展示兜住。
  const page = await openPluginPanel(browser, { state: null });
  try {
    await waitRealRows(page);
    const trace = await page.evaluate(() => window.__skelTrace);
    assert.equal(trace.skeletonAt !== null, true, "秒回的路径也应先画出骨架");
    const shown = trace.rowsAt - trace.skeletonAt;
    assert.equal(shown >= 280, true, `骨架至少展示约 300ms，实际只 ${Math.round(shown)}ms`);
  } finally {
    await page.close();
  }
});

test("关闭动效：骨架静止（无扫光），真实行直接落位", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser, { state: { pluginListDelay: 4000 }, motion: "off", ready: "skeleton" });
  try {
    const state = await page.evaluate(() => {
      const line = document.querySelector("#plugin-list .sk-line");
      const cs = line ? getComputedStyle(line) : null;
      return {
        motion: document.documentElement.getAttribute("data-motion"),
        count: document.querySelectorAll("#plugin-list [data-skeleton]").length,
        anim: cs ? cs.animationName : null,
        duration: cs ? cs.animationDuration : null,
      };
    });
    assert.equal(state.motion, "off", "关掉动效后 <html> 应带 data-motion=off");
    assert.equal(state.count, 3, "关掉动效时骨架仍在（静态占位）");
    assert.equal(state.anim, "none", `关掉动效后骨架不应扫光，实际 animation-name=${state.anim}`);
    assert.equal(state.duration, "0s", "关掉动效后骨架不应有动画时长");

    await waitRealRows(page);
    const trace = await page.evaluate(() => window.__skelTrace);
    assert.equal(
      trace.rows.every((row) => row.duration === 0),
      true,
      `关掉动效后入场应瞬时完成，实际 ${JSON.stringify(trace.rows.map((row) => row.duration))}`,
    );
    // 跟着骨架、无延迟地出现在最终位置：透明度不留在中间态。
    const opacity = await page.evaluate(() => {
      const row = document.querySelector("#plugin-list .plugin-row");
      return row ? getComputedStyle(row).opacity : null;
    });
    assert.equal(opacity, "1", "关掉动效后真实行应直接可见");
  } finally {
    await page.close();
  }
});

test("读取失败：骨架撤掉，只留失败提示", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser, {
    state: { pluginListDelay: 3000, pluginListFails: true },
    ready: "skeleton",
  });
  try {
    assert.equal(
      await page.evaluate(() => document.querySelectorAll("#plugin-list [data-skeleton]").length),
      3,
      "读取失败前也应先看到骨架",
    );
    await page.waitForFunction(() => document.querySelectorAll("#plugin-list [data-skeleton]").length === 0, {
      timeout: 8000,
    });
    const after = await page.evaluate(() => {
      const note = document.querySelector("#plugin-note");
      return {
        rows: document.querySelectorAll("#plugin-list .plugin-row").length,
        noteHidden: note.classList.contains("hidden"),
        note: note.textContent.trim(),
      };
    });
    assert.equal(after.rows, 0, "读取失败时不应凭空出现真实行");
    assert.equal(after.noteHidden, false, "读取失败要给出提示");
    assert.match(after.note, /读取插件清单失败/, `失败提示应写明原因，实际「${after.note}」`);
  } finally {
    await page.close();
  }
});

test("空列表：骨架不冒充空态，读到零插件才显示空态", { skip: skipReason }, async () => {
  const page = await openPluginPanel(browser, {
    state: { plugins: { web: [] }, pluginListDelay: 3000 },
    ready: "skeleton",
  });
  try {
    assert.equal(
      await page.evaluate(() => document.querySelectorAll("#plugin-list [data-skeleton]").length),
      3,
      "还没读到时先铺骨架",
    );
    await page.waitForFunction(() => !document.querySelector("#plugin-empty").classList.contains("hidden"), {
      timeout: 8000,
    });
    const after = await page.evaluate(() => ({
      skeletons: document.querySelectorAll("#plugin-list [data-skeleton]").length,
      rows: document.querySelectorAll("#plugin-list .plugin-row").length,
    }));
    assert.equal(after.skeletons, 0, "读到空清单后骨架应撤掉");
    assert.equal(after.rows, 0, "空清单不应有真实行");
  } finally {
    await page.close();
  }
});
