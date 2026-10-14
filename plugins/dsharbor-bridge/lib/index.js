/**
 * DSHarbor 桥接插件：运行在 DSH Host 进程内部的 Cordis 插件。
 *
 * 为什么需要它（设计依据见任务书「关于 Token 的硬性事实」）：
 * - DSH 官方不允许通过命令行参数或环境变量指定固定 token；token 由 Host
 *   进程内部随机生成、只驻内存。壳无法从磁盘读到它。
 * - 本插件跑在 Host 进程内，可以调用官方 connection 服务（@deepseek-ai/
 *   dsh-client-connection）的 `authenticatedUrl()` 现场铸造带 token 的登录
 *   链接 —— 与 `dsh web` 启动时打印的是同一个机制，官方兼容。
 * - 链接只经本机 HTTP 接口交给壳：请求必须携带 nonce。nonce 由壳在每次
 *   启动 DSH 时随机生成，经环境变量 DSHARBOR_BRIDGE_NONCE 注入（见
 *   dsh.bundle.patch.yml），只驻内存、不落盘。这很重要：用户配置里
 *   webserver 可以 bind 0.0.0.0（官方 remote-web-ui 就是这么配的），
 *   本接口因而可能从局域网可达，必须防止他人直接拿走登录链接。
 * - nonce 缺失时（例如用户自己直接跑 `dsh web`）接口只回 503「未启用」，
 *   不提供任何数据，也不影响 DSH 本身。
 * - token 永不写入磁盘：本插件只读 config.nonce 和运行中的内存服务。
 */
import { timingSafeEqual } from 'node:crypto';

export const name = 'dsharbor-bridge';

/**
 * 只依赖 webServer：连接服务（connection）可能晚于路由注册就绪，
 * 因此像官方 web-app 一样在 apply 里延迟注入，处理请求时再检查。
 */
export const inject = ['webServer'];

export const ROUTE_PATH = '/dsharbor-bridge/url';

/** 恒定时间比较，避免通过响应时间侧信道猜测 nonce。 */
export function nonceMatches(expected, provided) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function respond(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** 供测试直接调用的处理函数；生产路径由 apply 注册到 webServer。 */
export function createHandler(getWebServer, getConnection, nonce) {
  return (req, res) => {
    try {
      if (req.method !== 'GET') {
        respond(res, 405, { error: 'method not allowed' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const provided = url.searchParams.get('nonce');
      if (typeof nonce !== 'string' || nonce === '') {
        respond(res, 503, { error: 'bridge disabled: DSHARBOR_BRIDGE_NONCE is not set for this DSH process' });
        return;
      }
      if (!nonceMatches(nonce, provided)) {
        respond(res, 403, { error: 'forbidden' });
        return;
      }
      const webServer = getWebServer();
      const connection = getConnection();
      if (webServer === undefined || typeof webServer.port !== 'number' || connection === undefined) {
        respond(res, 503, { error: 'bridge not ready: web server or connection service unavailable' });
        return;
      }
      // 与 `dsh web` 启动公告同一机制：authenticatedUrl 把 launchToken 作为
      // ?token= 拼到本机 URL 上；token 每次启动都不同。
      const base = `http://127.0.0.1:${String(webServer.port)}/`;
      const loginUrl = connection.authenticatedUrl(base);
      respond(res, 200, { url: loginUrl, port: webServer.port, channel: 'bridge' });
    } catch (error) {
      respond(res, 500, { error: `bridge failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
}

export function apply(ctx, config) {
  // nonce 有两个来源，任一可用即可：
  // 1) patch 注入的 config.nonce（dsh.bundle.patch.yml 里用 !!js 读环境变量）；
  // 2) 直接读进程环境变量 DSHARBOR_BRIDGE_NONCE。
  // 为什么要双保险：`!!js` 表达式由 loader 求值，历史上有过在部分环境里
  // 拿到空值的情况；插件代码直接读 process.env 则不受求值链路影响。
  const configNonce = typeof config?.nonce === 'string' ? config.nonce : '';
  const envNonce = typeof process.env.DSHARBOR_BRIDGE_NONCE === 'string' ? process.env.DSHARBOR_BRIDGE_NONCE : '';
  const nonce = configNonce || envNonce;
  let webServer;
  let connection;

  ctx.inject(['webServer'], (webCtx) => {
    webServer = webCtx.webServer;
    const route = {
      kind: 'exact',
      path: ROUTE_PATH,
      handler: createHandler(() => webServer, () => connection, nonce),
    };
    if (typeof webCtx.effect === 'function') {
      webCtx.effect(() => webServer.register(route), 'dsharbor-bridge: login url route');
    } else {
      webServer.register(route);
    }
    // 只报「是否配置 / 来源」，不打印 nonce 值。
    const state = nonce === ''
      ? `absent (config:${configNonce ? 'yes' : 'no'} env:${envNonce ? 'yes' : 'no'}) - requests will get 503`
      : `configured via ${configNonce ? 'config' : 'env'}`;
    ctx.logger?.info?.(`dsharbor-bridge: ${ROUTE_PATH} ready (nonce ${state})`);
  });

  ctx.inject(['connection'], (connectionCtx) => {
    connection = connectionCtx.connection;
  });
}
