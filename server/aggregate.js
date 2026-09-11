// 聚合层: collectors + quota + insights + store -> snapshot
// 两个核心实体:
//   1. 工具层 agents: claude/codex/opencode/codebuddy/pi/agy/cursor，负责用量与 5h/周额度
//   2. 订阅层 subscriptions: 记录付费订阅/预付、月费、周期、状态与关联工具用量

import { collect as collectClaude } from "./collectors/claude.js";
import { collect as collectCodex } from "./collectors/codex.js";
import { collect as collectOpencode } from "./collectors/opencode.js";
import { collect as collectCodebuddy } from "./collectors/codebuddy.js";
import { collect as collectPi } from "./collectors/pi.js";
import { collect as collectManual } from "./collectors/manual.js";
import { resolveQuota } from "./quota/index.js";
import {
  detectDormant,
  buildHeatmap,
  buildDistribution,
  buildUsageAnalytics,
} from "./insights.js";
import { loadConfig } from "./store.js";
import { collect as collectAgy } from "./collectors/agy.js";
import { collect as collectCursor } from "./collectors/cursor.js";
import {
  resolveBindings,
  buildIndex,
  attributeEvents,
  detectConflicts,
} from "./attribution.js";
import { buildCursorQuota } from "./quota/cursor.js";
import {
  detectCodingPlanProvider,
  fetchCodingPlanQuota,
} from "./quota/codingPlan.js";

const DAY = 24 * 3600 * 1000;
const H5 = 5 * 3600 * 1000;

// 自动发现的工具元信息(无订阅语义;订阅在 subscriptions 层)
const AUTO_AGENTS = [
  { agent: "claude", name: "Claude Code", discoverable: true },
  { agent: "codex", name: "Codex", discoverable: true },
  { agent: "opencode", name: "OpenCode", discoverable: true },
  { agent: "codebuddy", name: "CodeBuddy", discoverable: true },
  { agent: "pi", name: "Pi", discoverable: true },
  { agent: "agy", name: "Agy", discoverable: true },
  { agent: "cursor", name: "Cursor", discoverable: true },
];

export async function buildSnapshot() {
  const now = Date.now();
  const cfg = loadConfig();
  const unpricedModels = new Set();
  const opts = { pricingOverrides: cfg.pricingOverrides, unpricedModels };const claudeEvents = collectClaude(opts);
  const codexRes = collectCodex(opts);
  const opencodeEvents = collectOpencode(opts);
  const codebuddyEvents = collectCodebuddy(opts);
  const piEvents = collectPi(opts);
  const agyEvents = collectAgy(opts);
  const cursorEvents = collectCursor(opts);
  const manualBySub = collectManual({ config: cfg, unpricedModels });
  const codexEvents = codexRes.events;

  const byAgent = new Map();
  byAgent.set("claude", claudeEvents);
  byAgent.set("codex", codexEvents);
  byAgent.set("opencode", opencodeEvents);
  byAgent.set("codebuddy", codebuddyEvents);
  byAgent.set("pi", piEvents);
  byAgent.set("agy", agyEvents);
  byAgent.set("cursor", cursorEvents);const agentRecords = [];
  for (const meta of AUTO_AGENTS) {
    const events = (byAgent.get(meta.agent) || []).sort((a, b) => a.ts - b.ts);
    agentRecords.push(
      await buildAgentRecord(meta, events, codexRes.latestRateLimit, cfg, now),
    );
  }

  const allEvents = []
    .concat(
      claudeEvents,
      codexEvents,
      opencodeEvents,
      codebuddyEvents,
      piEvents,
      agyEvents,
      cursorEvents,
    )
    .sort((a, b) => a.ts - b.ts);
  // 订阅归属: 每条事件最多归属一个订阅(详见 server/attribution.js)
  const bindings = resolveBindings(cfg);
  const attribution = attributeEvents(allEvents, buildIndex(bindings));
  const attributionSummary = {
    stats: attribution.stats,
    conflicts: detectConflicts(bindings),
    source:
      Array.isArray(cfg.bindings) && cfg.bindings.length
        ? "explicit"
        : "derived",
  };

  const subscriptions = await buildSubscriptions(
    cfg,
    manualBySub,    codexRes.latestRateLimit,
    now,
    attribution,
  );

  return {
    generatedAt: now,
    agents: agentRecords,
    subscriptions,
    attribution: attributionSummary,global: {
      cost30d: allEvents
        .filter((e) => e.ts >= now - 30 * DAY)
        .reduce((a, e) => a + e.costUSD, 0),
      tokens30d: allEvents
        .filter((e) => e.ts >= now - 30 * DAY)
        .reduce(
          (a, e) =>
            a +
            e.inputTokens +
            e.outputTokens +
            e.cacheReadTokens +
            e.cacheWriteTokens,
          0,
        ),
      distribution: buildDistribution(allEvents, 30, now),
      heatmap: buildHeatmap(allEvents.filter((e) => e.ts >= now - 30 * DAY)),
      analytics: buildUsageAnalytics(allEvents, now),
    },
    unpricedModels: [...unpricedModels],
  };
}

// ---------- 工具层 ----------
async function buildAgentRecord(meta, events, officialRateLimit, cfg, now) {
  const usage = usageStats(events, now);
  const quota = await resolveQuota({
    events,
    agent: meta.agent,
    officialRateLimit: meta.agent === "codex" ? officialRateLimit : null,
    manualQuota: null,
    quotaLimits: (cfg.quotaOverrides && cfg.quotaOverrides[meta.agent]) || null,
    now,
  });
  return {
    agent: meta.agent,
    name: meta.name,
    discoverable: !!meta.discoverable,
    quota,
    usage,
    models: [...new Set(events.map((e) => e.model).filter(Boolean))],
    analytics: buildUsageAnalytics(events, now),
  };
}

function parseDateBoundary(dStr, isEnd = false) {
  if (!dStr) return null;
  if (typeof dStr === "number" && isFinite(dStr)) return dStr;
  const str = String(dStr).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split("-").map(Number);
    if (isEnd) return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  }
  const t = Date.parse(str);
  return isFinite(t) ? t : null;
}

// ---------- 订阅层 ----------
// 订阅关联工具(agentIds)，直接按关联工具聚合真实本地/API用量与折算成本，并解析该订阅的 5h/周额度。
async function buildSubscriptions(
  cfg,
  manualBySub,
  codexOfficialRateLimit, now,
  attribution,
) {
  // attribution 由 buildSnapshot 计算并传入: 每条事件已归属到唯一订阅,
  // 这里只做聚合, 不再各自按 agentIds 捞事件(那样同工具的多个订阅会重复计入)
  const subs = await Promise.all(
    (cfg.subscriptions || []).map(async (sub) => {
      const isPrepaid = sub.billingType === "prepaid";
      const price =
        !isPrepaid && typeof sub.priceMonthly === "number"
          ? sub.priceMonthly
          : null;
      const startDate = sub.startDate || sub.startedAt || null;
      const startTs = parseDateBoundary(startDate, false);
      const expireTs = parseDateBoundary(sub.expireAt, true);

      // 状态判定: 明确指定的 status 优先; 否则若有到期时间且已到期且不自动续费, 自动判为 historical
      let status = sub.status;
      const isExpired =
        typeof expireTs === "number" &&
        isFinite(expireTs) &&
        expireTs < now &&
        !sub.autoRenew;
      if (!status) {
        status = isExpired ? "historical" : "active";
      }
      const isHistorical = status === "historical";

      // 折算时间窗口与订阅开始时间及有效区间强关联:
      // 1) 截止时间 endBound: 若已归档/已到期且在过去, 截止到到期时间; 否则截止到当前时间 now
      const endBound =
        isHistorical && typeof expireTs === "number" && expireTs < now
          ? expireTs
          : now;
      // 2) 起始时间 startBound: 默认过去 30 天, 但绝不早于订阅开始时间 startTs
      const defaultStart = endBound - 30 * DAY;
      const startBound =
        typeof startTs === "number" && startTs > 0
          ? Math.max(defaultStart, startTs)
          : defaultStart;
      const windowDays = Math.max(1, Math.round((endBound - startBound) / DAY));

      // 分工具明细: 只统计归属到本订阅的事件(已保证不与其它订阅重叠)
      const attrEvents = attribution.bySubscription.get(sub.id) || [];
      const attrByAgent = new Map();
      for (const e of attrEvents) {
        if (!attrByAgent.has(e.agent)) attrByAgent.set(e.agent, []);
        attrByAgent.get(e.agent).push(e);
      }
      const agentUsage = [];
      for (const aid of new Set([
        ...(sub.agentIds || []),
        ...attrByAgent.keys(),
      ])) {
        let tokens30d = 0,
          cost30d = 0,
          tokens7d = 0,
          cost7d = 0,
          requests30d = 0,
          last = null;
        const events = attrByAgent.get(aid) || [];
        for (const e of events) {
          // 记录订阅有效期内的最新活跃时间
          if (e.ts >= (startTs || 0) && e.ts <= endBound) {
            if (last === null || e.ts > last) last = e.ts;
          }
          // 统计折算周期内的用量
          if (e.ts >= startBound && e.ts <= endBound) {
            tokens30d += tok(e);
            cost30d += e.costUSD || 0;
            requests30d += 1;
          }
          if (
            e.ts >= Math.max(endBound - 7 * DAY, startBound) &&
            e.ts <= endBound
          ) {
            tokens7d += tok(e);
            cost7d += e.costUSD || 0;
          }
        }
        agentUsage.push({
          agent: aid,
          tokens30d,
          cost30d: round2(cost30d),
          tokens7d,
          cost7d: round2(cost7d),
          requests30d,
          lastActiveAt: last,
        });
      }

      const billCost30d = agentUsage.reduce((a, x) => a + x.cost30d, 0);
      const billTokens30d = agentUsage.reduce((a, x) => a + x.tokens30d, 0);
      const billRequests30d = agentUsage.reduce(
        (a, x) => a + (x.requests30d || 0),
        0,
      );

      // 手填事件
      const manual = manualBySub.get(sub.id) || [];
      let mTokens = 0,
        mCost = 0,
        mLast = null;
      for (const e of manual) {
        if (e.ts >= (startTs || 0) && e.ts <= endBound) {
          if (mLast === null || e.ts > mLast) mLast = e.ts;
        }
        if (e.ts >= startBound && e.ts <= endBound) {
          mTokens += tok(e);
          mCost += e.costUSD || 0;
        }
      }

      // 活跃: 各工具与手填取 max
      let lastActiveAt = mLast;
      for (const x of agentUsage) {
        if (
          x.lastActiveAt &&
          (lastActiveAt === null || x.lastActiveAt > lastActiveAt)
        )
          lastActiveAt = x.lastActiveAt;
      }

      const roi =
        price && price > 0 ? { ratio: (billCost30d + mCost) / price } : null;

      // 开始时间与已花费折算 (只计算和展示有效周期内实际已支出的金额)
      let monthsSinceStart = null;
      let costSinceStart = null;
      let yearlyCost = null;

      if (isPrepaid) {
        // 预付费类型: 已花费 = 累计充值金额(若填) 或 (当前余额 + 实际调用折算成本)
        const balance = typeof sub.balance === "number" ? sub.balance : 0;
        costSinceStart =
          typeof sub.totalRecharged === "number"
            ? sub.totalRecharged
            : round2(balance + billCost30d + mCost);
        yearlyCost = costSinceStart;
      } else if (price && price > 0) {
        const nDate = new Date(now);
        if (startDate) {
          const sTs = startTs;
          if (typeof sTs === "number" && isFinite(sTs)) {
            const sDate = new Date(sTs);
            // 若已归档/已到期, 计算截止时间为到期时间而非当前时间
            const endCalcDate =
              isHistorical &&
              typeof expireTs === "number" &&
              isFinite(expireTs) &&
              new Date(expireTs) < nDate
                ? new Date(expireTs)
                : nDate;

            if (sDate <= endCalcDate) {
              let m =
                (endCalcDate.getFullYear() - sDate.getFullYear()) * 12 +
                (endCalcDate.getMonth() - sDate.getMonth());
              if (endCalcDate.getDate() >= sDate.getDate()) m += 1;
              monthsSinceStart = Math.max(1, m);
              costSinceStart = Math.round(monthsSinceStart * price * 100) / 100;
            } else {
              monthsSinceStart = 0;
              costSinceStart = 0;
            }
          }
        }
        if (costSinceStart === null) {
          // 未填开始时间, 默认按当年至今自然月数
          monthsSinceStart = nDate.getMonth() + 1;
          costSinceStart = Math.round(monthsSinceStart * price * 100) / 100;
        }
        yearlyCost = costSinceStart;
      }
      // 沉睡: 有关联工具/手填用事件口径
      let dormantInfo;
      let subEvents = attrEvents.slice();
      if (manual && manual.length) {
        subEvents = subEvents.concat(manual);
      }
      subEvents = subEvents.filter(
        (e) => e.ts >= (startTs || 0) && e.ts <= endBound,
      );
      subEvents.sort((a, b) => a.ts - b.ts);

      if (subEvents.length) {
        dormantInfo = detectDormant(subEvents, 14, now);
      } else if (lastActiveAt) {
        dormantInfo = {
          dormant: now - lastActiveAt > 14 * DAY,
          daysSinceActive: (now - lastActiveAt) / DAY,
        };
      } else {
        dormantInfo = null;
      }

      // 额度解析: 预付费没有额度；显式/可靠识别的 Coding Plan 优先于工具级额度。
      let quota = null;
      const codingPlanProvider = detectCodingPlanProvider(sub);
      if (
        !isPrepaid &&
        !isHistorical &&
        ((sub.agentIds || []).length > 0 ||
          codingPlanProvider ||
          sub.manualQuota ||
          sub.quotaLimits)
      ) {
        if (codingPlanProvider) {
          quota = await resolveQuota({
            events: subEvents,
            agent: sub.id,
            apiFetcher: () => fetchCodingPlanQuota(sub),
            manualQuota: sub.manualQuota || null,
            quotaLimits:
              sub.quotaLimits || cfg.quotaOverrides?.[sub.id] || null,
            now,
          });
        } else if (sub.agentIds?.includes("cursor")) {
          quota = buildCursorQuota(
            subEvents,
            sub.quotaLimits || cfg.quotaOverrides?.cursor || null,
            now,
          );
        } else if (sub.agentIds?.includes("codex")) {
          // Codex 只有周额度 (优先官方接口/日志)
          const q = await resolveQuota({
            events: subEvents,
            agent: "codex",
            officialRateLimit: codexOfficialRateLimit,
            manualQuota: sub.manualQuota || null,
            quotaLimits: sub.quotaLimits || null,
            now,
          });
          if (q && q.week) {
            quota = {
              week: q.week,
              fiveHour: null,
              month: null,
              source: q.week.source || q.source || "api",
            };
          }
        } else {
          const primaryAgent = sub.agentIds?.[0];
          const hasQuotaConfig = !!(
            sub.manualQuota ||
            sub.quotaLimits ||
            (cfg.quotaOverrides &&
              (cfg.quotaOverrides[sub.id] ||
                (primaryAgent && cfg.quotaOverrides[primaryAgent])))
          );
          // OpenCode / Agy / Claude 具备额度
          const supportsRateLimit =
            sub.agentIds?.some((a) =>
              ["claude", "agy", "opencode"].includes(a),
            ) || hasQuotaConfig;

          if (supportsRateLimit) {
            quota = await resolveQuota({
              events: subEvents,
              agent: primaryAgent || sub.id,
              manualQuota: sub.manualQuota || null,
              quotaLimits:
                sub.quotaLimits ||
                (cfg.quotaOverrides &&
                  (cfg.quotaOverrides[sub.id] ||
                    (primaryAgent && cfg.quotaOverrides[primaryAgent]))) ||
                null,
              now,
            });
            // Agy 只有 5h 和周额度
            if (sub.agentIds?.includes("agy") && quota) {
              quota.month = null;
            }
          }
        }
      }

      return {
        id: sub.id,
        name: sub.name,
        status,
        isHistorical,
        billingType: isPrepaid ? "prepaid" : "subscription",
        plan: sub.plan || (isPrepaid ? "预付费" : null),
        priceMonthly: price,
        balance: typeof sub.balance === "number" ? sub.balance : null,
        totalRecharged:
          typeof sub.totalRecharged === "number" ? sub.totalRecharged : null,
        autoRenew: isPrepaid ? false : !!sub.autoRenew,
        startDate,
        billingCycleStart: sub.billingCycleStart || null,
        expireAt: sub.expireAt || null,
        note: sub.note || null,
        quota,
        quotaProvider: codingPlanProvider,
        agentIds: sub.agentIds || [],
        agentUsage,
        finance: {
          billingType: isPrepaid ? "prepaid" : "subscription",
          startDate,
          monthsSinceStart,
          costSinceStart,
          yearlyCost,
          balance: typeof sub.balance === "number" ? sub.balance : null,
        },
        usage: {
          tokens30d: billTokens30d + mTokens,
          cost30d: round2(billCost30d + mCost),
          requests30d: billRequests30d,
          lastActiveAt,
          windowDays,
          windowStart: startBound,
          windowEnd: endBound,
        },
        insights: { roiMonthly: roi, dormant: dormantInfo },
      };
    }),
  );

  // 排序: 当前正在使用/生效排在前面，历史归档排到最下面
  subs.sort((a, b) => {
    const ah = a.isHistorical ? 1 : 0;
    const bh = b.isHistorical ? 1 : 0;
    return ah - bh;
  });
  return subs;
}

function tok(e) {
  return (
    e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens
  );
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function usageStats(events, now) {
  const sum = (evts) =>
    evts.reduce(
      (a, e) => ({
        i: a.i + e.inputTokens,
        o: a.o + e.outputTokens,
        cr: a.cr + e.cacheReadTokens,
        cw: a.cw + e.cacheWriteTokens,
        c: a.c + e.costUSD,
      }),
      { i: 0, o: 0, cr: 0, cw: 0, c: 0 },
    );

  const last5h = sum(events.filter((e) => e.ts >= now - H5));
  const last7d = sum(events.filter((e) => e.ts >= now - 7 * DAY));

  const buckets = new Map();
  for (const e of events) {
    const k = Math.floor(e.ts / DAY);
    const b = buckets.get(k) || { tokens: 0, costUSD: 0 };
    b.tokens += tok(e);
    b.costUSD += e.costUSD || 0;
    buckets.set(k, b);
  }
  const last30dByDay = [];
  for (let d = 29; d >= 0; d--) {
    const k = Math.floor((now - d * DAY) / DAY);
    const b = buckets.get(k) || { tokens: 0, costUSD: 0 };
    last30dByDay.push({
      day: new Date(k * DAY).toISOString().slice(0, 10),
      ...b,
    });
  }

  return {
    last5h: { ...last5h, tokens: last5h.i + last5h.o + last5h.cr + last5h.cw },
    last7d: { ...last7d, tokens: last7d.i + last7d.o + last7d.cr + last7d.cw },
    last30dByDay,
    lastActiveAt: events.length ? events[events.length - 1].ts : null,
  };
}
