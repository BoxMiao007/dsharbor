#!/usr/bin/env node
/**
 * 前端改动的浏览器假数据预览台（AGENTS.md「完成定义」里的第一条验证手段）。
 *
 * 为什么要有它：真机（打包 → 静默安装 → 起 WebView2）一轮要几分钟，而界面改动
 * 九成能在普通浏览器里用假后端渲染出来看。做法是把 `dist/index.html` 拷成
 * `dist/mock.html`，在第一个 `<script` 之前注入一段假的 `window.__TAURI_INTERNALS__`，
 * 于是 main.ts 里的 `invoke(...)` 与窗口 API 全部有实现，界面在浏览器里照常渲染。
 *
 * 用法：
 *   pnpm build                                   # 先出 dist/
 *   node scripts/mock-preview.mjs                # 生成 dist/mock.html 并起 8123
 *   node scripts/mock-preview.mjs --port 8200    # 换端口
 *   node scripts/mock-preview.mjs --no-serve     # 只生成 mock.html，不起服务
 *
 * 从浏览器/调试协议里能直接改假状态：`__MOCK_STATE__.session = "running"`、
 * `__MOCK_STATE__.dshVersion = "0.1.0"` 等；点界面上的按钮同样会改它
 * （启动/停止/重启、装/卸桥接插件）。没实现的命令会记进
 * `window.__mockUnimplemented` 并打印到控制台——预览里出现异常时先看它。
 *
 * 它看不到的东西（这些只能上真机）：WebView2 与 Chromium 渲染差异（例如
 * `::-webkit-scrollbar` 在预览的 overlay 滚动条下被整段忽略）、无边框窗口的原生
 * 行为（拖动 / 缩放 / 贴靠）、真 DSH 进程与托盘、真实的 npx / WSL 启动。
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8123;
const serve = !args.includes("--no-serve");

/** 假后端的初始状态：直接改它就能换预览里的场景。 */
const state = {
  session: "stopped", // stopped | running | starting | failed
  /** true = 运行中但登录链接还没就绪（真实的「启动中」：running + 无登录链接）。 */
  loginPending: false,
  /** 设成一段文字可预览工具条下方那条「登录链接读不到」的黄色提示。 */
  loginError: null,
  dshVersion: "0.2.1-rc.2",
  /** 端口提示的假数据：改它就能预览「跟随 DSH 配置」与「没读到配置」两种分支。 */
  portHint: { host: "127.0.0.1", port: 3080, source: "managed" },
  /** WSL 发行版探测结果（`wsl_distro_info`）：改 hasNode 可预览「未检测到 Node.js」提示。 */
  distros: [
    { distro: "Ubuntu", hasNode: true },
    { distro: "Debian", hasNode: false },
  ],
  /** 官方版本列表（`query_dsh_versions`）：改成 null 可预览读取失败 / 断网时的分支。 */
  registry: {
    distTags: { latest: "0.2.1-rc.2" },
    versions: [
      "0.2.1-rc.2", "0.2.1-rc.1", "0.2.1-alpha.5", "0.2.1-alpha.4", "0.2.1-alpha.3",
      "0.2.0-rc.2", "0.2.0-rc.1", "0.2.0-alpha.2", "0.2.0-alpha.1", "0.1.9",
      "0.1.8", "0.1.7", "0.1.6", "0.1.5", "0.1.4", "0.1.3", "0.1.2", "0.1.1", "0.1.0",
    ],
  },
  /** 本机 npx 缓存里已有的版本（`npx_cached_versions`）：「已缓存」徽章按它挂。 */
  npxCachedVersions: ["0.2.1-rc.1", "0.2.0-rc.2"],
  /** 已保存的启动配置：改它并刷新页面就能预览各种保存/回填分支（如存了已下架的版本）。 */
  savedLaunch: {
    mode: { kind: "npx", version: null },
    runtime: { kind: "default" },
    extraArgs: [],
    port: null,
  },
  /** 已保存的壳设置：改这里并刷新页面就能预览各种保存/回填分支。 */
  savedShell: {
    trayClick: "launcher",
    lightDelaySecs: 0,
    // 「环境 / 网络 / 集成」三张卡承载的六个字段：删掉任意键可预览「旧配置缺键取默认」，
    // 填个不存在的枚举值可预览「手改坏了也不影响开壳」。
    profile: "web",
    downloadSource: "mirror",
    proxyMode: "system",
    proxyAddress: "",
    cliIntegration: false,
  },
  /** 系统代理的假数据：url 改成 null 可预览「跟随系统但系统里没配」。
      bypass 就是系统里那份例外列表（回环地址由后端补，这里不列）。 */
  systemProxy: { url: "127.0.0.1:7890", bypass: ["*.corp.example"], source: "env" },
  /** 自检（`self_check_network`）的假结果：改 state 可预览三种结论各自的文案
      （proxyOk / directOnly / bothFail），failure 是失败时多出来的那一行原因。 */
  selfCheck: {
    state: "proxyOk",
    failure: null,
  },
  counter: 0,
  /** 让运行中的日志尾巴别每秒自己长（测试要可复现时打开它，改 counter 就能造出一次性的一大批行）。 */
  freezeLog: false,
  bridgeInstalls: 0,
  bridgeInstallFails: false,
  /** 命令行集成的假状态：改它能预览开关打开/关闭、PATH 里没有目录、被别的 dsh 盖住、
      以及非 Windows 宿主（supported: false）等分支。enabled 默认跟 savedShell 走。 */
  cli: { supported: true, enabled: false, onPath: false, shadow: null },
  /** 设成 true 可预览「读取命令行集成状态失败」那条黄色提示。 */
  cliFails: false,
  /** 已装 DSH 的假数据（`installed_dsh_versions`）：npx 缓存里的几份 + npm 全局装的一份。
      改成 [] 可预览「本机还没装过」；把某份 version 设成 null 可预览「版本读不到」；
      卸掉 npm 全局那份（`uninstall_dsh_global`）后这张列表会少一行。 */
  installedDsh: [
    { version: "0.2.1-rc.2", source: "npx", path: "D:\\IT\\Scoop\\User\\persist\\nodejs\\cache\\_npx\\c8633a242642d858", inUse: true },
    { version: "0.2.0-rc.2", source: "npx", path: "D:\\IT\\Scoop\\User\\persist\\nodejs\\cache\\_npx\\50d2c97abf8f4186", inUse: false },
    { version: "0.1.9", source: "npm", path: "D:\\IT\\Scoop\\User\\persist\\nodejs\\bin\\node_modules\\@deepseek-ai\\dsh", inUse: false },
  ],
  /** 设成 true 可预览「读取已装 DSH 版本失败」那条黄色提示。 */
  installedDshFails: false,
  /** 环境列表（`list_profiles`）的假数据：删掉某项可预览「配置里记的环境已不在」，
      把 desktop 的 webCapable 改成 true 可确认它仍然被界面藏起来。
      把 profilesUnsupported 改成 true 可预览非 Windows 宿主下的「仅在 Windows 宿主可用」。 */
  profilesUnsupported: false,
  /** 网络卡（`proxy_state`）的假平台标记：改成 true 可预览非 Windows 宿主下
      整卡换成「仅在 Windows 宿主可用」的样子。 */
  networkUnsupported: false,
  /** 非空时 `save_shell_config` 按原文报错：预览「代理地址填错被后端拒收」那条路径。 */
  rejectShellSave: null,
  profiles: [
    { name: "web", plugins: 17, bridgeInstalled: true, webCapable: true, depsInstalled: true },
    { name: "lab", plugins: 4, bridgeInstalled: false, webCapable: true, depsInstalled: true },
    { name: "headless", plugins: 2, bridgeInstalled: false, webCapable: false, depsInstalled: false },
    { name: "desktop", plugins: 9, bridgeInstalled: true, webCapable: true, depsInstalled: true },
  ],
  /** 补丁层备份的假数据：按环境名分组（与后端 `<备份根>/patch/<目标>/<环境>/` 同构）。
      删掉某个环境可预览「还没有任何备份」那段提示。 */
  patchBackups: {
    web: [
      { name: "patch-1767000000.yml", path: "C:\\Users\\mock\\AppData\\Roaming\\DSHarbor\\backups\\patch\\host\\web\\patch-1767000000.yml", stamp: 1767000000 },
      { name: "patch-1767100000.yml", path: "C:\\Users\\mock\\AppData\\Roaming\\DSHarbor\\backups\\patch\\host\\web\\patch-1767100000.yml", stamp: 1767100000 },
    ],
    lab: [],
  },
  /** 重装依赖失败的假开关：设成 true 可预览「命令报错原文带回界面」那条分支。 */
  depsInstallFails: false,
  /** 插件清单（`plugin_list`）的假数据：按环境名分组。
      web 是真实环境的缩本（含读写两个内置骨架包、一个手写禁用、桥接）；headless 给
      一个空数组预览「零插件 + 去安装依赖」；lab 删掉就能预览「读到了但一项也没有」。 */
  plugins: {
    web: [
      { name: "@deepseek-ai/dsh-base", entries: [], enabled: true, bridge: false, manual: false, switchable: false, description: "DSH 官方内置骨架包：会话、工具与界面的基础挂载点。" },
      { name: "@deepseek-ai/dsh-web-app", entries: [], enabled: true, bridge: false, manual: false, switchable: false, description: "DSH 官方 Web 界面包，浏览器里那套界面本体。" },
      { name: "billion-context", entries: ["bili-native"], enabled: true, bridge: false, manual: false, switchable: true, description: "十亿级上下文记忆检索：压缩、折叠与按需还原历史对话。" },
      { name: "dsh-context", entries: ["dsh-context"], enabled: false, bridge: false, manual: false, switchable: true, description: "上下文管理与注入策略面板。" },
      { name: "dsh-better-sidebar", entries: ["better-sidebar"], enabled: false, bridge: false, manual: true, switchable: true, description: "增强版侧边栏：分组、置顶与拖拽排序。" },
      { name: "dsh-free-search", entries: ["web-search-free"], enabled: true, bridge: false, manual: false, switchable: true, description: "免 Key 聚合网络搜索，多引擎自动回退。" },
      { name: "dsh-local-tools", entries: ["local-tools"], enabled: true, bridge: false, manual: true, switchable: true, description: "本地打包的工具集（不上 registry，永远查不到版本）。" },
      { name: "dsh-skill-mcp-panel", entries: ["skill-mcp-panel"], enabled: false, bridge: false, manual: false, switchable: true, description: "技能与 MCP 服务的管理面板。" },
      { name: "dsharbor-bridge", entries: ["dsharbor-bridge"], enabled: true, bridge: true, manual: false, switchable: true, description: "本壳自带的桥接插件，在「桥接插件」浮窗里管理。" },
    ],
    lab: [
      { name: "@deepseek-ai/dsh-base", entries: [], enabled: true, bridge: false, manual: false, switchable: false, description: "DSH 官方内置骨架包：会话、工具与界面的基础挂载点。" },
      { name: "dsharbor-bridge", entries: ["dsharbor-bridge"], enabled: true, bridge: true, manual: false, switchable: true, description: "本壳自带的桥接插件，在「桥接插件」浮窗里管理。" },
    ],
    headless: [],
    desktop: [],
  },
  /** 插件更新检查（`plugin_updates_list`）的假数据：按环境名分组，形状照后端
      PluginUpdateItem（camelCase）。web 里安排了「可更新、停用也可更新（两行）、已最新、
      查不到」五种行，把行内渲染的分支都预览到；没配的环境返回 []。 */
  pluginUpdates: {
    web: [
      { name: "billion-context", current: "2.1.0", target: "2.3.0-rc.1", error: null, hasUpdate: true },
      { name: "dsh-context", current: "0.4.2", target: "0.4.2", error: null, hasUpdate: false },
      { name: "dsh-better-sidebar", current: "3.0.1", target: "3.2.0", error: null, hasUpdate: true },
      { name: "dsh-free-search", current: null, target: null, error: "读取插件「dsh-free-search」的版本列表失败：E404", hasUpdate: false },
      { name: "dsh-local-tools", current: "0.9.0", target: null, error: "读取插件「dsh-local-tools」的版本列表失败：E404", hasUpdate: false },
      { name: "dsh-skill-mcp-panel", current: "1.0.0", target: "1.1.0", error: null, hasUpdate: true },
    ],
  },
  /** 假命令的人工延时（毫秒，URL ?state= 可覆盖）：给「操作互斥」的接缝测试一个
      确定的忙态窗口——同步假结果会让忙态在两次 CDP 往返之间就消失，测不到中间态。 */
  pluginUpdateDelay: 0,
  pluginCheckDelay: 0,
  calls: {},
};

const stub = `<script>
window.__MOCK_STATE__ = ${JSON.stringify(state)};
// 调试协议 / 测试脚本可以直接改假状态：URL 带 ?state={"session":"running"} 就在首轮渲染前
// 覆盖初始值（只覆盖已声明的键，其余照旧），省掉「先开页再改再等刷新」那一步。
try {
  const fromUrl = new URLSearchParams(location.search).get("state");
  if (fromUrl) Object.assign(window.__MOCK_STATE__, JSON.parse(fromUrl));
} catch (err) {
  console.warn("[mock] URL 上的 ?state= 解析失败：", err);
}
window.__mockUnimplemented = [];
(function () {
  const S = window.__MOCK_STATE__;
  const seen = (name) => { S.calls[name] = (S.calls[name] || 0) + 1; };
  // 环境名校验：规则照核心库 dsharbor_core::profiles::validate_name 抄一份，只为预览时
  // 能看到「非法名字被拒绝」的样子（真正的判定在后端）。
  const checkProfileName = (name, list) => {
    if (!name) return "环境名不能为空";
    if (name.length > 64) return "环境名过长（最多 64 字符）：" + name;
    if (name === "." || name === "..") return "环境名不能是 " + name;
    if (!/^[A-Za-z0-9]/.test(name)) return "环境名必须以字母或数字开头：" + name;
    const bad = name.split("").find((ch) => !/[A-Za-z0-9._-]/.test(ch));
    if (bad) return "环境名包含不允许的字符 " + JSON.stringify(bad) + "：" + name + "（仅允许字母数字与 - _ .）";
    if (name === "desktop") return "「desktop」是官方桌面端的环境目录，不能用作名字";
    if (list.some((item) => item.name === name)) return "已经有同名环境「" + name + "」了";
    return null;
  };
  // DSH 正在运行时的拒绝文案：照核心库 dsharbor_core::patch_layer::session_busy 抄一份，
  // 只为预览「运行中点这些按钮会被挡下来」那条分支（真正的判定在后端）。
  const busyText = (action, profile) =>
    "DSH 正在运行，现在" + action + "会和运行中的进程争用环境「" + profile + "」的目录（pnpm 与 DSH 互相覆盖，结果不可预测）。\\n请先停止 DSH，再" + action + "。";
  const status = () => {
    const running = S.session === "running";
    const failed = S.session === "failed";
    return {
      state: S.session,
      pid: running ? 20704 : null,
      port: running ? 3099 : null,
      loginUrl: running ? "https://example.invalid/dsh?token=mock" : null,
      loginReady: running && !S.loginPending,
      loginError: S.loginError || null,
      // 真后端的 logTail 是最后 300 行（见 launcher.rs 的 LOG_TAIL_LINES）：预览也照这个形状给
      // 一段持续增长的尾巴，才能看出界面「只追加新增的那几行」的效果。
      logTail:
        S.session === "stopped"
          ? []
          : Array.from({ length: Math.min(20, S.counter + 1) }, (_, i) => "第 " + (S.counter - Math.min(20, S.counter + 1) + 1 + i) + " 行 mock 输出"),
      dshVersion: S.dshVersion,
    };
  };
  const bridgeState = () => ({
    installed: S.bridgeInstalls > 0,
    target: "Windows",
    profileDir: "C:\\\\Users\\\\me\\\\.dsh",
    detail: "",
    latestBackup: "backup-1760500000",
    backupCount: S.bridgeInstalls,
  });
  // 命令行集成的假状态：真实实现会读 HKCU\\Environment 并探测 dsh，这里只拼一份
  // 看上去像真的结果（目录取 app_info 的 configDir + \\bin）。
  // 垫片正文跟随传入的启动方式，预览里切完模式能直接看到正文变了。
  const shimForMode = (mode) => {
    const kind = (mode && mode.kind) || "npx";
    let target;
    if (kind === "system") target = "D:\\\\IT\\\\Scoop\\\\apps\\\\deepseek-harness\\\\dsh.cmd";
    else if (kind === "binary") target = '"' + ((mode && mode.path) || "D:\\\\tools\\\\dsh.cmd") + '"';
    else if (kind === "custom") target = (mode && mode.command) || "node D:\\\\tools\\\\dsh.js";
    else {
      const suffix = mode && mode.version ? "@" + mode.version : "";
      target = "npx --yes @deepseek-ai/dsh" + suffix;
    }
    return "@echo off\\r\\n" + target + " %*\\r\\n";
  };
  const cliIntegrationState = (cli) => {
    const binDir = "C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\DSHarbor\\\\bin";
    const enabled = !!cli.enabled;
    const onPath = !!cli.onPath;
    const shadow = cli.shadow === undefined ? null : cli.shadow;
    let message;
    if (!cli.supported) {
      message = "仅在 Windows 宿主可用：这里不会改动任何 shell 配置，可以复制下面的命令手动接入。";
    } else if (enabled && !onPath) {
      message = "开关已打开，但用户 PATH 里没有垫片目录（可能被其它工具改回去了），重新开关一次即可补回。";
    } else if (enabled && shadow) {
      message =
        "已接入。注意：PATH 里还有一份排在更前面的 " + shadow + "，终端会先命中它；要改用壳里的这份，把它挪到后面或删掉。";
    } else if (enabled) {
      message = "已接入：新开一个终端后 dsh 命令就指向壳里正在用的那份。";
    } else {
      message = "开关关闭：终端里的 dsh 与壳无关。";
    }
    return {
      supported: !!cli.supported,
      enabled: enabled,
      binDir: binDir,
      bin_dir: binDir,
      shimPath: binDir + "\\\\dsh.cmd",
      shim_path: binDir + "\\\\dsh.cmd",
      onPath: onPath,
      on_path: onPath,
      manualCommand: 'setx PATH "%PATH%;' + binDir + '"',
      manual_command: 'setx PATH "%PATH%;' + binDir + '"',
      shimText: cli.shimText === undefined ? "@echo off\\r\\nnpx --yes @deepseek-ai/dsh %*\\r\\n" : cli.shimText,
      shim_text: cli.shimText === undefined ? "@echo off\\r\\nnpx --yes @deepseek-ai/dsh %*\\r\\n" : cli.shimText,
      shimError: cli.shimError === undefined ? null : cli.shimError,
      shim_error: cli.shimError === undefined ? null : cli.shimError,
      systemDsh: "D:\\\\IT\\\\Scoop\\\\apps\\\\deepseek-harness\\\\dsh.cmd",
      system_dsh: "D:\\\\IT\\\\Scoop\\\\apps\\\\deepseek-harness\\\\dsh.cmd",
      shadow: shadow,
      message: message,
    };
  };
  const cmds = {
    app_info: () => ({
      name: "DSHarbor",
      version: "0.0.0-mock",
      coreVersion: "0.0.0-mock",
      core_version: "0.0.0-mock",
      repository: "https://github.com/BoxMiao007/dsharbor",
      siteUrl: "https://example.invalid/dsh",
      site_url: "https://example.invalid/dsh",
      license: "MIT",
      configDir: "C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\DSHarbor",
      config_dir: "C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\DSHarbor",
      logsDir: "C:\\\\Users\\\\me\\\\.dsh\\\\logs",
      logs_dir: "C:\\\\Users\\\\me\\\\.dsh\\\\logs",
    }),
    load_shell_config: () => ({
      launch: JSON.parse(JSON.stringify(S.savedLaunch)),
      ...JSON.parse(JSON.stringify(S.savedShell)),
    }),
    // 保存链路上看得到什么：存进 S.lastSavedShell，预览页控制台可查六个新字段有没有被带上。
    // S.rejectShellSave 有值（一段中文）时假装后端拒收这份配置——预览「代理地址填错、
    // 提示行显示拒绝理由」那条路径用。
    save_shell_config: (a) => {
      // 真后端的 Err(String) 到了界面就是一段字符串（没有 Error 前缀），这里也照原样拒。
      if (S.rejectShellSave) return Promise.reject(S.rejectShellSave);
      S.lastSavedShell = a && a.config;
      return null;
    },
    // 命令行集成：假状态。改 S.cli 里的字段就能预览各种分支
    // （supported:false 看「仅在 Windows 宿主可用」、shadow 有值看「排在更前面」提示）。
    cli_integration_state: () => {
      if (S.cliFails) throw "读不到 PATH";
      const cli = S.cli || (S.cli = { supported: true, enabled: false, onPath: false, shadow: null });
      if (cli.supported === undefined) cli.supported = true;
      if (cli.enabled === undefined) cli.enabled = !!S.savedShell.cliIntegration;
      if (cli.onPath === undefined) cli.onPath = false;
      return cliIntegrationState(cli);
    },
    set_cli_integration: (a) => {
      seen("set_cli_integration");
      const cli = S.cli || (S.cli = { supported: true, enabled: false, onPath: false, shadow: null });
      if (cli.supported === undefined) cli.supported = true;
      cli.enabled = !!(a && a.enabled);
      // 真实后端会同时改 PATH：这里跟着改，预览里才能看到开→关来回切的效果。
      cli.onPath = !!cli.enabled;
      // 垫片正文跟随当前启动方式重写（真实实现写盘，这里只记住给界面回显）。
      cli.shimText = cli.enabled ? shimForMode(a && a.config && a.config.mode) : cli.shimText;
      S.savedShell.cliIntegration = !!cli.enabled;
      return cliIntegrationState(cli);
    },
    // 「指定程序路径」的即时校验：只看格式与「不存在」两种，用来预览字段下方红字。
    // 抛字符串而不是 Error：真实 invoke 被拒时前端拿到的是纯文案，预览要跟真机一致。
    check_binary_path: (a) => {
      const p = (a && a.path) || "";
      if (!/^[A-Za-z]:\\\\.+\.(exe|cmd|bat)$/i.test(p)) {
        throw "请填写完整路径（如 D:\\\\tools\\\\dsh.cmd）：" + p;
      }
      if (/missing/i.test(p)) throw "找不到该文件：" + p;
      return null;
    },
    // 系统「打开文件」框：预览里没有原生对话框，直接返回 __MOCK_STATE__.dialogPick
    // （设成 null 模拟「用户取消」）。
    "plugin:dialog|open": () => (S.dialogPick === undefined ? "D:\\\\tools\\\\dsh.cmd" : S.dialogPick),
    // 代理状态：假实现按照 savedShell 的两个字段算出与核心库同一套结果
    // （地址归一化与文案在 Rust 侧只有一份，这里只预览界面怎么显示）。
    // 改 S.systemProxy.url 可预览「系统里没检测到代理」。
    proxy_state: () => {
      seen("proxy_state");
      const sys = S.systemProxy || (S.systemProxy = { url: null, bypass: [], source: "none" });
      const bypass = (sys.bypass || []).slice();
      // 真后端每次读的是存盘后的配置，所以这里优先用「刚保存的那一份」，否则预览里
      // 改完地址、点完模式后提示行不会跟着变，看不到真实的来回。
      const saved = S.lastSavedShell || S.savedShell;
      const mode = saved.proxyMode || "system";
      const raw = (saved.proxyAddress || "").trim();
      const normalize = (value) => {
        const text = String(value || "").trim();
        if (!text) return { error: "还没填代理地址，形如 http://127.0.0.1:7890" };
        if (/^socks[0-9a-z]*:[/][/]/i.test(text)) {
          return { error: "这里是 socks 代理，请填同一端口的 http 混合端口，形如 http://127.0.0.1:7890" };
        }
        const withScheme = /^[a-z][a-z0-9+.-]*:[/][/]/i.test(text) ? text : "http://" + text;
        const scheme = (/^([a-z][a-z0-9+.-]*):[/][/]/i.exec(withScheme) || [])[1] || "";
        if (scheme.toLowerCase() !== "http" && scheme.toLowerCase() !== "https") {
          return { error: "只支持 http 或 https 代理，不认识 " + scheme.toLowerCase() + ":// 开头的地址" };
        }
        let rest = withScheme.slice(scheme.length + 3).split(/[?#]/)[0];
        const slash = rest.indexOf("/");
        if (slash >= 0) rest = rest.slice(0, slash);
        const hostPort = rest.slice(rest.lastIndexOf("@") + 1);
        const host = hostPort.replace(/:\d+$/, "");
        if (!host) return { error: "地址里没解析出主机名，形如 http://127.0.0.1:7890" };
        return { url: scheme.toLowerCase() + "://" + rest };
      };
      const plain = (url, tail) =>
        (mode === "manual" ? "手动填写：DSH 与下载都走 " + url : "跟随系统：使用系统里配的代理 " + url) +
        "；回环地址始终直连" +
        (tail ? "，系统例外 " + tail + " 项一并直连" : "") +
        "。";
      let url = null;
      let hint;
      if (mode === "off") {
        hint = "不走代理：不向 DSH 下发任何代理环境变量。";
      } else if (mode === "manual") {
        const result = normalize(raw);
        if (result.error) hint = result.error;
        else {
          url = result.url;
          hint = plain(url, bypass.length);
        }
      } else if (sys.url) {
        const result = normalize(sys.url);
        if (result.error) hint = "跟随系统：系统里没检测到代理设置，请求直连。";
        else {
          url = result.url;
          hint = plain(url, bypass.length);
        }
      } else {
        hint = "跟随系统：系统里没检测到代理设置，请求直连。";
      }
      // 与真后端同一个口径：平台标记由后端给，自检失败时界面拼在结论后面的那句
      // 「当前代理：…」也在这里算（核心库 net::proxy_state_text 的镜像）。
      const stateText =
        url !== null
          ? "当前代理：" + url + (mode === "manual" ? "（手动填写）" : "（跟随系统）")
          : mode === "off"
            ? "当前代理：不走代理"
            : mode === "manual"
              ? "当前代理：还没填地址"
              : "当前代理：跟随系统（系统里没检测到代理）";
      return {
        supported: !S.networkUnsupported,
        url: url,
        bypass: url === null ? [] : bypass,
        hint: hint,
        stateText: stateText,
      };
    },
    dsh_status: () => status(),
    bridge_state: () => bridgeState(),
    // 已装 DSH 版本：只读扫描（npx 缓存 + npm 全局）。
    installed_dsh_versions: () => {
      seen("installed_dsh_versions");
      if (S.installedDshFails) throw "读取已装 DSH 版本失败：npm 不在 PATH 里";
      return S.installedDsh || [];
    },
    // 卸载 npm 全局那一份：从假数据里拿掉 source=npm 的行，界面重扫后少一行。
    uninstall_dsh_global: () => {
      seen("uninstall_dsh_global");
      const before = (S.installedDsh || []).length;
      S.installedDsh = (S.installedDsh || []).filter((item) => item.source !== "npm");
      if (S.installedDsh.length === before) {
        throw "npm 全局没有装 @deepseek-ai/dsh。";
      }
      return "已卸载全局安装的 DSH。";
    },
    // 删掉 npx 缓存里的某一份：按 path 从假数据里拿掉那一行。
    delete_dsh_npx: (args) => {
      seen("delete_dsh_npx");
      const before = (S.installedDsh || []).length;
      S.installedDsh = (S.installedDsh || []).filter(
        (item) => !(item.source === "npx" && item.path === args?.path),
      );
      if (S.installedDsh.length === before) {
        throw "这一份 npx 安装已经不在缓存里了，刷新一下列表。";
      }
      return "已删掉 npx 缓存里的那一份。";
    },
    profile_port_hint: () => S.portHint,
    // 环境列表：S.profiles 改成 [] 可预览「一个能起网页的环境都没有」；
    // S.profilesUnsupported 改成 true 可预览非 Windows 宿主（整卡收起、只说一句）。
    list_profiles: () => {
      seen("list_profiles");
      if (S.profilesUnsupported) {
        return { supported: false, profiles: [] };
      }
      return { supported: true, profiles: S.profiles || [] };
    },
    // ---- 环境生命周期（新建 / 复制 / 重命名 / 删除 / 重装依赖）----------------
    // 假后端把 S.profiles 当成真清单来改，所以预览里连着点几下就能看到下拉、徽章与
    // 管理面板一起变。名字校验也照核心库的规则在本文件里做一份，只为预览时能看到
    // 那些拒绝原因（真判在后端）。
    create_profile: (a) => {
      seen("create_profile:" + (a && a.name ? a.name : "?"));
      const name = (a && a.name ? a.name : "").trim();
      const bad = checkProfileName(name, S.profiles);
      if (bad) throw bad;
      const item = { name: name, plugins: 2, bridgeInstalled: false, webCapable: true, depsInstalled: false };
      S.profiles.push(item);
      return { ok: true, message: "已在 Windows 上新建空白环境「" + name + "」（只写了骨架文件，还没装依赖）。", name: name, summary: item };
    },
    copy_profile: (a) => {
      seen("copy_profile:" + (a && a.source ? a.source : "?") + "->" + (a && a.name ? a.name : "?"));
      const name = (a && a.name ? a.name : "").trim();
      const bad = checkProfileName(name, S.profiles);
      if (bad) throw bad;
      const source = S.profiles.find((p) => p.name === (a && a.source));
      const item = { name: name, plugins: source ? source.plugins : 0, bridgeInstalled: false, webCapable: source ? source.webCapable : true, depsInstalled: false };
      S.profiles.push(item);
      return { ok: true, message: "已复制「" + (a && a.source) + "」为「" + name + "」（3 项配置与数据，依赖目录与锁文件未复制）。跳过：node_modules、pnpm-lock.yaml。新环境还没装依赖，点「重装依赖」补齐后才能启动。", name: name, summary: item };
    },
    rename_profile: (a) => {
      seen("rename_profile:" + (a && a.oldName ? a.oldName : "?") + "->" + (a && a.name ? a.name : "?"));
      const name = (a && a.name ? a.name : "").trim();
      const bad = checkProfileName(name, S.profiles);
      if (bad) throw bad;
      const item = S.profiles.find((p) => p.name === (a && a.oldName));
      if (!item) throw "找不到要重命名的环境「" + (a && a.oldName) + "」。";
      item.name = name;
      if (S.savedShell && S.savedShell.profile === (a && a.oldName)) S.savedShell.profile = name;
      return { ok: true, message: "已把「" + (a && a.oldName) + "」重命名为「" + name + "」（目录与清单里的名字都改了）。", name: name, summary: item };
    },
    delete_profile: (a) => {
      seen("delete_profile:" + (a && a.name ? a.name : "?"));
      const name = a && a.name;
      if (name === "desktop") throw "这是官方桌面端的环境目录，不允许删除：desktop";
      if (S.savedShell && S.savedShell.profile === name) throw "「" + name + "」是当前启动用的环境，先切到别的环境再删除。";
      const index = S.profiles.findIndex((p) => p.name === name);
      if (index < 0) throw "找不到要删除的环境「" + name + "」。";
      S.profiles.splice(index, 1);
      return { ok: true, message: "已删除环境「" + name + "」。", name: name, summary: null };
    },
    install_profile_deps: (a) => {
      seen("install_profile_deps:" + (a && a.name ? a.name : "?"));
      const item = S.profiles.find((p) => p.name === (a && a.name));
      if (!item) throw "找不到环境「" + (a && a.name) + "」。";
      if (S.session === "running") throw busyText("重装依赖", item.name);
      if (S.depsInstallFails) {
        // 失败分支：与后端一样给退出码与输出尾部，看看界面能不能把原因完整转述。
        return {
          ok: false,
          message:
            "重装依赖：dsh plugin --profile " + item.name + " install（经 Windows）\\n退出码：1\\n校验：仍未看到 node_modules ✗（安装可能未生效）\\n输出：\\n" +
            "ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@deepseek-ai%2Fdsh-base: Not Found - 404\\n" +
            "This error was caused by not finding a package in the npm registry.\\n" +
            "Progress: resolved 1, reused 0, downloaded 0, added 0",
          name: item.name,
          summary: item,
        };
      }
      item.depsInstalled = true;
      return {
        ok: true,
        message:
          "重装依赖：dsh plugin --profile " + item.name + " install（经 Windows）\\n退出码：0\\n校验：node_modules 已就位 ✓\\n输出：\\n" +
          "Packages: +412\\nProgress: resolved 412, reused 402, downloaded 10, added 412, done\\nDone in 21.4s",
        name: item.name,
        summary: item,
      };
    },
    // ---- 补丁层备份 / 还原 --------------------------------------------------
    patch_backups: (a) => {
      seen("patch_backups:" + (a && a.name ? a.name : "?"));
      return (S.patchBackups && S.patchBackups[a && a.name]) || [];
    },
    patch_backup: (a) => {
      seen("patch_backup:" + (a && a.name ? a.name : "?"));
      const name = a && a.name;
      if (S.session === "running") throw busyText("备份补丁层", name);
      const list = (S.patchBackups[name] = S.patchBackups[name] || []);
      const stamp = Math.max(Math.floor(Date.now() / 1000), (list[0] ? list[list.length - 1].stamp : 0) + 1);
      const file = "patch-" + stamp + ".yml";
      const path = "C:\\\\Users\\\\mock\\\\AppData\\\\Roaming\\\\DSHarbor\\\\backups\\\\patch\\\\host\\\\" + name + "\\\\" + file;
      list.push({ name: file, path: path, stamp: stamp });
      return {
        message:
          "已备份环境「" + name + "」的补丁层（cordis.patch.yml，经 Windows）到：\\n" + path + "\\n每个环境只保留最近 5 份补丁层备份。",
        path: path,
        backups: list,
      };
    },
    patch_restore: (a) => {
      seen("patch_restore:" + (a && a.name ? a.name : "?") + "/" + (a && a.backup ? a.backup : "?"));
      const name = a && a.name;
      if (S.session === "running") throw busyText("还原补丁层", name);
      const list = (S.patchBackups[name] = S.patchBackups[name] || []);
      const source = list.find((item) => item.name === (a && a.backup));
      if (!source) throw "读不到补丁层备份：" + (a && a.backup);
      const stamp = (list[0] ? list[list.length - 1].stamp : 0) + 1;
      const savedName = "patch-" + stamp + ".yml";
      const saved = "C:\\\\Users\\\\mock\\\\AppData\\\\Roaming\\\\DSHarbor\\\\backups\\\\patch\\\\host\\\\" + name + "\\\\" + savedName;
      list.push({ name: savedName, path: saved, stamp: stamp });
      return {
        message:
          "已把环境「" + name + "」的补丁层还原成：\\n" + source.path + "\\n（已写回 Windows 上的 cordis.patch.yml）\\n还原前的版本已另存一份，想反悔就再还原它：\\n" + saved + "\\n补丁层要重启 DSH 后才生效。",
        path: saved,
        backups: list,
      };
    },
    // ---- 插件开关 ------------------------------------------------------------
    plugin_list: (a) => {
      seen("plugin_list:" + (a && a.name ? a.name : "?"));
      return (S.plugins && S.plugins[a && a.name]) || [];
    },
    plugin_toggle: (a) => {
      const name = a && a.name;
      const plugin = a && a.plugin;
      const enabled = !!(a && a.enabled);
      seen("plugin_toggle:" + name + "/" + plugin + "/" + (enabled ? "on" : "off"));
      if (S.session === "running") {
        throw busyText(enabled ? "打开插件开关" : "关闭插件开关", name);
      }
      const list = S.plugins[name] || (S.plugins[name] = []);
      const item = list.find((it) => it.name === plugin);
      if (!item) throw "环境「" + name + "」里没有登记插件「" + plugin + "」，可能是清单刚变过，刷新后再试。";
      if (!item.switchable) throw "读不到「" + plugin + "」在补丁层里的挂载点，壳没法安全地开关它。";
      item.enabled = enabled;
      // 开关前自动备份：与后端一样，先备份再写文件，所以列表会跟着长一条。
      const backups = (S.patchBackups[name] = S.patchBackups[name] || []);
      const stamp = Math.max(Math.floor(Date.now() / 1000), (backups.length ? backups[backups.length - 1].stamp : 0) + 1);
      const file = "patch-" + stamp + ".yml";
      const path = "C:\\\\Users\\\\mock\\\\AppData\\\\Roaming\\\\DSHarbor\\\\backups\\\\patch\\\\host\\\\" + name + "\\\\" + file;
      backups.push({ name: file, path: path, stamp: stamp });
      return {
        message:
          (enabled
            ? "已打开「" + plugin + "」的插件开关，重启 DSH 后生效。"
            : "已关闭「" + plugin + "」的插件开关，重启 DSH 后生效；插件包还在磁盘上，重新打开不需要重新下载。") +
          "已自动备份补丁层：" + path,
        backup: path,
        warning:
          plugin === "dsharbor-bridge" && !enabled
            ? "桥接插件已关闭：DSH 每次启动会动态生成登录链接，关掉桥接后壳取不到它，只能从日志里翻。"
            : null,
        items: list,
      };
    },
    // ---- 插件更新 --------------------------------------------------------------
    plugin_updates_list: (a) => {
      seen("plugin_updates_list:" + (a && a.name ? a.name : "?") + "/" + (a && a.force ? "force" : "cached"));
      const rows = (S.pluginUpdates && S.pluginUpdates[a && a.name]) || [];
      return S.pluginCheckDelay > 0
        ? new Promise((done) => setTimeout(() => done(rows), S.pluginCheckDelay))
        : rows;
    },
    plugin_update: (a) => {
      const name = a && a.name;
      const plugin = a && a.plugin;
      seen("plugin_update:" + name + "/" + (plugin || "all"));
      if (S.session === "running") {
        throw busyText("更新插件", name);
      }
      const rows = (S.pluginUpdates[name] = S.pluginUpdates[name] || []);
      const scope = plugin ? rows.filter((it) => it.name === plugin) : rows.filter((it) => it.hasUpdate);
      if (plugin && scope.length === 0) {
        throw "环境「" + name + "」的更新清单里没有插件「" + plugin + "」，先「检查更新」再试。";
      }
      const done = [];
      for (const it of scope) {
        if (!it.hasUpdate) continue;
        it.current = it.target;
        it.hasUpdate = false;
        done.push(it.name + "@" + it.current);
      }
      const message = plugin
        ? done.length
          ? "已把「" + plugin + "」更新到 " + done[0].split("@").pop() + "。重启 DSH 后生效。"
          : "已是最新版本，未做任何改动。"
        : done.length === 0
          ? "没有需要更新的插件。"
          : "全部更新完成：成功 " + done.length + " 个（" + done.join("、") + "）。重启 DSH 后生效。";
      const result = {
        ok: true,
        message: message,
        backupDir: "C:\\Users\\mock\\AppData\\Roaming\\DSHarbor\\backups\\backup-mock",
      };
      return S.pluginUpdateDelay > 0
        ? new Promise((done) => setTimeout(() => done(result), S.pluginUpdateDelay))
        : result;
    },
    // 预览里不再单独提供 list_wsl_distros：运行环境下拉走带 node/npm 标记的 wsl_distro_info。
    wsl_distro_info: () => S.distros,
    // 官方版本列表：S.registry 改成 null 就能预览「读取失败 + 刷新按钮转圈」。
    // 下载源记进 calls（键名形如 query_dsh_versions:official），预览时一眼能看出这次请求带的是哪个源。
    query_dsh_versions: (a) => {
      seen("query_dsh_versions:" + (a && a.source ? a.source : "?") + (a && a.force ? ":force" : ""));
      if (S.registry === null) throw "npm view @deepseek-ai/dsh versions 失败：ENOTFOUND registry.npmjs.org";
      return S.registry;
    },
    // 本机 npx 缓存里现有的版本：「已缓存」徽章的数据源（预览里固定给一组假版本）。
    npx_cached_versions: () => {
      seen("npx_cached_versions");
      return S.npxCachedVersions || [];
    },

    // 自检：结论与失败原因都从 __MOCK_STATE__.selfCheck 来（改它能预览三种文案），
    // 下载源与代理地址按当前存盘配置填，跟真后端一样是「这次实际用的那两者」。
    self_check_network: (a) => {
      const source = (a && a.source) || "inherit";
      seen("self_check_network:" + source);
      const check = S.selfCheck || (S.selfCheck = { state: "proxyOk", failure: null });
      const saved = S.lastSavedShell || S.savedShell;
      const mode = saved.proxyMode || "system";
      const registries = { mirror: "https://registry.npmmirror.com", official: "https://registry.npmjs.org" };
      const registry = registries[source] || null;
      const proxyUrl = mode === "off" ? null : mode === "manual" ? (saved.proxyAddress || null) : ((S.systemProxy || {}).url || null);
      const via = check.state === "proxyOk" && proxyUrl ? "proxy" : "direct";
      return {
        state: check.state,
        via: via,
        registry: registry,
        proxy: via === "proxy" ? proxyUrl : null,
        failure:
          check.state === "bothFail"
            ? check.failure ||
              "域名解析不到：可能是断网、DNS 被改，或者这条网络把域名拦了。（npm error code ENOTFOUND）"
            : null,
      };
    },
    start_dsh: () => { seen("start_dsh"); S.counter += 1; S.session = "running"; return status(); },
    stop_dsh: () => { seen("stop_dsh"); S.counter += 1; S.session = "stopped"; return status(); },
    restart_dsh: () => { seen("restart_dsh"); S.counter += 1; S.session = "running"; return status(); },
    // 工具条主按钮区在「运行中」时点「重启 DSH」：与 start_dsh 一样产生输出。
    // 「复制登录链接」每次现取（token 是一次性铸造的），预览里给个固定假地址。
    dsh_login_url: () => {
      seen("dsh_login_url");
      return "http://127.0.0.1:3099/?token=mock-token";
    },
    // 主题镜像给 Rust（开窗前定 WebView 底色）。预览里没有窗口，记一笔即可。
    save_ui_theme: (a) => {
      seen("save_ui_theme:" + (a && a.theme ? a.theme : "?"));
      return null;
    },
    bridge_install: () => {
      seen("bridge_install");
      if (S.bridgeInstallFails) throw new Error("mock：安装失败（可把 __MOCK_STATE__.bridgeInstallFails 改回 false）");
      S.bridgeInstalls += 1;
      return { ok: true, message: "已安装桥接插件（Mock 返回）", backupDir: null, backup_dir: null };
    },
    bridge_uninstall: () => { seen("bridge_uninstall"); S.bridgeInstalls = 0; return { ok: true, message: "已卸载桥接插件（Mock 返回）" }; },
    bridge_restore: () => { seen("bridge_restore"); return { ok: true, message: "已回滚到备份（Mock 返回）" }; },
    open_dsh_window: () => { seen("open_dsh_window"); return null; },
    open_dsh_in_browser: () => { seen("open_dsh_in_browser"); return null; },
    open_external: (a) => { seen("open_external:" + (a && a.target ? a.target : "?")); return null; },
    open_shell_dir: (a) => {
      seen("open_shell_dir:" + (a && a.kind ? a.kind : "?"));
      return "C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\DSHarbor\\\\" + (a && a.kind ? a.kind : "");
    },
    "plugin:window|minimize": () => null,
    "plugin:window|toggle_maximize": () => null,
    "plugin:window|close": () => null,
    "plugin:window|start_dragging": () => null,
    "plugin:window|is_maximized": () => false,
    "plugin:window|is_decorated": () => false,
    "plugin:window|set_decorations": () => null,
    "plugin:window|set_theme": () => null,
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: (cb) => {
      const id = Math.floor(Math.random() * 1e9);
      window["_" + id] = cb;
      return id;
    },
    invoke: async (cmd, a) => {
      const handler = cmds[cmd];
      if (!handler) {
        window.__mockUnimplemented.push(cmd);
        console.warn("[mock] 未实现的命令：", cmd);
        throw new Error("mock 未实现的命令: " + cmd);
      }
      return handler(a === undefined ? {} : a);
    },
  };
  // 运行中时日志行每秒增长，用来验证「滚动 / 拖选时界面不会被刷没」
  window.setInterval(() => { if (S.session === "running" && !S.freezeLog) S.counter += 1; }, 1000);
})();
</script>
`;

const source = readFileSync(join(dist, "index.html"), "utf8");
if (!source.includes("<script")) throw new Error("dist/index.html 里没有 <script>，先跑 pnpm build");
const mockHtml = source.replace("<script", stub + "<script");
writeFileSync(join(dist, "mock.html"), mockHtml);
console.log(`已生成 dist/mock.html（${mockHtml.length} 字节）`);

if (!serve) process.exit(0);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

createServer((req, res) => {
  const path = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = join(dist, path === "/" ? "index.html" : path);
  if (!file.startsWith(dist)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`假数据预览：http://127.0.0.1:${port}/mock.html （Ctrl-C 停）`);
  console.log("本机若有 http_proxy，用 curl 检查端口要加 --noproxy '*'，否则会拿到代理的 502");
});
