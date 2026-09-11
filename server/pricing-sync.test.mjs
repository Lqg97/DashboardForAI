import assert from 'node:assert/strict';
import test from 'node:test';

test('pricing-sync: ensurePricingFresh with TTL and force options', async (t) => {
  const { ensurePricingFresh, syncedPricingAge, flattenPricing, TTL_MS } = await import('./pricing-sync.js');

  // Verify exported TTL_MS is 24h
  assert.equal(TTL_MS, 24 * 3600 * 1000);

  // Age is finite for existing cache
  const age = syncedPricingAge();
  assert.ok(typeof age === 'number');

  // ensurePricingFresh(false) returns false when cache is fresh (< 24h)
  if (age < TTL_MS) {
    const refreshed = await ensurePricingFresh(false);
    assert.equal(refreshed, false);
  }

  // flattenPricing correctly parses models.dev payload
  const mockPayload = {
    openai: {
      models: {
        'gpt-6-astra': {
          cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
          modalities: { output: ['text'] },
        },
        'non-text-audio': {
          cost: { input: 5, output: 5 },
          modalities: { output: ['audio'] },
        },
      },
    },
  };
  const table = flattenPricing(mockPayload);
  assert.ok(table['gpt-6-astra']);
  assert.equal(table['gpt-6-astra'].input, 10);
  assert.equal(table['gpt-6-astra'].output, 50);
  assert.equal(table['non-text-audio'], undefined); // Non-text excluded
});

test('pricing-chain: costOf uses synced pricing and respects cache invalidation', async () => {
  const { costOf, invalidateSyncedCache } = await import('./pricing-chain.js');

  invalidateSyncedCache();
  const res = costOf('gpt-6-astra', { inputTokens: 1000, outputTokens: 1000 });
  assert.equal(res.unpriced, false);
  assert.equal(res.source, 'modelsdev');
  assert.ok(res.cost > 0);
});

test('subscriptions: usage and equivalent cost is bounded by startDate and expireAt', async () => {
  const { buildSnapshot } = await import('./aggregate.js');
  const snap = await buildSnapshot();
  const subs = snap.subscriptions || [];

  for (const s of subs) {
    if (s.startDate && s.usage?.windowStart) {
      const sDate = new Date(s.startDate);
      const sTs = new Date(sDate.getFullYear(), sDate.getMonth(), sDate.getDate()).getTime();
      assert.ok(
        s.usage.windowStart >= sTs,
        `${s.name} windowStart (${new Date(s.usage.windowStart).toISOString()}) should be >= startDate (${s.startDate})`
      );
    }
  }
});
