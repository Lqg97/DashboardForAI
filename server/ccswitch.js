// cc-switch 集成: proxy_request_logs 用量 + providers 台账(仅数据,不做定价来源)
// 定价上游改用 models.dev(server/pricing-sync.js),此处只读本地一手代理日志与配置。
// db 结构(2026-08-31 实测):
//   proxy_request_logs: per-request tokens + 已算好 total_cost_usd, created_at 为 epoch 秒
//   providers: id, app_type, name, limit_daily_usd, limit_monthly_usd, is_current

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const CCSWITCH_DB = process.env.CCSWITCH_DB || join(homedir(), '.cc-switch', 'cc-switch.db');

export function openDb(dbPath = CCSWITCH_DB) {
  if (!existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

// 读 providers 台账 -> [{id, appType, name, isCurrent, limitDailyUsd, limitMonthlyUsd}]
export function loadProviders(dbPath = CCSWITCH_DB) {
  const db = openDb(dbPath);
  if (!db) return [];
  try {
    return db.prepare('SELECT id, app_type, name, category, is_current, limit_daily_usd, limit_monthly_usd, cost_multiplier FROM providers ORDER BY app_type, sort_index').all()
      .map(r => ({
        id: r.id,
        appType: r.app_type,
        name: r.name,
        category: r.category || null,
        isCurrent: !!r.is_current,
        limitDailyUsd: r.limit_daily_usd === null ? null : Number(r.limit_daily_usd),
        limitMonthlyUsd: r.limit_monthly_usd === null ? null : Number(r.limit_monthly_usd),
        costMultiplier: r.cost_multiplier === null ? null : Number(r.cost_multiplier),
      }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// 读 proxy 用量 -> UsageEvent[](ts 升序), agent 按 app_type 映射, cost 直接用已算好的
// 仅统计 status 2xx,避免失败请求双计口径偏差
export function collectUsageEvents(dbPath = CCSWITCH_DB, opts = {}) {
  const db = openDb(dbPath);
  if (!db) return [];
  const sinceSec = opts.sinceSec || 0;
  try {
    const rows = db.prepare(`
      SELECT created_at, app_type, provider_id, model, pricing_model,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             total_cost_usd, status_code
      FROM proxy_request_logs
      WHERE created_at >= ? AND status_code >= 200 AND status_code < 400
    `).all(sinceSec);
    const events = rows.map(r => ({
      agent: normalizeAgent(r.app_type),
      providerId: r.provider_id,
      ts: r.created_at * 1000,
      model: r.pricing_model || r.model || 'unknown',
      project: null,
      inputTokens: r.input_tokens || 0,
      outputTokens: r.output_tokens || 0,
      cacheReadTokens: r.cache_read_tokens || 0,
      cacheWriteTokens: r.cache_creation_tokens || 0,
      costUSD: Number(r.total_cost_usd) || 0,   // cc-switch 已按 pricing_model+multiplier 算好
    }));
    events.sort((a, b) => a.ts - b.ts);
    return events;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function normalizeAgent(appType) {
  // cc-switch app_type -> dashboard agent
  return appType === 'claude-desktop' ? 'claude' : appType;
}

// 按 provider 聚合代理日志 -> Map<providerId, {requests, costUSD, topModel, lastActiveMs}>
export function loadProviderUsage(dbPath = CCSWITCH_DB, sinceSec = 0) {
  const db = openDb(dbPath);
  if (!db) return new Map();
  try {
    const rows = db.prepare(`
      SELECT provider_id, model, count(*) AS requests,
             sum(total_cost_usd) AS cost, max(created_at) AS last_at,
             sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
      FROM proxy_request_logs
      WHERE created_at >= ? AND status_code >= 200 AND status_code < 400
      GROUP BY provider_id, model
    `).all(sinceSec);
    const byProvider = new Map();
    for (const r of rows) {
      const pid = r.provider_id || '(none)';
      if (!byProvider.has(pid)) {
        byProvider.set(pid, { requests: 0, costUSD: 0, tokens: 0, models: new Map(), lastActiveMs: 0 });
      }
      const b = byProvider.get(pid);
      b.requests += r.requests;
      b.costUSD += Number(r.cost) || 0;
      b.tokens += Number(r.tokens) || 0;
      b.models.set(r.model || 'unknown', (b.models.get(r.model) || 0) + r.requests);
      b.lastActiveMs = Math.max(b.lastActiveMs, r.last_at * 1000);
    }
    const out = new Map();
    for (const [pid, b] of byProvider) {
      const topModel = [...b.models.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
      out.set(pid, { requests: b.requests, costUSD: b.costUSD, tokens: b.tokens, topModel, lastActiveMs: b.lastActiveMs });
    }
    return out;
  } catch {
    return new Map();
  } finally {
    db.close();
  }
}
