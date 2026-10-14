# dsharbor-bridge

DSHarbor 桌面壳的桥接插件：把 DSH Host 进程本次启动的**带 token 登录链接**，
经本机 HTTP 接口交给壳。

- 为什么不能读磁盘：DSH 的 token 由 Host 进程随机生成、只驻内存，官方不接受
  外部指定或持久化 token。插件跑在 Host 进程内，用官方
  `connection.authenticatedUrl()` 现场铸造链接（与 `dsh web` 启动公告同机制）。
- 安全边界：请求必须携带 nonce。nonce 由壳在每次启动 DSH 时随机生成，经环境
  变量 `DSHARBOR_BRIDGE_NONCE` 注入，只驻内存。nonce 缺失时接口回 503。
- token 不落盘：本插件不写任何文件。

## 接口

`GET /dsharbor-bridge/url?nonce=<nonce>`

- `200 {"url": "http://127.0.0.1:<port>/?token=...", "port": <port>, "channel": "bridge"}`
- `403` nonce 不匹配；`503` 未启用/未就绪；`405` 非 GET。

## 安装 / 卸载（官方插件机制）

在目标环境（Windows 或 WSL）执行，profile 名为 `web`：

```sh
npx --yes @deepseek-ai/dsh plugin --profile web add file:<本包 tgz 路径>
npx --yes @deepseek-ai/dsh plugin --profile web remove dsharbor-bridge
```

`dsh plugin add` 会自动把带 `dsh.bundle` 声明的包登记进
`dsh.profile.bundles`；卸载时自动摘除。DSHarbor 壳在这两步之前会自动备份
profile 的 `package.json` 等文件，可一键回滚。

## 测试

```sh
node --test plugins/dsharbor-bridge/test/
```
