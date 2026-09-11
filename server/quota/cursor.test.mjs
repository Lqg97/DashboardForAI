import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCursorQuota } from './cursor.js';

const NOW = Date.parse('2026-09-03T05:00:00Z');

function event(overrides = {}) {
  return {
    ts: NOW - 1_000,
    model: 'gpt-5.6-luna',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUSD: 0.5,
    isUserPrompt: true,
    ...overrides,
  };
}

test('does not invent a Cursor monthly request limit', () => {
  const quota = buildCursorQuota([event()], null, NOW);

  assert.equal(quota.month.requests, 1);
  assert.equal(quota.month.limit, null);
  assert.equal(quota.month.usedPct, null);
  assert.equal(quota.source, 'estimate');
});

test('uses an explicitly configured Cursor request limit', () => {
  const quota = buildCursorQuota([
    event(),
    event({ model: 'cursor-small', isUserPrompt: false }),
  ], { monthLimitReqs: 20 }, NOW);

  assert.equal(quota.month.requests, 1);
  assert.equal(quota.month.limit, 20);
  assert.equal(quota.month.usedPct, 5);
  assert.equal(quota.source, 'manual');
  assert.equal(quota.mixed, true);
  assert.equal(quota.month.native.tokens, 120);
});

test('treats invalid and zero limits as unknown', () => {
  for (const monthLimitReqs of [0, -1, '500', Number.NaN]) {
    const quota = buildCursorQuota([event()], { monthLimitReqs }, NOW);
    assert.equal(quota.month.limit, null);
    assert.equal(quota.month.usedPct, null);
  }
});
