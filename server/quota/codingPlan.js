// 编程套餐额度适配。接口与字段语义对齐 CC Switch 的 coding_plan 服务，
// 但凭据只参与当前请求和哈希缓存键，不进入快照。

import { createHash, createHmac } from 'node:crypto';

const CACHE_TTL_MS = 60_000;
const VOLCENGINE_HOST = 'open.volcengineapi.com';
const VOLCENGINE_VERSION = '2024-01-01';
const VOLCENGINE_SERVICE = 'ark';
const VOLCENGINE_CONTENT_TYPE = 'application/json; charset=utf-8';
const VOLCENGINE_SIGNED_HEADERS = 'host;x-date;x-content-sha256;content-type';

export const CODING_PLAN_PROVIDERS = Object.freeze([
  'kimi',
  'zhipu',
  'zhipu_team',
  'minimax',
  'zenmux',
  'volcengine',
  'opencode_go',
]);

const PROVIDER_ALIASES = Object.freeze({
  kimi: 'kimi',
  zhipu: 'zhipu',
  zhipu_cn: 'zhipu',
  zhipu_en: 'zhipu',
  zhipu_team: 'zhipu_team',
  minimax: 'minimax',
  minimax_cn: 'minimax',
  minimax_global: 'minimax',
  minimax_en: 'minimax',
  zenmux: 'zenmux',
  volcengine: 'volcengine',
  opencode_go: 'opencode_go',
});

const sharedCache = createCodingPlanQuotaCache();

export function createCodingPlanQuotaCache(ttlMs = CACHE_TTL_MS) {
  return { ttlMs, entries: new Map() };
}

export function detectCodingPlanProvider(subscription = {}) {
  const explicit = cleanString(subscription.quotaProvider || subscription.codingPlanProvider);
  if (explicit) return PROVIDER_ALIASES[explicit.toLowerCase()] || null;

  const baseUrl = cleanString(subscription.quotaBaseUrl || subscription.baseUrl)?.toLowerCase() || '';
  if (baseUrl.includes('api.kimi.com/coding')) return 'kimi';
  if (baseUrl.includes('bigmodel.cn') || baseUrl.includes('api.z.ai')) return 'zhipu';
  if (baseUrl.includes('api.minimaxi.com') || baseUrl.includes('api.minimax.io')) return 'minimax';
  if (baseUrl.includes('zenmux')) return 'zenmux';
  if (baseUrl.includes('opencode.ai/zen/go')) return 'opencode_go';
  if (baseUrl.includes('volces.com/api/plan') || baseUrl.includes('volces.com/api/coding')) return 'volcengine';

  const label = `${subscription.name || ''} ${subscription.plan || ''}`.toLowerCase();
  if (label.includes('kimi')) return 'kimi';
  if (label.includes('智谱') || label.includes('zhipu') || /(^|\W)glm(\W|$)/i.test(label)) return 'zhipu';
  if (label.includes('minimax')) return 'minimax';
  if (label.includes('zenmux')) return 'zenmux';
  if (label.includes('opencode') && /(^|\W)go(\W|$)/i.test(label)) return 'opencode_go';
  if (label.includes('volcengine') || label.includes('火山') || label.includes('方舟')) return 'volcengine';
  return null;
}

export function parseKimiQuota(body) {
  if (!body || typeof body !== 'object') return null;
  let fiveHour = null;
  for (const item of Array.isArray(body.limits) ? body.limits : []) {
    const detail = item?.detail;
    const limit = numberValue(detail?.limit);
    const remaining = numberValue(detail?.remaining);
    if (limit !== null && limit > 0 && remaining !== null) {
      fiveHour = quotaWindow(Math.max(0, limit - remaining) / limit * 100, detail?.resetTime);
      break;
    }
  }

  const weeklyLimit = numberValue(body.usage?.limit);
  const weeklyRemaining = numberValue(body.usage?.remaining);
  const week = weeklyLimit !== null && weeklyLimit > 0 && weeklyRemaining !== null
    ? quotaWindow(Math.max(0, weeklyLimit - weeklyRemaining) / weeklyLimit * 100, body.usage?.resetTime)
    : null;
  return quotaResult({ fiveHour, week });
}

export function parseZhipuQuota(body) {
  if (!body || typeof body !== 'object' || body.success === false) return null;
  const data = body.data;
  if (!data || typeof data !== 'object') return null;

  let fiveHour = null;
  let week = null;
  const unclassified = [];
  for (const item of Array.isArray(data.limits) ? data.limits : []) {
    const type = String(item?.type || '').toUpperCase();
    if (type !== 'TOKENS_LIMIT' && type !== 'CREDIT_LIMIT') continue;
    const percentage = numberValue(item.percentage);
    if (percentage === null) continue;
    const window = quotaWindow(percentage, item.nextResetTime);
    const unit = numberValue(item.unit);
    if (unit === 3 && !fiveHour) fiveHour = window;
    else if (unit === 6 && !week) week = window;
    else unclassified.push({ window, resetAt: window.resetAt });
  }

  // 旧响应可能没有 unit。与 CC Switch 一致：无重置的条目优先视为 5h，
  // 其余按重置时间升序填充空槽，绝不自行生成重置时间。
  unclassified.sort((a, b) => {
    if (a.resetAt === null && b.resetAt !== null) return -1;
    if (a.resetAt !== null && b.resetAt === null) return 1;
    return (a.resetAt || 0) - (b.resetAt || 0);
  });
  for (const item of unclassified) {
    if (!fiveHour) fiveHour = item.window;
    else if (!week) week = item.window;
  }

  return quotaResult({ fiveHour, week }, { planLabel: cleanString(data.level) });
}

export function parseMiniMaxQuota(body) {
  if (!body || typeof body !== 'object') return null;
  const statusCode = numberValue(body.base_resp?.status_code);
  if (statusCode !== null && statusCode !== 0) return null;
  const item = (Array.isArray(body.model_remains) ? body.model_remains : [])
    .find(entry => entry?.model_name === 'general');
  if (!item) return null;

  const remaining = numberValue(item.current_interval_remaining_percent);
  const fiveHour = remaining === null ? null : quotaWindow(100 - remaining, item.end_time);
  const weeklyRemaining = numberValue(item.current_weekly_remaining_percent);
  const week = numberValue(item.current_weekly_status) === 1 && weeklyRemaining !== null
    ? quotaWindow(100 - weeklyRemaining, item.weekly_end_time)
    : null;
  return quotaResult({ fiveHour, week });
}

export function parseZenMuxQuota(body) {
  if (!body || typeof body !== 'object' || body.success !== true || !body.data) return null;
  const make = value => {
    const ratio = numberValue(value?.usage_percentage);
    if (ratio === null) return null;
    return quotaWindow(ratio * 100, value?.resets_at, {
      usedValueUsd: numberValue(value?.used_value_usd),
      maxValueUsd: numberValue(value?.max_value_usd),
    });
  };
  const tier = cleanString(body.data.plan?.tier);
  const status = cleanString(body.data.account_status);
  const planLabel = tier ? `${tier}${status ? ` (${status})` : ''}` : null;
  return quotaResult({
    fiveHour: make(body.data.quota_5_hour),
    week: make(body.data.quota_7_day),
  }, { planLabel });
}

export function parseOpenCodeGoQuota(body) {
  const usage = body?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const make = value => {
    const percentage = numberValue(value?.percent);
    if (percentage === null) return null;
    // 0% 时上游返回 now+窗口长度的占位值，不把它展示成真实重置倒计时。
    return quotaWindow(percentage, percentage > 0 ? value?.resetsAt : null);
  };
  return quotaResult({
    fiveHour: make(usage.rolling),
    week: make(usage.weekly),
    month: make(usage.monthly),
  });
}

export function parseVolcengineAfpQuota(body) {
  const result = body?.Result || body;
  if (!result || typeof result !== 'object') return null;
  const make = key => {
    const value = result[key];
    const limit = numberValue(value?.Quota);
    if (limit === null || limit <= 0) return null;
    const used = numberValue(value?.Used) ?? 0;
    return quotaWindow(used / limit * 100, value?.ResetTime, { used, limit });
  };
  const planType = cleanString(result.PlanType);
  return quotaResult({
    fiveHour: make('AFPFiveHour'),
    week: make('AFPWeekly'),
    month: make('AFPMonthly'),
  }, { planLabel: planType ? `Agent Plan ${planType}` : 'Agent Plan' });
}

export function parseVolcengineCodingQuota(body) {
  const result = body?.Result || body;
  if (!result || typeof result !== 'object') return null;
  const entries = [result.QuotaUsage, result.Usages, result.Details].find(Array.isArray) || [];
  const windows = { fiveHour: null, week: null, month: null };
  for (const item of entries) {
    const label = cleanString(item?.Level || item?.Type || item?.Period || item?.Label || item?.Window)?.toLowerCase();
    const key = codingWindowKey(label);
    if (!key || windows[key]) continue;
    const percentage = numberValue(item?.Percent ?? item?.UsedPercent ?? item?.UsagePercent);
    if (percentage === null) continue;
    windows[key] = quotaWindow(percentage, item?.ResetTime ?? item?.ResetTimestamp);
  }
  return quotaResult(windows, { planLabel: 'Coding Plan' });
}

export function signVolcengineRequest({
  accessKeyId,
  secretAccessKey,
  region = 'cn-beijing',
  action,
  now = Date.now(),
}) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid signing time');
  const xDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const shortDate = xDate.slice(0, 8);
  const canonicalQuery = [
    ['Action', action],
    ['Region', region],
    ['Version', VOLCENGINE_VERSION],
  ].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&');
  const body = '';
  const bodyHash = sha256Hex(body);
  const canonicalHeaders = `host:${VOLCENGINE_HOST}\nx-date:${xDate}\nx-content-sha256:${bodyHash}\ncontent-type:${VOLCENGINE_CONTENT_TYPE}\n`;
  const canonicalRequest = `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${VOLCENGINE_SIGNED_HEADERS}\n${bodyHash}`;
  const credentialScope = `${shortDate}/${region}/${VOLCENGINE_SERVICE}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const dateKey = hmac(secretAccessKey, shortDate);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, VOLCENGINE_SERVICE);
  const signingKey = hmac(serviceKey, 'request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${VOLCENGINE_SIGNED_HEADERS}, Signature=${signature}`;

  return {
    url: `https://${VOLCENGINE_HOST}/?${canonicalQuery}`,
    method: 'POST',
    body,
    headers: {
      'X-Date': xDate,
      'X-Content-Sha256': bodyHash,
      'Content-Type': VOLCENGINE_CONTENT_TYPE,
      Authorization: authorization,
    },
  };
}

export async function fetchCodingPlanQuota(subscription = {}, options = {}) {
  const provider = detectCodingPlanProvider(subscription);
  if (!provider) return null;
  const credentials = resolveCredentials(provider, subscription);
  if (!credentials) return null;

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const cache = validCache(options.cache) ? options.cache : sharedCache;
  const key = cacheKey(provider, credentials);
  const cached = cache.entries.get(key);
  if (cached && now - cached.fetchedAt < cache.ttlMs) return cloneQuota(cached.quota);

  const request = options.request || defaultRequest;
  let quota;
  try {
    quota = provider === 'volcengine'
      ? await queryVolcengine(credentials, request, now)
      : await queryBearerProvider(provider, credentials, request);
  } catch (error) {
    if (error instanceof DeterministicResponseError) {
      cache.entries.delete(key);
      return null;
    }
    return cached ? markStale(cached.quota, cached.fetchedAt) : null;
  }

  if (!quota) {
    // 鉴权、订阅资格、业务错误或响应结构改变都是确定性结果；不能用旧值掩盖。
    cache.entries.delete(key);
    return null;
  }
  const normalized = {
    ...quota,
    provider,
    source: 'api',
    stale: false,
    queriedAt: now,
  };
  cache.entries.set(key, { fetchedAt: now, quota: cloneQuota(normalized) });
  return normalized;
}

async function queryBearerProvider(provider, credentials, request) {
  const { url, headers } = providerRequest(provider, credentials);
  if (!url) return null;
  const response = await request({ url, method: 'GET', headers });
  if (!response || !response.ok) return null;
  const body = await readJson(response);
  if (provider === 'kimi') return parseKimiQuota(body);
  if (provider === 'zhipu' || provider === 'zhipu_team') return parseZhipuQuota(body);
  if (provider === 'minimax') return parseMiniMaxQuota(body);
  if (provider === 'zenmux') return parseZenMuxQuota(body);
  if (provider === 'opencode_go') return parseOpenCodeGoQuota(body);
  return null;
}

async function queryVolcengine(credentials, request, now) {
  for (const action of ['GetAFPUsage', 'GetCodingPlanUsage']) {
    const signed = signVolcengineRequest({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      region: credentials.region,
      action,
      now,
    });
    const response = await request(signed);
    if (!response) return null;
    if (!response.ok) {
      // 两个套餐共用同一 AK/SK；401/403 明确为硬鉴权失败。
      if (response.status === 401 || response.status === 403) return null;
      // 火山网关也常用 400 + ResponseMetadata.Error 表示签名/权限错误。
      try {
        const errorBody = await response.json();
        const error = volcengineResponseError(errorBody);
        if (error && isVolcengineAuthError(error.code)) return null;
      } catch { /* 非 JSON 的普通 HTTP 错误，继续探测另一套餐 */ }
      continue;
    }
    const body = await readJson(response);
    const error = volcengineResponseError(body);
    if (error) {
      if (isVolcengineAuthError(error.code)) return null;
      continue;
    }
    const quota = action === 'GetAFPUsage'
      ? parseVolcengineAfpQuota(body)
      : parseVolcengineCodingQuota(body);
    if (quota) return quota;
  }
  return null;
}

function providerRequest(provider, credentials) {
  if (provider === 'kimi') {
    return {
      url: 'https://api.kimi.com/coding/v1/usages',
      headers: { Authorization: `Bearer ${credentials.apiKey}`, Accept: 'application/json' },
    };
  }
  if (provider === 'zhipu_team') {
    return {
      url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2',
      headers: {
        Authorization: credentials.apiKey,
        'bigmodel-organization': credentials.teamOrganizationId,
        'bigmodel-project': credentials.teamProjectId,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
    };
  }
  if (provider === 'zhipu') {
    const host = credentials.baseUrl.toLowerCase().includes('bigmodel.cn')
      ? 'https://open.bigmodel.cn'
      : 'https://api.z.ai';
    return {
      url: `${host}/api/monitor/usage/quota/limit`,
      // 智谱额度接口要求原始 key，不能添加 Bearer 前缀。
      headers: { Authorization: credentials.apiKey, 'Content-Type': 'application/json', 'Accept-Language': 'en-US,en' },
    };
  }
  if (provider === 'minimax') {
    const host = credentials.baseUrl.toLowerCase().includes('api.minimax.io')
      ? 'api.minimax.io'
      : 'api.minimaxi.com';
    return {
      url: `https://${host}/v1/api/openplatform/coding_plan/remains`,
      headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' },
    };
  }
  if (provider === 'zenmux') {
    return {
      url: credentials.baseUrl,
      headers: { Authorization: `Bearer ${credentials.apiKey}`, Accept: 'application/json' },
    };
  }
  if (provider === 'opencode_go') {
    return {
      url: 'https://opencode.ai/zen/go/v1/usage',
      headers: { Authorization: `Bearer ${credentials.apiKey}`, Accept: 'application/json' },
    };
  }
  return { url: null, headers: {} };
}

function resolveCredentials(provider, subscription) {
  const configuredProvider = cleanString(subscription.quotaProvider || subscription.codingPlanProvider)?.toLowerCase();
  let baseUrl = cleanString(subscription.quotaBaseUrl || subscription.baseUrl);
  if (provider === 'volcengine') {
    const accessKeyId = cleanString(subscription.accessKeyId || process.env.VOLCENGINE_ACCESS_KEY_ID);
    const secretAccessKey = cleanString(subscription.secretAccessKey || process.env.VOLCENGINE_SECRET_ACCESS_KEY);
    if (!accessKeyId || !secretAccessKey) return null;
    baseUrl ||= 'https://ark.cn-beijing.volces.com/api/coding';
    return { accessKeyId, secretAccessKey, baseUrl, region: volcengineRegion(baseUrl) };
  }

  const envKey = {
    kimi: process.env.KIMI_API_KEY,
    zhipu: process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY,
    zhipu_team: process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY,
    minimax: process.env.MINIMAX_API_KEY,
    zenmux: process.env.ZENMUX_API_KEY,
    opencode_go: process.env.OPENCODE_GO_API_KEY,
  }[provider];
  const apiKey = cleanString(subscription.apiKey || envKey);
  if (!apiKey) return null;

  if (provider === 'zhipu_team') {
    const teamOrganizationId = cleanString(subscription.teamOrganizationId);
    const teamProjectId = cleanString(subscription.teamProjectId);
    if (!teamOrganizationId || !teamProjectId) return null;
    return { apiKey, teamOrganizationId, teamProjectId, baseUrl: 'https://open.bigmodel.cn' };
  }
  if (provider === 'zhipu') {
    if (!baseUrl) baseUrl = configuredProvider === 'zhipu_en'
      ? 'https://api.z.ai/api/paas/v4'
      : 'https://open.bigmodel.cn/api/paas/v4';
  } else if (provider === 'minimax') {
    if (!baseUrl) baseUrl = ['minimax_global', 'minimax_en'].includes(configuredProvider)
      ? 'https://api.minimax.io'
      : 'https://api.minimaxi.com';
  } else if (provider === 'zenmux') {
    if (!baseUrl) return null;
  } else if (provider === 'kimi') {
    baseUrl ||= 'https://api.kimi.com/coding';
  } else if (provider === 'opencode_go') {
    baseUrl ||= 'https://opencode.ai/zen/go';
  }
  return { apiKey, baseUrl };
}

async function defaultRequest({ url, method, headers, body }) {
  return fetch(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : body,
    signal: AbortSignal.timeout(15_000),
  });
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    throw new DeterministicResponseError('invalid JSON response', { cause: error });
  }
}

function quotaResult({ fiveHour = null, week = null, month = null }, extra = {}) {
  if (!fiveHour && !week && !month) return null;
  return { fiveHour, week, month, source: 'api', ...extra };
}

function quotaWindow(usedPct, resetValue, extra = {}) {
  return {
    usedPct,
    resetAt: resetTimestamp(resetValue),
    source: 'api',
    ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== null && value !== undefined)),
  };
}

function resetTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return resetTimestamp(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function codingWindowKey(label) {
  if (['session', '5h', 'fivehour', 'five_hour', 'rolling_5h'].includes(label)) return 'fiveHour';
  if (['weekly', 'week', '7d'].includes(label)) return 'week';
  if (['monthly', 'month'].includes(label)) return 'month';
  return null;
}

function volcengineRegion(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname.split('.').find(part => part.startsWith('cn-') || part.startsWith('ap-')) || 'cn-beijing';
  } catch {
    return 'cn-beijing';
  }
}

function volcengineResponseError(body) {
  const error = body?.ResponseMetadata?.Error || body?.Error;
  if (!error || typeof error !== 'object') return null;
  const code = cleanString(error.Code) || '';
  const message = cleanString(error.Message) || '';
  return code || message ? { code, message } : null;
}

function isVolcengineAuthError(code) {
  const value = String(code || '').toLowerCase();
  return ['auth', 'signature', 'accessdenied', 'denied', 'unauthorized', 'forbidden', 'credential', 'token']
    .some(part => value.includes(part));
}

function cacheKey(provider, credentials) {
  return `${provider}:${sha256Hex(JSON.stringify(credentials))}`;
}

function validCache(cache) {
  return cache && cache.entries instanceof Map && Number.isFinite(cache.ttlMs) && cache.ttlMs >= 0;
}

function cloneQuota(quota) {
  return structuredClone(quota);
}

function markStale(quota, fetchedAt) {
  const copy = cloneQuota(quota);
  copy.stale = true;
  copy.cachedAt = fetchedAt;
  return copy;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

class DeterministicResponseError extends Error {}
