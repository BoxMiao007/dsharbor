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
| 一键启动 | 五种启动方式：官方 npx / 系统全局命令 / 指定二进制路径 / 自定义命令 / WSL 跨系统（在发行版内拉起 DSH）；「指定程序路径」可直接点「浏览…」挑文件，选完立刻提示路径是否可用；「自定义命令」可以自己写整条启动命令（如 `npx @deepseek-ai/dsh@next web`），壳只在末尾补上 `--no-open` 与附加参数；启动前只有一个「启动 DSH」，起来之后同一个按钮变成「停止」、并多出「重启 DSH」 |
| 运行自动检测 | 启动前自动探测目标地址（跟随 DSH 配置的绑定地址，回环或网卡 IP 都行）：已有 DSH Web 在跑（上次壳异常退出残留等）就不再重复拉起、直接显示「运行中」，不会被端口冲突报错卡住；检测到的不是本壳启动的 DSH 时，「停止 / 重启」会说明原因而不是悄悄失效 |
| 登录链接自动到手 | 桥接插件（首选，现场铸造）+ 启动日志解析（兜底）；「应用内打开」弹出的窗口直接是登录态，不用手拼链接 |
| 两种打开方式 | 「应用内打开」（壳内 WebView2 窗口）/「浏览器打开」（系统默认浏览器）；两窗口相互独立 |
| 轻量模式 | 关闭窗口释放界面内存（延迟时长可在界面设置，默认立即），DSH 与托盘常驻，托盘一点窗口回来 |
| 配置持久化 | 启动方式、附加参数、WSL 发行版、端口改完即存（`%APPDATA%\DSHarbor`）|
| 端口覆盖 | 默认跟随 DSH 配置（界面显示当前生效值），也可自定义；端口框旁的「还原」按钮一键恢复默认（清空 = 继续跟随 DSH 配置）；不改动任何 DSH 文件。附加参数里写了 `--port` / `--host` 时，端口提示会说明「以它为准」 |
| TLS 提示 | DSH 开了 `--tls-cert` / `--tls-key` 时壳的探测走明文 HTTP、读不出对方身份；这种情况会直接说明「壳暂不支持加密连接」，而不是误报成端口被占用 |
| 桥接插件管理 | 经官方 `dsh plugin` 通道安装，不碰 DSH 配置；Windows / WSL 两侧一键安装 · 卸载 · 回滚（自动备份 profile 文件并附哈希清单，只保留最近 5 份，超出删最旧的）；卡片内可一键打开备份目录 |

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

别把 `cargo xwin build --release`（或 `cargo build`）单独编出来的 `target/.../release/dsharbor.exe` 直接拷去运行或替换安装目录：那是不带 tauri `custom-protocol` 的**开发版**，它按 `devUrl` 去连 `http://localhost:1420` 的 Vite dev server，脱离 dev server 只会看到「localhost 拒绝连接」的错误页。能独立运行的产物只有上面这条命令出的安装包（或它装出来的安装目录里的 exe）。

### 仓库结构

| 目录 | 内容 |
|---|---|
| `crates/dsharbor-core/` | 纯逻辑核心库（启动命令构造、token 解析、端口覆盖层、轻量模式状态机）——开发机可全自动测试 |
| `plugins/dsharbor-bridge/` | DSH 桥接插件（随安装包以 tgz 分发） |
| `src-tauri/` | Tauri 2 外壳（启动器、登录链接、轻量模式、托盘、桥接插件管理） |
| `src/` | 前端界面（Vite 8 + TypeScript 7，无 UI 框架） |
| `assets/` | 图标源：`icon-source.png`（主用）、`icon-source.svg`（备用）、`logo.png` |
| `design/ui-candidates/` | 界面候选静态稿（`node scripts/ui-candidates.mjs` 起预览台逐个点开挑选） |
| `docs/decisions.md` | 重大技术决策记录（每条含决策、原因、放弃了什么） |
| `docs/manual-acceptance.md` | 发布前 Windows 手动验收手册 |
| `GLOSSARY.md` | 项目与 DSH 生态术语表 |

### 技术栈

Tauri 2（Rust + 系统 WebView2）和 Vite 8 / TypeScript 7；在 WSL2 用 `cargo-xwin` 交叉编译、NSIS 打安装包。为什么这么选、放弃了什么，都记在 `docs/decisions.md`。

## 给 AI agent 的约定

本仓库由 AI 开发与维护：维护者只提需求与验收，实现、验证、文档、提交由 AI 完成。协作规则见 [AGENTS.md](AGENTS.md)。
