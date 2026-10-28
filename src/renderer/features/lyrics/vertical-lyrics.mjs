/**
 * 竖版桌面歌词的纯逻辑：当前句/下一句、滚动偏移、逐字进度。
 * 数据仍是 AMLL 解析出的行与 `withKaraokeWords` 的逐字时间；字号沿用横版档位（由样式表决定）。
 */

/** 视口左右留白（竖排的块轴两端）。 */
export const VERTICAL_COLUMN_PADDING_PX = 8;
/** 列厚系数：竖排一列占的横向空间不止字号本身（字距 + 行距）。 */
export const VERTICAL_COLUMN_THICKNESS_RATIO = 1.25;
/** 正在唱的字停在视口高度的这个比例上（略靠上，看得见后面的字）。 */
export const VERTICAL_SCROLL_ANCHOR_RATIO = 0.35;
/** 跟随修正的上下留白：字贴着视口边就算"看不见"了。 */
export const VERTICAL_SCROLL_MARGIN_PX = 8;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 一列里的文字长度（行级 LRC 的空白行不算一句）。 */
function textOf(line) {
  if (line === null || line === undefined || !Array.isArray(line.words)) return "";
  return line.words.map((word) => (typeof word?.word === "string" ? word.word : "")).join("");
}

/** 当前句：时间落在哪一行（取最后一行已开始且有字的）；纯时间戳的空白行沿时间往前找有字行，时间未到第一句回 -1。 */
export function activeLyricIndex(lines, timeMs) {
  if (!Array.isArray(lines) || lines.length === 0) return -1;
  const time = finite(timeMs);
  if (time === null) return -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const start = finite(lines[index]?.startTime);
    if (start === null || start > time) continue;
    if (textOf(lines[index]).trim() === "") continue;
    return index;
  }
  return -1;
}

/** 当前句与下一句（下一句有字才算；宽度放不下时组件不画它）。 */
export function verticalLinePlan(lines, timeMs) {
  const current = activeLyricIndex(lines, timeMs);
  const nextOf = (from) => {
    for (let index = from + 1; index < lines.length; index += 1) {
      if (textOf(lines[index]).trim() !== "") return index;
    }
    return -1;
  };
  if (!Array.isArray(lines)) return { current: -1, next: -1 };
  if (current === -1) {
    const first = nextOf(-1);
    return { current: -1, next: first };
  }
  return { current, next: nextOf(current) };
}

/**
 * 当前句的进度（0..1）：滚动位置按它算，所以必须**只看时间**。
 * 行尾等于行首（解析器只给了起点）时拿下一句起点当结束；都没有就停在 0——不猜时长。
 */
export function lineProgress(line, timeMs, nextStartMs) {
  const start = finite(line?.startTime);
  const time = finite(timeMs);
  if (start === null || time === null) return 0;
  const end = (() => {
    const declared = finite(line?.endTime);
    if (declared !== null && declared > start) return declared;
    const next = finite(nextStartMs);
    return next !== null && next > start ? next : null;
  })();
  if (end === null) return 0;
  return clamp((time - start) / (end - start), 0, 1);
}

/** 组合符号/变体选择符/零宽连接符：它们属于前一个字素簇，不能独立成列。 */
const CLUSTER_CONTINUATION = /^[\p{M}\u200d\ufe0e\ufe0f]$/u;

/** 逐字词 → 渲染用的字素簇 token（只合并，不切分）；时间跟着合并：起点取首字、终点取末字。 */
export function karaokeTokens(words) {
  if (!Array.isArray(words)) return [];
  const tokens = [];
  for (const word of words) {
    const text = typeof word?.word === "string" ? word.word : "";
    if (text === "") continue;
    const previous = tokens.at(-1);
    const joins = previous !== undefined
      && (CLUSTER_CONTINUATION.test(text) || previous.text.endsWith("\u200d"));
    if (joins) {
      previous.text += text;
      previous.endTime = finite(word?.endTime) ?? previous.endTime;
      continue;
    }
    tokens.push({ text, startTime: finite(word?.startTime), endTime: finite(word?.endTime) });
  }
  return tokens;
}

/** 词时间是否真的逐字（全 0、倒挂、单字都算"没有逐字时间"，回头按整句处理）。 */
function hasWordTiming(tokens) {
  if (tokens.length < 2) return false;
  return tokens.every((token, index) => token.startTime !== null && token.endTime !== null
    && token.startTime <= token.endTime
    && (index === 0 || token.startTime >= tokens[index - 1].startTime || token.startTime === tokens[index - 1].startTime));
}

/**
 * 逐字进度：`sung`（已唱）/`active`（正在唱）/`pending`（未唱）。
 *
 * 逐字高亮关掉、或数据里没有逐字时间时按**整句**处理：当前句一起亮，未到的句子不亮。
 */
export function karaokeStates(line, timeMs, karaoke = true) {
  const tokens = karaokeTokens(line?.words);
  if (tokens.length === 0) return [];
  const time = finite(timeMs);
  const start = finite(line?.startTime);
  const whole = karaoke !== true || !hasWordTiming(tokens);
  if (whole) {
    const lit = time !== null && start !== null && time >= start;
    return tokens.map(() => (lit ? "sung" : "pending"));
  }
  return tokens.map((token) => {
    if (time === null || token.endTime === null) return "pending";
    if (time >= token.endTime) return "sung";
    if (token.startTime !== null && time >= token.startTime) return "active";
    return "pending";
  });
}

/** 正在唱的那个字的进度（0–1），用来连续扫亮；时间不全或不在这个字的范围内时为 0。 */
export function wordProgress(token, timeMs) {
  const start = typeof token?.startTime === "number" ? token.startTime : null;
  const end = typeof token?.endTime === "number" ? token.endTime : null;
  const time = finite(timeMs);
  if (start === null || end === null || time === null || end <= start) return 0;
  return clamp((time - start) / (end - start), 0, 1);
}

/**
 * 沿书写方向的平移量（`transform: translateY` 用的负数）。
 * 进度 p 把内容推到 `p × 内容高` 落在视口 `anchorRatio` 处，两端夹在 `[-(内容高 - 视口高), 0]`。
 */
export function verticalScrollOffset(options) {
  const { contentHeight, viewportHeight, progress, anchorRatio = VERTICAL_SCROLL_ANCHOR_RATIO } = options ?? {};
  const content = finite(contentHeight);
  const viewport = finite(viewportHeight);
  const ratio = finite(progress);
  if (content === null || viewport === null || ratio === null || content <= 0 || viewport <= 0) return 0;
  const max = Math.max(0, content - viewport);
  if (max === 0) return 0;
  const anchor = finite(anchorRatio) ?? VERTICAL_SCROLL_ANCHOR_RATIO;
  return -clamp(clamp(ratio, 0, 1) * content - viewport * anchor, 0, max);
}

/**
 * 跟随修正：字宽/字距不均匀时，按时间推出来的位置可能让正在唱的字贴边或出界，
 * 用**量到的**字形位置把它拉回视口内（`charTop` 是内容坐标系里的位置）。
 */
export function verticalFollowOffset(options) {
  const { offset, charTop, charHeight, contentHeight, viewportHeight, margin = VERTICAL_SCROLL_MARGIN_PX } = options ?? {};
  const content = finite(contentHeight);
  const viewport = finite(viewportHeight);
  if (content === null || viewport === null || content <= 0 || viewport <= 0) return 0;
  const max = Math.max(0, content - viewport);
  const base = finite(offset) ?? 0;
  let next = clamp(base, -max, 0);
  const top = finite(charTop);
  const height = finite(charHeight);
  if (top === null || height === null) return next;
  const gap = finite(margin) ?? VERTICAL_SCROLL_MARGIN_PX;
  const visibleTop = -next;
  if (top - gap < visibleTop) next = clamp(-(top - gap), -max, 0);
  else if (top + height + gap > visibleTop + viewport) next = clamp(-(top + height + gap - viewport), -max, 0);
  return next;
}

/** 下一句那一列放得下吗：列厚随字号长，宽度不够就只画当前句（多一列会把当前句挤出视口）。 */
export function nextColumnFits(options) {
  const { viewportWidth, fontPx, columns } = options ?? {};
  const width = finite(viewportWidth);
  const font = finite(fontPx);
  const used = finite(columns);
  if (width === null || font === null || used === null || width <= 0 || font <= 0 || used < 1) return false;
  const available = width - 2 * VERTICAL_COLUMN_PADDING_PX;
  return available >= font * VERTICAL_COLUMN_THICKNESS_RATIO * (used + 1);
}
