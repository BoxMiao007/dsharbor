/**
 * 前端接缝测试：「官方 npx 命令」的版本下拉（原「渠道」）。
 *
 * 只测这一个接缝——`#npx-version-picker` 展开后的列表：
 *  1. 首项固定是「自动最新版本」，徽章把 latest 标签名与它指向的版本号合成一枚（`latest 0.2.1-rc.2`），
 *     它不带版本号（选它 = 跟 latest 走）；
 *  2. 列表按新到旧直列官方发布过的版本，不打渠道分组；每个版本按 npm 的 dist-tag 挂 tag 徽章
 *     （latest / next / beta / alpha / canary / 自定义），顺序 latest → next → 其他字母序，
 *     最多 3 枚、超出折成「+N」；
 *  3. npx 缓存里已有的版本挂「已缓存」（数据来自 `npx_cached_versions`），它不占 tag 的 3 枚名额，
 *     排在 tag 徽章后面；选中的版本不额外挂「已装」
 *     （「已装」原来按「当前选中的值」判，选中未安装的版本也会误显示，已删）；
 *  4. 「选了会再下载」提示只有一种口径：缓存里已有该版本号、但那份是裸包名写法留下的 →
 *     「会再下载一份」（npx 按命令写法各存一份缓存）；钉版本写法（`dsh@<版本>`）直接复用
 *     缓存的那份不再提示——「已缓存」徽章已经说明，多一句是噪音（用户反馈，已删）；
 *  5. 末尾是「更多…」，每点一次再放 10 个，且点「更多」不收起弹层。
 *
 * 跑在普通浏览器里（假后端预览台 scripts/mock-preview.mjs），不起 Tauri 窗口。
 * 前置：先 `pnpm build`（预览台读 dist/index.html）。
 * 跑法：`node --test test/frontend/version-picker.test.mjs`
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
const PORT = 8209;
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

async function openLaunchPage(browser, state = null, waitText = "自动最新版本") {
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 900 });
  const url = state ? `${PAGE_URL}?state=${encodeURIComponent(JSON.stringify(state))}` : PAGE_URL;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#npx-version-picker .picker-btn");
  // 版本列表是异步读回来的：等首项从「正在读取…」变成目标文案（默认是「自动最新版本」，
  // 注入了已存版本的页面则是那个版本号本身）。
  await page.waitForFunction(
    (text) => document.querySelector("#npx-version-picker .picker-label")?.textContent.includes(text),
    { timeout: 5000 },
    waitText,
  );
  return page;
}

/** 展开下拉、等缓存徽章扫回来（onOpen 里现扫 npx 缓存）。 */
async function openList(page) {
  await page.click("#npx-version-picker .picker-btn");
  await page.waitForFunction(
    () => !document.querySelector("#npx-version-picker .picker-list").classList.contains("hidden"),
    { timeout: 3000 },
  );
  // 等「已缓存」徽章出现：它来自一次异步 invoke，落地后 picker 会重铺候选。
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("#npx-version-picker .picker-badge")).some((b) => b.textContent === "已缓存"),
    { timeout: 5000 },
  );
  await sleep(100);
}

function readList(page) {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("#npx-version-picker .picker-option"));
    return items.map((li) => {
      // 只看行里直接挂的徽章：气泡内部也有一模一样的 `.picker-badge`（气泡里的那几枚），
      // 用不带 `:scope >` 的选择器会把它们一起算进来，行徽章列表就会变成「名字 + 空串」交替。
      const badges = Array.from(li.querySelectorAll(":scope > .picker-badge"));
      return {
        label: li.querySelector(".text")?.textContent ?? "",
        // 徽章节点里还嵌着气泡，文字只读外层那一枚 `.picker-badge-text`。
        badges: badges.map((b) => b.querySelector(":scope > .picker-badge-text")?.textContent ?? ""),
        // 悬停气泡（被「+N」折叠掉的标签名、被截断标签的全名）：气泡里只有徽章，读成一组名字。
        tips: badges.map((b) => {
          const tip = b.querySelector(":scope > .picker-tip");
          if (tip === null) {
            return null;
          }
          return Array.from(tip.querySelectorAll(".picker-badge")).map((x) => x.textContent ?? "");
        }),
        isAction: li.classList.contains("is-action"),
      };
    });
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

test("首项是「自动最新版本」，徽章把 latest 标签与版本号合成一枚", { skip: skipReason }, async () => {
  const page = await openLaunchPage(browser);
  try {
    await openList(page);
    const rows = await readList(page);
    assert.equal(rows[0].label, "自动最新版本", "首项文案固定为「自动最新版本」");
    assert.equal(rows[0].badges.length, 1, "首项只挂一枚合并徽章");
    // 合并形态：`latest 0.2.1-rc.2` —— 既写标签名，也把这次会用到的版本号写出来。
    assert.match(rows[0].badges[0], /^latest \d+\.\d+\.\d+\S*$/, "首项徽章是「latest + 版本号」的合并形态");
    // 首项不是「更多…」那种动作行，选中它就是一个可保存的值（空字符串 = 不带版本号）。
    assert.equal(rows[0].isAction, false, "首项是可选项，不是动作行");
  } finally {
    await page.close();
  }
});

test("版本按新到旧直列，latest 那行挂 latest 徽章，缓存里有的挂「已缓存」", { skip: skipReason }, async () => {
  const page = await openLaunchPage(browser);
  try {
    await openList(page);
    const rows = await readList(page);
    const versions = rows.slice(1).filter((r) => !r.isAction).map((r) => r.label);
    assert.ok(versions.length >= 5, `版本行数应不少于 5，实际 ${versions.length}`);

    // 直列：不打渠道分组，也不该出现「稳定版 / 尝鲜版 / 内测版」这类组名行。
    for (const name of versions) {
      assert.match(name, /^\d+\.\d+\.\d+/, `版本行只写版本号，实际「${name}」`);
    }

    // 首项徽章里的版本号（`latest 0.2.1-rc.2` 去掉标签名），正是列表里挂 latest 的那一行。
    const latestVersion = rows[0].badges[0].replace(/^latest /, "");
    const latestRow = rows.find((r) => r.label === latestVersion);
    assert.ok(latestRow, "latest 那一行应能在列表里找到");
    assert.deepEqual(latestRow.badges, ["latest"], "latest 指向的版本挂 latest 徽章");

    // 假数据里 0.2.1-rc.1 与 0.2.0-rc.2 在 npx 缓存里。
    for (const cached of ["0.2.1-rc.1", "0.2.0-rc.2"]) {
      const row = rows.find((r) => r.label === cached);
      assert.ok(row?.badges.includes("已缓存"), `${cached} 应挂「已缓存」`);
    }

    // 「已装」徽章已删掉：选中只是下拉里的一个值，不代表这一版装在本机。
    for (const row of rows) {
      assert.ok(!row.badges.includes("已装"), `「${row.label}」不该挂「已装」`);
    }
  } finally {
    await page.close();
  }
});

test("next 标签指向的版本挂 next 徽章；已经完整显示的标签不再挂气泡", { skip: skipReason }, async () => {
  const page = await openLaunchPage(browser);
  try {
    await openList(page);
    const rows = await readList(page);
    // 假数据里 next 指向 0.2.1-rc.3，latest 指向 0.2.1-rc.2：两个标签各挂各的行。
    const row = rows.find((r) => r.label === "0.2.1-rc.3");
    assert.ok(row, "假数据的 next 指向 0.2.1-rc.3");
    assert.deepEqual(row.badges, ["next"], "next 那一行挂 next 徽章");
    assert.equal(row.tips[0], null, "next 已经完整显示，再弹一遍同样的徽章没有信息量");
  } finally {
    await page.close();
  }
});

test("同一个版本挂多个标签时按 latest → next → 其他字母序 → 已缓存 排", { skip: skipReason }, async () => {
  // 默认假数据里 latest 与 next 指向不同版本，拼不出完整顺序，
  // 所以用 ?state= 造一个「同一版本挂 latest + next + 自定义 tag，且本机已缓存」的场面。
  const three = {
    registry: {
      distTags: {
        latest: "0.2.1-rc.2",
        tags: { latest: "0.2.1-rc.2", next: "0.2.1-rc.2", zeta: "0.2.1-rc.2" },
      },
      versions: ["0.2.1-rc.2", "0.2.1-rc.1", "0.2.0-rc.2"],
    },
    npxCachedVersions: ["0.2.1-rc.2"],
  };
  const page = await openLaunchPage(browser, three);
  try {
    await openList(page);
    const rows = await readList(page);
    const row = rows.find((r) => r.label === "0.2.1-rc.2");
    assert.deepEqual(row.badges, ["latest", "next", "zeta", "已缓存"], "固定顺序：latest → next → 其他 → 已缓存");
  } finally {
    await page.close();
  }

  // 其余标签之间按字母序（注入顺序故意打乱），跟 `latest` 有没有排第一无关。
  const alphabetical = {
    registry: {
      distTags: {
        latest: null,
        tags: { zeta: "0.2.1-alpha.4", alpha: "0.2.1-alpha.4", mu: "0.2.1-alpha.4" },
      },
      versions: ["0.2.1-alpha.4", "0.2.1-rc.2"],
    },
    npxCachedVersions: ["0.2.1-alpha.4"],
  };
  const page2 = await openLaunchPage(browser, alphabetical);
  try {
    await openList(page2);
    const rows = await readList(page2);
    const row = rows.find((r) => r.label === "0.2.1-alpha.4");
    assert.deepEqual(row.badges, ["alpha", "mu", "zeta", "已缓存"], "自定义标签按字母序，已缓存永远排最后");
  } finally {
    await page2.close();
  }
});

test("tag 超过 3 枚时折叠成 +N，气泡只补「看不全」的那两处", { skip: skipReason }, async () => {
  const page = await openLaunchPage(browser);
  try {
    await openList(page);
    const rows = await readList(page);
    // 假数据里 0.2.1-alpha.4 挂了 alpha / canary / experimental / legacy 四个标签。
    const row = rows.find((r) => r.label === "0.2.1-alpha.4");
    assert.ok(row, "假数据里 0.2.1-alpha.4 挂着 4 个 tag");
    // experimental 是 12 个字符，超过 10 个就截断成「experiment…」（全名留在气泡里）。
    assert.deepEqual(row.badges, ["alpha", "canary", "experiment…", "+1"], "最多 3 枚 tag，其余折成 +1");
    assert.deepEqual(row.tips[3], ["legacy"], "被折叠掉的标签名在气泡里是一枚一枚的徽章");
    assert.deepEqual(row.tips[2], ["experimental"], "截断的徽章在气泡里给全名");
    assert.equal(row.tips[0], null, "alpha 已经完整显示，不挂气泡");
    assert.equal(row.tips[1], null, "canary 已经完整显示，不挂气泡");
  } finally {
    await page.close();
  }
});

test("收起态只显一枚，有 tag 时优先 tag 徽章而不是「已缓存」", { skip: skipReason }, async () => {
  const page = await openLaunchPage(browser);
  try {
    await openList(page);
    // 0.2.0-rc.2 既挂 beta 标签、又在本机 npx 缓存里：收起态显 beta，而不是「已缓存」。
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("#npx-version-picker .picker-option"));
      items.find((li) => li.querySelector(".text")?.textContent === "0.2.0-rc.2")?.click();
    });
    await sleep(200);
    const label = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#npx-version-picker .picker-label .picker-badge .picker-badge-text")).map((b) => b.textContent),
    );
    assert.deepEqual(label, ["beta"], "收起态只显第一枚，tag 排在「已缓存」之前");
  } finally {
    await page.close();
  }
});

test("拿不到 tags 字段时不显示 tag 徽章（老缓存只剩 distTags.latest）", { skip: skipReason }, async () => {
  // 老缓存 / 旧版命令返回里只有 `distTags.latest`、没有 `tags`：宁可一枚 tag 都不挂，也不猜。
  const legacy = {
    registry: {
      distTags: { latest: "0.2.1-rc.2" },
      versions: ["0.2.1-rc.2", "0.2.1-rc.1", "0.2.0-rc.2"],
    },
  };
  const page = await openLaunchPage(browser, legacy);
  try {
    await openList(page);
    const rows = await readList(page);
    const tagNames = ["latest", "next", "beta", "alpha", "canary"];
    for (const row of rows) {
      for (const badge of row.badges) {
        assert.ok(!tagNames.includes(badge), `「${row.label}」不该挂 tag 徽章，实际出现「${badge}」`);
      }
    }
    assert.deepEqual(rows[0].badges, [], "首项也拿不到标签名，合并徽章留空");
    // 「已缓存」不依赖 tags，照常挂。
    assert.deepEqual(rows.find((r) => r.label === "0.2.1-rc.1").badges, ["已缓存"]);
  } finally {
    await page.close();
  }
});

test("选中未安装的版本不显示「已装」徽章", { skip: skipReason }, async () => {
  const page = await openLaunchPage(browser);
  try {
    await openList(page);
    // 假数据里 0.2.1-alpha.5 既不是 latest（0.2.1-rc.2）也不在本机缓存里。
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("#npx-version-picker .picker-option"));
      items.find((li) => li.querySelector(".text")?.textContent === "0.2.1-alpha.5")?.click();
    });
    await sleep(200);
    const label = await page.evaluate(() => ({
      text: document.querySelector("#npx-version-picker .picker-label")?.textContent ?? "",
      badges: Array.from(document.querySelectorAll("#npx-version-picker .picker-label .picker-badge .picker-badge-text")).map((b) => b.textContent),
    }));
    assert.ok(label.text.includes("0.2.1-alpha.5"), "应已选中 0.2.1-alpha.5");
    assert.ok(!label.badges.includes("已装"), "未安装的版本不该挂「已装」");
    assert.deepEqual(label.badges, [], "没有 tag、也不在本机缓存里的版本不挂任何徽章");
  } finally {
    await page.close();
  }
});

test("缓存扫描在按下与抬起之间返回时，一次点击就能选中", { skip: skipReason }, async () => {
  // 复现「选不同版本要点两次」：展开下拉会异步扫一次 npx 缓存（onOpen → refreshCachedVersions），
  // 扫回来要重铺候选。如果重铺是整表重建 <li>，用户按下的那个节点会被换掉，
  // 浏览器就不发 click ——必须再点一次才生效。这里把扫描拖慢 300ms，故意在它返回前按下、
  // 返回后再抬起，验证一次点击即可选中。
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1240, height: 900 });
    await page.evaluateOnNewDocument(() => {
      let api = null;
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        get: () => api,
        set: (value) => {
          const orig = value.invoke.bind(value);
          value.invoke = async (cmd, a) => {
            if (cmd === "npx_cached_versions") {
              await new Promise((done) => setTimeout(done, 300));
            }
            return orig(cmd, a);
          };
          api = value;
        },
      });
    });
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#npx-version-picker .picker-label")?.textContent.includes("自动最新版本"),
      { timeout: 5000 },
    );

    await page.click("#npx-version-picker .picker-btn");
    await page.waitForFunction(
      () => !document.querySelector("#npx-version-picker .picker-list").classList.contains("hidden"),
      { timeout: 3000 },
    );
    // 这时缓存还没扫回来（延迟 300ms），先把目标行滚进可视区再取坐标。
    const point = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#npx-version-picker .picker-option")).find(
        (li) => li.querySelector(".text")?.textContent === "0.2.0-rc.2",
      );
      if (!row) return null;
      row.scrollIntoView({ block: "center" });
      const box = row.getBoundingClientRect();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hitInsideRow: row.contains(hit) };
    });
    assert.ok(point, "列表里应有 0.2.0-rc.2");
    assert.equal(point.hitInsideRow, true, "坐标应落在目标行上，否则后面的点击会打到别处");

    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await sleep(500); // 扫描在这期间返回并重铺，旧实现会把按下的节点换掉
    await page.mouse.up();
    await sleep(200);

    const state = await page.evaluate(() => ({
      label: document.querySelector("#npx-version-picker .picker-label")?.textContent ?? "",
      open: !document.querySelector("#npx-version-picker .picker-list").classList.contains("hidden"),
    }));
    assert.ok(state.label.includes("0.2.0-rc.2"), `一次点击就该选中 0.2.0-rc.2，实际「${state.label}」`);
    assert.equal(state.open, false, "选中后弹层应已收起");
  } finally {
    await page.close();
  }
});

test("末尾「更多…」每次只放 10 个，且点了不收起弹层", { skip: skipReason }, async () => {
  const page = await openLaunchPage(browser);
  try {
    await openList(page);
    const initial = await readList(page);
    const actionRow = initial.find((r) => r.isAction);
    assert.ok(actionRow, "列表末尾应有「更多…」动作行");
    assert.match(actionRow.label, /^更多…（还剩 \d+ 个）$/, "「更多…」要带剩余数量");

    const verCount = (rows) => rows.filter((r) => !r.isAction).length;
    const beforeCount = verCount(initial);

    // 点「更多…」：只加 10 行，不收起。
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("#npx-version-picker .picker-option"));
      items.find((li) => li.classList.contains("is-action")).click();
    });
    await sleep(300);

    const stillOpen = await page.evaluate(
      () => !document.querySelector("#npx-version-picker .picker-list").classList.contains("hidden"),
    );
    assert.equal(stillOpen, true, "点「更多…」不该收起弹层");

    const afterOne = await readList(page);
    assert.equal(verCount(afterOne), beforeCount + 10, "点一次「更多…」应再多放 10 个版本");
  } finally {
    await page.close();
  }
});

test("缓存提示只说会重下的口径：裸包名写法提示，钉版本直接复用不再提示", { skip: skipReason }, async () => {
  // 保存的配置选了 0.2.0-rc.2：它在缓存里（默认假数据），但 pinServed 只登记 0.2.1-rc.1
  // ——即缓存里那份 0.2.0-rc.2 是裸包名写法留下的，按 npx「每种写法各存一份」会再下载。
  const state = {
    savedLaunch: {
      mode: { kind: "npx", version: "0.2.0-rc.2" },
      runtime: { kind: "default" },
      extraArgs: [],
      port: null,
    },
    npxPinServedVersions: ["0.2.1-rc.1"],
  };
  const page = await openLaunchPage(browser, state, "0.2.0-rc.2");
  try {
    const hint = () =>
      page.evaluate(() => {
        const el = document.querySelector("#npx-installed-hint");
        return { text: el?.textContent ?? "", hidden: el?.classList.contains("hidden") ?? true };
      });

    let shown = await hint();
    assert.equal(shown.hidden, false, "缓存里的选中版本要出提示");
    assert.match(shown.text, /0\.2\.0-rc\.2/, "提示要带当前版本号");
    assert.match(shown.text, /[^不]会再下载一份/, "裸包名写法留下的缓存要如实说会再下载");
    assert.doesNotMatch(shown.text, /不会再下载/, "此时不能反过来保证不重下");

    // 换选 pinServed 命中的 0.2.1-rc.1：这份缓存就是钉版本写法留下的，启动直接复用，
    // 「已缓存」徽章已经说明——不再额外出「不会再下载」的提示（用户反馈的噪音，已删）。
    await openList(page);
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("#npx-version-picker .picker-option"));
      items.find((li) => li.querySelector(".text")?.textContent === "0.2.1-rc.1")?.click();
    });
    await page.waitForFunction(
      () => document.querySelector("#npx-version-picker .picker-label")?.textContent.includes("0.2.1-rc.1"),
      { timeout: 3000 },
    );
    shown = await hint();
    assert.equal(shown.hidden, true, "钉版本写法命中的缓存不再出「已装过」提示");
  } finally {
    await page.close();
  }
});
