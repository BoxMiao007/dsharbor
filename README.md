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
  安装包约 2 MB · 关窗即释放界面内存 · 登录链接自动到手
</p>

## 它解决什么

DSH Web 版（`dsh web`）每次启动会在本地起 HTTP 服务，并随机生成一次性 token——你得从终端日志里找到带 token 的地址，再丢进浏览器。浏览器标签开着不动会持续吃内存，终端一关链接也就找不回来了。

DSHarbor 把这些收进一个 2 MB 出头的 Windows 桌面壳：

- **一键启动**：四种启动方式（官方 npx 命令 / 系统全局命令 / 指定二进制路径 / WSL 跨系统），启动、停止、重启都在界面上；
- **登录链接自动到手**：壳以 DSH 插件（`dsharbor-bridge`）为第一通道现场铸造链接、启动日志解析兜底；「当前程序打开」弹出的窗口**直接是登录态**，不用手拼链接；
- **界面内存可释放**：关闭窗口即销毁 WebView（实测两窗口全开 1037 MB → 关窗后 474 MB），DSH 后端与托盘常驻，托盘一点窗口原地重建；
- **不碰你的 DSH 配置**：端口覆盖用一次性 launcher 层；桥接插件走官方 `dsh plugin` 安装，装前自动备份（只保留最近 5 份）、可一键回滚。

## 功能一览（v0.1.0）

| 能力 | 说明 |
|---|---|
| 四种启动方式 | 官方 npx / 系统全局命令 / 指定二进制路径 / WSL 跨系统（在发行版内拉起 DSH） |
| 登录链接 | 桥接插件（首选）+ 启动日志解析（兜底），界面徽章显示「桥接就绪 / 日志兜底就绪」；token 只驻内存、不落盘 |
| 两种打开方式 | 「当前程序打开」（壳内 WebView2 窗口）/「浏览器打开」（系统默认浏览器）；两窗口相互独立 |
| 轻量模式 | 关闭窗口释放界面内存，DSH 与托盘常驻；关一个窗口不连带关另一个 |
| 托盘菜单 | 浏览器打开 / 当前程序打开 / 打开启动界面 / 重启 DSH / 停止 DSH / 完全退出；单击目标可配置 |
| 配置持久化 | 启动方式、附加参数、WSL 发行版、端口改完即存（`%APPDATA%\DSHarbor`），卸载不删 |
| 端口覆盖 | 默认跟随 DSH 配置（界面显示当前生效值），也可自定义；不改动任何 DSH 文件 |
| 桥接插件管理 | Windows / WSL 两侧一键安装 · 卸载 · 回滚（自动备份 profile 文件并附哈希清单，只保留最近 5 份，超出删最旧的）；卡片内可一键打开备份目录 |
| 会话卡片信息 | 「DSH 会话」状态行依次是登录徽章、状态徽章（启动中 / 运行中 / 已停止 / 启动失败）、当前 DSH 版本徽章、PID 与端口；版本在每次成功启动后自动读取，并记在 `%APPDATA%\DSHarbor` 下，壳重开后直接沿用上次的值（不再显示「未知」） |
| 可折叠卡片 | 「启动方式」「桥接插件」标题可点开/收起（收起状态不落盘）；收起后标题上直接显示徽章（当前启动方式 / 桥接安装状态）；「DSH 会话」与「关于」常开 |
| 日志与复制 | 「最近输出」「操作输出」只显示最近 15 行，超出可在框内滚动，内容可选中、点「复制」一键拷贝全量 |
| 关于卡片 | 壳与核心库版本、DSH 版本、开源许可证、项目仓库、DSH 官网、配置目录、日志目录；后四项各带自己的打开按钮（仓库 / 官网走浏览器，两个目录走资源管理器） |
| 单实例与健壮性 | 重复启动聚焦已有窗口；DSH 意外退出给出提示，随时可用「重启 DSH」入口（界面与托盘一致） |

功能计划与进度见[需求单 #1](https://github.com/BoxMiao007/dsharbor/issues/1)。

## 给使用者

> 安装包未做代码签名，首次运行 Windows 可能提示 SmartScreen，选「仍要运行」即可。需要 Win10/11（自带 WebView2 运行时）。

1. **安装**：双击 `DSHarbor_0.1.0_x64-setup.exe` 按向导完成（静默安装：命令后加 `/S`）。装到当前用户目录，不需要管理员权限。
2. **启动**：打开 DSHarbor → 选启动方式（默认「官方 npx 命令」）→ 点「启动 DSH」。首次用 npx 会自动下载 DSH，稍慢。
3. **看界面**：状态先显示「启动中」（拿到登录链接前），再变「运行中」；点「当前程序打开」（或托盘菜单）即可看到已登录的 DSH 界面，也可以用「浏览器打开」交给系统默认浏览器。卡片标题可点开/收起（收起后标题上会显示当前启动方式 / 桥接安装状态），末尾的「关于」卡片能查壳与 DSH 版本、仓库、配置与日志目录（都能一键打开）。
4. **省内存**：直接关闭窗口即可——界面内存立刻释放，DSH 继续运行；单击托盘图标随时回来（打开哪个窗口可在界面里配置）。
5. **卸载**：只删安装目录；DSH 数据（`%USERPROFILE%\.dsh`）与壳配置、桥接备份（`%APPDATA%\DSHarbor`）都会保留。

## 给开发者

### 一次性准备（WSL2 / Ubuntu）

```bash
sudo apt-get install -y clang lld llvm nsis        # LLVM 工具链 + NSIS
rustup target add x86_64-pc-windows-msvc           # Windows 目标
cargo install --locked cargo-xwin                  # 交叉编译工具
pnpm install                                       # 前端依赖
```

### 验证门（提交前必过）

```bash
cargo fmt --check
cargo test -p dsharbor-core
node --test plugins/dsharbor-bridge/test/bridge.test.js
pnpm build
cargo xwin clippy --workspace --all-targets --target x86_64-pc-windows-msvc -- -D warnings
```

### 一条命令出 Windows 安装包

```bash
pnpm exec tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
# 产物：target/x86_64-pc-windows-msvc/release/bundle/nsis/DSHarbor_<版本>_x64-setup.exe
```

### 仓库结构

| 目录 | 内容 |
|---|---|
| `crates/dsharbor-core/` | 纯逻辑核心库（启动命令构造、token 解析、端口覆盖层、轻量模式状态机）——开发机可全自动测试 |
| `plugins/dsharbor-bridge/` | DSH 桥接插件（随安装包以 tgz 分发） |
| `src-tauri/` | Tauri 2 外壳（启动器、登录链接、轻量模式、托盘、桥接插件管理） |
| `src/` | 前端界面（Vite 8 + TypeScript 7，无 UI 框架） |
| `assets/` | 图标源：`icon-source.png`（主用）、`icon-source.svg`（备用）、`logo.png` |
| `docs/decisions.md` | 重大技术决策记录（每条含决策、原因、放弃了什么） |
| `docs/manual-acceptance.md` | 发布前 Windows 手动验收手册 |
| `GLOSSARY.md` | 项目与 DSH 生态术语表 |

### 技术栈

Tauri 2（Rust + 系统 WebView2）和 Vite 8 / TypeScript 7；在 WSL2 用 `cargo-xwin` 交叉编译、NSIS 打安装包。为什么这么选、放弃了什么，都记在 `docs/decisions.md`。

## 给 AI agent 的约定

本仓库由 AI 开发与维护：维护者只提需求与验收，实现、验证、文档、提交由 AI 完成。协作规则见 [AGENTS.md](AGENTS.md)。
