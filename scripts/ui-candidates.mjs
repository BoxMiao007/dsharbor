#!/usr/bin/env node
/**
 * 界面候选预览台：把 `design/ui-candidates/` 下的候选页面用静态服务起出来，
 * 维护者在浏览器里逐个点开挑选（`docs/decisions.md` 里记选型结论）。
 *
 * 为什么单独一个脚本：候选页面是纯静态 HTML + 共用 common.css / common.js，
 * 不需要 `pnpm build`、不需要 Tauri、也不需要假数据注入（内容全部写死在页面里）。
 * 它与 `scripts/mock-preview.mjs` 的分工：那个是「真实界面 + 假后端」，用来复核
 * 已实现的界面；这个是「假界面 + 假数据」，用来挑还没实现的方案。
 *
 * 用法：
 *   node scripts/ui-candidates.mjs              # 起 8124，打印挑选页地址
 *   node scripts/ui-candidates.mjs --port 8300
 *
 * 服务根目录是整个仓库：候选页里的 logo（`../../src/assets/logo.png`）与
 * 「当前线上界面」基线（`/dist/mock.html`）都要跨目录取。仅监听 127.0.0.1。
 */
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const indexPath = "/design/ui-candidates/";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8124;

// 挑选页里的基线链接指向 dist/mock.html（由 mock-preview 生成）。dist 会被
// `pnpm build` 清空，所以启动时顺手补一次；补不了只提示，不挡候选页面。
const mockHtml = join(root, "dist", "mock.html");
if (!existsSync(mockHtml) && existsSync(join(root, "dist", "index.html"))) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "mock-preview.mjs"), "--no-serve"], { stdio: "inherit" });
  if (result.status !== 0) {
    console.warn("提示：基线（dist/mock.html）没生成成功，挑选页里的「当前界面」链接会 404；先跑 pnpm build 再来。");
  }
}

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
  let path = decodeURIComponent((req.url || "/").split("?")[0]);
  if (path === "/" || path === "/index.html") {
    res.writeHead(302, { location: indexPath }).end();
    return;
  }
  // 目录地址补上 index.html，否则打印出来的挑选页地址会 404
  if (path.endsWith("/")) path += "index.html";
  const file = join(root, normalize(path));
  if (file !== root && !file.startsWith(root + sep)) {
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
  console.log(`界面候选挑选页：http://127.0.0.1:${port}${indexPath}`);
  console.log(`基线（当前线上界面）：http://127.0.0.1:${port}/dist/mock.html`);
  console.log("（Ctrl-C 停；本机若有 http_proxy，用 curl 检查端口要加 --noproxy '*'）");
});
