/**
 * 前端接缝测试：面板与容器（#36）—— 分区滑块、折叠块、环境卡悬停。
 *
 * 只测「浏览器里才说得清」的三处接缝：
 *  1. 左栏分区选中改成一块滑动的指示：点另一个分区后指示块按序号换位，
 *     快速连点也只停在最后点的那个分区上。
 *  2. 内容区入场：切过去的分区带入场类、首个子项挂着入场动画，动画跑完后位移归零。
 *  3. 折叠块：展开后内容撑出高度、收起后归零，箭头同步转；键盘 Enter 仍能开合（原生语义）。
 *  4. 环境卡：悬停上浮 1px、阴影加深、右侧「更多」入口淡入；键盘聚焦到卡内元素同样出现。
 *  5. 关掉动效后切分区瞬时到位，不留动画中的中间态。
 *
 * 不断言毫秒数与 keyframes 名字以外的实现细节：时长只断言「有过过渡/动画」这一事实。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/mock.html）。
 * 跑法：`node --test test/frontend/motion-panels.test.mjs`
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
// 独占端口：log 8207 / switch 8208 / picker 8209 / toolbar 8210 / update 8211 / badge 8213 /
// danger 8214 / motion-pref 8215 / 本文件（#36 面板与容器）8219。
const PORT = 8219;
const PANEL_KEY = "dsharbor.ui.panel";
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

/** 新开一页，预置分区与动效偏好后重载；停在 `panel` 那个分区上。 */
async function openApp(browser, { panel = "launch", motion = null } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    (panelKey, motionKey, panelValue, motionValue) => {
      window.localStorage.setItem(panelKey, panelValue);
      window.localStorage.removeItem(motionKey);
      if (motionValue !== null) window.localStorage.setItem(motionKey, motionValue);
    },
    PANEL_KEY,
    MOTION_KEY,
    panel,
    motion,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-panel-btn="launch"]');
  // 等左栏那块指示块拿到「首帧贴位完成」的标记（main.ts 在下一帧才给 .rail[data-ready]，
  // 从那时起才允许过渡）。不等它就读，会偶发读到 transition: none，测出的位移是硬跳。
  await page.waitForFunction(() => document.querySelector(".rail[data-ready]") !== null, { timeout: 5000 });
  await sleep(150); // 等首帧内联脚本与挂载跑完、样式重算
  return page;
}

/** 读左栏选中指示块的位置：序号变量、水平位移、按钮之间的实际间距。 */
function readIndicator(page) {
  return page.evaluate(() => {
    const ind = document.querySelector(".rail-ind");
    if (!ind) return null;
    const buttons = [...document.querySelectorAll("[data-panel-btn]")];
    const buttons2 = buttons.map((b) => b.offsetTop);
    const cs = getComputedStyle(ind);
    const i = Number(ind.style.getPropertyValue("--i") || "0");
    const ty = (() => {
      const m = /matrix\(([^)]+)\)/.exec(cs.transform);
      return m ? Number(m[1].split(",")[5]) : null;
    })();
    return {
      i,
      ty,
      step: buttons2.length > 1 ? buttons2[1] - buttons2[0] : 0,
      transitionProperty: cs.transitionProperty,
      transitionDuration: cs.transitionDuration,
    };
  });
}

/** 读折叠块：整块高度、summary 高度、箭头矩阵。 */
function readDetails(page) {
  return page.evaluate(() => {
    const box = document.querySelector('[data-panel="integ"] .log-box');
    if (!box) return null;
    const summary = box.querySelector("summary");
    const chev = summary.querySelector(".chev");
    return {
      open: box.open,
      total: box.getBoundingClientRect().height,
      summary: summary.getBoundingClientRect().height,
      chevTransform: getComputedStyle(chev).transform,
    };
  });
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

test("切换分区后指示块换位：序号与位移都跟着选中项走", { skip: skipReason }, async () => {
  const page = await openApp(browser, { panel: "launch" });
  try {
    const start = await readIndicator(page);
    assert.ok(start, "左栏里应有选中指示块 .rail-ind");
    assert.equal(start.i, 0, "启动时指示块应停在第一个分区（启动方式）");
    assert.equal(start.transitionProperty, "transform", "指示块应只对 transform 做过渡（不整块淡入）");

    // 托盘与网络是第 4 项（序号 3，从 0 起）。
    await page.click('[data-panel-btn="traynet"]');
    await sleep(500); // 等过渡跑完（含回弹），读静止态
    const moved = await readIndicator(page);
    assert.equal(moved.i, 3, "点第 4 项后序号应为 3");
    assert.ok(moved.step > 0, "应能量到两个分区按钮的间距");
    assert.ok(
      Math.abs(moved.ty - moved.step * 3) < 0.6,
      `指示块应滑到第 4 项的位置（期望 ${moved.step * 3}px，实测 ${moved.ty}px）`,
    );
    assert.notEqual(moved.transitionDuration, "0s", "动效开着时位移应有过渡，不是硬跳");
  } finally {
    await page.close();
  }
});

test("快速连续点不同分区：指示块跟上，最终停在最后那个分区", { skip: skipReason }, async () => {
  const page = await openApp(browser, { panel: "launch" });
  try {
    // 连点三个分区，中间不等过渡跑完。
    await page.click('[data-panel-btn="env"]');
    await page.click('[data-panel-btn="integ"]');
    await page.click('[data-panel-btn="log"]');
    await sleep(500);
    const state = await readIndicator(page);
    assert.equal(state.i, 4, "最后点的是日志（序号 4）");
    assert.ok(
      Math.abs(state.ty - state.step * 4) < 0.6,
      `指示块最终应停在第 5 项（期望 ${state.step * 4}px，实测 ${state.ty}px）`,
    );
    // 选中态只留一块指示，按钮自身不再各自铺底色。
    // 先把指针挪开：全局 `button:hover` 会在点过之后留一层悬停底色，那是 #28 的悬停反馈，
    // 不是选中态。这里要验的是「静止态下选中项自己不再铺底」。
    await page.mouse.move(1, 1);
    await sleep(200);
    const buttonBg = await page.evaluate(() => {
      const active = document.querySelector('[data-panel-btn="log"]');
      return getComputedStyle(active).backgroundColor;
    });
    assert.equal(buttonBg, "rgba(0, 0, 0, 0)", "选中项不该再铺静态底色（底色由滑动指示块统一给）");
  } finally {
    await page.close();
  }
});

test("内容区入场：切过去的分区带入场类、卡里的内容有入场动画，大卡片自己不动", { skip: skipReason }, async () => {
  const page = await openApp(browser, { panel: "launch" });
  try {
    await page.click('[data-panel-btn="traynet"]');
    const entering = await page.evaluate(() => {
      const panel = document.querySelector('.panel[data-panel="traynet"]');
      const card = panel?.querySelector(".main-card");
      const inner = card?.querySelector(":scope > *");
      if (!panel || !card || !inner) return null;
      return {
        className: panel.className,
        cardAnimation: getComputedStyle(card).animationName,
        innerAnimation: getComputedStyle(inner).animationName,
        height: inner.getBoundingClientRect().height,
      };
    });
    assert.ok(entering, "应能读到托盘与网络分区");
    assert.match(entering.className, /(^|\s)is-enter(\s|$)/, "切入的分区应挂上入场类");
    assert.equal(entering.cardAnimation, "none", "大卡片本身固定不动，不跑入场动画");
    assert.equal(entering.innerAnimation, "panel-enter", "卡里的内容才跑入场动画");
    assert.ok(entering.height > 0, "入场时内容应已可见");

    await sleep(500);
    const settled = await page.evaluate(() => {
      const card = document.querySelector('.panel[data-panel="traynet"] .main-card');
      const inner = card?.querySelector(":scope > *");
      return {
        card: getComputedStyle(card).transform,
        inner: getComputedStyle(inner).transform,
        innerOpacity: getComputedStyle(inner).opacity,
      };
    });
    assert.equal(settled.card, "none", "大卡片全程不产生位移");
    assert.equal(settled.inner, "none", "入场动画跑完后内容位移应归零，不留中间态");
    // 入场只做位移、不做透明度：带 opacity 的话每次切分区内容都先整块消失再淡回来，
    // 连点几下就是「黑一下、亮一下」的频闪（维护者反馈过）。这里钉死「全程不透明」。
    assert.equal(settled.innerOpacity, "1", "入场动画不能淡入淡出，内容必须始终不透明");
  } finally {
    await page.close();
  }
});

test("内容区入场不自带淡入：动画刚开始时内容就已经完全不透明", { skip: skipReason }, async () => {
  const page = await openApp(browser, { panel: "launch" });
  try {
    await page.click('[data-panel-btn="integ"]');
    // 立刻读：此刻入场动画正跑在最开头（transform 还没归零），透明度必须已经是 1。
    const atStart = await page.evaluate(() => {
      const card = document.querySelector('.panel[data-panel="integ"] .main-card');
      const kids = card ? [...card.children] : [];
      return kids.map((el) => ({
        opacity: getComputedStyle(el).opacity,
        anims: el.getAnimations().length,
        transform: getComputedStyle(el).transform,
      }));
    });
    assert.ok(atStart.length > 0, "集成分区的卡里应有内容块");
    for (const one of atStart) {
      assert.equal(one.opacity, "1", `入场期间内容不该变透明（否则就是频闪），实测 ${one.opacity}`);
      // 动画确实在跑（transform 已离开 none 或者已经归零），这边只关心 opacity 不被碰。
      assert.ok(one.anims <= 1, `同一个元素上最多一条入场动画，实测 ${one.anims} 条`);
    }
  } finally {
    await page.close();
  }
});

test("反复点已选中项：指示块与按钮尺寸始终一致，不会出现第二层框", { skip: skipReason }, async () => {
  const page = await openApp(browser, { panel: "env" });
  try {
    await page.mouse.move(1, 1);
    await sleep(200);
    const box = await page.evaluate(() => {
      const b = document.querySelector('.rail .ico-item[aria-current="true"]');
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });

    const read = () =>
      page.evaluate(() => {
        const actives = [...document.querySelectorAll('.rail .ico-item[aria-current="true"]')];
        const inds = [...document.querySelectorAll(".rail .rail-ind")];
        const b = actives[0].getBoundingClientRect();
        const i = inds[0].getBoundingClientRect();
        const cs = getComputedStyle(actives[0]);
        return {
          activeCount: actives.length,
          indCount: inds.length,
          btn: [+b.width.toFixed(1), +b.height.toFixed(1)],
          ind: [+i.width.toFixed(1), +i.height.toFixed(1)],
          transform: cs.transform,
          boxShadow: cs.boxShadow,
        };
      });

    const baseline = await read();
    assert.equal(baseline.activeCount, 1, "任何时刻只能有一项是选中的");
    assert.equal(baseline.indCount, 1, "指示块只有一个实例（不要每次点击新建一个）");
    assert.deepEqual(baseline.btn, baseline.ind, "静止时按钮与指示块同尺寸");

    // 按住不放：全站那条 button:active 的缩放会把按钮缩到 97.2%，指示块不动 → 视觉两层框。
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await sleep(140);
    const pressed = await read();
    await page.mouse.up();
    assert.equal(pressed.transform, "none", "导航项不参与全站按压缩放（否则和指示块错开成两个框）");
    assert.equal(pressed.boxShadow, "none", "导航项按下不加内阴影（那是第二层框）");
    assert.deepEqual(pressed.btn, pressed.ind, "按住时按钮仍与指示块同尺寸");

    // 反复点已选中项：全程单框、几何不抖。
    for (let i = 0; i < 6; i++) {
      await page.mouse.click(box.x, box.y, { delay: 12 });
      await sleep(60);
      const s = await read();
      assert.equal(s.activeCount, 1, `第 ${i + 1} 次点击后仍只能有一个选中项`);
      assert.equal(s.indCount, 1, `第 ${i + 1} 次点击后仍只能有一个指示块`);
      assert.equal(s.transform, "none", `第 ${i + 1} 次点击时按钮不该被缩放`);
      assert.deepEqual(s.btn, s.ind, `第 ${i + 1} 次点击时按钮与指示块应同尺寸`);
    }
  } finally {
    await page.close();
  }
});

test("折叠块：展开后内容撑出高度、收起后归零，箭头同步转", { skip: skipReason }, async () => {
  const page = await openApp(browser, { panel: "integ" });
  try {
    const closed = await readDetails(page);
    assert.ok(closed, "集成分区里应有折叠块 .log-box");
    assert.equal(closed.open, false, "折叠块默认收起");
    assert.equal(closed.chevTransform, "none", "收起时箭头不转");

    await page.click('[data-panel="integ"] .log-box summary');
    await sleep(500); // 等高度过渡跑完
    const opened = await readDetails(page);
    assert.equal(opened.open, true, "点一下 summary 应展开");
    assert.ok(
      opened.total - opened.summary > 20,
      `展开后内容应撑出高度（整块 ${opened.total}px，summary ${opened.summary}px）`,
    );
    assert.notEqual(opened.chevTransform, "none", "展开后箭头应转过去");

    await page.click('[data-panel="integ"] .log-box summary');
    await sleep(500); // 等收起过渡与延迟隐藏跑完
    const reclosed = await readDetails(page);
    assert.equal(reclosed.open, false, "再点一下应收起");
    assert.ok(
      Math.abs(reclosed.total - closed.total) < 0.6,
      `收起后内容高度应归零（原来 ${closed.total}px，收起后 ${reclosed.total}px）`,
    );
  } finally {
    await page.close();
  }
});

test("折叠块保留原生语义：键盘 Enter 能开、再按能合", { skip: skipReason }, async () => {
  const page = await openApp(browser, { panel: "integ" });
  try {
    const summary = '[data-panel="integ"] .log-box summary';
    // summary 自己可聚焦（原生 <details> 的键盘入口），不需要自绘控件。
    await page.focus(summary);
    const focused = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), summary);
    assert.equal(focused, true, "summary 应能直接拿到焦点");

    await page.keyboard.press("Enter");
    await sleep(500);
    const opened = await readDetails(page);
    assert.equal(opened.open, true, "Enter 应展开原生折叠块");
    assert.ok(opened.total - opened.summary > 20, "键盘展开后内容同样撑出高度");

    await page.keyboard.press("Enter");
    await sleep(500);
    const reclosed = await readDetails(page);
    assert.equal(reclosed.open, false, "再按一次 Enter 应合上");
  } finally {
    await page.close();
  }
});

test("环境卡悬停：上浮 1px、阴影加深、右侧更多入口淡入", { skip: skipReason }, async () => {
  const page = await openApp(browser, { panel: "env" });
  try {
    await page.waitForSelector(".env-card .env-more", { timeout: 5000 });
    const rest = await page.evaluate(() => {
      const card = document.querySelector(".env-card");
      const more = card.querySelector(".env-more");
      const cs = getComputedStyle(card);
      return {
        transform: cs.transform,
        shadow: cs.boxShadow,
        moreOpacity: getComputedStyle(more).opacity,
        moreFocusable: more.tabIndex >= 0 && !more.disabled,
      };
    });
    assert.equal(rest.moreOpacity, "0", "指针不在卡上时「更多」入口应淡出（不占视觉）");
    assert.equal(rest.moreFocusable, true, "「更多」入口本身要可聚焦（触屏与纯键盘不走悬停）");

    await page.hover(".env-card");
    await sleep(300);
    const hovered = await page.evaluate(() => {
      const card = document.querySelector(".env-card");
      const cs = getComputedStyle(card);
      return {
        transform: cs.transform,
        shadow: cs.boxShadow,
        moreOpacity: getComputedStyle(card.querySelector(".env-more")).opacity,
      };
    });
    const ty = (() => {
      const m = /matrix\(([^)]+)\)/.exec(hovered.transform);
      return m ? Number(m[1].split(",")[5]) : 0;
    })();
    assert.ok(Math.abs(ty + 1) < 0.2, `悬停应上浮 1px（实测 ${hovered.transform}）`);
    assert.notEqual(hovered.shadow, rest.shadow, "悬停时阴影应加深一档");
    assert.equal(hovered.moreOpacity, "1", "悬停时「更多」入口应淡入");
  } finally {
    await page.close();
  }
});

test("环境卡键盘聚焦：焦点进卡内元素时「更多」入口同样出现", { skip: skipReason }, async () => {
  const page = await openApp(browser, { panel: "env" });
  try {
    await page.waitForSelector(".env-card .env-card-main", { timeout: 5000 });
    await page.focus(".env-card .env-card-main");
    await sleep(300);
    const state = await page.evaluate(() => {
      const card = document.querySelector(".env-card");
      return {
        within: card.matches(":focus-within"),
        moreOpacity: getComputedStyle(card.querySelector(".env-more")).opacity,
      };
    });
    assert.equal(state.within, true, "焦点进卡片后应命中 :focus-within");
    assert.equal(state.moreOpacity, "1", "键盘聚焦时「更多」入口应出现（不依赖悬停）");
  } finally {
    await page.close();
  }
});

test("关掉动效后切分区瞬时到位：不留动画中的中间态", { skip: skipReason }, async () => {
  const page = await openApp(browser, { panel: "launch", motion: "off" });
  try {
    const instant = await page.evaluate(async () => {
      const button = document.querySelector('[data-panel-btn="about"]');
      if (!button) return null;
      button.click();
      // 下一帧读：动效被中和后，指示块与内容区都应该已经落在终态上。
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const ind = document.querySelector(".rail-ind");
      const panel = document.querySelector('.panel[data-panel="about"]');
      const first = panel?.querySelector(".panel-body > *");
      const ty = (() => {
        const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(ind).transform);
        return m ? Number(m[1].split(",")[5]) : null;
      })();
      const buttons = [...document.querySelectorAll("[data-panel-btn]")];
      const step = buttons[1].offsetTop - buttons[0].offsetTop;
      return {
        i: Number(ind.style.getPropertyValue("--i") || "0"),
        ty,
        step,
        hidden: panel.classList.contains("hidden"),
        transform: first ? getComputedStyle(first).transform : null,
      };
    });
    assert.ok(instant, "应能点到「关于」分区");
    assert.equal(instant.i, 5, "关掉动效后也照样换到第 6 个分区");
    assert.equal(instant.hidden, false, "目标分区应已显示");
    assert.ok(
      Math.abs(instant.ty - instant.step * 5) < 0.6,
      `关掉动效后指示块应直接落在终态（期望 ${instant.step * 5}px，实测 ${instant.ty}px）`,
    );
    assert.equal(instant.transform, "none", "关掉动效后内容区不该停在入场位移上");
  } finally {
    await page.close();
  }
});
