// 订阅归属单测: 重点锁住"每条事件最多归属一个订阅"这条不变量
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveBindings,
  normalizeBindings,
  resolveBindings,
  buildIndex,
  attributeEvents,
  detectConflicts,
} from "./attribution.js";

const ev = (agent, model = "m", project = "/p", ts = 1000) => ({
  agent,
  model,
  project,
  ts,
  costUSD: 1,
  inputTokens: 1,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const subs = (list) => ({ subscriptions: list, bindings: [] });

test("deriveBindings: 从 agentIds 推导, 带 modelFilter 的优先级更高", () => {
  const cfg = subs([
    { id: "s1", name: "通用", agentIds: ["codex"] },
    { id: "s2", name: "专用", agentIds: ["codex"], modelFilter: ["gpt-5.6"] },
  ]);
  const list = deriveBindings(cfg.subscriptions);
  assert.equal(list.length, 2);
  const generic = list.find((b) => b.subscriptionId === "s1");
  const specific = list.find((b) => b.subscriptionId === "s2");
  assert.ok(specific.priority > generic.priority, "带过滤条件的应更优先");
  assert.deepEqual(specific.matcher.models, ["gpt-5.6"]);
  assert.deepEqual(generic.matcher.models, []);
});

test("归属: 同一工具两个订阅, 专用订阅先挑走匹配的模型, 通用订阅只拿剩下的", () => {
  const cfg = subs([
    { id: "s-generic", name: "通用", agentIds: ["codex"] },
    {
      id: "s-specific",
      name: "专用",
      agentIds: ["codex"],
      modelFilter: ["gpt-5.6"],
    },
  ]);
  const index = buildIndex(resolveBindings(cfg));
  const events = [
    ev("codex", "gpt-5.6"),
    ev("codex", "gpt-5.6"),
    ev("codex", "other-model"),
  ];
  const res = attributeEvents(events, index);

  const specific = res.bySubscription.get("s-specific") || [];
  const generic = res.bySubscription.get("s-generic") || [];
  assert.equal(specific.length, 2, "专用订阅拿走两条 gpt-5.6");
  assert.equal(generic.length, 1, "通用订阅只拿剩下那条");
  // 关键不变量: 归属总数 == 事件总数, 没有重复计入
  assert.equal(res.stats.matched, 3);
  assert.equal(specific.length + generic.length, events.length);
});

test("归属: 两条完全相同的绑定 -> 报冲突, 且只有一个订阅拿到用量", () => {
  const cfg = subs([
    { id: "s-a", name: "Codex A", agentIds: ["codex"] },
    { id: "s-b", name: "Codex B", agentIds: ["codex"] },
  ]);
  const bindings = resolveBindings(cfg);
  const index = buildIndex(bindings);
  const res = attributeEvents([ev("codex"), ev("codex"), ev("codex")], index);

  assert.equal(res.stats.matched, 3);
  assert.equal(res.stats.unmatched, 0);
  assert.equal(res.stats.ambiguous, 3, "每条都有多个候选, 记为 ambiguous");
  const owners = [...res.bySubscription.keys()];
  assert.equal(owners.length, 1, "只能有一个订阅拿到");
  assert.equal(res.bySubscription.get(owners[0]).length, 3);

  const conflicts = detectConflicts(bindings);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "identical");
  assert.equal(conflicts[0].tool, "codex");
  assert.ok(
    conflicts[0].winnerSubscriptionId === "s-a" ||
      conflicts[0].winnerSubscriptionId === "s-b",
  );
});

test("归属: 同一工具先后两套套餐, 按有效期各认领自己那段时间", () => {
  const now = Date.parse("2026-09-15T00:00:00Z");
  const cfg = subs([
    {
      id: "old",
      name: "旧套餐",
      agentIds: ["codex"],
      startDate: "2026-07-01",
      expireAt: "2026-07-31",
    },
    { id: "new", name: "新套餐", agentIds: ["codex"], startDate: "2026-09-01" },
  ]);
  const bindings = resolveBindings(cfg, { now });
  const index = buildIndex(bindings);
  const res = attributeEvents(
    [
      ev("codex", "m", "/p", Date.parse("2026-07-10T00:00:00Z")),
      ev("codex", "m", "/p", Date.parse("2026-08-10T00:00:00Z")),
      ev("codex", "m", "/p", Date.parse("2026-09-10T00:00:00Z")),
    ],
    index,
  );

  assert.equal(
    (res.bySubscription.get("old") || []).length,
    1,
    "旧套餐只认领 7 月",
  );
  assert.equal(
    (res.bySubscription.get("new") || []).length,
    1,
    "新套餐只认领 9 月",
  );
  assert.equal(res.stats.unmatched, 1, "8 月无订阅覆盖 -> unmatched");
  assert.equal(
    detectConflicts(bindings).length,
    0,
    "有效期不重叠, 不是冲突(是先后两套套餐)",
  );
});

test("归属: 无绑定工具的事件记为 unmatched, 不计入任何订阅", () => {
  const cfg = subs([{ id: "s1", name: "仅 claude", agentIds: ["claude"] }]);
  const index = buildIndex(resolveBindings(cfg));
  const res = attributeEvents([ev("claude"), ev("codex")], index);
  assert.equal(res.stats.matched, 1);
  assert.equal(res.stats.unmatched, 1);
  assert.equal((res.bySubscription.get("s1") || []).length, 1);
});

test("归属: project 过滤生效, 且两个维度是 AND", () => {
  const bindings = normalizeBindings(
    [
      {
        id: "b1",
        subscriptionId: "s1",
        tool: "claude",
        matcher: { models: ["opus"], projects: ["/work"] },
      },
    ],
    [{ id: "s1" }],
  );
  const index = buildIndex(bindings);
  const events = [
    ev("claude", "claude-opus-5", "/work"),
    ev("claude", "claude-opus-5", "/home"), // project 不符
    ev("claude", "claude-haiku", "/work"), // model 不符
  ];
  const res = attributeEvents(events, index);
  assert.equal(
    (res.bySubscription.get("s1") || []).length,
    1,
    "只有两个维度都命中的那条算",
  );
  assert.equal(res.stats.unmatched, 2);
});

test("归属: 生效期内才归属(validFrom / validTo)", () => {
  const bindings = normalizeBindings(
    [
      {
        id: "b1",
        subscriptionId: "s1",
        tool: "claude",
        validFrom: 2000,
        validTo: 3000,
      },
    ],
    [{ id: "s1" }],
  );
  const index = buildIndex(bindings);
  const res = attributeEvents(
    [
      ev("claude", "m", "/p", 1000),
      ev("claude", "m", "/p", 2500),
      ev("claude", "m", "/p", 4000),
    ],
    index,
  );
  const got = res.bySubscription.get("s1") || [];
  assert.equal(got.length, 1);
  assert.equal(got[0].ts, 2500);
});

test("normalizeBindings: 丢弃外键无效的绑定, 不猜测归属", () => {
  const out = normalizeBindings(
    [
      { id: "ok", subscriptionId: "s1", tool: "claude" },
      { id: "bad", subscriptionId: "不存在的订阅", tool: "claude" },
      { id: "noTool", subscriptionId: "s1" },
    ],
    [{ id: "s1" }],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "ok");
});

test("resolveBindings: 有显式 bindings 时不再用 agentIds 推导", () => {
  const cfg = {
    subscriptions: [{ id: "s1", agentIds: ["claude"], modelFilter: ["opus"] }],
    bindings: [{ id: "b1", subscriptionId: "s1", tool: "claude" }],
  };
  const list = resolveBindings(cfg);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "b1");
  assert.equal(list[0].source, "explicit");
  assert.deepEqual(
    list[0].matcher.models,
    [],
    "显式绑定未配置 matcher 时不过滤",
  );
});

test("不变量: 任意事件集合, 归属总数 <= 事件总数(绝不重复计入)", () => {
  const cfg = subs([
    { id: "s1", name: "A", agentIds: ["claude", "codex"] },
    { id: "s2", name: "B", agentIds: ["claude"], modelFilter: ["opus"] },
    { id: "s3", name: "C", agentIds: ["codex"], modelFilter: ["gpt"] },
  ]);
  const index = buildIndex(resolveBindings(cfg));
  const events = [];
  for (const agent of ["claude", "codex", "pi"]) {
    for (const model of ["claude-opus-5", "gpt-5.6", "other"]) {
      events.push(ev(agent, model));
    }
  }
  const res = attributeEvents(events, index);
  let total = 0;
  for (const list of res.bySubscription.values()) total += list.length;
  assert.equal(total, res.stats.matched);
  assert.ok(total <= events.length, "归属总数不能超过事件总数");
  // 每条 claude/codex 事件都恰好归属一次
  assert.equal(
    res.stats.matched,
    6,
    "claude+codex 各 3 条; pi 无绑定 -> unmatched",
  );
  assert.equal(res.stats.unmatched, 3);
});
