// quota 层自测: 四级降级 + 滚动窗口语义
import { rollingUsage, toEstimateQuota } from './rollingWindow.js';
import { fromOfficialRateLimit } from './codexLog.js';
import { resolveQuota } from './index.js';

const NOW = Date.parse('2026-08-31T12:00:00Z');
const MIN = 60 * 1000;
let fails = [];
function check(c, label, detail) {
  console.log('  [' + (c ? 'PASS' : 'FAIL') + '] ' + label + (detail ? ' :: ' + detail : ''));
  if (!c) fails.push(label);
}

// ---- rollingWindow: 5h 窗口起点=窗口内最早事件 ----
console.log('=== rollingWindow ===');
{
  const events = [
    { ts: NOW - 4 * 60 * MIN, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0.5 },
    { ts: NOW - 1 * 60 * MIN, inputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0.5 },
    { ts: NOW - 10 * 24 * 60 * MIN, inputTokens: 999, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 9 },  // 10天前,窗外
  ].sort((a, b) => a.ts - b.ts);
  const r = rollingUsage(events, NOW);
  check(r.fiveHour.active === true, '5h 窗口活跃');
  check(r.fiveHour.events === 2, '5h 窗口只含 2 事件', 'n=' + r.fiveHour.events);
  check(r.fiveHour.startAt === NOW - 4 * 60 * MIN, '5h 窗口起点=窗口内最早事件');
  check(r.fiveHour.resetAt === NOW - 4 * 60 * MIN + 5 * 3600 * 1000, '5h resetAt=startAt+5h');
  check(r.fiveHour.inputTokens === 300, '5h input 合计=300', String(r.fiveHour.inputTokens));
  check(r.week.events === 2, '周窗口同样含这 2 事件(10天前事件在周窗外)');
}
{
  const r = rollingUsage([], NOW);
  check(r.fiveHour.active === false, '空事件 -> 5h 不活跃,不抛错');
}

// ---- toEstimateQuota ----
console.log('=== toEstimateQuota ===');
{
  const r = rollingUsage([
    { ts: NOW - MIN, inputTokens: 700, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 1 },
  ], NOW);
  const q = toEstimateQuota(r, { fiveHourLimitTokens: 1000, weekLimitTokens: 100000 });
  check(!!q, 'estimate 额度生成');
  check(q.fiveHour.usedPct === 100, 'usedPct=100(700+300=1000/1000)', String(q.fiveHour.usedPct));
  check(q.week.usedPct === 1, 'week usedPct=1%(1000/100000)', String(q.week.usedPct));
  check(q.source === 'estimate', 'source=estimate');
}
{
  const r = rollingUsage([], NOW);
  check(toEstimateQuota(r, {}) === null, '无活跃窗口 -> null');
}

// ---- official(codexLog) ----
console.log('=== official ===');
{
  const q = fromOfficialRateLimit({
    week: { usedPct: 42, windowMinutes: 10080, resetsAt: NOW + 86400000 },
  });
  check(q && q.source === 'official', 'official 源生成');
  check(q.week.usedPct === 42 && q.week.resetAt === NOW + 86400000, 'week 字段透传');
  check(q.fiveHour === null, '无 fiveHour 数据时为 null');
  check(fromOfficialRateLimit(null) === null, 'null 输入 -> null');
}

// ---- 四级降级 ----
console.log('=== resolveQuota 降级链 ===');
{
  // 1) official 命中即返回
  const q1 = await resolveQuota({
    officialRateLimit: { week: { usedPct: 42, windowMinutes: 10080, resetsAt: NOW + 86400000 } },
    events: [{ ts: NOW - MIN, inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0 }],
    now: NOW,
  });
  check(q1 && q1.source === 'official', '链1: official 命中');
}
{
  // 2) api 命中
  const q2 = await resolveQuota({
    apiFetcher: async () => ({ fiveHour: { usedPct: 10, resetAt: NOW + 3600000 }, week: { usedPct: 5, resetAt: NOW + 86400000 } }),
    events: [{ ts: NOW - MIN, inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0 }],
    now: NOW,
  });
  check(q2 && q2.source === 'api', '链2: api 命中');
}
{
  // 3) estimate(无 official 无 api)
  const q3 = await resolveQuota({
    events: [{ ts: NOW - MIN, inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0 }],
    now: NOW,
  });
  check(q3 && q3.source === 'estimate', '链3: estimate 降级');
  check(q3.fiveHour.usedPct === null, '无上限时 usedPct=null(仅展示用量)');
}
{
  // 4) manual 兜底(无事件)
  const q4 = await resolveQuota({
    events: [],
    manualQuota: { fiveHour: { usedPct: 30, resetAt: NOW + 7200000 } },
    now: NOW,
  });
  check(q4 && q4.source === 'manual', '链4: manual 兜底');
  check(q4.week === null, 'manual 未填 week 时为 null');
}
{
  // 显式手动额度比本地推算更可信，但不覆盖 official/api
  const q4b = await resolveQuota({
    agent: 'claude',
    events: [{ ts: NOW - MIN, inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0 }],
    manualQuota: { fiveHour: { usedPct: 30, resetAt: NOW + 7200000 } },
    now: NOW,
  });
  check(q4b && q4b.fiveHour.usedPct === 30, '手动额度不被估算值掩盖');
  check(q4b && q4b.fiveHour.source === 'manual', '手动额度保留窗口级 source');
}
{
  // 5) 全空 -> null 不抛错
  const q5 = await resolveQuota({ events: [], now: NOW });
  check(q5 === null, '全空 -> null 不抛错');
}

// 没有显式配置上限时只展示用量，不使用未验证的默认套餐容量
{
  const r = rollingUsage([
    { ts: NOW - MIN, inputTokens: 700, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 1 },
  ], NOW);
  const q = toEstimateQuota(r, null, 'claude');
  check(q.fiveHour.limit === null, '未配置上限时 limit=null');
  check(q.fiveHour.usedPct === null, '未配置上限时 usedPct=null');
}

console.log(fails.length ? '\nFAILED: ' + fails.join('; ') : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
