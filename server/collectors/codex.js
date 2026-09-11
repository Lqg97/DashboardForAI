// Codex collector: 解析 ~/.codex/sessions 与 ~/.codex/archived_sessions 下的 rollout-*.jsonl
// 口径: 优先取 event_msg payload.info.last_token_usage (官方每轮精确增量,含 input, cached_input, output, reasoning)。
//       若仅有 total_token_usage 则使用差分去重(补齐第1轮保底),避免重复计数。
// rate_limits.primary{used_percent, window_minutes, resets_at(epoch秒)} 是官方窗口数据,取全局最新未过期一条。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_DIR } from '../config.js';
import { costOf } from '../pricing-chain.js';

function* walkFiles(dirs) {
  for (const dir of dirs) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) yield* walkFiles([p]);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) yield p;
    }
  }
}

// 模块级单文件缓存: filePath -> { mtime, items: [{ts, model, delta, rl}] }
const codexFileCache = new Map();

function parseOneCodexFile(file) {
  let prevTotal = null;
  let model = null;
  const items = [];
  let content;
  try { content = readFileSync(file, 'utf8'); } catch { return items; }

  let start = 0;
  while (start < content.length) {
    let end = content.indexOf('\n', start);
    if (end === -1) end = content.length;
    const line = content.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;

    // 字符串快速预筛选，避免 75% 无关行无效执行 JSON.parse
    if (!line.includes('token_count') && !line.includes('turn_context')) continue;

    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'turn_context' && d.payload?.model) model = d.payload.model;
    if (d.type !== 'event_msg' || !d.payload) continue;
    const p = d.payload;
    if (p.type !== 'token_count') continue;

    const ts = Date.parse(d.timestamp) || 0;
    const info = p.info;
    const ltu = info?.last_token_usage;
    const ttu = info?.total_token_usage;

    let delta = null;
    if (ltu && (ltu.total_tokens > 0 || ltu.input_tokens > 0 || ltu.output_tokens > 0 || ltu.cached_input_tokens > 0)) {
      const cached = ltu.cached_input_tokens || 0;
      delta = {
        inputTokens: Math.max(0, (ltu.input_tokens || 0) - cached),
        outputTokens: (ltu.output_tokens || 0) + (ltu.reasoning_output_tokens || 0),
        cacheReadTokens: cached,
        cacheWriteTokens: ltu.cache_write_input_tokens || 0,
      };
    } else if (ttu) {
      const cur = {
        inputTokens: (ttu.input_tokens || 0) - (ttu.cached_input_tokens || 0),
        outputTokens: (ttu.output_tokens || 0) + (ttu.reasoning_output_tokens || 0),
        cacheReadTokens: ttu.cached_input_tokens || 0,
        cacheWriteTokens: ttu.cache_write_input_tokens || 0,
      };
      if (prevTotal) {
        delta = {
          inputTokens: Math.max(0, cur.inputTokens - prevTotal.inputTokens),
          outputTokens: Math.max(0, cur.outputTokens - prevTotal.outputTokens),
          cacheReadTokens: Math.max(0, cur.cacheReadTokens - prevTotal.cacheReadTokens),
          cacheWriteTokens: Math.max(0, (cur.cacheWriteTokens || 0) - (prevTotal.cacheWriteTokens || 0)),
        };
      } else {
        delta = {
          inputTokens: Math.max(0, cur.inputTokens),
          outputTokens: Math.max(0, cur.outputTokens),
          cacheReadTokens: Math.max(0, cur.cacheReadTokens),
          cacheWriteTokens: Math.max(0, cur.cacheWriteTokens),
        };
      }
      prevTotal = cur;
    }

    const rl = (p.rate_limits && p.rate_limits.primary) || null;
    if (delta || rl) {
      items.push({ ts, model, delta, rl });
    }
  }
  return items;
}

function emitUsageEvent(ts, model, delta, out, opts) {
  if (delta.inputTokens <= 0 && delta.outputTokens <= 0 && (delta.cacheWriteTokens || 0) <= 0 && (delta.cacheReadTokens || 0) <= 0) return;
  const ev = {
    agent: 'codex',
    ts,
    model: model || 'codex-unknown',
    project: null,
    inputTokens: delta.inputTokens,
    outputTokens: delta.outputTokens,
    cacheReadTokens: delta.cacheReadTokens || 0,
    cacheWriteTokens: delta.cacheWriteTokens || 0,
    costUSD: 0,
  };
  const { cost, unpriced } = costOf(ev.model, ev, opts.pricingOverrides);
  ev.costUSD = cost;
  if (unpriced) opts.unpricedModels.add(ev.model);
  out.push(ev);
}

// 返回 {events: UsageEvent[], latestRateLimit: {...}|null}
export function collect(opts = {}) {
  const o = {
    dir: opts.dir || CODEX_DIR,
    pricingOverrides: opts.pricingOverrides || {},
    unpricedModels: opts.unpricedModels || new Set(),
  };
  const scanDirs = [
    join(o.dir, 'sessions'),
    join(o.dir, 'archived_sessions'),
  ].filter(d => existsSync(d));

  const events = [];
  const bestRateLimit = {};   // {fiveHour: {...}|undefined, week: {...}|undefined}
  const now = Date.now();

  for (const file of walkFiles(scanDirs)) {
    let mtime = 0;
    try { mtime = statSync(file).mtimeMs; } catch { continue; }

    let cached = codexFileCache.get(file);
    if (!cached || cached.mtime !== mtime) {
      cached = { mtime, items: parseOneCodexFile(file) };
      codexFileCache.set(file, cached);
    }

    for (const item of cached.items) {
      if (item.delta) {
        emitUsageEvent(item.ts, item.model, item.delta, events, o);
      }
      const rl = item.rl;
      if (rl && rl.resets_at && rl.window_minutes) {
        const resetAtMs = rl.resets_at * 1000;
        if (resetAtMs > now) {
          const kind = rl.window_minutes <= 600 ? 'fiveHour' : 'week';
          if (!bestRateLimit[kind] || item.ts >= (bestRateLimit[kind].ts || 0)) {
            bestRateLimit[kind] = {
              ts: item.ts,
              usedPct: rl.used_percent,
              windowMinutes: rl.window_minutes,
              resetsAt: resetAtMs,
            };
          }
        }
      }
    }
  }

  events.sort((a, b) => a.ts - b.ts);
  const latestRateLimit = (bestRateLimit.fiveHour || bestRateLimit.week)
    ? { ...bestRateLimit }
    : null;
  return { events, latestRateLimit };
}
