// hub-merge 单元测试: 多客户端快照合并结构与数值
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnapshots, padLast30Days } from './hub-merge.js';

const DAY = 24 * 3600 * 1000;
const now = 1788800000000;

function mkUsage(tokens, cost) {
  return {
    last5h: { i: tokens, o: 0, cr: 0, cw: 0, c: cost, tokens },
    last7d: { i: tokens, o: 0, cr: 0, cw: 0, c: cost, tokens },
    last30dByDay: [{ day: new Date(now - DAY).toISOString().slice(0, 10), tokens, costUSD: cost }],
    lastActiveAt: now - 3600 * 1000,
  };
}

const ANALYTICS = {
  summary: { today: { totalTokens: 100, inputTokens: 40, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, costUSD: 0.5, requests: 4, cacheHitRate: 55.6 }, last30d: { totalTokens: 100, inputTokens: 40, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, costUSD: 0.5, requests: 4, cacheHitRate: 55.6 } },
  trends: { last30d: [{ ts: now - DAY, label: 'x', inputTokens: 40, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, totalTokens: 100, costUSD: 0.5, requests: 4 }] },
  models: { last30d: [{ model: 'claude-opus-5', tokens: 100, inputTokens: 40, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, costUSD: 0.5, requests: 4, agents: ['claude'], cacheHitRate: 55.6, pctTokens: 100, pctCost: 100 }] },
  heatmaps: { last30d: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ tokens: 1, costUSD: 0.1 }))) },
  distributions: { last30d: [{ agent: 'claude', tokens: 100, costUSD: 0.5, requests: 4, pctTokens: 100, pctCost: 100 }] },
};

function mkSnapshot(userId) {
  return {
    generatedAt: now - 60 * 1000,
    agents: [
      {
        agent: 'claude', name: 'Claude Code', discoverable: true, quota: { week: { usedPct: 30 } },
        usage: mkUsage(1000, 1.5), models: ['claude-opus-5'],
        analytics: ANALYTICS,
      },
      {
        agent: 'codex', name: 'Codex', discoverable: true, quota: null,
        usage: mkUsage(2000, 2.0), models: [], analytics: null,
      },
    ],
    subscriptions: [
      { id: 'sub-a', name: 'Zhipu GLM', isHistorical: false, usage: { tokens30d: 1000, cost30d: 1.5 }, insights: {} },
      { id: 'sub-b', name: 'Old', isHistorical: true, usage: { tokens30d: 0, cost30d: 0 }, insights: {} },
    ],
    global: {
      cost30d: 3.5, tokens30d: 3000,
      distribution: [{ agent: 'claude', tokens: 1000, costUSD: 1.5, requests: 10, pctTokens: 33.3, pctCost: 42.9 }],
      heatmap: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ tokens: 1, costUSD: 0.1 }))),
      analytics: ANALYTICS,
    },
    unpricedModels: ['internal-model'],
    _userId: userId,
  };
}

test('mergeSnapshots: 单用户透传 + 打标', () => {
  const snap = mkSnapshot('alice');
  const merged = mergeSnapshots([{ userId: 'alice', machine: 'm1', lastReportAt: now, snapshot: snap }]);
  assert.equal(merged.hub.mode, 'hub');
  assert.equal(merged.hub.user, 'alice');
  assert.equal(merged.hub.users[0].userId, 'alice');
  for (const s of merged.subscriptions) assert.equal(s.user, 'alice');
  // 单用户透传: 数值不变化
  assert.equal(merged.global.cost30d, 3.5);
  assert.equal(merged.agents[0].usage.last5h.tokens, 1000);
});

test('mergeSnapshots: 多用户用量求和 / 订阅并列 / agent.users 明细', () => {
  const merged = mergeSnapshots([
    { userId: 'alice', machine: 'm1', lastReportAt: now, snapshot: mkSnapshot('alice') },
    { userId: 'bob', machine: 'm2', lastReportAt: now, snapshot: mkSnapshot('bob') },
  ]);
  assert.equal(merged.hub.user, '__all__');
  assert.equal(merged.hub.users.length, 2);
  assert.equal(merged.subscriptions.length, 4);
  assert.deepEqual([...new Set(merged.subscriptions.map(s => s.user))].sort(), ['alice', 'bob']);

  const claude = merged.agents.find(a => a.agent === 'claude');
  assert.equal(claude.usage.last5h.tokens, 2000);
  assert.equal(claude.usage.last5h.c, 3);
  assert.equal(claude.usage.last7d.tokens, 2000);
  assert.equal(claude.usage.last30dByDay.length, 30);
  assert.equal(claude.users.length, 2);
  assert.equal(claude.quota, null);            // 额度不跨用户合并
  assert.equal(claude.users[0].quota.week.usedPct, 30);
  assert.ok(claude.models.includes('claude-opus-5'));

  // 全局求和
  assert.equal(merged.global.cost30d, 7);
  assert.equal(merged.global.tokens30d, 6000);
  // analytics 求和: 命中率重算 100/(100+80)=55.6%
  const an = merged.global.analytics;
  assert.equal(an.summary.last30d.totalTokens, 200);
  assert.equal(an.summary.last30d.cacheHitRate, 55.6);
  assert.equal(an.trends.last30d.length, 1);
  assert.equal(an.trends.last30d[0].totalTokens, 200);
  assert.equal(an.models.last30d[0].tokens, 200);
  assert.equal(an.models.last30d[0].pctTokens, 100);
  // 热力图逐格求和
  assert.equal(an.heatmaps.last30d[0][0].tokens, 2);
  assert.equal(an.distributions.last30d[0].tokens, 200);
});


test('mergeSnapshots: 异常输入安全', () => {
  assert.equal(mergeSnapshots([]), null);
  assert.equal(mergeSnapshots(null), null);
  assert.equal(mergeSnapshots([{ userId: 'x', snapshot: null }]), null);
  const merged = mergeSnapshots([{ userId: 'x', snapshot: {} }]);
  assert.equal(merged.agents.length, 0);
  assert.deepEqual(merged.subscriptions, []);
});

test('mergeSnapshots: last30dByDay 30 天对齐且逐日求和', () => {
  const a = mkSnapshot('a');
  const b = mkSnapshot('b');
  const merged = mergeSnapshots([
    { userId: 'a', machine: 'm', lastReportAt: 1, snapshot: a },
    { userId: 'b', machine: 'm', lastReportAt: 1, snapshot: b },
  ]);
  const claude = merged.agents.find(x => x.agent === 'claude');
  assert.equal(claude.usage.last30dByDay.length, 30);
  const yesterday = claude.usage.last30dByDay.find(d => d.day === new Date(now - DAY).toISOString().slice(0, 10));
  assert.equal(yesterday.tokens, 2000);
  assert.equal(yesterday.costUSD, 3);
  // 其余天补 0
  const zeroDay = claude.usage.last30dByDay.find(d => d.day !== yesterday.day);
  assert.equal(zeroDay.tokens, 0);
});

test('mergeSnapshots: 不同 day 覆盖的客户端也保持 30 天等长', () => {
  const a = mkSnapshot('a');
  const b = mkSnapshot('b');
  // b 只有昨天数据, a 覆盖到今天
  b.agents[0].usage.last30dByDay = [{ day: new Date(now - 2 * DAY).toISOString().slice(0, 10), tokens: 5, costUSD: 0.5 }];
  const merged = mergeSnapshots([
    { userId: 'a', machine: 'm', lastReportAt: 1, snapshot: a },
    { userId: 'b', machine: 'm', lastReportAt: 1, snapshot: b },
  ]);
  for (const ag of merged.agents) {
    assert.equal(ag.usage.last30dByDay.length, 30);
  }
});

// 供回归验证内部函数
test('padLast30Days: 补齐 30 天', () => {
  const out = padLast30Days([{ day: new Date(now - DAY).toISOString().slice(0, 10), tokens: 1, costUSD: 1 }], now);
  assert.equal(out.length, 30);
});
