// manual collector: 订阅条目上手填的用量事件(config.subscriptions[].manualUsage)
// 返回 Map<subId, UsageEvent[]>;cost 可手填 costUSD,否则按模型折算

import { loadConfig } from '../store.js';
import { costOf } from '../pricing-chain.js';

export function collect(opts = {}) {
  const cfg = opts.config || loadConfig(opts.configPath);
  const bySub = new Map();
  const unpriced = opts.unpricedModels || new Set();
  for (const sub of cfg.subscriptions || []) {
    if (!Array.isArray(sub.manualUsage) || !sub.manualUsage.length) continue;
    const evts = [];
    for (const mu of sub.manualUsage) {
      const ev = {
        agent: 'sub:' + sub.id,
        ts: typeof mu.ts === 'string' ? (Date.parse(mu.ts) || 0) : (mu.ts || 0),
        model: mu.model || null,
        project: null,
        inputTokens: mu.inputTokens || 0,
        outputTokens: mu.outputTokens || 0,
        cacheReadTokens: mu.cacheReadTokens || 0,
        cacheWriteTokens: mu.cacheWriteTokens || 0,
        costUSD: typeof mu.costUSD === 'number' ? mu.costUSD : null,
      };
      if (ev.costUSD === null) {
        const r = ev.model ? costOf(ev.model, ev, cfg.pricingOverrides) : { cost: 0, unpriced: false };
        ev.costUSD = r.cost;
        if (r.unpriced && ev.model) unpriced.add(ev.model);
      }
      evts.push(ev);
    }
    evts.sort((a, b) => a.ts - b.ts);
    bySub.set(sub.id, evts);
  }
  return bySub;
}
