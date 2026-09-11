// 联机上报器: 可启停的周期上报循环
// 依赖注入 buildSnapshotFn(单机 refreshSnapshot), 避免 index.js <-> reporter 循环导入。
// 使用方:
//   - server/client.js (CLI: env/参数驱动)
//   - server/index.js (单机服务器/桌面 App: settings.json 驱动, 随开关启停)

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const TICK_MS = 15000;

export function createReporter({ hubUrl, token = '', user, machine = '', intervalMs, buildSnapshotFn, onReported, log = console }) {
  const hub = String(hubUrl || '').replace(/\/+$/, '');
  const interval = Number(intervalMs) > 0 ? Number(intervalMs) : DEFAULT_INTERVAL_MS;
  let timer = null;
  let tickTimer = null;
  let keepAlive = null;
  let running = false;
  let reporting = false;
  let lastReportAt = 0;
  let lastError = null;
  let reportCount = 0;

  function state() {
    return { running, hubUrl: hub, user, machine, intervalMs: interval, lastReportAt, lastError, reportCount };
  }

  async function postJson(path, body) {
    const res = await fetch(hub + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  async function reportNow(reason = '手动') {
    if (reporting) return false;
    if (!hub) throw new Error('缺少 Hub 地址');
    reporting = true;
    try {
      const snapshot = await buildSnapshotFn(true);
      await postJson('/api/report', {
        userId: user,
        machine: machine || undefined,
        token: token || undefined,
        clientVersion: process.version,
        snapshot,
      });
      lastReportAt = Date.now();
      lastError = null;
      reportCount += 1;
      log.log?.(`[reporter] 上报成功(${reason}) · 用户=${user} · 订阅${(snapshot.subscriptions || []).length}条`);
      try { onReported && onReported(state(), snapshot); } catch { /* 回调异常不影响上报 */ }
      return true;
    } catch (e) {
      lastError = e.message;
      log.warn?.(`[reporter] 上报失败(${reason}):`, e.message);
      return false;
    } finally {
      reporting = false;
    }
  }

  async function tick() {
    if (reporting) return;
    let kicked = false;
    try {
      const res = await fetch(`${hub}/api/kick?user=${encodeURIComponent(user)}&since=${lastReportAt}`);
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        kicked = !!j.refresh;
      }
    } catch { /* Hub 暂不可达, 忽略 */ }
    if (kicked) return void await reportNow('Hub 指令');
    if (Date.now() - lastReportAt >= interval) return void await reportNow('定时');
  }

  function start() {
    if (running) return state();
    if (!hub) throw new Error('缺少 Hub 地址');
    running = true;
    (async () => {
      await reportNow('启动');
    })();
    timer = setInterval(() => { tick().catch(e => log.warn?.('[reporter] tick 异常:', e.message)); }, TICK_MS);
    // 保活: 维持事件循环不为空(定时器自身 unref)
    keepAlive = setInterval(() => {}, 1 << 30);
    return state();
  }

  function stop() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    return state();
  }

  return { start, stop, reportNow, state, get running() { return running; } };
}
