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
    distTags: { latest: "0.2.0-rc.2", next: "0.2.1-rc.2", alpha: "0.2.1-alpha.5" },
    rc: ["0.2.1-rc.2", "0.2.1-rc.1", "0.2.0-rc.2", "0.2.0-rc.1"],
    alpha: ["0.2.1-alpha.5", "0.2.1-alpha.4", "0.2.1-alpha.3"],
  },
  /** 已保存的启动配置：改它并刷新页面就能预览各种保存/回填分支（如存了已下架的版本）。 */
  savedLaunch: {
    mode: { kind: "npx", channel: "latest", version: null },
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
    cacheCleanup: false,
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
  bridgeInstalls: 0,
  bridgeInstallFails: false,
  /** 「启动后自动清理」的假结果：start_dsh / restart_dsh 在缓存开关打开时把结果写进这里，
      `auto_cleanup_report` 按 since 返回新的一次（改 autoCleanup 可预览各种结果文案）。 */
  autoCleanup: null,
  autoCleanupSeq: 0,
  /** 命令行集成的假状态：改它能预览开关打开/关闭、PATH 里没有目录、被别的 dsh 盖住、
      以及非 Windows 宿主（supported: false）等分支。enabled 默认跟 savedShell 走。 */
  cli: { supported: true, enabled: false, onPath: false, shadow: null },
  /** npx 缓存盘面的假数据：dirs 里 keep=true 的是保留的（current 那份必保留），
      其余会被「立即清理」删掉；把 cleanupFails 设为 true 可预览「删不掉 + 逐条原因」分支。 */
  cache: {
    supported: true,
    rootSource: "npm",
    warning: null,
    cleanupFails: false,
    dirs: [
      { name: "1e7f6d9597241db0", label: "@deepseek-ai/dsh（1e7f6d95）", bytes: 486539264, keep: true, current: true },
      { name: "50d2c97abf8f4186", label: "@deepseek-ai/dsh@next（50d2c97a）", bytes: 412090368, keep: false, current: false },
      { name: "c8633a242642d858", label: "@deepseek-ai/dsh@0.2.1-rc.2（c8633a24）", bytes: 297795584, keep: false, current: false },
    ],
  },
  /** 环境列表（`list_profiles`）的假数据：删掉某项可预览「配置里记的环境已不在」，
      把 desktop 的 webCapable 改成 true 可确认它仍然被界面藏起来。 */
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
      { name: "@deepseek-ai/dsh-base", entries: [], enabled: true, bridge: false, manual: false, switchable: false },
      { name: "@deepseek-ai/dsh-web-app", entries: [], enabled: true, bridge: false, manual: false, switchable: false },
      { name: "billion-context", entries: ["bili-native"], enabled: true, bridge: false, manual: false, switchable: true },
      { name: "dsh-context", entries: ["dsh-context"], enabled: false, bridge: false, manual: false, switchable: true },
      { name: "dsh-better-sidebar", entries: ["better-sidebar"], enabled: false, bridge: false, manual: true, switchable: true },
      { name: "dsh-free-search", entries: ["web-search-free"], enabled: true, bridge: false, manual: false, switchable: true },
      { name: "dsh-skill-mcp-panel", entries: ["skill-mcp-panel"], enabled: false, bridge: false, manual: false, switchable: true },
      { name: "dsharbor-bridge", entries: ["dsharbor-bridge"], enabled: true, bridge: true, manual: false, switchable: true },
    ],
    lab: [
      { name: "@deepseek-ai/dsh-base", entries: [], enabled: true, bridge: false, manual: false, switchable: false },
      { name: "dsharbor-bridge", entries: ["dsharbor-bridge"], enabled: true, bridge: true, manual: false, switchable: true },
    ],
    headless: [],
    desktop: [],
  },
  calls: {},
};

const stub = `<script>
window.__MOCK_STATE__ = ${JSON.stringify(state)};
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
      loginError: null,
      logTail: S.session === "stopped" ? [] : ["第 " + S.counter + " 行 mock 输出"],
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
      const suffix = mode && mode.channel === "next" ? "@next" : mode && mode.version ? "@" + mode.version : "";
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
      manualCommand: 'export PATH="$PATH:' + binDir + '"',
      manual_command: 'export PATH="$PATH:' + binDir + '"',
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
  // 字节数的显示形式（1024 进制，B 取整、其余 1 位小数），与核心库的 human_bytes 一致；
  // 真实后端会把算好的文字一起送过来，这里只是为了假数据看着像真的。
  const humanBytes = (bytes) => {
    if (bytes < 1024) return bytes + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return value.toFixed(1) + " " + units[i];
  };
  // 缓存盘面的假状态：只含属于本包的目录，与真实后端一个口径。
  // 可回收 = keep=false 的字节和，份数与文案都跟着算，改 S.cache.dirs 就能预览各种分支。
  const cacheState = (cache) => {
    const dirs = (cache.dirs || []).map((dir) => ({
      name: dir.name,
      label: dir.label,
      bytes: dir.bytes,
      bytesText: humanBytes(dir.bytes),
      bytes_text: humanBytes(dir.bytes),
      keep: !!dir.keep,
      current: !!dir.current,
    }));
    const ownBytes = dirs.reduce((sum, dir) => sum + dir.bytes, 0);
    const removable = dirs.filter((dir) => !dir.keep);
    const reclaimable = removable.reduce((sum, dir) => sum + dir.bytes, 0);
    const current = dirs.find((dir) => dir.current);
    let message;
    if (!cache.supported) {
      message = "缓存盘面仅在 Windows 宿主可用。";
    } else if (dirs.length === 0) {
      message = "没找到本包的 npx 缓存：本包还没用 npx 跑过时这里就是空的。只统计明确记录着本包的目录，别的包不计入。";
    } else if (removable.length === 0) {
      message = "本包占用 " + humanBytes(ownBytes) + "（" + dirs.length + " 份），没有可回收的部分：保留份数已经覆盖全部。";
    } else {
      message =
        "本包占用 " +
        humanBytes(ownBytes) +
        "（" +
        dirs.length +
        " 份），可回收 " +
        humanBytes(reclaimable) +
        "（" +
        removable.length +
        " 份）。清理会保留当前启动配置对应的那份加最近用过的几份，其余删除；npm 的包体缓存不动，下次启动不用重新下载。";
    }
    const warning = cache.warning === undefined ? null : cache.warning;
    return {
      supported: !!cache.supported,
      root: cache.root === undefined ? "D:\\\\IT\\\\Scoop\\\\User\\\\persist\\\\nodejs\\\\cache" : cache.root,
      rootSource: cache.rootSource || "npm",
      root_source: cache.rootSource || "npm",
      ownBytes: ownBytes,
      own_bytes: ownBytes,
      ownBytesText: humanBytes(ownBytes),
      own_bytes_text: humanBytes(ownBytes),
      ownCount: dirs.length,
      own_count: dirs.length,
      reclaimableBytes: reclaimable,
      reclaimable_bytes: reclaimable,
      reclaimableBytesText: humanBytes(reclaimable),
      reclaimable_bytes_text: humanBytes(reclaimable),
      removableCount: removable.length,
      removable_count: removable.length,
      keepCount: dirs.length - removable.length,
      keep_count: dirs.length - removable.length,
      current: current ? current.name : null,
      message: message,
      warning: warning,
      dirs: dirs,
    };
  };
  // 清理的实际动作（与「立即清理」按钮和「启动后自动清理」共用一份，真后端也是同一个函数）。
  const doCleanup = () => {
    const cache = S.cache || (S.cache = { supported: true, dirs: [] });
    const removable = (cache.dirs || []).filter((dir) => !dir.keep);
    const freedBytes = removable.reduce((sum, dir) => sum + dir.bytes, 0);
    if (cache.cleanupFails) {
      return {
        removed: [],
        failed: removable.map((dir) => ({
          label: dir.label,
          path: "D:\\\\IT\\\\Scoop\\\\User\\\\persist\\\\nodejs\\\\cache\\\\_npx\\\\" + dir.name,
          reason: "文件被占用（可能 DSH 正在运行）：拒绝访问。 (os error 32)",
        })),
        freedBytes: 0,
        freed_bytes: 0,
        message: "这次一个目录都没能清掉，原因见下面的逐条结果。",
        state: cacheState(cache),
      };
    }
    cache.dirs = (cache.dirs || []).filter((dir) => dir.keep);
    return {
      removed: removable.map((dir) => ({
        label: dir.label,
        bytes: dir.bytes,
        bytesText: humanBytes(dir.bytes),
        bytes_text: humanBytes(dir.bytes),
      })),
      failed: [],
      freedBytes: freedBytes,
      freed_bytes: freedBytes,
      message:
        removable.length === 0
          ? "没有需要清理的目录。"
          : "已清掉 " + removable.length + " 个目录，释放 " + humanBytes(freedBytes) + "。",
      state: cacheState(cache),
    };
  };
  // 真的 DSH 拉起成功后、开关开着时，后端会自己跑一次清理并把结果留着等界面来取。
  // 预览里用假数据把这条链路补上：只有开关开着才跑，且每次 seq 自增一次。
  const maybeAutoCleanup = () => {
    const shell = S.lastSavedShell || S.savedShell;
    if (!shell || !shell.cacheCleanup) return;
    const result = doCleanup();
    S.autoCleanupSeq = (S.autoCleanupSeq || 0) + 1;
    S.autoCleanup = {
      seq: S.autoCleanupSeq,
      message: "启动后自动清理：" + result.message,
      result: result,
    };
  };
  const cmds = {    app_info: () => ({
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
    save_shell_config: (a) => {
      S.lastSavedShell = a && a.config;
      return null;
    },
    // 命令行集成：假状态。改 S.cli 里的字段就能预览各种分支
    // （supported:false 看「仅在 Windows 宿主可用」、shadow 有值看「排在更前面」提示）。
    cli_integration_state: () => {
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
      return { url: url, bypass: url === null ? [] : bypass, hint: hint };
    },
    dsh_status: () => status(),
    bridge_state: () => bridgeState(),
    // 缓存盘面：只读扫描。
    cache_state: () => {
      const cache = S.cache || (S.cache = { supported: true, dirs: [] });
      return cacheState(cache);
    },
    // 立即清理：把 keep=false 的目录从假数据里拿掉，返回逐条结果与清理后的新盘面。
    // cleanupFails=true 时假装删不掉（预览「没清掉 + 原因」那几行）。
    cleanup_cache: () => {
      seen("cleanup_cache");
      return doCleanup();
    },
    // 启动后自动清理的结果：since 是界面已经播报过的序号，只有更新的才返回。
    auto_cleanup_report: (a) => {
      seen("auto_cleanup_report");
      const report = S.autoCleanup;
      const since = (a && a.since) || 0;
      return report && report.seq > since ? report : null;
    },
    profile_port_hint: () => S.portHint,
    // 环境列表：S.profiles 改成 [] 可预览「一个能起网页的环境都没有」。
    list_profiles: () => {
      seen("list_profiles");
      return S.profiles || [];
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
    // 预览里不再单独提供 list_wsl_distros：运行环境下拉走带 node/npm 标记的 wsl_distro_info。
    wsl_distro_info: () => S.distros,
    // 官方版本列表：S.registry 改成 null 就能预览「读取失败 + 重新读取按钮」。
    // 下载源记进 calls（键名形如 query_dsh_versions:official），预览时一眼能看出这次请求带的是哪个源。
    query_dsh_versions: (a) => {
      seen("query_dsh_versions:" + (a && a.source ? a.source : "?"));
      if (S.registry === null) throw "npm view @deepseek-ai/dsh versions 失败：ENOTFOUND registry.npmjs.org";
      return S.registry;
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
    start_dsh: () => { seen("start_dsh"); S.counter += 1; S.session = "running"; maybeAutoCleanup(); return status(); },
    stop_dsh: () => { seen("stop_dsh"); S.counter += 1; S.session = "stopped"; return status(); },
    restart_dsh: () => { seen("restart_dsh"); S.counter += 1; S.session = "running"; maybeAutoCleanup(); return status(); },
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
    // 系统标题栏取色（Windows 专用），预览里没有窗口，直接当成功。
    set_caption_color: () => null,
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
  window.setInterval(() => { if (S.session === "running") S.counter += 1; }, 1000);
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
