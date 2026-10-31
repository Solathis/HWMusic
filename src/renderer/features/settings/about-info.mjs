/**
 * 设置「关于」的数据与文案：外链表、技术栈、运行环境行。
 * 外链只按键交给宿主打开，URL 的权威表在 `src-tauri/src/about.rs`，两边由测试逐条互钉。
 */

const REPOSITORY = "https://github.com/Solathis/HWMusic";

/** 本项目的开源地址。 */
export const PROJECT_LINKS = [
  { key: "repository", label: "源码仓库", url: REPOSITORY },
  { key: "releases", label: "版本发布", url: `${REPOSITORY}/releases` },
  { key: "issues", label: "问题反馈", url: `${REPOSITORY}/issues` },
  { key: "license", label: "许可证（AGPL-3.0-only）", url: `${REPOSITORY}/blob/main/LICENSE` },
];

/** 参考与直接使用的项目（与 README「参考项目与致谢」一致）。 */
export const REFERENCE_LINKS = [
  { key: "ref-huawei-music-desktop", label: "talongao/huawei-music-desktop", note: "登录链路与接口形状", url: "https://github.com/talongao/huawei-music-desktop" },
  { key: "ref-taskbar-lyrics", label: "ANYNC/TaskbarLyrics", note: "任务栏歌词", url: "https://github.com/ANYNC/TaskbarLyrics" },
  { key: "ref-spotify-lyrics-window", label: "Mai-icy/Spotify-lyrics-window", note: "桌面歌词设计", url: "https://github.com/Mai-icy/Spotify-lyrics-window" },
  { key: "ref-amll", label: "Apple Music-like Lyrics", note: "歌词与播放页组件", url: "https://github.com/amll-dev/applemusic-like-lyrics" },
  { key: "ref-shadcn", label: "shadcn/ui", note: "界面组件", url: "https://github.com/shadcn-ui/ui" },
];

/**
 * 技术栈。`version` 与 package-lock.json 逐条一致（测试钉住）；
 * Tauri 取宿主回报的运行时版本，Node.js 随安装包内置。
 */
export const TECH_STACK = [
  { name: "Tauri", role: "桌面外壳与系统能力", source: "host" },
  { name: "React", role: "界面", package: "react", version: "19.3.0" },
  { name: "TypeScript", role: "类型检查", package: "typescript", version: "7.0.2" },
  { name: "Vite", role: "构建", package: "vite", version: "7.3.7" },
  { name: "Tailwind CSS", role: "样式", package: "tailwindcss", version: "4.3.3" },
  { name: "shadcn/ui", role: "界面组件", package: "shadcn", version: "4.22.0" },
  { name: "Radix UI", role: "无障碍原语", package: "radix-ui", version: "1.8.1" },
  { name: "AMLL", role: "歌词与播放页", package: "@applemusic-like-lyrics/react", version: "0.6.0" },
  { name: "Node.js", role: "内核（sidecar）", source: "bundled" },
];

/** 宿主没给出的值统一显示这个占位。 */
export const UNKNOWN_TEXT = "—";

/** 技术栈一行的版本文本。 */
export function techVersionText(entry, info) {
  if (entry.source === "host") return textOrUnknown(info?.tauriVersion);
  if (entry.source === "bundled") return "内置";
  return entry.version;
}

const OS_LABELS = { windows: "Windows", macos: "macOS", linux: "Linux" };

/** 宿主回报的系统名 → 显示名；认不出的原样显示。 */
export function osLabel(os) {
  return OS_LABELS[os] ?? textOrUnknown(os);
}

function textOrUnknown(value) {
  return typeof value === "string" && value.trim() !== "" ? value : UNKNOWN_TEXT;
}

/** 「版本信息」卡的三行：版本、系统、WebView，缺的值显示占位。 */
export function runtimeRows(info) {
  const os = typeof info?.os === "string" && info.os !== "" ? osLabel(info.os) : UNKNOWN_TEXT;
  const arch = typeof info?.arch === "string" && info.arch !== "" ? ` ${info.arch}` : "";
  return [
    { id: "version", label: "版本", value: textOrUnknown(info?.version) },
    { id: "os", label: "系统", value: os === UNKNOWN_TEXT ? os : `${os}${arch}` },
    { id: "webview", label: "WebView", value: textOrUnknown(info?.webviewVersion) },
  ];
}

export const ABOUT_INFO_FAILED = "读不到版本信息（详情见运行日志）。";
export const ABOUT_OPEN_FAILED = "没能打开浏览器（详情见运行日志），可以复制上面的地址手动打开。";
