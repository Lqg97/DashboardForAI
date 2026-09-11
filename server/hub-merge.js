// 联机合并层: 把多个客户端上报的快照合并成一个总快照
// 输出结构与单机 buildSnapshot() 完全一致, 前端视图无需改动即可渲染;
// 额外附加 hub 元数据与 per-user 归属字段(subscription.user / agent.users)
// 所有函数均为纯函数: 异常输入按空值处理, 不抛错。

const DAY = 24 * 3600 * 1000;
const H5 = 5 * 3600 * 1000;
const WEEK = 7 * DAY;
const ALL = '__all__';

function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
function round2(x) { return Math.round(x * 100) / 100; }
function safeList(v) { return Array.isArray(v) ? v : []; }

// ---------- 用量桶合并 ----------
function sumUsageBuckets(a, b) {
  const out = {};
  for (const k of ['i', 'o', 'cr', 'cw', 'c', 'tokens']) out[k] = num(a?.[k]) + num(b?.[k]);
  return out;
}

function mergeByDayLists(lists) {
  const byDay = new Map();
  for (const list of lists) {
    for (const d of safeList(list)) {
      if (!d || !d.day) continue;
      const g = byDay.get(d.day) || { day: d.day, tokens: 0, costUSD: 0 };
      g.tokens += num(d.tokens);
      g.costUSD += num(d.costUSD);
      byDay.set(d.day, g);
    }
  }
  // 对齐为最近 30 天(以最新 day 为终点), 缺失天补 0
  let maxDay = null;
  for (const day of byDay.keys()) if (!maxDay || day > maxDay) maxDay = day;
  if (!maxDay) return [];
  const maxK = Date.parse(maxDay + 'T00:00:00Z') / DAY;
  const out = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date((maxK - i) * DAY).toISOString().slice(0, 10);
    const b = byDay.get(day) || { day, tokens: 0, costUSD: 0 };
    out.push({ day, tokens: num(b.tokens), costUSD: num(b.costUSD) });
  }
  return out;
}

function mergeByDayMapTo(list, days = 30, now = Date.now()) {
  // 把任意天的 day Map 补齐/裁剪为最近 days 天(补 0), 输出升序数组
  const m = new Map();
  for (const d of safeList(list)) if (d && d.day) m.set(d.day, d);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = Math.floor((now - i * DAY) / DAY);
    const day = new Date(k * DAY).toISOString().slice(0, 10);
    const b = m.get(day) || { day, tokens: 0, costUSD: 0 };
    out.push({ day, tokens: num(b.tokens), costUSD: num(b.costUSD) });
  }
  return out;
}

function maxTs(a, b) {
  const va = num(a) || null;
  const vb = num(b) || null;
  if (va === null) return vb;
  if (vb === null) return va;
  return Math.max(va, vb);
}

// ---------- analytics 合并 ----------
function mergeSummary(summaries) {
  const out = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0, requests: 0, cacheHitRate: 0 };
  for (const s of safeList(summaries)) {
    if (!s || typeof s !== 'object') continue;
    for (const k of ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUSD', 'requests']) out[k] += num(s[k]);
  }
  const totalInput = out.cacheReadTokens + out.inputTokens;
  out.cacheHitRate = totalInput > 0 ? Math.round((out.cacheReadTokens / totalInput) * 1000) / 10 : 0;
  out.costUSD = Math.round(out.costUSD * 10000) / 10000;
  return out;
}

function mergeTrendSeries(lists) {
  const byTs = new Map();
  for (const list of lists) {
    for (const p of safeList(list)) {
      if (!p || !p.ts) continue;
      const g = byTs.get(p.ts) || { ts: p.ts, label: p.label || '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUSD: 0, requests: 0 };
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUSD', 'requests']) g[k] += num(p[k]);
      if (!g.label && p.label) g.label = p.label;
      byTs.set(p.ts, g);
    }
  }
  const arr = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  for (const p of arr) {
    p.totalTokens = p.inputTokens + p.outputTokens + p.cacheReadTokens + p.cacheWriteTokens;
    p.costUSD = Math.round(p.costUSD * 10000) / 10000;
  }
  return arr;
}

function mergeModelDist(lists) {
  const byModel = new Map();
  let totalTokens = 0;
  let totalCost = 0;
  for (const list of lists) {
    for (const m of safeList(list)) {
      if (!m || !m.model) continue;
      const g = byModel.get(m.model) || {
        model: m.model, tokens: 0, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0, requests: 0,
        agents: new Set(),
      };
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUSD', 'requests']) g[k] += num(m[k]);
      g.tokens += num(m.tokens);
      for (const a of safeList(m.agents)) g.agents.add(a);
      byModel.set(m.model, g);
      totalTokens += num(m.tokens);
      totalCost += num(m.costUSD);
    }
  }
  return [...byModel.values()].map(g => {
    const hitTotal = g.cacheReadTokens + g.inputTokens;
    return {
      ...g,
      agents: [...g.agents],
      costUSD: Math.round(g.costUSD * 10000) / 10000,
      cacheHitRate: hitTotal > 0 ? Math.round((g.cacheReadTokens / hitTotal) * 1000) / 10 : 0,
      pctTokens: totalTokens > 0 ? Math.round((g.tokens / totalTokens) * 1000) / 10 : 0,
      pctCost: totalCost > 0 ? Math.round((g.costUSD / totalCost) * 1000) / 10 : 0,
    };
  }).sort((a, b) => b.tokens - a.tokens);
}

function mergeHeatmaps(grids) {
  const gridsSafe = safeList(grids).filter(g => Array.isArray(g));
  const rows = 7, cols = 24;
  const out = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ tokens: 0, costUSD: 0 })));
  for (const g of gridsSafe) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = g[r] && g[r][c];
        if (!cell) continue;
        out[r][c].tokens += num(cell.tokens);
        out[r][c].costUSD += num(cell.costUSD);
      }
    }
  }
  return out;
}

function mergeDistributions(lists) {
  const byAgent = new Map();
  let totalTokens = 0;
  let totalCost = 0;
  for (const list of lists) {
    for (const d of safeList(list)) {
      if (!d || !d.agent) continue;
      const g = byAgent.get(d.agent) || { agent: d.agent, tokens: 0, costUSD: 0, requests: 0 };
      g.tokens += num(d.tokens);
      g.costUSD += num(d.costUSD);
      g.requests += num(d.requests);
      byAgent.set(d.agent, g);
      totalTokens += num(d.tokens);
      totalCost += num(d.costUSD);
    }
  }
  const arr = [...byAgent.values()].map(g => ({
    ...g,
    costUSD: round2(g.costUSD),
    pctTokens: totalTokens > 0 ? (g.tokens / totalTokens) * 100 : 0,
    pctCost: totalCost > 0 ? (g.costUSD / totalCost) * 100 : 0,
  }));
  arr.sort((a, b) => b.tokens - a.tokens);
  const sumPct = arr.reduce((a, x) => a + x.pctTokens, 0);
  if (arr.length && Math.abs(sumPct - 100) > 1e-9) arr[0].pctTokens += 100 - sumPct;
  return arr;
}

function mergeAnalytics(lists) {
  const listsSafe = safeList(lists).filter(a => a && typeof a === 'object');
  if (!listsSafe.length) return null;
  const first = listsSafe[0];
  const out = { summary: {}, trends: {}, models: {}, heatmaps: {}, distributions: {} };
  for (const range of ['today', 'last24h', 'last7d', 'last30d']) {
    out.summary[range] = mergeSummary(listsSafe.map(a => a.summary && a.summary[range]));
    out.trends[range] = mergeTrendSeries(listsSafe.map(a => a.trends && a.trends[range]));
    out.models[range] = mergeModelDist(listsSafe.map(a => a.models && a.models[range]));
    out.heatmaps[range] = mergeHeatmaps(listsSafe.map(a => a.heatmaps && a.heatmaps[range]));
    out.distributions[range] = mergeDistributions(listsSafe.map(a => a.distributions && a.distributions[range]));
  }
  void first;
  return out;
}

// ---------- agent 合并 ----------
function mergeAgents(agentGroups) {
  const out = [];
  for (const group of agentGroups) {
    const [first] = group;
    const usage = {
      last5h: sumUsageBuckets(null, null),
      last7d: sumUsageBuckets(null, null),
      last30dByDay: [],
      lastActiveAt: null,
    };
    let last5h = null, last7d = null, lastActiveAt = null;
    const analyticsList = [];
    const modelSet = new Set();
    const perUser = [];
    const dayLists = [];
    for (const rec of group) {
      const u = rec.agent.usage || {};
      last5h = sumUsageBuckets(last5h, u.last5h);
      last7d = sumUsageBuckets(last7d, u.last7d);
      dayLists.push(u.last30dByDay);
      lastActiveAt = maxTs(lastActiveAt, u.lastActiveAt);
      if (rec.agent.analytics) analyticsList.push(rec.agent.analytics);
      for (const m of safeList(rec.agent.models)) modelSet.add(m);
      perUser.push({
        user: rec.userId,
        machine: rec.machine,
        lastActiveAt: u.lastActiveAt ?? null,
        last5hTokens: (u.last5h && num(u.last5h.tokens)) || 0,
        last7dTokens: (u.last7d && num(u.last7d.tokens)) || 0,
        quota: rec.agent.quota ?? null,
        models: safeList(rec.agent.models),
      });
    }
    usage.last5h = last5h;
    usage.last7d = last7d;
    usage.last30dByDay = mergeByDayLists(dayLists);
    usage.lastActiveAt = lastActiveAt;
    out.push({
      agent: first.agent.agent,
      name: first.agent.name || first.agent.agent,
      discoverable: group.some(r => r.agent.discoverable),
      // 额度是每用户/每机器口径, 总览不合并百分比; 明细见 users[].quota
      quota: null,
      usage,
      models: [...modelSet],
      analytics: analyticsList.length ? mergeAnalytics(analyticsList) : null,
      users: perUser,
    });
  }
  return out;
}

// ---------- 订阅打标(不合并内容, 仅归属用户) ----------
function tagSubscriptions(subs, userId) {
  return safeList(subs).map(s => ({ ...s, user: userId }));
}

// ---------- 主入口 ----------
// reports: [{userId, machine, lastReportAt, snapshot}]
// opts: {storage?: string} — 附加到 hub 元数据
export function mergeSnapshots(reports, now = Date.now(), opts = {}) {
  const list = safeList(reports).filter(r => r && r.snapshot && typeof r.snapshot === 'object');
  if (!list.length) return null;

  const agentsByAgent = new Map();
  const analyticsList = [];
  const subsOut = [];const userMeta = [];
  const unpriced = new Set();
  let globalCost30d = 0;
  let globalTokens30d = 0;
  let generatedAt = 0;

  for (const rec of list) {
    const snap = rec.snapshot;
    generatedAt = maxTs(generatedAt, snap.generatedAt);    for (const a of safeList(snap.agents)) {
      if (!a || !a.agent) continue;
      if (!agentsByAgent.has(a.agent)) agentsByAgent.set(a.agent, []);
      agentsByAgent.get(a.agent).push({ userId: rec.userId, machine: rec.machine, agent: a });
    }
    if (snap.global) {
      globalCost30d += num(snap.global.cost30d);
      globalTokens30d += num(snap.global.tokens30d);
      if (snap.global.analytics) analyticsList.push(snap.global.analytics);
    }
    subsOut.push(...tagSubscriptions(snap.subscriptions, rec.userId));for (const m of safeList(snap.unpricedModels)) unpriced.add(m);
    const subCount = safeList(snap.subscriptions).length;
    const activeCount = safeList(snap.subscriptions).filter(s => s && !s.isHistorical).length;
    userMeta.push({
      userId: rec.userId,
      machine: rec.machine || null,
      lastReportAt: rec.lastReportAt || null,
      generatedAt: snap.generatedAt || null,
      online: num(rec.lastReportAt) > 0 && (now - num(rec.lastReportAt)) < 10 * 60 * 1000,
      subscriptions: subCount,
      activeSubscriptions: activeCount,
      cost30d: num(snap.global && snap.global.cost30d),
      tokens30d: num(snap.global && snap.global.tokens30d),
    });
  }

  const single = list.length === 1;
  const merged = {
    generatedAt,
    agents: mergeAgents([...agentsByAgent.values()].map(g => g)),
    subscriptions: subsOut.sort((a, b) => (a.isHistorical ? 1 : 0) - (b.isHistorical ? 1 : 0)),global: {
      cost30d: round2(globalCost30d),
      tokens30d: globalTokens30d,
      distribution: mergeDistributions([list.map(r => r.snapshot.global && r.snapshot.global.distribution).filter(Boolean)]),
      heatmap: mergeHeatmaps(list.map(r => r.snapshot.global && r.snapshot.global.heatmap)),
      analytics: analyticsList.length ? mergeAnalytics(analyticsList) : null,
    },
    unpricedModels: [...unpriced],
    hub: {
      mode: 'hub',
      user: opts.user || (list.every(r => r.userId === list[0].userId) ? list[0].userId : ALL),
      storage: opts.storage || null,
      users: userMeta.sort((a, b) => (b.cost30d || 0) - (a.cost30d || 0)),
      machines: userMeta.map(u => ({
        machine: u.machine || 'default',
        userId: u.userId,
        lastReportAt: u.lastReportAt,
        online: u.online,
        cost30d: u.cost30d,
        tokens30d: u.tokens30d,
      })),
    },
  };

  // 单用户视图: 快照内容原样保留(避免合并过程引入精度/结构变化), 仅打 hub 元数据
  if (single) {
    const snap = list[0].snapshot;
    const rec = list[0];
    return {
      generatedAt: null,
      agents: [],
      subscriptions: [],
      billing: { woa: null },
      global: { cost30d: 0, tokens30d: 0, distribution: null, heatmap: null, analytics: null },
      unpricedModels: [],
      ...snap,
      subscriptions: tagSubscriptions(snap.subscriptions, rec.userId),
      hub: {
        mode: 'hub',
        user: rec.userId,
        machine: rec.machine || null,
        lastReportAt: rec.lastReportAt || null,
        storage: opts.storage || null,
        users: merged.hub.users,
        machines: merged.hub.machines,
      },
    };
  }

  void now;
  void H5;
  void WEEK;
  return merged;
}

// 30 天 day 列表补齐(合并后不同客户端 day 覆盖可能参差)
export function padLast30Days(list, now = Date.now()) {
  return mergeByDayMapTo(list, 30, now);
}
