// Hub 存储适配器: MySQL(容器化部署)
// 与 hub-store.js 的 createFileStorage 接口一致:
//   { type, init(), ready(), saveReport(), loadReport(), listReports(), deleteReport(), close() }
// 表:
//   user_reports   — 每用户最新上报(PK user_id)
//   report_history — 上报历史(默认每用户保留 288 条, 由 HISTORY_KEEP 控制)
// 环境变量: MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
// 依赖: mysql2 (hub 专属依赖, 客户端/本地模式零依赖不受影响)

import mysql from 'mysql2/promise';

const HISTORY_KEEP_DEFAULT = 288;   // 5 分钟一报 ≈ 24h

export function dbConfigFromEnv(env = process.env) {
  return {
    host: env.MYSQL_HOST || '127.0.0.1',
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER || 'root',
    password: env.MYSQL_PASSWORD || '',
    database: env.MYSQL_DATABASE || 'ai_sub_dashboard',
    historyKeep: Number(env.HUB_HISTORY_KEEP || HISTORY_KEEP_DEFAULT),
  };
}

export function createDbStorage(cfg = dbConfigFromEnv(), log = console) {
  let pool = null;
  let dbReady = false;
  const historyKeep = cfg.historyKeep > 0 ? cfg.historyKeep : HISTORY_KEEP_DEFAULT;

  // MySQL 行(snake_case) -> 存储接口统一形状 {userId, machine, lastReportAt, snapshot}
  function rowToReport(row) {
    if (!row) return row;
    let snapshot = row.snapshot;
    if (typeof snapshot === 'string') {
      try { snapshot = JSON.parse(snapshot); }
      catch { snapshot = null; }
    }
    return {
      userId: row.user_id ?? row.userId,
      machine: row.machine ?? null,
      clientVersion: row.client_version ?? row.clientVersion ?? null,
      lastReportAt: Number(row.last_report_at ?? row.lastReportAt ?? 0),
      snapshot,
    };
  }

  async function init() {
    pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectionLimit: 10,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      timezone: 'Z',
      charset: 'utf8mb4',
    });
    await pool.query('SELECT 1');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_reports (
        user_id VARCHAR(64) NOT NULL,
        machine VARCHAR(128) NOT NULL DEFAULT '',
        client_version VARCHAR(64) NULL,
        last_report_at BIGINT NOT NULL,
        snapshot JSON NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, machine)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    try {
      await pool.query('ALTER TABLE user_reports MODIFY machine VARCHAR(128) NOT NULL DEFAULT ""');
      await pool.query('ALTER TABLE user_reports DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, machine)');
    } catch { /* 忽略重复主键修改 */ }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS report_history (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        machine VARCHAR(128) NULL,
        client_version VARCHAR(64) NULL,
        last_report_at BIGINT NOT NULL,
        snapshot JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_report_at (user_id, last_report_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    dbReady = true;
    log.log?.(`[hub-db] MySQL 就绪 ${cfg.host}:${cfg.port}/${cfg.database} (历史保留 ${historyKeep} 条/用户)`);
  }

  async function saveReport(report) {
    if (!pool || !dbReady) throw new Error('db not ready');
    const userId = String(report?.userId || '').slice(0, 64);
    if (!userId) throw new Error('invalid userId');
    const machine = String(report.machine || '').slice(0, 128);
    const clientVersion = report.clientVersion || null;
    const lastReportAt = report.lastReportAt || Date.now();
    const snapshot = JSON.stringify(report.snapshot);
    await pool.query(
      `INSERT INTO user_reports (user_id, machine, client_version, last_report_at, snapshot)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE client_version=VALUES(client_version),
                               last_report_at=VALUES(last_report_at), snapshot=VALUES(snapshot)`,
      [userId, machine, clientVersion, lastReportAt, snapshot],
    );
    // 追加历史并裁剪到 HISTORY_KEEP 条
    await pool.query(
      `INSERT INTO report_history (user_id, machine, client_version, last_report_at, snapshot)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, machine, clientVersion, lastReportAt, snapshot],
    );
    await pool.query(
      `DELETE FROM report_history
       WHERE user_id = ? AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM report_history WHERE user_id = ? ORDER BY last_report_at DESC, id DESC LIMIT ?
         ) t)`,
      [userId, userId, historyKeep],
    );
    return userId;
  }

  async function loadReport(userId, machine) {
    if (!pool || !dbReady) throw new Error('db not ready');
    const uid = String(userId || '').slice(0, 64);
    if (machine && machine !== '__all__') {
      const [rows] = await pool.query(
        'SELECT user_id, machine, client_version, last_report_at, snapshot FROM user_reports WHERE user_id = ? AND machine = ? LIMIT 1',
        [uid, String(machine).slice(0, 128)],
      );
      if (rows.length) return rowToReport(rows[0]);
    }
    const [rows] = await pool.query(
      'SELECT user_id, machine, client_version, last_report_at, snapshot FROM user_reports WHERE user_id = ? ORDER BY last_report_at DESC LIMIT 1',
      [uid],
    );
    if (!rows.length) return null;
    return rowToReport(rows[0]);
  }

  async function listReports(userId) {
    if (!pool || !dbReady) throw new Error('db not ready');
    // 不在 SQL 里 ORDER BY: 行含大 JSON 列, filesort 易触发 Out of sort memory; 改为 JS 排序
    let sql = 'SELECT user_id, machine, client_version, last_report_at, snapshot FROM user_reports';
    const params = [];
    if (userId) {
      sql += ' WHERE user_id = ?';
      params.push(String(userId || '').slice(0, 64));
    }
    const [rows] = await pool.query(sql, params);
    const out = rows.map(rowToReport);
    out.sort((a, b) => b.lastReportAt - a.lastReportAt);
    return out;
  }

  async function deleteReport(userId, machine) {
    if (!pool || !dbReady) throw new Error('db not ready');
    const uid = String(userId || '').slice(0, 64);
    if (machine) {
      const m = String(machine).slice(0, 128);
      await pool.query('DELETE FROM user_reports WHERE user_id = ? AND machine = ?', [uid, m]);
      await pool.query('DELETE FROM report_history WHERE user_id = ? AND machine = ?', [uid, m]);
    } else {
      await pool.query('DELETE FROM user_reports WHERE user_id = ?', [uid]);
      await pool.query('DELETE FROM report_history WHERE user_id = ?', [uid]);
    }
    return true;
  }

  async function history(userId, limit = 100) {
    if (!pool || !dbReady) throw new Error('db not ready');
    const [rows] = await pool.query(
      `SELECT user_id, last_report_at, snapshot, created_at FROM report_history
       WHERE user_id = ? ORDER BY last_report_at DESC, id DESC LIMIT ?`,
      [String(userId || '').slice(0, 64), Math.min(Number(limit) || 100, 1000)],
    );
    return rows.map(rowToReport);
  }

  async function close() { if (pool) { await pool.end(); pool = null; dbReady = false; } }

  return { type: 'mysql', init, ready: () => dbReady, saveReport, loadReport, listReports, deleteReport, history, close };
}
