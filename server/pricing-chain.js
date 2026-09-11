// Cost entry: override(config) -> models.dev synced -> builtin PRICING+ALIASES.
// cc-switch also syncs pricing FROM models.dev, so we sync from models.dev too.

import { statSync } from 'node:fs';
import { lookupPricing as lookupBuiltin } from './pricing.js';
import {
  loadSyncedPricing,
  ensurePricingFresh,
  MODELS_DEV_API,
  CACHE_PATH,
  TTL_MS,
} from './pricing-sync.js';

export { MODELS_DEV_API, ensurePricingFresh, CACHE_PATH, TTL_MS } from './pricing-sync.js';

let syncedTable = null;
let syncedMtime = 0;

function getSyncedTable() {
  let mtime = 0;
  try { mtime = statSync(CACHE_PATH).mtimeMs; } catch { /* ignore */ }
  if (syncedTable === null || syncedMtime !== mtime) {
    syncedTable = loadSyncedPricing();
    syncedMtime = mtime;
  }
  return syncedTable;
}

export function invalidateSyncedCache() {
  syncedTable = null;
  syncedMtime = 0;
}

// Search models.dev synced table (exact then prefix, case-insensitive)
function lookupSynced(rawModel) {
  const table = getSyncedTable();
  if (!table || !rawModel) return null;
  const m = String(rawModel).trim().toLowerCase();
  if (!m) return null;
  if (table[m]) return { ...table[m], source: 'modelsdev' };
  for (const k of Object.keys(table)) {
    if (m.startsWith(k)) return { ...table[k], source: 'modelsdev' };
  }
  return null;
}

// Returns {cost, unpriced, matched, source}  source: override|modelsdev|builtin|none
export function costOf(rawModel, usage, overrides) {
  const o = overrides || {};
  if (o[rawModel]) return finishCost(o[rawModel], usage, 'override');
  const synced = lookupSynced(rawModel);
  if (synced) return finishCost(synced, usage, 'modelsdev');
  const builtin = lookupBuiltin(rawModel, o);
  if (builtin) return finishCost(builtin, usage, 'builtin');
  return { cost: 0, unpriced: true, matched: null, source: 'none' };
}

function finishCost(p, usage, source) {
  const u = usage || {};
  const cost =
    ((u.inputTokens || 0) * (p.input || 0) +
      (u.outputTokens || 0) * (p.output || 0) +
      (u.cacheReadTokens || 0) * (p.cacheRead || 0) +
      (u.cacheWriteTokens || 0) * (p.cacheWrite || 0)) / 1e6;
  return { cost, unpriced: false, matched: p, source };
}
