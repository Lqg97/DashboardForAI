// 订阅与覆盖配置存取: data/config.json
// 订阅主体是渠道(provider),不是工具(agent);工具只是接入方式。
// 结构: {subscriptions: [{id, name, plan, priceMonthly, autoRenew, billingCycleStart, expireAt,
//        note, providerIds?[](关联cc-switch渠道,可跨工具多条), agentIds?[](关联工具)}],
//        pricingOverrides: {}, quotaOverrides: {}}
// 兼容: 旧结构 agents[] 读入时迁移为 subscriptions[]
// 写入原子性: 临时文件 + rename

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, DATA_DIR } from "./config.js";
import { randomBytes } from "node:crypto";

const DEFAULT_CONFIG = {
  subscriptions: [],
  pricingOverrides: {},
  quotaOverrides: {},
};
const QUOTA_PROVIDERS = new Set([
  "kimi",
  "zhipu",
  "zhipu_cn",
  "zhipu_en",
  "zhipu_team",
  "minimax",
  "minimax_cn",
  "minimax_global",
  "minimax_en",
  "zenmux",
  "volcengine",
  "opencode_go",
]);
const CREDENTIAL_FIELDS = [
  "apiKey",
  "accessKeyId",
  "secretAccessKey",
  "teamOrganizationId",
  "teamProjectId",
];

export function loadConfig(configPath = CONFIG_PATH) {
  try {
    const raw = readFileSync(configPath, "utf8");
    const d = JSON.parse(raw);
    return normalize(d);
  } catch {
    return { ...DEFAULT_CONFIG }; // 不存在或损坏 -> 默认空配置,不抛错
  }
}

function normalize(d) {
  if (!d || typeof d !== "object") return { ...DEFAULT_CONFIG };
  // 旧结构 agents[] -> subscriptions[](同一批字段语义迁移)
  const rawSubs = Array.isArray(d.subscriptions)
    ? d.subscriptions
    : Array.isArray(d.agents)
      ? d.agents
      : [];
  const seen = new Set();
  const out = [];
  for (let a of rawSubs) {
    if (!a || typeof a !== "object") continue;
    if (!a.id) a = { id: "sub-" + randomBytes(4).toString("hex"), ...a };
    if (seen.has(a.id)) continue; // 去重
    seen.add(a.id);
    out.push(a);
  }
  // bindings: 订阅归属规则(可选)。缺失时由 agentIds 推导, 见 server/attribution.js
  const bindings = Array.isArray(d.bindings)
    ? d.bindings.filter((b) => b && typeof b === "object")
    : [];
  return {
    subscriptions: out,
    bindings,
    pricingOverrides:
      d.pricingOverrides && typeof d.pricingOverrides === "object"
        ? d.pricingOverrides
        : {},
    quotaOverrides:
      d.quotaOverrides && typeof d.quotaOverrides === "object"
        ? d.quotaOverrides
        : {},
  };
}

// 全量校验: 每个订阅条目必须有 name;数值字段必须是有限数;时间字段 ISO 或 epoch
export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg))
    return ["config 必须是对象"];
  if (cfg.subscriptions !== undefined && !Array.isArray(cfg.subscriptions))
    errors.push("subscriptions 必须是数组");
  for (const a of cfg.subscriptions || []) {
    if (!a || typeof a !== "object") {
      errors.push("subscriptions 元素必须是对象");
      continue;
    }
    if (!a.name || typeof a.name !== "string")
      errors.push("subscription 缺少 name");
    if (a.agentIds !== undefined && !isStringArray(a.agentIds))
      errors.push(a.name + ": agentIds 必须是字符串数组");
    if (a.providerIds !== undefined && !isStringArray(a.providerIds))
      errors.push(a.name + ": providerIds 必须是字符串数组");
    if (a.modelFilter !== undefined && !isStringArray(a.modelFilter))
      errors.push(a.name + ": modelFilter 必须是字符串数组");
    if (
      a.status !== undefined &&
      a.status !== null &&
      !["active", "historical", "paused"].includes(a.status)
    )
      errors.push(a.name + ": status 必须是 active 或 historical 或 paused");
    if (
      a.billingType !== undefined &&
      a.billingType !== null &&
      !["subscription", "prepaid"].includes(a.billingType)
    )
      errors.push(a.name + ": billingType 必须是 subscription 或 prepaid");
    if (
      a.quotaProvider !== undefined &&
      a.quotaProvider !== null &&
      (typeof a.quotaProvider !== "string" ||
        !QUOTA_PROVIDERS.has(a.quotaProvider))
    )
      errors.push(a.name + ": quotaProvider 不受支持");
    for (const field of CREDENTIAL_FIELDS) {
      if (
        a[field] !== undefined &&
        a[field] !== null &&
        typeof a[field] !== "string"
      )
        errors.push(a.name + ": " + field + " 必须是字符串");
    }
    for (const field of ["baseUrl", "quotaBaseUrl"]) {
      if (
        a[field] !== undefined &&
        a[field] !== null &&
        !validHttpUrl(a[field])
      )
        errors.push(a.name + ": " + field + " 必须是 http(s) URL");
    }
    if (
      a.balance !== undefined &&
      a.balance !== null &&
      (typeof a.balance !== "number" || !isFinite(a.balance) || a.balance < 0)
    )
      errors.push(a.name + ": balance 必须是 >=0 的数");
    if (
      a.totalRecharged !== undefined &&
      a.totalRecharged !== null &&
      (typeof a.totalRecharged !== "number" ||
        !isFinite(a.totalRecharged) ||
        a.totalRecharged < 0)
    )
      errors.push(a.name + ": totalRecharged 必须是 >=0 的数");
    if (
      a.priceMonthly !== undefined &&
      a.priceMonthly !== null &&
      (typeof a.priceMonthly !== "number" ||
        !isFinite(a.priceMonthly) ||
        a.priceMonthly < 0)
    )
      errors.push(a.name + ": priceMonthly 必须是 >=0 的数");
    for (const k of [
      "expireAt",
      "billingCycleStart",
      "startDate",
      "startedAt",
    ]) {
      if (a[k] !== undefined && a[k] !== null && !validTime(a[k]))
        errors.push(a.name + ": " + k + " 必须是 epoch ms 或 ISO 字符串");
    }
  }
  // bindings: 只做结构校验, 语义(外键/冲突)由 attribution 层在运行时报告,
  // 这里不阻断保存 —— 用户可能正在调整订阅与绑定的过程中
  if (cfg.bindings !== undefined) {
    if (!Array.isArray(cfg.bindings)) errors.push("bindings 必须是数组");
    else {
      for (const b of cfg.bindings) {
        if (!b || typeof b !== "object") {
          errors.push("bindings 元素必须是对象");
          continue;
        }
        if (typeof b.subscriptionId !== "string" || !b.subscriptionId)
          errors.push("binding 缺少 subscriptionId");
        if (typeof b.tool !== "string" || !b.tool)
          errors.push("binding 缺少 tool");
        if (
          b.priority !== undefined &&
          b.priority !== null &&
          typeof b.priority !== "number"
        )
          errors.push("binding priority 必须是数字");
        if (b.matcher !== undefined && b.matcher !== null) {
          if (typeof b.matcher !== "object" || Array.isArray(b.matcher))
            errors.push("binding matcher 必须是对象");
          else {
            for (const key of ["models", "projects"]) {
              if (
                b.matcher[key] !== undefined &&
                !isStringArray(b.matcher[key])
              )
                errors.push("binding matcher." + key + " 必须是字符串数组");
            }
          }
        }
        for (const key of ["validFrom", "validTo"]) {
          if (b[key] !== undefined && b[key] !== null && !validTime(b[key]))
            errors.push("binding " + key + " 必须是 epoch ms 或 ISO 字符串");
        }
      }
    }
  }
  if (
    cfg.pricingOverrides !== undefined &&
    (typeof cfg.pricingOverrides !== "object" ||
      Array.isArray(cfg.pricingOverrides))
  )
    errors.push("pricingOverrides 必须是对象");
  if (
    cfg.quotaOverrides !== undefined &&
    (typeof cfg.quotaOverrides !== "object" ||
      Array.isArray(cfg.quotaOverrides))
  )
    errors.push("quotaOverrides 忀须是对象");
  return errors;
}

function validTime(v) {
  if (typeof v === "number") return isFinite(v) && v > 0;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return isFinite(t);
  }
  return false;
}

function isStringArray(value) {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim())
  );
}

function validHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// 原子写入: 同目录临时文件 + rename(同文件系统保证原子)
export function saveConfig(cfg, configPath = CONFIG_PATH) {
  const errors = validateConfig(cfg);
  if (errors.length) {
    const err = new Error("config 校验失败: " + errors.join("; "));
    err.statusCode = 400;
    throw err;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = join(
    dirname(configPath),
    "." + "config.tmp." + randomBytes(4).toString("hex"),
  );
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  try {
    renameSync(tmp, configPath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

// upsert 一条订阅;返回更新后的完整 config
export function upsertSubscription(cfg, sub) {
  const next = { ...cfg };
  next.subscriptions = [...cfg.subscriptions];
  const idx = cfg.subscriptions.findIndex((x) => x.id === sub.id);
  if (idx >= 0) next.subscriptions[idx] = { ...cfg.subscriptions[idx], ...sub };
  else
    next.subscriptions.push({
      id: sub.id || "sub-" + randomBytes(4).toString("hex"),
      ...sub,
    });
  return next;
}

// 删除一条订阅
export function removeSubscription(cfg, subId) {
  return {
    ...cfg,
    subscriptions: cfg.subscriptions.filter((x) => x.id !== subId),
  };
}
