// official 源: Codex rollout 日志内嵌的 rate_limits(collector 已解析为 latestRateLimit)
// latestRateLimit: {fiveHour?: {usedPct,windowMinutes,resetsAt}, week?: {...}} | null

export function fromOfficialRateLimit(latestRateLimit) {
  if (!latestRateLimit) return null;
  const conv = (w) => w ? {
    usedPct: w.usedPct,
    resetAt: w.resetsAt,
    windowMinutes: w.windowMinutes,
    source: 'official',
  } : null;
  const fiveHour = conv(latestRateLimit.fiveHour);
  const week = conv(latestRateLimit.week);
  if (!fiveHour && !week) return null;
  return { fiveHour, week, source: 'official' };
}
