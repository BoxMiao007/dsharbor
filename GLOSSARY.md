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
| 折叠摘要徽章 | card summary badge | 卡片收起时显示在标题行右侧的小徽章：「启动方式」显示当前方式名、「桥接插件」显示已安装 / 未安装；展开时隐藏。收起状态记在界面本地存储（`localStorage` 键 `dsharbor.ui.cardCollapsed`），壳重开后沿用。 |
| 关于卡片 | about card | 启动界面末尾常开的卡片：壳与核心库版本、DSH 版本、许可证、仓库、官网，以及配置目录 / 日志目录的一键打开入口。 |
| 回滚备份 | bridge backup | 安装/卸载桥接插件前，壳把 profile 中会被 pnpm 改写的文件（package.json、pnpm-workspace.yaml、pnpm-lock.yaml、cordis.patch.yml）备份到 `%APPDATA%\DSHarbor\backups`（含内容哈希清单）；只保留最近 5 份，超出删最旧的。 |
| 自绘标题栏 | custom titlebar | 主窗口顶部那条自己画的标题栏（窗口用 `decorations: false`，没有系统标题栏）：左上角应用图标 + `DSHarbor`，右上角最小化 / 最大化 / 关闭（关闭 = 轻量模式）；整条可拖动、双击最大化 / 还原、背景全透明。已知取舍：Windows 11 贴靠布局与 `Alt+Space` 系统菜单在自绘标题栏下不可用。 |
| 滚动指示条 | scroll indicator | 页面右缘那条 5px 淡蓝细胶囊：滚动时或指针移到那条带上才出现，可按住上下拖；它替代了占宽度的视口滚动条（后者已隐藏），内部框（「最近输出 / 操作输出」）另用 8px 极淡细条。 |
| 预览台 | mock preview（`scripts/mock-preview.mjs`） | 界面改动的第一道证据：`pnpm build` 后把 `dist/index.html` 拷成 `mock.html` 并注入假的 `__TAURI_INTERNALS__`（假 DSH 状态、假桥接、假窗口命令），在普通浏览器里量尺寸、截图；看不到的部分（WebView2 渲染差异、无边框窗口拖动 / 缩放 / 贴靠、真 DSH 进程与托盘）才上真机。 |
| 验证门 | verification gates | 交付前必过的命令集合，见 `AGENTS.md`「完成定义」。 |
| 手动验收 | manual acceptance | 需要真机才能确认的复核清单（WebView2 渲染差异、无边框窗口拖动 / 缩放 / 贴靠、真 DSH 进程与托盘、安装与卸载），见 `docs/manual-acceptance.md`；日常界面改动不走它，改用预览台，只有发布或涉及真机行为时才逐项走。 |
