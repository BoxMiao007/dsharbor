/**
 * 桥接插件的本地 stub 测试（不依赖真实 DSH）。
 *
 * 覆盖验收条款「取回 / 超时 / 重试 / 降级分支有自动化测试（本地 stub）」中
 * 插件侧的分支：成功取回、nonce 缺失（降级信号 503）、nonce 错误、方法限制、
 * 连接服务未就绪。超时与重试策略在壳侧（Rust core）测试。
 *
 * 运行：node --test plugins/dsharbor-bridge/test/
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { apply, createHandler, formatHost, nonceMatches, ROUTE_PATH } from '../lib/index.js';

const NONCE = 'a'.repeat(32);

function fakeRes() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
    get json() {
      return JSON.parse(this.body);
    },
  };
}

function fakeReq(method, url) {
  return { method, url };
}

function stubWebServer(port = 3080) {
  const routes = [];
  return {
    port,
    routes,
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
}

test('apply 注册精确路由并接受注入的 nonce', () => {
  const webServer = stubWebServer();
  const connection = { authenticatedUrl: (base) => `${base}?token=TESTTOKEN` };
  const ctx = {
    logger: { info: () => {} },
    inject(names, cb) {
      if (names.includes('webServer')) cb({ webServer, effect: (fn) => fn() });
      if (names.includes('connection')) cb({ connection });
    },
  };
  apply(ctx, { nonce: NONCE });
  assert.equal(webServer.routes.length, 1);
  const route = webServer.routes[0];
  assert.equal(route.kind, 'exact');
  assert.equal(route.path, ROUTE_PATH);
});

test('带正确 nonce 时取回带 token 的登录链接', () => {
  const webServer = stubWebServer(3100);
  const connection = { authenticatedUrl: (base) => `${base}?token=TOKEN-A` };
  const handler = createHandler(() => webServer, () => connection, NONCE);
  const res = fakeRes();
  handler(fakeReq('GET', `${ROUTE_PATH}?nonce=${NONCE}`), res);
  assert.equal(res.status, 200);
  assert.equal(res.json.url, 'http://127.0.0.1:3100/?token=TOKEN-A');
  assert.equal(res.json.port, 3100);
  assert.equal(res.json.channel, 'bridge');
  assert.match(res.headers['cache-control'], /no-store/);
});

test('链接基地址跟随 webserver 绑定的 host（LAN 绑定不回环）', () => {
  const webServer = { ...stubWebServer(3080), host: '192.168.1.7' };
  const connection = { authenticatedUrl: (base) => `${base}?token=LAN` };
  const handler = createHandler(() => webServer, () => connection, NONCE);
  const res = fakeRes();
  handler(fakeReq('GET', `${ROUTE_PATH}?nonce=${NONCE}`), res);
  assert.equal(res.status, 200);
  assert.equal(res.json.url, 'http://192.168.1.7:3080/?token=LAN');
});

test('DSH 提供 getOrigin() 时优先采用它', () => {
  const webServer = {
    ...stubWebServer(3080),
    host: '192.168.1.7',
    getOrigin: () => 'http://192.168.1.7:3080',
  };
  const connection = { authenticatedUrl: (base) => `${base}?token=ORIGIN` };
  const handler = createHandler(() => webServer, () => connection, NONCE);
  const res = fakeRes();
  handler(fakeReq('GET', `${ROUTE_PATH}?nonce=${NONCE}`), res);
  assert.equal(res.json.url, 'http://192.168.1.7:3080/?token=ORIGIN');
});

test('IPv6 绑定时给 URL 里的主机加方括号', () => {
  assert.equal(formatHost('::1'), '[::1]');
  assert.equal(formatHost('[::1]'), '[::1]');
  assert.equal(formatHost('127.0.0.1'), '127.0.0.1');
  assert.equal(formatHost(undefined), '127.0.0.1');
});

test('nonce 缺失（壳没注入环境变量）时回 503，作为降级信号', () => {
  const handler = createHandler(() => stubWebServer(), () => undefined, '');
  const res = fakeRes();
  handler(fakeReq('GET', `${ROUTE_PATH}?nonce=x`), res);
  assert.equal(res.status, 503);
  assert.match(res.json.error, /disabled/);
});

test('nonce 不匹配时回 403，且不泄露链接', () => {
  const connection = { authenticatedUrl: () => 'http://127.0.0.1:3080/?token=LEAK' };
  const handler = createHandler(() => stubWebServer(), () => connection, NONCE);
  const wrong = fakeRes();
  handler(fakeReq('GET', `${ROUTE_PATH}?nonce=${'b'.repeat(32)}`), wrong);
  assert.equal(wrong.status, 403);
  assert.ok(!wrong.body.includes('LEAK'));

  const missing = fakeRes();
  handler(fakeReq('GET', ROUTE_PATH), missing);
  assert.equal(missing.status, 403);
});

test('非 GET 方法回 405', () => {
  const handler = createHandler(() => stubWebServer(), () => undefined, NONCE);
  const res = fakeRes();
  handler(fakeReq('POST', `${ROUTE_PATH}?nonce=${NONCE}`), res);
  assert.equal(res.status, 405);
});

test('connection 未就绪时回 503 而不是崩溃', () => {
  const handler = createHandler(() => stubWebServer(), () => undefined, NONCE);
  const res = fakeRes();
  handler(fakeReq('GET', `${ROUTE_PATH}?nonce=${NONCE}`), res);
  assert.equal(res.status, 503);
  assert.match(res.json.error, /not ready/);
});

test('nonceMatches 恒定时间比较的边界', () => {
  assert.equal(nonceMatches('abcd', 'abcd'), true);
  assert.equal(nonceMatches('abcd', 'abce'), false);
  assert.equal(nonceMatches('abcd', 'abc'), false);
  assert.equal(nonceMatches('', ''), false);
  assert.equal(nonceMatches('abcd', undefined), false);
  assert.equal(nonceMatches(undefined, 'abcd'), false);
});
