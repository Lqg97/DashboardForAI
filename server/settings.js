// 联机上报设置存储: data/settings.json
// 属于本机应用设置(不含订阅数据), 与 config.json 分开避免相互污染。
// 结构: { online: { enabled, hubUrl, token, user, machine, intervalMs } }
// 写入原子性: 临时文件 + rename;不存任何凭据校验, token 由用户自填。

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { userInfo, hostname } from 'node:os';
import { DATA_DIR, DEFAULT_HUB_URL, DEFAULT_HUB_TOKEN } from './config.js';

export const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

export function defaultSettings(env = process.env) {
  return {
    online: {
      enabled: false,
      hubUrl: env.HUB_URL || DEFAULT_HUB_URL,
      token: env.DASH_TOKEN || DEFAULT_HUB_TOKEN,
      user: (env.DASH_USER || userInfo().username || 'unknown').trim(),
      machine: (env.DASH_MACHINE || hostname()).trim(),
      intervalMs: Number(env.REPORT_INTERVAL_MS || 5 * 60 * 1000),
    },
  };
}

export function loadSettings(settingsPath = SETTINGS_PATH) {
  const def = defaultSettings();
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const d = JSON.parse(raw);
    const online = (d && typeof d.online === 'object' && d.online) || {};
    const envDefaults = defaultSettings();
    return {
      online: {
        enabled: online.enabled === true,
        // hubUrl 缺失/为空 -> 默认服务器; token 字段缺失 -> 默认令牌(显式保存空串则保留, 适配无鉴权自建 Hub)
        hubUrl: (typeof online.hubUrl === 'string' && online.hubUrl.trim()) || DEFAULT_HUB_URL,
        token: online.token === undefined || online.token === null
          ? DEFAULT_HUB_TOKEN
          : (typeof online.token === 'string' ? online.token : DEFAULT_HUB_TOKEN),
        user: (typeof online.user === 'string' && online.user.trim()) || envDefaults.online.user,
        machine: (typeof online.machine === 'string' && online.machine.trim()) || envDefaults.online.machine,
        intervalMs: Number(online.intervalMs) > 0 ? Number(online.intervalMs) : envDefaults.online.intervalMs,
      },
    };
  } catch {
    return defaultSettings();   // 不存在或损坏 -> 默认(关闭)
  }
}

// 全量校验: 返回错误数组, 空数组=合法
export function validateSettings(s) {
  const errors = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['settings 必须是对象'];
  const online = s.online || {};
  if (online.enabled !== undefined && typeof online.enabled !== 'boolean') errors.push('online.enabled 必须是布尔值');
  if (online.hubUrl) {
    try {
      const u = new URL(online.hubUrl);
      if (!['http:', 'https:'].includes(u.protocol)) errors.push('online.hubUrl 必须是 http(s) URL');
    } catch {
      errors.push('online.hubUrl 必须是 http(s) URL');
    }
  }
  for (const field of ['token', 'user', 'machine']) {
    if (online[field] !== undefined && online[field] !== null && typeof online[field] !== 'string')
      errors.push('online.' + field + ' 必须是字符串');
  }
  if (online.intervalMs !== undefined && online.intervalMs !== null &&
    (!Number.isFinite(Number(online.intervalMs)) || Number(online.intervalMs) < 15000))
    errors.push('online.intervalMs 必须 >= 15000ms');
  if (online.enabled && (!online.hubUrl || !String(online.hubUrl).trim())) errors.push('启用联机上报前必须填写 Hub 地址');
  return errors;
}

export function saveSettings(settings, settingsPath = SETTINGS_PATH) {
  const errors = validateSettings(settings);
  if (errors.length) {
    const err = new Error('settings 校验失败: ' + errors.join('; '));
    err.statusCode = 400;
    throw err;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = join(DATA_DIR, '.settings.tmp.' + randomBytes(4).toString('hex'));
  writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  try { renameSync(tmp, settingsPath); }
  catch (e) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw e; }
  return settings;
}

// 供测试注入临时目录
export function resetSettings(settingsPath = SETTINGS_PATH) {
  if (existsSync(settingsPath)) rmSync(settingsPath, { force: true });
}
