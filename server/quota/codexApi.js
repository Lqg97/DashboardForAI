// Codex 官方接口获取真实配额
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_DIR } from '../config.js';

let cachedQuota = null;
let lastFetchAt = 0;
const CACHE_TTL_MS = 60 * 1000; // 60s 缓存，避免高频打接口

export async function fetchCodexQuota(opts = {}) {
  const now = Date.now();
  if (cachedQuota && (now - lastFetchAt < CACHE_TTL_MS)) {
    return cachedQuota;
  }

  const authPath = join(opts.dir || CODEX_DIR, 'auth.json');
  let token = null;
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    token = auth.tokens?.access_token;
  } catch {
    return null;
  }

  if (!token) return null;

  try {
    const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'codex/1.0',
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    const primary = data.rate_limit?.primary_window;
    if (!primary) return null;

    const resetAt = primary.reset_at ? primary.reset_at * 1000 : (primary.reset_after_seconds ? now + primary.reset_after_seconds * 1000 : null);
    const windowMinutes = primary.limit_window_seconds ? Math.round(primary.limit_window_seconds / 60) : 10080;

    const quota = {
      week: {
        usedPct: typeof primary.used_percent === 'number' ? primary.used_percent : null,
        resetAt,
        windowMinutes,
        source: 'api',
      },
      fiveHour: null,
      month: null,
      source: 'api',
    };

    cachedQuota = quota;
    lastFetchAt = now;
    return quota;
  } catch {
    return cachedQuota || null;
  }
}
