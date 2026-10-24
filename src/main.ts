/* 应用入口：只剩 main() —— 装配初始 DOM、绑定全部事件、轮询后端状态。
   静态骨架见 ui/build-html.ts；图标、类型、工具、主题、转动状态机等模块在 ui/。 */
import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import "./style.css";
import { PANELS, ICON_MAXIMIZE, ICON_RESTORE, ICON_STOP, ICON_OPEN_APP, ICON_OPEN_BROWSER, ICON_MORE, ICON_COPY } from "./ui/icons";
import { prepareCopyButton, flashCopy, copyIconStack, copyTextChrome } from "./ui/copy-feedback";
import { isStarting } from "./ui/types";
import type { AppInfo, LaunchRuntime, LaunchConfig, RegistryInfo, DistroInfo, TrayClick, PanelKey, DownloadSource, ProxyMode, ShellPrefs, ShellConfig, PortHint, SessionStatus, BridgeState, ProfileSummary, ProfileListing, ProxyState, SelfCheckReport, BridgeOutcome, CliIntegrationState, InstalledDsh } from "./ui/types";
import { DEFAULT_PREFS, normalizePrefs } from "./ui/prefs";
import { DOWNLOAD_SOURCE_CHOICES, downloadSourceHint, PROXY_MODE_CHOICES, RUNTIME_DEFAULT, AUTO_VERSION, VERSION_AUTO_LABEL, VERSION_INITIAL_COUNT, VERSION_PAGE_SIZE, npxCommandOf, START_PROFILE, TOGGLE_TEXT_REST, TOGGLE_TEXT_STARTING, TOOLTIP_STOP, TOOLTIP_STARTING } from "./ui/config";
import { Picker } from "./ui/picker";
import type { PickerBadge, PickerChoice } from "./ui/picker";
import { THEME_KEY, readStoredTheme, applyMode } from "./ui/theme";
import type { ThemeId } from "./ui/theme";
import { readStoredMotion, saveStoredMotion, applyMotion } from "./ui/motion";
import type { MotionPref } from "./ui/motion";
import { escapeHtml, toggleSwapHtml } from "./ui/markup";
import { applyRestartSpin, beginRestartSpin, endRestartSpin, updateRestartSpin, setStatusRefresher } from "./ui/spin";
import { setSquareBusy, flashSquareDone } from "./ui/sqbusy";
import { showToast } from "./ui/toast";
import { attachScrollThumb } from "./ui/scroll-thumb";
import { buildHtml } from "./ui/build-html";

/** 通知微标的统一文案：超过 99 截成「99+」，防止多位数把圆形微标撑宽（形状见
 *  90-modals.css 的 .btn-badge 与 20-sidebar.css 的 .ico-count）。 */
function countBadgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** 把计数画进微标并按是否截断挂 .is-dense（缩一号字），0 画成空文案。 */
function paintCountBadge(el: HTMLElement, count: number): void {
  const capped = count > 99;
  el.textContent = count <= 0 ? "" : countBadgeText(count);
  el.classList.toggle("is-dense", capped);
}

async function main(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    return;
  }
  // 界面挂载、重建都要用它；写成非空类型，省得每个用到的地方再判一次空。
  const root: HTMLDivElement = app;

  let info: AppInfo = {
    name: "DSHarbor",
    version: "未知",
    core_version: "未知",
    repository: "未知",
    site_url: "未知",
    license: "未知",
    config_dir: "未知",
    logs_dir: "未知",
  };
  try {
    info = await invoke<AppInfo>("app_info");
  } catch (err) {
    // 在普通浏览器里打开页面时没有 Tauri 环境，保留占位信息即可。
    console.error("无法通过 Tauri 获取应用信息:", err);
  }

  let theme: ThemeId = readStoredTheme();
  // 全站动效偏好：与外观同族，存在 localStorage。关闭时 <html> 带 data-motion="off"，
  // 由 99-hidden.css 统一中和动画与过渡。
  let motion: MotionPref = readStoredMotion();
  // 六个新字段的当前值：后端读回来之后换成它。本版只做承载，没有界面控件改它，
  // 但保存链路上必须原样带上，否则界面上任何一次保存都会把用户已改的值抹回默认。
  let prefs: ShellPrefs = { ...DEFAULT_PREFS };
  // DOM 只在启动时生成一次：切浅色/深色只改 <html data-mode>，不重建界面。
  // 挂在 window / document 上的监听（窗口缩放、托盘轮询、自绘滚动条）也只注册一次，
  // 通过下面三个钩子指到当前这套界面。
  let updateScrollThumbHook: () => void = () => {};
  /** mount() 里挂的内层自绘胶囊（日志正文、dsh 垫片）的刷新钩子，随分区切换一起调。 */
  let refreshInnerScrollThumbsHook: () => void = () => {};
  let syncMaximizeIconHook: () => void = () => {};
  let refreshNowHook: () => Promise<void> = async () => {};

  /** 生成界面与全部绑定。只在启动时跑一次：切浅色/深色只改 <html data-mode>，不重建 DOM。 */
  async function mount(): Promise<void> {
    applyMode(theme);
    // 动效偏好与外观一样只改 <html>，不重建界面。index.html 的内联脚本已在首帧贴过
    // 一次，这里再贴一次是给「首帧之后才跑到的代码路径」兜底（幂等）。
    applyMotion(motion);
    root.innerHTML = buildHtml(info);

    const $ = <T extends HTMLElement>(id: string): T => {
      const el = root.querySelector<T>(`#${id}`);
      if (!el) {
        throw new Error(`缺少元素 #${id}`);
      }
      return el;
    };

    const versionText = $<HTMLElement>("version-text");
    const pidEl = $<HTMLElement>("status-pid");
    const portEl = $<HTMLElement>("status-port");
    const errorEl = $<HTMLParagraphElement>("status-error");
    const logEl = $<HTMLPreElement>("log");
    const btnToggle = $<HTMLButtonElement>("btn-toggle");
    const btnRestart = $<HTMLButtonElement>("btn-restart");
    const extraInput = $<HTMLInputElement>("extra-args");
    const binaryPath = $<HTMLInputElement>("binary-path");
    const binaryBrowse = $<HTMLButtonElement>("binary-browse");
    const binaryError = $<HTMLParagraphElement>("binary-error");
    const customCommand = $<HTMLInputElement>("custom-command");
    const npxCommandPreview = $<HTMLElement>("npx-command-preview");
    const npxVersionsHint = $<HTMLDivElement>("npx-versions-hint");
    const npxInstalledHint = $<HTMLDivElement>("npx-installed-hint");
    const npxVersionsRefresh = $<HTMLButtonElement>("npx-versions-refresh");
    const portInput = $<HTMLInputElement>("port");
    const portReset = $<HTMLButtonElement>("port-reset");
    const portInfoEl = $<HTMLSpanElement>("port-info");
    const loginBadge = $<HTMLSpanElement>("login-badge");
    const loginText = $<HTMLElement>("login-text");
    const loginInfo = $<HTMLElement>("login-info");
    const loginNote = $<HTMLParagraphElement>("login-note");
    const btnClearLog = $<HTMLButtonElement>("btn-clear-log");
    // 打开方式：主按钮 + 右侧小三角的两段式（选完回填，再点主按钮才执行）。
    const btnOpen = $<HTMLButtonElement>("btn-open");
    const btnOpenMore = $<HTMLButtonElement>("btn-open-more");
    const openMenu = $<HTMLElement>("open-menu");
    const openIco = $<HTMLElement>("open-ico");
    const openText = $<HTMLElement>("open-text");
    const linkSite = $<HTMLButtonElement>("link-site");
    const linkRepo = $<HTMLButtonElement>("link-repo");
    const trayPicker = new Picker("tray-picker", () => void persistConfigQuiet());
    trayPicker.setChoices([
      { value: "launcher", label: "启动界面（默认）" },
      { value: "dsh", label: "应用内窗口" },
    ]);
    const lightDelayPicker = new Picker("light-delay-picker", () => void persistConfigQuiet());
    /** 「关闭窗口后释放界面内存」的延迟候选，value 为秒数的十进制字符串。 */
    const LIGHT_DELAY_CHOICES: PickerChoice[] = [
      { value: "0", label: "立即" },
      { value: "5", label: "5 秒" },
      { value: "15", label: "15 秒" },
      { value: "30", label: "30 秒" },
      { value: "60", label: "1 分钟" },
      { value: "300", label: "5 分钟" },
    ];
    lightDelayPicker.setChoices(LIGHT_DELAY_CHOICES);
    // 运行环境是壳级选择：官方 npx 命令与自定义命令共用同一份值，两个下拉框互相同步。
    let runtime: LaunchRuntime = { kind: "default" };
    /** null = 还没读到；读取失败时也是 null，靠 distrosError 区分「加载中」与「失败」。 */
    let distroInfos: DistroInfo[] | null = null;
    let distrosError: string | null = null;
    /** 官方版本列表：按运行环境分别读；Rust 侧有 10 分钟缓存，这里不再叠一层。 */
    let registry: RegistryInfo | null = null;
    let registryError: string | null = null;
    let registryLoading = false;
    /**
     * 当前选中的版本号；null = 首项「自动最新版本」（不写死版本号）。
     *
     * 它是唯一真源，不是从下拉框的 DOM 值反推：换运行环境、刷新列表、读取失败降级
     * 都会重铺候选，从 DOM 反推的话这几种情况都会把用户选好的版本悄悄退回首项。
     */
    let selectedVersion: string | null = null;
    /** 本机 npx 缓存里已有的版本；每次展开版本下拉现扫一次。 */
    let cachedVersions: string[] = [];
    /** 其中钉版本写法（`dsh@<版本>`）启动能直接复用的部分（`npx_cached_versions.pinServed`）。 */
    let pinServedVersions: string[] = [];
    /** 版本下拉当前放出几个具体版本（不含首项与末尾的「更多…」）。 */
    let versionShown = VERSION_INITIAL_COUNT;

    const runtimeValue = (value: LaunchRuntime): string =>
      value.kind === "wsl" ? `wsl:${value.distro}` : RUNTIME_DEFAULT;

    const runtimeOf = (value: string): LaunchRuntime =>
      value.startsWith("wsl:") ? { kind: "wsl", distro: value.slice(4) } : { kind: "default" };

    /** 发行版列表就绪前先占位的禁用项（value 为空，选不到）。 */
    function runtimeChoices(): PickerChoice[] {
      const choices: PickerChoice[] = [{ value: RUNTIME_DEFAULT, label: "默认" }];
      if (distroInfos === null) {
        choices.push({
          value: "",
          label: distrosError === null ? "（正在读取发行版列表…）" : "（读取发行版列表失败）",
          disabled: true,
        });
        return choices;
      }
      for (const info of distroInfos) {
        // 装了 WSL 但没有 node/npm 的发行版仍然可选，只在文字上标一下，让用户自己决定。
        choices.push({
          value: `wsl:${info.distro}`,
          label: info.hasNode ? `WSL - ${info.distro}` : `WSL - ${info.distro}（未检测到 Node.js）`,
        });
      }
      if (distroInfos.length === 0) {
        choices.push({ value: "", label: "（未检测到 WSL 发行版）", disabled: true });
      }
      // 存过但发行版已经没了：仍列出来（让用户看见存的是什么），改选「默认」就清掉。
      if (runtime.kind === "wsl") {
        const saved = runtime.distro;
        if (!distroInfos.some((info) => info.distro === saved)) {
          choices.push({ value: `wsl:${saved}`, label: `WSL - ${saved}（发行版已不存在）` });
        }
      }
      return choices;
    }

    function syncRuntimePickers(): void {
      const choices = runtimeChoices();
      const value = runtimeValue(runtime);
      for (const picker of [npxRuntimePicker, customRuntimePicker]) {
        picker.setChoices(choices);
        picker.setValue(value);
      }
    }

    function onRuntimeChange(value: string): void {
      runtime = runtimeOf(value);
      syncRuntimePickers();
      void persistConfigQuiet();
      void refreshPortHint();
      void refreshBridgeState();
      // 先清掉上一个环境的清单，否则换发行版后到新清单回来之前，版本下拉里
      // 还挂着另一个环境（另一个 npm registry 视图）的版本号与「已缓存」标记。
      // selectedVersion 不跟着清：用户选的版本号仍然适用，新列表回来后照旧选中它。
      registry = null;
      registryError = null;
      cachedVersions = [];
      void loadRegistry();
    }

    const npxRuntimePicker = new Picker("npx-runtime-picker", onRuntimeChange);
    npxRuntimePicker.setChoices([{ value: RUNTIME_DEFAULT, label: "默认" }]);
    const customRuntimePicker = new Picker("custom-runtime-picker", onRuntimeChange);
    customRuntimePicker.setChoices([{ value: RUNTIME_DEFAULT, label: "默认" }]);

    /** 当前选定的具体版本；null = 首项「自动最新版本」（不写死版本号）。 */
    const currentVersion = (): string | null => selectedVersion;

    /** npm 的 latest 标签当前指向的版本；还没读到列表时为 null。 */
    const latestVersion = (): string | null => registry?.distTags.latest ?? null;

    /**
     * 全部 dist-tag（标签名 → 版本号）。老缓存 / 命令返回里没有 `tags` 字段时给空对象：
     * 界面据此一律不挂 tag 徽章，而不是把徽章显示成一串猜出来的名字。
     */
    const distTags = (): Record<string, string> => registry?.distTags.tags ?? {};

    /** tag 名超过这个字符数就截断显示，全名留给悬停气泡（自定义 tag 名长度不可控）。 */
    const TAG_NAME_MAX = 10;

    /** 有固定排位的 tag：其余 tag 按字母序跟在后面。 */
    const TAG_ORDER: readonly string[] = ["latest", "next"];

    /** tag 名 → 徽章配色（与 `.picker-badge-*` 的类名后缀一一对应）。 */
    const TAG_TONES: Record<string, PickerBadge["tone"] | undefined> = {
      latest: "latest",
      next: "next",
      beta: "beta",
      alpha: "alpha",
      canary: "canary",
    };

    /** tag 徽章最多挂几枚，超出的折成一枚「+N」；「已缓存」「手动」不占这个名额。 */
    const TAG_BADGE_MAX = 3;

    /** 某个版本上挂的 tag 名：latest → next → 其余按字母序。 */
    function tagsOf(version: string): string[] {
      const tags = distTags();
      const names = Object.keys(tags).filter((tag) => tags[tag] === version);
      const rest = names.filter((tag) => !TAG_ORDER.includes(tag)).sort();
      return TAG_ORDER.filter((tag) => names.includes(tag)).concat(rest);
    }

    /**
     * 一枚 tag 徽章：长名字截断，气泡里补一枚写全名的徽章（行内那枚已经写全的就不再挂气泡——
     * 一样的东西再弹一遍没有信息量）。
     */
    function tagBadge(tag: string): PickerBadge {
      const truncated = tag.length > TAG_NAME_MAX;
      const text = truncated ? `${tag.slice(0, TAG_NAME_MAX)}…` : tag;
      const tone = TAG_TONES[tag] ?? "other";
      return truncated ? { text, tone, tip: [{ text: tag, tone }] } : { text, tone };
    }

    /** 版本行的 tag 徽章：最多 3 枚，其余折成「+N」，悬停把被折叠的 tag 一枚枚摆出来。 */
    function tagBadges(version: string): PickerBadge[] {
      const names = tagsOf(version);
      const badges = names.slice(0, TAG_BADGE_MAX).map(tagBadge);
      const folded = names.slice(TAG_BADGE_MAX);
      if (folded.length > 0) {
        badges.push({
          text: `+${folded.length}`,
          tone: "other",
          tip: folded.map((tag) => ({ text: tag, tone: TAG_TONES[tag] ?? "other" })),
        });
      }
      return badges;
    }

    /**
     * 版本行尾的徽章。顺序固定（tag → 已缓存），同一行反复渲染长得一样。
     * tag 徽章排在前面、且「已缓存」不占 tag 的 3 枚名额，所以收起态只显第一枚时
     * 自然先显 tag，没有 tag 才轮到「已缓存」（「手动」那一行本来就只挂一枚）。
     * 「已缓存」只按本机 npx 缓存里有没有这一版来判（`cachedVersions`），与「当前选中哪一行」无关：
     * 选中只是下拉里的一个值，不代表这一版已经装在本机，所以不能再拿 `selectedVersion` 当「已装」。
     * 选中的那一行靠行首的 ✓ 认，不需要额外的「已装」徽章（与「已缓存」也是同一件事）。
     */
    function versionBadges(version: string): PickerBadge[] {
      const badges = tagBadges(version);
      if (cachedVersions.includes(version)) {
        badges.push({ text: "已缓存", tone: "cached" });
      }
      return badges;
    }

    /**
     * 「自动最新版本」一行的徽章：tag 名与版本号合成一枚（`latest 0.2.1-rc.2`），
     * 让人一眼看到「自动」这次用的是哪个标签、指向哪个版本。
     * 它不是一个具体版本，所以不挂「已缓存」（缓存里存的是确切版本号）。
     * `distTags.latest` 与 `tags.latest` 对不上（老缓存只有前者）时宁可不挂：
     * 这时拼出来的名字是猜的，挂在「自动」这一行上会误导人。
     */
    function autoBadges(): PickerBadge[] {
      const latest = latestVersion();
      if (latest === null || distTags().latest !== latest) {
        return [];
      }
      // 标签名与版本号都写在徽章上了，没有「看不全」的部分，所以不挂气泡。
      return [{ text: `latest ${latest}`, tone: "latest" }];
    }

    /** 版本候选：首项「自动最新版本」+ 具体版本（先 6 个）+ 末尾「更多…」。 */
    function versionChoices(): PickerChoice[] {
      const choices: PickerChoice[] = [
        {
          value: AUTO_VERSION,
          label: VERSION_AUTO_LABEL,
          // 首项挂的是「latest 标签当前指向哪个版本号」——让人看见「自动」这次会用哪个；
          // 它不是一个具体版本，所以不挂「已缓存」（缓存里存的是确切版本号）。
          badges: autoBadges(),
        },
      ];
      const versions = registry?.versions ?? [];
      if (versions.length === 0) {
        choices.push({
          value: "(pending)",
          label: registryLoading ? "（正在读取版本列表…）" : "（没读到官方版本列表）",
          disabled: true,
        });
        return choices;
      }
      // 选过 / 存过但官方已经下架的版本仍然列出来，否则一重开壳就把这个选择悄悄改掉。
      if (selectedVersion !== null && !versions.includes(selectedVersion)) {
        choices.push({
          value: selectedVersion,
          label: selectedVersion,
          badges: [{ text: "手动", tone: "manual" }],
        });
      }
      for (const version of versions.slice(0, versionShown)) {
        choices.push({ value: version, label: version, badges: versionBadges(version) });
      }
      const rest = versions.length - versionShown;
      if (rest > 0) {
        choices.push({
          value: "(more)",
          label: `更多…（还剩 ${rest} 个）`,
          // 动作行：点一下只在弹层里再加 10 个，不改变选中值、也不收起弹层
          //（收起就得重新展开一遍才能接着点）。
          action: () => {
            versionShown += VERSION_PAGE_SIZE;
            renderVersionUI();
            npxVersionPicker.relayout();
          },
        });
      }
      return choices;
    }

    function registryHint(): string {
      if (registryLoading) {
        return "正在读取官方版本列表…";
      }
      if (registryError !== null) {
        if (runtime.kind === "wsl") {
          const distro = runtime.distro;
          const info = distroInfos?.find((item) => item.distro === distro);
          if (info && !info.hasNode) {
            return `${distro} 里没有 node/npm，读不到版本列表；要先在该发行版里装 Node.js。「自动最新版本」同理也需要。`;
          }
        }
        return "读不到官方版本列表（npm view 失败或断网）；「自动最新版本」仍可直接启动，也可以点右边的刷新按钮重试。";
      }
      if ((registry?.versions.length ?? 0) === 0) {
        return "官方还没有发布过任何版本。";
      }
      return "";
    }

    /**
     * 选中版本「本机已经装过」的提示。按实际版本号判等（不看 latest 标签），
     * 只提示不禁用——用户仍可照常启动。两种口径都说实话：
     * 缓存里那份就是钉版本写法（`dsh@<版本>`）留下的，选它启动直接复用；
     * 否则（裸包名写法留下的）按 npx「每种写法各存一份缓存」的规则，选了还会再下一份。
     */
    function installedHint(): string {
      if (selectedVersion === null) {
        return "";
      }
      if (!cachedVersions.includes(selectedVersion)) {
        return "";
      }
      if (pinServedVersions.includes(selectedVersion)) {
        return `v${selectedVersion} 本机已经装过（缓存里就是 dsh@${selectedVersion} 写法的那份），选它启动不会再下载一份。`;
      }
      return `v${selectedVersion} 本机 npx 缓存里已有这一份，但选它启动会再下载一份——npx 按命令写法各存一份缓存，缓存里那份是裸包名写法（不带 @版本）留下的。`;
    }

    /**
     * 动态提示胶囊统一入口：正文在 CSS 里限成一行（.hint.notice），全文挂 data-tip
     * 走悬停气泡。文字为空时连同 data-tip 一起清掉，免得留一颗空气泡。
     */
    function setNoticeHint(el: HTMLElement, text: string): void {
      el.textContent = text;
      if (text === "") {
        delete el.dataset.tip;
        el.classList.add("hidden");
        return;
      }
      el.dataset.tip = text;
      el.classList.remove("hidden");
    }

    /** 版本下拉、命令预览、提示行与刷新按钮的状态一处刷齐。 */
    function renderVersionUI(): void {
      npxVersionPicker.setChoices(versionChoices());
      npxVersionPicker.setValue(selectedVersion ?? AUTO_VERSION);
      npxCommandPreview.textContent = npxCommandOf(selectedVersion);
      const hint = registryHint();
      setNoticeHint(npxVersionsHint, hint);
      npxVersionsHint.classList.toggle("notice", registryError !== null && !registryLoading);
      const installed = installedHint();
      setNoticeHint(npxInstalledHint, installed);
      // 读列表期间刷新按钮转圈并禁用：连点会让每次强制查询都真发一次 npm view。
      // 转的是叠加的环形 spinner，不是语义图标本身（见 src/ui/sqbusy.ts）。
      npxVersionsRefresh.disabled = registryLoading;
      setSquareBusy(npxVersionsRefresh, registryLoading);
    }

    /** 现扫一次本机 npx 缓存里已有的版本，好把「已缓存」徽章挂到正确的行上。 */
    async function refreshCachedVersions(): Promise<void> {
      try {
        const cached = await invoke<{ versions: string[]; pinServed: string[] }>(
          "npx_cached_versions",
          { runtime },
        );
        cachedVersions = cached.versions;
        pinServedVersions = cached.pinServed;
      } catch (err) {
        // 缓存目录读不到只影响那枚徽章，不影响选版本；不打扰用户，日志里留痕。
        console.error("读取 npx 缓存版本失败:", err);
        cachedVersions = [];
        pinServedVersions = [];
      }
      // 徽章是在 versionChoices() 里算的，扫回来必须重铺一遍候选；只调 relayout() 不会重算徽章。
      // 「本机已装过」的提示也依赖 cachedVersions，一并重刷。
      renderVersionUI();
      npxVersionPicker.relayout();
    }

    async function loadDistros(): Promise<void> {
      try {
        distroInfos = await invoke<DistroInfo[]>("wsl_distro_info");
        distrosError = null;
      } catch (err) {
        distroInfos = null;
        distrosError = String(err);
        console.error("读取 WSL 发行版失败:", err);
      }
      syncRuntimePickers();
    }

    /** 读官方版本列表；`force` 为真时让后端绕过 10 分钟缓存，真跑一次 npm view。 */
    async function loadRegistry(force = false): Promise<void> {
      registryLoading = true;
      registryError = null;
      renderVersionUI();
      let ok = false;
      try {
        registry = await invoke<RegistryInfo>("query_dsh_versions", {
          runtime,
          source: prefs.downloadSource,
          force,
        });
        ok = true;
      } catch (err) {
        registry = null;
        registryError = String(err);
        console.error("读取官方版本列表失败:", err);
      } finally {
        registryLoading = false;
      }
      // 换了一批候选，分页从头算：上一次展开过「更多…」不该让新列表一上来就全摊开。
      versionShown = VERSION_INITIAL_COUNT;
      renderVersionUI();
      // 只有用户主动点的「重新获取」才落勾：启动/切环境的后台加载不闪一次反馈。
      if (force && ok) {
        flashSquareDone(npxVersionsRefresh);
      }
    }

    const npxVersionPicker = new Picker("npx-version-picker", (value) => {
      selectedVersion = value === AUTO_VERSION ? null : value;
      renderVersionUI();
      void persistConfigQuiet();
      void syncCliShim();
    });
    // 缓存在 npx 那边随时会变（每次启动都可能新增一份），所以每次展开都现扫一次，
    // 而不是进面板时扫一次然后长期沿用。
    npxVersionPicker.onOpen = () => void refreshCachedVersions();
    npxVersionPicker.setChoices([]);
    // 手动刷新：强制绕过后端缓存，结果回来前按钮转圈、下拉框里显示「正在读取…」。
    npxVersionsRefresh.addEventListener("click", () => {
      versionShown = VERSION_INITIAL_COUNT;
      void loadRegistry(true);
    });
    // 左栏底部那颗浅/深切换：图标画的是「点下去会变成什么」，切换只改 <html data-mode>，
    // 界面不重建，正在填的字段与滚动位置都保住。
    const modeBtn = $<HTMLButtonElement>("mode-btn");
    // 图标交接只由 html[data-mode] 驱动（见 20-sidebar.css 的 .theme-morph）：两颗图标
    // 常驻 DOM，谁在场、谁转走全交给 CSS，JS 不再换 innerHTML，所以过渡能完整跑完、
    // 连点也只会重算到目标终态。这里只同步无障碍标签。
    const renderModeButton = (): void => {
      const dark = theme === "dark";
      const label = dark ? "切换到浅色模式" : "切换到深色模式";
      modeBtn.title = label;
      modeBtn.setAttribute("aria-label", label);
    };
    modeBtn.addEventListener("click", () => {
      theme = theme === "dark" ? "light" : "dark";
      applyMode(theme);
      renderModeButton();
      try {
        window.localStorage.setItem(THEME_KEY, theme);
      } catch {
        // 隐私模式等场景下存不下：本次切换仍生效，只是下次启动回到默认。
      }
      syncThemeToShell(theme);
    });
    renderModeButton();
    // 「动效」总开关：与外观同一套做法——只改 <html data-motion>，不重建界面，
    // 正在填的字段与滚动位置都保住。关掉后由 99-hidden.css 统一把动画与过渡中和，
    // 转圈这类无限动画改为静止（图标仍在，不会出现「看不出在忙」）。
    const motionToggle = $<HTMLButtonElement>("motion-toggle");
    const renderMotionToggle = (): void => {
      motionToggle.setAttribute("aria-checked", motion === "off" ? "false" : "true");
    };
    motionToggle.addEventListener("click", () => {
      motion = motion === "off" ? "on" : "off";
      applyMotion(motion);
      saveStoredMotion(motion);
      renderMotionToggle();
    });
    renderMotionToggle();
    // 下载源：「网络」卡的第一个控件。改完立刻生效于版本清单查询（选「官方源」
    // 就真的去官方地址拉），不必重启壳。
    /** 「网络与代理」卡的平台标记。卡头不再挂摘要徽章（各块一律只有标题）。*/
    const networkWindowsOnly = $<HTMLElement>("network-windows-only");
    const networkContent = $<HTMLElement>("network-content");
    /** 这台宿主能不能真正生效（后端给的平台标记）；还没读到代理状态时先按 true 留着。 */
    let networkSupported = true;
    const downloadSourceHintEl = $<HTMLParagraphElement>("download-source-hint");
    const proxyHintEl = $<HTMLParagraphElement>("proxy-hint");
    const proxyManualRow = $<HTMLElement>("proxy-manual");
    const proxyAddressInput = $<HTMLInputElement>("proxy-address");
    /** 后端算好的代理状态（地址、例外列表与那一行说明）；还没读到时为 null。 */
    let proxyState: ProxyState | null = null;
    /** 上一次提交地址时被后端拒绝的理由；成功存盘或切模式后清掉。 */
    let proxySaveError: string | null = null;

    /** 平台标记只决定「整卡还是只留一句」——单独拿出来，免得刷新代理状态时把自检结果也抹掉。 */
    function renderNetworkSupport(): void {
      networkWindowsOnly.classList.toggle("hidden", networkSupported);
      networkContent.classList.toggle("hidden", !networkSupported);
    }

    function renderNetworkUI(): void {
      // 非 Windows 宿主：整卡换成一句说明（跟环境卡用同一个写法：平台标记由后端给，
      // 界面只负责 toggle）——不能让人在能点但不能生效的控件上白调。
      renderNetworkSupport();
      if (!networkSupported) {
        return;
      }
      downloadSourceHintEl.textContent = downloadSourceHint(prefs.downloadSource);
      // 地址输入框只在手动模式才露出来；另外两种模式那个值不参与计算，露出来只会让人以为要填。
      proxyManualRow.classList.toggle("hidden", prefs.proxyMode !== "manual");
      proxySaveError = null;
      renderProxyHint();
      // 源或代理变了，上一次自检的结论就不适用了：清掉，别让人拿旧结论判断新配置。
      // 只有这条路径会清它：每秒的状态刷新走的不是 renderNetworkUI，
      // 所以用户刚看到的结果不会被自动刷新抹掉。
      selfCheckReport = null;
      renderSelfCheck();
    }

    /** 提示行：手动模式填错了就把那句校验文案当错误显示，其它情形都是普通说明。 */
    function renderProxyHint(): void {
      const state = proxyState;
      if (proxySaveError !== null) {
        // 存盘被后端拦下：这是比「地址算不出来」更要紧的事实——整份配置根本没落地，
        // 界面上的值只在这次会话里，重开就回到旧值。必须说出来，不能只 console.debug。
        proxyHintEl.textContent = proxySaveError;
        proxyHintEl.classList.add("error", "field-error");
        return;
      }
      if (state === null) {
        proxyHintEl.textContent = "正在读取系统代理设置…";
        proxyHintEl.classList.remove("error", "field-error");
        return;
      }
      // 手动模式里填了地址却没生效（socks、格式错、缺主机）：那行说明就是错在哪里。
      const isError =
        prefs.proxyMode === "manual" && state.url === null && prefs.proxyAddress.trim() !== "";
      proxyHintEl.textContent = state.hint;
      proxyHintEl.classList.toggle("error", isError);
      proxyHintEl.classList.toggle("field-error", isError);
    }

    const downloadSourcePicker = new Picker("download-source-picker", (value) => {
      const next = normalizePrefs({ downloadSource: value as DownloadSource }).downloadSource;
      if (next === prefs.downloadSource) {
        return;
      }
      prefs = { ...prefs, downloadSource: next };
      renderNetworkUI();
      // 先存盘（壳在保存时作废版本清单缓存），再重新查一次：旧清单里的版本号
      // 是从另一个 registry 拉到的，留着会让人以为切换没生效。
      void (async () => {
        await persistConfigQuiet();
        registry = null;
        registryError = null;
        await loadRegistry();
      })();
    });
    downloadSourcePicker.setChoices(DOWNLOAD_SOURCE_CHOICES);
    downloadSourcePicker.setValue(prefs.downloadSource);

    /** 代理状态由后端算（核心库负责地址归一化与文案）；读不到就退成一句说明。 */
    async function refreshProxyState(): Promise<void> {
      try {
        proxyState = await invoke<ProxyState>("proxy_state");
        networkSupported = proxyState?.supported !== false;
      } catch (err) {
        proxyState = { supported: true, url: null, bypass: [], hint: `读取代理设置失败：${err}`, stateText: "" };
      }
      renderNetworkSupport();
      renderProxyHint();
    }

    const proxyModePicker = new Picker("proxy-mode-picker", (value) => {
      const next = normalizePrefs({ proxyMode: value as ProxyMode }).proxyMode;
      if (next === prefs.proxyMode) {
        return;
      }
      prefs = { ...prefs, proxyMode: next };
      renderNetworkUI();
      // 切模式不必重查版本：地址变了要等下一次启动才生效，这里只把存盘与提示跟上。
      void (async () => {
        await persistConfigQuiet();
        await refreshProxyState();
      })();
    });
    proxyModePicker.setChoices(PROXY_MODE_CHOICES);
    proxyModePicker.setValue(prefs.proxyMode);

    /** 提交地址：只在失焦与回车时调，不跟着每次敲键存盘。 */
    function commitProxyAddress(): void {
      const next = proxyAddressInput.value.trim();
      if (next === prefs.proxyAddress) {
        return;
      }
      prefs = { ...prefs, proxyAddress: next };
      void (async () => {
        // 这条路径单独看存盘结果：地址填错时后端会拒收整份配置，
        // 不报出来的话输入框里留着「看起来已经生效」的地址，重开才回到旧值。
        const err = await persistConfigQuiet();
        proxySaveError = err;
        renderProxyHint();
        await refreshProxyState();
      })();
    }

    proxyAddressInput.addEventListener("blur", commitProxyAddress);
    proxyAddressInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitProxyAddress();
        proxyAddressInput.blur();
      }
    });

    // 自检（「测试连接」）：结果只属于「点下的这一次」。存在这里的变量里，
    // 不放进 prefs、也不跟着每秒的状态刷新重算——自动刷新把用户刚看到的结果
    // 抹掉是本卡最容易被投诉的毛病。只有改了下载源才清空（那时的结论已经不适用了）。
    const btnSelfCheck = $<HTMLButtonElement>("btn-self-check");
    const selfCheckStatus = $<HTMLParagraphElement>("self-check-status");
    const selfCheckDetail = $<HTMLParagraphElement>("self-check-detail");
    let selfCheckReport: SelfCheckReport | null = null;
    /** 正在进行中的请求：非 null 时按钮禁用，连点也不会发第二次。 */
    let selfCheckRunning = false;

    /** 结果行的文案：三态各一句，通了要说清是走代理通的还是直连通的。 */
    function selfCheckLine(report: SelfCheckReport): string {
      const source = report.registry ?? "npm 全局配置里的源";
      // 当前代理状态由后端一句话给出（与上方 hint 同一套口径），这里只负责拼上去。
      const proxyNow = proxyState?.stateText ? ` ${proxyState.stateText}。` : "";
      switch (report.state) {
        case "proxyOk":
          return report.via === "proxy" && report.proxy
            ? `通了：经代理 ${report.proxy} 访问 ${source} 成功，下载会走这条路。`
            : `通了：直连 ${source} 成功（这次没走代理），下载会走这条路。`;
        case "directOnly":
          return `只有直连能通：去掉代理后访问 ${source} 成功了。真实下载仍然会带代理，所以很可能下不动——建议检查代理设置，或者选「不走代理」。${proxyNow}`;
        default:
          return `两种都不通：带代理和不带代理都没拿到 ${source} 的数据。先看下面的原因，再检查代理设置或换一个下载源。${proxyNow}`;
      }
    }

    function renderSelfCheck(): void {
      const report = selfCheckReport;
      btnSelfCheck.disabled = selfCheckRunning;
      btnSelfCheck.textContent = selfCheckRunning ? "测试中…" : "测试连接";
      if (selfCheckRunning) {
        selfCheckStatus.textContent = "正在测试…（最多要等十几秒）";
        selfCheckStatus.classList.remove("error");
        selfCheckDetail.classList.add("hidden");
        selfCheckDetail.textContent = "";
        return;
      }
      if (report === null) {
        selfCheckStatus.textContent = "用当前下载源与代理设置跑一次真实请求，确认到底通不通。";
        selfCheckStatus.classList.remove("error");
        selfCheckDetail.classList.add("hidden");
        selfCheckDetail.textContent = "";
        return;
      }
      selfCheckStatus.textContent = selfCheckLine(report);
      selfCheckStatus.classList.toggle("error", report.state !== "proxyOk");
      // 失败原因单独一行：它是「一句中文 + 一行原文」，跟上面那句混在一起太长。
      const failure = report.failure;
      selfCheckDetail.classList.toggle("hidden", failure === null);
      selfCheckDetail.textContent = failure ?? "";
    }

    async function runSelfCheck(): Promise<void> {
      // 已有一个在跑：什么也不做（按钮本来就禁用着，这里再拒一次防竞态）。
      if (selfCheckRunning) {
        return;
      }
      selfCheckRunning = true;
      renderSelfCheck();
      try {
        selfCheckReport = await invoke<SelfCheckReport>("self_check_network", {
          runtime,
          source: prefs.downloadSource,
        });
      } catch (err) {
        // 命令本身没跑起来（IPC 出错）：当作「都不通」上报，同样带一句原因。
        selfCheckReport = {
          state: "bothFail",
          via: "direct",
          registry: null,
          proxy: null,
          failure: `自检没能执行：${err}`,
        };
      } finally {
        selfCheckRunning = false;
        renderSelfCheck();
      }
    }

    btnSelfCheck.addEventListener("click", () => void runSelfCheck());

    renderNetworkUI();
    const btnCopyLog = $<HTMLButtonElement>("btn-copy-log");
    const bridgeTarget = $<HTMLElement>("bridge-target");
    const bridgeStatus = $<HTMLElement>("bridge-status");
    const bridgeBackup = $<HTMLElement>("bridge-backup");
    const bridgeError = $<HTMLParagraphElement>("bridge-error");
    const bridgeNote = $<HTMLParagraphElement>("bridge-note");
    const btnBridgeInstall = $<HTMLButtonElement>("btn-bridge-install");
    const btnBridgeUninstall = $<HTMLButtonElement>("btn-bridge-uninstall");
    const btnBridgeRestore = $<HTMLButtonElement>("btn-bridge-restore");
    const btnBridgeBackups = $<HTMLButtonElement>("btn-bridge-backups");
    const aboutDsh = $<HTMLElement>("about-dsh");
    const aboutNote = $<HTMLParagraphElement>("about-note");
    // 浮在窗口右上角的三颗窗口按钮。窗口一律无边框，这里理论上必然存在；
    // 仍用可空取法，是因为这段代码在普通浏览器预览里也要能跑通。
    const btnWinMin = root.querySelector<HTMLButtonElement>("#win-min");
    const btnWinMax = root.querySelector<HTMLButtonElement>("#win-max");
    const btnWinClose = root.querySelector<HTMLButtonElement>("#win-close");
    const btnAboutConfig = $<HTMLButtonElement>("btn-about-config");
    const btnAboutLogs = $<HTMLButtonElement>("btn-about-logs");

    // ---- 集成面板：命令行集成（PATH 与 dsh 垫片） ------------------------------
    // 展示内容全部由后端算好（目录、垫片内容、手动命令、状态说明），界面只负责渲染，
    // 免得两边各算一套口径对不上。
    const cliSummary = $<HTMLSpanElement>("integrations-summary");
    const cliToggle = $<HTMLButtonElement>("cli-toggle");
    const cliBinDir = $<HTMLElement>("cli-bin-dir");
    const cliShimPath = $<HTMLElement>("cli-shim-path");
    const cliManual = $<HTMLElement>("cli-manual");
    const cliShimText = $<HTMLPreElement>("cli-shim-text");
    // 日志正文与 dsh 垫片同样藏了原生滚动条、改用自绘胶囊（工具见 scroll-thumb.ts）：
    // 前者轨道挂 .content-main（与主卡轨道同一挂点），后者挂 .log-area（定位壳）。
    // 垫片在折叠块里，details 开合改变几何，toggle 时刷新一次。
    // 挂点必须是「本分区」的 .content-main（每张分区各有一个），不能拿全文档第一个。
    const contentMain = logEl.closest<HTMLElement>(".content-main");
    const logThumb = contentMain
      ? attachScrollThumb({ getScroller: () => logEl, getHolder: () => contentMain, inset: () => 10 })
      : null;
    const shimArea = cliShimText.closest<HTMLElement>(".log-area");
    const shimThumb = shimArea
      ? attachScrollThumb({ getScroller: () => cliShimText, getHolder: () => shimArea, inset: () => 6 })
      : null;
    cliShimText.closest("details")?.addEventListener("toggle", () => shimThumb?.update());
    refreshInnerScrollThumbsHook = () => {
      logThumb?.update();
      shimThumb?.update();
    };
    const cliMessage = $<HTMLParagraphElement>("cli-message");
    const cliError = $<HTMLParagraphElement>("cli-error");
    const btnCliDir = $<HTMLButtonElement>("btn-cli-dir");
    const btnCliCopy = $<HTMLButtonElement>("btn-cli-copy");
    const btnCliCopyShim = $<HTMLButtonElement>("btn-cli-copy-shim");
    // 「自动接入」那两半截（开关 + 目录、垫片内容）只在 Windows 下有意义。
    const cliWindowsOnly = Array.from(root.querySelectorAll<HTMLElement>(".cli-windows-only"));

    // ---- 集成面板：DSH 版本 ------------------------------------------------------
    // 「本机装了哪几份 dsh」由后端扫出来（npx 缓存 + npm 全局），界面只渲染列表与卸载按钮。
    const dshVersionsList = $<HTMLDivElement>("dsh-versions-list");
    const dshVersionsError = $<HTMLParagraphElement>("dsh-versions-error");
    const dshVersionsDup = $<HTMLSpanElement>("dsh-versions-dup");

    // 分区导航：点左侧图标切右侧面板。选择记在 localStorage，壳重启、轻量模式重建窗口后沿用。
    // 不放 config.json：那是整份回写的设置文件，界面偏好丢了不影响功能。
    const PANEL_KEY = "dsharbor.ui.panel";
    const navButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-panel-btn]"));
    const panelSections = Array.from(root.querySelectorAll<HTMLElement>("[data-panel]"));
    // 左栏那块跟着选中项滑的底（#36）：位置由按钮序号算，序号写在 --i 上（见 20-sidebar.css）。
    const railEl = navButtons[0]?.closest<HTMLElement>(".rail") ?? null;
    const railIndicator = railEl?.querySelector<HTMLElement>(".rail-ind") ?? null;
    /** 内容区整体滚动（工具栏与左栏固定），滚动指示条挂在它的外层。 */

    function readStoredPanel(): PanelKey {
      try {
        const saved = window.localStorage.getItem(PANEL_KEY);
        if (PANELS.some((item) => item.key === saved)) {
          return saved as PanelKey;
        }
      } catch {
        // 存储被禁用：用默认分区。
      }
      return "launch";
    }

    let currentPanel: PanelKey = readStoredPanel();

    /** 读一个动效时长令牌（毫秒）。浏览器把计算后的 <time> 序列化成秒（"0.2s"），
     *  不是变量里写的 "200ms"，所以按单位换算，别把 0.2 当毫秒用。 */
    function motionMs(name: string, fallback: number): number {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const value = Number.parseFloat(raw);
      if (!Number.isFinite(value) || value <= 0) {
        return fallback;
      }
      return raw.endsWith("ms") ? value : value * 1000;
    }

    /** 交叉淡化里「旧分区」的退役定时器：新的淡完（--m-base）就把它彻底摘掉。 */
    let leavingTimer: number | null = null;

    /** 切换分区：同步 aria-current 与可见性，并把主卡滚回顶部（换内容时留着旧滚动位置很莫名）。
        滚动容器是当前分区那张主卡（`.block.main-card`），不是 #page。

        切换用**纯交叉淡化**（见 40-content.css）：旧分区在过渡期间改成绝对定位垫在下面，
        新分区压在它上面从透明淡进来。旧块不跟着淡——两块一起淡会在中途漏出页面底色，
        亮度先掉一截再爬回来，那正是维护者报的「频闪」。 */
    const selectPanel = (key: PanelKey, persist: boolean): void => {
      const previous = currentPanel;
      currentPanel = key;
      // 已经停在这一页、又没有别的分区要让位：没有「交接」可放，重播入场只会让整块内容
      // 从全透明淡回一次——那正是维护者报的频闪。点击监听那边已挡过一次，但代码里还有
      // 别的入口（桥接安装/卸载/恢复后要切到「环境」面板，用户可能本来就停在那儿），
      // 所以在真正放动画的地方再挡一次，从源头保证「同一页不重播」。
      const switching = previous !== key;
      for (const button of navButtons) {
        button.setAttribute("aria-current", button.dataset.panelBtn === key ? "true" : "false");
      }
      // 左栏指示块按按钮序号滑过去：只写序号，位移与回弹交给 CSS 过渡（#36）。
      if (railIndicator) {
        const index = navButtons.findIndex((button) => button.dataset.panelBtn === key);
        railIndicator.style.setProperty("--i", String(Math.max(index, 0)));
      }

      // 上一轮的旧块先退役：连点几下时可能有不止一块还挂着，一并收掉，免得越叠越多。
      if (leavingTimer !== null) {
        window.clearTimeout(leavingTimer);
        leavingTimer = null;
      }
      for (const panel of panelSections) {
        panel.classList.remove("is-leaving");
      }

      const leaving = switching ? panelSections.find((panel) => panel.dataset.panel === previous) : undefined;

      for (const panel of panelSections) {
        const showing = panel.dataset.panel === key;
        panel.classList.toggle("hidden", !showing);
        // 换内容时留着旧滚动位置很莫名：主卡（唯一的滚动容器）回到顶部。
        if (showing) {
          for (const host of panel.querySelectorAll<HTMLElement>(".block.main-card")) host.scrollTop = 0;
          // 先摘类、强制一次回流，再挂回去：同一个分区来回切也能重播。
          panel.classList.remove("is-enter");
          void panel.offsetWidth;
          // 真换了分区才挂入场；没换（含首帧、桥接操作顺带切回同一页）不重播。
          if (switching) panel.classList.add("is-enter");
        }
      }

      // 旧分区留在原地当底衬，新的淡完就摘。关掉动效时不必留：新版一帧就铺满了。
      if (leaving) {
        leaving.classList.remove("is-enter");
        leaving.classList.remove("hidden");
        leaving.classList.add("is-leaving");
        leavingTimer = window.setTimeout(
          () => {
            leaving.classList.add("hidden");
            leaving.classList.remove("is-leaving");
            leavingTimer = null;
          },
          motionOff() ? 0 : motionMs("--m-base", 200),
        );
      }

      updateScrollThumbHook();
      if (persist) {
        try {
          window.localStorage.setItem(PANEL_KEY, key);
        } catch {
          // 存储被禁用时忽略：本次会话仍按内存里的状态走
        }
      }
    };

    // 首帧把指示块直接贴到存下来的分区上，不许它从第一个慢慢滑过去（#36）：
    // 下一帧才给 .rail[data-ready]，从那时起换分区才有过渡。
    if (railEl) {
      window.requestAnimationFrame(() => {
        railEl.dataset.ready = "";
      });
    }

    for (const button of navButtons) {
      button.addEventListener("click", () => {
        const key = button.dataset.panelBtn as PanelKey;
        const same = key === currentPanel;
        // 点的就是当前这一页：整下动作当空操作——不改 aria-current、不动指示块、不重播入场动画。
        // 维护者要的是「从源头消除重复点击叠加动效的可能」，所以直接返回。
        // 唯一例外是「日志」：重复点它要的是「拉到底并清未读」，那是滚动位置与计数，不是切换动效。
        if (same && key !== "log") return;
        if (!same) selectPanel(key, true);
        // 点进日志就是来看最新的：直接拉到底，不用再手动滚；未读数同时归零。
        if (key === "log") {
          followLogTail();
          resetLogUnread();
        }
      });
    }
    selectPanel(currentPanel, false);

    // ---- 折叠块：高度过渡（#36）--------------------------------------------------
    // 语义与键盘仍归原生 <details>：这里只在它开合时补一段「内容长出来 / 收回去」的过程。
    // 展开走纯 CSS（::details-content 的 block-size 0→auto，见 70-polish.css）；
    // 收起时浏览器会立刻把内容当隐藏处理、内容量归零，高度动画就没有可缩的东西，
    // 所以在关闭那一刻给整块挂 data-closing，等过渡跑完再摘——这一段是补原生做不到的一半。
    const foldBoxes = Array.from(root.querySelectorAll<HTMLDetailsElement>(".log-box"));
    for (const box of foldBoxes) {
      // toggle 事件不分「用户点的」和「代码改 open」的，统一走这里，行为一致。
      box.addEventListener("toggle", () => {
        if (box.open) {
          box.removeAttribute("data-closing");
          return;
        }
        if (motionOff()) return; // 动效关掉：不收窗口，瞬时完成
        box.setAttribute("data-closing", "");
        box.addEventListener(
          "transitionend",
          (event) => {
            if (event.target === box && event.propertyName === "block-size") {
              box.removeAttribute("data-closing");
            }
          },
          { once: true },
        );
      });
    }

    // ---- 日志：左栏里的一个分区，日志正文在主卡里自己滚 ---------------------------
    // 不做窄条 / 浮层 / 遮罩：点左栏「日志」进来，与其他分区平等的进进出出。
    // 内容刷新后要不要拉到底：用户往上翻过就先不抢（距底超过 24px 就算在上翻）。
    let logFollow = true;

    function scrollLogToEnd(): void {
      window.requestAnimationFrame(() => {
        logEl.scrollTop = logEl.scrollHeight;
      });
    }

    /**
     * 把视野交还给最新内容：之后再来新行就自动跟到底，并且立刻拉一次。
     *
     * 只做「跟到底」，不切分区——主动操作产生的输出不再抢画面（见下面的未读数字）。
     */
    const followLogTail = (): void => {
      logFollow = true;
      scrollLogToEnd();
    };

    logEl.addEventListener("scroll", () => {
      const distance = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight;
      logFollow = distance < 24;
    });

    // ---- 左栏「日志」的未读数字 ------------------------------------------------------
    // 主动操作的输出不再把界面拽到日志页，改在左栏「日志」上挂一个数字：按行累加、逐个上拍、
    // 点进日志即归零。纯界面状态——不落盘、不进后端命令，壳重启归 0（见票12）。

    /** 未读数字的上拍节奏：每 90ms 一拍，积压再多也最多 12 拍（约 1.1 秒）走到终值。 */
    const LOG_UNREAD_TICK_MS = 90;
    const LOG_UNREAD_MAX_TICKS = 12;
    /** 数字每变一拍的弹动类名（形状在 style.css 的 .ico-count-bump，节奏由这里的定时器给）。 */
    const LOG_UNREAD_BUMP_CLASS = "ico-count-bump";

    const logUnreadEl = $<HTMLElement>("log-unread");
    /** 已经画在界面上的数字。 */
    let logUnreadShown = 0;
    /** 队列的终值：日志每新写一批行就往上涨。 */
    let logUnreadTarget = 0;
    /** 这一轮上拍的步长：队列起手时按积压定死，之后不再重算（途中新到的行只把队列拉长）。 */
    let logUnreadStep = 1;
    /** 上拍定时器的 id；0 表示队列已经走完（没在跑）。 */
    let logUnreadTimer = 0;

    /** 把当前「已显示值」画成文案：0 时空着（CSS 的 :empty 收成不渲染），过百显示 99+ 并缩字号。 */
    function renderLogUnread(): void {
      paintCountBadge(logUnreadEl, logUnreadShown);
    }

    /** 弹一下：先摘掉动画类、强制回流，再加回去——不然连着两拍之间类名没真正离开过，动画不会重播。 */
    function bumpLogUnread(): void {
      logUnreadEl.classList.remove(LOG_UNREAD_BUMP_CLASS);
      void logUnreadEl.offsetWidth;
      logUnreadEl.classList.add(LOG_UNREAD_BUMP_CLASS);
    }

    function stopLogUnreadTick(): void {
      if (logUnreadTimer !== 0) {
        window.clearInterval(logUnreadTimer);
        logUnreadTimer = 0;
      }
    }

    /** 一拍：往终值推一步。追上了就停表，等下一批行重新起手。 */
    function advanceLogUnread(): void {
      if (logUnreadShown >= logUnreadTarget) {
        stopLogUnreadTick();
        return;
      }
      logUnreadShown = Math.min(logUnreadTarget, logUnreadShown + logUnreadStep);
      renderLogUnread();
      bumpLogUnread();
    }

    /**
     * 记未读：`count` 是这一批新写进日志的行数（`--- 时间 ---` 分段线不算行，所以传原始行数即可）。
     *
     * 停在日志分区时不计：用户眼前就是最新内容，没必要再提示一次。
     */
    function addLogUnread(count: number): void {
      if (count <= 0 || currentPanel === "log") return;
      logUnreadTarget += count;
      // 队列已经停着才定步长：积压超过 12 行就多步合并，保证 12 拍内走到终值；
      // 队列还在跑时新行只把终值往上抬，队列随之延长，不做重置、也不许跳到终值。
      if (logUnreadTimer === 0) {
        logUnreadStep = Math.max(1, Math.ceil((logUnreadTarget - logUnreadShown) / LOG_UNREAD_MAX_TICKS));
        logUnreadTimer = window.setInterval(advanceLogUnread, LOG_UNREAD_TICK_MS);
      }
    }

    /** 点进日志分区：直接归零并隐藏，不等队列一拍拍走完。 */
    function resetLogUnread(): void {
      stopLogUnreadTick();
      logUnreadTarget = 0;
      logUnreadShown = 0;
      logUnreadStep = 1;
      renderLogUnread();
    }

    /** 日志分区右上角的「清空日志」：只清界面这一份（后端的环形缓冲不动），未读数不受影响。 */
    btnClearLog.addEventListener("click", () => clearLog());

    /** 写剪贴板：先试剪贴板 API，不可用时退回「选中 + execCommand」。返回是否成功。 */
    async function writeText(text: string): Promise<boolean> {
      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error("剪贴板 API 不可用");
        }
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // 兜底：临时建一个不可见的 textarea 选中复制（WebView2 支持 execCommand）。
        const holder = document.createElement("textarea");
        holder.value = text;
        holder.setAttribute("readonly", "");
        holder.style.position = "fixed";
        holder.style.opacity = "0";
        document.body.appendChild(holder);
        holder.select();
        let ok = false;
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
        holder.remove();
        return ok;
      }
    }

    /** 按钮上的「复制」：复制某个元素里的文本，按钮内回显结果（见 ui/copy-feedback.ts）。
        日志面板的「复制日志」与命令行集成的「手动命令」「垫片内容」共用这一套。
        成功只留在按钮里；失败另补一条 toast——按钮内的红态一闪就复原，复制没成功
        得让人有机会知道该手动选中文本再复制。 */
    function copyLog(source: HTMLElement, button: HTMLButtonElement): void {
      void (async () => {
        const ok = await writeText(source.textContent ?? "");
        flashCopy(button, ok);
        if (!ok) {
          showToast("复制失败：剪贴板不可用，请手动选中文本复制。", "error");
        }
      })();
    }

    // 一次性把三颗复制按钮装上反馈结构（图标叠层 + 定宽文案层 + 隐藏播报区）。
    prepareCopyButton(btnCopyLog, "复制日志");
    prepareCopyButton(btnCliCopy, "复制");
    prepareCopyButton(btnCliCopyShim, "复制");

    btnCopyLog.addEventListener("click", () => copyLog(logEl, btnCopyLog));
    for (const [button, source] of [
      [btnCliCopy, cliManual],
      [btnCliCopyShim, cliShimText],
    ] as const) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        copyLog(source, button);
      });
    }

    // 桥接插件小节的状态：busy 防重复点击；lastBridgeState 供「恢复最近备份」用。
    let bridgeBusy = false;
    let lastBridgeState: BridgeState | null = null;

    // ---- 端口字段：托管值提示 + 覆盖状态 + 输入校验 --------------------------

    let portHint: PortHint | null = null;

    /** 端口输入的即时校验；为空 = 不覆盖（合法）。 */
    function portFieldError(): string | null {
      // type=number 会把成不了数的输入吞掉（.value 直接变成空串，比如 "1e"）。
      // 只按空串判断会被当成「留空 = 跟随 DSH 配置」而静默存盘，所以先问一次 validity。
      if (portInput.validity.badInput) {
        return "端口必须是 1-65535 的整数（留空表示跟随 DSH 配置）";
      }
      const raw = portInput.value.trim();
      if (raw === "") {
        return null;
      }
      if (!/^\d+$/.test(raw)) {
        return "端口必须是 1-65535 的整数（留空表示跟随 DSH 配置）";
      }
      const value = Number.parseInt(raw, 10);
      if (value < 1 || value > 65535) {
        return "端口超出范围：必须是 1-65535 的整数";
      }
      return null;
    }

    /** 端口说明写进标签后的 ⓘ 气泡：动态状态 + 原来那行小字里「所有启动方式共用这两个字段」的固定说明。 */
    function setPortTip(text: string): void {
      portInfoEl.dataset.tip = `${text}四种启动方式共用这两个字段，运行环境选 WSL 时同样生效（壳注入的端口覆盖层会经 /mnt 路径送进发行版）。配置改完自动保存，重开壳后保留。`;
    }

    /** 附加参数里的 `--port` / `--host`：它们会盖掉 profile 的 webserver 配置，提示里要说清。 */
    function extraArgFlag(name: string): string | null {
      const args = extraInput.value.trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === name) return args[i + 1] ?? "";
        if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
      }
      return null;
    }

    function renderPortHint(): void {
      const raw = portInput.value.trim();
      // 输入框提示显示 DSH 配置里的真实端口（读不到就显示默认 3080）：只是提示文字，
      // 不参与保存，「留空 = 跟随 DSH 配置」的语义不变。
      const managedPort = portHint !== null && portHint.source === "managed" ? portHint.port : null;
      portInput.placeholder = String(managedPort ?? 3080);
      // 空 = 本来就跟配置走，没有可还原的东西。
      portReset.disabled = raw === "";
      const flagPort = extraArgFlag("--port");
      const flagHost = extraArgFlag("--host");
      // 谁真正生效：profile 里写死的 webserver 块压过 DSH 的 --port / --host（真机实测：
      // profile 写 3080 + `--port 3097` 仍监听 3080，profile 写 192.168.1.7 时
      // `--host 127.0.0.1` 也不生效）；只有 profile 没写那项时附加参数才轮得到。
      const managedHost = portHint !== null && portHint.source === "managed" ? portHint.host : null;
      const overridden: string[] = [];
      if (flagPort !== null && managedPort !== null) overridden.push("--port");
      if (flagHost !== null && managedHost !== null) overridden.push("--host");
      const wins: string[] = [];
      if (flagPort !== null && managedPort === null) wins.push(`--port ${flagPort || "（缺值）"}`);
      if (flagHost !== null && managedHost === null) wins.push(`--host ${flagHost || "（缺值）"}`);
      const flagNote =
        overridden.length > 0 || wins.length > 0
          ? `${overridden.length > 0 ? `注意：附加参数里的 ${overridden.join(" / ")} 不生效——DSH 配置的 webserver 块已写死，优先级更高。` : ""}${wins.length > 0 ? `注意：附加参数里的 ${wins.join("、")} 会盖掉下面的配置。` : ""}`
          : "";
      if (!portHint) {
        setPortTip(flagNote || "正在读取 DSH 配置…");
        return;
      }
      if (portHint.source === "managed" && portHint.port !== null) {
        const host = portHint.host ? `host ${portHint.host}，` : "";
        setPortTip(`${flagNote}当前生效值：${portHint.port}（来自 DSH 配置的 webserver 块，${host}留空时不动它；自定义端口会保留 host）。`);
      } else {
        setPortTip(`${flagNote}未读到 DSH 端口配置（默认 3080）；留空则完全不干预。`);
      }
    }

    async function refreshPortHint(): Promise<void> {
      try {
        portHint = await invoke<PortHint>("profile_port_hint", { config: collectConfig() });
      } catch (err) {
        portHint = null;
        console.error("读取端口提示失败:", err);
      }
      renderPortHint();
    }

    /**
     * 静默保存当前配置（编辑中暂时不合法时跳过，启动时会再校验）。
     *
     * 返回存盘失败的理由；存成功了返回 null。大多数调用方不关心，但代理地址那条路径
     * 必须把错误报给用户：后端会拒收填错的地址，静静吞掉就成了「看起来生效、重开就没了」。
     */
    async function persistConfigQuiet(): Promise<string | null> {
      if (portFieldError()) {
        renderPortHint();
        return null;
      }
      try {
        const shell: ShellConfig = {
          launch: collectConfig(),
          trayClick: trayPicker.value as TrayClick,
          lightDelaySecs: Number(lightDelayPicker.value),
          // 主题镜像一致即可；写进 save_shell_config 会被整份串行化，若不一致也顺手对齐
          // （正常路径由左栏底部的浅/深切换单独走 save_ui_theme）。
          uiTheme: theme,
          // 三张新卡的六个字段本版没有界面控件，但必须原样带上：整份回写会把漏掉的键
          // 抹回默认值。值来自后端读回（缺字段时为 normalizePrefs 补的默认）。
          ...prefs,
        };
        await invoke("save_shell_config", { config: shell });
        // 配置已回到合法状态：把之前因非法输入显示的错误消掉。
        if (localError) {
          localError = null;
          await refresh();
        }
        return null;
      } catch (err) {
        console.debug("配置暂未保存:", err);
        return String(err);
      }
    }

    const modeRadios = () => Array.from(root.querySelectorAll<HTMLInputElement>('input[name="mode"]'));
    const currentMode = (): string => modeRadios().find((r) => r.checked)?.value ?? "npx";

    function syncModeFields(): void {
      $("npx-fields").classList.toggle("hidden", currentMode() !== "npx");
      $("binary-fields").classList.toggle("hidden", currentMode() !== "binary");
      $("custom-fields").classList.toggle("hidden", currentMode() !== "custom");
      // 桥接插件与端口提示都跟随运行环境（Windows 宿主 / WSL 发行版），换模式就刷新。
      void refreshBridgeState();
      void refreshPortHint();
    }
    for (const radio of modeRadios()) {
      radio.addEventListener("change", () => {
        syncModeFields();
        void persistConfigQuiet();
        // 转换启动方式后垫片要跟着重写，否则终端里的 dsh 还是旧的那份（票据验收标准）。
        void syncCliShim();
      });
    }
    syncModeFields();

    function collectConfig(): LaunchConfig {
      const extraArgs = extraInput.value.trim().split(/\s+/).filter(Boolean);
      const raw = portInput.value.trim();
      // 端口输入非法时调用方（启动/保存）会先报错拦截；这里兜底按 null 处理。
      const parsed = raw === "" ? null : Number.parseInt(raw, 10);
      const port = parsed !== null && Number.isFinite(parsed) ? parsed : null;
      // 运行环境只对「官方 npx」「自定义命令」生效；另外两种固定跑 Windows 宿主，
      // 写盘时按默认值序列化，避免下拉里残留的 WSL 值跟着进配置文件（否则壳会
      // 把桥接插件装进发行版、按 WSL 算探测地址）。壳级共享的 runtime 不变。
      const mode = currentMode();
      const effectiveRuntime: LaunchRuntime =
        mode === "npx" || mode === "custom" ? runtime : { kind: "default" };
      const base = { runtime: effectiveRuntime, extraArgs, port };
      switch (mode) {
        case "system":
          return { ...base, mode: { kind: "system" } };
        case "binary":
          return { ...base, mode: { kind: "binary", path: binaryPath.value.trim() } };
        case "custom":
          return { ...base, mode: { kind: "custom", command: customCommand.value.trim() } };
        default:
          return { ...base, mode: { kind: "npx", version: currentVersion() } };
      }
    }

    // 配置自动保存：任一字段变更后尝试写盘（当前不合法时不写、不打扰；启动时会再校验）。
    // 自绘下拉框（托盘单击打开 / 运行环境 / 渠道 / 版本）的回调在构造时已接进 persistConfigQuiet。
    for (const input of [extraInput, binaryPath, customCommand, portInput]) {
      input.addEventListener("change", () => void persistConfigQuiet());
    }
    // 二进制路径与自定义命令直接决定垫片内容：改完（失焦/回车）就按新值重写。
    for (const input of [binaryPath, customCommand]) {
      input.addEventListener("change", () => void syncCliShim());
    }
    // 附加参数里可能写了 --port / --host，改完立刻刷新端口气泡里的「以它为准」提示。
    extraInput.addEventListener("input", () => renderPortHint());
    // 「指定程序路径」：点「浏览…」弹系统「打开文件」框（默认只列可执行文件），选完写入输入框并
    // 即时校验；手打/粘贴的路径在失焦时校验。红字只是提前提醒，不拦启动（启动时后端仍会校验）。
    binaryBrowse.addEventListener("click", () => void pickBinaryPath());
    binaryPath.addEventListener("blur", () => void checkBinaryPath());

    async function pickBinaryPath(): Promise<void> {
      let picked: string | string[] | null;
      try {
        picked = await openFileDialog({
          multiple: false,
          directory: false,
          filters: [
            { name: "可执行文件", extensions: ["exe", "cmd", "bat"] },
            { name: "所有文件", extensions: ["*"] },
          ],
        });
      } catch (err) {
        // 弹框失败（多半是缺少 dialog 权限）也要说清楚，不能静默。
        showBinaryError(`打开文件对话框失败：${String(err)}`);
        return;
      }
      if (typeof picked !== "string") return; // 用户取消：输入框保持原样
      binaryPath.value = picked;
      void persistConfigQuiet();
      await checkBinaryPath();
    }

    /** 校验「指定程序路径」并在字段下方显示/清除红字；空值当作「还没填」，不提示。 */
    async function checkBinaryPath(): Promise<void> {
      const path = binaryPath.value.trim();
      if (!path) {
        hideBinaryError();
        return;
      }
      try {
        await invoke("check_binary_path", { path });
        hideBinaryError();
      } catch (err) {
        showBinaryError(String(err));
      }
    }

    function showBinaryError(message: string): void {
      binaryError.textContent = message;
      binaryError.classList.remove("hidden");
    }

    function hideBinaryError(): void {
      binaryError.textContent = "";
      binaryError.classList.add("hidden");
    }
    // 端口：输入即刷新提示与「还原」按钮（不含程序化赋值）；失焦再刷新一次保证同步。
    portInput.addEventListener("input", renderPortHint);
    portInput.addEventListener("change", renderPortHint);
    // 滚轮掠过不得改值：number 输入框会把落在它身上的滚轮当步进用，用户想滚面板却把端口滚没了。
    // 拦掉默认行为，并在没聚焦时顺手失焦兜底（聚焦时可能是想用上下键调，别抢）。
    portInput.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        if (document.activeElement !== portInput) {
          portInput.blur();
        }
      },
      { passive: false },
    );
    // 「还原」：清空输入框并派发 input/change，走与手打完全相同的自动保存路径。
    portReset.addEventListener("click", () => {
      portInput.value = "";
      portInput.dispatchEvent(new Event("input", { bubbles: true }));
      portInput.dispatchEvent(new Event("change", { bubbles: true }));
      portInput.focus();
    });
    // 启动/停止失败时后端返回的错误（与轮询到的会话错误分开保存，
    // 否则下一次轮询（每秒一次）会把刚显示的错误清掉）。
    let localError: string | null = null;

    /** 把说明写进登录徽章的感叹号气泡（悬停或键盘聚焦时显示）。 */
    function setLoginTip(text: string): void {
      loginInfo.dataset.tip = text;
      loginInfo.setAttribute("aria-label", `登录链接说明：${text}`);
    }

    /**
     * 日志面板的文本更新。
     *
     * 状态每秒轮询一次，每次都把同一个字符串重新赋给 `textContent`；换掉文本节点本身就会清掉选区，
     * 表现就是「拖选几段、一松手就没了」。所以：文本没变就不动 DOM，用户正在这块里框选（选区未折叠）
     * 也先不动。轮询每 1 秒重跑一次，等用户点别处解除选区后自然会补上。
     */
    function setOutputText(el: HTMLElement, text: string): void {
      if (el.textContent === text || hasSelectionWithin(el)) {
        return;
      }
      el.textContent = text;
    }

    /** 选区（含折叠判定）是否落在这个元素里：跨块拖选时 anchor 与 focus 任一端在内就算。 */
    function hasSelectionWithin(el: HTMLElement): boolean {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return false;
      }
      return [selection.anchorNode, selection.focusNode].some((node) => node !== null && el.contains(node));
    }

    // ---- 统一日志 ------------------------------------------------------------------
    // 界面里只留一个日志：后端 DSH 进程的输出尾部 + 桥接 / 环境 / 缓存这些主动操作的结果都写进
    // 这一份，不随切分区丢、不自动清，只有点「清空日志」或完全退出程序才清。
    // 后端的环形缓冲留 1200 行、状态查询每次给最后 300 行（见 launcher.rs），这里只负责
    // 算出「这一轮新长出来的那几行」，不然每秒轮询会把同一段尾巴反复追加一遍。
    let logText = "";
    /** 上一轮拿到的日志尾部：用来做增量比对，只追加新增的那几行。 */
    let lastLogTail: string[] | null = null;
    /** 上一次往日志里写东西的时间：间隔太长就补一条 `--- 时间 ---` 分段线。 */
    let lastLogAt = 0;
    const LOG_GAP_MS = 10 * 60 * 1000;

    function logStamp(): string {
      const now = new Date();
      const pad = (value: number): string => String(value).padStart(2, "0");
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    /** 往日志末尾追加一批行；`stamp` 为真时先插一条 `--- 时间 ---` 分段线。
     *  写进去的行数记进左栏「日志」的未读数字（分段线不算一行，`lines` 里本来也不含它）。
     *  `countUnread` 为假时只写不算——用于整段历史尾巴这种「本来就在那儿」的内容。 */
    function appendLog(lines: string[], stamp: boolean, countUnread = true): void {
      const body = lines.join("\n").replace(/\s+$/, "");
      if (body === "") return;
      const needStamp = stamp || lastLogAt === 0 || Date.now() - lastLogAt > LOG_GAP_MS;
      const chunk = needStamp ? `--- ${logStamp()} ---\n${body}` : body;
      // 同一批次的连续追加只用单换行接上；换批次（带分段线）时前面空一行。
      const separator = logText === "" ? "" : needStamp ? "\n\n" : "\n";
      logText = `${logText.replace(/\s+$/, "")}${separator}${chunk}`;
      lastLogAt = Date.now();
      setOutputText(logEl, logText);
      if (logFollow) scrollLogToEnd();
      if (countUnread) addLogUnread(body.split("\n").length);
    }

    /** 主动操作的结果（桥接 / 环境 / 缓存）：写进统一日志。不再把界面拽到日志页——
     *  没在看日志的人才需要知道「那边多了几行」，那由左栏的未读数字提示。 */
    function logAction(text: string): void {
      appendLog([text], true);
    }

    /** 后端日志尾部：算出新增的那几行（上一轮的尾巴可能已被环形缓冲挤掉前半段，所以两头都试）。
     *  `previous === null` 是首段历史尾巴：整段都算已读，不产生未读。 */
    function syncLogFromTail(tail: string[]): void {
      const previous = lastLogTail;
      lastLogTail = [...tail];
      if (previous === null) {
        // 首段整段历史尾巴不冒未读：这些行是「本来就在那儿」的，不是刚新写进来的。
        // 也顺手覆盖了「清空日志后的第一次同步」——重新落回去的是用户刚看过的内容，
        // 清空本身不动计数，跟着回来的这几行也不该抬计数。
        appendLog(tail, false, false);
        return;
      }
      if (tail.length === 0) return;
      // 正常情况：上一轮尾巴是这一轮的前缀，新的就是尾部多出来的那几行。
      const sameHead = previous.length <= tail.length && previous.every((line, index) => line === tail[index]);
      if (sameHead) {
        if (tail.length > previous.length) appendLog(tail.slice(previous.length), false);
        return;
      }
      // 缓冲已满、上一轮的尾巴被挤掉前半段：找最长的重叠部分拼上去。
      const limit = Math.min(previous.length, tail.length);
      for (let overlap = limit; overlap > 0; overlap -= 1) {
        const tailStart = tail.length - overlap;
        let same = true;
        for (let i = 0; i < overlap; i += 1) {
          if (previous[previous.length - overlap + i] !== tail[tailStart + i]) {
            same = false;
            break;
          }
        }
        if (same) {
          if (overlap < tail.length) appendLog(tail.slice(overlap), false);
          return;
        }
      }
      // 完全接不上（DSH 重启、换了环境）：整段当成新的一批。
      appendLog(tail, true);
    }

    function clearLog(): void {
      logText = "";
      lastLogTail = null;
      lastLogAt = 0;
      logEl.textContent = "（暂无输出）";
    }

    /** 最近一次渲染的状态：「启动 / 停止」合并成一个按钮，靠它决定该发哪条命令。 */
    let currentStatus: SessionStatus | null = null;

    /** 上次渲染的按钮形态：render 每秒跑一次，只在跨状态时重建 DOM。
     * 初始就是 swap（buildHtml 的标记带 .swap），第一轮 render 不必重建。 */
    let toggleMode: "swap" | "busy" | "round" | null = "swap";

    /** 刚点了「启动」、start_dsh 这条命令还没返回的那一小段。
     * 这段时间后端状态仍是「已停止」，界面却已经该说「启动中」，所以本地记一笔；
     * 命令返回后交给 isStarting（进程起来了、登录链接还没就绪）接着表达。 */
    let launchPending = false;

    /**
     * 渲染「启动 / 停止」按钮，三种形态：
     * - `swap`（未启动）：蓝底长条「启动 DSH」+ 两组文字逐字切换（60-controls.css 的
     *   `#btn-toggle.swap`）；
     * - `busy`（启动中）：同一根蓝底长条，换成一只细环 + 「启动中…」。命令在途时这一下
     *   按不动（后端仍是 stopped，再发一条只会被拒），气泡如实说明「在等」；
     * - `round`（运行中）：红底**圆形图标钮**（维护者要求：与「重启 DSH」同形）。
     * 三种形态只在跨状态时重建一次，逐帧调用不会反复重排 DOM。
     */
    function renderToggleButton(mode: "swap" | "busy" | "round"): void {
      if (mode === toggleMode) return;
      toggleMode = mode;
      btnToggle.classList.toggle("swap", mode === "swap");
      btnToggle.classList.toggle("busy", mode === "busy");
      btnToggle.classList.toggle("round", mode === "round");
      if (mode === "round") {
        // 圆形钮里只有图标，没有可见文字：名字靠 aria-label，操作说明走自绘气泡
        //（.has-tip + data-tip，见 50-info.css）。不再用原生 title，免得两份提示叠在一起。
        btnToggle.classList.add("has-tip");
        btnToggle.dataset.tip = TOOLTIP_STOP;
        btnToggle.setAttribute("aria-label", TOOLTIP_STOP);
        btnToggle.innerHTML = ICON_STOP;
        return;
      }
      if (mode === "busy") {
        // 启动中仍是长条按钮。气泡说实话：这一下按不动（命令在途时后端还是 stopped，
        // 再发一条只会被拒），等进程真的起来、变红圆钮之后才谈得上停止。
        btnToggle.classList.add("has-tip");
        btnToggle.dataset.tip = TOOLTIP_STARTING;
        btnToggle.setAttribute("aria-label", `${TOGGLE_TEXT_STARTING}正在等待 DSH 起来`);
        btnToggle.innerHTML = `<span class="launch-spin" aria-hidden="true"></span><span class="btn-text">${TOGGLE_TEXT_STARTING}</span>`;
        return;
      }
      // 停止态是带可见文字的长条按钮，气泡没有意义，一并摘掉。
      btnToggle.classList.remove("has-tip");
      delete btnToggle.dataset.tip;
      btnToggle.setAttribute("aria-label", TOGGLE_TEXT_REST);
      btnToggle.innerHTML = toggleSwapHtml();
    }

    /**
     * 按「在途 / 启动中 / 运行 / 未启动」重画「启动 / 停止」这一支（形态 + 主色 + aria-busy +
     * 重启钮要不要露面）。轮询渲染与点击瞬间都走这一条，免得两处各算一遍 `busy` 之后
     * 算出不同的结论（点击时先切「启动中」，靠的就是这里同一套推导）。
     */
    function paintToggle(): void {
      const running = currentStatus?.state === "running";
      const starting = currentStatus ? isStarting(currentStatus) : false;
      const busy = launchPending || starting;
      renderToggleButton(busy ? "busy" : running ? "round" : "swap");
      // 启动中仍是蓝底主按钮（不是运行态那枚红圆钮），所以主色跟着 busy / 未启动走。
      btnToggle.classList.toggle("primary", !running || busy);
      // 读屏软件靠它知道「按下去之后还在忙」，不依赖那只转圈的动画。
      btnToggle.setAttribute("aria-busy", busy ? "true" : "false");
      // 「重启 DSH」只在**真正起来之后**出现（维护者要求）：启动中整排仍只有一颗按钮，
      // 登录链接就绪、状态落定才放出「停止 / 重启」。
      btnRestart.classList.toggle("hidden", !running || busy);
    }

    function render(status: SessionStatus): void {
      currentStatus = status;
      // 运行状态不入徽章：只看主按钮的蓝/红与文案。
      // DSH 版本：后端在每次成功启动后异步补上，重启壳后为「未知」直到再次启动。
      versionText.textContent = status.dshVersion ? `DSH v${status.dshVersion}` : "DSH 版本未知";
      aboutDsh.textContent = status.dshVersion ?? "未知";
      pidEl.textContent = status.pid === null ? "—" : String(status.pid);
      portEl.textContent = status.port === null ? "—" : String(status.port);
      const message = localError ?? status.error;
      if (message) {
        errorEl.textContent = message;
        errorEl.classList.remove("hidden");
      } else {
        errorEl.textContent = "";
        errorEl.classList.add("hidden");
      }
      syncLogFromTail(status.logTail);
      // 「启动中」= 命令刚发出去还没回来，或进程起来了、登录链接还没就绪（npx 首次下载、
      // DSH 冷启动都停在这一步）。这一段不能直接跳到运行态，否则点了「启动 DSH」会一下子
      // 蹦出「停止 / 重启」两颗（维护者反馈的突变）。推导与形态切换都在 paintToggle 里。
      paintToggle();
      // 「打开方式」：启动前后都在，只在登录链接就绪后可点（没链接时点开也没用）。
      btnOpen.disabled = !status.loginReady;
      btnOpenMore.disabled = !status.loginReady;

      // 顶部徽章只报告「桥接插件装没装」（纯两态）；文案由 paintBridgeBadge 统一写。
      // 登录链接本身的状态不占一格，但出问题时仍要能看见：有错就写进下面那一行。
      if (status.loginError) {
        setNoticeHint(loginNote, status.loginError);
      } else {
        setNoticeHint(loginNote, "");
      }
      // 「重启 DSH」的持续转动：拿这次状态过一遍收场条件（每秒轮询都会走到这里）。
      updateRestartSpin(status, isStarting(status));
      // 日志会不断长个儿，顺带把滚动指示条的几何刷新一下（这里只算不显示）。
      updateScrollThumbHook();
    }

    async function refresh(): Promise<void> {
      try {
        render(await invoke<SessionStatus>("dsh_status"));
      } catch (err) {
        console.error("查询状态失败:", err);
      }
    }
    setStatusRefresher(refresh);

    /** 按当前界面配置启动 DSH；`restart_dsh` 会先停掉现有会话再拉起（「启动」与「重启」共用）。 */
    async function startOrRestart(command: "start_dsh" | "restart_dsh"): Promise<void> {
      localError = null;
      // 端口非法输入：明确提示、不保存、不启动。
      const portError = portFieldError();
      if (portError) {
        localError = portError;
        // 命令没发出去，就不要再显示「启动中」。
        launchPending = false;
        // 重启点击时已经开始转（beginRestartSpin），命令没发出去就别转了。
        endRestartSpin();
        await refresh();
        return;
      }
      // 启动/重启 DSH 都会产生终端输出，但不再把界面拽到日志页：没在看日志的人由左栏的
      // 未读数字告知，正在看日志的人继续跟到底。
      followLogTail();
      try {
        await invoke(command, { config: collectConfig() });
      } catch (err) {
        localError = String(err);
        // 命令被后端拒绝（如端口占用）：重启没真正发生，立即收拾掉点击时的转动。
        if (command === "restart_dsh") endRestartSpin();
      }
      // 命令返回后「在途」这一相就结束了：之后启动到哪一步交给状态里的「启动中」接着表达
      //（进程起来了、登录链接还没就绪）。放刷新之前清，免得这一帧还停在 busy 上。
      launchPending = false;
      await refresh();
      // 启动/重启都会重读一次环境清单：插件数、依赖状态可能刚变过。
      void loadProfiles();
    }

    // 「启动 DSH / 停止」同一个按钮：运行中（含「启动中」）点击是停止，否则是启动（失败后也是重新启动）。
    // 转动中按下「停止」= 主动打断重启：转动立即停（维护者规格），剩下的交给 stop_dsh。
    btnToggle.addEventListener("click", () => {
      if (currentStatus?.state === "running") {
        endRestartSpin();
        void stopDsh();
        return;
      }
      // 命令还在途：按钮已经显示「启动中…」，再点一次只会在后端排第二条启动命令。
      if (launchPending) return;
      // 立刻切到「启动中」形态，不等这条命令返回——后端那一轮可能要等 npx 下载。
      // 走 paintToggle 而不是直接 renderToggleButton("busy")：形态、主色、aria-busy、
      // 重启钮的显隐是同一套推导，别在点击瞬间另写一份结论。
      launchPending = true;
      paintToggle();
      void startOrRestart("start_dsh");
    });
    // 「重启 DSH」：点击瞬间开始持续转动（不等悬停那圈的 300ms 提前量），转动期间照旧可点、重点即重新计时。
    btnRestart.addEventListener("click", () => {
      beginRestartSpin();
      void startOrRestart("restart_dsh");
    });

    async function stopDsh(): Promise<void> {
      localError = null;
      followLogTail();
      try {
        await invoke("stop_dsh");
      } catch (err) {
        localError = String(err);
      }
      await refresh();
    }

    // ---- 打开方式：主按钮 + 右侧小三角的两段式 ----------------------------------
    // 点小三角展开菜单 → 选一种方式 → 文字与图标回填到主按钮 → 再点主按钮才执行。
    // 选择记在 localStorage：下次启动沿用上次的方式（默认应用内打开）。
    const OPEN_MODE_KEY = "dsharbor.ui.openMode";
    type OpenMode = "app" | "browser" | "copy";
    const OPEN_MODES: ReadonlyArray<{ key: OpenMode; label: string; icon: string }> = [
      { key: "app", label: "应用内打开", icon: ICON_OPEN_APP },
      { key: "browser", label: "浏览器打开", icon: ICON_OPEN_BROWSER },
      { key: "copy", label: "复制登录链接", icon: ICON_COPY },
    ];

    function readOpenMode(): OpenMode {
      try {
        const raw = window.localStorage.getItem(OPEN_MODE_KEY);
        return raw === "browser" || raw === "copy" ? raw : "app";
      } catch {
        return "app";
      }
    }

    let openMode: OpenMode = readOpenMode();

    /** 主按钮回填当前方式；菜单里的勾选也跟着走。 */
    function paintOpenMode(): void {
      const mode = OPEN_MODES.find((item) => item.key === openMode) ?? OPEN_MODES[0];
      // 「复制登录链接」与其它复制按钮同一套结构（图标叠层 + 定宽文案层，见 ui/copy-feedback.ts）；
      // 其它方式仍是单图标 + 单文案。切换方式时重建，顺带清掉上一次的复制反馈态。
      const copyMode = mode.key === "copy";
      openIco.innerHTML = copyMode ? copyIconStack() : mode.icon;
      openText.innerHTML = copyMode ? copyTextChrome(mode.label) : escapeHtml(mode.label);
      // 复制方式的文案层带 aria-hidden（三行叠放，读屏会连着念），名字改由 aria-label 给；
      // 其它方式没有这层，名字仍走可见文字。
      if (copyMode) btnOpen.setAttribute("aria-label", mode.label);
      else btnOpen.removeAttribute("aria-label");
      btnOpen.classList.toggle("copy-mode", copyMode);
      btnOpen.classList.remove("copied", "copy-failed");
      for (const item of Array.from(openMenu.querySelectorAll<HTMLButtonElement>("[data-open-mode]"))) {
        item.setAttribute("aria-checked", item.dataset.openMode === openMode ? "true" : "false");
      }
    }

    function setOpenMenuOpen(open: boolean): void {
      openMenu.classList.toggle("hidden", !open);
      btnOpenMore.setAttribute("aria-expanded", open ? "true" : "false");
    }

    btnOpenMore.addEventListener("click", (event) => {
      event.stopPropagation();
      setOpenMenuOpen(openMenu.classList.contains("hidden"));
    });
    document.addEventListener("click", () => setOpenMenuOpen(false));
    openMenu.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpenMenuOpen(false);
    });

    for (const item of Array.from(openMenu.querySelectorAll<HTMLButtonElement>("[data-open-mode]"))) {
      item.addEventListener("click", () => {
        openMode = item.dataset.openMode as OpenMode;
        try {
          window.localStorage.setItem(OPEN_MODE_KEY, openMode);
        } catch {
          // 存储被禁用时只在本次会话生效
        }
        paintOpenMode();
        setOpenMenuOpen(false);
      });
    }

    /** 复制登录链接：链接每次都重新取（token 是一次性铸造的），成功后按钮上短暂回显。
        失败与另外三颗复制按钮一致：按钮内红态之外再补一条 toast。 */
    async function copyLoginUrl(): Promise<void> {
      const url = await invoke<string>("dsh_login_url");
      const ok = await writeText(url);
      flashCopy(btnOpen, ok);
      if (!ok) {
        showToast("复制失败：剪贴板不可用，请手动选中文本复制。", "error");
      }
    }

    // 主按钮：按当前方式真的去打开（应用内 / 浏览器 / 复制）。
    btnOpen.addEventListener("click", () => {
      void (async () => {
        localError = null;
        try {
          if (openMode === "app") {
            await invoke("open_dsh_window");
          } else if (openMode === "browser") {
            await invoke("open_dsh_in_browser");
          } else {
            await copyLoginUrl();
          }
        } catch (err) {
          localError = String(err);
          await refresh();
        }
      })();
    });

    paintOpenMode();

    // 左栏底部的官网 / 仓库链接（「关于」里不再重复这两项）。
    linkSite.addEventListener("click", () => void openExternal("site"));
    linkRepo.addEventListener("click", () => void openExternal("repo"));

    function updateBridgeButtons(): void {
      btnBridgeInstall.disabled = bridgeBusy;
      btnBridgeUninstall.disabled = bridgeBusy;
      btnBridgeRestore.disabled = bridgeBusy;
    }

    /**
     * 读桥接插件状态。
     *
     * 顶部那颗徽章是「纯两态」（维护者要求）：桥接已安装就算已连接，没装就说没装；
     * 登录链接有没有拿到不再单独占一格（那是会话状态，跟插件是否装好是两件事）。
     * 徽章恒看启动用的 web 环境——桥接只装在那份上。
     */
    async function refreshBridgeState(): Promise<void> {
      try {
        const state = await invoke<BridgeState>("bridge_state", { config: collectConfig() });
        lastBridgeState = state;
        bridgeTarget.textContent = state.target;
        bridgeStatus.textContent = state.installed ? "已安装（优先走桥接通道）" : "未安装（走日志兜底）";
        bridgeBackup.textContent = state.latestBackup
          ? `最近备份：${state.latestBackup}`
          : "还没有备份：安装或卸载时会自动创建，可用「恢复最近备份」回滚。";
        paintBridgeBadge(state.installed, null);
      } catch (err) {
        bridgeStatus.textContent = `读取失败：${err}`;
        paintBridgeBadge(null, String(err));
      }
    }

    /**
     * 把桥接状态画到顶部徽章上。
     *
     * `installed === null` 表示没读到（读取失败），这时如实说读取失败，不假装「未安装」。
     */
    function paintBridgeBadge(installed: boolean | null, error: string | null): void {
      if (installed === null) {
        loginBadge.className = "badge badge-failed";
        loginText.textContent = "桥接状态读取失败";
        setLoginTip(error ?? "读取桥接插件状态失败。");
        return;
      }
      loginBadge.className = `badge ${installed ? "badge-running" : "badge-stopped"}`;
      loginText.textContent = installed ? "桥接就绪" : "桥接未安装";
      setLoginTip(
        installed
          ? "桥接插件已装在启动用的 web 环境上：登录链接直接经它取得，不依赖日志格式。"
          : "桥接插件还没装：现在只能从启动日志里解析登录链接。到「环境/插件」里点「桥接插件」装上更稳。",
      );
    }

    function runBridgeOp(name: "bridge_install" | "bridge_uninstall"): void {
      void (async () => {
        bridgeBusy = true;
        updateBridgeButtons();
        bridgeError.classList.add("hidden");
        // 桥接操作会产生 pnpm/命令的终端输出：自动切到「环境」面板并拉起日志浮层（维护者要求）。
        selectPanel("env", true);
        logAction("桥接插件：执行中…（首次可能较慢，pnpm 需要解析依赖）");
        try {
          const outcome = await invoke<BridgeOutcome>(name, { config: collectConfig() });
          logAction(outcome.message);
          // 安装/卸载的结果除了进日志，再补一条回执：浮窗与日志都可能没在眼前。
          showToast(outcome.message, outcome.ok ? "ok" : "error");
          if (!outcome.ok) {
            bridgeError.textContent = "命令返回非成功状态，请看下方输出与备份目录。";
            bridgeError.classList.remove("hidden");
          }
        } catch (err) {
          bridgeError.textContent = String(err);
          bridgeError.classList.remove("hidden");
          showToast(`桥接插件操作失败：${String(err)}`, "error");
        } finally {
          bridgeBusy = false;
          updateBridgeButtons();
          await refreshBridgeState();
        }
      })();
    }

    btnBridgeInstall.addEventListener("click", () => runBridgeOp("bridge_install"));
    btnBridgeUninstall.addEventListener("click", () => runBridgeOp("bridge_uninstall"));
    btnBridgeRestore.addEventListener("click", () => {
      void (async () => {
        const backup = lastBridgeState?.latestBackup;
        if (!backup) {
          bridgeError.textContent = "还没有可恢复的备份：先执行一次安装或卸载，壳会自动创建备份。";
          bridgeError.classList.remove("hidden");
          return;
        }
        bridgeBusy = true;
        updateBridgeButtons();
        try {
          // 恢复同样产生终端输出：自动切到「环境」面板并拉起日志浮层。
          selectPanel("env", true);
          const message = await invoke<string>("bridge_restore", {
            config: collectConfig(),
            backupDir: backup,
          });
          logAction(message);
          bridgeError.classList.add("hidden");
          showToast(message, "ok");
        } catch (err) {
          bridgeError.textContent = String(err);
          bridgeError.classList.remove("hidden");
          showToast(`恢复桥接插件备份失败：${String(err)}`, "error");
        } finally {
          bridgeBusy = false;
          updateBridgeButtons();
          await refreshBridgeState();
        }
      })();
    });

    // ---- 环境/插件卡：一排环境大按钮 + 插件开关 --------------------------------
    // 点大按钮只把「当前管理的环境」切过去（写进配置，下次打开还是它）；真正拉起 DSH
    // 永远用 web 环境（核心库 launch::PROFILE_NAME）。重命名 / 复制 / 删除 / 安装依赖 /
    // 打开目录收进每张环境卡右上角的横向三点菜单；右侧一列三颗按钮：新建空白环境、
    // 桥接插件（恒装在 web 上）、补丁层，后两颗各自弹浮窗。
    const profileCards = $<HTMLElement>("profile-cards");
    const profileNote = $<HTMLParagraphElement>("profile-note");
    const profileError = $<HTMLParagraphElement>("profile-error");
    // 非 Windows 宿主把整卡内容收起、只留一条说明（同集成卡的 .cli-windows-only）。
    const profilesWindowsOnly = $<HTMLElement>("profiles-windows-only");
    const profilesContent = $<HTMLElement>("profiles-content");
    const pluginSummary = $<HTMLSpanElement>("plugin-summary");
    const btnProfileCreate = $<HTMLButtonElement>("btn-profile-create");
    const btnBridge = $<HTMLButtonElement>("btn-bridge");
    const envMenu = $<HTMLElement>("env-menu");

    /** 后端枚举回来的全部环境（含不能起网页的：照样列出来，只是标一句）。 */
    let profileList: ProfileSummary[] = [];
    /** 当前宿主能不能枚举环境；false 时环境卡收起并只说这一件事。 */
    let profilesSupported = true;

    const profileOf = (name: string): ProfileSummary | null =>
      profileList.find((item) => item.name === name) ?? null;

    /** 环境大按钮上的小标签：启动用 / 依赖状态 / 能不能起网页。 */
    function envMarks(item: ProfileSummary): string[] {
      const marks: string[] = [];
      if (item.name === START_PROFILE) {
        marks.push("启动用");
      }
      if (!item.depsInstalled) {
        marks.push("依赖未安装");
      }
      if (!item.webCapable) {
        marks.push("不能起网页");
      }
      return marks;
    }

    /** 一排环境大按钮：点卡片切管理目标，点右上角三点展开操作菜单；
     *  查过更新的环境再挂一枚「可更新插件数」微标（.btn-badge，样式见 90-modals.css）。 */
    function renderEnvCards(): void {
      if (!profilesSupported) {
        profileCards.innerHTML = "";
        return;
      }
      if (profileList.length === 0) {
        profileCards.innerHTML = `<p class="hint">还没读到任何环境；先启动一次 DSH 会创建默认的 web 环境。</p>`;
        return;
      }
      profileCards.innerHTML = profileList
        .map((item) => {
          const active = item.name === prefs.profile ? " is-active" : "";
          const marks = envMarks(item);
          const marksHtml =
            marks.length > 0 ? `<span class="env-card-marks">${marks.join(" · ")}</span>` : "";
          // 该环境最近一次检查得到的可更新插件数：>0 才画微标，没查过或为 0 都不显示。
          const pending = pluginUpdateCounts.get(item.name) ?? 0;
          const badgeHtml =
            pending > 0
              ? `<span class="btn-badge${pending > 99 ? " is-dense" : ""}" aria-hidden="true">${countBadgeText(pending)}</span>`
              : "";
          return `<div class="env-card${active}" data-env="${escapeHtml(item.name)}">
            <button class="env-card-main" type="button" data-env-pick="${escapeHtml(item.name)}">
              <span class="env-card-name">${escapeHtml(item.name)}</span>
              <span class="env-card-meta">${item.plugins} 个插件</span>
              ${marksHtml}
            </button>
            ${badgeHtml}
            <button class="env-more" type="button" title="环境操作" aria-label="环境操作" aria-haspopup="menu" aria-expanded="false" data-env-more="${escapeHtml(item.name)}">${ICON_MORE}</button>
          </div>`;
        })
        .join("");
      for (const pick of profileCards.querySelectorAll<HTMLButtonElement>("[data-env-pick]")) {
        pick.addEventListener("click", () => {
          void selectProfile(pick.dataset.envPick ?? "");
        });
      }
      for (const more of profileCards.querySelectorAll<HTMLButtonElement>("[data-env-more]")) {
        more.addEventListener("click", (event) => {
          // 别让这一下冒到 document 上，否则刚开就被「点外面关闭」收掉。
          event.stopPropagation();
          toggleEnvMenu(more.dataset.envMore ?? "", more);
        });
      }
    }

    /** 插件卡的徽章跟着选中的环境走：一眼看出开关作用在哪个环境、启用了几项。
     *  计数与下面的列表同口径（只数壳管得了的那些插件），否则徽章报 16、列表只有 12 行，
     *  看上去像有插件丢了；清单还没回来时宁可说「正在读取」也不报 0。 */
    function renderPluginSummary(): void {
      const target = profileOf(prefs.profile);
      if (!target) {
        pluginSummary.textContent = "未选中环境";
        pluginSummary.className = "badge badge-stopped panel-badge";
        return;
      }
      const rows = manageablePlugins();
      const on = rows.filter((item) => item.enabled).length;
      const count = pluginLoaded ? `已启用 ${on}/${rows.length} 个插件` : "正在读取插件清单…";
      const updates = pluginUpdatesChecked
        ? ` · ${pluginUpdateItems.filter((item) => item.hasUpdate).length} 个可更新`
        : "";
      pluginSummary.textContent = `${target.name} · ${count}${updates}`;
      pluginSummary.className = `badge ${target.depsInstalled ? "badge-running" : "badge-stopped"} panel-badge`;
    }

    function setProfileNote(text: string | null): void {
      if (!text) {
        profileNote.textContent = "";
        profileNote.classList.add("hidden");
        return;
      }
      profileNote.textContent = text;
      profileNote.classList.remove("hidden");
    }

    function renderProfilesUI(): void {
      // 不支持的环境下收起整卡内容，只留一条「仅在 Windows 宿主可用」的说明，
      // 免得看到一排永远为空的环境按钮还以为环境全丢了。
      profilesWindowsOnly.classList.toggle("hidden", profilesSupported);
      profilesContent.classList.toggle("hidden", !profilesSupported);
      renderEnvCards();
      renderPluginSummary();
    }

    async function loadProfiles(): Promise<void> {
      try {
        const listing = await invoke<ProfileListing>("list_profiles", { config: collectConfig() });
        profilesSupported = listing.supported;
        profileList = listing.profiles;
        profileError.classList.add("hidden");
      } catch (err) {
        // 读取失败不等于不支持：把失败原因如实反映出来，卡内容照旧展开，
        // 免得把一次暂时读盘失败说成「这个平台不支持」。
        profilesSupported = true;
        profileList = [];
        profileError.textContent = `读取环境列表失败：${err}`;
        profileError.classList.remove("hidden");
      }
      renderProfilesUI();
      // 插件卡与补丁层浮窗看的也是这份清单，重读后一起刷新。
      renderManageUI();
    }

    /** 切管理目标：写配置 → 换插件清单。不重启、不打断正在跑的会话（启动恒用 web）。 */
    async function selectProfile(name: string): Promise<void> {
      if (!name || name === prefs.profile) {
        return;
      }
      profileError.classList.add("hidden");
      setProfileNote(null);
      prefs = { ...prefs, profile: name };
      renderProfilesUI();
      // 配置里记的是「下次打开还是它」，所以必须落盘；后端插件操作也从这里读。
      await persistConfigQuiet();
      // 插件与补丁层跟着换：清掉旧缓存让它重新拉一次。
      pluginLoadedFor = null;
      patchLoadedFor = null;
      renderManageUI();
      if (currentStatus?.state === "running" && name !== START_PROFILE) {
        setProfileNote(
          `正在跑的会话仍是 web 环境（启动恒用 web）；这里切的是插件与补丁层的管理对象。`,
        );
      }
    }

    // ---- 环境操作菜单：重命名 / 复制 / 删除 / 安装依赖 / 打开目录 ----------------
    /** 菜单当前操作的环境；null 表示菜单是收起的。 */
    let envMenuTarget: string | null = null;

    function closeEnvMenu(): void {
      if (envMenuTarget === null) {
        return;
      }
      envMenuTarget = null;
      envMenu.classList.add("hidden");
      for (const btn of profileCards.querySelectorAll<HTMLElement>("[data-env-more]")) {
        btn.setAttribute("aria-expanded", "false");
      }
    }

    /** 某个环境卡上的三点按钮；卡片重建（切换环境）后按环境名找回新的一颗。 */
    function envMoreButton(name: string | null): HTMLElement | null {
      if (!name) {
        return null;
      }
      for (const btn of profileCards.querySelectorAll<HTMLElement>("[data-env-more]")) {
        if (btn.dataset.envMore === name) {
          return btn;
        }
      }
      return null;
    }

    /** 在三点按钮旁边展开菜单；靠视口边缘时往回收，别被窗口裁掉。 */
    function toggleEnvMenu(name: string, anchor: HTMLElement): void {
      const already = envMenuTarget === name;
      closeEnvMenu();
      if (already || !name) {
        return;
      }
      envMenuTarget = name;
      envMenu.classList.remove("hidden");
      anchor.setAttribute("aria-expanded", "true");
      const rect = anchor.getBoundingClientRect();
      const width = envMenu.offsetWidth;
      const height = envMenu.offsetHeight;
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      // 下方放不下就往上翻，避免贴着窗口底边被裁。
      const below = rect.bottom + 6;
      const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
      envMenu.style.left = `${Math.round(left)}px`;
      envMenu.style.top = `${Math.round(top)}px`;
      // 不能管理的项置灰：web 是启动用的环境，当前正管理的那个也不能删。
      const target = profileOf(name);
      const isWeb = name === START_PROFILE;
      for (const item of envMenu.querySelectorAll<HTMLButtonElement>("[data-env-act]")) {
        const act = item.dataset.envAct;
        const disabled =
          (act === "delete" && (isWeb || name === prefs.profile)) ||
          (act === "deps" && target === null);
        item.disabled = disabled;
        item.title = disabled
          ? act === "delete"
            ? isWeb
              ? "web 是启动 DSH 用的环境，不能删"
              : "这是当前正管理的环境，先在上面选一个别的再删"
            : "这个环境已经不在清单里了"
          : "";
      }
    }

    for (const item of envMenu.querySelectorAll<HTMLButtonElement>("[data-env-act]")) {
      item.addEventListener("click", () => {
        const name = envMenuTarget;
        const act = item.dataset.envAct ?? "";
        // 菜单一收起，里面点的这一项就不可见了：先把焦点还给这颗三点按钮，
        // 浮窗关闭时才有个「刚才点的位置」可回（见 setModal 的 modalReturnFocus）。
        envMoreButton(name)?.focus();
        closeEnvMenu();
        if (!name) {
          return;
        }
        if (act === "rename") {
          openNameModal("rename", name, envMoreButton(name));
        } else if (act === "copy") {
          openNameModal("copy", name, envMoreButton(name));
        } else if (act === "delete") {
          openNameModal("delete", name, envMoreButton(name));
        } else if (act === "deps") {
          void runEnvAction(() => installDeps(name));
        } else if (act === "patch") {
          // 补丁层是「按环境」的：先把管理目标切到这一个，再开浮窗（浮窗自己会去拉它的备份）。
          // 切换会重建环境卡，所以要等切完再按环境名取那颗新的三点按钮当焦点归处。
          void selectProfile(name).then(() => {
            syncPatchModal();
            setModal("patch", envMoreButton(name));
          });
        } else if (act === "open") {
          void openProfileDir(name);
        }
      });
    }

    // ---- 浮窗层：桥接插件 / 补丁层 / 环境名输入 --------------------------------
    const modalScrim = $<HTMLElement>("modal-scrim");
    const modalBridge = $<HTMLElement>("modal-bridge");
    const modalPatch = $<HTMLElement>("modal-patch");
    const modalName = $<HTMLElement>("modal-name");
    const modalNameTitle = $<HTMLElement>("modal-name-title");
    type ModalId = "bridge" | "patch" | "name";
    let openModal: ModalId | null = null;
    /** 打开浮窗前焦点所在的元素：关闭时把焦点还回去，键盘用户才不会被丢在页面顶部。 */
    let modalReturnFocus: HTMLElement | null = null;
    /** 等出场动画播完的定时器；期间再打开浮窗要把它取消掉。 */
    let modalCloseTimer: number | null = null;

    /** 浮窗内可聚焦的控件（用于初始聚焦与 Tab 兜圈）。 */
    function focusablesIn(container: HTMLElement): HTMLElement[] {
      const nodes = container.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      return Array.from(nodes).filter(
        (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
      );
    }

    function panelOf(id: ModalId): HTMLElement {
      return id === "bridge" ? modalBridge : id === "patch" ? modalPatch : modalName;
    }

    /** 本机偏好关掉动效时，进出场应当瞬时完成，不再等出场那 130ms。 */
    function motionOff(): boolean {
      return document.documentElement.dataset.motion === "off";
    }

    /** 出场动画时长：直接读 --m-exit，避免 JS 里再写一份毫秒数。
     *  浏览器把计算后的 <time> 序列化成秒（"0.13s"），不是变量里写的 "130ms"，
     *  所以按单位换算，别把 0.13 当毫秒用。 */
    function modalExitMs(): number {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--m-exit").trim();
      const value = Number.parseFloat(raw);
      if (!Number.isFinite(value) || value <= 0) {
        return 130;
      }
      return raw.endsWith("ms") ? value : value * 1000;
    }

    function clearModalClose(): void {
      if (modalCloseTimer !== null) {
        window.clearTimeout(modalCloseTimer);
        modalCloseTimer = null;
      }
      for (const panel of [modalBridge, modalPatch, modalName]) {
        panel.classList.remove("is-closing");
      }
      modalScrim.classList.remove("is-closing");
    }

    /** 出场播完（或动效关闭）后才真正隐藏，display:none 不会截断动画。 */
    function finishModalClose(): void {
      modalCloseTimer = null;
      modalReturnFocus = null;
      for (const panel of [modalBridge, modalPatch, modalName]) {
        panel.classList.add("hidden");
        panel.classList.remove("is-closing");
      }
      modalScrim.classList.add("hidden");
      modalScrim.classList.remove("is-closing");
    }

    /** 取出关闭后该还回去的焦点控件；卡片重建过就按环境名找回那颗三点按钮。 */
    function takeModalReturnFocus(): HTMLElement | null {
      const back = modalReturnFocus;
      modalReturnFocus = null;
      if (back?.isConnected) {
        return back;
      }
      return envMoreButton(back?.dataset.envMore ?? null) ?? back;
    }

    function setModal(id: ModalId | null, returnFocus?: HTMLElement | null): void {
      if (id !== null) {
        // 打开（或从一张浮窗换到另一张）：取消还在跑的出场，再换显示的那张。
        clearModalClose();
        const wasOpen = openModal !== null;
        openModal = id;
        modalBridge.classList.toggle("hidden", id !== "bridge");
        modalPatch.classList.toggle("hidden", id !== "patch");
        modalName.classList.toggle("hidden", id !== "name");
        modalScrim.classList.remove("hidden");
        // 打开：把焦点送进浮窗第一颗按钮，并记住打开前的焦点。
        // 调用方可以显式指定归处：从三点菜单打开时，那颗按钮在切换环境后会被重建。
        if (!wasOpen) {
          modalReturnFocus =
            returnFocus ??
            (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        }
        const panel = panelOf(id);
        const first = focusablesIn(panel)[0] ?? panel;
        first.focus();
        return;
      }
      // 关闭：先让出场动画播完，再真正隐藏（.hidden 是瞬时的，会截断动画）。
      closeEnvMenu();
      if (openModal === null && modalCloseTimer === null) {
        return;
      }
      if (openModal !== null) {
        const panel = panelOf(openModal);
        openModal = null;
        panel.classList.add("is-closing");
        modalScrim.classList.add("is-closing");
      }
      const back = takeModalReturnFocus();
      if (back?.isConnected) {
        back.focus();
      }
      if (motionOff()) {
        finishModalClose();
        return;
      }
      if (modalCloseTimer !== null) {
        window.clearTimeout(modalCloseTimer);
      }
      modalCloseTimer = window.setTimeout(finishModalClose, modalExitMs());
    }

    // 焦点圈在打开着的浮窗里：Tab / Shift+Tab 到首尾时折返，不会跑到浮窗背后的页面上。
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Tab" || openModal === null) {
        return;
      }
      const panel =
        openModal === "bridge"
          ? modalBridge
          : openModal === "patch"
            ? modalPatch
            : modalName;
      const items = focusablesIn(panel);
      if (items.length === 0) {
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    });

    modalScrim.addEventListener("click", () => setModal(null));
    for (const close of root.querySelectorAll<HTMLButtonElement>("[data-modal-close]")) {
      close.addEventListener("click", () => setModal(null));
    }
    // 捕获阶段处理 Esc：先关浮窗，且不再让底下「按 Esc 收日志」那一条跟着动。
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") {
          return;
        }
        if (openModal !== null) {
          event.stopPropagation();
          setModal(null);
        } else if (envMenuTarget !== null) {
          event.stopPropagation();
          closeEnvMenu();
        }
      },
      true,
    );
    // 点菜单与浮窗以外的地方收起菜单。
    document.addEventListener("click", () => closeEnvMenu());

    btnBridge.addEventListener("click", () => {
      void refreshBridgeState();
      setModal("bridge");
    });

    // ---- 环境名输入：新建 / 重命名 / 复制 / 删除确认 ---------------------------
    // 四个动作的规则（名字合法性、哪些不能删、依赖目录与锁文件不跟着复制）全在后端，
    // 界面只负责弹输入框收集名字、转述后端那句中文说明、重读列表。
    const profileManageName = $<HTMLInputElement>("profile-manage-name");
    const profileManageNote = $<HTMLParagraphElement>("profile-manage-note");
    const profileManageError = $<HTMLParagraphElement>("profile-manage-error");
    const profileManageConfirm = $<HTMLElement>("profile-manage-confirm");
    const profileManageConfirmText = $<HTMLParagraphElement>("profile-manage-confirm-text");
    const nameInputRow = $<HTMLElement>("profile-manage-name-row");
    const btnNameConfirm = $<HTMLButtonElement>("btn-name-confirm");
    const btnNameCancel = $<HTMLButtonElement>("btn-name-cancel");

    type NameMode = "create" | "rename" | "copy" | "delete";
    let nameMode: NameMode = "create";
    /** 重命名 / 复制 / 删除针对的环境；新建时为 null。 */
    let nameTarget: string | null = null;
    /** 正在跑的环境动作（忙时按钮置灰，防重复提交）。 */
    let manageBusy = false;

    /** 后端返回值：与 Rust 侧 `profile_ops::ProfileOutcome` 对应。 */
    interface ProfileOutcome {
      ok: boolean;
      message: string;
      name: string;
      summary: ProfileSummary | null;
    }

    function setManageNote(text: string | null): void {
      if (!text) {
        profileManageNote.textContent = "";
        profileManageNote.classList.add("hidden");
        return;
      }
      profileManageNote.textContent = text;
      profileManageNote.classList.remove("hidden");
    }

    function setManageError(text: string | null): void {
      if (!text) {
        profileManageError.textContent = "";
        profileManageError.classList.add("hidden");
        return;
      }
      profileManageError.textContent = text;
      profileManageError.classList.remove("hidden");
    }

    /** 打开名字浮窗：新建收集新名字，重命名/复制预填旧名字，删除只做确认。
     *  `returnFocus` 是关闭后焦点该回去的控件（三点菜单触发时显式传入）。 */
    function openNameModal(
      mode: NameMode,
      target: string | null,
      returnFocus?: HTMLElement | null,
    ): void {
      nameMode = mode;
      nameTarget = target;
      // 命名规则与环境切分说明只在新建时可讲：卡里不再常驻这段说明，但也不能让人盲填。
      setManageNote(
        mode === "create"
          ? "环境名只能用字母、数字和 - _ .，且以字母或数字开头。启动 DSH 始终用 web 环境；选中别的环境只是把插件与补丁层的管理对象切过去。"
          : null,
      );
      setManageError(null);
      const deleting = mode === "delete";
      // 删除是危险动作：整张浮窗染成危险色（描边 + 淡底），让人一眼看出这次不是普通的改名。
      modalName.classList.toggle("modal-danger", deleting);
      nameInputRow.classList.toggle("hidden", deleting);
      profileManageConfirm.classList.toggle("hidden", !deleting);
      if (deleting && target) {
        profileManageConfirmText.textContent = `确定删除环境「${target}」？目录与里面的插件配置会被一起删掉，这个操作没法撤销。`;
      }
      modalNameTitle.textContent =
        mode === "create"
          ? "新建空白环境"
          : mode === "rename"
            ? "重命名环境"
            : mode === "copy"
              ? "复制环境"
              : "删除环境";
      profileManageName.value = mode === "rename" && target ? target : "";
      profileManageName.placeholder = mode === "create" ? "例如 lab" : `把「${target ?? ""}」改成…`;
      profileManageName.disabled = manageBusy;
      btnNameConfirm.textContent = deleting ? "确定删除" : "确定";
      btnNameConfirm.classList.toggle("danger", deleting);
      btnNameConfirm.classList.toggle("primary", !deleting);
      btnNameCancel.disabled = manageBusy;
      setModal("name", returnFocus);
      if (deleting) {
        // 删除是危险动作：默认焦点不落在「确定删除」上，落在「取消」，
        // 回车不会顺手把环境删掉。
        btnNameCancel.focus();
      } else {
        profileManageName.focus();
        profileManageName.select();
      }
    }

    /**
     * 跑一个环境动作：清提示 → 置忙 → 调后端 → 转述结果 → 重读列表。
     *
     * `reloadPrefs` 用于重命名：后端可能已经把配置里的环境名改掉了，界面必须重读，
     * 否则下一次保存配置会把旧名字写回去。
     */
    async function runEnvAction(
      action: () => Promise<ProfileOutcome>,
      options: { reloadPrefs?: boolean; output?: boolean } = {},
    ): Promise<void> {
      if (manageBusy) {
        return;
      }
      manageBusy = true;
      setManageError(null);
      setManageNote(null);
      btnNameConfirm.disabled = true;
      btnNameCancel.disabled = true;
      profileManageName.disabled = true;
      try {
        const outcome = await action();
        if (options.output) {
          // 重装依赖的说明里有命令原文、退出码与输出尾部，整段贴进日志浮层；
          // 界面上只留一句结论，否则一行提示会被几百行输出撞长。
          logAction(outcome.message);
          if (outcome.ok) {
            setModal(null);
            void appendSystemNote(`环境「${outcome.name}」的依赖已就绪。`);
          } else {
            setManageError(
              `重装依赖没有完成（环境「${outcome.name}」）：命令原文、退出码与输出尾部都在日志浮层里。`,
            );
          }
        } else if (outcome.ok) {
          setModal(null);
          void appendSystemNote(outcome.message);
          // 新建/复制/重命名/删除的结果：浮窗一收就没别的地方能看到了，补一条回执。
          // 成功与失败都回执——没做成也要让人知道，浮窗里的红字照旧留着说明原因。
          showToast(outcome.message, "ok");
        } else {
          setManageError(outcome.message);
          showToast(outcome.message, "error");
        }
        // 新建/复制/重命名都会改变清单，删掉的更得重读：一律重读一次。
        // 重装依赖同样可能让插件数从零变成若干，插件清单也得重新拉。
        pluginLoadedFor = null;
        patchLoadedFor = null;
        await loadProfiles();
        if (options.reloadPrefs) {
          await reloadPrefsFromDisk();
        }
      } catch (err) {
        setManageError(String(err));
        showToast(`环境操作没有完成：${String(err)}`, "error");
      } finally {
        manageBusy = false;
        btnNameConfirm.disabled = false;
        btnNameCancel.disabled = false;
        profileManageName.disabled = false;
        renderManageUI();
      }
    }

    /** 环境动作的一句话结果：静默写进日志，不切分区（新的几行由左栏未读数字提示）。 */
    function appendSystemNote(text: string): void {
      appendLog([text], true);
    }

    async function createProfile(name: string): Promise<ProfileOutcome> {
      return invoke<ProfileOutcome>("create_profile", { config: collectConfig(), name });
    }

    async function copyProfile(source: string, name: string): Promise<ProfileOutcome> {
      return invoke<ProfileOutcome>("copy_profile", { config: collectConfig(), source, name });
    }

    async function renameProfile(oldName: string, name: string): Promise<ProfileOutcome> {
      return invoke<ProfileOutcome>("rename_profile", { config: collectConfig(), oldName, name });
    }

    async function deleteProfile(name: string): Promise<ProfileOutcome> {
      return invoke<ProfileOutcome>("delete_profile", { config: collectConfig(), name });
    }

    /** 重装依赖：几分钟起步，先给一句「别关窗口」再发命令。 */
    async function installDeps(name: string): Promise<ProfileOutcome> {
      setPluginNote(`正在给「${name}」重装依赖，可能要几分钟…（期间请不要关窗口）`);
      void appendSystemNote(`环境「${name}」：开始重装依赖…`);
      return invoke<ProfileOutcome>("install_profile_deps", { config: collectConfig(), name });
    }

    /** 打开某个环境自己的目录（宿主与 WSL 下的路径都由后端拼，前端算不出来）。 */
    async function openProfileDir(name: string): Promise<void> {
      try {
        const dir = await invoke<string>("open_shell_dir", { kind: "profile", profile: name });
        void appendSystemNote(`已在资源管理器中打开环境「${name}」的目录：${dir}`);
      } catch (err) {
        void appendSystemNote(`打开环境「${name}」的目录失败：${String(err)}`);
      }
    }

    btnProfileCreate.addEventListener("click", () => {
      if (manageBusy) {
        return;
      }
      openNameModal("create", null);
    });

    btnNameCancel.addEventListener("click", () => setModal(null));

    btnNameConfirm.addEventListener("click", () => {
      if (manageBusy) {
        return;
      }
      const name = profileManageName.value.trim();
      if (nameMode === "delete") {
        const target = nameTarget;
        if (!target) {
          return;
        }
        void runEnvAction(() => deleteProfile(target));
        return;
      }
      if (name === "") {
        setManageError("先填一个环境名。");
        profileManageName.focus();
        return;
      }
      if (nameMode === "create") {
        void runEnvAction(() => createProfile(name));
        return;
      }
      const target = nameTarget;
      if (!target) {
        return;
      }
      if (nameMode === "copy") {
        void runEnvAction(() => copyProfile(target, name));
        return;
      }
      void runEnvAction(() => renameProfile(target, name), { reloadPrefs: true });
    });

    profileManageName.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      btnNameConfirm.click();
    });

    /** 配置里的环境名可能被后端改过（重命名/删除），重读一遍再回写界面。 */
    async function reloadPrefsFromDisk(): Promise<void> {
      try {
        const saved = await invoke<ShellConfig>("load_shell_config");
        prefs = normalizePrefs(saved);
        renderProfilesUI();
      } catch (err) {
        setManageError(`重读配置失败：${err}`);
      }
    }

    // ---- 补丁层浮窗 ------------------------------------------------------------
    // 规则（文件名、保留份数、还原前另存与说明文案）全在后端 `patch_layer` 里算，
    // 界面只负责：对选中的那个环境发命令、把备份列表列出来、把说明原文贴出来。
    const patchTargetEl = $<HTMLElement>("patch-target");
    const patchBackupList = $<HTMLElement>("patch-backup-list");
    const btnPatchBackup = $<HTMLButtonElement>("btn-patch-backup");
    const patchRestoreConfirm = $<HTMLElement>("patch-restore-confirm");
    const patchRestoreConfirmText = $<HTMLParagraphElement>("patch-restore-confirm-text");
    const btnPatchConfirmYes = $<HTMLButtonElement>("btn-patch-confirm-yes");
    const btnPatchConfirmNo = $<HTMLButtonElement>("btn-patch-confirm-no");
    const patchNote = $<HTMLParagraphElement>("patch-note");
    const patchError = $<HTMLParagraphElement>("patch-error");

    /** 与 Rust 侧 `patch_layer::PatchBackup` 对应（最旧在前）。 */
    interface PatchBackup {
      name: string;
      path: string;
      stamp: number;
    }

    /** 与 Rust 侧 `patch::PatchOutcome` 对应。 */
    interface PatchOutcome {
      message: string;
      path: string;
      backups: PatchBackup[];
    }

    /** 当前管理环境的补丁层备份（最旧在前，与后端返回顺序一致）。 */
    let patchBackups: PatchBackup[] = [];
    /** 补丁层动作是否在跑（忙时按钮置灰，防重复提交）。 */
    let patchBusy = false;
    /** 已拉取备份清单的那个环境；换环境才重新拉，避免每次渲染都打一趟后端。 */
    let patchLoadedFor: string | null = null;
    /** 待确认的还原目标（备份文件名）；非 null 时确认行展开。 */
    let patchPendingRestore: string | null = null;

    function setPatchNote(text: string | null): void {
      if (!text) {
        patchNote.textContent = "";
        patchNote.classList.add("hidden");
        return;
      }
      patchNote.textContent = text;
      patchNote.classList.remove("hidden");
    }

    function setPatchError(text: string | null): void {
      if (!text) {
        patchError.textContent = "";
        patchError.classList.add("hidden");
        return;
      }
      patchError.textContent = text;
      patchError.classList.remove("hidden");
    }

    /** 备份时间戳（unix 秒）→ 本地时间文本；文件名里就是它，用户能对着看。 */
    function stampLabel(stamp: number): string {
      const date = new Date(stamp * 1000);
      const pad = (value: number): string => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** 备份清单：最新的在最上面，每行能直接点「还原」；路径原文照抄，方便自己去翻。 */
    function renderPatchList(): void {
      if (patchBackups.length === 0) {
        patchBackupList.innerHTML = `<p class="hint notice">这个环境还没有补丁层备份。改补丁层之前先点「备份补丁层」留个底。</p>`;
        return;
      }
      const newest = patchBackups[patchBackups.length - 1]?.name ?? "";
      patchBackupList.innerHTML = [...patchBackups]
        .reverse()
        .map((item) => {
          const tag = item.name === newest ? `<span class="profile-manage-tag">最新</span>` : "";
          const disabled = patchBusy || manageBusy ? " disabled" : "";
          return `<div class="patch-backup-row"><span class="patch-backup-time">${stampLabel(item.stamp)}</span><span class="patch-backup-path">${escapeHtml(item.path)}</span>${tag}<button type="button" class="kv-action" data-patch-restore="${escapeHtml(item.name)}"${disabled}>还原这一份</button></div>`;
        })
        .join("");
      for (const button of patchBackupList.querySelectorAll<HTMLButtonElement>("[data-patch-restore]")) {
        button.addEventListener("click", () => {
          // 第一下只展开确认行；真正改文件要再点一次「确定还原」。
          patchPendingRestore = button.dataset.patchRestore ?? "";
          setPatchError(null);
          setPatchNote(null);
          syncPatchModal();
        });
      }
    }

    /** 补丁层浮窗跟着当前管理的环境走；换环境才拉一次备份清单。 */
    function syncPatchModal(): void {
      const target = profileOf(prefs.profile);
      patchTargetEl.textContent = target ? target.name : "—";
      // 还原确认行：有待确认的目标才展开，并把「覆盖哪一份、能不能反悔」说清楚。
      const pending = patchPendingRestore;
      patchRestoreConfirm.classList.toggle("hidden", pending === null);
      if (pending !== null) {
        patchRestoreConfirmText.textContent = `确定把补丁层还原成「${pending}」？这会覆盖当前那份 cordis.patch.yml（现有内容会先另存一份备份，改坏了还能再退回来）。`;
      }
      if (!target) {
        patchBackups = [];
        patchLoadedFor = null;
        renderPatchList();
        return;
      }
      if (patchLoadedFor !== target.name) {
        patchLoadedFor = target.name;
        patchBackups = [];
        renderPatchList();
        void refreshPatchBackups(target.name);
        return;
      }
      renderPatchList();
    }

    /** 读一次备份清单（读失败只提示，不打断其它动作）。 */
    async function refreshPatchBackups(name: string): Promise<void> {
      try {
        const list = await invoke<PatchBackup[]>("patch_backups", { config: collectConfig(), name });
        if (prefs.profile !== name) {
          return; // 期间换了环境，丢弃这批结果
        }
        patchBackups = list;
        renderPatchList();
      } catch (err) {
        if (prefs.profile === name) {
          setPatchError(`读取补丁层备份失败：${String(err)}`);
        }
      }
    }

    /** 备份补丁层：成功与否都要落地一句原文（含路径），失败原因不吞。 */
    async function backupPatchLayer(): Promise<void> {
      const name = prefs.profile;
      if (!name || patchBusy || manageBusy) {
        return;
      }
      patchBusy = true;
      setPatchError(null);
      setPatchNote(null);
      syncPatchModal();
      try {
        const outcome = await invoke<PatchOutcome>("patch_backup", { config: collectConfig(), name });
        patchBackups = outcome.backups;
        patchLoadedFor = name;
        setPatchNote(outcome.message);
        logAction(outcome.message);
      } catch (err) {
        setPatchError(String(err));
        logAction(`备份补丁层失败：${String(err)}`);
      } finally {
        patchBusy = false;
        syncPatchModal();
      }
    }

    /**
     * 还原到某一份备份。
     *
     * 会覆盖当前的补丁层文件，所以界面上先要一次确认：后端覆盖前会把当前版本另存一份
     * 备份，因此这一步可反悔，但那不等于不用问。
     */
    async function restorePatchLayer(backup: string): Promise<void> {
      const name = prefs.profile;
      if (!name || !backup || patchBusy || manageBusy) {
        return;
      }
      patchPendingRestore = null;
      patchBusy = true;
      setPatchError(null);
      setPatchNote(null);
      syncPatchModal();
      try {
        const outcome = await invoke<PatchOutcome>("patch_restore", {
          config: collectConfig(),
          name,
          backup,
        });
        patchBackups = outcome.backups;
        patchLoadedFor = name;
        setPatchNote(outcome.message);
        logAction(outcome.message);
      } catch (err) {
        setPatchError(String(err));
        logAction(`还原补丁层失败：${String(err)}`);
      } finally {
        patchBusy = false;
        syncPatchModal();
      }
    }

    btnPatchBackup.addEventListener("click", () => {
      void backupPatchLayer();
    });

    // 还原分两拍：第一下点备份行只展开确认行，这里才真的改文件。
    btnPatchConfirmYes.addEventListener("click", () => {
      const backup = patchPendingRestore;
      if (!backup) {
        return;
      }
      void restorePatchLayer(backup);
    });

    btnPatchConfirmNo.addEventListener("click", () => {
      patchPendingRestore = null;
      syncPatchModal();
    });

    // ---- 插件开关 --------------------------------------------------------------
    // 哪些插件、现在开没开、该往补丁层写什么，规则全在后端
    // （dsharbor_core::plugin_switch）。界面只负责：列出来、发开关命令、把后端
    // 那句中文说明与提醒原文贴出来。
    const profilePluginPanel = $<HTMLElement>("profile-plugins");
    const pluginList = $<HTMLElement>("plugin-list");
    const pluginEmpty = $<HTMLElement>("plugin-empty");
    const pluginNote = $<HTMLParagraphElement>("plugin-note");
    const pluginWarning = $<HTMLParagraphElement>("plugin-warning");
    const btnPluginDeps = $<HTMLButtonElement>("btn-plugin-deps");
    const btnPluginCheckUpdates = $<HTMLButtonElement>("btn-plugin-check-updates");
    const btnPluginUpdateAll = $<HTMLButtonElement>("btn-plugin-update-all");
    const btnUpdateAllBadge = $<HTMLSpanElement>("plugin-update-all-badge");
    const pluginProgress = $<HTMLElement>("plugin-progress");
    const pluginProgressBar = $<HTMLElement>("plugin-progress-bar");
    const pluginProgressSum = $<HTMLParagraphElement>("plugin-progress-sum");

    /** 与 Rust 侧 `plugin_switch::PluginItem` 对应。 */
    interface PluginItem {
      name: string;
      entries: string[];
      enabled: boolean;
      bridge: boolean;
      manual: boolean;
      switchable: boolean;
      /** 插件自带的说明文字（后端从包 package.json 的 description 读的，读不到是 null）。 */
      description: string | null;
    }

    /** 与 Rust 侧 `plugin_switch::ToggleOutcome` 对应。 */
    interface ToggleOutcome {
      message: string;
      backup: string;
      warning: string | null;
      items: PluginItem[];
    }

    /** 当前管理环境实际加载的插件（后端顺序，与 package.json 里登记的顺序一致）。 */
    let pluginItems: PluginItem[] = [];
    /** 插件清单是否已拉过（未拉到时不能把空数组当成「零插件」画空状态）。 */
    let pluginLoaded = false;
    /** 已为哪个环境拉过清单；换环境才重新拉。 */
    let pluginLoadedFor: string | null = null;
    /** 骨架最短展示时长（毫秒）：清单回得再快也要站够，避免快网络下只闪一下。 */
    const PLUGIN_SKELETON_MIN_MS = 300;
    /** 是否在画骨架（清单还没回来）。读到结果（成功/失败/空清单）都要关掉它，
     *  否则骨架会一直挂在列表里冒充「还在加载」。 */
    let pluginSkeleton = false;
    /** 骨架最早可撤下的时刻（performance.now 时间戳）：清单回得再快也要站够最短展示，
     *  避免快网络下只闪一下，比不画还难看。 */
    let pluginSkeletonUntil = 0;
    /** 下一次重铺要不要给真实行挂入场标记。只在「骨架 → 真实行」那一次置真，用完即清，
     *  之后的重绘不带，免得每次重画都重播一遍入场。 */
    let pluginEnterPending = false;
    /** 插件开关动作是否在跑（忙时所有开关置灰，防重复提交）。 */
    let pluginBusy = false;

    /** 与 Rust 侧 `plugin_update::PluginUpdateItem` 对应。 */
    interface PluginUpdateItem {
      name: string;
      current: string | null;
      target: string | null;
      error: string | null;
      hasUpdate: boolean;
    }

    /** 与 Rust 侧 `plugin_update::UpdateOutcome` 对应。 */
    interface UpdateOutcome {
      ok: boolean;
      message: string;
      backupDir: string;
    }

    /**
     * 与 Rust 侧 `plugin_update::ProgressEvent` 对应：批量更新时后端逐个插件回放的进度。
     * 每个插件两条——`start`（开始动它）与 `done`（结果出来了）；单插件更新不走这里。
     */
    interface UpdateProgressEvent {
      phase: "start" | "done";
      /** 这一轮里的序号，从 1 起。 */
      index: number;
      /** 这一轮一共要更新几个。 */
      total: number;
      plugin: string;
      /** 仅 `done`：这一步成功与否。 */
      ok: boolean | null;
      /** 仅 `done`：成功是版本提示，失败是原因（首行）。 */
      message: string | null;
    }

    /** 行级更新状态：排队 → 更新中 → 已更新/失败。不在表里＝这一行没参与本轮。 */
    type UpdatePhase = "queue" | "busy" | "done" | "fail";

    /** 最近一次检查得到的更新清单（只含参与更新的第三方插件）。 */
    let pluginUpdateItems: PluginUpdateItem[] = [];
    /** 当前环境是否已检查过（没查过时行里不显示版本号，免得像「没有版本」）。 */
    let pluginUpdatesChecked = false;
    /** 每个环境最近一次检查得到的可更新插件数（键＝环境名）：环境卡微标按它显示。
     *  只在对应环境的检查/更新流程里写入；没查过或为 0 的环境没有微标。 */
    const pluginUpdateCounts = new Map<string, number>();

    /** 当前环境的可更新计数增减并刷新环境卡微标（没查过的环境不动）：
     *  更新动作成功一个就实时递减一枚，权威数字随后由重查回来的更新清单覆盖。 */
    function bumpPluginUpdateCount(delta: number): void {
      const current = pluginUpdateCounts.get(prefs.profile);
      if (current === undefined || current + delta < 0) {
        return;
      }
      pluginUpdateCounts.set(prefs.profile, current + delta);
      renderEnvCards();
    }
    /** 插件更新动作是否在跑（忙时更新按钮与开关全部置灰，防重复提交）。 */
    let pluginUpdateBusy = false;
    /** 这轮更新是不是「全部更新」发起的：只有它让工具条上那枚图标转起来，单行更新不转。 */
    let pluginUpdateRunningAll = false;
    /** 检查更新是否在跑（「检查更新」按钮发起的强制重查；进卡自动查不锁界面）。 */
    let pluginCheckBusy = false;
    /** 这一轮更新里每一行自己的状态（键＝插件名）。空着＝没有正在展示的更新轮次。 */
    let pluginUpdatePhases = new Map<string, { phase: UpdatePhase; message: string | null }>();
    /** 这一轮要更新几个／已完成几个（含失败）／失败几个：进度条与收尾汇总都按它们算。 */
    let pluginProgressTotal = 0;
    let pluginProgressDone = 0;
    let pluginProgressFailed = 0;
    /** 收尾汇总文案（null＝这一轮还没跑完，进度区显示进行中的已完成数）。 */
    let pluginProgressSummary: string | null = null;
    /** 刚落定成已更新／失败的那几行：接下来几次重画给小签挂一次性强调动画，
     *  到点自动出组。列表每次整块重画，纯 CSS 动画会跟着重画重演，
     *  所以「只演一次」由这组标记兜住，不靠样式记忆。 */
    const pluginFreshPhase = new Set<string>();

    /** 给刚出结果的小签挂一次性强调：0.9s 动画播完就出组，之后的重画不再挂。 */
    function markFreshPhase(name: string): void {
      pluginFreshPhase.add(name);
      window.setTimeout(() => pluginFreshPhase.delete(name), 1000);
    }

    /** 清掉上一轮的进度与行级状态（换环境、重新检查、开始新一轮时用）。 */
    function resetPluginProgress(): void {
      pluginUpdatePhases = new Map();
      pluginFreshPhase.clear();
      pluginProgressTotal = 0;
      pluginProgressDone = 0;
      pluginProgressFailed = 0;
      pluginProgressSummary = null;
    }

    /** 插件卡上还有没有别的动作在跑（检查更新或任意一轮更新）：
     *  是的话开关与更新按钮全部置灰——维护者要求这些操作互斥，做完才放开。 */
    function pluginActionBusy(): boolean {
      return pluginUpdateBusy || pluginCheckBusy;
    }

    /**
     * 插件清单：一行一个插件，右端一枚**总开关**（开/关整个插件）。
     *
     * 只列壳管得了的插件：官方内置的骨架包没有挂载点、写不进补丁层，桥接插件归
     * 「桥接插件」浮窗管——这两类列在这里也点不动，所以干脆不列（维护者要求）。
     */
    function manageablePlugins(): PluginItem[] {
      return pluginItems.filter((item) => item.switchable && !item.bridge);
    }

    /** 行提示：说清这枚开关管的是整个插件，并列出它写进补丁层的那些挂载点。 */
    function pluginRowTitle(item: PluginItem): string {
      const points = item.entries.length > 0 ? item.entries.join("、") : "（读不到挂载点）";
      const manual = item.manual
        ? "补丁层里这一项的禁用表达是手写的，拨开关会把它改成壳写的形式；"
        : "";
      return ` title="${escapeHtml(`总开关：停用整个「${item.name}」。它挂在 ${points}。${manual}改完要重启 DSH 才生效。`)}"`;
    }

    /** 该插件最近的检查结果（没查过、或不在更新范围——官方骨架包/桥接插件——就没有行）。 */
    function updateItemFor(name: string): PluginUpdateItem | null {
      return pluginUpdateItems.find((item) => item.name === name) ?? null;
    }

    /** 行级四态的中文标签：排队 / 更新中 / 已更新 / 失败。 */
    const updatePhaseLabel: Record<UpdatePhase, string> = {
      queue: "排队",
      busy: "更新中",
      done: "已更新",
      fail: "失败",
    };

    /** 这一行在本轮更新里的状态；没参与本轮返回 null。 */
    function updatePhaseFor(name: string): { phase: UpdatePhase; message: string | null } | null {
      return pluginUpdatePhases.get(name) ?? null;
    }

    /** 行标题里那枚状态胶囊：只在参与本轮更新的行上出现。 */
    function pluginPhaseChipHtml(name: string): string {
      const state = updatePhaseFor(name);
      if (!state) {
        return "";
      }
      return `<span class="plugin-phase plugin-phase-${state.phase}${pluginFreshPhase.has(name) ? " is-fresh" : ""}">${updatePhaseLabel[state.phase]}</span>`;
    }

    /** 失败行把原因留在行里（可读、可核对），成功行不占位。 */
    function pluginFailHtml(name: string): string {
      const state = updatePhaseFor(name);
      if (!state || state.phase !== "fail") {
        return "";
      }
      const reason = state.message ? `失败：${state.message}` : "失败：原因未知";
      return `<div class="plugin-fail" title="${escapeHtml(reason)}">${escapeHtml(reason)}</div>`;
    }

    /** 行标题里的版本徽章：查过更新才有；版本读不出来时亮「版本未知」。
     *  检查失败（registry 查不到/断网）必须露出来，不能只留版本号装没事——
     *  本地 tgz、私有包装的插件就落在这条分支上。 */
    function pluginVerBadgeHtml(item: PluginItem): string {
      if (!pluginUpdatesChecked) {
        return "";
      }
      const upd = updateItemFor(item.name);
      if (!upd) {
        return "";
      }
      if (upd.error && !upd.current) {
        return `<span class="plugin-ver plugin-ver-bad" title="${escapeHtml(upd.error)}">版本未知</span>`;
      }
      if (!upd.current) {
        return "";
      }
      const bad = upd.error
        ? `<span class="plugin-ver plugin-ver-bad" title="${escapeHtml(upd.error)}">检查失败</span>`
        : "";
      // 有更新：旧版本 → 新版本两枚徽章并列，新版本用绿色突出；目标版本同时收在
      // 「更新」按钮的气泡里，更新前后对比一眼可见。
      if (upd.hasUpdate && upd.target) {
        return `<span class="plugin-ver">v${escapeHtml(upd.current)}</span><span class="plugin-ver-arrow" aria-hidden="true">→</span><span class="plugin-ver plugin-ver-new" title="registry 上的最新版本">v${escapeHtml(upd.target)}</span>`;
      }
      return `<span class="plugin-ver">v${escapeHtml(upd.current)}</span>${bad}`;
    }

    /** 行里的「更新」按钮：有更新才出现；目标版本在新版本徽章与气泡里，点不点由维护者定。
     *  这一轮参与更新的行按状态改文案：排队/更新中置灰但不摘掉（互斥面要有可读的禁用态），
     *  已更新摘掉（没得再更），失败换成「重试」（失败行留着，能单独再跑一次）。 */
    function pluginUpdateCellHtml(item: PluginItem): string {
      const state = updatePhaseFor(item.name);
      if (state?.phase === "done") {
        return "";
      }
      if (state) {
        const busy = pluginActionBusy() || pluginBusy ? " disabled" : "";
        const upd = updateItemFor(item.name);
        const retry = state.phase === "fail";
        const label = retry ? "重试" : "更新";
        const hint = retry
          ? `重新更新「${item.name}」；失败原因在行内`
          : `把 ${item.name} 从 v${upd?.current ?? "?"} 更新到 v${upd?.target ?? "?"}`;
        return `<button class="plugin-update" type="button" data-plugin-update="${escapeHtml(item.name)}" title="${escapeHtml(hint)}"${busy}>${label}</button>`;
      }
      if (!pluginUpdatesChecked) {
        return "";
      }
      const upd = updateItemFor(item.name);
      if (!upd || !upd.hasUpdate || !upd.target) {
        return "";
      }
      const busy = pluginActionBusy() || pluginBusy ? " disabled" : "";
      return `<button class="plugin-update" type="button" data-plugin-update="${escapeHtml(item.name)}" title="把 ${escapeHtml(item.name)} 从 v${escapeHtml(upd.current ?? "?")} 更新到 v${escapeHtml(upd.target)}；更新前会自动备份，装完回读校验"${busy}>更新</button>`;
    }

    function pluginRowHtml(item: PluginItem, enterIndex = -1): string {
      // 只留「桥接」这一枚身份标签：开关本身已经说明启用与否，再写一遍「已启用/已停用」
      // 是同一件事说两次；「手写禁用」这点信息收进行提示，不占位。
      const marks = item.bridge ? `<span class="plugin-tag plugin-tag-bridge">桥接</span>` : "";
      // 描述是插件自己带的元信息（package.json 的 description），单行截断、悬停看全文；
      // 没有的包就不渲染这一行，行高随内容，不做假两行。
      const desc = item.description
        ? `<div class="plugin-desc" title="${escapeHtml(item.description)}">${escapeHtml(item.description)}</div>`
        : "";
      // 检查/更新进行中把开关也锁上（互斥）：正常开关忙态不锁——那条链路逐行重绘，锁
      // 整表会让别的行在开关结束后残留在禁用态。
      const lock = pluginActionBusy() ? " disabled" : "";
      const label = item.enabled ? "停用" : "启用";
      const state = updatePhaseFor(item.name);
      const phaseAttr = state ? ` data-phase="${state.phase}"` : "";
      // 入场序号：只在「骨架 → 真实行」那一次重铺里带上（enterIndex >= 0），序号既写进
      // `--i` 给 CSS 算错开的延迟，也写进 `data-enter` 当稳定的测试钩子；之后的重绘不带，
      // 不会每次重画都重播一遍入场。
      const enterAttr =
        enterIndex >= 0 ? ` style="--i:${enterIndex}" data-enter="${enterIndex}"` : "";
      return `<div class="plugin-row${item.enabled ? "" : " is-off"}" data-row="${escapeHtml(item.name)}"${phaseAttr}${enterAttr}${pluginRowTitle(item)}><div class="plugin-main"><div class="plugin-title"><span class="plugin-name">${escapeHtml(item.name)}</span>${marks}${pluginVerBadgeHtml(item)}${pluginPhaseChipHtml(item.name)}</div>${desc}${pluginFailHtml(item.name)}</div>${pluginUpdateCellHtml(item)}<button class="switch" type="button" role="switch" aria-checked="${item.enabled ? "true" : "false"}" aria-label="${label}${escapeHtml(item.name)}" title="${label}${escapeHtml(item.name)}" data-plugin="${escapeHtml(item.name)}"${lock}><span class="switch-knob"></span></button></div>`;
    }

    /** 一行骨架：左侧一个圆点（图标位）加长短两条灰条（标题与说明），右端一枚方条（开关位）。
     *  结构与真实行同高（`.plugin-row` 的 padding/border 照搬，主列固定 38px），切换时版面不跳。
     *  刻意不复用 `.plugin-row` 类：那是「真实插件行」的语义钩子（其它界面测试靠它判断
     *  清单是否读完），骨架顶上会让它们以为已经加载完了。 */
    function pluginSkeletonRowHtml(index: number): string {
      return `<div class="plugin-skel" data-skeleton="${index}" aria-hidden="true"><div class="sk-main"><span class="sk-dot"></span><span class="sk-line sk-line-name"></span><span class="sk-line sk-line-desc"></span></div><span class="sk-line sk-line-switch"></span></div>`;
    }

    function renderPluginList(): void {
      const rows = manageablePlugins();
      // 骨架只在「还没读到清单」时铺：读到空清单是空态，不是加载中。
      const showSkeleton = pluginSkeleton && !pluginLoaded;
      pluginEmpty.classList.toggle("hidden", rows.length > 0 || !pluginLoaded);
      // 整表重铺会重建每一行，先把滚动位置记下来再放回去，否则列表看着像跳了一下。
      const scrollTop = pluginList.scrollTop;
      if (showSkeleton) {
        pluginList.innerHTML = [0, 1, 2].map(pluginSkeletonRowHtml).join("");
        pluginList.classList.add("is-loading");
        pluginList.classList.remove("is-loaded");
        pluginList.scrollTop = scrollTop;
        renderPluginUpdatesToolbar();
        return;
      }
      // 只在「骨架 → 真实行」那次重铺挂入场；用完即清，后续重绘不再重播。
      const enter = pluginEnterPending;
      pluginEnterPending = false;
      pluginList.innerHTML = rows.map((item, i) => pluginRowHtml(item, enter ? i : -1)).join("");
      pluginList.classList.remove("is-loading");
      pluginList.classList.toggle("is-loaded", pluginLoaded && rows.length > 0);
      pluginList.scrollTop = scrollTop;
      for (const box of pluginList.querySelectorAll<HTMLButtonElement>("[data-plugin]")) {
        box.addEventListener("click", () => {
          const next = box.getAttribute("aria-checked") !== "true";
          void togglePlugin(box.dataset.plugin ?? "", next);
        });
      }
      for (const box of pluginList.querySelectorAll<HTMLButtonElement>("[data-plugin-update]")) {
        box.addEventListener("click", () => {
          void updatePlugin(box.dataset.pluginUpdate ?? "");
        });
      }
      renderPluginUpdatesToolbar();
    }

    /** 工具条两枚图标的可用状态与动效：在忙（含检查/更新互斥）、还没查过、
     *  没有可更新的插件就置灰；正在跑的那一枚转起来（复用 .square-btn 的旋转）。 */
    function renderPluginUpdatesToolbar(): void {
      const pending = pluginUpdateItems.filter((item) => item.hasUpdate).length;
      const busy = pluginActionBusy() || pluginBusy;
      btnPluginCheckUpdates.disabled = busy || !pluginLoaded;
      btnPluginUpdateAll.disabled = busy || !pluginUpdatesChecked || pending === 0;
      // 转圈只认「自己这枚按钮发起的动作」：检查转检查的，全部更新转全部更新的；
      // 单行更新只置灰工具条，不让「全部更新」的图标空转。转的是叠加的环形 spinner。
      setSquareBusy(btnPluginCheckUpdates, pluginCheckBusy);
      setSquareBusy(btnPluginUpdateAll, pluginUpdateBusy && pluginUpdateRunningAll);
      // 右上角微标 = 当前可更新的插件数；没有可更新时收掉，按钮本身置灰已足够。
      paintCountBadge(btnUpdateAllBadge, pending);
      btnUpdateAllBadge.classList.toggle("hidden", pending === 0);
    }

    /**
     * 画顶部这条确定进度条与汇总文案。
     *
     * 百分比只按「已完成数 / 总数」算（不转圈、不猜），收尾时正好 100%；汇总区是
     * `aria-live="polite"`，完成一句话会被读屏读出来。失败数一并写进去，不藏在行里。
     */
    function renderPluginProgress(): void {
      const visible = pluginProgressTotal > 0 || pluginProgressSummary !== null;
      pluginProgress.classList.toggle("hidden", !visible);
      const percent =
        pluginProgressTotal > 0 ? Math.round((pluginProgressDone / pluginProgressTotal) * 100) : 0;
      pluginProgressBar.setAttribute("aria-valuenow", String(percent));
      const fill = pluginProgressBar.firstElementChild;
      if (fill instanceof HTMLElement) {
        fill.style.width = `${percent}%`;
      }
      pluginProgressSum.textContent =
        pluginProgressSummary ??
        (pluginProgressTotal > 0
          ? `正在更新：已完成 ${pluginProgressDone}/${pluginProgressTotal}`
          : "");
    }

    /** 兜底收尾：这一轮结束后仍有行没走到「已更新/失败」（整轮在命令级就失败、
     *  或进度通道最后一条没送到），把它们按失败补齐，进度条推到 100%，汇总照实写。
     *  只对批量生效——单插件的结果只认命令返回值。 */
    function settleUnfinishedPluginRows(scope: string[], name: string | null): void {
      if (name !== null || pluginProgressTotal <= 0 || pluginProgressDone >= pluginProgressTotal) {
        return;
      }
      const successes = pluginProgressDone - pluginProgressFailed;
      for (const plugin of scope) {
        const state = pluginUpdatePhases.get(plugin);
        if (state !== undefined && (state.phase === "done" || state.phase === "fail")) {
          continue;
        }
        pluginUpdatePhases.set(plugin, { phase: "fail", message: "没有收到结果" });
        markFreshPhase(plugin);
      }
      pluginProgressFailed = pluginProgressTotal - successes;
      pluginProgressDone = pluginProgressTotal;
      pluginProgressSummary = `已更新 ${successes}/${pluginProgressTotal}，${pluginProgressFailed} 个失败`;
    }

    /** 全部跑完时把收尾文案定下来：`已更新 N/M，K 个失败`（N 是成功的，M 是本轮总数）。
     *  已经有汇总文案（例如整轮在命令级就失败、由 settleUnfinishedPluginRows 收的尾）就不再改。 */
    function finishPluginProgressIfComplete(): void {
      if (
        pluginProgressTotal > 0 &&
        pluginProgressDone >= pluginProgressTotal &&
        pluginProgressSummary === null
      ) {
        const ok = pluginProgressDone - pluginProgressFailed;
        pluginProgressSummary = `已更新 ${ok}/${pluginProgressTotal}，${pluginProgressFailed} 个失败`;
      }
    }

    /** 吃一条后端进度事件：start 只把这一行点亮，done 记结果并推进进度条。
     *  已完成数直接取后端给的 `index`（从 1 起），总数取 `total`——不靠前端自增，
     *  这样漏收一条或顺序有变时进度条也不会和真实结果脱节。 */
    function applyUpdateProgress(event: UpdateProgressEvent): void {
      if (event.total > 0) {
        pluginProgressTotal = event.total;
      }
      if (event.phase === "start") {
        pluginUpdatePhases.set(event.plugin, { phase: "busy", message: null });
      } else {
        const previous = pluginUpdatePhases.get(event.plugin);
        const counted = previous !== undefined && previous.phase !== "done" && previous.phase !== "fail";
        if (counted && event.ok !== true) {
          pluginProgressFailed += 1;
        }
        if (event.index > pluginProgressDone) {
          pluginProgressDone = event.index;
        }
        const ok = event.ok === true;
        pluginUpdatePhases.set(event.plugin, {
          phase: ok ? "done" : "fail",
          message: ok ? (event.message ?? null) : (event.message ?? "原因未知"),
        });
        markFreshPhase(event.plugin);
        // 更新成功一个，环境卡微标就实时递减一枚（失败的仍是可更新，不递减）。
        if (ok) {
          bumpPluginUpdateCount(-1);
        }
        finishPluginProgressIfComplete();
      }
      renderPluginList();
      renderPluginProgress();
    }

    /**
     * 只重画一行的开关状态，不动别的行也不重建列表。
     *
     * 点开关时整表重建过一次（乐观更新）再重建一次（后端回话），两次之间开关会闪、
     * 面板滚动位置也会丢——维护者要求「点开关时列表不得跳动」，所以改成只碰这一行。
     */
    function paintPluginRow(name: string, enabled: boolean, busy: boolean): void {
      const row = pluginList.querySelector<HTMLElement>(`[data-row="${name}"]`);
      const box = row?.querySelector<HTMLButtonElement>(".switch");
      if (!row || !box) {
        return;
      }
      row.classList.toggle("is-off", !enabled);
      box.setAttribute("aria-checked", enabled ? "true" : "false");
      box.disabled = busy;
    }

    /** 插件卡跟着当前管理的环境走；换环境才拉一次清单。 */
    function syncPluginPanel(): void {
      const target = profileOf(prefs.profile);
      profilePluginPanel.classList.toggle("hidden", target === null);
      if (target === null) {
        pluginItems = [];
        pluginLoaded = false;
        pluginLoadedFor = null;
        pluginSkeleton = false;
        pluginEnterPending = false;
        pluginUpdateItems = [];
        pluginUpdatesChecked = false;
        resetPluginProgress();
        setPluginNote(null);
        setPluginWarning(null);
        renderPluginList();
        renderPluginProgress();
        return;
      }
      if (pluginLoadedFor !== target.name) {
        pluginLoadedFor = target.name;
        pluginItems = [];
        pluginLoaded = false;
        // 进卡即铺骨架，并记下最早可撤下的时刻：清单回得再快也得站够最短展示。
        pluginSkeleton = true;
        pluginSkeletonUntil = performance.now() + PLUGIN_SKELETON_MIN_MS;
        pluginEnterPending = false;
        // 更新清单跟着环境走，一并重置；第一次进这张卡自动查一次
        // （后端有会话级缓存，重进/重查不打网络）。
        pluginUpdateItems = [];
        pluginUpdatesChecked = false;
        resetPluginProgress();
        setPluginNote(null);
        setPluginWarning(null);
        renderPluginList();
        renderPluginProgress();
        void refreshPluginList(target.name);
        void refreshPluginUpdates(target.name, false);
        return;
      }
      renderPluginList();
    }

    /**
     * 检查一次更新：进插件卡自动查（每个环境一次，后端会话缓存兜着），
     *  「检查更新」按钮强制重查。失败只提示，不打断开关插件等其它动作。
     *  强制重查期间锁住插件卡的全部操作（互斥），自动查不锁——它是背景动作。
     *  返回这一轮是否成功（强制重查成功才落勾，见 #29）；换了环境丢弃结果算失败。
     */
    async function refreshPluginUpdates(name: string, force: boolean): Promise<boolean> {
      if (!name || (force && pluginCheckBusy)) {
        return false;
      }
      if (force) {
        pluginCheckBusy = true;
        // 重新检查＝新一轮：上一轮的行级状态与收尾文案都作废，免得旧结果冒充新结果。
        resetPluginProgress();
        renderPluginList();
        renderPluginProgress();
      }
      let ok = false;
      try {
        const items = await invoke<PluginUpdateItem[]>("plugin_updates_list", {
          config: collectConfig(),
          name,
          source: prefs.downloadSource,
          force,
        });
        if (prefs.profile !== name) {
          return false; // 期间换了环境，丢弃这批结果
        }
        pluginUpdateItems = items;
        pluginUpdatesChecked = true;
        // 环境卡微标跟着这份清单走：按环境分别计数，不是全局总数。
        pluginUpdateCounts.set(name, items.filter((item) => item.hasUpdate).length);
        renderEnvCards();
        ok = true;
        renderPluginList();
        renderPluginSummary();
        const pending = items.filter((item) => item.hasUpdate).length;
        const broken = items.filter((item) => item.error).length;
        // 只有用户主动点的「检查更新」才写日志：进卡自动查是背景动作，结果就在
        // 行内版本号与徽章上，写日志只会让每次开卡都冒出一条没动作的未读。
        if (force) {
          const summary =
            `已重新检查插件更新：${pending} 个可更新` + (broken ? `、${broken} 个查不到` : "");
          logAction(summary);
          // 用户主动点的「检查更新」完成后右下角也回执一条（自动查是背景动作，不打扰）。
          showToast(summary, "info");
        }
      } catch (err) {
        if (prefs.profile === name) {
          setPluginNote(`检查插件更新失败：${String(err)}`);
        }
        logAction(`检查插件更新失败：${String(err)}`);
        // 只有用户主动点的「检查更新」失败才弹 toast：自动查失败安静落日志。
        if (force) {
          showToast(`检查插件更新失败：${String(err)}`, "error");
        }
      } finally {
        if (force) {
          pluginCheckBusy = false;
          renderPluginList();
        }
      }
      // 用户主动点的「检查更新」成功后落一个勾停 0.9s；自动查（背景动作）不闪反馈。
      if (force && ok) {
        flashSquareDone(btnPluginCheckUpdates);
      }
      return ok;
    }

    /**
     * 更新单个插件（`name` 有值）或全部有更新的插件（`null`，后端逐个执行、
     * 单个失败不影响其余）。
     *
     * 忙时所有更新入口都置灰；完成后用后端回来的汇总提示，并重查一次更新清单
     * （更新过的包后端已挪掉会话缓存，这一步看到的是装上的真版本）。
     * 更新不碰补丁层：停用状态原样保留；但新版本若改了挂载点，停用可能失效，要提醒。
     */
    async function updatePlugin(name: string | null): Promise<void> {
      const target = prefs.profile;
      if (!target || pluginBusy || pluginActionBusy() || manageBusy || patchBusy) {
        return;
      }
      // 只有「全部更新」会让工具条上那枚按钮转圈，所以也只有它结束才落勾（见 #29）。
      const runningAll = name === null;
      pluginUpdateBusy = true;
      pluginUpdateRunningAll = runningAll;
      setPluginNote(null);
      setPluginWarning(null);
      // 记下这轮要动的插件（批量=查出的全部可更新行），完事好提醒「停用的也更新了」。
      const scope = name
        ? [name]
        : pluginUpdateItems.filter((item) => item.hasUpdate).map((item) => item.name);
      let ok = false;
      // 开端就把整轮状态摆出来：批量全部进「排队」，单行直接「更新中」——不画假进度。
      resetPluginProgress();
      if (name === null) {
        pluginProgressTotal = scope.length;
        for (const plugin of scope) {
          pluginUpdatePhases.set(plugin, { phase: "queue", message: null });
        }
      } else if (name) {
        pluginUpdatePhases.set(name, { phase: "busy", message: null });
      }
      renderPluginList();
      renderPluginProgress();
      // 批量走进度通道（后端逐个回放开始/结束）；单插件只认返回值——一个状态来源。
      const progress = name === null ? new Channel<UpdateProgressEvent>() : null;
      if (progress) {
        progress.onmessage = (event: UpdateProgressEvent) => {
          applyUpdateProgress(event);
        };
      }
      try {
        const outcome = await invoke<UpdateOutcome>("plugin_update", {
          config: collectConfig(),
          name: target,
          source: prefs.downloadSource,
          plugin: name,
          progress,
        });
        ok = outcome.ok;
        setPluginNote(outcome.message);
        logAction(outcome.message);
        // 更新结果的回执（#34）：批量收尾的那句里带失败条数，这里只把后端的话搬出来，
        // 进度事件与行级状态归 #33，这里不碰。
        showToast(outcome.message, outcome.ok ? "ok" : "error");
        if (name !== null) {
          // 单插件：返回值的 ok 就是这一行的结果，失败原因就写在 message 里。
          pluginUpdatePhases.set(name, {
            phase: outcome.ok ? "done" : "fail",
            message: outcome.ok ? null : outcome.message,
          });
          markFreshPhase(name);
          // 单个更新成功同样实时递减环境卡微标（随后重查回来的清单会覆盖成权威值）。
          if (outcome.ok) {
            bumpPluginUpdateCount(-1);
          }
        }
        if (outcome.ok) {
          const disabled = scope.filter(
            (plugin) => pluginItems.find((item) => item.name === plugin)?.enabled === false,
          );
          if (disabled.length > 0) {
            setPluginWarning(
              `「${disabled.join("」「")}」目前处于停用状态，更新后保持停用；若新版本改了挂载点，停用可能失效。`,
            );
          }
        }
        await refreshPluginUpdates(target, false);
      } catch (err) {
        setPluginNote(`更新插件失败：${String(err)}`);
        logAction(`更新插件失败：${String(err)}`);
        showToast(`更新插件失败：${String(err)}`, "error");
        if (name) {
          pluginUpdatePhases.set(name, { phase: "fail", message: String(err) });
          markFreshPhase(name);
        }
      } finally {
        pluginUpdateBusy = false;
        pluginUpdateRunningAll = false;
        // 兜底：没走完的行按失败补齐再定汇总，不让进度条悬在「已完成 x/N」。
        settleUnfinishedPluginRows(scope, name);
        finishPluginProgressIfComplete();
        renderPluginList();
        renderPluginProgress();
        renderPluginSummary();
      }
      // 全部更新成功：在工具条那枚按钮上落勾停 0.9s；失败直接还原，不做错误态图标。
      if (runningAll && ok) {
        flashSquareDone(btnPluginUpdateAll);
      }
    }

    /** 读一次插件清单（读失败只提示，不打断其它动作）。
     *  骨架有最短展示：清单回得再快，也要站到 `pluginSkeletonUntil` 才换成真实行，
     *  否则快网络下骨架闪一下就没，比不画还难看。 */
    async function refreshPluginList(name: string): Promise<void> {
      try {
        const list = await invoke<PluginItem[]>("plugin_list", { config: collectConfig(), name });
        if (prefs.profile !== name) {
          return; // 期间换了环境，丢弃这批结果
        }
        // 站够最短展示再撤骨架。
        const wait = pluginSkeletonUntil - performance.now();
        if (pluginSkeleton && wait > 0) {
          await new Promise((done) => setTimeout(done, wait));
          if (prefs.profile !== name) {
            return; // 等待期间又换了环境，这批结果作废
          }
        }
        const hadSkeleton = pluginSkeleton;
        pluginItems = list;
        pluginLoaded = true;
        pluginSkeleton = false;
        // 只有「骨架 → 真实行」那一次挂入场；之前没有骨架就不重播。
        pluginEnterPending = hadSkeleton;
        renderPluginList();
        // 徽章的计数与列表同口径：清单回来要把「正在读取…」换成真实数字。
        renderPluginSummary();
      } catch (err) {
        if (prefs.profile === name) {
          // 读失败：撤掉骨架（不冒充还在加载），只留失败提示；空态也不显示。
          pluginSkeleton = false;
          pluginEnterPending = false;
          renderPluginList();
          setPluginNote(`读取插件清单失败：${String(err)}`);
        }
      }
    }

    /**
     * 开关一个插件的**总开关**（不是它内部的某个子项：后端会把该插件挂在补丁层里的
     * 全部挂载点一起翻过来）。
     *
     * 后端在写文件前会自己先备份一次补丁层，成功时把备份路径与刷新后的清单一起带回来；
     * 关掉桥接插件时还会带一句「登录链接只能靠日志兜底」的提醒。
     */
    async function togglePlugin(name: string, enabled: boolean): Promise<void> {
      const target = prefs.profile;
      // 检查/更新进行中不允许动开关（互斥）：更新要改 node_modules，开关要写补丁层，
      // 两边同时落盘没有意义，还容易让「更新后保持停用」的判断踩到刚翻的状态。
      if (!target || !name || pluginBusy || pluginActionBusy() || manageBusy || patchBusy) {
        return;
      }
      pluginBusy = true;
      setPluginNote(null);
      setPluginWarning(null);
      // 乐观更新：先把被点的这一行拨过去并锁住它，等后端回话再对齐。
      // 这里刻意不重建整张列表——重建会让开关闪一下，面板的滚动位置也会丢。
      paintPluginRow(name, enabled, true);
      let ok = false;
      try {
        const outcome = await invoke<ToggleOutcome>("plugin_toggle", {
          config: collectConfig(),
          name: target,
          plugin: name,
          enabled,
        });
        pluginItems = outcome.items;
        pluginLoaded = true;
        pluginLoadedFor = target;
        setPluginWarning(outcome.warning);
        setPluginNote(
          enabled
            ? `已打开「${name}」的总开关，重启 DSH 后生效。`
            : `已关闭「${name}」的总开关，重启 DSH 后生效；重新打开不需要重新下载。`,
        );
        logAction(outcome.message);
        // 开关前刚自动备份过，备份清单跟着刷新一次，免得用户还要再点一下才能看到。
        patchLoadedFor = null;
        ok = true;
      } catch (err) {
        setPluginNote(`切换插件开关失败：${String(err)}`);
        logAction(`切换插件开关失败：${String(err)}`);
        // 开关失败也要留回执：卡上那行提示会被下一次操作冲掉，toast 能兜住这一下。
        showToast(`切换插件开关失败：${String(err)}`, "error");
        // 失败时开关已经被点过去了，先把它拨回真实状态，再让下面重铺一次与后端对齐。
        paintPluginRow(name, !enabled, false);
        pluginLoadedFor = null;
      } finally {
        pluginBusy = false;
        if (ok) {
          // 用后端回来的真实状态收尾（个别插件可能写不进去，回的清单才是准的）。
          const item = pluginItems.find((entry) => entry.name === name);
          if (item) {
            paintPluginRow(name, item.enabled, false);
          } else {
            renderPluginList();
          }
        } else {
          renderPluginList();
        }
        renderPluginSummary();
      }
    }

    /** 开关后的那一句确认（含「重启才生效」）：卡上一眼能看到，不用展开日志。 */
    function setPluginNote(text: string | null): void {
      if (!text) {
        pluginNote.textContent = "";
        pluginNote.classList.add("hidden");
        return;
      }
      pluginNote.textContent = text;
      pluginNote.classList.remove("hidden");
    }

    /** 桥接关掉后的提醒：一字不改地用后端那句，免两处口径不一样。 */
    function setPluginWarning(text: string | null): void {
      setNoticeHint(pluginWarning, text ?? "");
    }

    /** 环境清单变化后统一刷三处：环境按钮、补丁层浮窗、插件卡。 */
    function renderManageUI(): void {
      renderProfilesUI();
      syncPatchModal();
      syncPluginPanel();
    }

    // 零插件空状态里的「去安装依赖」：跟着走同一个动作，而不是另写一份。
    btnPluginDeps.addEventListener("click", () => {
      void runEnvAction(() => installDeps(prefs.profile), { output: true });
    });

    // 「检查更新」：强制重查（后端绕过会话缓存真发网络）；跑完前插件卡整体互斥。
    btnPluginCheckUpdates.addEventListener("click", () => {
      if (!prefs.profile || pluginBusy || pluginActionBusy()) {
        return;
      }
      void refreshPluginUpdates(prefs.profile, true);
    });

    // 「全部更新」：批量走后端逐个升级（plugin=null），汇总由后端算好带回来。
    btnPluginUpdateAll.addEventListener("click", () => {
      void updatePlugin(null);
    });

    // ---- 集成面板：命令行集成（用户级 PATH + dsh 垫片） ------------------------
    // 目录、垫片内容、手动命令与状态说明都由后端算好，界面只负责渲染，
    // 免得两边各算一套口径对不上。
    let cliBusy = false;
    /** 后端说当前宿主能不能自动接入（只有 Windows）。非 Windows 时开关整段藏起来。 */
    let cliSupported = false;
    /** 两张半卡（命令行 + DSH 版本）共享同一个收起后徽章，所以各自只记录状态，徽章统一渲染。 */
    let cliBadgeText = "命令行读取中";
    let cliBadgeConnected = false;
    let cliBadgeFailed = false;
    /** 命令行那半是否已经拿到结果（两半各跑各的，先到的不应该把另一份还没读的当成「不可用」）。 */
    let cliLoaded = false;
    let dshVersionsBadgeText: string | null = null;
    let dshVersionsBadgeFailed = false;

    /** 收起后只能看到这一个徽章，所以两半的信息合在一起：`命令行已接入 · 装了 2 份 DSH`。 */
    function renderIntegrationsSummary(): void {
      if (cliLoaded && !cliSupported) {
        cliSummary.className = "badge badge-stopped panel-badge";
        cliSummary.textContent = "仅 Windows 可用";
        return;
      }
      if (cliLoaded && dshVersionsBadgeFailed && cliBadgeFailed) {
        cliSummary.className = "badge badge-failed panel-badge";
        cliSummary.textContent = "读取失败";
        return;
      }
      const parts = [cliBadgeText];
      if (dshVersionsBadgeText !== null) {
        parts.push(dshVersionsBadgeText);
      }
      cliSummary.className = `badge ${cliBadgeConnected ? "badge-running" : "badge-stopped"} panel-badge`;
      cliSummary.textContent = parts.join(" · ");
    }

    function renderCliState(state: CliIntegrationState): void {
      cliSupported = state.supported;
      cliLoaded = true;
      // 非 Windows 宿主不改任何 shell 配置：自动接入那半截整段收起来，只留手动命令。
      for (const el of cliWindowsOnly) {
        el.classList.toggle("hidden", !state.supported);
      }
      cliToggle.setAttribute("aria-checked", state.enabled ? "true" : "false");
      cliToggle.disabled = cliBusy || !state.supported;
      cliBinDir.textContent = state.binDir;
      cliShimPath.textContent = state.shimPath;
      cliManual.textContent = state.manualCommand;
      // 垫片渲染不出来（启动方式还没填完整等）时把原因显示在代码块里，便于手改。
      cliShimText.textContent = state.shimError === null ? state.shimText : state.shimError;
      cliMessage.textContent = state.message;
      // 正常态是灰字状态说明；上一次失败留下的黄色胶囊要撤掉。
      cliMessage.classList.remove("notice");
      const connected = state.supported && state.enabled && state.onPath;
      cliBadgeConnected = connected;
      cliBadgeFailed = false;
      cliBadgeText = !state.supported ? "仅 Windows 可用" : connected ? "命令行已接入" : "命令行未接入";
      renderIntegrationsSummary();
    }

    async function refreshCliState(): Promise<void> {
      try {
        const state = await invoke<CliIntegrationState>("cli_integration_state", { config: collectConfig() });
        renderCliState(state);
      } catch (err) {
        cliMessage.textContent = `读取命令行集成状态失败：${err}`;
        // 读不到状态是要用户处理的事，用醒目提示把它从普通灰字里拎出来。
        cliMessage.classList.add("notice");
        cliLoaded = true;
        cliBadgeFailed = true;
        cliBadgeText = "命令行读取失败";
        renderIntegrationsSummary();
      }
    }

    /** 开关与「启动方式变了之后重写垫片」共用：enabled 就是希望变成的状态。 */
    async function applyCliIntegration(enabled: boolean): Promise<void> {
      cliBusy = true;
      cliToggle.disabled = true;
      cliError.classList.add("hidden");
      try {
        const state = await invoke<CliIntegrationState>("set_cli_integration", {
          config: collectConfig(),
          enabled,
        });
        prefs.cliIntegration = state.enabled;
        renderCliState(state);
      } catch (err) {
        // 写 PATH 失败时后端不会留下半成品，这里把界面也拨回去，避免看着「已接入」其实没接。
        cliError.textContent = String(err);
        cliError.classList.remove("hidden");
        cliToggle.setAttribute("aria-checked", prefs.cliIntegration ? "true" : "false");
      } finally {
        cliBusy = false;
        cliToggle.disabled = !cliSupported;
      }
    }

    /** 启动方式（或二进制路径、自定义命令）改了就按新配置重写垫片；开关关着时只刷新说明。 */
    async function syncCliShim(): Promise<void> {
      if (!prefs.cliIntegration) {
        await refreshCliState();
        return;
      }
      try {
        const state = await invoke<CliIntegrationState>("set_cli_integration", {
          config: collectConfig(),
          enabled: true,
        });
        renderCliState(state);
      } catch (err) {
        cliMessage.textContent = `垫片没能跟着重写：${err}`;
        cliMessage.classList.add("notice");
      }
    }

    // 开关是 button + role="switch"：状态在 aria-checked 上，点击时取反后提交。
    cliToggle.addEventListener("click", () => {
      const next = cliToggle.getAttribute("aria-checked") !== "true";
      void applyCliIntegration(next);
    });

    btnCliDir.addEventListener("click", () => {
      void (async () => {
        cliError.classList.add("hidden");
        try {
          await invoke<string>("open_shell_dir", { kind: "bin" });
        } catch (err) {
          cliError.textContent = `打开垫片目录失败：${err}`;
          cliError.classList.remove("hidden");
        }
      })();
    });

    // ---- 集成面板：DSH 版本 ------------------------------------------------------
    // 后端扫出「本机装了哪几份 dsh」（npx 缓存 + npm 全局），界面只渲染列表；
    // 列表里每一份都能删：npm 全局那份跑 npm uninstall -g，npx 缓存那份直接删目录。
    // 删除不可撤销，所以都要再点一次「确定」；确认按钮只在点开的那一行展开。
    let dshVersionsBusy = false;
    /** 最近一次渲染的列表（按行顺序），重画动作区时按同一顺序对回每条记录。 */
    let dshVersionEntries: InstalledDsh[] = [];
    /** 当前处于「确认删除」状态的那一行（用的是 dshEntryKey）；null 表示没有。 */
    let dshPendingDelete: string | null = null;

    const DSH_SOURCE_LABELS: Record<string, string> = {
      npx: "npx 缓存",
      npm: "npm 全局",
    };

    /** 一行的版本号：读不到版本时说清楚「读不到」，不要留空白让人以为坏了。 */
    function dshVersionText(entry: InstalledDsh): string {
      return entry.version === null ? "版本未知" : `v${entry.version}`;
    }

    function renderDshVersions(list: InstalledDsh[]): void {
      dshVersionsList.textContent = "";
      // 重画列表就意味着原来那行的确认没了，待确认状态一起清掉。
      dshPendingDelete = null;
      dshVersionEntries = list;
      if (list.length === 0) {
        const empty = document.createElement("p");
        empty.className = "hint notice";
        empty.textContent =
          "本机还没有装过 dsh web。选「官方 npx 命令」启动一次，就会在 npx 缓存里出现一份。";
        dshVersionsList.append(empty);
        dshVersionsBadgeText = "未装过";
        dshVersionsBadgeFailed = false;
        paintDuplicateBadge(list);
        renderIntegrationsSummary();
        return;
      }

      for (const entry of list) {
        const row = document.createElement("div");
        row.className = "dsh-version-row";

        const main = document.createElement("div");
        main.className = "dsh-version-main";

        const version = document.createElement("span");
        version.className = "dsh-version-ver";
        version.textContent = dshVersionText(entry);

        const source = document.createElement("span");
        source.className = "badge badge-stopped dsh-version-source";
        source.textContent = DSH_SOURCE_LABELS[entry.source] ?? entry.source;

        main.append(version, source);

        if (entry.inUse) {
          const inUse = document.createElement("span");
          inUse.className = "badge badge-running dsh-version-inuse";
          inUse.textContent = "使用中";
          main.append(inUse);
        }

        const path = document.createElement("p");
        path.className = "dsh-version-path";
        path.textContent = entry.path;

        row.append(main, path, versionActions(entry));
        dshVersionsList.append(row);
      }

      dshVersionsBadgeText = `装了 ${list.length} 份`;
      dshVersionsBadgeFailed = false;
      paintDuplicateBadge(list);
      renderIntegrationsSummary();
    }

    /** 同一个版本装了不止一份时，在标题旁挂一枚黄色徽章点出重复数量。
     *  重复常见于换过 npx 参数（版本号一样但缓存目录不同），不提示的话很难发现多占了盘。
     *  只有一组重复就点明是哪个版本、几份；多组重复则给组数，避免徽章被撑长。 */
    function paintDuplicateBadge(list: InstalledDsh[]): void {
      const counts = new Map<string, number>();
      for (const entry of list) {
        const key = entry.version ?? "未知";
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const duplicated = [...counts.entries()].filter(([, count]) => count > 1);
      if (duplicated.length === 0) {
        dshVersionsDup.textContent = "";
        dshVersionsDup.classList.add("hidden");
        return;
      }
      if (duplicated.length === 1) {
        const [version, count] = duplicated[0] as [string, number];
        dshVersionsDup.textContent = `${version === "未知" ? "版本未知" : `v${version}`} 装了 ${count} 份`;
      } else {
        dshVersionsDup.textContent = `${duplicated.length} 个版本有重复`;
      }
      dshVersionsDup.classList.remove("hidden");
    }

    /** 一行的动作区：默认一个「删除/卸载」；点了才换成二次确认。
     *  同一时刻最多只有一行处于确认态——否则两行并排红着，很容易点错删错。 */
    function versionActions(entry: InstalledDsh): HTMLElement {
      const box = document.createElement("div");
      box.className = "dsh-version-actions";
      paintActionBox(box, entry);
      return box;
    }

    /** 这一行的唯一标识：同一个路径不会同时出现在两个来源下，拿来源加路径就够。 */
    function dshEntryKey(entry: InstalledDsh): string {
      return `${entry.source}:${entry.path}`;
    }

    /** 按「这一行是不是待确认的那一行」来画：是就画确认对，否则画单颗删除。 */
    function paintActionBox(box: HTMLElement, entry: InstalledDsh): void {
      if (dshPendingDelete === dshEntryKey(entry)) {
        paintConfirm(box, entry);
      } else {
        paintDeleteButton(box, entry);
      }
    }

    /** 把列表里所有动作区按当前待确认状态重画（点了某行就整表刷一次，保证只有一行在确认）。 */
    function repaintActionBoxes(): void {
      const boxes = Array.from(
        dshVersionsList.querySelectorAll<HTMLElement>(".dsh-version-actions"),
      );
      for (let i = 0; i < boxes.length && i < dshVersionEntries.length; i += 1) {
        const box = boxes[i];
        const entry = dshVersionEntries[i];
        if (box && entry) {
          paintActionBox(box, entry);
        }
      }
    }

    function paintDeleteButton(box: HTMLElement, entry: InstalledDsh): void {
      box.textContent = "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dsh-version-uninstall";
      btn.textContent = entry.source === "npm" ? "卸载" : "删除";
      btn.addEventListener("click", () => {
        dshPendingDelete = dshEntryKey(entry);
        repaintActionBoxes();
      });
      box.append(btn);
    }

    function paintConfirm(box: HTMLElement, entry: InstalledDsh): void {
      box.textContent = "";
      const yes = document.createElement("button");
      yes.type = "button";
      yes.className = "dsh-version-uninstall danger";
      yes.textContent = entry.source === "npm" ? "确定卸载" : "确定删除";
      yes.addEventListener("click", () => {
        void removeDshVersion(yes, entry);
      });
      const no = document.createElement("button");
      no.type = "button";
      no.className = "dsh-version-uninstall ghost";
      no.textContent = "取消";
      no.addEventListener("click", () => {
        dshPendingDelete = null;
        repaintActionBoxes();
      });
      box.append(yes, no);
    }

    /** 删一份：npm 全局走 `npm uninstall -g`，npx 缓存直接删对应目录。 */
    async function removeDshVersion(button: HTMLButtonElement, entry: InstalledDsh): Promise<void> {
      if (dshVersionsBusy) return;
      dshVersionsBusy = true;
      dshVersionsError.classList.add("hidden");
      for (const item of dshVersionsList.querySelectorAll<HTMLButtonElement>("button")) {
        item.disabled = true;
      }
      try {
        // 成功不用弹提示条：列表重画后那一行没了，本身就是结果。
        if (entry.source === "npm") {
          await invoke<string>("uninstall_dsh_global", { runtime: collectConfig().runtime });
        } else {
          await invoke<string>("delete_dsh_npx", {
            runtime: collectConfig().runtime,
            path: entry.path,
          });
        }
        dshPendingDelete = null;
        await refreshDshVersions();
      } catch (err) {
        dshVersionsError.textContent = String(err);
        dshVersionsError.classList.remove("hidden");
        button.disabled = false;
        for (const item of dshVersionsList.querySelectorAll<HTMLButtonElement>("button")) {
          item.disabled = false;
        }
      } finally {
        dshVersionsBusy = false;
      }
    }

    async function refreshDshVersions(): Promise<void> {
      try {
        const list = await invoke<InstalledDsh[]>("installed_dsh_versions", {
          config: collectConfig(),
        });
        renderDshVersions(list);
      } catch (err) {
        // 失败原因写在下面那行 .error 里；列表区不再重复一条「读取失败」，避免两句叠着说同一件事。
        // 后端返回的错误文案已经带「读取已装 DSH 版本失败：」前缀，这里原样用，不再加一层。
        dshVersionsList.textContent = "";
        dshVersionsError.textContent = String(err);
        dshVersionsError.classList.remove("hidden");
        dshVersionsBadgeFailed = true;
        renderIntegrationsSummary();
      }
    }

    /** 桥接插件：「打开备份目录」（安装/卸载的备份都落在这里）。 */
    btnBridgeBackups.addEventListener("click", () => {
      void (async () => {
        bridgeNote.classList.add("hidden");
        try {
          const path = await invoke<string>("open_shell_dir", { kind: "backups" });
          bridgeNote.textContent = `已在资源管理器中打开备份目录：${path}`;
          bridgeNote.classList.remove("hidden");
        } catch (err) {
          bridgeNote.textContent = `打开备份目录失败：${err}`;
          bridgeNote.classList.remove("hidden");
        }
      })();
    });

    /** 「关于」面板：打开项目仓库 / DSH 官网（URL 固定在 Rust 侧，界面只传目标键）。 */
    function openExternal(target: "repo" | "site"): void {
      void (async () => {
        aboutNote.classList.add("hidden");
        try {
          await invoke("open_external", { target });
        } catch (err) {
          aboutNote.textContent = `打开失败：${err}`;
          aboutNote.classList.remove("hidden");
        }
      })();
    }

    /** 「关于」面板：在系统文件管理器里打开壳配置目录 / DSH 日志目录。 */
    function openShellDir(kind: "config" | "logs"): void {
      void (async () => {
        aboutNote.classList.add("hidden");
        try {
          const path = await invoke<string>("open_shell_dir", { kind });
          aboutNote.textContent = `已在资源管理器中打开：${path}`;
          aboutNote.classList.remove("hidden");
        } catch (err) {
          aboutNote.textContent = `打开目录失败：${err}`;
          aboutNote.classList.remove("hidden");
        }
      })();
    }

    btnAboutConfig.addEventListener("click", () => openShellDir("config"));
    btnAboutLogs.addEventListener("click", () => openShellDir("logs"));


    // 窗口右上角那三颗按钮。拖拽与双击最大化由 data-tauri-drag-region 交给系统处理，这里只发最小化 /
    // 最大化切换 / 关闭；关窗命令和原生关闭按钮走同一条路径，最终由 Rust 侧的
    // CloseRequested 拦下来转成轻量模式。
    if (btnWinMin && btnWinMax && btnWinClose) {
      const minButton = btnWinMin;
      const maxButton = btnWinMax;
      const closeButton = btnWinClose;
      try {
        const appWindow = getCurrentWindow();
        const windowButtons: Array<[HTMLButtonElement, () => Promise<void>]> = [
          [minButton, () => appWindow.minimize()],
          [maxButton, () => appWindow.toggleMaximize()],
          [closeButton, () => appWindow.close()],
        ];
        for (const [button, action] of windowButtons) {
          button.addEventListener("click", () => {
            void action().catch((err) => console.error("窗口操作失败:", err));
          });
        }
      } catch (err) {
        // 普通浏览器里没有 Tauri 窗口环境（预览用），按钮保留但点了没反应。
        console.error("无法获取当前窗口:", err);
      }

      // 最大化后按钮应该显示「还原」（两个叠放的方框）。窗口尺寸一变就同步一次：
      // 最大化 / 还原 / 贴靠 / 拖边缩放都会改视图尺寸，所以监 window.resize 就够，
      // 不必再走 Tauri 的窗口事件通道。监听只注册一次（见 main 尾部），
      // 这里只把钩子换成新界面上的按钮。
      syncMaximizeIconHook = (): void => {
        try {
          void getCurrentWindow()
            .isMaximized()
            .then((maximized) => {
              maxButton.innerHTML = maximized ? ICON_RESTORE : ICON_MAXIMIZE;
              const label = maximized ? "还原" : "最大化";
              maxButton.title = label;
              maxButton.setAttribute("aria-label", label);
            });
        } catch (err) {
          console.error("读取窗口最大化状态失败:", err);
        }
      };
      syncMaximizeIconHook();
    }

    /** 首启/重开壳时把已保存的设置填回界面（后端缺省时返回默认值）。 */
    async function loadSavedConfig(): Promise<void> {
      let saved: ShellConfig;
      try {
        saved = await invoke<ShellConfig>("load_shell_config");
      } catch (err) {
        console.error("读取已保存配置失败:", err);
        return;
      }
      const launch = saved.launch;
      // 环境 / 网络 / 集成的六个字段：缺键、坏值在这里统一兜底成默认（与 Rust 侧宽容读取同语义），
      // 以后每次保存都按这份值原样回写。
      prefs = normalizePrefs(saved);
      const radio = modeRadios().find((r) => r.value === launch.mode.kind);
      if (radio) {
        radio.checked = true;
      }
      if (launch.mode.kind === "binary") {
        binaryPath.value = launch.mode.path;
      }
      if (launch.mode.kind === "custom") {
        customCommand.value = launch.mode.command;
      }
      // 运行环境：旧配置没有 runtime 字段就是 default（后端 fallback 也是这个值）。
      runtime = launch.runtime ?? { kind: "default" };
      syncRuntimePickers();
      if (launch.mode.kind === "npx") {
        // 版本是唯一真源：候选还没读回来也先记着，loadRegistry 会按它把下拉选回去。
        selectedVersion = launch.mode.version ?? null;
      }
      extraInput.value = launch.extraArgs.join(" ");
      if (launch.port !== null && launch.port !== undefined) {
        portInput.value = String(launch.port);
      }
      trayPicker.setValue(saved.trayClick);
      // 缺字段或值不在候选集合时回落「立即」。
      const lightDelay = String(saved.lightDelaySecs ?? 0);
      lightDelayPicker.setValue(LIGHT_DELAY_CHOICES.some((choice) => choice.value === lightDelay) ? lightDelay : "0");
      syncModeFields();
      renderPortHint();
      renderVersionUI();
      // 下载源与代理：读回来的值可能不是界面上的默认项，回填下拉、地址框与摘要。
      downloadSourcePicker.setValue(prefs.downloadSource);
      proxyModePicker.setValue(prefs.proxyMode);
      proxyAddressInput.value = prefs.proxyAddress;
      renderNetworkUI();
      void refreshProxyState();
    }

    await loadSavedConfig();
    // 运行环境候选与官方版本列表都提前读好，切到对应面板即可直接选。
    await loadDistros();
    await loadRegistry();
    // 先扫一次本机 npx 缓存：既给「已缓存」徽章，也决定「本机已经装过」那条提示要不要显示。
    await refreshCachedVersions();
    await refreshPortHint();
    await refresh();
    void refreshBridgeState();
    void refreshCliState();
    // 「已装 DSH 版本」要起 npm 子进程，不阻塞首次挂载。
    void refreshDshVersions();
    void loadProfiles();
    refreshNowHook = refresh;
    // 转动状态与计时在模块级（界面元素可能被重建），这里把类贴到当前这颗「重启 DSH」上。
    applyRestartSpin();
  }

  /** 把浅色/深色镜像给 Rust（ui_theme）：开窗前要按它定 WebView 底色，避免首帧闪白。 */
  function syncThemeToShell(next: ThemeId): void {
    invoke("save_ui_theme", { theme: next }).catch((err) => {
      // 失败只影响下次开窗的头一帧底色，本次界面不受影响。
      console.debug("镜像主题到外壳失败:", err);
    });
  }

  // 自绘滚动指示条：主卡（`.block.main-card`）的原生滚动条已在样式里藏起来，滚动时它
  // 右边缘浮出一条细胶囊，停手约 1 秒后淡出。机制在 scroll-thumb.ts（与日志正文、
  // 版本下拉共用一份）。挂的是「当前分区的主卡」而不是视口：界面定高，只有主卡内部滚、
  // 下方小卡固定可见，视口永远不可滚，绑在视口上就等于没有。
  /**
   * 胶囊轨道相对主卡上下各让进多少：取卡片圆角（`--radius-card`）减去 2px 余量。
   * 圆角是从令牌读的、不抄数字——维护者改令牌时这里跟着走（同 `motionMs` 的思路）。
   */
  function trackInset(): number {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--radius-card").trim();
    const radius = Number.parseFloat(raw);
    return (Number.isFinite(radius) && radius > 0 ? radius : 14) - 2;
  }

  /**
   * 滚动容器是当前分区那张主卡（`.block.main-card`）：只有它内部滚，下方并排的小卡
   * 固定可见（2026-10-21 维护者定稿）。没有小卡的分区主卡同样吃掉整个高度。
   * 交叉淡化期间旧分区还在 DOM 里（`.is-leaving`），要把它排除掉，否则滚动指示条会
   * 认错容器、量到正在退役的那一块。
   */
  function activePanel(): HTMLElement | null {
    return root.querySelector<HTMLElement>(".panel:not(.hidden):not(.is-leaving) .block.main-card");
  }

  // 轨道挂 `.content-main`：主卡自己是滚动容器，绝对定位的子元素会跟着内容一起滚走，
  // 挂在外层才定得住；界面重建后由 getHolder 现取，仍能找回新节点。
  const mainThumb = attachScrollThumb({
    getScroller: activePanel,
    getHolder: () => root.querySelector<HTMLElement>(".content-main"),
    inset: trackInset,
  });

  // 窗口尺寸变化与 1 秒状态轮询只注册一次，通过钩子指向当前这套界面。
  window.addEventListener("resize", () => {
    syncMaximizeIconHook();
    mainThumb.update();
  });
  window.setInterval(() => void refreshNowHook(), 1000);
  updateScrollThumbHook = () => {
    mainThumb.update();
    // mount() 里给日志正文与垫片挂的自绘胶囊（见 logThumb/shimThumb）：
    // 分区切换会改变它们的几何，随主卡轨道一并刷新。
    refreshInnerScrollThumbsHook();
  };

  // 浅色/深色镜像给 Rust：老配置里没有这份镜像（主题本来只存 localStorage），启动时补齐，
  // 下次开窗（含托盘重开）就能第一时间按主题铺底色，避免首帧闪一下另一种色。
  syncThemeToShell(theme);
  await mount();
}

void main();
