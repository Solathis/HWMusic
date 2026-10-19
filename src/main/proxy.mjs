/**
 * 统一 HTTP 代理：设置/环境变量 → undici 全局 dispatcher → 业务请求。
 *
 * 分工：
 * - `settings.json` 是**唯一真源**（`src/main/settings.mjs` 读写它），这里只做"配置 → 装配"；
 * - 装配必须发生在**任何业务请求之前**（R7 的 AuthManager.restore 也在其内）：`main.mjs` 在建桥/建调度器
 *   之前调用 [`applyStartupProxy`]，`test/proxy.test.mjs` 用源码顺序扫描把这条钉死；
 * - 环境变量兜底（HTTP(S)_PROXY / ALL_PROXY / NO_PROXY）只在设置**没配**代理时生效，且**必须发一条
 *   可见提示**——用户有权知道"为什么走了代理"（谁把流量引出去了不能是个谜）。
 *
 * 凭据纪律（硬要求）：用户名/密码**只进 undici 的 `auth`**（它最终是 `proxy-authorization` 头）。
 * 我们自己拼的 URI 只有 `scheme://host:port`，日志、提示、错误文案里只有 `host:port`。
 *
 * 为什么用 `EnvHttpProxyAgent` 而不是裸 `ProxyAgent`：只有它认"例外列表"（`noProxy`）。
 * 它接受显式覆盖（`httpProxy`/`httpsProxy`/`noProxy`），所以设置路径**不会**回头去读环境变量，
 * 两条来源彼此不串味。这里核对过 undici 7.30 的实现（`lib/dispatcher/env-http-proxy-agent.js` +
 * `lib/dispatcher/proxy-agent.js`）：`auth` 只被 ProxyAgent 用作 `proxy-authorization`，
 * 直连分支的 `Agent` 忽略它——所以凭据不会漏给目标站点（`test/proxy.test.mjs` 用本地服务器实测钉住）。
 */
import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher as installGlobalDispatcher } from "undici";

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

/**
 * 归一后的代理计划：`{host, port, auth, noProxy, scheme, source}`。
 * `auth` 是 **base64 的 `user:password`**（undici 的 `auth` 就是这个语义）；没凭据时是 `null`。
 * `source` 只在环境变量兜底时才有值（写进提示，好让用户知道是哪个变量把流量引出去的）。
 */
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

/**
 * 设置里的代理对象 → 代理计划；**没填全或没开一律 `null`**（= 当没配，直连）。
 *
 * `enabled` 与"字段齐全"是两回事：`enabled:true` 但 host/port 不合法，结果同样是 `null`。
 * 这里再清洗一遍 host/port（防调用方绕过 `normalizeProxy` 直接喂表单值）。
 */
export function proxyPlan(proxy) {
  if (proxy === null || typeof proxy !== "object" || Array.isArray(proxy)) return null;
  if (proxy.enabled !== true) return null;
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

/**
 * 坏值回显：**绝不把原文拼进日志/提示**，只给"剥离后的形态"。
 *
 * 为什么连"看不出凭据"的值也不回显：用户把 `user:pass` 整串误贴进 `HTTP_PROXY` 时，
 * `new URL` 会把它当成 scheme（`user:`）+ 路径解析成功，一个 `@` 都没有——可那里面就是密码。
 * 所以只有两个出口：
 * - 能解析出主机 → `「scheme://host:port」`（userinfo 已被 URL 解析器剥掉，端口按 URL 规范归一）；
 * - 其余 → 固定短语（明说"不回显"，而不是把原文糊上去）。
 */
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
 * 启动装配：设置优先，没配则回落环境变量；生效时给出**可见提示**（用户要知道为什么走了代理）。
 *
 * @returns {{applied: boolean, source: "settings"|"env"|null, uri: string|null, notice: string|null}}
 */
export function applyStartupProxy({
  settings = null,
  env = {},
  setGlobalDispatcher = installGlobalDispatcher,
  agentFactory = defaultAgentFactory,
  log = defaultLog,
} = {}) {
  const fromSettings = applySettingsProxy({
    proxy: settings?.data?.proxy ?? null,
    setGlobalDispatcher,
    agentFactory,
    log,
  });
  if (fromSettings.applied) {
    return {
      applied: true,
      source: "settings",
      uri: fromSettings.uri,
      notice: `已按设置启用 HTTP 代理 ${describePlan(fromSettings.plan)}`,
    };
  }

  const { plan: envPlan, problem } = readEnvProxy(env);
  if (envPlan === null) {
    if (problem === null) return { applied: false, source: null, uri: null, notice: null };
    log(problem.reason);
    return { applied: false, source: null, uri: null, notice: `代理设置未生效：${problem.reason}` };
  }

  setGlobalDispatcher(createProxyDispatcher(dispatcherOptions(envPlan), { agentFactory }));
  const uri = agentOptions(envPlan).uri;
  log(`设置里没有代理：按环境变量 ${envPlan.source} 装配 HTTP 代理 ${describePlan(envPlan)}`);
  return {
    applied: true,
    source: "env",
    uri,
    notice: `设置里没有代理，已按环境变量 ${envPlan.source} 使用 HTTP 代理 ${describePlan(envPlan)}`,
  };
}

/** 测试连接的默认超时：够一次握手，又不至于让设置页卡住。 */
export const PROXY_TEST_TIMEOUT_MS = 10_000;

/**
 * 测试连接：**用独立的 `ProxyAgent`**（绝不换掉全局 dispatcher）向给定 URL 发一次请求。
 *
 * 结果里只有状态与错误摘要，**不回显凭据**。`kind`：`not_configured` / `invalid_url` /
 * `proxy_auth_required`（407：代理要认证，多半是用户名密码不对）/ `timeout` / `network` / `http_status`。
 *
 * @param {object} options
 * @param {object} options.proxy 设置里的代理对象（表单原样）
 * @param {string} options.url   被请求的 URL（由调用方给，本模块不猜目标）
 */
export async function testProxyConnection({
  proxy,
  url,
  timeoutMs = PROXY_TEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  agentFactory = (options) => new ProxyAgent(options),
} = {}) {
  const proxyPlanValue = proxyPlan(proxy);
  if (proxyPlanValue === null) {
    return {
      ok: false,
      error: { kind: "not_configured", message: "代理没开或没填全（主机与端口都要有）" },
    };
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
      return {
        ok: false,
        ms,
        status: response.status,
        error: { kind: "proxy_auth_required", message: "代理要求认证（407）：请检查用户名与密码" },
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        ms,
        status: response.status,
        error: { kind: "http_status", message: `代理连通，但目标返回 ${response.status}` },
      };
    }
    return { ok: true, ms, status: response.status };
  } catch (cause) {
    const ms = Date.now() - startedAt;
    if (signal.aborted) {
      return { ok: false, ms, error: { kind: "timeout", message: `测试连接超时（${timeoutMs} 毫秒）` } };
    }
    // undici 的 ProxyAgent 把代理回的 407 拦成错误（`lib/dispatcher/proxy-agent.js`：
    // `statusCode === 407` → `onError(new InvalidArgumentError('Proxy Authentication Required (407)'))`），
    // 所以"代理要认证"这条通常走这里，而不是上面的 status 分支（那条兜住别的 dispatcher / 注入的 fetch）。
    if (isProxyAuthFailure(cause)) {
      return {
        ok: false,
        ms,
        error: { kind: "proxy_auth_required", message: "代理要求认证（407）：请检查用户名与密码" },
      };
    }
    const detail = cause?.code ?? cause?.message ?? "未知原因";
    return { ok: false, ms, error: { kind: "network", message: `无法通过该代理建立连接（${detail}）` } };
  }
}

/** 代理要认证的判定：只看 undici 那一条固定文案/状态码，不做宽泛的字符串联想。 */
function isProxyAuthFailure(cause) {
  const text = `${cause?.message ?? ""} ${cause?.cause?.message ?? ""}`;
  return text.includes("407") || text.includes("Proxy Authentication Required");
}
