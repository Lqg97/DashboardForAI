// insights 自测
import { computeROI, detectDormant, buildHeatmap, buildDistribution, buildUsageSummary, buildTrendSeries, buildUsageAnalytics, buildModelDistribution } from './insights.js';

const NOW = Date.parse('2026-08-31T12:00:00Z');
const DAY = 24 * 3600 * 1000;
let fails = [];
function check(c, label, detail) {
  console.log('  [' + (c ? 'PASS' : 'FAIL') + '] ' + label + (detail ? ' :: ' + detail : ''));
  if (!c) fails.push(label);
}

console.log('=== computeROI ===');
{
  // 本月1号起,周期内成本 100,月费 50 -> ratio=2
  const evs = [
    { ts: Date.parse('2026-08-02T00:00:00Z'), costUSD: 100 },
    { ts: Date.parse('2026-07-15T00:00:00Z'), costUSD: 999 },  // 周期外
  ];
  const r = computeROI(evs, 50, null, NOW);
  check(r && r.ratio === 2, 'ROI=成本/月费=2', JSON.stringify(r));
  check(r.costUSD === 100, '周期外事件不计入');
  const r2 = computeROI(evs, null, null, NOW);
  check(r2 === null, '月费缺失 -> null');
  const r3 = computeROI(evs, 0, null, NOW);
  check(r3 === null, '月费=0 -> null');
  // billingCycleStart 外推: 60天前起点,外推2次30天 -> since 在近30天内
  const r4 = computeROI(evs, 50, NOW - 60 * DAY, NOW);
  check(r4 && r4.since === NOW - 60 * DAY + 60 * DAY, '周期起点外推到最近过去点');
}

console.log('=== detectDormant ===');
{
  const r = detectDormant([{ ts: NOW - 20 * DAY }], 14, NOW);
  check(r && r.dormant === true, '20天未用 -> dormant=true');
  const r2 = detectDormant([{ ts: NOW - 3 * DAY }], 14, NOW);
  check(r2 && r2.dormant === false, '3天前活跃 -> dormant=false');
  check(detectDormant([], 14, NOW) === null, '无事件 -> null');
  // events 未按序? detectDormant 依赖升序,乱序输入防御:取 max ts
  const r3 = detectDormant([{ ts: NOW - 1 * DAY }, { ts: NOW - 3 * DAY }], 14, NOW);
  check(r3 && r3.daysSinceActive === 1, '乱序输入取最新 ts');
}

console.log('=== buildHeatmap ===');
{
  // 2026-08-31 是周一;03:00 UTC 事件应落在 [1][3]
  const evs = [
    { ts: Date.parse('2026-08-31T03:00:00Z'), inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 1 },
    { ts: Date.parse('2026-08-30T03:00:00Z'), inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0.1 },
  ];
  const g = buildHeatmap(evs);
  check(Array.isArray(g) && g.length === 7 && g[0].length === 24, '7x24 网格');
  check(g[1][3].tokens === 150 && g[1][3].costUSD === 1, '周一03:00 格子聚合正确', g[1][3].tokens + '/' + g[1][3].costUSD);
  check(g[0][3].tokens === 10, '周日03:00 格子(08-30是周日)');
  check(buildHeatmap(null) !== null && Array.isArray(buildHeatmap(null)), 'null 输入返回空网格不抛错');
}

console.log('=== buildDistribution ===');
{
  const evs = [
    { agent: 'claude', ts: NOW - 1 * DAY, inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 90 },
    { agent: 'codex', ts: NOW - 2 * DAY, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0 },  // 0 token 但有事件
    { agent: 'codex', ts: NOW - 1 * DAY, inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 10 },
    { agent: 'opencode', ts: NOW - 45 * DAY, inputTokens: 999, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 99 },  // 30天窗口外
  ];
  const d = buildDistribution(evs, 30, NOW);
  check(d && d.length === 2, '窗口外 agent 不计入', d ? d.map(x => x.agent).join(',') : 'null');
  check(d[0].agent === 'claude' && Math.abs(d[0].pctTokens - 90.9090909) < 1e-6, 'claude ~90.9% 排第一', String(d[0].pctTokens));
  check(Math.abs(d[1].pctTokens - 9.0909091) < 1e-6, 'codex ~9.1%', String(d[1].pctTokens));
  const sumPct = d.reduce((a, x) => a + x.pctTokens, 0);
  check(Math.abs(sumPct - 100) < 1e-9, '合计=100%', String(sumPct));
  check(buildDistribution([], 30, NOW) === null, '无事件 -> null');
}

console.log('=== buildUsageSummary & Trends ===');
{
  const evs = [
    { ts: NOW - 2 * 3600000, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000, cacheWriteTokens: 500, costUSD: 0.1234 },
    { ts: NOW - 1 * 3600000, inputTokens: 2000, outputTokens: 300, cacheReadTokens: 12000, cacheWriteTokens: 0, costUSD: 0.2345 },
  ];
  const summary = buildUsageSummary(evs, NOW - 3 * 3600000, NOW);
  check(summary.totalTokens === 24000, '真实消耗 Tokens 合计=24000', String(summary.totalTokens));
  check(summary.requests === 2, '总请求数=2');
  check(summary.costUSD === 0.3579, '总成本折算正确', String(summary.costUSD));
  // 缓存命中率: 20000 / (20000 + 3000) = 20/23 ~ 86.956% -> 87%
  check(summary.cacheHitRate >= 86.9 && summary.cacheHitRate <= 87.1, '缓存命中率计算正确', String(summary.cacheHitRate));

  const trends24h = buildTrendSeries(evs, 'last24h', NOW);
  check(trends24h.length === 24, '近 24 小时产生 24 个点位');

  const analytics = buildUsageAnalytics(evs, NOW);
  check(analytics && analytics.summary && analytics.trends && analytics.models, 'buildUsageAnalytics 结构完整');
}

console.log('=== buildModelDistribution ===');
{
  const evs = [
    { ts: NOW - 2 * 3600000, model: 'claude-3-7-sonnet', agent: 'claude', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000, cacheWriteTokens: 0, costUSD: 0.1 },
    { ts: NOW - 1 * 3600000, model: 'gpt-4o', agent: 'codex', inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0.05 },
    { ts: NOW - 1 * 3600000, model: 'claude-3-7-sonnet', agent: 'pi', inputTokens: 500, outputTokens: 100, cacheReadTokens: 4000, cacheWriteTokens: 0, costUSD: 0.05 },
  ];
  const list = buildModelDistribution(evs, NOW - 3 * 3600000, NOW);
  check(list.length === 2, '聚合为 2 个模型');
  check(list[0].model === 'claude-3-7-sonnet', '用量最大的排第一');
  check(list[0].tokens === 13800, 'claude-3-7-sonnet tokens=13800', String(list[0].tokens));
  check(list[0].agents.includes('claude') && list[0].agents.includes('pi'), 'agents 列表包含多工具');
}

console.log(fails.length ? '\nFAILED: ' + fails.join('; ') : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
