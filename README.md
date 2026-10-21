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
| 一键启动 | 四种启动方式：官方 npx / 系统全局命令 / 指定二进制路径 / 自定义命令；「官方 npx」的**版本**下拉首项固定是「自动最新版本」（不带版本号，跟 npm 的 `latest` 标签走，右侧徽章显示它当前指向的版本，壳会自动检测官方最新版），下面按新到旧直列 npm 上发布过的所有版本（「更多…」每次再放 10 个），本机 npx 缓存里已有的版本挂「已缓存」标记；下拉右边一颗方钮手动重新获取版本列表；这一项底部的「命令预览」那行 `npx --yes …` 跟着所选版本实时变，版本列表从 npm 现查（读不到时提示出来，照常能启动）；「官方 npx」与「自定义命令」都有**运行环境**下拉，可直接选 `WSL - <发行版>` 在发行版内拉起（没装 Node.js 的发行版会在选项里标出来）；「指定程序路径」可点右边的文件夹方钮挑文件，选完立刻提示路径是否可用；「自定义命令」可以自己写整条启动命令（如 `npx @deepseek-ai/dsh@next web`），壳只在末尾补上 `--no-open` 与附加参数；启动前只有一个「启动 DSH」，起来之后同一个按钮变成圆形红底的「停止」，并多出一颗圆形黄底的「重启 DSH」（点击后图标持续转动） |
| 运行自动检测 | 启动前自动探测目标地址（跟随 DSH 配置的绑定地址，回环或网卡 IP 都行）：已有 DSH Web 在跑（上次壳异常退出残留等）就不再重复拉起、直接进运行态（主按钮变「停止」并多出「重启 DSH」，PID 显示 `—`），不会被端口冲突报错卡住；检测到的不是本壳启动的 DSH 时，「停止 / 重启」会说明原因而不是悄悄失效 |
| 登录链接自动到手 | 桥接插件（首选，现场铸造）+ 启动日志解析（兜底）；「应用内打开」弹出的窗口直接是登录态，不用手拼链接 |
| 三种打开方式 | 工具条右侧是「应用内打开」主按钮 + 小三角分体按钮：应用内打开（壳内 WebView2 窗口）/ 浏览器打开（系统默认浏览器）/ 复制登录链接（带 token 的完整链接写进剪贴板）；默认「应用内打开」并记住上次选择（选完方式文字与图标回填到主按钮，再点主按钮才执行）；DSH 窗口与主窗口相互独立 |
| 统一日志 | 左栏有一项「日志」，点开右侧就是一整屏日志：DSH 进程输出与桥接 / 环境 / 缓存等操作输出都在同一个框里，不同批次间插 `--- 时间 ---`；右上角「清空日志」「复制日志」，不随切分区清空，只有清空或退出程序才清；滚到底自动追新、往上翻不抢滚动；**产生命令输出的操作（启动 / 停止 / 重启、桥接安装卸载、重装依赖、备份还原补丁层）不再把界面切走**，左栏「日志」上会挂一枚蓝色数字，告诉你攒了几行新输出，点进「日志」就自动归零 |
| 环境与插件 | 「环境/插件」分区顶部是一排环境大按钮（`web` / `desktop` / `headless` / 自己建的都列出来），点一下即选中——选中的这个只是**插件、补丁层、依赖**的管理对象；**启动 DSH 恒用 `web` 环境**。每个按钮右上角的三点菜单里是重命名 / 复制 / 删除 / 安装依赖 / 补丁层 / 打开目录（补丁层入口在这里，点了会先切到该环境再开浮窗），右侧一列两颗按钮是「新建空白环境」与「桥接插件」两个浮窗（桥接浮窗里安装、卸载、回滚备份；补丁层浮窗里备份、还原补丁层），再往下一张卡是逐插件的**总开关**（一行一个插件，只列壳管得了的插件，官方内置骨架包与桥接插件不在这里出现；开关状态变化时列表不跳动） |
| 顶部状态栏 | 一条通栏的透明顶栏：左端加粗 `DSHarbor` + 小字「DSH Web 的桌面壳」，右端三颗窗口按钮，按住顶栏任意位置都能拖窗口；下面工具条左边是四样读数（桥接插件是否装好的徽章「桥接就绪」/「桥接未安装」、DSH 版本、PID、监听端口；窗口拉窄时先收 PID / 监听、再收版本，始终一排），右边是主操作按钮——运行状态只看主按钮：蓝色「启动 DSH」与红色「停止」。运行起来后「停止」和「重启 DSH」都是圆形背景图标钮（34×34，鼠标悬停时「停止」图标在实心/空心间闪一下、「重启 DSH」图标转一圈） |
| 轻量模式 | 关闭窗口释放界面内存（延迟时长可在界面设置，默认立即），DSH 与托盘常驻，托盘一点窗口回来 |
| 配置持久化 | 启动方式、版本、运行环境（Windows / WSL 发行版）、附加参数、端口改完即存（`%APPDATA%\DSHarbor`）；旧版本存的配置（含已下线的「通过 WSL 启动」与按渠道存的 npx 版本）打开时自动升级，不丢设置 |
| 端口覆盖 | 默认跟随 DSH 配置（界面显示当前生效值），也可自定义；端口框只在鼠标悬停时显出上下步进箭头，框旁的「还原」方钮一键恢复默认（清空 = 继续跟随 DSH 配置）；不改动任何 DSH 文件。附加参数里写了 `--port` / `--host` 时，端口提示会说明「以它为准」 |
| TLS 提示 | DSH 开了 `--tls-cert` / `--tls-key` 时壳的探测走明文 HTTP、读不出对方身份；这种情况会直接说明「壳暂不支持加密连接」，而不是误报成端口被占用 |
| 桥接插件管理 | 经官方 `dsh plugin` 通道安装，不碰 DSH 配置；Windows / WSL 两侧一键安装 · 卸载 · 回滚（自动备份 profile 文件并附哈希清单，只保留最近 5 份，超出删最旧的）；面板内可一键打开备份目录 |

功能计划与进度见[需求单 #1](https://github.com/BoxMiao007/dsharbor/issues/1)。

---

## 快速使用

> 安装包未做代码签名，首次运行 Windows 可能提示 SmartScreen，选「仍要运行」即可。需要 Win10/11（自带 WebView2 运行时）。

1. **安装**：双击 `DSHarbor_*_x64-setup.exe` 按向导完成（静默安装：命令后加 `/S`）。装到当前用户目录，不需要管理员权限。
2. **启动**：打开 DSHarbor → 选启动方式（默认「官方 npx 命令」）→ 点「启动 DSH」。首次用 npx 会自动下载 DSH，稍慢。
3. **省内存**：直接关闭窗口即可——界面内存立刻释放，DSH 继续运行；单击托盘图标随时回来（打开哪个窗口可在界面里配置）。关闭后多久进入轻量模式可在界面里设置（默认立即）。
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
node --test test/frontend/*.test.mjs
pnpm build
pnpm pack:bridge
```

`pnpm build` 会清空 `dist` 但不会生成桥接插件包；缺了 `src-tauri/resources/*.tgz` 时 clippy 与打包会报 `glob pattern resources/*.tgz path not found`，所以打安装包前先跑 `pnpm pack:bridge`。

`node --test test/frontend/*.test.mjs` 用 `puppeteer-core` 驱动本机 Edge 在假数据预览台上跑，量的是「用量尺寸 / 可见性 / 动画」这类浏览器里才说得清的接缝；缺 puppeteer-core 或 Edge 时整组 skip（不是静默通过）。路径可用 `DSHARBOR_PUPPETEER` / `DSHARBOR_BROWSER` 覆盖。

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
| `src/ui/` | 九个前端模块：`build-html.ts`（整页 HTML 骨架）、`types.ts`、`picker.ts`、`config.ts`、`spin.ts`、`icons.ts`、`markup.ts`、`theme.ts`、`prefs.ts` |
| `src/styles/` | 12 个按功能分区的 CSS（`00-tokens` 令牌与变量 → `99-hidden` 工具类）；入口 `src/style.css` 只是一串**有顺序的** `@import`，层叠依赖声明顺序，新增样式按区插进对应文件，不要换顺序 |
| `test/frontend/` | 前端界面接缝测试（`puppeteer-core` + 本机 Edge，在假数据预览台上跑） |
| `scripts/` | 开发脚本：`mock-preview.mjs`（假数据预览台）、`ui-candidates.mjs`（界面候选稿预览台） |
| `assets/` | 图标源：`icon-source.png`（主用）、`icon-source.svg`（备用）、`logo.png` |
| `design/ui-candidates/` | 界面候选静态稿（`node scripts/ui-candidates.mjs` 起预览台逐个点开挑选） |
| `docs/decisions.md` | 重大技术决策记录（每条含决策、原因、放弃了什么） |
| `docs/manual-acceptance.md` | 发布前 Windows 手动验收手册 |
| `docs/ui-review-2026-10-21.md` | 界面评审报告（Web Interface Guidelines 合规 + 视觉设计，含实测对比度与优先级） |
| `GLOSSARY.md` | 项目与 DSH 生态术语表 |

### 技术栈

Tauri 2（Rust + 系统 WebView2）和 Vite 8 / TypeScript 7；在 Windows 本机用 MSVC 工具链编译、NSIS 打安装包。为什么这么选、放弃了什么，都记在 `docs/decisions.md`。

## 给 AI agent 的约定

本仓库由 AI 开发与维护：维护者只提需求与验收，实现、验证、文档、提交由 AI 完成。协作规则见 [AGENTS.md](AGENTS.md)。
