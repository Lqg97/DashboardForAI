// 滚动窗口用量估算(estimate 源)
// 5h 窗口语义: 近 5h 内有事件则窗口"活跃",窗口起点=窗口内最早事件 ts(首次使用时刻),
//   resetAt=startAt+5h(近似 Claude 订阅"从开始使用起 5 小时"的重置行为)。
// 周窗口: 近 7d 汇总,resetAt=startAt+7d 近似(真实按账单周期,此处 estimate 层只给近似值)。

const H5 = 5 * 3600 * 1000;
const D7 = 7 * 24 * 3600 * 1000;
const D30 = 30 * 24 * 3600 * 1000;

function windowStats(events, fromTs, spanMs, now) {
  const win = events.filter(e => e.ts >= fromTs && e.ts <= now);
  if (!win.length) {
    return { active: false, startAt: null, resetAt: null, events: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0 };
  }
  const startAt = win[0].ts;  // 窗口内最早事件
  const s = { active: true, startAt, resetAt: startAt + spanMs, events: win.length,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0 };
  for (const e of win) {
    s.inputTokens += e.inputTokens;
    s.outputTokens += e.outputTokens;
    s.cacheReadTokens += e.cacheReadTokens;
    s.cacheWriteTokens += e.cacheWriteTokens;
    s.costUSD += e.costUSD;
  }
  return s;
}

// events 需已按 ts 升序(collector 已保证)
export function rollingUsage(events, now = Date.now()) {
  const evs = Array.isArray(events) ? events : [];
  return {
    fiveHour: windowStats(evs, now - H5, H5, now),
    week: windowStats(evs, now - D7, D7, now),
    month: windowStats(evs, now - D30, D30, now),
  };
}

// 历史默认计划容量，仅保留导出兼容，不再自动用于百分比。
// 这些数值不是稳定的官方合约；只有 quotaOverrides/订阅显式配置才是上限。
export const DEFAULT_PLAN_LIMITS = {
  agy: {
    fiveHourLimitTokens: 150_000_000, // 150M
    weekLimitTokens: 300_000_000,     // 300M
    monthLimitTokens: 600_000_000,    // 600M
  },
  opencode: {
    fiveHourLimitTokens: 30_000_000,  // 30M
    weekLimitTokens: 200_000_000,     // 200M
    monthLimitTokens: 350_000_000,    // 350M
  },
  claude: {
    fiveHourLimitTokens: 25_000_000,  // 25M
    weekLimitTokens: 120_000_000,     // 120M
    monthLimitTokens: 350_000_000,    // 350M
  },
  glm: {
    fiveHourLimitTokens: 20_000_000,  // 20M
    weekLimitTokens: 100_000_000,     // 100M
  },
  codex: {
    weekLimitTokens: 200_000_000,     // 200M
  },
};

// 把 rolling 结果转成 estimate 用量对象；上限只来自显式 quotaOverrides。
export function toEstimateQuota(rolling, limits, agentKey) {
  void agentKey;
  const lim = { ...(limits || {}) };

  const conv = (w, limit) => {
    if (!w) return null;
    const total = w.active ? (w.inputTokens + w.outputTokens + w.cacheReadTokens + w.cacheWriteTokens) : 0;
    let usedPct = null;
    if (limit && limit > 0) {
      usedPct = Math.min(100, Math.round(total / limit * 100));
    } else if (!w.active) {
      return null;
    }
    return {
      usedPct,
      limit: limit || null,
      resetAt: w.active ? w.resetAt : null,
      tokens: total,
      costUSD: w.costUSD || 0,
      active: !!w.active,
    };
  };
  const fiveHour = conv(rolling && rolling.fiveHour, lim.fiveHourLimitTokens);
  const week = conv(rolling && rolling.week, lim.weekLimitTokens);
  const month = conv(rolling && rolling.month, lim.monthLimitTokens);
  if (!fiveHour && !week && !month) return null;
  return { fiveHour, week, month, source: 'estimate' };
}
