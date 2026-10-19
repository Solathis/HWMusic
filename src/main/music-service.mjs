/**
 * 音乐业务的装配（R8）：端点从**设置文档**读，读不到就是空表。
 *
 * 为什么是设置而不是环境变量/写死：业务端点全部待联调确认（docs/API_CONTRACT.md §2.1），
 * 项目红线是"未确认前不写猜测 URL，只登记文档、代码走注入"。设置文档的 `data` 里
 * 未知键原样带过（src/main/settings.mjs 的既有事实），所以联调确认后把 `musicEndpoints`
 * 写进 settings.json 即可生效，本模块与协议层一行都不用改。
 *
 * 现在**没有任何写入方**：表是空的 → 每个 `library:*` 请求都由协议层如实回
 * `endpoint_unknown`，UI 显示"接口尚未配置"。这是设计上的落点，不是坏掉。
 */
import { MUSIC_ENDPOINT_KEYS, createMusicApi } from "../protocols/music.mjs";

/** 设置文档里的端点注入键（`data.musicEndpoints`）。 */
export const MUSIC_ENDPOINTS_SETTING_KEY = "musicEndpoints";

/**
 * 从设置文档的 `data` 里收端点：只认协议层的已知键、只收非空字符串。
 *
 * 陌生键 / 空值 / 数字一律丢弃（不归一、不猜测）——多收了会让人以为某个接口能用。
 */
export function readMusicEndpoints(settingsData) {
  const source = settingsData !== null && typeof settingsData === "object" ? settingsData : {};
  const raw = source[MUSIC_ENDPOINTS_SETTING_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const endpoints = {};
  for (const key of MUSIC_ENDPOINT_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim() !== "") endpoints[key] = value.trim();
  }
  return endpoints;
}

/**
 * 造音乐服务。
 *
 * @param {object} options
 * @param {object} [options.settingsData]  设置文档的 `data`（端点来源）
 * @param {Function} [options.fetchImpl]   注入 fetch（测试）
 * @param {Function} [options.sessionHeaders] 会话头注入；**默认不带任何凭据**——
 *   凭据方案要等端点确认后的联调，本任务不猜 header 名（见 docs/API_CONTRACT.md §2.2）
 * @param {number} [options.pageSize]      默认页大小（协议层另有默认）
 */
export function createMusicService({ settingsData, fetchImpl, sessionHeaders, pageSize } = {}) {
  const endpoints = readMusicEndpoints(settingsData);
  const api = createMusicApi({
    endpoints,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(sessionHeaders === undefined ? {} : { sessionHeaders }),
    ...(pageSize === undefined ? {} : { pageSize }),
  });
  return { api, endpoints, configured: Object.keys(endpoints).length > 0 };
}
