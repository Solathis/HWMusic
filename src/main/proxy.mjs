/**
 * 统一 HTTP 代理：设置/环境变量 → undici 全局 dispatcher → 业务请求。
 * `settings.json` 是唯一真源；装配必须发生在任何业务请求之前。
 * `main.mjs` 在建桥/建调度器前调用 `applyStartupProxy`，`test/proxy.test.mjs` 用源码顺序扫描钉住。
 * 方式与作用范围见 src/shared/proxy-mode.mjs：只有「全部请求」才动内核出口；环境变量兜底只在系统代理与自定义都没有时生效，且必须发一条可见提示。
 * 凭据只进 undici 的 `auth`；自拼 URI、日志与文案里只有 `host:port`。
 */
import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher as installGlobalDispatcher } from "undici";

import { proxyModeAndScope } from "../shared/proxy-mode.mjs";
import { cleanHost, cleanPort, normalizeBypass } from "./settings.mjs";

/** 环境变量候选名（每项大写在前：本机 Windows 环境变量本身大小写不敏感）。 */
export const ENV_PROXY_VARIABLES = {
  https: ["HTTPS_PROXY", "https_proxy"],
  http: ["HTTP_PROXY", "http_proxy"],
  all: ["ALL_PROXY", "all_proxy"],
  noProxy: ["NO_PROXY", "no_proxy"],
};

/** 受支持的代理协议：Chromium 与 undici 都认这些（其余一律忽略而不是猜）。 */
export const PROXY_SCHEMES = ["http:", "https:", "socks5:", "socks:"];

const DEFAULT_PORTS = { "http:": 80, "https:": 443 };

const defaultLog = (message) => console.error("[hwmusic-core]", message);

const base64 = (text) => Buffer.from(text, "utf8").toString("base64");

/** 归一后的代理计划：`{host, port, auth, noProxy, scheme, source}`。
 * `auth` 是 base64 的 `user:password`；`source` 只在环境变量兜底时有值。 */
function plan(parts) {
  return Object.freeze({
    scheme: parts.scheme ?? "http:",
    host: parts.host,
    port: parts.port,
    auth: parts.auth ?? null,
    noProxy: parts.noProxy ?? [],
    source: parts.source ?? null,
  });
}

function authFor(username, password) {
  return username === "" && password === "" ? null : base64(`${username}:${password}`);
}

/** 设置里的代理对象 → 代理计划：只有自定义方式才算配，没填全一律 `null`（直连），host/port 这里再清洗一遍。 */
export function proxyPlan(proxy) {
  if (proxy === null || typeof proxy !== "object" || Array.isArray(proxy)) return null;
  if (proxyModeAndScope(proxy).mode !== "custom") return null;
  const host = cleanHost(proxy.host);
  const port = cleanPort(proxy.port);
  if (host === null || port === null) return null;

  const username = typeof proxy.username === "string" ? proxy.username : "";
  const password = typeof proxy.password === "string" ? proxy.password : "";
  return plan({
    host,
    port,
    auth: authFor(username, password),
    noProxy: normalizeBypass(proxy.bypass),
  });
}

/** 代理计划 → `ProxyAgent` 选项（`{uri, auth?}`）：**uri 里永远没有凭据**。 */
export function agentOptions(proxyPlanValue) {
  if (proxyPlanValue === null) return null;
  const uri = `${proxyPlanValue.scheme}//${proxyPlanValue.host}:${proxyPlanValue.port}`;
  return proxyPlanValue.auth === null ? { uri } : { uri, auth: proxyPlanValue.auth };
}

/** 代理计划 → 全局 dispatcher 选项：例外列表进 `noProxy`（直连例外不是摆设）。 */
export function dispatcherOptions(proxyPlanValue) {
  if (proxyPlanValue === null) return null;
  const uri = `${proxyPlanValue.scheme}//${proxyPlanValue.host}:${proxyPlanValue.port}`;
  const noProxy = Array.isArray(proxyPlanValue.noProxy)
    ? proxyPlanValue.noProxy.join(",")
    : String(proxyPlanValue.noProxy ?? "");
  const options = { httpProxy: uri, httpsProxy: uri, noProxy };
  if (proxyPlanValue.auth !== null) options.auth = proxyPlanValue.auth;
  return options;
}

/** 只给日志/提示用的描述：`host:port`（凭据绝不出现）。 */
export function describePlan(proxyPlanValue) {
  return proxyPlanValue === null ? null : `${proxyPlanValue.host}:${proxyPlanValue.port}`;
}

/** 默认 agent 工厂：`EnvHttpProxyAgent` 是唯一认 `noProxy` 的 dispatcher。 */
export const defaultAgentFactory = (options) => new EnvHttpProxyAgent(options);

/** 造一个 dispatcher（注入用工厂函数，不用类：测试要能顺手包一层，比如关掉隧道）。 */
export function createProxyDispatcher(options, { agentFactory = defaultAgentFactory } = {}) {
  return agentFactory(options);
}

/** 坏值回显：绝不把原文拼进日志/提示——能解析出主机就给 `scheme://host:port`（userinfo 已被剥掉），其余给固定短语。 */
export function redactProxyValue(raw) {
  if (typeof raw === "string") {
    try {
      const url = new URL(raw);
      if (url.host !== "") {
        const port = url.port === "" ? "" : `:${url.port}`;
        return `「${url.protocol}//${url.hostname}${port}」`;
      }
    } catch {
      // 解析不了：下面统一走"不回显"
    }
  }
  return REDACTED_VALUE;
}

/** 无法安全回显时的固定短语（说清为什么不给，而不是给一半）。 */
export const REDACTED_VALUE = "（内容不予回显：可能内联着凭据）";

/** 环境变量 → 代理计划；值不可用时给出结构化 `problem`（"忽略了"也要说出来）。 */
export function readEnvProxy(env = {}) {
  const lookup = (names) => {
    for (const name of names) {
      const value = env?.[name];
      if (typeof value === "string" && value.trim() !== "") {
        return { name: name.toUpperCase(), value: value.trim() };
      }
    }
    return null;
  };

  const noProxy = normalizeBypass(lookup(ENV_PROXY_VARIABLES.noProxy)?.value ?? "");
  const found =
    lookup(ENV_PROXY_VARIABLES.https) ?? lookup(ENV_PROXY_VARIABLES.http) ?? lookup(ENV_PROXY_VARIABLES.all);
  if (found === null) return { plan: null, problem: null };

  const ignored = (reason) => ({ plan: null, problem: { variable: found.name, reason } });
  let url;
  try {
    url = new URL(found.value);
  } catch {
    return ignored(`环境变量 ${found.name} 的值${redactProxyValue(found.value)}不是可用的代理地址，已忽略`);
  }
  if (!PROXY_SCHEMES.includes(url.protocol)) {
    return ignored(
      `环境变量 ${found.name} 的值${redactProxyValue(found.value)}不是受支持的代理协议（只认 http/https/socks5），已忽略`,
    );
  }

  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  return {
    plan: plan({
      scheme: url.protocol,
      host: url.hostname,
      port: url.port === "" ? (DEFAULT_PORTS[url.protocol] ?? 80) : Number(url.port),
      auth: authFor(username, password),
      noProxy,
      source: found.name,
    }),
    problem: null,
  };
}

/** 宿主（Rust）读到的系统代理经这个环境变量交给 core：值固定是 `http://host:port`，没有系统代理时宿主不设。 */
export const SYSTEM_PROXY_ENV = "HWMUSIC_SYSTEM_PROXY";

/** 系统代理 → 代理计划：只认宿主写的 `http://host:port`，坏值或带凭据的值都当没有（null）。 */
export function systemProxyPlan(env = {}) {
  const raw = env?.[SYSTEM_PROXY_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  const host = cleanHost(url.hostname);
  const port = cleanPort(url.port === "" ? 80 : url.port);
  if (host === null || port === null) return null;
  return plan({ host, port });
}

/**
 * 按设置装配全局 dispatcher（配了才动，没配什么都不做）。
 *
 * @returns {{applied: boolean, source: string|null, uri: string|null, plan: object|null}}
 */
export function applySettingsProxy({
  proxy,
  setGlobalDispatcher = installGlobalDispatcher,
  agentFactory = defaultAgentFactory,
  log = defaultLog,
} = {}) {
  const proxyPlanValue = proxyPlan(proxy);
  if (proxyPlanValue === null) {
    return { applied: false, source: null, uri: null, plan: null };
  }
  setGlobalDispatcher(createProxyDispatcher(dispatcherOptions(proxyPlanValue), { agentFactory }));
  const uri = agentOptions(proxyPlanValue).uri;
  log(`已按设置装配 HTTP 代理：${describePlan(proxyPlanValue)}（例外：${proxyPlanValue.noProxy.join(",") || "无"}）`);
  return { applied: true, source: "settings", uri, plan: proxyPlanValue };
}

/**
 * 启动装配：只有「全部请求」才动内核出口；顺序是自定义（设置）→ 系统代理 → 环境变量兜底；走了代理或忽略了坏值都给可见提示。
 *
 * @returns {{applied: boolean, source: "settings"|"system"|"env"|null, uri: string|null, notice: string|null}}
 */
export function applyStartupProxy({
  settings = null,
  env = {},
  setGlobalDispatcher = installGlobalDispatcher,
  agentFactory = defaultAgentFactory,
  log = defaultLog,
} = {}) {
  const rawProxy = settings?.data?.proxy ?? null;
  const { mode, scope } = proxyModeAndScope(rawProxy);
  const none = { applied: false, source: null, uri: null, notice: null };
  if (mode === "off" || scope === "update") {
    log(mode === "off" ? "内核直连：设置为不使用代理" : "内核直连：代理只用于检查更新");
    return none;
  }

  if (mode === "custom") {
    const fromSettings = applySettingsProxy({ proxy: rawProxy, setGlobalDispatcher, agentFactory, log });
    if (fromSettings.applied) {
      return {
        applied: true,
        source: "settings",
        uri: fromSettings.uri,
        notice: `已按设置启用 HTTP 代理 ${describePlan(fromSettings.plan)}`,
      };
    }
  } else {
    const systemPlan = systemProxyPlan(env);
    if (systemPlan !== null) {
      setGlobalDispatcher(createProxyDispatcher(dispatcherOptions(systemPlan), { agentFactory }));
      log(`已按系统代理装配 HTTP 代理：${describePlan(systemPlan)}`);
      return {
        applied: true,
        source: "system",
        uri: agentOptions(systemPlan).uri,
        notice: `已按系统代理启用 HTTP 代理 ${describePlan(systemPlan)}`,
      };
    }
  }

  const missing = mode === "custom" ? "设置里的代理没填全" : "系统没有设置代理";
  const { plan: envPlan, problem } = readEnvProxy(env);
  if (envPlan === null) {
    if (problem === null) return none;
    log(problem.reason);
    return { ...none, notice: `代理设置未生效：${problem.reason}` };
  }

  setGlobalDispatcher(createProxyDispatcher(dispatcherOptions(envPlan), { agentFactory }));
  const uri = agentOptions(envPlan).uri;
  log(`${missing}：按环境变量 ${envPlan.source} 装配 HTTP 代理 ${describePlan(envPlan)}`);
  return {
    applied: true,
    source: "env",
    uri,
    notice: `${missing}，已按环境变量 ${envPlan.source} 使用 HTTP 代理 ${describePlan(envPlan)}`,
  };
}

/** 测试连接的默认超时：够一次握手，又不至于让设置页卡住。 */
export const PROXY_TEST_TIMEOUT_MS = 10_000;

/**
 * 测试连接：用独立的 `ProxyAgent`（绝不换掉全局 dispatcher）按所选方式向给定 URL 发一次请求；拿到任何 HTTP 响应（407 除外）都算连通，结果不回显凭据。
 *
 * @param {object} options
 * @param {object} options.proxy 设置里的代理对象（表单草稿原样）
 * @param {string} options.url 被请求的 URL（由调用方给，本模块不猜目标）
 * @param {object} [options.env] 读系统代理用的环境变量（sidecar 传 process.env）
 */
export async function testProxyConnection({
  proxy,
  url,
  env = {},
  timeoutMs = PROXY_TEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  agentFactory = (options) => new ProxyAgent(options),
  log = defaultLog,
} = {}) {
  const { mode } = proxyModeAndScope(proxy);
  if (mode === "off") {
    return { ok: false, error: { kind: "not_configured", message: "没有使用代理：请求直连，不需要测试" } };
  }
  const proxyPlanValue = mode === "system" ? systemProxyPlan(env) : proxyPlan(proxy);
  if (proxyPlanValue === null) {
    return mode === "system"
      ? {
          ok: false,
          error: { kind: "no_system_proxy", message: "系统没有设置代理（自动配置脚本 PAC 暂不支持）：请求会直连" },
        }
      : { ok: false, error: { kind: "not_configured", message: "自定义代理没填全（主机与端口都要有）" } };
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, error: { kind: "invalid_url", message: "测试连接需要一个合法的 http(s) URL" } };
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    return { ok: false, error: { kind: "invalid_url", message: "测试连接只支持 http(s) URL" } };
  }

  const via = `${mode === "system" ? "系统代理" : "HTTP 代理"} ${describePlan(proxyPlanValue)}`;
  const dispatcher = createProxyDispatcher(agentOptions(proxyPlanValue), { agentFactory });
  const signal = AbortSignal.timeout(timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(target.href, { dispatcher, signal });
    const ms = Date.now() - startedAt;
    try {
      await response.body?.cancel();
    } catch {
      // 关掉响应体只是省资源，失败不影响结论
    }
    if (response.status === 407) {
      log(`测试连接：经${via} 访问 ${target.host}，代理要求认证（407）`);
      return {
        ok: false,
        ms,
        status: response.status,
        error: { kind: "proxy_auth_required", message: "代理要求认证（407）：请检查用户名与密码" },
      };
    }
    // 目标回 403/404 也说明请求已经穿过代理到了目标：连通性只看这一点，状态码只进日志。
    log(`测试连接：经${via} 访问 ${target.host}，HTTP ${response.status}，耗时 ${ms} 毫秒`);
    return { ok: true, ms, status: response.status };
  } catch (cause) {
    const ms = Date.now() - startedAt;
    if (signal.aborted) {
      log(`测试连接：经${via} 访问 ${target.host} 超时（${timeoutMs} 毫秒）`);
      return { ok: false, ms, error: { kind: "timeout", message: `测试连接超时（${timeoutMs} 毫秒）` } };
    }
    // undici 的 ProxyAgent 把代理回的 407 拦成错误，所以「代理要认证」通常走这里，而不是上面的 status 分支。
    if (isProxyAuthFailure(cause)) {
      log(`测试连接：经${via} 访问 ${target.host}，代理要求认证（407）`);
      return {
        ok: false,
        ms,
        error: { kind: "proxy_auth_required", message: "代理要求认证（407）：请检查用户名与密码" },
      };
    }
    // fetch 自己只说 fetch failed，真正的原因在 cause 里。
    const inner = cause?.cause ?? cause;
    const detail = inner?.message || inner?.code || cause?.message || "未知原因";
    log(`测试连接：经${via} 访问 ${target.host} 失败（${detail}）`);
    return { ok: false, ms, error: { kind: "network", message: `无法通过该代理建立连接（${detail}）` } };
  }
}

/** 代理要认证的判定：只看 undici 那一条固定文案/状态码，不做宽泛的字符串联想。 */
function isProxyAuthFailure(cause) {
  const text = `${cause?.message ?? ""} ${cause?.cause?.message ?? ""}`;
  return text.includes("407") || text.includes("Proxy Authentication Required");
}
