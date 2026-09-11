// settings 单元测试: 联机上报设置存取与校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSettings, loadSettings, saveSettings, validateSettings, resetSettings, SETTINGS_PATH,
} from './settings.js';
import { DEFAULT_HUB_URL, DEFAULT_HUB_TOKEN } from './config.js';

function newDir() { return mkdtempSync(join(tmpdir(), 'settings-')); }

test('defaultSettings: 默认服务器开箱即用', () => {
  const d = defaultSettings({});
  assert.equal(d.online.enabled, false);
  assert.equal(d.online.hubUrl, DEFAULT_HUB_URL);
  assert.equal(d.online.token, DEFAULT_HUB_TOKEN);
  assert.ok(d.online.user.length > 0);
  assert.ok(d.online.machine.length > 0);
  assert.equal(d.online.intervalMs, 300000);
});

test('loadSettings: 无文件 -> 默认关闭 + 默认服务器', () => {
  const dir = newDir();
  try {
    const s = loadSettings(join(dir, 'settings.json'));
    assert.equal(s.online.enabled, false);
    assert.equal(s.online.hubUrl, DEFAULT_HUB_URL);
    assert.equal(s.online.token, DEFAULT_HUB_TOKEN);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('saveSettings/loadSettings: 原子保存读取', () => {
  const dir = newDir();
  try {
    const path = join(dir, 'settings.json');
    saveSettings({ online: { enabled: true, hubUrl: 'http://hub:4780/', token: 't1', user: 'u', machine: 'm' } }, path);
    const s = loadSettings(path);
    assert.equal(s.online.enabled, true);
    assert.equal(s.online.hubUrl, 'http://hub:4780/');
    assert.equal(s.online.token, 't1');
    assert.equal(s.online.user, 'u');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadSettings: 缺失字段回退默认/损坏文件安全/空 token 显式保留', () => {
  const dir = newDir();
  try {
    const path = join(dir, 'settings.json');
    // 缺失 hubUrl/token -> 默认服务器/令牌
    writeFileSync(path, JSON.stringify({ online: { enabled: true } }));
    const s = loadSettings(path);
    assert.equal(s.online.enabled, true);
    assert.equal(s.online.hubUrl, DEFAULT_HUB_URL);
    assert.equal(s.online.token, DEFAULT_HUB_TOKEN);
    // 显式保存空 token(无鉴权自建 Hub)不回退默认
    writeFileSync(path, JSON.stringify({ online: { enabled: true, hubUrl: 'http://my-hub:1234', token: '' } }));
    assert.equal(loadSettings(path).online.token, '');
    assert.equal(loadSettings(path).online.hubUrl, 'http://my-hub:1234');
    // 损坏文件 -> 全默认
    writeFileSync(path, '{broken');
    assert.equal(loadSettings(path).online.enabled, false);
    assert.equal(loadSettings(path).online.hubUrl, DEFAULT_HUB_URL);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validateSettings: 校验规则', () => {
  assert.deepEqual(validateSettings({ online: { enabled: false } }), []);
  assert.ok(validateSettings({ online: { enabled: true, hubUrl: '' } }).some(e => e.includes('Hub 地址')));
  assert.ok(validateSettings({ online: { hubUrl: 'ftp://x' } }).some(e => e.includes('hubUrl')));
  assert.ok(validateSettings({ online: { intervalMs: 100 } }).some(e => e.includes('intervalMs')));
  assert.ok(validateSettings({ online: { user: 5 } }).some(e => e.includes('user')));
  assert.ok(validateSettings(null).length > 0);
});

test('saveSettings: 非法配置抛 400', () => {
  const dir = newDir();
  try {
    const path = join(dir, 'settings.json');
    assert.throws(() => saveSettings({ online: { enabled: true, hubUrl: '' } }, path), e => e.statusCode === 400);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SETTINGS_PATH 常量可用且默认关闭(本地 data/settings.json 不存在时)', () => {
  assert.ok(SETTINGS_PATH.endsWith('settings.json'));
  // 不读取真实文件, 仅验证 loadSettings 不会抛错
  assert.doesNotThrow(() => loadSettings(join(tmpdir(), 'nonexistent-dir-xyz', 'settings.json')));
});
