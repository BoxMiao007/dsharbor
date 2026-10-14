<!-- vibe-coding-declaration:begin -->
> [!IMPORTANT]
> 本仓库由 AI 开发与维护，所有代码变更均由 AI 执行。
<!-- vibe-coding-declaration:end -->

# DSHarbor

DSH（DeepSeek Harness）Web 版的桌面壳：**安装包尽量小**、关闭界面时释放内存（DSH 后端照常运行）、**自动拿到每次启动动态生成的登录链接**（DSH 内部桥接插件优先、启动日志解析兜底，可一键在壳窗口或系统浏览器打开且已登录）、支持四种启动方式（官方 npx 命令 / 系统全局命令 / 指定二进制路径 / WSL 跨系统）。

> 目前状态：**开发中**。骨架、启动器、登录链接、轻量模式与托盘、配置持久化（含端口覆盖）已跑通（WSL2 交叉编译出 Windows 安装包 → 真机安装；界面里可选四种启动方式拉起 DSH，显示运行状态与带 token 的登录链接，可一键停止、两种方式打开 DSH 界面（当前程序/浏览器）；桥接插件支持在 Windows / WSL 两侧一键安装/卸载并自动备份回滚；关闭窗口即进入轻量模式释放界面内存，托盘菜单五档、单击目标可配置；启动配置自动保存、重开壳保留，端口可跟随或覆盖 DSH 配置；「最近输出 / 操作输出」折叠块在启动、停止、桥接安装/卸载/恢复等操作时会自动展开）；单实例（重复启动聚焦已有窗口）、DSH 意外退出提示与「重新启动」入口、安装包元数据与卸载数据保留均已跑通；文档收尾完成（术语表与手动验收手册见仓库；等待维护者确认提交与发布）。功能计划见[需求单 #1](https://github.com/BoxMiao007/dsharbor/issues/1)。

## 给使用者：怎么装、怎么用

> 第一个可日常使用的版本尚未正式发布；想现在就用，按下方「给开发者」一节自己打包即可（装到当前用户目录、不需要管理员权限；Win10/11 自带 WebView2 运行时）。

使用方式：

- 安装：双击安装包按向导完成（静默安装：命令后加 `/S`）
- 日常使用：右键托盘提供「浏览器打开 / 当前程序打开 / 打开启动界面 / 重启 DSH / 停止 DSH / 完全退出」（Win11 默认收在「隐藏的图标」里，可拖到任务栏常显）；单击托盘图标打开你在界面里配置的默认窗口（启动界面或程序窗口）；「停止 DSH」只停后端，壳与窗口照样用
- 两种打开方式（相互独立，关一个不影响另一个）：「当前程序打开」在弹出的壳窗口里看已登录的 DSH 界面（Token 由壳自动换取，不用手拼链接）；「浏览器打开」显式交给系统默认浏览器
- 默认不碰系统浏览器：界面就在壳自己的窗口里（Windows 自带 WebView2 内核，关窗即释放）；启动 DSH 时壳自动加 `--no-open`，不会自动弹出浏览器——想用浏览器时点「浏览器打开」手动开
- 关闭主窗口 = 轻量模式：界面内存释放（实测两窗口全开 1037 MB → 关窗后 474 MB，减少的约 563 MB 全部来自 WebView），DSH 后端继续运行，登录链接保留；单击托盘（或菜单「打开启动界面」）窗口原地重建，登录链接自动恢复
- 启动配置（启动方式、附加参数、WSL 发行版、端口）在界面里改完即自动保存，重开壳后保留；壳自己的配置与桥接插件备份存放在 `%APPDATA%\DSHarbor`，卸载时保留
- 端口默认跟随你 DSH 配置里的值（界面会显示当前生效值，如 3080）；也可以填自定义端口，壳以一次性覆盖层生效——不改动你的任何 DSH 配置文件
- 重复启动壳只会切回已开着的那个窗口；DSH 意外退出时界面会提示并给出「重新启动 DSH」
- 卸载说明（只删安装目录：不动你的 DSH 数据，也不删壳自己的配置与桥接备份）

## 给开发者：怎么构建

### 一次性准备（WSL2 / Ubuntu）

```bash
# 系统工具：LLVM 工具链（交叉编译用）+ NSIS（打 Windows 安装包用）
sudo apt-get install -y clang lld llvm nsis

# Rust：Windows 目标编译器 + 交叉编译工具
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin

# 前端依赖
pnpm install
```

### 日常命令

```bash
cargo fmt --check            # Rust 格式检查
cargo test -p dsharbor-core  # 纯逻辑核心库的单元测试（开发机直接跑）
node --test plugins/dsharbor-bridge/test/bridge.test.js  # 桥接插件测试
pnpm build                    # 前端类型检查 + 构建
pnpm pack:bridge              # 桥接插件打 tgz（tauri build 会自动执行）

# 静态检查（按真实交付目标 Windows 跑）
cargo xwin clippy --workspace --all-targets --target x86_64-pc-windows-msvc -- -D warnings

# 一条命令产出 Windows 安装包
pnpm exec tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
# 产物：target/x86_64-pc-windows-msvc/release/bundle/nsis/DSHarbor_<版本>_x64-setup.exe
```

### 仓库结构

- `crates/dsharbor-core/` —— 与界面、系统 API 无关的纯逻辑（开发机可全自动测试）
- `src-tauri/` —— Tauri 2 外壳（窗口、启动器、登录链接、轻量模式）
- `src/` —— 前端界面（Vite + TypeScript）
- `plugins/dsharbor-bridge/` —— DSH 桥接插件（壳经它取登录链接；以 tgz 形式随安装包分发）
- `docs/decisions.md` —— 重大技术决策记录
- `docs/manual-acceptance.md` —— 发布前 Windows 手动验收手册（每步含操作与期望结果）
- `GLOSSARY.md` —— 项目与 DSH 生态的核心术语表

## 给 AI agent 的约定

本仓库的协作规则见 [AGENTS.md](AGENTS.md)。
