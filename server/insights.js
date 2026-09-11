// insights: ROI 回本率 / 沉睡检测 / 使用热力图 / agent 分布
// 全部纯函数,输入 UsageEvent[](ts 升序),异常输入返回 null 不抛错。

const DAY = 24 * 3600 * 1000;

// ROI = 本账单周期内 API 等效成本合计 / 月费
// billingCycleStart: ISO 或 epoch ms;缺省按自然月(本月1号)
// 返回 {ratio, costUSD, since} 或 null(月费缺失/<=0 或周期内无事件)
export function computeROI(events, priceMonthly, billingCycleStart, now = Date.now()) {
  try {
    const fee = Number(priceMonthly);
    if (!isFinite(fee) || fee <= 0) return null;
    let since;
    if (billingCycleStart) {
      const t = typeof billingCycleStart === 'string' ? Date.parse(billingCycleStart) : Number(billingCycleStart);
      if (!isFinite(t)) return null;
      // 周期起点按日对齐再外推到最近的过去周期点(周期=30天近似,与到期计算口径一致)
      since = t;
      while (since + 30 * DAY <= now) since += 30 * DAY;
    } else {
      const d = new Date(now);
      since = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
    let cost = 0;
    for (const e of (events || [])) {
      if (e.ts >= since && e.ts <= now) cost += e.costUSD || 0;
    }
    return { ratio: cost / fee, costUSD: cost, since };
  } catch {
    return null;
  }
}
// 沉睡检测: lastActiveAt 距今 > dormantDays(默认14)天
// 返回 {dormant, daysSinceActive, lastActiveAt} 或 null(无事件)
export function detectDormant(events, dormantDays = 14, now = Date.now()) {
  try {
    if (!events || !events.length) return null;
    // 不依赖输入有序,取 max ts 防御
    let last = -Infinity;
    for (const e of events) if (e.ts > last) last = e.ts;
    if (last === -Infinity) return null;
    const days = (now - last) / DAY;
    return { dormant: days > dormantDays, daysSinceActive: days, lastActiveAt: last };
  } catch {
    return null;
  }
}

// 热力图: 7x24 网格(行=周几 0=周日..6=周六, 列=0..23 时)
// 时区: 浏览器本地时区由前端处理,后端统一输出 UTC 网格,前端渲染时平移
// 每格 {tokens, costUSD}
export function buildHeatmap(events) {
  try {
    const grid = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => ({ tokens: 0, costUSD: 0 })));
    for (const e of (events || [])) {
      const d = new Date(e.ts);
      grid[d.getUTCDay()][d.getUTCHours()].tokens +=
        e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
      grid[d.getUTCDay()][d.getUTCHours()].costUSD += e.costUSD || 0;
    }
    return grid;
  } catch {
    return null;
  }
}

// agent 分布: 近 N 天(默认30)按 agent 聚合 token 与成本占比,合计=100%
// 返回 [{agent, tokens, costUSD, pctTokens, pctCost}] 或 null(无事件)
export function buildDistribution(events, days = 30, now = Date.now()) {
  const since = now - days * DAY;
  return buildDistributionRange(events, since, now);
}

export function buildDistributionRange(events, sinceMs = 0, untilMs = Infinity) {
  try {
    const byAgent = new Map();
    let totalTokens = 0;
    let totalCost = 0;
    for (const e of (events || [])) {
      if (e.ts < sinceMs || e.ts > untilMs) continue;
      const agentKey = e.agent || 'unknown';
      const g = byAgent.get(agentKey) || { agent: agentKey, tokens: 0, costUSD: 0, requests: 0 };
      const t = (e.inputTokens || 0) + (e.outputTokens || 0) + (e.cacheReadTokens || 0) + (e.cacheWriteTokens || 0);
      g.tokens += t;
      g.costUSD += e.costUSD || 0;
      g.requests += 1;
      totalTokens += t;
      totalCost += e.costUSD || 0;
      byAgent.set(agentKey, g);
    }
    if (!byAgent.size) return null;
    const arr = [...byAgent.values()].map(g => ({
      ...g,
      costUSD: Math.round(g.costUSD * 100) / 100,
      pctTokens: totalTokens > 0 ? (g.tokens / totalTokens) * 100 : 0,
      pctCost: totalCost > 0 ? (g.costUSD / totalCost) * 100 : 0,
    }));
    arr.sort((a, b) => b.tokens - a.tokens);
    // 合计=100% 校准(浮点尾差归到最大项)
    const sumPct = arr.reduce((a, x) => a + x.pctTokens, 0);
    if (arr.length && Math.abs(sumPct - 100) > 1e-9) arr[0].pctTokens += 100 - sumPct;
    return arr;
  } catch {
    return null;
  }
}

// 用量统计大盘汇总: 真实消耗 Tokens、新增输入、输出、创建、命中、缓存命中率、总请求与总成本
export function buildUsageSummary(events, sinceMs = 0, untilMs = Infinity) {
  try {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let costUSD = 0;
    let requests = 0;

    for (const e of (events || [])) {
      if (e.ts >= sinceMs && e.ts <= untilMs) {
        inputTokens += e.inputTokens || 0;
        outputTokens += e.outputTokens || 0;
        cacheReadTokens += e.cacheReadTokens || 0;
        cacheWriteTokens += e.cacheWriteTokens || 0;
        costUSD += e.costUSD || 0;
        requests += 1;
      }
    }

    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    const totalInput = cacheReadTokens + inputTokens;
    const cacheHitRate = totalInput > 0 ? (cacheReadTokens / totalInput) * 100 : 0;

    return {
      totalTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUSD: Math.round(costUSD * 10000) / 10000,
      requests,
      cacheHitRate: Math.round(cacheHitRate * 10) / 10,
    };
  } catch {
    return {
      totalTokens: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0,
      requests: 0, cacheHitRate: 0,
    };
  }
}

// 时序趋势图表点位生成: 支持 today(当天24h), last24h(滚动24h), last7d(7天), last30d(30天)
export function buildTrendSeries(events, range = 'today', now = Date.now()) {
  try {
    const buckets = [];
    const evts = events || [];
    const pad2 = (n) => String(n).padStart(2, '0');
    const fmtMDH = (d) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:00`;
    const fmtMD = (d) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;

    if (range === 'today') {
      const dNow = new Date(now);
      const startToday = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate()).getTime();
      // 当天 00:00 到 23:00 共 24 个 1 小时刻度
      for (let h = 0; h < 24; h++) {
        const bStart = startToday + h * 3600000;
        const bEnd = bStart + 3600000;
        const bDate = new Date(bStart);
        buckets.push({
          ts: bStart,
          label: fmtMDH(bDate),
          startMs: bStart,
          endMs: bEnd,
        });
      }
    } else if (range === 'last24h') {
      // 滚动近 24 小时
      const curHourTs = Math.floor(now / 3600000) * 3600000;
      for (let i = 23; i >= 0; i--) {
        const bStart = curHourTs - i * 3600000;
        const bEnd = bStart + 3600000;
        const bDate = new Date(bStart);
        buckets.push({
          ts: bStart,
          label: fmtMDH(bDate),
          startMs: bStart,
          endMs: bEnd,
        });
      }
    } else if (range === 'last7d') {
      // 近 7 天(每天一个刻度)
      const dNow = new Date(now);
      const curDayTs = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate()).getTime();
      for (let i = 6; i >= 0; i--) {
        const bStart = curDayTs - i * DAY;
        const bEnd = bStart + DAY;
        const bDate = new Date(bStart);
        buckets.push({
          ts: bStart,
          label: fmtMD(bDate),
          startMs: bStart,
          endMs: bEnd,
        });
      }
    } else {
      // 默认 last30d
      const dNow = new Date(now);
      const curDayTs = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate()).getTime();
      for (let i = 29; i >= 0; i--) {
        const bStart = curDayTs - i * DAY;
        const bEnd = bStart + DAY;
        const bDate = new Date(bStart);
        buckets.push({
          ts: bStart,
          label: fmtMD(bDate),
          startMs: bStart,
          endMs: bEnd,
        });
      }
    }

    const points = buckets.map(b => {
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let costUSD = 0;
      let requests = 0;

      for (const e of evts) {
        if (e.ts >= b.startMs && e.ts < b.endMs) {
          inputTokens += e.inputTokens || 0;
          outputTokens += e.outputTokens || 0;
          cacheReadTokens += e.cacheReadTokens || 0;
          cacheWriteTokens += e.cacheWriteTokens || 0;
          costUSD += e.costUSD || 0;
          requests += 1;
        }
      }

      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
      return {
        ts: b.ts,
        label: b.label,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        costUSD: Math.round(costUSD * 10000) / 10000,
        requests,
      };
    });

    return points;
  } catch {
    return [];
  }
}

// 模型用量分布与明细: 按 model 聚合 tokens, 细分与成本占比
export function buildModelDistribution(events, sinceMs = 0, untilMs = Infinity) {
  try {
    const byModel = new Map();
    let totalTokens = 0;
    let totalCost = 0;

    for (const e of (events || [])) {
      if (e.ts >= sinceMs && e.ts <= untilMs) {
        const m = e.model || 'unknown';
        if (!byModel.has(m)) {
          byModel.set(m, {
            model: m,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            tokens: 0,
            costUSD: 0,
            requests: 0,
            agents: new Set(),
          });
        }
        const g = byModel.get(m);
        const inT = e.inputTokens || 0;
        const outT = e.outputTokens || 0;
        const crT = e.cacheReadTokens || 0;
        const cwT = e.cacheWriteTokens || 0;
        const tokSum = inT + outT + crT + cwT;
        const c = e.costUSD || 0;

        g.inputTokens += inT;
        g.outputTokens += outT;
        g.cacheReadTokens += crT;
        g.cacheWriteTokens += cwT;
        g.tokens += tokSum;
        g.costUSD += c;
        g.requests += 1;
        if (e.agent) g.agents.add(e.agent);

        totalTokens += tokSum;
        totalCost += c;
      }
    }

    if (!byModel.size) return [];

    const list = [...byModel.values()].map(g => {
      const hitTotal = g.cacheReadTokens + g.inputTokens;
      const hitRate = hitTotal > 0 ? (g.cacheReadTokens / hitTotal) * 100 : 0;
      return {
        model: g.model,
        tokens: g.tokens,
        inputTokens: g.inputTokens,
        outputTokens: g.outputTokens,
        cacheReadTokens: g.cacheReadTokens,
        cacheWriteTokens: g.cacheWriteTokens,
        costUSD: Math.round(g.costUSD * 10000) / 10000,
        requests: g.requests,
        agents: [...g.agents],
        cacheHitRate: Math.round(hitRate * 10) / 10,
        pctTokens: totalTokens > 0 ? Math.round((g.tokens / totalTokens) * 1000) / 10 : 0,
        pctCost: totalCost > 0 ? Math.round((g.costUSD / totalCost) * 1000) / 10 : 0,
      };
    });

    list.sort((a, b) => b.tokens - a.tokens);
    return list;
  } catch {
    return [];
  }
}

// 统一打包用量分析数据(汇总 + 四维时序点位 + 模型用量分布)
export function buildUsageAnalytics(events, now = Date.now()) {
  const dNow = new Date(now);
  const startOfToday = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate()).getTime();
  const start24h = now - 24 * 3600 * 1000;
  const start7d = now - 7 * DAY;
  const start30d = now - 30 * DAY;

  return {
    summary: {
      today: buildUsageSummary(events, startOfToday, now),
      last24h: buildUsageSummary(events, start24h, now),
      last7d: buildUsageSummary(events, start7d, now),
      last30d: buildUsageSummary(events, start30d, now),
    },
    trends: {
      today: buildTrendSeries(events, 'today', now),
      last24h: buildTrendSeries(events, 'last24h', now),
      last7d: buildTrendSeries(events, 'last7d', now),
      last30d: buildTrendSeries(events, 'last30d', now),
    },
    models: {
      today: buildModelDistribution(events, startOfToday, now),
      last24h: buildModelDistribution(events, start24h, now),
      last7d: buildModelDistribution(events, start7d, now),
      last30d: buildModelDistribution(events, start30d, now),
    },
    heatmaps: {
      today: buildHeatmap((events || []).filter(e => e.ts >= startOfToday && e.ts <= now)),
      last24h: buildHeatmap((events || []).filter(e => e.ts >= start24h && e.ts <= now)),
      last7d: buildHeatmap((events || []).filter(e => e.ts >= start7d && e.ts <= now)),
      last30d: buildHeatmap((events || []).filter(e => e.ts >= start30d && e.ts <= now)),
    },
    distributions: {
      today: buildDistributionRange(events, startOfToday, now) || [],
      last24h: buildDistributionRange(events, start24h, now) || [],
      last7d: buildDistributionRange(events, start7d, now) || [],
      last30d: buildDistributionRange(events, start30d, now) || [],
    },
  };
}
