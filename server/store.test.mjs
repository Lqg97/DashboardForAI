import assert from 'node:assert/strict';
import test from 'node:test';

import { validateConfig } from './store.js';

test('accepts supported coding-plan configuration fields', () => {
  const errors = validateConfig({
    subscriptions: [{
      id: 'sub-1',
      name: 'Zhipu Team',
      quotaProvider: 'zhipu_team',
      apiKey: 'secret',
      quotaBaseUrl: 'https://open.bigmodel.cn',
      teamOrganizationId: 'org',
      teamProjectId: 'project',
      agentIds: ['claude'],
      providerIds: ['provider-1'],
      modelFilter: ['glm'],
    }],
    pricingOverrides: {},
    quotaOverrides: {},
  });
  assert.deepEqual(errors, []);
});

test('rejects unsupported providers, unsafe URLs, and malformed string arrays', () => {
  const errors = validateConfig({
    subscriptions: [{
      name: 'Bad',
      quotaProvider: 'made-up',
      quotaBaseUrl: 'file:///tmp/secret',
      apiKey: 123,
      agentIds: ['codex', 4],
      providerIds: 'provider-1',
      modelFilter: [''],
    }],
  });

  assert.ok(errors.some(error => error.includes('quotaProvider')));
  assert.ok(errors.some(error => error.includes('quotaBaseUrl')));
  assert.ok(errors.some(error => error.includes('apiKey')));
  assert.ok(errors.some(error => error.includes('agentIds')));
  assert.ok(errors.some(error => error.includes('providerIds')));
  assert.ok(errors.some(error => error.includes('modelFilter')));
});
