// hub-store 单元测试: 按用户持久化 / 校验 / 安全清洗
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveReport, loadReport, listReports, deleteReport, validateReport,
  safeUserId, resetUsers,
} from './hub-store.js';

function newDir() { return mkdtempSync(join(tmpdir(), 'hub-store-')); }

const REPORT = {
  userId: 'carol',
  machine: 'macbook-pro',
  lastReportAt: 1788800000000,
  snapshot: { generatedAt: 1788799940000, agents: [], subscriptions: [], billing: {}, global: {}, unpricedModels: [] },
};

test('safeUserId: 白名单清洗 + 拒绝危险输入', () => {
  assert.equal(safeUserId('carol'), 'carol');
  assert.equal(safeUserId('a.b@corp'), 'a.b@corp');
  assert.equal(safeUserId('a/b c'), 'a_b_c');
  assert.equal(safeUserId('evil/../x'), null);   // 含路径穿越特征直接拒绝
  assert.equal(safeUserId('.hidden'), null);
  assert.equal(safeUserId(''), null);
  assert.equal(safeUserId(null), null);
  assert.equal(safeUserId('..'), null);
});

test('saveReport/loadReport: 原子保存与读取', () => {
  const dir = newDir();
  try {
    saveReport(REPORT, dir);
    const loaded = loadReport('carol', dir);
    assert.equal(loaded.userId, 'carol');
    assert.equal(loaded.machine, 'macbook-pro');
    assert.equal(loaded.snapshot.generatedAt, 1788799940000);
    assert.equal(loadReport('nobody', dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('saveReport: 覆盖旧上报', () => {
  const dir = newDir();
  try {
    saveReport(REPORT, dir);
    saveReport({ ...REPORT, lastReportAt: 1788800099999 }, dir);
    assert.equal(loadReport('carol', dir).lastReportAt, 1788800099999);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listReports: 按最近上报时间倒序', () => {
  const dir = newDir();
  try {
    saveReport(REPORT, dir);
    saveReport({ ...REPORT, userId: 'bob', lastReportAt: 1788800050000 }, dir);
    saveReport({ ...REPORT, userId: 'alice', lastReportAt: 1788800010000 }, dir);
    const list = listReports(dir);
    assert.deepEqual(list.map(x => x.userId), ['bob', 'alice', 'carol']);
    assert.ok(list.every(x => x.snapshot));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deleteReport: 删除用户数据', () => {
  const dir = newDir();
  try {
    saveReport(REPORT, dir);
    assert.equal(deleteReport('carol', dir), true);
    assert.equal(loadReport('carol', dir), null);
    assert.equal(deleteReport('carol', dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validateReport: 字段校验', () => {
  assert.deepEqual(validateReport(null).length > 0, true);
  assert.deepEqual(validateReport({ userId: 'a', snapshot: { agents: [], subscriptions: [] } }), []);
  const errs = validateReport({ userId: '', snapshot: { agents: 'x', subscriptions: [] } });
  assert.ok(errs.some(e => e.includes('userId')));
  assert.ok(errs.some(e => e.includes('agents')));
});

test('resetUsers: 清空目录', () => {
  const dir = newDir();
  try {
    saveReport(REPORT, dir);
    resetUsers(dir);
    assert.deepEqual(listReports(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('multi-machine: 同一用户多台机器独立保存并列出', () => {
  const dir = newDir();
  try {
    saveReport({ ...REPORT, machine: 'machine-A', lastReportAt: 1788800010000 }, dir);
    saveReport({ ...REPORT, machine: 'machine-B', lastReportAt: 1788800020000 }, dir);
    const list = listReports(dir);
    assert.equal(list.length, 2);
    const machines = list.map(x => x.machine).sort();
    assert.deepEqual(machines, ['machine-A', 'machine-B']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

