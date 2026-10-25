/**
 * 前端接缝测试：动作回执 Toast（#34）。
 *
 * 只测「浏览器里才说得清」的几条接缝：
 *  1. 动作收尾 → 右下角冒出一条 toast，文案就是后端回来的那句话；播报容器
 *     `#toasts` 带 role="status" / aria-live="polite"，且不抢焦点。
 *  2. 同时最多 3 条：连续 4 条不同文案，最旧的那条被挤掉。
 *  3. 同文案去重：同样的动作再来一次，不叠新条，只把已有那条的计时刷新。
 *  4. 自动消失：不是写死毫秒等待，而是先确认它确实停留了一会儿，再轮询到它退场。
 *  5. 关闭按钮：可点、可访问名是「关闭提示」、点完真的没了。
 *  6. 关动效（html[data-motion="off"]）：toast 仍瞬时出现且看得见，不会被中和规则吞掉。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/mock.html）。
 * 跑法：`node --test test/frontend/motion-toast.test.mjs`
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
const PORT = 8222; // 独占端口:见 AGENTS.md「容易踩的」里的端口表
const MOTION_KEY = "dsharbor.ui.motion";
const PAGE_URL = `http://127.0.0.1:${PORT}/mock.html`;

/** 还在栈里的 toast：正在退场（.is-leaving）的那条不算，它已经在往下掉了。 */
const LIVE_TOASTS = "#toasts .toast:not(.is-leaving)";

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
 * 打开一页并停在「环境/插件」分区（四类回执里三条的入口都在这里）。
 * `state` 会拼到 URL 的 ?state= 上（预览台在首轮渲染前覆盖假状态），
 * `motion` 预置动效偏好（null=保持默认开）。
 */
async function openEnvPanel(browser, { state = null, motion = null } = {}) {
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

/** 读当前 toast 栈：容器的播报属性 + 每条的文案与语气。 */
function readToasts(page) {
  return page.evaluate(() => {
    const host = document.querySelector("#toasts");
    if (!host) {
      return null;
    }
    return {
      role: host.getAttribute("role"),
      ariaLive: host.getAttribute("aria-live"),
      items: [...host.querySelectorAll(".toast:not(.is-leaving)")].map((el) => ({
        text: (el.querySelector(".toast-body")?.textContent ?? "").trim(),
        kind: el.dataset.kind ?? null,
      })),
    };
  });
}

/** 轮询到「还在栈里的 toast 正好 n 条」为止；超时由 puppeteer 抛错。 */
function waitToastCount(page, count, timeout = 5000) {
  return page.waitForFunction(
    (sel, n) => document.querySelectorAll(sel).length === n,
    { timeout },
    LIVE_TOASTS,
    count,
  );
}

/** 点一次「全部更新」：批量更新收尾会出一条 ok toast（假后端的汇总文案带成功条数）。 */
async function runUpdateAll(page) {
  const disabled = await page.$eval("#btn-plugin-update-all", (el) => el.disabled);
  assert.equal(disabled, false, "「全部更新」应当可点：环境面板加载完会先查一次更新");
  await page.click("#btn-plugin-update-all");
}

/**
 * 新建一个空白环境：走「环境名」浮窗，成功后浮窗收掉、结果写成一条 toast。
 *
 * 整段压成一次 page.evaluate：全套并行时每条 puppeteer 往返都要等渲染主线程，
 * 若拆成 5 个往返，4 次调用就会越过 toast 的 3.6s 保持期，前面的条先自然过期，
 * 让「最多 3 条」的断言看起来像失败。单往返则 4 次稳稳落在同一条时间窗里。
 */
async function createEnv(page, name) {
  const created = await page.evaluate(async (value) => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const deadline = Date.now() + 5000;
    document.querySelector("#btn-profile-create").click();
    let input = null;
    while (Date.now() < deadline) {
      const modal = document.querySelector("#modal-name");
      input = document.querySelector("#profile-manage-name");
      if (modal && !modal.classList.contains("hidden") && input) {
        break;
      }
      await wait(10);
    }
    if (!input) {
      return false;
    }
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#btn-name-confirm").click();
    while (Date.now() < deadline) {
      if (document.querySelector("#modal-name").classList.contains("hidden")) {
        return true;
      }
      await wait(10);
    }
    return false;
  }, name);
  assert.equal(created, true, `新建环境「${name}」没走完`);
}

/**
 * 点一次插件总开关。假后端在 DSH 正在跑（session: "running"）时会直接拒绝，
 * 于是这条链路固定吐同一句失败文案——正好用来验「同文案不叠条」。
 * 返回这次失败落在卡上的那句提示，等它也出现就说明动作真的走完了。
 */
async function failOneToggle(page) {
  // 挑第一颗当前是「开」的开关：点过去是「关」，失败文案随之固定，两次点击撞出同一句。
  await page.evaluate(() => {
    document.querySelector('#plugin-list [data-plugin][aria-checked="true"]').click();
  });
  await page.waitForFunction(
    () => {
      const note = document.querySelector("#plugin-note");
      return !note.classList.contains("hidden") && note.textContent.includes("切换插件开关失败");
    },
    { timeout: 5000 },
  );
  return page.$eval("#plugin-note", (el) => el.textContent.trim());
}

let preview;
let browser;

before(async () => {
  if (skipReason) {
    return;
  }
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

test("动作收尾：右下角出一条 toast，文案是后端那句话，容器礼貌播报且不抢焦点", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser);
  try {
    const before = await readToasts(page);
    assert.ok(before, "页面上应当有 #toasts 播报容器");
    assert.equal(before.role, "status", `容器应当是 role="status"，实际 ${before.role}`);
    assert.equal(before.ariaLive, "polite", `容器应当是 aria-live="polite"，实际 ${before.ariaLive}`);
    assert.equal(before.items.length, 0, "还没做事时不该有 toast");

    await runUpdateAll(page);
    await waitToastCount(page, 1);

    const after = await readToasts(page);
    assert.equal(after.items.length, 1, "更新收尾应当出 1 条 toast");
    const toast = after.items[0];
    assert.match(toast.text, /全部更新完成/, `文案应是后端的汇总，实际「${toast.text}」`);
    assert.match(toast.text, /重启 DSH 后生效/, "批量更新的汇总应带上「重启 DSH 后生效」");
    assert.equal(toast.kind, "ok", `成功的回执语气应是 ok，实际 ${toast.kind}`);

    const focusedInToast = await page.evaluate(() => {
      const active = document.activeElement;
      return Boolean(active && document.querySelector("#toasts")?.contains(active));
    });
    assert.equal(focusedInToast, false, "toast 不该抢焦点");
  } finally {
    await page.close();
  }
});

test("最多 3 条：连出 4 条不同文案，最旧的那条被挤掉", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser);
  try {
    for (const name of ["t1", "t2", "t3", "t4"]) {
      await createEnv(page, name);
    }
    await waitToastCount(page, 3, 8000);

    const stack = await readToasts(page);
    assert.equal(stack.items.length, 3, "同时最多只留 3 条");
    const texts = stack.items.map((item) => item.text);
    assert.equal(
      texts.some((text) => text.includes("「t1」")),
      false,
      `最旧的「t1」应当被挤掉，实际栈里是 ${JSON.stringify(texts)}`,
    );
    for (const name of ["t2", "t3", "t4"]) {
      assert.equal(
        texts.some((text) => text.includes(`「${name}」`)),
        true,
        `「${name}」应当还在栈里，实际 ${JSON.stringify(texts)}`,
      );
    }
  } finally {
    await page.close();
  }
});

test("同文案去重：同样的失败再来一次，不叠新条", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser, { state: { session: "running" } });
  try {
    const firstNote = await failOneToggle(page);
    await waitToastCount(page, 1);
    const first = (await readToasts(page)).items[0];
    assert.match(first.text, /切换插件开关失败/, `失败回执文案不对：「${first.text}」`);
    assert.equal(first.kind, "error", `失败回执语气应是 error，实际 ${first.kind}`);

    const secondNote = await failOneToggle(page);
    assert.equal(secondNote, firstNote, "两次失败落在卡上的同一句提示，说明确实是同一条文案");
    // 第一次的 toast 还没到点；再来一次只该刷新它，不该变成两条。
    await sleep(300);
    const stack = await readToasts(page);
    assert.equal(stack.items.length, 1, `同文案不该叠条，实际 ${stack.items.length} 条`);
    assert.equal(stack.items[0].text, first.text, "栈里应当还是原来那一条");
  } finally {
    await page.close();
  }
});

test("自动消失：先停留一会儿，再自己退场", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser, { state: { session: "running" } });
  try {
    await failOneToggle(page);
    await waitToastCount(page, 1);

    // 不写死毫秒：只要求「不是立刻消失」，然后轮询到 0。
    await sleep(800);
    assert.equal((await readToasts(page)).items.length, 1, "刚出来的 toast 不该立刻消失");

    await waitToastCount(page, 0, 8000);
    const empty = await readToasts(page);
    assert.equal(empty.items.length, 0, "到点应当自动退场");
  } finally {
    await page.close();
  }
});

test("关闭按钮：可访问名「关闭提示」，点一下就收掉", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser, { state: { session: "running" } });
  try {
    await failOneToggle(page);
    await waitToastCount(page, 1);

    const label = await page.$eval("#toasts .toast .toast-close", (el) => el.getAttribute("aria-label"));
    assert.equal(label, "关闭提示", `关闭按钮的可访问名应为「关闭提示」，实际 ${label}`);

    await page.click("#toasts .toast .toast-close");
    await waitToastCount(page, 0);
    assert.equal((await readToasts(page)).items.length, 0, "点关闭后这条应当没了");
  } finally {
    await page.close();
  }
});

test("环境动作失败也要回执：名字被拒时，浮窗红字与 error toast 同时在", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser);
  try {
    // 「web」这个环境本来就存在，新建同名环境会被假后端拒绝（与真后端同一套名字规则）。
    const rejected = await page.evaluate(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms));
      const deadline = Date.now() + 5000;
      document.querySelector("#btn-profile-create").click();
      let input = null;
      while (Date.now() < deadline) {
        input = document.querySelector("#profile-manage-name");
        if (input && !document.querySelector("#modal-name").classList.contains("hidden")) {
          break;
        }
        await wait(10);
      }
      if (!input) {
        return null;
      }
      input.value = "web";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#btn-name-confirm").click();
      // 失败会把红字显出来、浮窗留着不关。
      while (Date.now() < deadline) {
        const err = document.querySelector("#profile-manage-error");
        if (err && !err.classList.contains("hidden") && err.textContent.trim()) {
          return err.textContent.trim();
        }
        await wait(10);
      }
      return null;
    });
    assert.ok(rejected && /已经有同名环境/.test(rejected), `浮窗里应留下名字被拒的原因，实际「${rejected}」`);

    // 除了浮窗红字，还要有一条 error toast（规格：没做成也要回执）。
    await waitToastCount(page, 1);
    const stack = await readToasts(page);
    assert.equal(stack.items[0].kind, "error", `失败回执语气应是 error，实际 ${stack.items[0].kind}`);
    // 后端是直接抛字符串（而不是回 ok:false）时，toast 会带上「环境操作没有完成：」前缀；
    // 它必须把同一句原因原样带出来，别让人在角落看到一句无法对照的话。
    assert.ok(
      stack.items[0].text.includes(rejected),
      `toast 应原样带上浮窗里那句原因，实际「${stack.items[0].text}」`,
    );
  } finally {
    await page.close();
  }
});

test("关动效：toast 仍瞬时出现且看得见", { skip: skipReason }, async () => {
  const page = await openEnvPanel(browser, { state: { session: "running" }, motion: "off" });
  try {
    await failOneToggle(page);
    await waitToastCount(page, 1);

    const look = await page.evaluate(() => {
      const el = document.querySelector("#toasts .toast:not(.is-leaving)");
      if (!el) {
        return null;
      }
      const style = window.getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return {
        opacity: style.opacity,
        visibility: style.visibility,
        display: style.display,
        width: box.width,
        height: box.height,
      };
    });
    assert.ok(look, "关动效时 toast 仍应出现在 DOM 里");
    assert.notEqual(look.opacity, "0", "关动效时 toast 不该是透明不可见的");
    assert.equal(look.visibility, "visible", `关动效时 toast 应可见，实际 ${look.visibility}`);
    assert.notEqual(look.display, "none", "关动效时 toast 不该被 display:none 吞掉");
    assert.ok(look.width > 0 && look.height > 0, "关动效时 toast 应占位（有尺寸）");
  } finally {
    await page.close();
  }
});
