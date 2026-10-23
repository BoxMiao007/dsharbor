/* 配置类常量与推导：下载源/代理选择项、npx 命令拼装、版本下拉的分页口径、唯一 profile 名与启动按钮文案 —— 自 main.ts 原样搬出（2026-10 模块化拆分），声明加 export，其余未改。 */

import type { PickerChoice } from "./picker";
import type { DownloadSource } from "./types";

/** 下载源候选：标签用界面上的原文，value 与 Rust 侧 `DownloadSource::as_str()` 一致。 */
export const DOWNLOAD_SOURCE_CHOICES: PickerChoice[] = [
  { value: "inherit", label: "沿用 npm 全局配置" },
  { value: "mirror", label: "镜像源" },
  { value: "official", label: "官方源" },
];

/** 下载源选中后那行说明：随选项变化，说清代价而不是只报名字。 */
export function downloadSourceHint(source: DownloadSource): string {
  switch (source) {
    case "mirror":
      return "镜像源：国内直连较快；新版本可能稍晚才同步到。";
    case "official":
      return "官方源：更新及时；国内直连可能较慢。";
    default:
      return "沿用 npm 全局配置：不向 DSH 下发任何源，npm 自己读你的 .npmrc；行为与没有这项设置时一致。";
  }
}

/** 代理模式候选：标签用界面上的原文，value 与 Rust 侧 `ProxyMode::as_str()` 一致。 */
export const PROXY_MODE_CHOICES: PickerChoice[] = [
  { value: "system", label: "跟随系统" },
  { value: "manual", label: "手动填写" },
  { value: "off", label: "不走代理" },
];

/** 运行环境下拉的「默认」项：value 与 Rust 侧 Runtime::Default 的语义名一致。 */
export const RUNTIME_DEFAULT = "default";

/**
 * 版本下拉首项的 value：空串 = 「自动最新版本」。
 *
 * 空串在配置里表示「不写死版本号」（`npx --yes @deepseek-ai/dsh web`，跟 npm 的
 * latest 标签走）；它与「还没选过」不是一回事——后者由 Picker 自己的 selected 初值区分。
 */
export const AUTO_VERSION = "";

/** 首项的显示文字（收起时也用它）：与「最新」徽章不是一回事，别合并。 */
export const VERSION_AUTO_LABEL = "自动最新版本";

/** 版本下拉先列几个具体版本，其余收进末尾的「更多…」；点一次「更多…」再放 10 个。 */
export const VERSION_INITIAL_COUNT = 6;
export const VERSION_PAGE_SIZE = 10;

/**
 * 官方 npx 命令的拼装（只用于界面上的实时预览；真正下发的命令由 Rust 侧 `build_spawn_plan` 拼）。
 * `version` 为 null = 首项「自动最新版本」，不带版本号。
 * 保留 `--yes`：壳的子进程没有终端，npx 首次下载时的交互确认会直接把启动卡住。
 */
export function npxCommandOf(version: string | null): string {
  return `npx --yes @deepseek-ai/dsh${version ? `@${version}` : ""} web --no-open`;
}

/**
 * 「自定义命令」输入框的默认值：官方 next 标签，覆盖「想用别的版本 / 别的包管理器」的场景。
 * 保留 `--yes`：壳的子进程没有终端，npx 首次下载时的交互确认会直接把启动卡住。
 */
export const CUSTOM_DEFAULT_COMMAND = "npx --yes @deepseek-ai/dsh@next web";

/**
 * 启动 DSH 恒用的环境名：核心库 `launch.rs::PROFILE_NAME`（= "web"）。
 *
 * 界面里点别的环境只是把「插件与补丁层的管理对象」切过去，真正拉起的会话永远是这一个；
 * 桥接插件也恒装在这一份上（登录链接的取法只跟启动用的环境有关）。
 */
export const START_PROFILE = "web";

/** 「启动 DSH」按钮的两组文字：常显的一组 / 悬停时逐字换上的一组。 */
export const TOGGLE_TEXT_REST = "启动 DSH";
export const TOGGLE_TEXT_HOVER = "开始运行";

/** 启动过程中按钮上那一行字：进程起来了、登录链接还没就绪（npx 首次下载就卡在这）。 */
export const TOGGLE_TEXT_STARTING = "启动中…";

/** 运行态两颗圆钮的气泡文案（也是 aria-label）：纯图标按钮没有可见文字，必须补上。 */
export const TOOLTIP_STOP = "停止 DSH";
export const TOOLTIP_RESTART = "重启 DSH";

/** 启动中那颗长条按钮的气泡：它同时是「点一下能取消」，所以文案要说清两件事。 */
export const TOOLTIP_STARTING = "正在拉起 DSH、等登录链接就绪；点一下可停止。";
