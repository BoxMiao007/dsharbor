# Agent 开发约定

本文件是在本仓库工作的 AI agent 的工作契约。维护者不写代码、只提需求和验收,实现、验证、文档、提交均由 agent 完成。用户全局规则继续生效,本文件只写项目特有约定;两者冲突时,更具体的本文件优先。

## 项目是什么

DSH(DeepSeek Harness)Web 版的桌面壳:安装包尽量小、关掉界面时释放内存但 DSH 后端照常跑、自动拿到每次启动动态生成的登录链接、支持四种启动方式(官方 npx 命令 / 系统全局命令 / 指定二进制路径 / 自定义命令)与独立的运行环境选择(Windows 宿主 / 某个 WSL 发行版)。

v1 只做 Windows;开发与运行都在 Windows 本机(原 WSL2 + cargo-xwin 交叉编译的管线已下线,见 `docs/decisions.md`)。功能拆解与进度见需求单 #1(https://github.com/BoxMiao007/dsharbor/issues/1)。

## 目录地图

| 路径 | 是什么 |
|---|---|
| `crates/dsharbor-core/` | 纯逻辑核心库:启动计划构造、输入校验、链接解析、轻量模式状态机、插件清单与更新比较;不碰界面与系统 API,`cargo test` 全自动。 |
| `src-tauri/src/` | Tauri 壳层(Rust):`lib.rs` 是命令入口与 AppState,其余按域分文件——`launcher` 启动器、`plugin` 桥接插件安装、`plugin_switch`/`plugin_update` 插件开关与更新、`registry` 版本查询、`npxcache` npx 缓存扫描、`patch` 补丁层、`tray` 托盘、`wsl` 运行环境等。 |
| `src/` | 前端(TypeScript,无框架):`main.ts` 主逻辑,`ui/build-html.ts` DOM 模板,`ui/icons.ts` 内联 SVG 图标,`styles/` 按编号分区的样式(共 14 个文件,`00-tokens.css` 定义全部 CSS 变量,其余 13 个文件只引用变量)。 |
| `plugins/dsharbor-bridge/` | 随壳分发的 DSH 桥接插件(npm 包,`pnpm pack:bridge` 打成 tgz 放进 `src-tauri/resources/`)。 |
| `scripts/` | `mock-preview.mjs` 假数据预览台等辅助脚本。 |
| `test/` | `frontend/` 浏览器接缝测试(puppeteer-core 驱动 Edge,每文件独占端口);桥接插件测试在 `plugins/dsharbor-bridge/test/`。 |
| `docs/` | `decisions.md` 决策记录、`manual-acceptance.md` 真机复核清单、`agents/` 子契约。 |

`dist/`、`target/`、`src-tauri/resources/*.tgz` 都是构建产物,可随时重建、可清理。

## 协作模式

- 用户的话按"需求与验收期望"理解,不是技术指令;技术选型、实现细节、文件组织由 agent 决定。
- 方案不唯一且影响后续走向(技术栈、数据模型、外部服务、付费依赖)时,用简体中文给 2~3 个带取舍的选项让用户选;能安全推断的直接做,做完说明选了什么、为什么。
- 不问只有程序员才能答的技术判断题;确需用户拍板时,一次问清并附默认建议。

## 完成定义(每次交付前逐项核对)

1. 验证门全部通过(以下命令均已实测):
   - `cargo fmt --check`(Rust 格式)
   - `cargo clippy --workspace --all-targets -- -D warnings`(静态检查;开发机就是 Windows msvc 宿主,不需要交叉参数)
   - `cargo test -p dsharbor-core`(纯逻辑核心库单元测试,开发机直接跑)
   - `node --test plugins/dsharbor-bridge/test/bridge.test.js`(桥接插件测试)
   - `node --test --test-concurrency=2 test/frontend/*.test.mjs`(前端界面测试:用 `puppeteer-core` 驱动 Edge 在假数据预览台上跑,覆盖用量尺寸/可见性/动画这类浏览器里才说得清的接缝;依赖本机 `C:\Users\BOXMIAO\.pi\agent\npm\node_modules\puppeteer-core` 与 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,可用 `DSHARBOR_PUPPETEER` / `DSHARBOR_BROWSER` 覆盖,缺失时整组 skip;并发参数的必要性见下文「容易踩的」)
   - `pnpm build`(前端类型检查 + 构建)
   - `pnpm pack:bridge`(打桥接插件 tgz 到 `src-tauri/resources`;`pnpm build` 会清空 `dist` 但不会生成它,缺了它 clippy/打包会报 `glob pattern resources/*.tgz path not found`)
   - `pnpm exec tauri build`(完整 Windows 安装包,本地测试默认「速度优先」构建;**只在改动涉及打包配置、发版或验安装器时跑**,日常改界面不算验证门)
2. 功能实际跑通:能启动的自测核心路径;涉及界面或输出的改动,附截图或运行结果作为交付证据。界面改动按两档验,**任何一档都不打安装包**:
   - 量尺寸、看排版:`pnpm build` 后用 `node scripts/mock-preview.mjs` 在普通浏览器里按假数据渲染、量尺寸、截图。注意验证门里的 `pnpm build` 会清空 `dist`,交付预览前必须重跑一次 `node scripts/mock-preview.mjs --no-serve` 重新生成 `dist/mock.html`,否则预览地址返回 404。
   - 需要在真窗口里点一遍:`pnpm exec tauri dev`(首次或桥接插件改过时先 `pnpm pack:bridge`)。一条命令同时起 Vite(`127.0.0.1:1420`)与真 Tauri 窗口,前端存盘即刷新、Rust 改动自动重编重启。拖动/缩放/贴靠、WebView2 与 Chromium 的渲染差异(例如 `::-webkit-scrollbar` 在预览的 overlay 滚动条下被忽略)、真 DSH 进程与托盘、按钮悬停漫过与逐字切换这类交互,都在这档验。
   - 禁止用「`tauri build` + 静默安装 + 装出来的 exe」验界面:一轮要几分钟,且必须先关掉在跑的实例;那一套只在发版、验安装器/卸载、验托盘时才用。
3. 交付说明讲给不写代码的人听:做了什么、怎么看到结果(地址/命令/截图)、有什么限制和后续建议;没把握或未完成的部分明说,不藏在细节里。
4. 打出来的安装包只在发版或专门验安装器时用,不用于日常界面验证:
   - 需要装到本机时:先关掉在跑的实例(`Stop-Process -Name dsharbor -Force`,或托盘里完全退出),再静默执行 `target/release/bundle/nsis/DSHarbor_<版本>_x64-setup.exe /S`(安装包会一并刷新注册表卸载项、开始菜单与 `uninstall.exe`,不用再手工 copy 文件)。安装目录沿用上次选择的位置(已实测:NSIS 从注册表卸载项读回 `InstallLocation`,当前是 `D:\Program Files\DSHarbor`;装完 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHarbor` 的 `DisplayVersion` 会跟着更新)。
   - 不要用纯文件替换:那只换 exe 与资源、不动注册表与 `uninstall.exe`,装出来的版本信息会对不上。
   - 更不要拿裸 `cargo build --release` 的 `target/release/dsharbor.exe` 去运行或替换安装目录:那是开发版(没开 tauri 的 `custom-protocol`,运行时按 `devUrl` 去连 `http://127.0.0.1:1420` 的 Vite dev server),脱离 dev server 只会看到「127.0.0.1 拒绝连接」的错误页,而无边框主窗口的关闭按钮就在页面里。开发期要看真窗口行为,用 `pnpm exec tauri dev`。

## 容易踩的

- **前端测试跑的是 `dist/mock.html`,不是源码**:改完前端必须先 `pnpm build` 再跑 `node --test test/frontend/`,否则测的是旧构建、出「假失败」;测试莫名失败先怀疑构建没刷新,再怀疑代码。
- **前端测试每个文件独占一个端口**(log-unread 8207 / plugin-switch 8208 / version-picker 8209 / toolbar-round 8210 / plugin-update 8211 / notice-hint 8212 / badge-color 8213 / danger-surface 8214 / motion-pref 8215 / motion-interactions 8216 / motion-tooltip 8217 / motion-theme 8218 / motion-panels 8219 / motion-modal 8220 / motion-spinner 8221 / motion-toast 8222 / motion-copy 8223 / motion-progress 8224 / motion-skeleton 8225;8226 起空闲):`node --test` 并行跑会同时起各自的预览台,新写测试文件先挑没占用的端口——先 `grep -h "const PORT" test/frontend/*.test.mjs` 看现状,别照抄别的文件注释里的旧号码;调试留下的预览台进程占住端口,会让测试自己的预览台「预览台退出 (code 1)」整组秒挂,先 `netstat -ano` 找到 PID 再 `taskkill`。
- **前端测试要带 `--test-concurrency=2` 跑**(如 `node --test --test-concurrency=2 test/frontend/*.test.mjs`):默认全并行会让每个动效时序断言成片假失败(已两轮实证:全并行挂 8~9 个 motion-*/notice-hint/log-unread 用例,低并发 96/96 全过)——十几套 Edge + 预览台同时抢 CPU,动画帧时序全被拖慢;失败样例是「应已淡出,实测 opacity=1」「期望 162px 实测 165.5px」这类差一点点的断言,先怀疑并发而不是代码。
- **mock 假命令的延时按「每条命令」计**(如「全部更新」一条命令 600ms,不是每个插件各 600ms):写等待与超时断言前,先看 mock 状态里注入的延时字段。

## 界面设计规范(所有界面样式调整默认遵循)

四条通用细节规范,新增组件与样式重写都要按此检查,存量元素遇到就顺手修正;不需要每次在需求里重复交代。

1. **等宽数字**:所有会变动的数值(版本号、计数、时间、进度、PID 等)加 `font-variant-numeric: tabular-nums`,数值变化时宽度不变、不左右抖动。字符本身就等宽的等宽字族(`Consolas` 之类,如版本号徽章)天然满足,不必重复声明。
2. **同心圆角**:嵌套元素的外层圆角 = 内层圆角 + 两者之间的内边距(`outer = inner + padding`),保证内外弧线视觉同心。反过来设计时按 `inner = outer − padding` 取内层半径。
3. **标题平衡换行**:标题文字换行用 `text-wrap: balance`,避免最后一行只剩一个词。
4. **柔和阴影替代边框**:卡片/容器的分隔优先用多层柔和阴影(令牌 `--shadow-soft`)替代硬描边;换背景色时阴影自然融合,不用跟着调边框色。需要保底轮廓时用发丝边(`color-mix` 把 `--line` 调淡)而不是 1px 实线。

## 提交与推送

- 默认自行提交:完成并验证后直接按下面的粒度提交,不再等用户点头;交付说明里写明提交号与提交内容。
- 不自动推送:提交后留在本地,用户明确说推送时才推送到 origin。
- 提交粒度:一个独立功能、一处缺陷修复或一次重构各提交一次;提交前检查暂存内容,确保只含本次任务明确产生且经过检查的改动;提交前验证门必须全部通过。
- 密钥、凭据等敏感内容一律不提交;新增构建产物或本地环境文件类型时,同步补充 `.gitignore`(不含真实敏感值的 `.env.example` 等样例除外)。发现疑似敏感内容或无法确认安全性时,说明文件路径并停止提交,交由用户决定;不得为完成提交绕过 Git 钩子或其他安全检查。

## 版本与发布(用户明确说发版时才做)

本项目遵循 SemVer 2.0.0，标签格式 `vX.Y.Z`。递增由当前版本阶段与 Commit 类型机械决定：

- `BREAKING CHANGE:` footer，或任意类型携带 `!`（如 `feat!:`、`fix!:`、`refactor!:`）→ 升 MAJOR；
- `feat:` → 升 MINOR；
- 其余类型一律升 PATCH（如 `fix:`、`perf:`、`docs:`、`chore:`、`test:`、`ci:`、`build:`）；
- 处于 `0.y.z` 阶段时，凡按上述规则应升 MAJOR 的，改为升 MINOR；
- 无法机械判定时，暂停自动决策，列出候选版本号及理由，请用户选择。
- 仓库还没有任何 `vX.Y.Z` 标签时，首个发布为 `0.1.0`。

发布流程：

1. 更新承载版本号的文件（如 `VERSION`、`package.json`）。
2. 创建本地 annotated tag：`git tag -a vX.Y.Z -m "Release vX.Y.Z"`，**不推送**。
3. 停下并等待用户批准（闸门规则见全局 `AGENTS.md`「发布闸门」）；批准前不再产生新提交，若已产生，批准后先删掉本地 tag 重打（未推送的 tag 可以删），再推送。
4. 获批准后推送 tag 并执行 `gh release create`，Release 正文写清本次版本号与变更分类（breaking / feature / fix）；`gh` 未认证或仓库无 Release 权限时，只推送 tag 并说明原因，不阻断发布。

验证：宣称发布完成须附 `git tag -l vX.Y.Z` 与 `gh release view vX.Y.Z` 实际输出，并确认版本号文件与 tag 一致。

本仓库落地（DSHarbor，本块只写本仓库特有约定）：

- **只在用户明确说「发版」时才动版本号与 tag**，agent 不自行发版。
- **提交类型是机械判定的唯一输入**：提交信息用 `type(scope): 中文描述`，type 限 `feat` / `fix` / `perf` / `docs` / `chore` / `test` / `ci` / `build` / `refactor`，scope 可选（常用 `ui` / `launcher` / `plugin` / `tray` / `wsl` / `core` / `release`），破坏性变更用 `!` 或 `BREAKING CHANGE:` footer。历史提交不追溯；判定区间是「上一版本 tag..HEAD」的全部提交，取最高优先级（`BREAKING > feat > 其余`），一个区间只出一个结论。
- **三处版本号必须一致**：`package.json`、`src-tauri/tauri.conf.json`、`Cargo.toml` 的 `[workspace.package].version`（两个 crate 用 `version.workspace = true` 继承，`Cargo.lock` 随构建自动更新）。
- **升版提交写作 `chore(release): X.Y.Z`**，且不参与升版判定（否则每次发版会再涨一位）。
- **`1.0.0` 只能由用户明确指定**：agent 仅在已发布功能走完 `docs/manual-acceptance.md` 本机验收、且无已知阻断问题时，才在发布闸门里顺带提议。
- **发布 GitHub 的安装包必须用「性能优先」构建，禁止发「速度优先」的包**：`[profile.release]` 默认是速度优先（thin LTO + codegen-units 16，本地测试用），发布构建在它之上用环境变量覆盖成 fat LTO + 单 codegen 单元——`CARGO_PROFILE_RELEASE_LTO=true CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 pnpm exec tauri build`。发过速度优先的包要用性能优先重编后替换资产。
- **资产只放安装包**：不单独放裸 exe——程序需要同目录的 `resources/`。安装包文件名与 `--title` 沿用 `DSHarbor vX.Y.Z`。
- **Release 正文只写使用者能感知的变化**：分类节只出现有内容的 `## 新增` / `## 修复` / `## 变更` / `## 已知问题`；条目说人话、用界面上的原文（如「启动 DSH」「桥接插件」「轻量模式」），不逐条带日期（Release 页面自带发布日期）。不写构建或编译参数、重构、依赖升级、体积变化与性能数字、内部工具（预览台脚本、CI）、版本号元信息、安装包名/大小/SHA-256。

## 知识沉淀(保证任何新会话都能接手)

- 全新环境的依赖安装命令(已在 Windows 本机实测):安装 VS Build Tools(含 C++ 桌面开发 + Windows SDK,即 `link.exe`)、Rust 工具链(宿主 `x86_64-pc-windows-msvc`,带 `rustfmt` / `clippy`)、Node.js + pnpm(`pnpm install`);NSIS 由 `tauri build` 首次打包时自动下载到 `%LOCALAPPDATA%\tauri\NSIS`(需能访问 GitHub,墙内要开代理)。不再需要 clang/lld/llvm/cargo-xwin。步骤变化时同步更新 README。
- 重大技术决策(选型、数据模型、外部服务)在 `docs/decisions.md` 记一行:日期、决策、为什么、放弃了什么。技术栈选型是第一条要记的决策。发布前至少走一遍界面预览台 `node scripts/mock-preview.mjs` 确认界面能渲染、核心交互可用;`docs/manual-acceptance.md` 保留作真机复核清单,需要时再照它走。
- README 面向用户维护:项目是什么、怎么启动、日常怎么用,保持非程序员能看懂。

## Agent skills

### Issue tracker

Issues 与规格存放在 GitHub Issues(用 `gh` CLI 操作)。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用默认五种 triage 标签:`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context 布局:根目录 `GLOSSARY.md`；重大技术决策按本仓库约定记录在 `docs/decisions.md`（模板中的 docs/adr/ 未启用）。见 `docs/agents/domain.md`。
