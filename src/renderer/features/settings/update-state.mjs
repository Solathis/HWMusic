/**
 * 「软件更新」的纯状态机：检查 → 发现新版本 → 下载 → 安装（应用重启）。
 * 失败只留可读的原因与下一步；下载进度来自宿主的 `update:progress` 广播。
 */

export const UPDATE_IDLE = { phase: "idle" };
export const CHECK_FAILED_FALLBACK = "没能连上更新服务（详情见运行日志），请稍后重试。";
export const INSTALL_FAILED_FALLBACK = "更新没能完成（详情见运行日志），请重试。";
export const UPDATE_LATEST_TEXT = "已是最新版本";
export const UPDATE_INSTALLING_TEXT = "正在安装，完成后应用会自动重启。";
export const RELEASE_NOTE_LIMIT = 12;

/** 宿主已翻译好的 `update` 类失败原样显示，其余一律用兜底文案（不把原始错误摆进界面）。 */
export function failureText(failure, fallback) {
  if (failure && typeof failure === "object" && failure.kind === "update" && typeof failure.message === "string" && failure.message.trim() !== "") {
    return failure.message;
  }
  return fallback;
}

function failedState(stage, message, version, notes) {
  return { phase: "failed", stage, message: message || (stage === "check" ? CHECK_FAILED_FALLBACK : INSTALL_FAILED_FALLBACK), version, notes };
}

/** @param {any} state @param {any} action @returns {any} */
export function updateReducer(state, action) {
  switch (action?.type) {
    case "check":
      return state.phase === "downloading" || state.phase === "installing" ? state : { phase: "checking" };
    case "checked":
      if (state.phase !== "checking") return state;
      return action.answer?.available === true && typeof action.answer.version === "string"
        ? { phase: "available", version: action.answer.version, notes: action.answer.notes ?? "" }
        : { phase: "latest" };
    case "check-failed":
      return state.phase === "checking" ? failedState("check", action.message) : state;
    case "install":
      if (state.phase === "available" || (state.phase === "failed" && state.stage === "install")) {
        return { phase: "downloading", version: state.version, notes: state.notes ?? "", downloaded: 0, total: null };
      }
      return state;
    case "install-failed":
      return state.phase === "downloading" || state.phase === "installing"
        ? failedState("install", action.message, state.version, state.notes)
        : state;
    case "progress":
      return applyProgress(state, action.event);
    default:
      return state;
  }
}

function applyProgress(state, event) {
  if (state.phase !== "downloading" && state.phase !== "installing") return state;
  if (event?.phase === "failed") return failedState("install", event.message, state.version, state.notes);
  if (event?.phase === "installing") return { phase: "installing", version: state.version, notes: state.notes };
  if (event?.phase !== "downloading" || state.phase !== "downloading") return state;
  const downloaded = Number.isFinite(event.downloaded) && event.downloaded >= 0 ? event.downloaded : state.downloaded;
  const total = Number.isFinite(event.total) && event.total > 0 ? event.total : state.total;
  return { ...state, downloaded, total };
}

/** 总大小已知时的百分比（0–100 整数），未知回 null。 */
export function progressPercent(downloaded, total) {
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.floor((Math.max(0, downloaded) / total) * 100));
}

const mb = (bytes) => (Math.max(0, bytes) / 1048576).toFixed(1);

export function progressText(downloaded, total) {
  return Number.isFinite(total) && total > 0 ? `已下载 ${mb(downloaded)} MB / ${mb(total)} MB` : `已下载 ${mb(downloaded)} MB`;
}

/** 界面要的扁平视图：状态句、按钮、进度、失败说明、更新说明。 */
export function updateView(state) {
  const phase = state.phase;
  const installMode = phase === "available" || phase === "downloading" || phase === "installing" || (phase === "failed" && state.stage === "install");
  const status = phase === "latest" ? UPDATE_LATEST_TEXT
    : phase === "available" ? `发现新版本 ${state.version}`
    : phase === "downloading" ? `正在下载 ${state.version}`
    : phase === "installing" ? UPDATE_INSTALLING_TEXT
    : phase === "failed" && state.stage === "install" ? `新版本 ${state.version}`
    : "";
  return {
    status,
    actionLabel: installMode ? "下载并安装" : "检查更新",
    action: installMode ? "install" : "check",
    busy: phase === "checking" || phase === "downloading" || phase === "installing",
    percent: phase === "downloading" ? progressPercent(state.downloaded, state.total) : null,
    showProgress: phase === "downloading",
    progressText: phase === "downloading" ? progressText(state.downloaded, state.total) : "",
    failureTitle: phase === "failed" ? (state.stage === "check" ? "检查更新失败" : "更新没能完成") : "",
    failureMessage: phase === "failed" ? state.message : "",
    notes: phase === "available" || phase === "downloading" || (phase === "failed" && state.stage === "install") ? state.notes ?? "" : "",
  };
}

/** 发布说明（CHANGELOG 的一节）→ 分组：`### 标题` 起一组，`- 条目` 进组；每组最多 RELEASE_NOTE_LIMIT 条。 */
export function releaseNoteGroups(markdown) {
  if (typeof markdown !== "string" || markdown.trim() === "") return [];
  const groups = [];
  let current = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      current = { title: heading[1].trim(), items: [] };
      groups.push(current);
      continue;
    }
    if (current === null) {
      current = { title: "", items: [] };
      groups.push(current);
    }
    if (current.items.length < RELEASE_NOTE_LIMIT) current.items.push(line.replace(/^[-*]\s+/, ""));
  }
  return groups.filter((group) => group.items.length > 0);
}
