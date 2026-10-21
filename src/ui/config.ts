/* 配置类常量与推导：下载源/代理/渠道选择项、npx 命令拼装、唯一 profile 名与启动按钮文案 —— 自 main.ts 原样搬出（2026-10 模块化拆分），声明加 export，其余未改。 */

import type { PickerChoice } from "./picker";
import type { Channel, DownloadSource, RegistryInfo } from "./types";

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

/** 渠道候选：中文名在前、npm 标签在后；圆点靠 CSS 画（emoji 在 WebView2 里会渲染成黑白方块）。 */
export const CHANNEL_CHOICES: PickerChoice[] = [
  { value: "latest", label: "稳定版（latest）", dot: "latest" },
  { value: "next", label: "最新尝鲜版（next）", dot: "next" },
  { value: "rc", label: "尝鲜版历史版本（rc）", dot: "rc" },
  { value: "alpha", label: "内测版（alpha）", dot: "alpha" },
];

/** 运行环境下拉的「默认」项：value 与 Rust 侧 Runtime::Default 的语义名一致。 */
export const RUNTIME_DEFAULT = "default";

/** 渠道徽章：latest / next 显示 dist-tag 指的版本，rc / alpha 换成版本下拉。 */
export const BADGE_CHANNELS: Channel[] = ["latest", "next"];

/**
 * 取某个渠道该给哪些版本：rc / alpha 由后端按后缀分好组，这里只做兜底排序后的原样展示。
 * 返回空数组表示「还没读到」（渠道本身合法，不是错误）。
 */
export function channelVersions(registry: RegistryInfo | null, channel: Channel): string[] {
  if (!registry) {
    return [];
  }
  return channel === "rc" ? registry.rc : channel === "alpha" ? registry.alpha : [];
}

/** 徽章里的版本号：latest / next 读 dist-tag；没读到就显示 —。 */
export function channelTagVersion(registry: RegistryInfo | null, channel: Channel): string | null {
  if (!registry || !BADGE_CHANNELS.includes(channel)) {
    return null;
  }
  return channel === "latest" ? registry.distTags.latest : registry.distTags.next;
}

/**
 * 官方 npx 命令的拼装（只用于界面上的实时预览；真正下发的命令由 Rust 侧 `build_spawn_plan` 拼）。
 * 保留 `--yes`：壳的子进程没有终端，npx 首次下载时的交互确认会直接把启动卡住。
 */
export function npxCommandOf(channel: Channel, version: string | null): string {
  const suffix = channel === "latest" ? "" : channel === "next" ? "@next" : version ? `@${version}` : "@<版本>";
  return `npx --yes @deepseek-ai/dsh${suffix} web --no-open`;
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
