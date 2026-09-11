// 联机客户端 CLI: 本机采集用量快照并上报 Hub
// 启动: npm run client
// 必填: HUB_URL 环境变量或 --hub= 参数(未提供时回退 data/settings.json 的联机设置)
// 可选: DASH_USER / DASH_MACHINE / DASH_TOKEN / REPORT_INTERVAL_MS / --once(单次上报后退出)
// 上报循环复用 server/reporter.js(桌面 App 的联机开关也走它)

import { refreshSnapshot } from './index.js';
import { createReporter } from './reporter.js';
import { loadSettings } from './settings.js';

const args = process.argv.slice(2);
const argGet = (name) => {
  const hit = args.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

function log(...m) { console.log('[client]', new Date().toLocaleTimeString('zh-CN'), ...m); }

export async function runClient() {
  const settings = loadSettings().online;
  const hubUrl = (argGet('hub') || process.env.HUB_URL || settings.hubUrl || '').replace(/\/+$/, '');
  if (!hubUrl) {
    console.error('[client] 缺少 HUB_URL。用法: HUB_URL=http://<hub地址>:<端口> npm run client');
    process.exitCode = 1;
    return;
  }
  const cfg = {
    hubUrl,
    token: argGet('token') || process.env.DASH_TOKEN || settings.token || '',
    user: (argGet('user') || process.env.DASH_USER || settings.user || 'unknown').trim(),
    machine: (argGet('machine') || process.env.DASH_MACHINE || settings.machine || '').trim(),
    intervalMs: Number(argGet('interval') || process.env.REPORT_INTERVAL_MS || settings.intervalMs),
    buildSnapshotFn: refreshSnapshot,
    log: { log, warn: log },
  };
  const reporter = createReporter({
    ...cfg,
    onReported: (st) => {
      const tokenPart = cfg.token ? '&token=' + encodeURIComponent(cfg.token) : '';
      log(`你的看板(仅本人数据): ${cfg.hubUrl}/?user=${encodeURIComponent(cfg.user)}${tokenPart}`);
      void st;
    },
  });
  const ONCE = args.includes('--once');

  log(`联机客户端启动 · Hub=${hubUrl} · 用户=${cfg.user} · 机器=${cfg.machine} · 周期=${Math.round(cfg.intervalMs / 1000)}s`);

  if (ONCE) {
    await reporter.reportNow('单次');
    log('--once 单次上报完成, 退出');
    return;
  }

  reporter.start();
}

// 直接运行本文件时启动
if (process.argv[1] && process.argv[1].endsWith('server/client.js')) {
  runClient();
}
