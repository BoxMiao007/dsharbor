/**
 * 前端接缝测试：左栏分区顺序、以及「设置」分区里的 WSL 总开关。
 *
 * 覆盖四条接缝——都是用户能直接看到/用到的结果：
 *  1. 左栏顺序改成 启动方式 / 环境插件 / 集成 / 日志 / 设置 / 关于（「设置」与「日志」互换后，
 *     日志在上）。
 *  2. 默认开着 WSL：运行环境下拉里有 WSL 发行版；关掉开关后只剩「默认」，保存的配置里
 *     `wslEnabled` 变成 false，并且关闭动作不再触发发行版探测。
 *  3. 配置里存着 `wslEnabled: false` 时，启动整段跳过发行版探测（一次 wsl.exe 都不跑），
 *     下拉里只有「默认」。
 *  4. 在设置里重新打开 WSL：发行版选项回来（按需去读缓存/探测）。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/settings-wsl.test.mjs`
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
const PORT = 8229; // 独占端口:见 AGENTS.md「容易踩的」里的端口表
const PAGE_URL = `http://127.0.0.1:${PORT}/mock.html`;

const skipReason = !existsSync(PUPPETEER_CORE)
  ? `找不到 puppeteer-core：${PUPPETEER_CORE}（用 DSHARBOR_PUPPETEER 指定）`
  : !existsSync(BROWSER)
    ? `找不到浏览器：${BROWSER}（用 DSHARBOR_BROWSER 指定）`
    : false;

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

/** 一份完整的壳设置（假后端 `load_shell_config` 会把它平铺回来）。 */
function shellPrefs(overrides = {}) {
  return {
    profile: "web",
    downloadSource: "inherit",
    proxyMode: "system",
    proxyAddress: "",
    cliIntegration: false,
    wslEnabled: true,
    ...overrides,
  };
}

async function openPage(browser, state = null) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  const url = state ? `${PAGE_URL}?state=${encodeURIComponent(JSON.stringify(state))}` : PAGE_URL;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#npx-runtime-picker .picker-btn");
  return page;
}

/** 运行环境下拉框里的候选文案（列表收着也在 DOM 里）。 */
function runtimeOptions(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#npx-runtime-picker .picker-option .text")).map(
      (el) => el.textContent ?? "",
    ),
  );
}

function waitRuntimeOption(page, text, timeout = 5000) {
  return page.waitForFunction(
    (needle) =>
      Array.from(document.querySelectorAll("#npx-runtime-picker .picker-option .text")).some((el) =>
        (el.textContent ?? "").includes(needle),
      ),
    { timeout },
    text,
  );
}

async function openSettings(page) {
  await page.click('[data-panel-btn="settings"]');
  await page.waitForSelector("#wsl-toggle");
  await sleep(120); // 等分区入场动效与重算
}

function wslChecked(page) {
  return page.evaluate(() => document.querySelector("#wsl-toggle")?.getAttribute("aria-checked"));
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

test("左栏顺序：日志在设置上方，设置分区里有 WSL 开关", { skip: skipReason }, async () => {
  const page = await openPage(browser);
  try {
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-panel-btn] .txt")).map((el) => el.textContent ?? ""),
    );
    assert.deepEqual(
      labels,
      ["启动方式", "环境/插件", "集成", "日志", "设置", "关于"],
      `左栏顺序应把日志排在设置上方，实际 ${JSON.stringify(labels)}`,
    );

    await openSettings(page);
    assert.equal(await wslChecked(page), "true", "WSL 开关默认开着");
    const panel = await page.evaluate(() => {
      const section = document.querySelector('.panel[data-panel="settings"]');
      return {
        exists: section !== null,
        hasNetwork: (section?.textContent ?? "").includes("网络与代理"),
        hasMotion: (section?.textContent ?? "").includes("界面动效"),
      };
    });
    assert.equal(panel.exists, true, "设置分区应存在");
    assert.equal(panel.hasNetwork, true, "原「网络与代理」内容应还在设置分区里");
    assert.equal(panel.hasMotion, true, "原「动效」内容应还在设置分区里");
  } finally {
    await page.close();
  }
});

test("关掉 WSL：运行环境只剩「默认」、配置记成 false、不再触发探测", { skip: skipReason }, async () => {
  const page = await openPage(browser, { savedShell: shellPrefs() });
  try {
    // 默认开着：探测回来后下拉里有发行版。
    await waitRuntimeOption(page, "WSL - Ubuntu");
    await openSettings(page);
    const probeCallsBefore = await page.evaluate(() => window.__MOCK_STATE__.calls["wsl_distro_info"] ?? 0);

    await page.click("#wsl-toggle");
    await page.waitForFunction(() => document.querySelector("#wsl-toggle")?.getAttribute("aria-checked") === "false", {
      timeout: 3000,
    });
    await sleep(150);

    assert.deepEqual(await runtimeOptions(page), ["默认"], "关掉 WSL 后运行环境只剩「默认」");
    const saved = await page.evaluate(() => window.__MOCK_STATE__.lastSavedShell || null);
    assert.ok(saved, "开关变化应触发一次保存");
    assert.equal(saved.wslEnabled, false, "保存的配置里 wslEnabled 应为 false");

    const probeCallsAfter = await page.evaluate(() => window.__MOCK_STATE__.calls["wsl_distro_info"] ?? 0);
    assert.equal(probeCallsAfter, probeCallsBefore, "关闭动作不该再触发发行版探测");
  } finally {
    await page.close();
  }
});

test("配置里关着 WSL 时，启动整段跳过发行版探测", { skip: skipReason }, async () => {
  const page = await openPage(browser, { savedShell: shellPrefs({ wslEnabled: false }) });
  try {
    assert.deepEqual(await runtimeOptions(page), ["默认"], "启动时运行环境只有「默认」");
    await sleep(250); // 给「万一还是会探测」留一个窗口
    const calls = await page.evaluate(() => ({
      probe: window.__MOCK_STATE__.calls["wsl_distro_info"] ?? 0,
      cached: window.__MOCK_STATE__.calls["wsl_distro_info_cached"] ?? 0,
    }));
    assert.equal(calls.probe, 0, "WSL 关着时不该调 wsl_distro_info");
    assert.equal(calls.cached, 0, "WSL 关着时连缓存都不该读");
  } finally {
    await page.close();
  }
});

test("在设置里重新打开 WSL：发行版选项回来", { skip: skipReason }, async () => {
  const page = await openPage(browser, { savedShell: shellPrefs({ wslEnabled: false }) });
  try {
    await openSettings(page);
    assert.equal(await wslChecked(page), "false", "读回配置后开关应为关");

    await page.click("#wsl-toggle");
    await page.waitForFunction(() => document.querySelector("#wsl-toggle")?.getAttribute("aria-checked") === "true", {
      timeout: 3000,
    });
    await waitRuntimeOption(page, "WSL - Ubuntu");
    const saved = await page.evaluate(() => window.__MOCK_STATE__.lastSavedShell || null);
    assert.equal(saved?.wslEnabled, true, "打开后配置应记成 true");
  } finally {
    await page.close();
  }
});
