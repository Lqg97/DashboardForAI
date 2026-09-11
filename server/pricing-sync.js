// models.dev 定价同步(cc-switch 同款上游: https://models.dev/api.json)
// 策略参考 cc-switch src/lib/modelsDevPricing.ts:
//   - 只取文本计价模型(排除 audio/image/embedding/deprecated 等)
//   - 同一 model 在多 provider 报价时优先 family canonical provider(anthropic/openai/zai/moonshotai...)
//   - normalizedId 去重(取路径末段、去 :variant、@->-、小写、去 [1m])
// 本地缓存 data/models-dev-pricing.json(原子写),24h TTL 后台刷新,失败不阻塞服务。

import { writeFileSync, renameSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from './config.js';

export const MODELS_DEV_API = 'https://models.dev/api.json';
export const CACHE_PATH = join(DATA_DIR, 'models-dev-pricing.json');
export const TTL_MS = 24 * 3600 * 1000;

// family -> canonical provider(参考 cc-switch COMMON_FAMILY_RULES)
const FAMILY_CANONICAL = [
  [/^claude-/, 'anthropic'],
  [/^gpt-|^o[134]-/, 'openai'],
  [/^gemini-/, 'google'],
  [/^grok-/, 'xai'],
  [/^deepseek-/, 'deepseek'],
  [/^qwen/, 'alibaba'],
  [/^mimo-/, 'xiaomi'],
  [/^longcat-/, 'longcat'],
  [/^kimi-/, 'moonshotai'],
  [/^minimax-m/, 'minimax-cn'],
  [/^glm-/, 'zai'],
];

const NON_TEXT_MARKERS = ['audio', 'deprecated', 'embedding', 'image', 'moderation', 'realtime', 'transcribe', 'tts', 'video'];

function canonicalProviderFor(modelId) {
  const m = modelId.toLowerCase();
  for (const [re, prov] of FAMILY_CANONICAL) if (re.test(m)) return prov;
  return null;
}

function isTextPricingModel(modelId, model) {
  if ((model.status || '').toLowerCase() === 'deprecated') return false;
  const out = (model.modalities && model.modalities.output || []).map(s => String(s).toLowerCase());
  if (out.length && (!out.includes('text') || out.some(x => ['audio', 'image', 'video'].includes(x)))) return false;
  const hay = (modelId + ' ' + (model.name || '')).toLowerCase();
  return !NON_TEXT_MARKERS.some(k => hay.includes(k));
}

function normalizeId(modelId) {
  const afterSlash = modelId.slice(modelId.lastIndexOf('/') + 1);
  const beforeColon = afterSlash.split(':')[0] || '';
  let n = beforeColon.trim().replace(/@/g, '-').toLowerCase();
  if (n.endsWith('[1m]')) n = n.slice(0, -'[1m]'.length).trim();
  return n;
}

// api.json -> {modelId: {input, output, cacheRead, cacheWrite}}
export function flattenPricing(data) {
  const byId = new Map();   // normalizedId -> {providerId, releaseDate, pricing}
  for (const [providerId, provider] of Object.entries(data || {})) {
    if (!provider || typeof provider !== 'object') continue;
    for (const [modelId, model] of Object.entries(provider.models || {})) {
      if (!isTextPricingModel(modelId, model)) continue;
      const cost = model && model.cost;
      const input = typeof (cost && cost.input) === 'number' ? cost.input : null;
      const output = typeof (cost && cost.output) === 'number' ? cost.output : null;
      if (input === null && output === null) continue;
      const nid = normalizeId(modelId);
      if (!nid) continue;
      const cand = {
        providerId,
        releaseDate: typeof model.release_date === 'string' ? model.release_date : '',
        pricing: {
          input: input || 0,
          output: output || 0,
          cacheRead: typeof (cost && cost.cache_read) === 'number' ? cost.cache_read : 0,
          cacheWrite: typeof (cost && cost.cache_write) === 'number' ? cost.cache_write : 0,
        },
      };
      const prev = byId.get(nid);
      if (!prev) { byId.set(nid, cand); continue; }
      // 冲突消解: canonical provider 优先;同为/同非 canonical 时取 releaseDate 新者
      const canon = canonicalProviderFor(nid);
      const prevCanon = canon && prev.providerId === canon;
      const candCanon = canon && cand.providerId === canon;
      if (candCanon && !prevCanon) byId.set(nid, cand);
      else if (candCanon === prevCanon && cand.releaseDate > prev.releaseDate) byId.set(nid, cand);
    }
  }
  const table = {};
  for (const [nid, v] of byId) table[nid] = v.pricing;
  return table;
}

export function loadSyncedPricing() {
  try {
    const d = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (d && typeof d.models === 'object') return d.models;
  } catch { /* 无缓存 */ }
  return null;
}

export function syncedPricingAge() {
  try {
    const d = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (d && typeof d.syncedAt === 'number') return Date.now() - d.syncedAt;
  } catch { /* ignore */ }
  return Infinity;
}

// 拉取并落盘;成功返回模型数,失败抛错(调用方 catch 后降级用缓存/内置表)
export async function syncModelsDevPricing(fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const res = await fetchFn(MODELS_DEV_API, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('models.dev HTTP ' + res.status);
  const data = await res.json();
  const models = flattenPricing(data);
  mkdirSync(DATA_DIR, { recursive: true });
  const payload = JSON.stringify({ syncedAt: Date.now(), models });
  const tmp = join(dirname(CACHE_PATH), '.pricing.tmp.' + randomBytes(4).toString('hex'));
  writeFileSync(tmp, payload, 'utf8');
  renameSync(tmp, CACHE_PATH);
  return Object.keys(models).length;
}

let syncingPromise = null;

// 启动或运行时调用: 缓存缺失或超 TTL(或 force=true) 时联网拉取, 后台执行不阻塞, 并发调用合并
export function ensurePricingFresh(force = false) {
  if (!force && existsSync(CACHE_PATH) && syncedPricingAge() < TTL_MS) return Promise.resolve(false);
  if (syncingPromise) return syncingPromise;
  syncingPromise = syncModelsDevPricing()
    .then(n => {
      console.log('[pricing] models.dev synced:', n, 'models');
      return true;
    })
    .catch(e => {
      console.warn('[pricing] models.dev sync failed:', e.message);
      return false;
    })
    .finally(() => {
      syncingPromise = null;
    });
  return syncingPromise;
}
