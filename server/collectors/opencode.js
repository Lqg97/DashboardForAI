// OpenCode collector: node:sqlite 读 ~/.local/share/opencode/opencode.db
// 口径(2026-08-31 实测验证): assistant message 的 data.tokens 为每条消息独立用量(非累计):
//   {input, output, reasoning, cache{write,read}};reasoning 并入 output。
//   data.providerID/modelID 为顶层字段;provider=codebuddy/cb 拆为 codebuddy agent。
//   data.path.cwd 提供项目路径。

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { OPENCODE_DB } from '../config.js';
import { costOf } from '../pricing-chain.js';

// 返回 UsageEvent[](按 ts 升序)
export function collect(opts = {}) {
  const dbPath = opts.dbPath || OPENCODE_DB;
  if (!existsSync(dbPath)) return [];
  const pricingOverrides = opts.pricingOverrides || {};
  const unpricedModels = opts.unpricedModels || new Set();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const events = [];
  try {
    const rows = db.prepare(`
      SELECT
        time_created AS ts,
        json_extract(data, '$.providerID') AS provider,
        json_extract(data, '$.modelID') AS model,
        json_extract(data, '$.path.cwd') AS cwd,
        json_extract(data, '$.tokens.input') AS input_tokens,
        json_extract(data, '$.tokens.output') AS output_tokens,
        json_extract(data, '$.tokens.reasoning') AS reasoning,
        json_extract(data, '$.tokens.cache.write') AS cache_write,
        json_extract(data, '$.tokens.cache.read') AS cache_read
      FROM message
      WHERE json_extract(data, '$.role') = 'assistant'
        AND time_created IS NOT NULL
    `).all();
    for (const r of rows) {
      const provider = (r.provider || 'opencode').toLowerCase();
      if (provider === 'codebuddy' || provider === 'cb') continue;
      const ev = {
        agent: 'opencode',
        ts: Number(r.ts),
        model: r.model || 'unknown',
        project: r.cwd || null,
        inputTokens: r.input_tokens || 0,
        outputTokens: (r.output_tokens || 0) + (r.reasoning || 0),
        cacheReadTokens: r.cache_read || 0,
        cacheWriteTokens: r.cache_write || 0,
        costUSD: 0,
      };
      const { cost, unpriced } = costOf(ev.model, ev, pricingOverrides);
      ev.costUSD = cost;
      if (unpriced) unpricedModels.add(ev.model);
      events.push(ev);
    }
  } finally {
    db.close();
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}
