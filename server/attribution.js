// 订阅归属: 保证**每条事件最多归属一个订阅**。
//
// 背景: 以前订阅只靠 agentIds + modelFilter 认领用量, 两个订阅关联同一工具且过滤条件
// 不互斥时, 同一条日志会被两个订阅各算一遍(本机实测 codex / claude 各有两条重复订阅,
// 成本是按双倍统计的)。
//
// 现在把归属抽成独立的、可测试的纯逻辑:
//   1. bindings: 显式绑定(未来接 CC Switch Provider)或从旧 agentIds 推导
//   2. 每个事件按 tool -> 优先级 -> matcher 匹配, 命中多个时只取优先级最高的那个
//   3. 零命中记 unmatched, 多命中记 ambiguous(都只算一次)
//   4. 互相争抢且无法区分的绑定报 conflict, 让调用方提示用户补过滤条件
//
// 工具级全局统计仍使用全部事件, 只有"订阅成本"走归属结果, 两者口径在 API 中区分。

// ---------- 类型与规范化 ----------

const isNonEmptyStringArray = (v) =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim());

// 归一化 matcher: { models?, projects? }, 空或缺失表示该维度不限制
function normalizeMatcher(raw) {
  const models = isNonEmptyStringArray(raw?.models)
    ? raw.models.map((x) => x.trim().toLowerCase()).filter(Boolean)
    : [];
  const projects = isNonEmptyStringArray(raw?.projects)
    ? raw.projects.map((x) => x.trim().toLowerCase()).filter(Boolean)
    : [];
  return { models, projects };
}

// matcher 指纹: 用于判断两条绑定是否"认领范围完全相同"
function matcherKey(m) {
  return JSON.stringify({
    models: [...m.models].sort(),
    projects: [...m.projects].sort(),
  });
}

// 匹配: 两个维度都取"未配置即不限制"的语义, 维度内是 OR
function matcherMatches(matcher, event) {
  if (matcher.models.length) {
    const model = String(event.model || "").toLowerCase();
    if (!matcher.models.some((f) => model.includes(f))) return false;
  }
  if (matcher.projects.length) {
    const project = String(event.project || "").toLowerCase();
    if (!matcher.projects.some((f) => project.includes(f))) return false;
  }
  return true;
}

// ---------- 从旧配置推导 ----------

// 推导优先级: 带 modelFilter 的更具体, 优先命中; 裸 agentIds 作为兜底收尾。
// 数值越大越优先。
const PRIORITY_SPECIFIC = 100;
const PRIORITY_GENERIC = 50;

export function deriveBindings(subscriptions = [], opts = {}) {
  const now = opts.now || Date.now();
  const out = [];
  for (const sub of subscriptions) {
    if (!sub || typeof sub.id !== "string" || !sub.id) continue;
    const filters = isNonEmptyStringArray(sub.modelFilter)
      ? sub.modelFilter
      : null;
    const { validFrom, validTo } = subscriptionValidity(sub, now);
    for (const tool of sub.agentIds || []) {
      if (typeof tool !== "string" || !tool) continue;
      out.push({
        id: `derived:${sub.id}:${tool}`,
        subscriptionId: sub.id,
        tool,
        source: "derived_agent_ids",
        priority: filters ? PRIORITY_SPECIFIC : PRIORITY_GENERIC,
        matcher: normalizeMatcher({ models: filters || [] }),
        enabled: true,
        validFrom,
        validTo,
      });
    }
  }
  return out;
}

// 规范化用户显式配置的 bindings(不做猜测: 缺 subscriptionId/tool 直接丢弃)
export function normalizeBindings(rawList, subscriptions = []) {
  if (!Array.isArray(rawList) || !rawList.length) return null;
  const known = new Set(subscriptions.map((s) => s && s.id).filter(Boolean));
  const out = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.subscriptionId !== "string" || !raw.subscriptionId) continue;
    if (known.size && !known.has(raw.subscriptionId)) continue; // 外键无效
    if (typeof raw.tool !== "string" || !raw.tool) continue;
    out.push({
      id:
        typeof raw.id === "string" && raw.id
          ? raw.id
          : `binding:${raw.subscriptionId}:${raw.tool}`,
      subscriptionId: raw.subscriptionId,
      tool: raw.tool,
      source: typeof raw.source === "string" ? raw.source : "explicit",
      priority: Number.isFinite(Number(raw.priority))
        ? Number(raw.priority)
        : PRIORITY_GENERIC,
      matcher: normalizeMatcher(
        raw.matcher || { models: raw.models, projects: raw.projects },
      ),
      enabled: raw.enabled === false ? false : true,
      validFrom: raw.validFrom || null,
      validTo: raw.validTo || null,
    });
  }
  return out.length ? out : null;
}

// 取最终生效的绑定: 显式配置优先, 否则从 agentIds 推导
export function resolveBindings(config = {}, opts = {}) {
  const now = opts.now || Date.now();
  const explicit = normalizeBindings(
    config.bindings,
    config.subscriptions || [],
  );
  const list = explicit || deriveBindings(config.subscriptions || [], { now });
  return list.filter((b) => b.enabled !== false);
}

// ---------- 归属索引 ----------

// 按 tool 分组, 组内按 优先级降序 -> id 升序 排序, 保证同优先级下结果稳定可复现
export function buildIndex(bindings = []) {
  const index = new Map();
  for (const b of bindings) {
    if (!index.has(b.tool)) index.set(b.tool, []);
    index.get(b.tool).push(b);
  }
  for (const [tool, list] of index) {
    list.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
    index.set(tool, list);
  }
  return index;
}

// 时间字段既可能是 epoch ms 数字, 也可能是 ISO 字符串。
// 注意不能直接用 Date.parse(value): 传数字时它会先转成字符串, epoch 会被当成年份解析。
function toTime(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// 日期边界: 'YYYY-MM-DD' 按本地时区取当天首/末时刻, 与 aggregate.js 的
// parseDateBoundary 保持一致, 避免归属与账单窗口差一天
export function parseBoundary(value, isEnd = false) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const str = String(value).trim();
  const parts = str.split("-");
  const isDate =
    parts.length === 3 &&
    parts[0].length === 4 &&
    parts[1].length === 2 &&
    parts[2].length === 2;
  if (isDate) {
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if ([y, m, d].every(Number.isFinite)) {
      return isEnd
        ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
        : new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    }
  }
  return toTime(str);
}

// 订阅有效期: 从开始日期起; 已归档 / 已到期且未自动续费的, 到 expireAt 为止。
// 这样“先后两套套餐”各认领自己那段时间, 不会在同一时间轴上互相争抢。
export function subscriptionValidity(sub, now = Date.now()) {
  const validFrom = parseBoundary(sub.startDate || sub.startedAt, false);
  let validTo = null;
  const expireTs = parseBoundary(sub.expireAt, true);
  const isHistorical = sub.status === "historical" || sub.isHistorical === true;
  if (
    expireTs !== null &&
    (isHistorical || (expireTs < now && !sub.autoRenew))
  ) {
    validTo = expireTs;
  }
  return { validFrom, validTo };
}

// 两段有效期是否有交集: 不重叠(如先后两套套餐)就不算互相争抢
function rangesOverlap(a, b) {
  const start = Math.max(
    a.validFrom ?? Number.NEGATIVE_INFINITY,
    b.validFrom ?? Number.NEGATIVE_INFINITY,
  );
  const end = Math.min(
    a.validTo ?? Number.POSITIVE_INFINITY,
    b.validTo ?? Number.POSITIVE_INFINITY,
  );
  return start <= end;
}

function withinValidity(binding, ts) {
  const from = toTime(binding.validFrom);
  if (from !== null && ts < from) return false;
  const to = toTime(binding.validTo);
  if (to !== null && ts >= to) return false;
  return true;
}

// 返回按优先级排好的候选(可能为空)
export function candidatesFor(event, index) {
  const list = index.get(event.agent);
  if (!list || !list.length) return [];
  const ts = event.ts;
  return list.filter(
    (b) => matcherMatches(b.matcher, event) && withinValidity(b, ts),
  );
}

// ---------- 批量归属 ----------

// events: 全部事件(各工具混合)。返回按订阅聚合的结果 + 统计。
export function attributeEvents(events = [], index = new Map()) {
  const bySubscription = new Map(); // subscriptionId -> events[]
  const byBinding = new Map(); // bindingId -> events[]
  let matched = 0;
  let unmatched = 0;
  let ambiguous = 0;

  for (const ev of events) {
    const cands = candidatesFor(ev, index);
    if (!cands.length) {
      unmatched += 1;
      continue;
    }
    if (cands.length > 1) ambiguous += 1;
    const winner = cands[0]; // 只取优先级最高的一个: 保证不重复计费
    if (!byBinding.has(winner.id)) byBinding.set(winner.id, []);
    byBinding.get(winner.id).push(ev);
    if (!bySubscription.has(winner.subscriptionId))
      bySubscription.set(winner.subscriptionId, []);
    bySubscription.get(winner.subscriptionId).push(ev);
    matched += 1;
  }

  return {
    bySubscription,
    byBinding,
    stats: { total: events.length, matched, unmatched, ambiguous },
  };
}

// ---------- 冲突检测 ----------

// 同一工具下, 两条绑定认领范围完全相同 -> identical(必然争抢)
// 都有过滤条件但不同 -> overlap(可能同时命中, 取决于实际模型名)
// 一条有过滤、一条没有 -> 合理分工(具体的优先, 剩下的归兜底), 不算冲突
export function detectConflicts(bindings = []) {
  const byTool = new Map();
  for (const b of bindings) {
    if (!byTool.has(b.tool)) byTool.set(b.tool, []);
    byTool.get(b.tool).push(b);
  }
  const conflicts = [];
  for (const [tool, list] of byTool) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const am = a.matcher;
        const bm = b.matcher;
        const aEmpty = !am.models.length && !am.projects.length;
        const bEmpty = !bm.models.length && !bm.projects.length;
        let kind = null;
        if (aEmpty && bEmpty) kind = "identical";
        else if (matcherKey(am) === matcherKey(bm)) kind = "identical";
        else if (!aEmpty && !bEmpty) kind = "overlap";
        // 有效期不重叠(例如同一工具先后两套套餐)就不算冲突: 各认领自己那段时间
        if (kind && !rangesOverlap(a, b)) kind = null;
        if (kind) {
          // 报出当前赢家: 与 buildIndex 的排序一致(优先级降序 -> id 升序),
          // 让用户知道这些用量现在记在哪个订阅头上
          let winner = a;
          if (
            b.priority > a.priority ||
            (b.priority === a.priority && b.id < a.id)
          ) {
            winner = b;
          }
          conflicts.push({
            tool,
            kind,
            bindingIds: [a.id, b.id],
            subscriptionIds: [a.subscriptionId, b.subscriptionId],
            winnerSubscriptionId: winner.subscriptionId,
          });
        }
      }
    }
  }
  return conflicts;
}
