// api 源(占位): Anthropic 未提供公开的订阅额度查询端点。
// 探测 OAuth 凭据存在性;无可用端点则返回 null,让编排层降级到 estimate。
// 若未来出现官方端点,在此实现 fetch(带 3s 超时与全量 catch)即可。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function fetchClaudeQuota() {
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(credPath)) return null;
    const cred = JSON.parse(readFileSync(credPath, 'utf8'));
    const exp = cred?.claudeAiOauth?.expiresAtTimestamp || cred?.expiresAtTimestamp;
    if (!exp || exp < Date.now()) return null;   // 凭据过期同样视为不可用
    // 无官方额度端点 -> 降级
    return null;
  } catch {
    return null;   // 任何异常都不抛出,交给下一级
  }
}
