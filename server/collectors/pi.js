// Pi collector: 解析 ~/.pi/agent/sessions/**/*.jsonl
// 口径(2026-08-31 实测): type=message 且 message.role=assistant 的行带
//   message.usage {input, output, cacheRead, cacheWrite, totalTokens, cost{total}}
//   usage 为每条消息独立用量(非累计);cost.total 实测为 0(订阅内模型),统一用 pricing-chain 折算。
//   项目路径从 session 目录名还原(目录名 = cwd 的 / 与 . 替换为 -;取原始路径近似即可)。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PI_DIR } from '../config.js';
import { costOf } from '../pricing-chain.js';

function* walkFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

// 从会话目录名还原 cwd(信息有损, 仅作项目分组标签)
function cwdFromDirName(dirName) {
  if (!dirName.startsWith('-')) return null;
  const s = dirName.slice(1);
  return '/' + s.replace(/-+/g, '/');
}

// 模型名归一: 去掉 provider 前缀(z-ai/)与 :variant 后缀(:free),保留主干
export function normalizePiModel(raw) {
  if (!raw) return 'pi-unknown';
  let m = String(raw).trim();
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  const colon = m.indexOf(':');
  if (colon > 0) m = m.slice(0, colon);
  return m || 'pi-unknown';
}

export function collect(opts = {}) {
  const o = {
    dir: opts.dir || PI_DIR,
    pricingOverrides: opts.pricingOverrides || {},
    unpricedModels: opts.unpricedModels || new Set(),
  };
  const sessionsRoot = join(o.dir, 'agent', 'sessions');
  const events = [];

  for (const file of walkFiles(sessionsRoot)) {
    // 目录名即 cwd 编码
    const parts = file.split('/');
    const dirName = parts[parts.length - 2];
    const project = cwdFromDirName(dirName);
    let lines;
    try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.type !== 'message') continue;
      const msg = d.message;
      if (!msg || msg.role !== 'assistant') continue;
      const u = msg.usage;
      if (!u || typeof u !== 'object') continue;
      const inputTokens = u.input || 0;
      const outputTokens = u.output || 0;
      const cacheReadTokens = u.cacheRead || 0;
      const cacheWriteTokens = u.cacheWrite || 0;
      if (inputTokens <= 0 && outputTokens <= 0 && cacheReadTokens <= 0 && cacheWriteTokens <= 0) continue;
      const model = normalizePiModel(msg.model);
      const ev = {
        agent: 'pi',
        ts: Date.parse(d.timestamp) || 0,
        model,
        project,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUSD: 0,
      };
      const { cost, unpriced } = costOf(model, ev, o.pricingOverrides);
      ev.costUSD = cost;
      if (unpriced) o.unpricedModels.add(model);
      events.push(ev);
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}
