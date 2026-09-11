import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStorage } from './hub-store.js';
import { mergeSnapshots } from './hub-merge.js';

function newDir() { return mkdtempSync(join(tmpdir(), 'hub-machine-test-')); }

test('multi-machine: store and merge across multiple machines for single user', async () => {
  const dir = newDir();
  const storage = createFileStorage(dir);
  await storage.init();

  try {
    const snap1 = {
      generatedAt: 1788800010000,
      agents: [{ agent: 'claude', name: 'Claude', usage: { last5h: { tokens: 100, c: 0.1 } } }],
      subscriptions: [{ id: 's1', name: 'Sub 1' }],
      global: { cost30d: 10, tokens30d: 1000 },
    };
    const snap2 = {
      generatedAt: 1788800020000,
      agents: [{ agent: 'codex', name: 'Codex', usage: { last5h: { tokens: 200, c: 0.2 } } }],
      subscriptions: [{ id: 's2', name: 'Sub 2' }],
      global: { cost30d: 20, tokens30d: 2000 },
    };

    await storage.saveReport({ userId: 'alice', machine: 'mac-pro', lastReportAt: 1788800010000, snapshot: snap1 });
    await storage.saveReport({ userId: 'alice', machine: 'laptop', lastReportAt: 1788800020000, snapshot: snap2 });

    // 1. listReports for specific user returns both machines
    const userReports = await storage.listReports('alice');
    assert.equal(userReports.length, 2);
    assert.deepEqual(userReports.map(r => r.machine).sort(), ['laptop', 'mac-pro']);

    // 2. loadReport for specific machine
    const loadedMac = await storage.loadReport('alice', 'mac-pro');
    assert.equal(loadedMac.machine, 'mac-pro');
    assert.equal(loadedMac.snapshot.agents[0].agent, 'claude');

    const loadedDev = await storage.loadReport('alice', 'laptop');
    assert.equal(loadedDev.machine, 'laptop');
    assert.equal(loadedDev.snapshot.agents[0].agent, 'codex');

    // 3. mergeSnapshots across both machines
    const merged = mergeSnapshots(userReports);
    assert.equal(merged.hub.user, 'alice');
    assert.equal(merged.hub.machines.length, 2);
    assert.deepEqual(merged.hub.machines.map(m => m.machine).sort(), ['laptop', 'mac-pro']);
    assert.equal(merged.global.cost30d, 30);
    assert.equal(merged.global.tokens30d, 3000);
    assert.equal(merged.agents.length, 2);

    // 4. delete single machine
    await storage.deleteReport('alice', 'mac-pro');
    const remaining = await storage.listReports('alice');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].machine, 'laptop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
