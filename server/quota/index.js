// 额度编排: official -> api -> manual -> estimate。
// 每个窗口独立选择最可信数据；显式手动配置比本地估算更可信。

import { rollingUsage, toEstimateQuota } from './rollingWindow.js';
import { fromOfficialRateLimit } from './codexLog.js';
import { fetchClaudeQuota } from './claudeApi.js';
import { fetchCodexQuota } from './codexApi.js';
import { fetchGlmQuota } from './glmApi.js';

// ctx: {events, officialRateLimit?, apiFetcher?, manualQuota?, quotaLimits?, now?}
//   officialRateLimit: codex collector 的 latestRateLimit
//   apiFetcher: async () -> quota|null
//   manualQuota: config 手填 {fiveHour?, week?}(含 usedPct/resetAt)
//   quotaLimits: {fiveHourLimitTokens?, weekLimitTokens?} estimate 百分比上限
export async function resolveQuota(ctx) {
  const now = (ctx && ctx.now) || Date.now();
  const events = (ctx && ctx.events) || [];

  const agentKey = ctx && (ctx.agent || ctx.agentId || ctx.agentKey);

  // 1. official: 日志内嵌官方窗口数据
  let officialQ = null;
  try {
    officialQ = fromOfficialRateLimit(ctx && ctx.officialRateLimit);
  } catch { /* 降级 */ }

  // 2. api: 真实接口获取额度 (Codex wham/usage, GLM quota/limit, Claude API)
  let apiQ = null;
  try {
    let fetcher = ctx && ctx.apiFetcher;
    if (!fetcher) {
      if (agentKey === 'codex') fetcher = () => fetchCodexQuota(ctx);
      else if (agentKey === 'glm') fetcher = () => fetchGlmQuota(ctx);
      else if (agentKey === 'claude') fetcher = fetchClaudeQuota;
    }
    if (fetcher) {
      const res = await fetcher();
      if (res) apiQ = { ...res, source: res.source || 'api' };
    }
  } catch { /* 降级 */ }

  // 3. manual: 用户显式配置，用于填补 official/api 缺失的窗口
  const manual = ctx && ctx.manualQuota;
  const manualQ = manual && (manual.fiveHour || manual.week || manual.month)
    ? {
      fiveHour: withSource(manual.fiveHour, 'manual'),
      week: withSource(manual.week, 'manual'),
      month: withSource(manual.month, 'manual'),
      source: 'manual',
    }
    : null;

  // 4. estimate: 本地滚动窗口推算
  let estimateQ = null;
  try {
    const rolling = rollingUsage(events, now);
    estimateQ = toEstimateQuota(rolling, ctx && ctx.quotaLimits, agentKey);
  } catch { /* 降级 */ }

  const candidates = [officialQ, apiQ, manualQ, estimateQ].filter(Boolean);
  const fiveHour = pickWindow(candidates, 'fiveHour');
  const week = pickWindow(candidates, 'week');
  const month = pickWindow(candidates, 'month');
  if (!fiveHour && !week && !month) return null;
  const sources = new Set([fiveHour, week, month].filter(Boolean).map(window => window.source));
  return {
    fiveHour,
    week,
    month,
    // 顶层 source 保留最高优先级值以兼容旧快照，窗口级 source 是真实来源。
    source: candidates[0].source || 'unknown',
    mixed: sources.size > 1,
    sources: {
      fiveHour: fiveHour?.source || null,
      week: week?.source || null,
      month: month?.source || null,
    },
    provider: apiQ?.provider || null,
    planLabel: apiQ?.planLabel || null,
    stale: !!apiQ?.stale,
    queriedAt: apiQ?.queriedAt || null,
  };
}

function pickWindow(candidates, key) {
  for (const candidate of candidates) {
    if (candidate[key]) return withSource(candidate[key], candidate.source || 'unknown');
  }
  return null;
}

function withSource(window, source) {
  return window ? { ...window, source: window.source || source } : null;
}
