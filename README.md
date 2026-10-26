<!-- vibe-coding-declaration:begin -->
> [!IMPORTANT]
> 本仓库由 AI 开发与维护，所有代码变更均由 AI 执行。
<!-- vibe-coding-declaration:end -->

<p align="center">
  <img src="assets/logo.png" width="128" height="128" alt="DSHarbor">
</p>

<h1 align="center">DSHarbor</h1>

<p align="center">
  DSH（DeepSeek Harness）Web 版的轻量桌面壳<br>
  轻量包体 · 关窗即释放界面内存 · 登录链接自动到手
</p>

## 功能一览

| 能力 | 说明 |
|---|---|
| 一键启动 | 四种启动方式：官方 npx / 系统全局命令 / 指定二进制路径 / 自定义命令；可在 Windows 或 WSL 发行版内运行。版本下拉直列 npm 上发布过的所有版本，按 dist-tag 挂徽章（latest / next / beta…），「命令预览」跟着所选版本实时变；选的版本本机没缓存时，主按钮变「安装中…」并多出一行下载提示，日志里的下载进度随下随出，不会让人以为卡住 |
| 运行自动检测 | 启动前探测目标地址：已有 DSH 在跑就直接进入运行态，不被端口冲突卡住；停掉不是本壳启动的 DSH 时会说明原因，而不是悄悄失效 |
| 登录链接自动到手 | 桥接插件（首选）+ 启动日志解析（兜底）；「应用内打开」直接是登录态，不用手拼链接 |
| 三种打开方式 | 应用内打开（壳内 WebView2 窗口）/ 浏览器打开 / 复制登录链接，记住上次选择 |
| 统一日志 | DSH 进程与所有操作的输出在同一个框里，不随切分区清空；产生输出的操作不把界面切走，左栏「日志」上的数字提示攒了几行新输出 |
| 环境与插件 | 多环境管理：**启动 DSH 恒用 `web` 环境**，其余环境作为插件、补丁层、依赖的管理对象。插件逐个总开关（与 DSH 插件列表同一套组合包口径，开/关即把它加回或移出环境的插件列表，重开不用重新下载）、自动查更新、支持单个或全部更新（走官方通道，先自动备份再装、装完回读校验，单个失败不影响其余；**停用的插件同样会查、同样能更新，不会因为被关掉就少了版本号和更新按钮**；更新途中切到别的环境再切回来，进度与每行状态都还在；查过更新后每个环境按钮右上角会挂一枚可更新插件数小圆徽（0 个不显示，更完当场减）；某个环境的依赖锁文件坏了会先自动重修一次再装，不会只丢一句「校验未过」）。插件名带主页时可以点开系统浏览器；在插件行上右键能把这一份装进另一个环境（目标环境已装着同名插件时该行置灰、标出已装版本，不重复装） |
| 界面动效 | 全站动效可在「托盘与网络」里一键关掉（不跟随系统偏好）；操作结果统一在右下角弹提示，几秒自动消失 |
| 轻量模式 | 关闭窗口即释放界面内存（延迟可设，默认立即），DSH 与托盘常驻，托盘一点窗口回来 |
| 配置持久化 | 所有设置改完即存（`%APPDATA%\DSHarbor`）；旧版本存的配置打开时自动升级，不丢设置 |
| 端口覆盖 | 默认跟随 DSH 配置，也可自定义；不改动任何 DSH 文件 |
| TLS 提示 | DSH 开了 TLS 时壳会直接说明「暂不支持加密连接」，而不是误报成端口被占用 |
| 桥接插件管理 | 经官方 `dsh plugin` 通道安装，不碰 DSH 配置；Windows / WSL 两侧一键安装 · 卸载 · 回滚（自动备份 profile，保留最近 5 份） |
| 集成 | 「命令行集成」把 `dsh` 命令写进用户级 PATH（关掉即复原）；「DSH 版本」列出本机装过的每一份 dsh web（npx 缓存 / npm 全局），标出正在用的、装法（版本号安装 / 自动最新）与重复份数，每份都能删，随时可重扫 |

功能计划与进度见[需求单 #1](https://github.com/BoxMiao007/dsharbor/issues/1)。

---

## 快速使用

> 安装包未做代码签名，首次运行 Windows 可能提示 SmartScreen，选「仍要运行」即可。需要 Win10/11（自带 WebView2 运行时）。

1. **安装**：双击 `DSHarbor_*_x64-setup.exe` 按向导完成（静默安装：命令后加 `/S`）。装到当前用户目录，不需要管理员权限。
2. **启动**：打开 DSHarbor → 选启动方式（默认「官方 npx 命令」）→ 点「启动 DSH」。首次用 npx 会自动下载 DSH，稍慢。
3. **省内存**：直接关闭窗口即可——界面内存立刻释放，DSH 继续运行；单击托盘图标随时回来。
4. **卸载**：运行 `uninstall.exe`（程序数据目录 `%APPDATA%\DSHarbor`）。

---

## 开发

### 一次性准备（Windows）

```powershell
# 1) Visual Studio Build Tools：勾选「使用 C++ 的桌面开发」（含 Windows SDK，提供 link.exe）
# 2) Rust：宿主工具链就是 x86_64-pc-windows-msvc，需带 rustfmt / clippy
# 3) Node.js + pnpm
pnpm install                                       # 前端依赖
```

NSIS 不用手装：首次 `tauri build` 会自动下载到 `%LOCALAPPDATA%\tauri\NSIS`（需要能访问 GitHub，墙内先开代理）。

### 跑起来看效果（改界面时默认用这个）

```powershell
pnpm pack:bridge          # 只在第一次或桥接插件源码改过时需要
pnpm exec tauri dev
```

一条命令同时起 Vite（`127.0.0.1:1420`）和真正的 Tauri 窗口：改前端（`src/`）存盘即在窗口里刷新（CSS 走 HMR 不重载），改 Rust（`src-tauri/`、`crates/`）会增量重编并自动重启窗口。它是**真 WebView2 窗口**，所以拖动、缩放、贴靠、托盘、WebView2 渲染差异这些都能直接手动验；普通浏览器里的预览台（`node scripts/mock-preview.mjs`）量尺寸更快，但没有原生窗口行为。

别用 `pnpm exec tauri build` 加装包来验界面：那一轮要几分钟，装完还得先关掉在跑的实例。只有发版、验安装器、验托盘这类「装出来的东西」时才需要。

报 `Port 1420 is already in use` 是上一次的 dev server 没退干净：先 `Stop-Process -Name dsharbor -Force`，再占用 1420 端口的进程一起收掉，然后重开。

### 验证门（提交前必过）

```powershell
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p dsharbor-core
node --test plugins/dsharbor-bridge/test/bridge.test.js
node --test --test-concurrency=2 test/frontend/*.test.mjs
pnpm build
pnpm pack:bridge
```

`pnpm build` 会清空 `dist` 但不会生成桥接插件包；缺了 `src-tauri/resources/*.tgz` 时 clippy 与打包会报 `glob pattern resources/*.tgz path not found`，所以打安装包前先跑 `pnpm pack:bridge`。

`node --test test/frontend/*.test.mjs` 用 `puppeteer-core` 驱动本机 Edge 在假数据预览台上跑，量的是「用量尺寸 / 可见性 / 动画」这类浏览器里才说得清的接缝；缺 puppeteer-core 或 Edge 时整组 skip（不是静默通过）。路径可用 `DSHARBOR_PUPPETEER` / `DSHARBOR_BROWSER` 覆盖。**记得带 `--test-concurrency=2`**：默认全并行会同时起十几套 Edge + 预览台抢 CPU，动效时序断言会成片假失败（应已淡出实测 opacity=1、期望 162px 实测 165.5px 这类），低并发才稳。

`pnpm exec tauri build` 只在发版、验安装包、验托盘这类「装出来的东西」时才跑，日常改界面不必等它。

### 一条命令出 Windows 安装包

```powershell
pnpm exec tauri build
# 产物：target/release/bundle/nsis/DSHarbor_<版本>_x64-setup.exe
```

别把 `cargo build --release` 单独编出来的 `target/release/dsharbor.exe` 直接拷去运行或替换安装目录：那是不带 tauri `custom-protocol` 的**开发版**，它按 `devUrl` 去连 `http://127.0.0.1:1420` 的 Vite dev server，脱离 dev server 只会看到「127.0.0.1 拒绝连接」的错误页。能独立运行的产物只有上面这条命令出的安装包（或它装出来的安装目录里的 exe）。

### 仓库结构

| 目录 | 内容 |
|---|---|
| `crates/dsharbor-core/` | 纯逻辑核心库（启动命令构造、token 解析、端口覆盖层、轻量模式状态机）——开发机可全自动测试 |
| `plugins/dsharbor-bridge/` | DSH 桥接插件（随安装包以 tgz 分发） |
| `src-tauri/` | Tauri 2 外壳（启动器、登录链接、轻量模式、托盘、桥接插件管理） |
| `src/` | 前端界面（Vite 8 + TypeScript 7，无 UI 框架）：`main.ts` 是入口与全部交互逻辑，`ui/` 放类型、常量、配置项、图标与 HTML 骨架，`styles/` 放样式 |
| `src/styles/` | 按功能分区的 CSS（`00-tokens` 令牌与变量 → `99-hidden` 工具类）；入口 `src/style.css` 只是一串**有顺序的** `@import`，层叠依赖声明顺序，新增样式按区插进对应文件，不要换顺序 |
| `test/frontend/` | 前端界面接缝测试（`puppeteer-core` + 本机 Edge，在假数据预览台上跑） |
| `scripts/` | 开发脚本：`mock-preview.mjs`（假数据预览台）、`ui-candidates.mjs`（界面候选稿预览台，读下面那行本地草稿目录） |
| `assets/` | 图标源：`icon-source.png`（主用）、`icon-source.svg`（备用）、`logo.png` |
| `design/ui-candidates/` | 界面候选静态稿（`node scripts/ui-candidates.mjs` 起预览台逐个点开挑选）。**只在本机当草稿用、不入库**：`.gitignore` 里有 `/design/`，新克隆下来没有这个目录，脚本会提示缺页面 |
| `docs/decisions.md` | 重大技术决策记录（每条含决策、原因、放弃了什么） |
| `docs/manual-acceptance.md` | 发布前 Windows 手动验收手册 |
| `GLOSSARY.md` | 项目与 DSH 生态术语表 |

### 技术栈

Tauri 2（Rust + 系统 WebView2）和 Vite 8 / TypeScript 7；在 Windows 本机用 MSVC 工具链编译、NSIS 打安装包。为什么这么选、放弃了什么，都记在 `docs/decisions.md`。

## 给 AI agent 的约定

本仓库由 AI 开发与维护：维护者只提需求与验收，实现、验证、文档、提交由 AI 完成。协作规则见 [AGENTS.md](AGENTS.md)。
