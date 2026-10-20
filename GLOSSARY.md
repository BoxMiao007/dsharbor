# 术语表（GLOSSARY）

本项目（DSHarbor）与 DSH 生态的核心术语。写用户文案、Issue、代码注释时优先使用这里的称呼；英文/标识保留原文。

| 术语 | 英文 / 标识 | 含义 |
|---|---|---|
| DSH | DeepSeek Harness | 宿主程序：基于 Cordis「万物皆插件」框架的 AI 工具；Web 版由 `dsh web` 在本地起 HTTP 服务并随机生成一次性 token。 |
| 壳 / 外壳 | shell | 本项目交付的 Windows 桌面应用（Tauri 2 + Rust 系统 WebView2），负责拉起 DSH、取登录链接、托盘与轻量模式。 |
| 核心库 | `dsharbor-core` | 与界面、系统 API 无关的纯逻辑 crate（启动命令构造、输入校验、链接解析、覆盖层文本处理、轻量模式状态机等）；开发机可全自动 `cargo test`。 |
| 启动器 | launcher | 壳里按「启动方式」拉起 DSH 进程、维护状态与停止的部分（含取链接线程）。 |
| 启动方式 | `LaunchMode` | 四种之一：官方 npx 命令 / 系统全局命令（`dsh web`）/ 指定二进制路径 / 自定义命令；配置界面可选。 |
| 运行环境 | `Runtime` | 启动方式在哪儿执行：`默认`（Windows 宿主）或某个 WSL 发行版（`wsl:<发行版>`）；只对官方 npx 与自定义命令生效，跨启动方式共用一份选择。 |
| 渠道 | `Channel` | DSH 的发版通道，官方 npx 命令可选：稳定版（`latest`）/ 最新尝鲜版（`next`）/ 尝鲜版历史版本（`rc`）/ 内测版（`alpha`）。前两者跟 npm dist-tag，后两者要选具体版本号。 |
| 版本清单 | `RegistryInfo` | 从 `npm view @deepseek-ai/dsh dist-tags versions --json` 现查并缓存的版本数据（外壳侧 10 分钟）；读不到时界面退回空列表提示，不阻塞启动。 |
| DSH 会话 | DSH session | 壳拉起的这一次 DSH 进程树（cmd/npx/node 等）。 |
| 登录链接 / 认证链接 | authenticated URL | `http://<host>:<端口>/?token=<一次性 token>`，`<host>` 跟随 webserver 的绑定地址（回环或具体网卡 IP）；DSH 每次启动随机生成、进程内存驻留，浏览器凭它换持久 Cookie。 |
| 访问端点 | endpoint | 壳用来探活、连桥接的 `host:port`，由 `profile` 的 webserver 块 + 端口优先级算出（`dsharbor_core::endpoint`）。 |
| 桥接插件 | `dsharbor-bridge` | 随壳分发的 DSH 插件（tgz）；装进 DSH 后，壳经它现场铸造登录链接。 |
| 桥接通道 | bridge channel | 经桥接插件接口（`GET /dsharbor-bridge/url?nonce=…`）取登录链接的首选通道。 |
| 日志兜底 | log fallback | 从 DSH 启动日志解析 `dsh web: <url> (LAN: <url>)` 的降级通道；日志格式属实现细节、无稳定性承诺。 |
| nonce | 一次性随机数 | 壳每次启动生成的 128-bit hex，经环境变量 `DSHARBOR_BRIDGE_NONCE` 注入 DSH 供桥接接口校验；不落盘，缺失时接口回 503。 |
| profile | DSH profile | DSH 的环境目录 `~/.dsh/profiles/<名字>`；由 package.json 声明 bundles、cordis.patch.yml 覆写配置；壳默认操作 `web`。 |
| 桥接安装 | `dsh plugin add/remove file:<tgz>` | 官方插件安装/卸载入口；安装后 plugin-manager 自动把包登记进 `dsh.profile.bundles`，移除自动摘除。 |
| 托管块 | managed block | 用户 cordis.patch.yml 里由插件生成、标注「托管，勿改」的配置段（如 webserver 的 host/port）。壳只读，从不写。 |
| 端口覆盖 | port overlay | 壳生成的 launcher 层 patch 文件（以 `--patch` 附加启动命令），把 webserver 端口改为用户自定义值；不改动 DSH 任何配置文件，host 等其余键保留。 |
| 托管值 | managed value | 端口字段留空（「跟随 DSH 配置」）时的当前生效值；界面显示其来源（读取 profile 的 webserver 块）。 |
| 轻量模式 | light mode | 关闭主窗口后按设置延迟（默认立即）销毁它的 WebView 释放界面内存：延迟期内窗口先隐藏、倒计时到点才真正销毁，期间从托盘点回来仍显示原窗口；DSH 与托盘常驻。DSH 界面窗口与主窗口相互独立——关一个不连带关另一个。 |
| 状态机 | `ShellMachine` | 轻量模式状态/事件模型：`Normal/PendingLight/Light/Exiting` × 窗口开/关 → 副作用清单；`PendingLight` 表示主窗口已隐藏、倒计时未到（`LightTimeout` 事件到点才真正销毁）；核心库实现，可全自动测试。 |
| 托盘菜单 | tray menu | 右键菜单六档：「浏览器打开 / 应用内打开 / 打开启动界面 / 重启 DSH / 停止 DSH / 完全退出」；「停止 DSH」只停后端（壳与窗口保留）。 |
| 启动界面 | launcher window | 壳的主窗口（`main`）：启动/停止 DSH、改配置、看状态与日志；轻量模式下被销毁、可随时重建。 |
| 应用内打开 | open in app | 在壳自己的 WebView2 窗口（`dsh-view`）里打开已登录的 DSH 界面；窗口与启动界面相互独立。 |
| 浏览器打开 | open in browser | 显式把登录链接交给系统默认浏览器（手动动作；壳的启动流程自动弹出始终禁止）。 |
| 托盘单击目标 | tray click target | 单击托盘图标默认打开的窗口：启动界面（默认）或应用内窗口；随配置存在 `config.json` 的 `trayClick`。 |
| 版本徽章 | version badge | 「DSH 会话」状态行里显示**当前运行的 DSH 版本**的徽章（两个四角星 + `DSH v…`，外观同「已停止」）；版本由壳在每次成功启动后用 `--version` 查询，查到就记进 `%APPDATA%\DSHarbor\dsh-version.txt`，所以壳重开后直接沿用上次的值（不再显示「DSH 版本未知」）。 |
| 登录徽章 | login badge | 「DSH 会话」状态行**第一个**徽章，显示登录链接的通路与状态：登录等待中 / 桥接就绪（走桥接插件）/ 日志兜底就绪（日志解析）/ 登录获取失败；细节说明在徽章内感叹号图标的悬停气泡，获取失败时登录行显示原因原文。 |
| 启动中 | starting | 「DSH 会话」状态徽章的一种：DSH 进程已拉起、登录链接尚未就绪（`running` 且未就绪、未报错），带转圈动画；就绪后自动变「运行中」。 |
| 小卡徽章 | cell badge | 小卡头部右侧的小徽章，显示**真实摘要**：「启动方式」小卡显示当前方式名、「当前环境」小卡显示当前环境名 + 插件数 + 桥接状态（如 `web · 3 个插件 · 桥接已装`）、「命令行集成」小卡显示命令行接入状态与缓存占用 / 可回收量、「网络与代理」小卡显示「下载源 · 代理模式」；「桥接插件」小卡另有自己的已安装 / 未安装徽章。 |
| 左栏 | sidebar | 通高的一张悬浮卡片（约 236px 宽）：顶部是应用图标 + `DSHarbor` + 小字「DSH Web 的桌面壳」与一条细线，中部是五项导航（启动方式 / 环境 / 集成 / 托盘与网络 / 关于），底部是 DSH 官网 / GitHub / 浅暗切换三颗圆形图标按钮。 |
| 分区导航 | rail | 左栏中部竖排的五枚胶囊按钮（启动方式 / 环境 / 集成 / 托盘与网络 / 关于），点一项换右侧内容；当前分区记在界面本地存储（`localStorage` 键 `dsharbor.ui.panel`），壳重开后沿用。 |
| 环境分区 | profiles panel | 「环境」分区（当前环境小卡 + 桥接插件小卡）：对应 DSH 的 profile（一份独立的 `profiles/<名字>` 目录），当前环境名记在配置字段 `profile`（默认 `web`）。里面列出能起网页界面的环境并切换，「管理环境」里还能新建 / 复制 / 重命名 / 删除 / 重装依赖；另有补丁层备份与还原、逐插件启用停用（开关作用在补丁层的禁用表达上，重开不用重新下载）；**桥接插件小节也在这里**（安装 / 卸载 / 恢复备份 / 打开备份目录）。 |
| 托盘与网络分区 | tray & network panel | 「托盘与网络」分区（「托盘设置 │ 网络与代理」两张并排小卡 + 网络自检小卡）：下载源（`downloadSource`：沿用 npm 全局配置 / 镜像源 / 官方源）与代理（`proxyMode`：跟随系统 / 手动填写 / 不走代理；`proxyAddress`：代理地址）三项配置真实生效，并统一经 `net::plan_env` 注入到三条路径——版本查询、插件安装卸载、拉起的 DSH 进程；里面「测试连接」用当前设置跑一次真实请求做自检。「托盘设置」小卡里是托盘单击目标与关闭窗口后进入轻量模式的延迟。 |
| 集成分区 | integrations panel | 「集成」分区（命令行集成小卡 + npx 缓存小卡）：命令行集成开关（`cliIntegration`）打开后真实改写**用户级 PATH** 并写入 `dsh` 垫片（Windows 上写注册表 `HKCU\Environment` 的 `Path`，类型 `REG_EXPAND_SZ`），关掉复原；缓存清理开关（`cacheCleanup`）控制「每次真的拉起一个 DSH 进程后自动清理一次」。两者默认关闭。缓存区真实扫描 npx 缓存目录、显示占用与可回收量，支持「立即清理」。 |
| 关于分区 | about panel | 「关于」分区：只有一张「版本与目录」小卡——壳与核心库版本、DSH 版本、开源许可证、配置目录 / 日志目录（两个目录条目右侧各有「打开」）。仓库与官网入口在左栏底部，不在这里重复。 |
| 外观模式 | ui theme | 界面只有浅色 / 深色两套（`localStorage` 键 `dsharbor.ui.theme`，取值 `light` / `dark`；旧值 `classic` 读作浅色、`nativeDark` / `native` 读作深色），差别全在 `src/style.css` 的 CSS 变量上；入口是左栏底部那颗太阳 / 月亮图标，点它只改 `<html data-mode>`，不重建界面。同一份取值镜像进 `config.json` 的 `uiTheme`，Rust 开窗时据此定 WebView 底色。 |
| 主卡 | main card | 右侧内容区里那张大卡片：吃掉工具条以下的全部高度，自己内部整体滚（32px 内边距）。一个分区只有一张主卡，里面按条目装若干张小卡。 |
| 小卡 | cell | 主卡里的一个条目。靠明度与主卡拉开一档（深色比主卡亮、浅色比主卡沉）、圆角比主卡收窄，卡与卡之间是 20px 露缝而不是分隔线；需要并排时两小卡之间留 28px 缝（第 1、4 个分区各有一组并排）。 |
| 日志浮层 | log overlay | 工具条下方那条窄条（中间一颗小箭头）点开的浮层，盖在内容区上方约 60% 高度，点外面或 Esc 收起。**界面只有这一个日志**：DSH 进程输出 + 桥接 / 环境 / npx 缓存等操作输出都写进它，不同批次插 `--- 时间 ---` 分段线；不随切分区清空，只有「清空日志」或完全退出才清空；滚到底自动追新、往上翻不抢滚动；展开状态记 `localStorage` 键 `dsharbor.ui.logOpen`，主动操作（启动 / 重启 / 桥接安装等）会自动展开，用户手动收起后本次会话不再自动弹开。后端环形缓冲 1200 行（`LOG_CAPACITY`），界面每次取最后 300 行（`LOG_TAIL_LINES`）。 |
| 打开方式 | open mode | 工具条右侧的分体按钮：主按钮执行当前方式，右侧小三角展开三项——应用内打开（`open_dsh_window`）/ 浏览器打开（`open_dsh_in_browser`）/ 复制登录链接（`dsh_login_url` + 前端剪贴板）。默认「应用内打开」，选择记在 `localStorage` 键 `dsharbor.ui.openMode`。 |
| 回滚备份 | bridge backup | 安装/卸载桥接插件前，壳把 profile 中会被 pnpm 改写的文件（package.json、pnpm-workspace.yaml、pnpm-lock.yaml、cordis.patch.yml）备份到 `%APPDATA%\DSHarbor\backups`（含内容哈希清单）；只保留最近 5 份，超出删最旧的。 |
| 窗口按钮 | window controls | 主窗口右上角那三颗自己画的最小化 / 最大化 / 关闭（窗口用 `decorations: false`，没有系统标题栏）：它们**不占一条顶栏**，浮在所有卡片之上的窗口右上角空白里，关闭 = 轻量模式（悬停提示写明）。拖动窗口与双击最大化 / 还原落在左栏与工具条的空白处。已知取舍：Windows 11 贴靠布局与 `Alt+Space` 系统菜单不可用。 |
| 滚动指示条 | scroll indicator | 内容区右缘那条 5px 淡蓝细胶囊：滚动时或指针移到那条带上才出现，可按住上下拖；它替代了占宽度的视口滚动条（后者已隐藏）。主卡本身是唯一的滚动容器，日志浮层的正文框内部另用极淡细条。 |
| 预览台 | mock preview（`scripts/mock-preview.mjs`） | 界面改动的第一道证据：`pnpm build` 后把 `dist/index.html` 拷成 `mock.html` 并注入假的 `__TAURI_INTERNALS__`（假 DSH 状态、假桥接、假窗口命令），在普通浏览器里量尺寸、截图；看不到的部分（WebView2 渲染差异、无边框窗口拖动 / 缩放 / 贴靠、真 DSH 进程与托盘）才上真机。 |
| 验证门 | verification gates | 交付前必过的命令集合，见 `AGENTS.md`「完成定义」。 |
| 手动验收 | manual acceptance | 需要真机才能确认的复核清单（WebView2 渲染差异、无边框窗口拖动 / 缩放 / 贴靠、真 DSH 进程与托盘、安装与卸载），见 `docs/manual-acceptance.md`；日常界面改动不走它，改用预览台，只有发布或涉及真机行为时才逐项走。 |
