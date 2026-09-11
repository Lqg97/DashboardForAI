import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCodingPlanQuotaCache,
  detectCodingPlanProvider,
  fetchCodingPlanQuota,
  parseKimiQuota,
  parseMiniMaxQuota,
  parseOpenCodeGoQuota,
  parseVolcengineAfpQuota,
  parseVolcengineCodingQuota,
  parseZenMuxQuota,
  parseZhipuQuota,
  signVolcengineRequest,
} from './codingPlan.js';

const NOW = Date.parse('2026-09-03T05:00:00Z');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test('detects supported coding plans conservatively and honors explicit selection', () => {
  assert.equal(detectCodingPlanProvider({ quotaProvider: 'zhipu_team' }), 'zhipu_team');
  assert.equal(detectCodingPlanProvider({ name: 'Kimi For Coding' }), 'kimi');
  assert.equal(detectCodingPlanProvider({ name: 'MiniMax Coding Plan' }), 'minimax');
  assert.equal(detectCodingPlanProvider({ name: 'OpenCode Go' }), 'opencode_go');
  assert.equal(detectCodingPlanProvider({ name: '火山方舟 Agent Plan' }), 'volcengine');
  assert.equal(detectCodingPlanProvider({ name: '普通 OpenCode 按量账户' }), null);
  assert.equal(detectCodingPlanProvider({ quotaProvider: 'unknown' }), null);
});

test('maps Kimi 5-hour and weekly remaining values without inventing reset times', () => {
  const quota = parseKimiQuota({
    limits: [{ detail: { limit: 100, remaining: 75, resetTime: '2026-09-03T08:00:00Z' } }],
    usage: { limit: '500', remaining: '350' },
  });

  assert.equal(quota.fiveHour.usedPct, 25);
  assert.equal(quota.fiveHour.resetAt, Date.parse('2026-09-03T08:00:00Z'));
  assert.equal(quota.week.usedPct, 30);
  assert.equal(quota.week.resetAt, null);
});

test('maps Zhipu windows by unit and never fabricates a missing reset', () => {
  const quota = parseZhipuQuota({
    success: true,
    data: {
      level: 'pro',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 6, percentage: 61, nextResetTime: 1_788_000_000_000 },
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 23 },
        { type: 'TIME_LIMIT', unit: 3, percentage: 99 },
      ],
    },
  });

  assert.equal(quota.fiveHour.usedPct, 23);
  assert.equal(quota.fiveHour.resetAt, null);
  assert.equal(quota.week.usedPct, 61);
  assert.equal(quota.week.resetAt, 1_788_000_000_000);
  assert.equal(quota.planLabel, 'pro');
});

test('uses only MiniMax general model and omits an inactive weekly window', () => {
  const quota = parseMiniMaxQuota({
    base_resp: { status_code: 0 },
    model_remains: [
      { model_name: 'video', current_interval_remaining_percent: 5 },
      {
        model_name: 'general',
        current_interval_remaining_percent: 84,
        end_time: 1_788_000_000,
        current_weekly_status: 3,
        current_weekly_remaining_percent: 10,
      },
    ],
  });

  assert.equal(quota.fiveHour.usedPct, 16);
  assert.equal(quota.fiveHour.resetAt, 1_788_000_000_000);
  assert.equal(quota.week, null);
});

test('maps ZenMux ratios and USD values', () => {
  const quota = parseZenMuxQuota({
    success: true,
    data: {
      plan: { tier: 'pro' },
      account_status: 'active',
      quota_5_hour: {
        usage_percentage: '0.125',
        resets_at: '2026-09-03T06:00:00Z',
        used_value_usd: '1.5',
        max_value_usd: '12',
      },
      quota_7_day: { usage_percentage: 0.5 },
    },
  });

  assert.equal(quota.fiveHour.usedPct, 12.5);
  assert.equal(quota.fiveHour.usedValueUsd, 1.5);
  assert.equal(quota.fiveHour.maxValueUsd, 12);
  assert.equal(quota.week.usedPct, 50);
  assert.equal(quota.planLabel, 'pro (active)');
});

test('maps all OpenCode Go windows and removes the placeholder reset at zero usage', () => {
  const quota = parseOpenCodeGoQuota({
    usage: {
      rolling: { percent: 0, resetsAt: '2099-01-01T00:00:00Z' },
      weekly: { percent: 44, resetsAt: '2026-09-07T00:00:00Z' },
      monthly: { percent: '70', resetsAt: '2026-10-01T00:00:00Z' },
    },
  });

  assert.equal(quota.fiveHour.usedPct, 0);
  assert.equal(quota.fiveHour.resetAt, null);
  assert.equal(quota.week.usedPct, 44);
  assert.equal(quota.month.usedPct, 70);
});

test('maps Volcengine Agent Plan and Coding Plan response shapes', () => {
  const afp = parseVolcengineAfpQuota({
    PlanType: 'Large',
    AFPFiveHour: { Quota: 50, Used: 12.5, ResetTime: 1_778_806_800_000 },
    AFPDaily: { Quota: 100, Used: 90 },
    AFPWeekly: { Quota: 500, Used: 150 },
    AFPMonthly: { Quota: 2_000, Used: 850.5 },
  });
  assert.equal(afp.fiveHour.usedPct, 25);
  assert.equal(afp.week.usedPct, 30);
  assert.equal(afp.month.usedPct, 42.525);
  assert.equal(afp.planLabel, 'Agent Plan Large');

  const coding = parseVolcengineCodingQuota({
    QuotaUsage: [
      { Level: 'session', Percent: 0, ResetTimestamp: -1 },
      { Level: 'weekly', Percent: 1.5, ResetTimestamp: 1_782_057_600 },
      { Level: 'monthly', Percent: 2.5, ResetTimestamp: 1_784_303_999 },
      { Level: 'daily', Percent: 90 },
    ],
  });
  assert.equal(coding.fiveHour.resetAt, null);
  assert.equal(coding.week.resetAt, 1_782_057_600_000);
  assert.equal(coding.month.usedPct, 2.5);
});

test('generates the Volcengine HMAC-SHA256 request contract deterministically', () => {
  const signed = signVolcengineRequest({
    accessKeyId: 'AKLTtest',
    secretAccessKey: 'secretkey',
    region: 'cn-beijing',
    action: 'GetAFPUsage',
    now: Date.parse('2024-06-21T00:00:00Z'),
  });

  assert.equal(signed.url, 'https://open.volcengineapi.com/?Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01');
  assert.equal(signed.headers['X-Date'], '20240621T000000Z');
  assert.equal(signed.headers['X-Content-Sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.match(signed.headers.Authorization, /^HMAC-SHA256 Credential=AKLTtest\/20240621\/cn-beijing\/ark\/request,/);
  assert.match(signed.headers.Authorization, /SignedHeaders=host;x-date;x-content-sha256;content-type,/);
  assert.match(signed.headers.Authorization, /Signature=[0-9a-f]{64}$/);
});

test('uses provider-specific auth headers and team routing', async t => {
  await t.test('Zhipu sends the raw API key without Bearer', async () => {
    let captured;
    const quota = await fetchCodingPlanQuota({
      id: 'zhipu', quotaProvider: 'zhipu', apiKey: 'secret', baseUrl: 'https://api.z.ai/api/paas/v4',
    }, {
      now: NOW,
      cache: createCodingPlanQuotaCache(),
      request: async options => {
        captured = options;
        return response({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 7 }] } });
      },
    });

    assert.equal(captured.url, 'https://api.z.ai/api/monitor/usage/quota/limit');
    assert.equal(captured.headers.Authorization, 'secret');
    assert.equal(quota.fiveHour.usedPct, 7);
  });

  await t.test('Zhipu Team adds its organization and project headers', async () => {
    let captured;
    await fetchCodingPlanQuota({
      id: 'team', quotaProvider: 'zhipu_team', apiKey: 'secret',
      teamOrganizationId: 'org-1', teamProjectId: 'project-1',
    }, {
      now: NOW,
      cache: createCodingPlanQuotaCache(),
      request: async options => {
        captured = options;
        return response({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 7 }] } });
      },
    });

    assert.equal(captured.url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2');
    assert.equal(captured.headers['bigmodel-organization'], 'org-1');
    assert.equal(captured.headers['bigmodel-project'], 'project-1');
  });

  await t.test('Kimi uses Bearer authentication', async () => {
    let captured;
    await fetchCodingPlanQuota({ id: 'kimi', quotaProvider: 'kimi', apiKey: 'secret' }, {
      now: NOW,
      cache: createCodingPlanQuotaCache(),
      request: async options => {
        captured = options;
        return response({ usage: { limit: 100, remaining: 90 } });
      },
    });
    assert.equal(captured.url, 'https://api.kimi.com/coding/v1/usages');
    assert.equal(captured.headers.Authorization, 'Bearer secret');
  });
});

test('keeps last good data only for the same credential on transient failures', async () => {
  const cache = createCodingPlanQuotaCache();
  const sub = { id: 'kimi', quotaProvider: 'kimi', apiKey: 'key-a' };
  const first = await fetchCodingPlanQuota(sub, {
    now: NOW,
    cache,
    request: async () => response({ usage: { limit: 100, remaining: 60 } }),
  });
  assert.equal(first.week.usedPct, 40);

  const stale = await fetchCodingPlanQuota(sub, {
    now: NOW + 120_000,
    cache,
    request: async () => { throw new TypeError('network down'); },
  });
  assert.equal(stale.week.usedPct, 40);
  assert.equal(stale.stale, true);

  const otherAccount = await fetchCodingPlanQuota({ ...sub, apiKey: 'key-b' }, {
    now: NOW + 120_000,
    cache,
    request: async () => { throw new TypeError('network down'); },
  });
  assert.equal(otherAccount, null);
});

test('does not hide an authentication failure behind stale cached quota', async () => {
  const cache = createCodingPlanQuotaCache();
  const sub = { id: 'kimi', quotaProvider: 'kimi', apiKey: 'key-a' };
  await fetchCodingPlanQuota(sub, {
    now: NOW,
    cache,
    request: async () => response({ usage: { limit: 100, remaining: 60 } }),
  });

  const quota = await fetchCodingPlanQuota(sub, {
    now: NOW + 120_000,
    cache,
    request: async () => response({ error: 'unauthorized' }, 401),
  });
  assert.equal(quota, null);
});

test('discards stale quota after a deterministic response-shape failure', async () => {
  const cache = createCodingPlanQuotaCache();
  const sub = { id: 'kimi', quotaProvider: 'kimi', apiKey: 'key-a' };
  await fetchCodingPlanQuota(sub, {
    now: NOW,
    cache,
    request: async () => response({ usage: { limit: 100, remaining: 60 } }),
  });

  const malformed = await fetchCodingPlanQuota(sub, {
    now: NOW + 120_000,
    cache,
    request: async () => ({ ok: true, status: 200, async json() { throw new SyntaxError('bad JSON'); } }),
  });
  assert.equal(malformed, null);

  const laterNetworkFailure = await fetchCodingPlanQuota(sub, {
    now: NOW + 180_000,
    cache,
    request: async () => { throw new TypeError('network down'); },
  });
  assert.equal(laterNetworkFailure, null);
});

test('probes both Volcengine plans and stops on an auth envelope', async t => {
  await t.test('falls through an empty Agent Plan to Coding Plan', async () => {
    const calls = [];
    const quota = await fetchCodingPlanQuota({
      id: 'volc', quotaProvider: 'volcengine',
      accessKeyId: 'AKLTtest', secretAccessKey: 'secretkey',
      quotaBaseUrl: 'https://ark.cn-shanghai.volces.com/api/coding',
    }, {
      now: NOW,
      cache: createCodingPlanQuotaCache(),
      request: async options => {
        calls.push(options);
        if (options.url.includes('Action=GetAFPUsage')) {
          return response({ Result: { AFPFiveHour: { Quota: 0, Used: 0 } } });
        }
        return response({ Result: { QuotaUsage: [{ Level: 'weekly', Percent: 8 }] } });
      },
    });

    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.url.includes('Region=cn-shanghai')));
    assert.equal(quota.week.usedPct, 8);
    assert.equal(quota.planLabel, 'Coding Plan');
  });

  await t.test('recognizes a 400 signature error as a hard auth failure', async () => {
    let calls = 0;
    const quota = await fetchCodingPlanQuota({
      id: 'volc', quotaProvider: 'volcengine',
      accessKeyId: 'AKLTtest', secretAccessKey: 'wrong',
    }, {
      now: NOW,
      cache: createCodingPlanQuotaCache(),
      request: async () => {
        calls += 1;
        return response({ ResponseMetadata: { Error: { Code: 'SignatureDoesNotMatch', Message: 'bad signature' } } }, 400);
      },
    });

    assert.equal(quota, null);
    assert.equal(calls, 1);
  });
});

test('does not call the network when required credentials are missing', async () => {
  let calls = 0;
  const quota = await fetchCodingPlanQuota({ id: 'kimi', quotaProvider: 'kimi' }, {
    now: NOW,
    cache: createCodingPlanQuotaCache(),
    request: async () => { calls += 1; return response({}); },
  });

  assert.equal(quota, null);
  assert.equal(calls, 0);
});
