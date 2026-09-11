// 渠道自建存储: data/providers.json
// cc-switch 仅作"同步源"(POST /api/providers/sync,或首次启动 seed 一次),
// dashboard 展示与订阅计费一律读本文件,运行时不直连 cc-switch。
// 结构: { syncedAt: epochMs, source: 'cc-switch', providers: [{id, appType, name, category,
//   isCurrent, limitDailyUsd, limitMonthlyUsd, costMultiplier,
//   usage: {requests30d, cost30d, tokens30d, topModel, lastActiveAt}}] }
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR, PROVIDERS_PATH } from './config.js';
import { loadProviders, loadProviderUsage, CCSWITCH_DB } from './ccswitch.js';

export function loadProvidersStore(path = PROVIDERS_PATH) {
  try {
    const d = JSON.parse(readFileSync(path, 'utf8'));
    if (!d || !Array.isArray(d.providers)) return null;
    return { syncedAt: d.syncedAt || null, source: d.source || 'cc-switch', providers: d.providers };
  } catch {
    return null;   // 不存在或损坏 -> null(从未同步)
  }
}

export function saveProvidersStore(store, path = PROVIDERS_PATH) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = join(dirname(path), '.providers.tmp.' + randomBytes(4).toString('hex'));
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  renameSync(tmp, path);
}

const DAY = 24 * 3600 * 1000;

// 从 cc-switch 拉取最新 providers + 30d 代理用量,写入自建存储。
// 返回 { count, syncedAt };cc-switch 不可用(无 db / 无 provider)返回 null。
export function syncProvidersFromCcSwitch(now = Date.now(), path = PROVIDERS_PATH) {
  const list = loadProviders();
  if (!list.length) return null;
  const usage = loadProviderUsage(CCSWITCH_DB, Math.floor((now - 30 * DAY) / 1000));
  const providers = list.map(p => {
    const u = usage.get(p.id);
    return {
      id: p.id, appType: p.appType, name: p.name, category: p.category,
      isCurrent: p.isCurrent, limitDailyUsd: p.limitDailyUsd, limitMonthlyUsd: p.limitMonthlyUsd,
      costMultiplier: p.costMultiplier,
      usage: {
        requests30d: u ? u.requests : 0,
        cost30d: u ? Math.round(u.costUSD * 100) / 100 : 0,
        tokens30d: u ? u.tokens : 0,
        topModel: u ? u.topModel : null,
        lastActiveAt: u ? u.lastActiveMs : null,
      },
    };
  });
  saveProvidersStore({ syncedAt: now, source: 'cc-switch', providers }, path);
  return { count: providers.length, syncedAt: now };
}
