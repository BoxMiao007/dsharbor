/**
 * 前端接缝测试：按钮手感（悬停光环、按压缩放、重启进行中的工作态）。
 *
 * 只测浏览器里能观察到的结果，不断言毫秒数、也不断言 keyframes 名字——
 * 节奏与曲线由 00-tokens.css 统一出口决定，改数值不该让这些测试变红：
 *  1. 圆钮（停止 / 重启 DSH）悬停时出现一圈外光环（`box-shadow` 从 none 变成有值），
 *     图标轻微下沉一点点。
 *  2. 悬停不再有「停止闪方块 / 重启转一圈」那两套一次性动画（图标自身的 animation 为 none）；
 *     点击后的持续转动（`.is-restarting`）仍然保留。
 *  3. 按住圆钮明显缩一圈（比普通按钮缩得深），松手回弹；禁用态不缩。
 *  4. 任意普通按钮与主按钮按下都有一致的轻微下沉 + 内阴影。
 *  5. 重启 DSH 进行中：光环常亮、图标持续转。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/motion-interactions.test.mjs`
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
const PORT = 8216;
const PAGE_URL = `http://127.0.0.1:${PORT}/mock.html`;

/** 按下时圆钮与普通按钮的收缩目标值：#28 规格 0.94 / 0.972。 */
const PRESS_ROUND = 0.94;
const PRESS_PLAIN = 0.972;

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
  // 首轮 dsh_status 渲染完再量（按钮形态与显隐在这之后才定）。
  await page.waitForFunction(() => document.querySelectorAll("[data-panel]").length > 0);
  await sleep(150);
  return page;
}

/**
 * 读一颗按钮的外部可观察样式：外光环（box-shadow）、自身缩放（transform 矩阵解出的 scale）、
 * 图标的下移量与图标动画。返回值里没有任何毫秒数。
 */
function readButton(page, id) {
  return page.evaluate((btnId) => {
    const el = document.getElementById(btnId);
    const svg = el.querySelector("svg");
    const m = new DOMMatrix(getComputedStyle(el).transform);
    const icon = svg ? new DOMMatrix(getComputedStyle(svg).transform) : null;
    const svgStyle = svg ? getComputedStyle(svg) : null;
    return {
      className: el.className,
      disabled: el.disabled,
      visible: el.getBoundingClientRect().width > 0,
      boxShadow: getComputedStyle(el).boxShadow,
      scaleX: m.a,
      scaleY: m.d,
      iconDip: icon ? icon.f : null,
      iconAnimation: svgStyle?.animationName ?? null,
      iconIterations: svgStyle?.animationIterationCount ?? null,
    };
  }, id);
}

/** 把指针悬到按钮中心、等过渡落定后再读。 */
async function hoverAndRead(page, id) {
  await page.hover(`#${id}`);
  // 过渡时长是一百多毫秒量级，等它走完再读，避免量到中间值。
  await sleep(260);
  return readButton(page, id);
}

/** 悬停后按住不放，等缩放过渡落定再读；随后把指针移开再松手，避免触发 click。 */
async function pressAndRead(page, id) {
  const box = await (await page.$(`#${id}`)).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(180);
  await page.mouse.down();
  await sleep(220);
  const read = await readButton(page, id);
  await page.mouse.move(4, 4);
  await page.mouse.up();
  await sleep(60);
  return read;
}

const near = (actual, expected, tolerance = 0.01) => Math.abs(actual - expected) <= tolerance;

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

test("悬停圆钮：出现一圈外光环，图标轻微下沉", { skip: skipReason }, async () => {
  const page = await openPage(browser, { session: "running" });
  try {
    for (const id of ["btn-toggle", "btn-restart"]) {
      // 未悬停时先确认光环是关的，否则「悬停后非 none」可能本来就有。
      const idle = await readButton(page, id);
      assert.equal(idle.boxShadow, "none", `「${id}」悬停前不该有外光环，实际 ${idle.boxShadow}`);
      assert.equal(Math.round(idle.iconDip * 10) / 10, 0, `「${id}」悬停前图标应归位`);

      const hovered = await hoverAndRead(page, id);
      assert.notEqual(hovered.boxShadow, "none", `悬停「${id}」应出现外光环，实际 box-shadow 为 none`);
      assert.match(hovered.boxShadow, /\d+px/, `外光环应带扩散半径，实际 ${hovered.boxShadow}`);
      // 图标下沉一点点：介于 0 与 2px 之间，不动或跳太远都算跑偏。
      assert.ok(
        hovered.iconDip > 0.4 && hovered.iconDip < 2,
        `悬停「${id}」图标应轻微下沉（0~2px），实际 ${hovered.iconDip}px`,
      );

      // 移开还原：光环收掉、图标归位。
      await page.mouse.move(4, 4);
      await sleep(260);
      const back = await readButton(page, id);
      assert.equal(back.boxShadow, "none", `移开后「${id}」的外光环应收掉，实际 ${back.boxShadow}`);
    }
  } finally {
    await page.close();
  }
});

test("悬停不再闪方块 / 转一圈：圆钮悬停时图标自身没有一次性动画", { skip: skipReason }, async () => {
  const page = await openPage(browser, { session: "running" });
  try {
    for (const id of ["btn-toggle", "btn-restart"]) {
      await page.hover(`#${id}`);
      // 原来的两套动画在悬停后 300ms 才起势，等足够久再看它是否还在跑。
      await sleep(600);
      const hovered = await readButton(page, id);
      assert.ok(
        hovered.iconAnimation === "none" || hovered.iconAnimation === "",
        `悬停「${id}」不该再有图标动画，实际 animation-name 为 ${hovered.iconAnimation}`,
      );
    }
  } finally {
    await page.close();
  }
});

test("按住圆钮明显缩一圈，松手回弹；禁用时不缩", { skip: skipReason }, async () => {
  const page = await openPage(browser, { session: "running" });
  try {
    for (const id of ["btn-toggle", "btn-restart"]) {
      const pressed = await pressAndRead(page, id);
      assert.ok(
        near(pressed.scaleX, PRESS_ROUND, 0.02) && near(pressed.scaleY, PRESS_ROUND, 0.02),
        `按住「${id}」应缩到约 ${PRESS_ROUND}，实际 ${pressed.scaleX}`,
      );

      // 松手回弹：指针已移开，缩放回到 1。
      await sleep(260);
      const released = await readButton(page, id);
      assert.ok(
        near(released.scaleX, 1, 0.01),
        `松手后「${id}」应回弹到原尺寸，实际 ${released.scaleX}`,
      );
    }

    // 禁用态不缩：把「停止」置灰后按住，尺寸保持不变。
    await page.evaluate(() => {
      document.getElementById("btn-toggle").disabled = true;
    });
    const disabledPressed = await pressAndRead(page, "btn-toggle");
    assert.equal(disabledPressed.disabled, true, "前置：按钮应处于禁用态");
    assert.ok(
      near(disabledPressed.scaleX, 1, 0.01),
      `禁用态按下不该缩放，实际 ${disabledPressed.scaleX}`,
    );
  } finally {
    await page.close();
  }
});

test("任意普通按钮与主按钮按下都有一致的轻微下沉", { skip: skipReason }, async () => {
  // 停止态：「启动 DSH」是主按钮（.primary）长条，版本行尾的「重新获取」是普通方钮
  // （插件卡那张面板在停止态是收起的，按钮 rect 为 0，量不到）。
  const page = await openPage(browser, { session: "stopped" });
  try {
    for (const [id, kind] of [
      ["npx-versions-refresh", "普通按钮"],
      ["btn-toggle", "主按钮"],
    ]) {
      const pressed = await pressAndRead(page, id);
      assert.ok(
        near(pressed.scaleX, PRESS_PLAIN, 0.01) && near(pressed.scaleY, PRESS_PLAIN, 0.01),
        `${kind}「${id}」按下应缩到约 ${PRESS_PLAIN}，实际 ${pressed.scaleX}`,
      );
      // 内阴影同时加深一档：按下时 box-shadow 里应出现 inset。
      assert.match(pressed.boxShadow, /inset/, `${kind}按下应带内阴影，实际 ${pressed.boxShadow}`);
    }
  } finally {
    await page.close();
  }
});

test("重启进行中：光环常亮、图标持续转，直到结果出来", { skip: skipReason }, async () => {
  const page = await openPage(browser, { session: "running" });
  try {
    const idle = await readButton(page, "btn-restart");
    assert.equal(idle.boxShadow, "none", "重启进行前不该常亮光环");

    // 点「重启 DSH」并在同一次求值里读结果：转动窗口只有结果出来之前那一段，不能等。
    const afterClick = await page.evaluate(() => {
      const el = document.getElementById("btn-restart");
      el.click();
      const svg = el.querySelector("svg");
      const svgStyle = getComputedStyle(svg);
      return {
        className: el.className,
        boxShadow: getComputedStyle(el).boxShadow,
        iconAnimation: svgStyle.animationName,
        iconIterations: svgStyle.animationIterationCount,
      };
    });

    assert.match(afterClick.className, /is-restarting/, "点击重启后应进入 .is-restarting 工作态");
    assert.notEqual(afterClick.boxShadow, "none", "重启进行中光环应常亮，实际 box-shadow 为 none");
    assert.notEqual(afterClick.iconAnimation, "none", "重启进行中图标应转动，实际没有动画");
    assert.equal(afterClick.iconIterations, "infinite", `重启进行中图标应持续转，实际 ${afterClick.iconIterations}`);

    // 结果出来（假后端立刻回到 running）后收工：光环收掉、图标停转。
    await page.waitForFunction(
      () => !document.getElementById("btn-restart").classList.contains("is-restarting"),
      { timeout: 5_000 },
    );
    // 指针从按钮上挪开，等光环的淡出过渡走完再读（否则会量到过渡中间值）。
    await page.mouse.move(4, 4);
    await sleep(300);
    const settled = await readButton(page, "btn-restart");
    assert.equal(settled.boxShadow, "none", "重启结束后光环应跟着收掉");
    assert.ok(
      settled.iconAnimation === "none" || settled.iconAnimation === "",
      `重启结束后图标应停转，实际 ${settled.iconAnimation}`,
    );
  } finally {
    await page.close();
  }
});
