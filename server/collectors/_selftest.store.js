// store + manual collector 自测(subscriptions 模型)
import { loadConfig, saveConfig, validateConfig, upsertSubscription, removeSubscription } from '../store.js';
import { collect as collectManual } from './manual.js';
import { rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP = '/tmp/ai-sub-store-test';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const CFG_PATH = join(TMP, 'config.json');

let fails = [];
function check(c, label, detail) {
  console.log('  [' + (c ? 'PASS' : 'FAIL') + '] ' + label + (detail ? ' :: ' + detail : ''));
  if (!c) fails.push(label);
}

console.log('=== loadConfig ===');
{
  const empty = loadConfig(CFG_PATH);
  check(Array.isArray(empty.subscriptions) && empty.subscriptions.length === 0, '不存在文件 -> 默认空配置');
}

console.log('=== saveConfig 原子写 + upsert/remove ===');
{
  let cfg = loadConfig(CFG_PATH);
  cfg = upsertSubscription(cfg, { id: 'sub-pi', name: 'Pi 包月', plan: 'pro', priceMonthly: 20, expireAt: '2026-12-01' });
  saveConfig(cfg, CFG_PATH);
  check(existsSync(CFG_PATH), '写入后文件存在');
  const reread = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
  check(reread.subscriptions.length === 1 && reread.subscriptions[0].id === 'sub-pi', 'round-trip 保留订阅');
  // 更新
  cfg = upsertSubscription(cfg, { id: 'sub-pi', priceMonthly: 25 });
  check(cfg.subscriptions[0].priceMonthly === 25 && cfg.subscriptions[0].name === 'Pi 包月', 'upsert 合并非覆盖');
  // 删除
  cfg = removeSubscription(cfg, 'sub-pi');
  check(cfg.subscriptions.length === 0, 'removeSubscription 删除');
}

console.log('=== 旧结构 agents[] 迁移 ===');
{
  const legacy = { agents: [{ id: 'claude', name: 'Claude', plan: 'pro', priceMonthly: 200 }] };
  const cfg = loadConfig(CFG_PATH);
  // 直接写旧结构文件再读
  const { writeFileSync } = await import('node:fs');
  writeFileSync(CFG_PATH, JSON.stringify(legacy));
  const loaded = loadConfig(CFG_PATH);
  check(loaded.subscriptions.length === 1 && loaded.subscriptions[0].id === 'claude',
    'agents[] 迁移为 subscriptions[]', JSON.stringify(loaded.subscriptions));
  check(loaded.agents === undefined, '输出不再含 agents 字段');
}

console.log('=== validateConfig ===');
{
  check(validateConfig({ subscriptions: [{ name: 'x', startDate: '2026-03-01', billingType: 'prepaid', balance: 50, status: 'historical' }] }).length === 0, '合法配置通过(包含预付费与余额与状态)');
  check(validateConfig({ subscriptions: [{ priceMonthly: 1 }] }).length > 0, '缺 name 报错');
  check(validateConfig({ subscriptions: [{ name: 'x', status: 'invalid-status' }] }).length > 0, '非法status报错');
  check(validateConfig({ subscriptions: [{ name: 'x', priceMonthly: -5 }] }).length > 0, '负月费报错');
  check(validateConfig({ subscriptions: [{ name: 'x', balance: -10 }] }).length > 0, '负余额报错');
  check(validateConfig({ subscriptions: [{ name: 'x', billingType: 'invalid-type' }] }).length > 0, '非法billingType报错');
  check(validateConfig({ subscriptions: [{ name: 'x', expireAt: 'not-a-date' }] }).length > 0, '非法到期时间报错');
  check(validateConfig({ subscriptions: [{ name: 'x', startDate: 'invalid-date' }] }).length > 0, '非法开始时间报错');
  check(validateConfig({ subscriptions: 'nope' }).length > 0, 'subscriptions 非数组报错');
  check(validateConfig({ subscriptions: [{ name: 'x', agentIds: 'nope' }] }).length > 0, 'agentIds 非数组报错');
}

console.log('=== saveConfig 校验失败 -> 400 且原文件保留 ===');
{
  const before = readFileSync(CFG_PATH, 'utf8');
  let threw = null;
  try { saveConfig({ subscriptions: [{ priceMonthly: 'x' }] }, CFG_PATH); } catch (e) { threw = e; }
  check(threw && threw.statusCode === 400, '非法配置抛 statusCode=400', threw && threw.message);
  check(readFileSync(CFG_PATH, 'utf8') === before, '失败后原文件未被破坏');
}

console.log('=== manual collector(subscriptions.manualUsage) ===');
{
  const cfg = {
    subscriptions: [
      { id: 'sub-pi', name: 'Pi', manualUsage: [
        { ts: '2026-08-30T10:00:00Z', model: 'glm-5.3', inputTokens: 1000000, outputTokens: 500000 },
        { ts: 1787500000000, inputTokens: 10, outputTokens: 5 },
      ]},
      { id: 'sub-agy', name: 'Agy' },  // 无 manualUsage
    ],
  };
  const bySub = collectManual({ config: cfg });
  const events = bySub.get('sub-pi') || [];
  check(events.length === 2, 'manualUsage 转事件', 'n=' + events.length);
  const byTs = events.map(e => e.ts);
  check(byTs.includes(Date.parse('2026-08-30T10:00:00Z')), 'ISO ts 解析', JSON.stringify(byTs));
  check(byTs.includes(1787500000000), 'epoch ts 透传');
  check(byTs[0] <= byTs[1], '事件按 ts 升序');
  check(events.every(e => e.agent === 'sub:sub-pi'), '事件标属订阅');
  // glm-5.3 按 models.dev 折算: 1M*1.4 + 0.5M*4.4 = $3.6
  check(Math.abs(events[1].costUSD - 3.6) < 0.01, '模型折算成本', '$' + events[1].costUSD.toFixed(2));
  check(!bySub.has('sub-agy'), '无 manualUsage 的订阅不产出');
}

console.log(fails.length ? '\nFAILED: ' + fails.join('; ') : '\nALL PASS');
rmSync(TMP, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
