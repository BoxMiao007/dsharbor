/* 整页静态骨架 buildHtml：由 AppInfo 渲染左栏与右栏全部初始 DOM（id 不变，绑定代码共用） —— 自 main.ts 原样搬出（2026-10 模块化拆分），声明加 export，其余未改。 */

import { PANELS, UNREAD_BADGE_HTML, ICON_PLUS, ICON_SUN, ICON_MINIMIZE, ICON_MAXIMIZE, ICON_CLOSE, ICON_RESTART, ICON_OPEN_APP, ICON_OPEN_BROWSER, ICON_CODE, ICON_DSH_SITE, ICON_GITHUB, ICON_MODAL_CLOSE, ICON_CHEVRON_DOWN, ICON_REFRESH, ICON_FOLDER, ICON_REVERT } from "./icons";
import type { AppInfo } from "./types";
import { CUSTOM_DEFAULT_COMMAND, TOGGLE_TEXT_REST, TOOLTIP_RESTART, npxCommandOf } from "./config";
import { toggleSwapHtml, panelSection, cell, mainCard, cellRow, colHead, badgeLine } from "./markup";

/** 版本徽章里的两个四角星图标（取自 DeepSeek Harness 官网，路径原样保留）。 */
export const SPARKLE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
          <defs>
            <linearGradient id="harness-badge-sparkle" x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
              <stop stop-color="#D2E0FF" stop-opacity="0.6"></stop>
              <stop offset="1" stop-color="#A6C2FF" stop-opacity="0.38"></stop>
            </linearGradient>
          </defs>
          <path d="M9 6C10.53 9.82 13.68 12.97 17.5 14.5C13.68 16.03 10.53 19.18 9 23C7.47 19.18 4.32 16.03 0.5 14.5C4.32 12.97 7.47 9.82 9 6Z" fill="url(#harness-badge-sparkle)"></path>
          <path d="M19.5 1C20.22 2.8 21.7 4.28 23.5 5C21.7 5.72 20.22 7.2 19.5 9C18.78 7.2 17.3 5.72 15.5 5C17.3 4.28 18.78 2.8 19.5 1Z" fill="url(#harness-badge-sparkle)"></path>
        </svg>`;

/** 启动方式的界面文案（折叠摘要徽章与单选组共用一份，避免两处漂移）。 */
export const MODE_LABELS: Record<string, string> = {
  npx: "官方 npx 命令",
  system: "系统全局命令",
  binary: "指定程序路径",
  custom: "自定义命令",
};

/** 界面骨架：顶部一条通栏透明拖拽条（品牌 + 三只窗口按钮）+ 左栏悬浮块 + 右栏
    （工具条悬浮块 + 分区主卡）+ 弹窗层。
    块与块之间留缝，露出页面背景。所有可交互元素的 id 不变，绑定代码共用。 */
export function buildHtml(info: AppInfo): string {
  // 顶栏：整条可拖动，左边品牌、右边三只窗口按钮。
  // 品牌文字自身也带 data-tauri-drag-region：Tauri 只认事件命中的那个元素是否带属性，
  // 属性只挂在父元素上时，点在文字上就拖不动（旧版把属性挂在左栏卡片上的回归缺陷就是这么来的）。
  const titlebar = `
    <header class="titlebar" data-tauri-drag-region>
      <span class="titlebar-brand" data-tauri-drag-region>
        <span class="titlebar-name" data-tauri-drag-region>${info.name}</span><span
          class="titlebar-sub"
          data-tauri-drag-region
          >DSH Web 的桌面壳</span
        >
      </span>
      <div class="win-controls">
        <button id="win-min" class="win-btn" type="button" title="最小化" aria-label="最小化">${ICON_MINIMIZE}</button>
        <button id="win-max" class="win-btn" type="button" title="最大化" aria-label="最大化">${ICON_MAXIMIZE}</button>
        <button id="win-close" class="win-btn win-close" type="button" title="关闭窗口 = 轻量模式：界面内存释放，DSH 与托盘常驻" aria-label="关闭">${ICON_CLOSE}</button>
      </div>
    </header>
  `;

  // 左栏：一张通高的悬浮块。顶部一句话 + 小字署名（水平居中），中间各分区，底部三个纯图标快捷入口。
  const sidebar = `
    <aside class="sidebar" data-tauri-drag-region>
      <div class="sidebar-brand" data-tauri-drag-region>
        <span class="sidebar-name">探索未至之境</span>
        <p class="sidebar-sub">DeepSeek</p>
      </div>
      <nav class="rail" id="nav" aria-label="设置分区">
        ${PANELS.map(
          (item) =>
            `<button class="ico-item" type="button" data-panel-btn="${item.key}">${item.icon}<span class="txt">${item.label}</span>${item.key === "log" ? UNREAD_BADGE_HTML : ""}</button>`,
        ).join("\n        ")}
      </nav>
      <div class="sidebar-links">
        <button id="link-site" class="icon-btn" type="button" title="打开 DSH 官网" aria-label="打开 DSH 官网">${ICON_DSH_SITE}</button>
        <button id="link-repo" class="icon-btn" type="button" title="打开 GitHub 仓库" aria-label="打开 GitHub 仓库">${ICON_GITHUB}</button>
        <button id="mode-btn" class="icon-btn" type="button" title="切换到浅色模式" aria-label="切换到浅色模式">${ICON_SUN}</button>
      </div>
    </aside>
  `;

  // 工具条：一张独立的悬浮块。左边徽章群，右边主操作。运行状态不做徽章，只看主按钮
  // （蓝「启动 DSH」↔ 红「停止」）；启动前只有「启动」可点（打开方式可以先选好），
  // 运行后「停止 / 重启」出现。打开方式是「主按钮 + 右侧小三角」的两段式：
  // 点三角选方式，选完文字与图标回填到主按钮，再点主按钮才执行。
  const toolbar = `
    <section class="block toolbar-block">
      <div class="status-row">
        <span id="login-badge" class="badge badge-stopped" role="status" aria-live="polite"><span id="login-text">桥接未安装</span><span id="login-info" class="info-dot" role="img" tabindex="0" aria-label="桥接插件说明" data-tip="正在读取桥接插件状态…">!</span></span>
        <span id="version-badge" class="badge badge-version" title="每次成功启动 DSH 后自动读取">${SPARKLE_SVG}<span id="version-text">DSH 版本未知</span></span>
        <span class="status-meta">PID <b id="status-pid">—</b></span>
        <span class="status-meta">监听 <b id="status-port">—</b></span>
      </div>
      <!-- 拖动带：徽章之间到右侧按钮之间的空白交给系统拖窗口（按钮本身不参与）。 -->
      <div class="toolbar-drag" data-tauri-drag-region></div>
      <div class="toolbar-actions">
        <div class="actions actions-primary">
          <!-- 初始即停止态的逐字切换形态：首帧就用正确样式，等 render 前不会闪红底大字。 -->
          <button id="btn-toggle" class="primary swap" aria-label="${TOGGLE_TEXT_REST}">${toggleSwapHtml()}</button>
          <button id="btn-restart" class="round hidden" type="button" title="${TOOLTIP_RESTART}" aria-label="${TOOLTIP_RESTART}">${ICON_RESTART}</button>
        </div>
        <div class="open-split">
          <button id="btn-open" class="btn-open" type="button" disabled>
            <span class="btn-ico" id="open-ico" aria-hidden="true">${ICON_OPEN_APP}</span>
            <span class="btn-text" id="open-text">应用内打开</span>
          </button>
          <button id="btn-open-more" class="btn-open-more" type="button" title="更换打开方式" aria-label="更换打开方式" aria-expanded="false" aria-controls="open-menu">${ICON_CHEVRON_DOWN}</button>
          <div id="open-menu" class="open-menu hidden" role="menu" aria-label="打开方式">
            <button class="open-item" type="button" role="menuitem" data-open-mode="app">${ICON_OPEN_APP}<span>应用内打开</span></button>
            <button class="open-item" type="button" role="menuitem" data-open-mode="browser">${ICON_OPEN_BROWSER}<span>浏览器打开</span></button>
            <button class="open-item" type="button" role="menuitem" data-open-mode="copy">${ICON_CODE}<span>复制登录链接</span></button>
          </div>
        </div>
      </div>
    </section>
  `;

  // 状态错误与登录失败的两行提示：工具条下方整行显示，不塞进任何块。
  // 两者都是「运行中才出现」的动态状态，加 aria-live 让屏幕阅读器在出现时读出来。
  const statusErrorBlock = `<p id="status-error" class="error hidden" role="alert" aria-live="assertive"></p>`;
  const loginNoteBlock = `<p id="login-note" class="hint notice login-note hidden" role="status" aria-live="polite"></p>`;

  // 两条托盘设置（单击打开 / 释放界面内存）在「托盘设置」块里，说明直接写在控件下方。
  const trayFields = `
    ${colHead("托盘设置")}
    <div class="fields">
      <label>托盘单击打开</label>
      <div class="picker" id="tray-picker"></div>
      <p class="hint">单击系统托盘图标时打开哪一个；右键菜单「浏览器打开 / 应用内打开 / 打开启动界面」随时可用。</p>
    </div>
    <div class="fields">
      <label>关闭窗口后释放界面内存</label>
      <div class="picker" id="light-delay-picker"></div>
      <p class="hint">关闭后先留在内存里，这段时间内从托盘回来是秒开；到点后释放界面内存。</p>
    </div>
  `;

  // 「环境/插件」卡：顶部一排能起网页界面的环境大按钮，点一下就切「当前管理的环境」；
  // 右侧一列两颗按钮（新建空白环境 / 桥接插件），两颗等宽对齐。新建之所以放在最上面：
  // 它是这一块唯一的「添东西」动作，放行尾会被误读成与插件同类的设置项；它的命名规则说明
  // 收进点开后的弹窗，不在卡里占三行字。
  // 补丁层是「某个环境的」东西，所以入口收进环境三点菜单里，不在这里占一颗全局按钮。
  // 启动 DSH 永远用 web 环境（核心库 launch::PROFILE_NAME），这里选的只是「管理目标」。
  const profilesBody = `
    ${colHead("环境与插件")}
    <p id="profiles-windows-only" class="hint notice profiles-windows-only hidden">仅在 Windows 宿主可用：环境列表与管理要读写 DSH 自己的 <code>~/.dsh/profiles</code> 目录，这里不会改动任何文件。</p>
    <div id="profiles-content" class="profiles-content">
      <div class="env-row">
        <div id="profile-cards" class="env-cards"></div>
        <div class="env-aside">
          <button id="btn-profile-create" class="ghost env-new" type="button">${ICON_PLUS}<span>新建空白环境</span></button>
          <button id="btn-bridge" class="ghost" type="button">桥接插件</button>
        </div>
      </div>
      <p id="profile-note" class="hint hidden"></p>
      <p id="profile-error" class="error hidden"></p>
    </div>
  `;

  // 插件管理卡：跟着「选中的环境」走。开关改的是补丁层里的禁用表达，不卸载插件包。
  const pluginBody = `
    ${colHead("插件", badgeLine("plugin-summary", "读取中…"))}
    <p class="hint">一行一个插件的<b>总开关</b>；开关改的是补丁层里的禁用表达，<b>不会卸载插件包</b>：关掉后重启 DSH 才不再加载它，重新打开也不需要重新下载。只列壳管得了的插件——官方内置的骨架包（没有可禁用的挂载点）与桥接插件（归「桥接插件」浮窗管）不在这里出现。每次开关前会自动备份一份补丁层（每个环境保留最近 5 份）；改完要重启 DSH 才生效，所以操作前请先停止 DSH。</p>
    <div id="profile-plugins" class="plugin-panel">
      <div id="plugin-list" class="plugin-list"></div>
      <div id="plugin-empty" class="plugin-empty hidden">
        <p class="hint notice">这个环境还没有壳管得了的插件（官方内置骨架包与桥接插件不在列表里）。先给环境安装依赖，再用官方命令把插件装上（<code>dsh plugin --profile &lt;环境名&gt; add &lt;插件名&gt;</code>）。</p>
        <div class="actions">
          <button id="btn-plugin-deps" class="ghost">去安装依赖</button>
        </div>
      </div>
      <p id="plugin-note" class="hint hidden"></p>
      <p id="plugin-warning" class="hint notice plugin-warning hidden"></p>
    </div>
  `;

  // 「网络与代理」块：下载源 + 代理。代理设置按下发到子进程的时机生效，所以地址框失焦就存。
  const networkFieldsBody = `
    <p id="network-windows-only" class="hint notice network-windows-only hidden">仅在 Windows 宿主可用：代理设置要读系统代理（Windows 注册表或环境变量）并下发到子进程，自检也要起 npm；这里不会改动任何设置。</p>
    <div id="network-content" class="network-content">
    ${colHead("网络与代理")}
    <div class="fields">
      <span class="field-label">下载源</span>
      <div class="picker" id="download-source-picker"></div>
      <p class="hint" id="download-source-hint"></p>
    </div>
    <div class="fields">
      <span class="field-label">代理</span>
      <div class="picker" id="proxy-mode-picker"></div>
      <div id="proxy-manual" class="proxy-manual hidden">
        <input id="proxy-address" type="text" placeholder="例如 http://127.0.0.1:7890" aria-label="代理地址" spellcheck="false" autocomplete="off" />
      </div>
      <p class="hint" id="proxy-hint"></p>
    </div>
    </div>
  `;

  // 「网络自检」块：真正起一次 npm，看直连和走代理各自通不通。
  const selfCheckBody = `
    <div class="fields">
      <div class="actions">
        <button type="button" id="btn-self-check">测试连接</button>
      </div>
      <p class="hint" id="self-check-status"></p>
      <p class="hint hidden" id="self-check-detail"></p>
    </div>
  `;

  // 「命令行集成」块：内容全部由后端算好（目录、垫片内容、手动命令、状态说明），
  // 界面只负责显示，避免两边各算一套口径。非 Windows 宿主只留手动命令。
  // 长段解释统一收进底部折叠区：默认只留开关与两行路径，读起来不糊。
  const cliBlockBody = `
    ${colHead("命令行集成", badgeLine("integrations-summary", "读取中…"))}
    <div class="cli-windows-only">
      <div class="switch-row">
        <span class="switch-label" id="cli-toggle-label">把 <code>dsh</code> 命令接进终端</span>
        <button class="switch" type="button" role="switch" id="cli-toggle" aria-checked="false" aria-labelledby="cli-toggle-label"><span class="switch-knob"></span></button>
      </div>
      <div class="kv">
        <div class="kv-row"><span class="kv-key">垫片目录</span><span class="kv-value" id="cli-bin-dir">—</span></div>
        <div class="kv-row kv-row-action"><span class="kv-key">垫片文件</span><span class="kv-value" id="cli-shim-path">—</span><button id="btn-cli-dir" class="kv-action">打开目录</button></div>
      </div>
    </div>
    <div class="kv">
      <div class="kv-row kv-row-action"><span class="kv-key">手动命令</span><span class="kv-value cli-command" id="cli-manual">—</span><button id="btn-cli-copy" class="kv-action">复制</button></div>
    </div>
    <p id="cli-message" class="hint">读取中…</p>
    <p id="cli-error" class="error hidden"></p>
    <div class="cli-windows-only">
      <details class="log-box">
        <summary><span class="chev">▸</span>垫片内容（跟随当前启动方式）</summary>
        <div class="log-area log-area-code">
          <pre id="cli-shim-text">（读取中）</pre>
          <button type="button" class="log-copy" id="btn-cli-copy-shim">复制</button>
        </div>
      </details>
    </div>
    <details class="log-box">
      <summary><span class="chev">▸</span>这段在做什么 / 手动怎么配</summary>
      <div class="log-area">
        <p class="hint">只改当前用户的 PATH，不动系统 PATH，其它条目原样保留（百分号变量也不会被展开）；写入是原值回写，再长也不会截断。改完不影响已经开着的终端，<b>新开一个终端</b>才生效。</p>
        <p class="hint">不想打开上面的开关时，把「手动命令」粘进 <b>命令提示符（cmd）</b> 或 <b>PowerShell</b> 回车执行就行。注意 <code>setx</code> 会把 <code>%VAR%</code> 展开成当前值、超过 1024 个字符会被截断，所以它只适合手动救场，日常用上面那个开关（原值回写，不会被展开也不会截断）。</p>
      </div>
    </details>
  `;

  // 「DSH 版本」块：列出本机装了哪些 dsh web，并允许删掉某一份。
  // 壳不再管理 npx 缓存（不统计占用、不自动清理），这里只回答「装了哪几份、装在哪、在不在用」。
  // 同一个版本装了好几份很常见（每次换 npx 参数都会新解一份），标题旁挂一枚黄色徽章点出来。
  const dshVersionsBody = `
    ${colHead("DSH 版本", '<span id="dsh-versions-dup" class="badge badge-warn panel-badge hidden"></span>')}
    <p class="hint">本机装了哪些 dsh web：npx 缓存里的，与 <code>npm install -g</code> 装的。桌面版自带的 CLI 不算。</p>
    <div id="dsh-versions-list" class="version-list"><p class="hint">读取中…</p></div>
    <p id="dsh-versions-error" class="error hidden"></p>
    <details class="log-box">
      <summary><span class="chev">▸</span>删除说明</summary>
      <div class="log-area">
        <p class="hint">「npm 全局」那一份点「卸载」，等同于 <code>npm uninstall -g @deepseek-ai/dsh</code>；「npx 缓存」那几份点「删除」，直接删掉对应的缓存目录。两种都要再点一次「确定」，删掉后没法找回。</p>
        <p class="hint">正被当前启动方式用着的那一份（标着「使用中」）删掉后要换一种启动方式，或者重新下一次。只想腾空间、又不想丢版本的话，留着即可：npx 那几份下次选对应版本启动时不用重新下载。</p>
      </div>
    </details>
  `;

  // 「启动方式」块：四选一 + 各自参数。实际执行的命令与附加参数放在下面并排的两块里。
  // 每一项连同它展开的参数包在同一个 .mode-group 里：选中且展开参数时整组抬一层底色，
  // 让人一眼看出「这几行参数属于这个选项」，而不是四行平铺的选项各管各的。
  const modesBody = `
    ${colHead("启动方式")}
    <div class="mode-group">
      <label class="mode">
        <input type="radio" name="mode" value="npx" checked />
        <span>
          <b>${MODE_LABELS.npx}</b>
          <small>未全局安装 DSH 时用；首次启动会自动下载（较慢）；实际执行的命令见下方「命令预览」。</small>
        </span>
      </label>
      <div id="npx-fields" class="fields hidden">
        <span class="field-label">运行环境 <span class="info-dot" role="img" tabindex="0" aria-label="运行环境说明" data-tip="默认在 Windows 侧执行命令；选 WSL 发行版则通过 wsl.exe 在该发行版内执行，桥接插件也装到那个发行版里。">!</span></span>
        <div class="picker" id="npx-runtime-picker"></div>
        <span class="field-label">版本 <span class="info-dot" role="img" tabindex="0" aria-label="版本说明" data-tip="首项「自动最新版本」不带版本号，跟 npm 的 latest 标签走，官方发新版后自动用上；下面按新到旧列出官方发布过的版本，「更多…」每次再放 10 个。标「已缓存」的版本本机 npx 缓存里已经有了，选它启动不用重新下载。">!</span></span>
        <div class="control-line">
          <div class="picker" id="npx-version-picker"></div>
          <button type="button" id="npx-versions-refresh" class="square-btn" title="重新获取官方版本列表" aria-label="重新获取官方版本列表">${ICON_REFRESH}</button>
        </div>
        <div id="npx-versions-hint" class="hint hidden"></div>
        <div id="npx-installed-hint" class="hint notice hidden"></div>
        <div class="preview-line"><span class="field-label">命令预览</span><code id="npx-command-preview" class="command-preview">${npxCommandOf(null)}</code></div>
      </div>
    </div>
    <div class="mode-group">
      <label class="mode">
        <input type="radio" name="mode" value="system" />
        <span>
          <b>${MODE_LABELS.system}</b>
          <small>已执行过 <code>npm install -g @deepseek-ai/dsh</code></small>
        </span>
      </label>
    </div>
    <div class="mode-group">
      <label class="mode">
        <input type="radio" name="mode" value="binary" />
        <span>
          <b>${MODE_LABELS.binary}</b>
          <small>最可靠：直接启动 dsh.exe / dsh.cmd 的完整路径</small>
        </span>
      </label>
      <div id="binary-fields" class="fields hidden">
        <div class="path-row">
          <input id="binary-path" type="text" placeholder="例如 D:\\tools\\dsh.cmd" aria-label="指定程序路径" />
          <button type="button" id="binary-browse" class="square-btn" title="浏览程序路径" aria-label="浏览程序路径">${ICON_FOLDER}</button>
        </div>
        <p id="binary-error" class="error field-error hidden"></p>
      </div>
    </div>
    <div class="mode-group">
      <label class="mode">
        <input type="radio" name="mode" value="custom" />
        <span>
          <b>${MODE_LABELS.custom}</b>
          <small>自己写整条启动命令，例如 <code>npx @deepseek-ai/dsh@next web</code>（换版本标签、换包管理器、包一层脚本都行）</small>
        </span>
      </label>
      <div id="custom-fields" class="fields hidden">
        <span class="field-label">运行环境 <span class="info-dot" role="img" tabindex="0" aria-label="运行环境说明" data-tip="默认在 Windows 侧执行命令；选 WSL 发行版则通过 wsl.exe 在该发行版内执行这条命令。">!</span></span>
        <div class="picker" id="custom-runtime-picker"></div>
        <input id="custom-command" type="text" value="${CUSTOM_DEFAULT_COMMAND}" placeholder="例如 npx @deepseek-ai/dsh@next web" aria-label="自定义启动命令" />
        <p class="hint">写整条启动命令；只允许字母数字与 <code>- _ . / : = @ +</code> 和空格，引号、管道、重定向会被拒绝。壳会自动补上 <code>--no-open</code>。选中「环境」面板里的其它环境时不会改写这条命令——自己写进去才算数。</p>
      </div>
    </div>
  `;

  // 端口框用原生 number：只有它自带上下步进图标。图标平时透明、鼠标悬停或聚焦到框上才显形，
  // 但**始终占位**（透明度切换而非 display），否则显隐会让输入框内的可用宽度变化、文字左右挪。
  const portControl = `<input id="port" type="number" inputmode="numeric" min="1" max="65535" step="1" placeholder="例如 3099" />`;
  // 与启动方式同在主卡内、并排的两张小卡：「附加参数」与「端口」。
  const extraArgsBody = `<div class="fields">
      <label for="extra-args">附加参数 <span class="info-dot" role="img" tabindex="0" aria-label="附加参数说明" data-tip="追加到该启动方式的命令末尾（运行环境选 WSL 时追加到发行版内的命令后面）。仅允许字母数字与 - _ . / : = @ + 和空格；壳始终自动追加 --no-open（不自动弹浏览器），需要时用工具栏的「打开方式」。">!</span></label>
      <input id="extra-args" type="text" placeholder="例如 --port 3081 --no-open" />
    </div>`;
  const portBody = `<div class="fields">
      <label for="port">监听端口 <span id="port-info" class="info-dot" role="img" tabindex="0" aria-label="端口说明" data-tip="正在读取 DSH 配置…">!</span></label>
      <div class="port-row">${portControl}<button type="button" id="port-reset" class="square-btn" title="把端口还原为默认（留空 = 跟随 DSH 配置）" aria-label="还原端口">${ICON_REVERT}</button></div>
      <p class="hint" id="port-hint">留空即跟随 DSH 自身的配置。</p>
    </div>`;

  // 「桥接插件」浮窗：登录链接的可靠通道，恒装在启动用的 web 环境上。
  const bridgeBody = `
    <div class="kv">
      <div class="kv-row"><span class="kv-key">目标环境</span><span class="kv-value" id="bridge-target">—</span></div>
      <div class="kv-row"><span class="kv-key">安装状态</span><span class="kv-value" id="bridge-status">读取中…</span></div>
      <div class="kv-row"><span class="kv-key">最近备份</span><span class="kv-value" id="bridge-backup">—</span></div>
    </div>
    <p class="hint">安装后壳经 DSH 内部插件接口直接取带 token 的登录链接，不依赖日志格式；未安装时自动降级为日志解析（可用但较脆）。安装/卸载前请先停止 DSH。每次安装或卸载都会自动备份 profile 文件，只保留最近 5 份，超出后删掉最旧的。</p>
    <div class="actions bridge-actions">
      <button id="btn-bridge-install" class="primary">安装桥接插件</button>
      <button id="btn-bridge-uninstall">卸载</button>
      <button id="btn-bridge-restore">恢复最近备份</button>
      <button id="btn-bridge-backups">打开备份目录</button>
    </div>
    <p id="bridge-note" class="hint hidden"></p>
    <p id="bridge-error" class="error hidden"></p>
  `;

  // 「补丁层」浮窗：备份与还原所选环境的 cordis.patch.yml。
  const patchBody = `
    <p class="hint">补丁层是你手写的插件覆盖层，改坏了 DSH 可能起不来。改动前先备份一份，改坏了再还原回来：每个环境只保留最近 5 份备份；还原前会自动把当前版本另存一份，所以还原本身也能再退回去。补丁层与依赖都要重启 DSH 后才生效，操作前请先停止 DSH。</p>
    <div class="actions">
      <button id="btn-patch-backup" class="primary">备份补丁层</button>
    </div>
    <div id="patch-restore-confirm" class="profile-confirm hidden">
      <p id="patch-restore-confirm-text" class="hint"></p>
      <div class="actions">
        <button id="btn-patch-confirm-yes" class="danger">确定还原</button>
        <button id="btn-patch-confirm-no" class="ghost">取消</button>
      </div>
    </div>
    <p id="patch-note" class="hint hidden"></p>
    <p id="patch-error" class="error hidden"></p>
    <div id="patch-backup-list" class="patch-backup-list"></div>
  `;

  // 「关于」：只留版本与两个目录（仓库 / 官网的入口挪到了左栏底部的图标）。
  const aboutKv = `
    <div class="kv">
      <div class="kv-row"><span class="kv-key">壳版本</span><span class="kv-value" id="about-shell">${info.name} ${info.version}（核心库 ${info.core_version}）</span></div>
      <div class="kv-row"><span class="kv-key">DSH 版本</span><span class="kv-value" id="about-dsh">未知</span></div>
      <div class="kv-row"><span class="kv-key">开源许可证</span><span class="kv-value" id="about-license">${info.license}</span></div>
      <div class="kv-row kv-row-action"><span class="kv-key">配置目录</span><span class="kv-value" id="about-config-dir">${info.config_dir}</span><button id="btn-about-config" class="kv-action">打开</button></div>
      <div class="kv-row kv-row-action"><span class="kv-key">日志目录</span><span class="kv-value" id="about-logs-dir">${info.logs_dir}</span><button id="btn-about-logs" class="kv-action">打开</button></div>
    </div>
  `;
  const aboutTail = `
    <p id="about-note" class="hint hidden"></p>
    <p class="hint">DSH 版本在每次成功启动后自动读取；配置目录放壳设置与桥接备份，日志目录放 DSH 的启动日志（运行环境选 WSL 时日志在发行版内的 <code>~/.dsh/logs</code>）。</p>
  `;

  // 「关于」卡：一行小标题 + 版本与目录表。
  const aboutBody = `${colHead("版本与目录")}${aboutKv}${aboutTail}`;

  // 「日志」卡：标题与两颗按钮直接放在这张大卡上，日志正文是卡里唯一的一层内嵌卡片，
  // 自己滚。启动 / 重启 / 桥接 / 环境 / 缓存这些动作产生的输出不再把界面切到这里，
  // 只在左栏「日志」上挂未读数字提示多了几行。
  const logBody = `
    ${colHead("日志", `<div class="log-tools">
      <button id="btn-clear-log" class="log-action" type="button">清空日志</button>
      <button id="btn-copy-log" class="log-action" type="button">复制日志</button>
    </div>`)}
    <pre id="log" class="log-body">（暂无输出）</pre>
  `;

  // 分区共用同一套骨架：内容区就是一张主卡，里面每个条目各装一张小卡（卡中卡），
  // 超过高度时由主卡自己滚。并排的两项用 cellRow 包成两张小卡，留在主卡内部。
  const panels = [
    panelSection(
      "launch",
      // 命令预览不再单独一张小卡：它只跟「官方 npx 命令」这一项有关，已经跟着这一项的参数走了。
      mainCard([cell(modesBody), cellRow("1-1", extraArgsBody, portBody)]),
    ),
    panelSection("env", mainCard([cell(profilesBody), cell(pluginBody)])),
    panelSection("integ", mainCard([cell(cliBlockBody), cell(dshVersionsBody)])),
    panelSection(
      "traynet",
      // 托盘设置与网络与代理两张小卡等宽：内容不是一个量级（网络那边的说明长得多），
      // 但两张并排的卡宽窄不一、控件左右对不齐，观感更差；等宽后两列的标题、下拉框、
      // 说明都从同一条竖线起，看着才整齐。
      mainCard([cellRow("1-1", trayFields, networkFieldsBody), cell(selfCheckBody)]),
    ),
    // 日志分区是唯一不走「每项一张小卡」的分区：标题与按钮直接在大卡上，
    // 正文单独一层，所以这里把 logBody 直接铺进主卡，不套 cell。
    panelSection("log", mainCard([logBody], "main-card-log")),
    panelSection("about", mainCard([cell(aboutBody)])),
  ].join("\n");

  // 浮窗层：一颗遮罩 + 三张卡片式浮窗（桥接插件 / 补丁层 / 环境名输入）。
  // 遮罩负责点外面关闭，浮窗自己 stopPropagation 不受影响；Esc 与右上角的叉也能关。
  const modals = `
    <div id="modal-scrim" class="modal-scrim hidden"></div>
    <section id="modal-bridge" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-bridge-title">
      <header class="modal-head">
        <span class="modal-title" id="modal-bridge-title">桥接插件</span>
        <button class="modal-close" type="button" data-modal-close="bridge" title="关闭" aria-label="关闭">${ICON_MODAL_CLOSE}</button>
      </header>
      <div class="modal-body">${bridgeBody}</div>
    </section>
    <section id="modal-patch" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-patch-title">
      <header class="modal-head">
        <span class="modal-title" id="modal-patch-title">补丁层（cordis.patch.yml）</span>
        <button class="modal-close" type="button" data-modal-close="patch" title="关闭" aria-label="关闭">${ICON_MODAL_CLOSE}</button>
      </header>
      <div class="modal-body">
        <p class="hint">环境：<b id="patch-target">—</b></p>
        ${patchBody}
      </div>
    </section>
    <section id="modal-name" class="modal modal-tight hidden" role="dialog" aria-modal="true" aria-labelledby="modal-name-title">
      <header class="modal-head">
        <span class="modal-title" id="modal-name-title">环境名</span>
        <button class="modal-close" type="button" data-modal-close="name" title="关闭" aria-label="关闭">${ICON_MODAL_CLOSE}</button>
      </header>
      <div class="modal-body">
        <div class="fields" id="profile-manage-name-row">
          <input id="profile-manage-name" type="text" spellcheck="false" autocomplete="off" placeholder="例如 lab" aria-label="环境名">
        </div>
        <div id="profile-manage-confirm" class="profile-confirm hidden">
          <p id="profile-manage-confirm-text" class="hint"></p>
        </div>
        <p id="profile-manage-note" class="hint hidden"></p>
        <p id="profile-manage-error" class="error hidden"></p>
      </div>
      <footer class="modal-foot">
        <button id="btn-name-confirm" class="primary" type="button">确定</button>
        <button id="btn-name-cancel" class="ghost" type="button">取消</button>
      </footer>
    </section>
    <div id="env-menu" class="env-menu hidden" role="menu" aria-label="环境操作">
      <button type="button" role="menuitem" data-env-act="rename">重命名</button>
      <button type="button" role="menuitem" data-env-act="copy">复制</button>
      <button type="button" role="menuitem" data-env-act="delete" class="danger">删除</button>
      <button type="button" role="menuitem" data-env-act="deps">安装依赖</button>
      <button type="button" role="menuitem" data-env-act="patch">补丁层</button>
      <button type="button" role="menuitem" data-env-act="open">打开目录</button>
    </div>
  `;

  return `${titlebar}
  <div class="shell">
    ${sidebar}
    <main class="content">
      ${toolbar}
      ${statusErrorBlock}
      ${loginNoteBlock}
      <div class="content-main">
        <div class="page" id="page">${panels}</div>
      </div>
    </main>
  </div>
  ${modals}`;
}

