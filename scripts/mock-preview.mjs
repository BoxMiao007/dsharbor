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
  dshVersion: "0.2.0-rc.2",
  counter: 0,
  bridgeInstalls: 0,
  bridgeInstallFails: false,
  calls: {},
};

const stub = `<script>
window.__MOCK_STATE__ = ${JSON.stringify(state)};
window.__mockUnimplemented = [];
(function () {
  const S = window.__MOCK_STATE__;
  const seen = (name) => { S.calls[name] = (S.calls[name] || 0) + 1; };
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
      launch: { mode: { kind: "npx" }, extraArgs: [], port: null },
      trayClick: "launcher",
    }),
    save_shell_config: () => null,
    dsh_status: () => status(),
    bridge_state: () => bridgeState(),
    profile_port_hint: () => ({ port: 3080, source: "来自 DSH 配置的 webserver 块", hint: "" }),
    list_wsl_distros: () => ["Ubuntu", "Debian"],
    start_dsh: () => { seen("start_dsh"); S.counter += 1; S.session = "running"; return status(); },
    stop_dsh: () => { seen("stop_dsh"); S.counter += 1; S.session = "stopped"; return status(); },
    restart_dsh: () => { seen("restart_dsh"); S.counter += 1; S.session = "running"; return status(); },
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
