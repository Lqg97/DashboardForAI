// Claude Code collector: 解析 ~/.claude/projects/**/*.jsonl
// 口径: 只统计 type=assistant 且 message.usage 存在的行(ccusage 同口径)
// isSidechain(子agent)行也计入 —— 它们同样消耗订阅额度

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR } from '../config.js';
import { costOf } from '../pricing-chain.js';

function* walkJsonl(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

function parseLine(line, project, out, opts) {
  let d;
  try { d = JSON.parse(line); } catch { return; }
  if (d.type !== 'assistant') return;
  const msg = d.message;
  if (!msg || !msg.usage) return;
  const u = msg.usage;
  const ev = {
    agent: 'claude',
    ts: Date.parse(d.timestamp) || 0,
    model: msg.model || 'unknown',
    project,
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    cacheWriteTokens: u.cache_creation_input_tokens || 0,
    costUSD: 0,
  };
  const { cost, unpriced } = costOf(ev.model, ev, opts.pricingOverrides);
  ev.costUSD = cost;
  if (unpriced) opts.unpricedModels.add(ev.model);
  out.push(ev);
}

// 模块级单文件缓存: filePath -> { mtime, items: [rawEvent] }
const claudeFileCache = new Map();

function parseOneClaudeFile(file, project) {
  const items = [];
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return items; }

  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;

    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'assistant') continue;
    const msg = d.message;
    if (!msg || !msg.usage) continue;
    const u = msg.usage;

    items.push({
      agent: 'claude',
      ts: Date.parse(d.timestamp) || 0,
      model: msg.model || 'unknown',
      project,
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      cacheWriteTokens: u.cache_creation_input_tokens || 0,
    });
  }
  return items;
}

// 返回 UsageEvent[](按 ts 升序)
export function collect(opts = {}) {
  const o = {
    dir: opts.dir || CLAUDE_DIR,
    pricingOverrides: opts.pricingOverrides || {},
    unpricedModels: opts.unpricedModels || new Set(),
  };
  const projectsRoot = join(o.dir, 'projects');
  const events = [];

  for (const file of walkJsonl(projectsRoot)) {
    let mtime = 0;
    try { mtime = statSync(file).mtimeMs; } catch { continue; }

    let cached = claudeFileCache.get(file);
    if (!cached || cached.mtime !== mtime) {
      const project = file.split('/projects/')[1]?.split('/')[0] || '';
      cached = { mtime, items: parseOneClaudeFile(file, project) };
      claudeFileCache.set(file, cached);
    }

    for (const raw of cached.items) {
      const ev = { ...raw, costUSD: 0 };
      const { cost, unpriced } = costOf(ev.model, ev, o.pricingOverrides);
      ev.costUSD = cost;
      if (unpriced) o.unpricedModels.add(ev.model);
      events.push(ev);
    }
  }

  events.sort((a, b) => a.ts - b.ts);
  return events;
}
