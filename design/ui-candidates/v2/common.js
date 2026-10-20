/* v2 候选稿的公共脚本：图标清单、浅深切换、二级弹窗开合。
   三份候选页共用，各页只负责把图标排成自己要的形状。 */

const ICONS = {
  launch:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 16.5 3 21l4.5-1.5"/><path d="M14 4c3.5-1 6 1.5 5 5-1.2 4.2-5.6 7.6-8.4 9.1L8 15.4C9.5 12.6 11.3 5.2 14 4Z"/><circle cx="14.6" cy="9.4" r="1.6"/></svg>',
  env:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"/><path d="m4 7.5 8 4.5 8-4.5"/><path d="M12 12v9"/></svg>',
  net:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 3.6 9 14 14 0 0 1-3.6 9 14 14 0 0 1-3.6-9A14 14 0 0 1 12 3Z"/></svg>',
  traynet:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="10" r="6.5"/><path d="M5.5 10h13"/><path d="M12 3.5a10 10 0 0 1 2.6 6.5 10 10 0 0 1-2.6 6.5 10 10 0 0 1-2.6-6.5A10 10 0 0 1 12 3.5Z"/><path d="M4 19.5h4l1.2 2h5.6l1.2-2h4"/></svg>',
  integ:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m6.5 10 2.5 2.5L6.5 15"/><path d="M12 15.5h5"/></svg>',
  about:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.9" r="0.9" fill="currentColor" stroke="none"/></svg>',
};

/* 五个入口：「桥接插件」已归入「环境」，「网络」已归入「托盘与网络」。 */
const NAV = [
  { id: "launch", label: "启动方式", icon: ICONS.launch, body: bodyLaunch },
  { id: "env", label: "环境", icon: ICONS.env, body: bodyEnv },
  { id: "integ", label: "集成", icon: ICONS.integ, body: bodyInteg },
  { id: "traynet", label: "托盘与网络", icon: ICONS.traynet, body: bodyTrayNet },
  { id: "about", label: "关于", icon: ICONS.about, body: bodyAbout },
];

function field(label, ctl) {
  return `<div class="field"><span class="lbl">${label}</span><div class="ctl">${ctl}</div></div>`;
}

function picker(text) {
  return `<div class="picker">${text}</div>`;
}

function bodyLaunch() {
  return `
    ${field("启动方式", picker("官方 npx 命令"))}
    ${field("渠道", picker("最新稳定版（latest）"))}
    ${field("版本", picker("跟随渠道默认"))}
    ${field("运行环境", picker("Windows 宿主"))}
    ${field("附加参数", '<input class="text" value="" placeholder="例如 --port 3081" />')}
    ${field("端口", '<input class="text" value="3080" />')}
    <p class="hint">运行环境选 WSL 时，以上命令在该发行版内执行；壳始终自动追加 <code>--no-open</code>。</p>`;
}

function bodyEnv() {
  return `
    ${field("当前环境", picker("Windows 宿主"))}
    ${field("WSL 发行版", picker("Ubuntu（已检测到 Node.js）"))}
    <div class="kv">
      <div class="kv-row"><span class="kv-key">补丁层</span><span class="kv-val mono">~/.dsh/cordis.patch.yml</span></div>
      <div class="kv-row"><span class="kv-key">已装插件</span><span class="kv-val">3 个</span></div>
    </div>
    <div class="actions">
      <button class="btn">管理环境</button>
      <button class="btn">编辑补丁层</button>
      <span class="spacer"></span>
      <button class="btn">管理插件</button>
    </div>
    <div class="sec">
      <span>桥接插件</span>
      <span class="tag-ok">已安装 v0.3.7</span>
    </div>
    <div class="sub-block">
      <p class="hint">安装后壳经 DSH 内部插件接口直接取带 token 的登录链接，不依赖日志格式；未安装时自动降级为日志解析。</p>
      <div class="row-line">
        <button class="btn primary">安装桥接插件</button>
        <button class="btn">卸载</button>
        <button class="btn">恢复备份</button>
        <button class="btn ghost">打开备份目录</button>
        <span class="spacer"></span>
        <span class="mute">最近备份 2026-10-20 14:02 · profile.bak-3</span>
      </div>
      <p class="hint">安装、卸载、恢复备份前请先停止 DSH。</p>
      <details class="log-box">
        <summary>最近输出</summary>
        <div class="log">[14:02:11] 已写入 cordis 插件清单
[14:02:11] profile 已备份（保留最近 5 份）</div>
      </details>
    </div>`;
}

function bodyInteg() {
  return `
    ${field("命令行集成", picker("已把 dsh 加到系统 PATH"))}
    <p class="hint">开启后在任意终端里都能直接敲 <code>dsh</code>；改完需要新开一个终端。</p>
    <div class="kv">
      <div class="kv-row"><span class="kv-key">npx 缓存</span><span class="kv-val mono">%LOCALAPPDATA%\\npm-cache\\_npx</span></div>
      <div class="kv-row"><span class="kv-key">占用</span><span class="kv-val">412 MB</span></div>
    </div>
    <div class="actions"><span class="spacer"></span><button class="btn">清理 npx 缓存</button></div>`;
}

function bodyTrayNet() {
  return `
    ${field("下载源", picker("跟随 npm 全局配置"))}
    ${field("网络代理", picker("跟随系统代理"))}
    ${field("代理地址", '<input class="text" value="" placeholder="http://127.0.0.1:7890" />')}
    <p class="hint">下载源用于查版本与拉取 DSH，代理只作用于壳拉起的 DSH 进程；两者都不改动系统环境变量。</p>
    ${field("托盘单击打开", picker("启动界面"))}
    ${field("释放界面内存", picker("立即（0 秒）"))}
    <p class="hint">关窗后按上面的时长释放界面内存，这段时间内从托盘回来是秒开；右键菜单「浏览器打开 / 应用内打开 / 打开启动界面」随时可用，DSH 照常运行。</p>`;
}

function bodyAbout() {
  return `
    <div class="kv">
      <div class="kv-row"><span class="kv-key">壳版本</span><span class="kv-val">DSHarbor 0.3.7（核心库 0.3.7）</span></div>
      <div class="kv-row"><span class="kv-key">DSH 版本</span><span class="kv-val">0.2.1-rc.2</span></div>
      <div class="kv-row"><span class="kv-key">许可证</span><span class="kv-val">MIT</span></div>
      <div class="kv-row"><span class="kv-key">项目仓库</span><span class="kv-val mono">github.com/BoxMiao007/dsharbor</span></div>
      <div class="kv-row"><span class="kv-key">配置目录</span><span class="kv-val mono">%APPDATA%\\DSHarbor</span></div>
      <div class="kv-row"><span class="kv-key">日志目录</span><span class="kv-val mono">%USERPROFILE%\\.dsh\\logs</span></div>
    </div>
    <div class="actions">
      <button class="btn">打开 GitHub 仓库</button>
      <button class="btn">打开 DSH 官网</button>
      <span class="spacer"></span>
      <button class="btn">打开日志目录</button>
    </div>`;
}

/* ---- 浅/深切换：一个图标，记在本地 ---- */
const MODE_KEY = "dsharbor.v2.preview.mode";
const ICON_SUN =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>';

function applyMode(mode) {
  document.documentElement.dataset.mode = mode;
  const btn = document.getElementById("mode-btn");
  if (btn) {
    // 当前是深色 → 按钮显示太阳（点了变浅色）；浅色则显示月亮。
    btn.innerHTML = mode === "dark" ? ICON_SUN : ICON_MOON;
    btn.title = mode === "dark" ? "切换到浅色模式" : "切换到深色模式";
    btn.setAttribute("aria-label", btn.title);
  }
}

function initMode() {
  let mode = "dark";
  try {
    mode = localStorage.getItem(MODE_KEY) || "dark";
  } catch (err) {
    /* 隐私模式：按深色 */
  }
  applyMode(mode);
  document.getElementById("mode-btn").addEventListener("click", () => {
    mode = document.documentElement.dataset.mode === "dark" ? "light" : "dark";
    applyMode(mode);
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch (err) {
      /* 存不了就只在本页生效 */
    }
  });
}

/* ---- 二级弹窗：从被点的图标中心长出来 ---- */
function openSheet(id, originEl) {
  const item = NAV.find((entry) => entry.id === id);
  if (!item) return;
  const scrim = document.getElementById("scrim");
  const sheet = document.getElementById("sheet");
  if (originEl) {
    const box = originEl.getBoundingClientRect();
    const target = sheet.getBoundingClientRect();
    sheet.style.setProperty("--ox", `${box.left + box.width / 2 - (target.left || 0)}px`);
    sheet.style.setProperty("--oy", `${box.top + box.height / 2 - (target.top || 0)}px`);
  }
  document.getElementById("sheet-ico").innerHTML = item.icon;
  document.getElementById("sheet-title").textContent = item.label;
  document.getElementById("sheet-body").innerHTML = item.body();
  scrim.hidden = false;
  document.getElementById("sheet-close").focus();
}

function closeSheet() {
  document.getElementById("scrim").hidden = true;
}

function initSheet() {
  document.getElementById("scrim").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeSheet();
  });
  document.getElementById("sheet-close").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSheet();
  });
}

/** 渲染图标行：页面里只放一个空的 <nav id="nav">，排布由各候选的 css 决定。
 *  nav 带 data-rows="N" 时拆成多行（候选丙用两行）。 */
function renderNav() {
  const nav = document.getElementById("nav");
  if (!nav) return;
  const btn = (item) =>
    `<button type="button" class="ico-item" data-nav="${item.id}" title="${item.label}">${item.icon}<span class="txt">${item.label}</span></button>`;
  const rows = Number(nav.dataset.rows || 1);
  if (rows > 1) {
    // 前面几行均分，余数落在最后一行（7 项分两行 = 4 + 3）
    const per = Math.ceil(NAV.length / rows);
    nav.innerHTML = Array.from({ length: rows }, (_, r) =>
      `<div class="nav-row">${NAV.slice(r * per, (r + 1) * per).map(btn).join("")}</div>`,
    ).join("");
  } else {
    nav.innerHTML = NAV.map(btn).join("");
  }
  nav.querySelectorAll(".ico-item").forEach((el) => {
    el.addEventListener("click", () => openSheet(el.dataset.nav, el));
  });
}

/* 卡片主体 markup（三个候选同一份，只有 nav 的摆放位置不同）。 */
const CARD_MAIN = `
  <div class="head">
    <img class="head-logo" src="../../../src/assets/logo.png" alt="" />
    <div class="head-text">
      <h1>DSHarbor</h1>
      <p>DSH Web 的桌面壳</p>
    </div>
  </div>
  <div class="badges">
    <span class="badge on"><i class="dot"></i>登录链接就绪</span>
    <span class="badge on"><i class="dot"></i>运行中</span>
    <span class="badge">DSH 0.2.1-rc.2</span>
    <span class="meta">PID <b>12844</b></span>
    <span class="meta">监听 <b>3080</b></span>
  </div>
  <div class="actions">
    <button class="btn primary">停止 DSH</button>
    <button class="btn">重启 DSH</button>
    <span class="spacer"></span>
    <button class="btn">应用内打开</button>
    <button class="btn">浏览器打开</button>
  </div>
  <details class="log-box">
    <summary>最近输出</summary>
    <div class="log">[14:02:03] 登录链接已就绪：http://127.0.0.1:3080/?token=••••
[14:02:03] DSH 已启动，PID 12844，端口 3080
[14:02:11] 桥接插件已装载（cordis）</div>
  </details>`;

const SHEET = `
<div class="scrim" id="scrim" hidden>
  <div class="sheet" id="sheet">
    <div class="sheet-head">
      <span class="sheet-ico" id="sheet-ico"></span>
      <h2 id="sheet-title"></h2>
      <button class="sheet-close" id="sheet-close" aria-label="关闭">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1 11 11M11 1 1 11"/></svg>
      </button>
    </div>
    <div class="sheet-body" id="sheet-body"></div>
  </div>
</div>`;

/** 各候选页在 DOM 就绪后调一次。 */
function initCandidate() {
  // 页面上有两个占位：.card-main 与 .cand-sheet，其余交给各候选的 css。
  const main = document.querySelector(".card-main");
  if (main) main.innerHTML = CARD_MAIN;
  document.body.insertAdjacentHTML("beforeend", SHEET);
  renderNav();
  initMode();
  initSheet();
}
