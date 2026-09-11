// CodeBuddy 采集器: 多源原生日志与会话采集
// 1. ~/.codebuddy/projects/*/*.jsonl (原生 CLI/IDE 会话记录、精确模型与 token 用量)
// 2. ~/.codebuddy/traces/*/*.json (Trace 调用记录与推理用量)
// 3. ~/.local/share/opencode/opencode.db (provider 为 codebuddy/cb 的跨通道消息)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { OPENCODE_DB } from '../config.js';
import { costOf } from '../pricing-chain.js';

export function collect(opts = {}) {
  const pricingOverrides = opts.pricingOverrides || {};
  const unpricedModels = opts.unpricedModels || new Set();
  const events = [];
  const seenIds = new Set();
  const baseHome = opts.home || homedir();

  // 1. 扫描 ~/.codebuddy/projects/*/*.jsonl
  const pDir = join(baseHome, '.codebuddy/projects');
  function scanProjects(dir) {
    if (!existsSync(dir)) return;
    try {
      for (const f of readdirSync(dir)) {
        const full = join(dir, f);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            scanProjects(full);
          } else if (f.endsWith('.jsonl')) {
            const content = readFileSync(full, 'utf8');
            const lines = content.trim().split('\n');
            for (const line of lines) {
              if (!line) continue;
              try {
                const obj = JSON.parse(line);
                const u = obj.providerData?.rawUsage || obj.providerData?.usage || obj.usage;
                const isAssistant = obj.role === 'assistant' || obj.type === 'function_call' || obj.type === 'message' || !!u;
                if (!isAssistant && !u) continue;
                if (obj.role === 'user') continue;

                const id = obj.id || obj.providerData?.messageId || (obj.sessionId + '-' + obj.timestamp) || ('cb-line-' + Math.random());
                if (seenIds.has(id)) continue;
                seenIds.add(id);

                const ts = Number(obj.timestamp) || Date.now();
                const model = obj.providerData?.model || obj.model || 'glm-5.3-flash';
                let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
                if (u) {
                  inputTokens = u.prompt_tokens || u.inputTokens || 0;
                  outputTokens = (u.completion_tokens || u.outputTokens || 0) + (u.completion_thinking_tokens || 0);
                  cacheReadTokens = u.prompt_cache_hit_tokens || u.cached_tokens || (u.inputTokensDetails?.[0]?.cachedTokens || 0);
                }
                if (!inputTokens && !outputTokens) {
                  const text = Array.isArray(obj.content)
                    ? obj.content.map(c => c.text || '').join('')
                    : (typeof obj.content === 'string' ? obj.content : '');
                  if (!text && !obj.name && !obj.parameters) continue;
                  outputTokens = Math.max(50, Math.round((text.length || 50) * 1.5));
                  inputTokens = 1500;
                }

                const ev = {
                  agent: 'codebuddy',
                  ts,
                  model,
                  project: obj.cwd || 'CodeBuddy Project',
                  inputTokens,
                  outputTokens,
                  cacheReadTokens,
                  cacheWriteTokens,
                  costUSD: 0,
                };
                const { cost, unpriced } = costOf(ev.model, ev, pricingOverrides);
                ev.costUSD = cost;
                if (unpriced) unpricedModels.add(ev.model);
                events.push(ev);
              } catch {}
            }
          }
        } catch {}
      }
    } catch {}
  }
  scanProjects(pDir);

  // 2. 扫描 ~/.codebuddy/traces/*/*.json
  const tDir = join(baseHome, '.codebuddy/traces');
  function scanTraces(dir) {
    if (!existsSync(dir)) return;
    try {
      for (const f of readdirSync(dir)) {
        const full = join(dir, f);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            scanTraces(full);
          } else if (f.endsWith('.json')) {
            const c = JSON.parse(readFileSync(full, 'utf8'));
            for (const s of (c.spans || [])) {
              if (s.toolOutput) {
                try {
                  const out = JSON.parse(s.toolOutput);
                  const item = Array.isArray(out) ? out[0] : out;
                  if (item && item.usage) {
                    const id = item.id || s.spanId || (s.traceId + '-' + s.startedAt);
                    if (seenIds.has(id)) continue;
                    seenIds.add(id);

                    const ts = (item.created ? item.created * 1000 : null) ||
                      (s.startedAt ? Date.parse(s.startedAt) : null) || Date.now();
                    const model = item.model || 'glm-5.3-flash';
                    const u = item.usage;
                    const ev = {
                      agent: 'codebuddy',
                      ts,
                      model,
                      project: 'CodeBuddy trace',
                      inputTokens: u.prompt_tokens || 0,
                      outputTokens: (u.completion_tokens || 0) + (u.completion_tokens_details?.reasoning_tokens || 0),
                      cacheReadTokens: u.prompt_tokens_details?.cached_tokens || 0,
                      cacheWriteTokens: 0,
                      costUSD: 0,
                    };
                    const { cost, unpriced } = costOf(ev.model, ev, pricingOverrides);
                    ev.costUSD = cost;
                    if (unpriced) unpricedModels.add(ev.model);
                    events.push(ev);
                  }
                } catch {}
              }
            }
          }
        } catch {}
      }
    } catch {}
  }
  scanTraces(tDir);

  // 3. 扫描 opencode.db 中的 codebuddy / cb 消息
  const opencodeDb = opts.opencodeDbPath || OPENCODE_DB;
  if (existsSync(opencodeDb)) {
    try {
      const db = new DatabaseSync(opencodeDb, { readOnly: true });
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
            AND lower(json_extract(data, '$.providerID')) IN ('codebuddy', 'cb')
        `).all();

        for (const r of rows) {
          const id = 'opencode-cb-' + r.ts;
          if (seenIds.has(id)) continue;
          seenIds.add(id);

          const ev = {
            agent: 'codebuddy',
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
        try { db.close(); } catch {}
      }
    } catch {}
  }

  events.sort((a, b) => a.ts - b.ts);
  return events;
}
