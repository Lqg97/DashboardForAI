// Hub 存储适配器: 文件存储(data/users/<userId>/report.json)
// 供 hub.js 与测试使用;MySQL 版见 hub-db.js, 异步接口一致:
//   { type, init(), ready(), saveReport(), loadReport(), listReports(), deleteReport(), close() }
// 同步兼容函数(saveReport/loadReport/listReports/deleteReport)保留供脚本与测试直接调用。

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from './config.js';

export const USERS_DIR = join(DATA_DIR, 'users');

const USER_ID_RE = /^[A-Za-z0-9_.@-]{1,64}$/;

// userId -> 安全目录名: 非白名单字符替换 '_', 拒绝路径穿越特征
export function safeUserId(userId) {
  const s = String(userId || '').trim();
  if (!s || s.startsWith('.') || s.includes('..')) return null;
  const cleaned = s.replace(/[^A-Za-z0-9_.@-]/g, '_');
  return cleaned.length <= 64 ? cleaned : null;
}

export function safeMachine(machine) {
  const s = String(machine || '').trim();
  if (!s) return 'default';
  const cleaned = s.replace(/[^A-Za-z0-9_.@-]/g, '_');
  return cleaned.slice(0, 64) || 'default';
}

function reportFile(userId, usersDir, machine) {
  const dir = safeUserId(userId);
  if (!dir) return null;
  if (machine) {
    return join(usersDir, dir, `machine_${safeMachine(machine)}.json`);
  }
  return join(usersDir, dir, 'report.json');
}

// ---------- 同步核心 ----------
function saveReportSync(report, usersDir) {
  const dir = safeUserId(report?.userId);
  if (!dir) throw new Error('invalid userId');
  mkdirSync(usersDir, { recursive: true });
  const userFolder = join(usersDir, dir);
  mkdirSync(userFolder, { recursive: true });

  const payload = JSON.stringify({ ...report, lastReportAt: report.lastReportAt || Date.now() });

  // 1. 按机器名独立存盘
  const machName = safeMachine(report.machine);
  const mFile = join(userFolder, `machine_${machName}.json`);
  const tmpM = join(userFolder, `.report.m.${machName}.${randomBytes(4).toString('hex')}`);
  writeFileSync(tmpM, payload, 'utf8');
  try { renameSync(tmpM, mFile); }
  catch (e) { try { rmSync(tmpM, { force: true }); } catch { /* ignore */ } throw e; }

  // 2. 兼容写入主 report.json(作为最新快照)
  const mainFile = join(userFolder, 'report.json');
  const tmpMain = join(userFolder, `.report.main.${randomBytes(4).toString('hex')}`);
  writeFileSync(tmpMain, payload, 'utf8');
  try { renameSync(tmpMain, mainFile); }
  catch { try { rmSync(tmpMain, { force: true }); } catch { /* ignore */ } }

  return mFile;
}

function loadReportSync(userId, usersDir, machine) {
  const dir = safeUserId(userId);
  if (!dir) return null;
  const userFolder = join(usersDir, dir);
  if (!existsSync(userFolder)) return null;

  if (machine && machine !== '__all__') {
    const mFile = join(userFolder, `machine_${safeMachine(machine)}.json`);
    if (existsSync(mFile)) {
      try { return JSON.parse(readFileSync(mFile, 'utf8')); } catch { return null; }
    }
  }

  const mainFile = join(userFolder, 'report.json');
  if (existsSync(mainFile)) {
    try { return JSON.parse(readFileSync(mainFile, 'utf8')); } catch { return null; }
  }
  return null;
}

function listReportsSync(usersDir, filterUserId) {
  if (!existsSync(usersDir)) return [];
  let userDirs = [];
  if (filterUserId) {
    const d = safeUserId(filterUserId);
    if (d && existsSync(join(usersDir, d))) userDirs = [d];
  } else {
    try {
      userDirs = readdirSync(usersDir, { withFileTypes: true })
        .filter(ent => ent.isDirectory() && !ent.name.startsWith('.'))
        .map(ent => ent.name);
    } catch { return []; }
  }

  const out = [];
  for (const dirName of userDirs) {
    const userFolder = join(usersDir, dirName);
    let files = [];
    try { files = readdirSync(userFolder); } catch { continue; }

    const machineFiles = files.filter(f => f.startsWith('machine_') && f.endsWith('.json'));
    if (machineFiles.length > 0) {
      for (const mf of machineFiles) {
        try {
          const r = JSON.parse(readFileSync(join(userFolder, mf), 'utf8'));
          if (r && r.snapshot) {
            out.push({
              userId: r.userId || dirName,
              machine: r.machine || null,
              lastReportAt: r.lastReportAt || 0,
              clientVersion: r.clientVersion || null,
              snapshot: r.snapshot,
            });
          }
        } catch { /* ignore bad json */ }
      }
    } else if (files.includes('report.json')) {
      try {
        const r = JSON.parse(readFileSync(join(userFolder, 'report.json'), 'utf8'));
        if (r && r.snapshot) {
          out.push({
            userId: r.userId || dirName,
            machine: r.machine || null,
            lastReportAt: r.lastReportAt || 0,
            clientVersion: r.clientVersion || null,
            snapshot: r.snapshot,
          });
        }
      } catch { /* ignore */ }
    }
  }

  out.sort((a, b) => b.lastReportAt - a.lastReportAt);
  return out;
}

function deleteReportSync(userId, usersDir, machine) {
  const dir = safeUserId(userId);
  if (!dir) return false;
  const userFolder = join(usersDir, dir);
  if (!existsSync(userFolder)) return false;

  if (machine) {
    const mFile = join(userFolder, `machine_${safeMachine(machine)}.json`);
    if (existsSync(mFile)) {
      rmSync(mFile, { force: true });
      return true;
    }
    return false;
  }

  rmSync(userFolder, { recursive: true, force: true });
  return true;
}

// ---------- 文件存储适配器(与 hub-db.js 接口一致) ----------
export function createFileStorage(usersDir = USERS_DIR) {
  return {
    type: 'file',
    async init() { mkdirSync(usersDir, { recursive: true }); },
    ready() { return true; },
    async saveReport(report) { return saveReportSync(report, usersDir); },
    async loadReport(userId, machine) { return loadReportSync(userId, usersDir, machine); },
    async listReports(userId) { return listReportsSync(usersDir, userId); },
    async deleteReport(userId, machine) { return deleteReportSync(userId, usersDir, machine); },
    async close() {},
  };
}

// ---------- 同步兼容导出(测试/脚本使用) ----------
export function saveReport(report, usersDir = USERS_DIR) { return saveReportSync(report, usersDir); }
export function loadReport(userId, usersDir = USERS_DIR) { return loadReportSync(userId, usersDir); }
export function listReports(usersDir = USERS_DIR) { return listReportsSync(usersDir); }
export function deleteReport(userId, usersDir = USERS_DIR) { return deleteReportSync(userId, usersDir); }
export function resetUsers(usersDir = USERS_DIR) {
  if (existsSync(usersDir)) rmSync(usersDir, { recursive: true, force: true });
  mkdirSync(usersDir, { recursive: true });
}
export function ensureUsersDir(usersDir = USERS_DIR) { mkdirSync(usersDir, { recursive: true }); }

// 校验上报体: 返回错误信息数组, 空数组=合法
export function validateReport(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['report body 必须是对象'];
  if (!body.userId || typeof body.userId !== 'string' || !USER_ID_RE.test(body.userId.trim()))
    errors.push('userId 必填且仅可含 [A-Za-z0-9_.@-] (长度<=64)');
  if (body.machine !== undefined && body.machine !== null && typeof body.machine !== 'string') errors.push('machine 必须是字符串');
  if (!body.snapshot || typeof body.snapshot !== 'object' || Array.isArray(body.snapshot)) { errors.push('snapshot 必填'); return errors; }
  if (!Array.isArray(body.snapshot.agents)) errors.push('snapshot.agents 必须是数组');
  if (!Array.isArray(body.snapshot.subscriptions)) errors.push('snapshot.subscriptions 必须是数组');
  return errors;
}
