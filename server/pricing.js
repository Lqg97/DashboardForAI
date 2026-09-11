// 模型单价表(USD per 1M tokens)与成本折算
// 单价来源:官方定价页(2026-08 快照)。config.json pricingOverrides 可覆盖/新增。
// cost = input*in + output*out + cacheRead*cacheRead + cacheWrite*cacheWrite (各按 USD/1M tok)

export const PRICING = {
  // Anthropic (USD / 1M tokens)
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-7-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // OpenAI (USD / 1M tokens, 2026-08 官方定价页快照)
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 0 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 },
  'gpt-5.6-cyber': { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 0 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  'gpt-5.5-pro': { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
  'gpt-5.5-cyber': { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 0 },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5.1-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5.2-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  'gpt-5-pro': { input: 15, output: 120, cacheRead: 0, cacheWrite: 0 },
  'o3': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 },
  // Google Gemini (USD / 1M tokens)
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  'gemini-3.7-flash': { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0 },
  'gemini-3.7-pro': { input: 1.25, output: 5, cacheRead: 0.3125, cacheWrite: 0 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0 },
  'gemini-2.5-pro': { input: 1.25, output: 5, cacheRead: 0.3125, cacheWrite: 0 },
  // Cursor / Grok
  'cursor-small': { input: 0.2, output: 1.0, cacheRead: 0, cacheWrite: 0 },
  'composer-2.5-fast': { input: 0.25, output: 1.25, cacheRead: 0.05, cacheWrite: 0 },
  'composer-2.5': { input: 0.5, output: 2.5, cacheRead: 0.1, cacheWrite: 0 },
  'grok-4.5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 },
  'grok-4.6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 },
  // OpenCode & CodeBuddy 常见模型
  'ox-alpha-free': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'glm-5.2': { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0 },
  'codex-auto-review': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'glm-5.3': { input: 1.0, output: 4.0, cacheRead: 0.2, cacheWrite: 0 },
  'glm-5.3-flash': { input: 0.15, output: 0.6, cacheRead: 0.03, cacheWrite: 0 },
  'kimi-k3': { input: 0.6, output: 2.5, cacheRead: 0.1, cacheWrite: 0 },
  'deepseek-v4-flash': { input: 0.15, output: 0.6, cacheRead: 0.03, cacheWrite: 0 },
  'hy4-dev': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'hy4-preview': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'hy4-dev-high': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

// 别名归一:原始 model 字符串 -> PRICING key
const ALIASES = [
  [/^gemini.*3\.8.*flash/i, 'gemini-3.8-flash'],
  [/^gemini.*3\.7.*flash/i, 'gemini-3.7-flash'],
  [/^gemini.*3\.7.*pro/i, 'gemini-3.7-pro'],
  [/^gemini.*2\.5.*flash/i, 'gemini-2.5-flash'],
  [/^gemini.*2\.5.*pro/i, 'gemini-2.5-pro'],
  [/^claude.*opus-4-8/i, 'claude-opus-4-8'],
  [/^claude.*opus-5/i, 'claude-opus-5'],
  [/^claude.*sonnet-4-5/i, 'claude-sonnet-4-5'],
  [/^claude.*sonnet-5/i, 'claude-sonnet-5'],
  [/^claude.*haiku-4-5/i, 'claude-haiku-4-5'],
  [/^claude.*opus-4-1/i, 'claude-opus-4-1'],
  [/^claude.*3[-.]7[-.]sonnet/i, 'claude-3-7-sonnet'],
  [/^claude.*3[-.]5[-.]sonnet/i, 'claude-3-5-sonnet'],
  [/^claude.*3[-.]5[-.]haiku/i, 'claude-3-5-haiku'],
  [/^cursor-small/i, 'cursor-small'],
  [/^cursor-grok.*4[-.]6/i, 'grok-4.6'],
  [/^cursor-grok.*4[-.]5/i, 'grok-4.5'],
  [/^composer-2\.5-fast/i, 'composer-2.5-fast'],
  [/^composer-2\.5/i, 'composer-2.5'],
  [/^grok.*4[-.]5/i, 'grok-4.5'],
  [/^grok.*4[-.]6/i, 'grok-4.6'],
  [/^kimi.*k3/i, 'kimi-k3'],
  [/^glm.*5\.3.*flash/i, 'glm-5.3-flash'],
  [/^glm.*5\.3/i, 'glm-5.3'],
  [/^glm.*5\.2/i, 'glm-5.2'],
  [/^hy4.*high/i, 'hy4-dev-high'],
  [/^hy4.*preview/i, 'hy4-preview'],
  [/^hy4/i, 'hy4-dev'],
  [/^gpt-5\.6-sol/i, 'gpt-5.6-sol'],
  [/^gpt-5\.6-terra/i, 'gpt-5.6-terra'],
  [/^gpt-5\.6-luna/i, 'gpt-5.6-luna'],
  [/^gpt-5\.6-cyber/i, 'gpt-5.6-cyber'],
  [/^gpt-5\.5-pro/i, 'gpt-5.5-pro'],
  [/^gpt-5\.5-cyber/i, 'gpt-5.5-cyber'],
  [/^gpt-5\.5/i, 'gpt-5.5'],
  [/^gpt-5\.4/i, 'gpt-5.4'],
  [/^gpt-5\.3-codex/i, 'gpt-5.3-codex'],
  [/^gpt-5\.2-codex/i, 'gpt-5.2-codex'],
  [/^gpt-5\.1-codex/i, 'gpt-5.1-codex'],
  [/^gpt-5-codex/i, 'gpt-5-codex'],
  [/^gpt-5\.2/i, 'gpt-5.2'],
  [/^gpt-5\.1/i, 'gpt-5.1'],
  [/^gpt-5$/i, 'gpt-5'],
  [/^o3\b/i, 'o3'],
  [/^o4-mini/i, 'o4-mini'],
];

export function lookupPricing(rawModel, overrides) {
  if (!rawModel) return null;
  const o = overrides || {};
  if (o[rawModel]) return { ...o[rawModel], fromOverride: true };
  const m = String(rawModel).trim();
  if (PRICING[m]) return { ...PRICING[m] };
  for (const [re, key] of ALIASES) {
    if (re.test(m)) {
      const p = o[key] || PRICING[key];
      return p ? { ...p, fromOverride: !!o[key] } : null;
    }
  }
  return null;
}

// usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}
// 返回 {cost, unpriced, matched}
export function costOf(rawModel, usage, overrides) {
  const p = lookupPricing(rawModel, overrides);
  if (!p) return { cost: 0, unpriced: true, matched: null };
  const u = usage || {};
  const cost =
    ((u.inputTokens || 0) * (p.input || 0) +
      (u.outputTokens || 0) * (p.output || 0) +
      (u.cacheReadTokens || 0) * (p.cacheRead || 0) +
      (u.cacheWriteTokens || 0) * (p.cacheWrite || 0)) /
    1e6;
  return { cost, unpriced: false, matched: p };
}
