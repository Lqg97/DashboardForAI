const DAY = 24 * 60 * 60 * 1_000;

export function buildCursorQuota(events, quotaLimits, now = Date.now()) {
  const recentEvents = (Array.isArray(events) ? events : []).filter(event => event.ts >= now - 30 * DAY);
  const thirdPartyEvents = recentEvents.filter(event => event.model !== 'cursor-small');
  const nativeEvents = recentEvents.filter(event => event.model === 'cursor-small');
  const observedPrompts = thirdPartyEvents.filter(event => event.isUserPrompt).length;
  const requests = observedPrompts || Math.ceil(thirdPartyEvents.length / 20);
  const tokens = thirdPartyEvents.reduce((sum, event) => sum + eventTokens(event), 0);
  const costUSD = round2(thirdPartyEvents.reduce((sum, event) => sum + finiteNumber(event.costUSD, 0), 0));
  const nativeTokens = nativeEvents.reduce((sum, event) => sum + eventTokens(event), 0);
  const configuredLimit = quotaLimits?.monthLimitReqs;
  const limit = typeof configuredLimit === 'number' && Number.isFinite(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : null;

  return {
    month: {
      usedPct: limit === null ? null : round2(requests / limit * 100),
      requests,
      totalSteps: thirdPartyEvents.length,
      limit,
      tokens,
      costUSD,
      thirdParty: {
        requests,
        totalSteps: thirdPartyEvents.length,
        tokens,
        costUSD,
        models: [...new Set(thirdPartyEvents.map(event => event.model).filter(Boolean))],
      },
      native: {
        requests: nativeEvents.length,
        tokens: nativeTokens,
        models: ['cursor-small'],
      },
    },
    source: limit === null ? 'estimate' : 'manual',
    mixed: limit !== null,
  };
}

function eventTokens(event) {
  return finiteNumber(event.inputTokens, 0)
    + finiteNumber(event.outputTokens, 0)
    + finiteNumber(event.cacheReadTokens, 0)
    + finiteNumber(event.cacheWriteTokens, 0);
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
