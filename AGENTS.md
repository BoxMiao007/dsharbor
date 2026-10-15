# Agent 开发约定

本文件是在本仓库工作的 AI agent 的工作契约。维护者不写代码、只提需求和验收,实现、验证、文档、提交均由 agent 完成。用户全局规则继续生效,本文件只写项目特有约定;两者冲突时,更具体的本文件优先。

## 项目是什么

DSH(DeepSeek Harness)Web 版的桌面壳:安装包尽量小、关掉界面时释放内存但 DSH 后端照常跑、自动拿到每次启动动态生成的登录链接、支持四种启动方式(官方 npx 命令 / 系统全局命令 / 指定二进制路径 / WSL 跨系统)。

v1 只做 Windows;开发在 WSL2、运行在 Windows。功能拆解与进度见需求单 #1(https://github.com/BoxMiao007/dsharbor/issues/1)。

## 协作模式

- 用户的话按"需求与验收期望"理解,不是技术指令;技术选型、实现细节、文件组织由 agent 决定。
- 方案不唯一且影响后续走向(技术栈、数据模型、外部服务、付费依赖)时,用简体中文给 2~3 个带取舍的选项让用户选;能安全推断的直接做,做完说明选了什么、为什么。
- 不问只有程序员才能答的技术判断题;确需用户拍板时,一次问清并附默认建议。

## 完成定义(每次交付前逐项核对)

1. 验证门全部通过(以下命令均已实测):
   - `cargo fmt --check`(Rust 格式)
   - `cargo xwin clippy --workspace --all-targets --target x86_64-pc-windows-msvc -- -D warnings`(静态检查,按交付目标 Windows 跑)
   - `cargo test -p dsharbor-core`(纯逻辑核心库单元测试,开发机直接跑)
   - `node --test plugins/dsharbor-bridge/test/bridge.test.js`(桥接插件测试)
   - `pnpm build`(前端类型检查 + 构建)
   - `pnpm exec tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc`(完整 Windows 安装包;改动涉及外壳或打包时必须跑)
2. 功能实际跑通:能启动的自测核心路径;涉及界面或输出的改动,附截图或运行结果作为交付证据。界面改动先用 `node scripts/mock-preview.mjs`(跑完 `pnpm build` 后在普通浏览器里按假数据渲染、量尺寸、截图)出预览与证据,再交给维护者看;它比打包 + 静默安装 + 真机一轮快得多。它的盲区——WebView2 与 Chromium 的渲染差异(例如 `::-webkit-scrollbar` 在预览的 overlay 滚动条下被忽略)、无边框窗口的原生拖动/缩放/贴靠、真 DSH 进程与托盘——只能上真机看。
3. 交付说明讲给不写代码的人听:做了什么、怎么看到结果(地址/命令/截图)、有什么限制和后续建议;没把握或未完成的部分明说,不藏在细节里。
4. 构建完成后默认把产物装到本机安装目录(维护者要求,无需再问;运行中的 DSHarbor 会占用文件,先关掉再装):
   - 关掉在跑的实例:`Stop-Process -Name dsharbor -Force`(或托盘里完全退出)
   - 把 `target/x86_64-pc-windows-msvc/release/bundle/nsis/DSHarbor_<版本>_x64-setup.exe` 复制到 Windows 侧,静默执行 `<setup>.exe /S`(安装包会一并刷新注册表卸载项、开始菜单与 `uninstall.exe`,不用再手工 copy 文件)
   - 安装目录沿用上次选择的位置(已实测:NSIS 从注册表卸载项读回 `InstallLocation`,当前是 `D:\Program Files\DSHarbor`;装完 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHarbor` 的 `DisplayVersion` 会跟着更新)
   - 装完启动该目录下的 exe 确认界面能打开,然后关掉
   - 不要再用纯文件替换:那只换 exe 与资源、不动注册表与 `uninstall.exe`,装出来的版本信息会对不上
   - 更不要拿裸 `cargo xwin build --release` 的 `target/x86_64-pc-windows-msvc/release/dsharbor.exe` 去替换:那是开发版(没开 tauri 的 `custom-protocol`,运行时按 `devUrl` 去连 `http://localhost:1420` 的 Vite dev server),脱离 dev server 只会看到「localhost 拒绝连接」的错误页,而无边框主窗口的关闭按钮就在页面里

## 提交与推送

- 默认自行提交:完成并验证后直接按下面的粒度提交,不再等用户点头;交付说明里写明提交号与提交内容。
- 不自动推送:提交后留在本地,用户明确说推送时才推送到 origin。
- 提交粒度:一个独立功能、一处缺陷修复或一次重构各提交一次;提交前验证门必须全部通过。
- 密钥、凭据等敏感内容一律不提交;新增构建产物或本地环境文件类型时,同步补充 `.gitignore`。

## 知识沉淀(保证任何新会话都能接手)

- 全新环境的依赖安装命令(已在 WSL2 实测):`sudo apt-get install -y clang lld llvm nsis`、`rustup target add x86_64-pc-windows-msvc`、`cargo install --locked cargo-xwin`、`pnpm install`;步骤变化时同步更新 README。
- 重大技术决策(选型、数据模型、外部服务)在 `docs/decisions.md` 记一行:日期、决策、为什么、放弃了什么。技术栈选型是第一条要记的决策。发布前至少走一遍界面预览台 `node scripts/mock-preview.mjs` 确认界面能渲染、核心交互可用;`docs/manual-acceptance.md` 保留作真机复核清单,需要时再照它走。
- README 面向用户维护:项目是什么、怎么启动、日常怎么用,保持非程序员能看懂。

## Agent skills

### Issue tracker

Issues 与规格存放在 GitHub Issues(用 `gh` CLI 操作)。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用默认五种 triage 标签:`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context 布局:根目录 `GLOSSARY.md`；重大技术决策按本仓库约定记录在 `docs/decisions.md`（模板中的 docs/adr/ 未启用）。见 `docs/agents/domain.md`。
