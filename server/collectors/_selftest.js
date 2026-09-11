// collector 自测脚本: 三个 collector 各自对真实数据跑通基本断言
// 运行: npm run selftest (node server/collectors/_selftest.js)

import { collect as collectClaude } from "./claude.js";
import { collect as collectCodex } from "./codex.js";
import { collect as collectOpencode } from "./opencode.js";
import { collect as collectCodebuddy } from "./codebuddy.js";
import { collect as collectPi } from "./pi.js";
import { collect as collectAgy } from "./agy.js";
import { collect as collectCursor } from "./cursor.js";

const now = Date.now();
const DAY = 24 * 3600 * 1000;
let failures = [];

function section(name) {
  console.log("\n=== " + name + " ===");
}

function check(cond, label, detail) {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures.push(label);
  console.log("  [" + mark + "] " + label + (detail ? " :: " + detail : ""));
}

function sumTokens(events) {
  return events.reduce(
    (a, e) => ({
      i: a.i + e.inputTokens,
      o: a.o + e.outputTokens,
      cr: a.cr + e.cacheReadTokens,
      cw: a.cw + e.cacheWriteTokens,
    }),
    { i: 0, o: 0, cr: 0, cw: 0 },
  );
}

function span(events) {
  if (!events.length) return "n/a";
  return (
    new Date(events[0].ts).toISOString().slice(0, 10) +
    " ~ " +
    new Date(events[events.length - 1].ts).toISOString().slice(0, 10)
  );
}

// ---------- Claude ----------
section("claude");
try {
  const events = collectClaude();
  check(events.length > 0, "事件数>0", "n=" + events.length);
  const lastTs = events.length ? events[events.length - 1].ts : 0;
  check(
    lastTs > now - 90 * DAY,
    "最近事件在近90天内",
    new Date(lastTs).toISOString(),
  );
  const s = sumTokens(events);
  check(
    s.i > 0 && s.o > 0 && s.cr > 0,
    "累计 input/output/cacheRead 均>0",
    "in=" + s.i + " out=" + s.o + " cr=" + s.cr + " cw=" + s.cw,
  );
  const e0 = events[0];
  check(
    !!(
      e0 &&
      e0.agent === "claude" &&
      typeof e0.ts === "number" &&
      e0.model &&
      typeof e0.inputTokens === "number" &&
      typeof e0.costUSD === "number"
    ),
    "事件字段完整(agent/ts/model/tokens/costUSD)",
  );
  const cost = events.reduce((a, e) => a + e.costUSD, 0);
  console.log(
    "  events=" +
      events.length +
      ", span=" +
      span(events) +
      ", totalCost=$" +
      cost.toFixed(2),
  );
} catch (err) {
  check(false, "claude collector 未抛错", err.message);
}

// ---------- Codex ----------
section("codex");
try {
  const { events, latestRateLimit } = collectCodex();
  check(events.length > 0, "事件数>0", "n=" + events.length);
  const lastTs = events.length ? events[events.length - 1].ts : 0;
  check(
    lastTs > now - 120 * DAY,
    "最近事件时间合理(近120天内)",
    new Date(lastTs).toISOString(),
  );
  const s = sumTokens(events);
  check(
    s.i > 0 && s.o > 0 && s.cr > 0,
    "累计 input/output/cacheRead 均>0",
    "in=" + s.i + " out=" + s.o + " cr=" + s.cr,
  );
  const rl = latestRateLimit;
  const rlOk =
    rl === null ||
    (typeof rl === "object" &&
      (!rl.fiveHour ||
        (typeof rl.fiveHour.usedPct === "number" &&
          typeof rl.fiveHour.resetsAt === "number")) &&
      (!rl.week ||
        (typeof rl.week.usedPct === "number" &&
          typeof rl.week.resetsAt === "number")));
  check(
    rlOk,
    "latestRateLimit 结构完整或为 null",
    rl ? JSON.stringify(Object.keys(rl)) : "null",
  );
  const cost = events.reduce((a, e) => a + e.costUSD, 0);
  console.log(
    "  events=" +
      events.length +
      ", span=" +
      span(events) +
      ", totalCost=$" +
      cost.toFixed(2) +
      ", rateLimit=" +
      (rl ? Object.keys(rl).join(",") : "none"),
  );
} catch (err) {
  check(false, "codex collector 未抛错", err.message);
}

// ---------- OpenCode ----------
section("opencode");
try {
  const events = collectOpencode();
  check(events.length > 0, "事件数>0", "n=" + events.length);
  check(
    events.every((e) => e.agent === "opencode"),
    "全部事件 agent='opencode'",
  );
  const s = sumTokens(events);
  check(
    s.i > 0 && s.o > 0,
    "累计 input/output 均>0",
    "in=" + s.i + " out=" + s.o,
  );
  const cost = events.reduce((a, e) => a + e.costUSD, 0);
  console.log(
    "  events=" +
      events.length +
      ", span=" +
      span(events) +
      ", totalCost=$" +
      cost.toFixed(2),
  );
} catch (err) {
  check(false, "opencode collector 未抛错", err.message);
}

// ---------- CodeBuddy ----------
section("codebuddy");
try {
  const events = collectCodebuddy();
  check(events.length > 0, "事件数>0", "n=" + events.length);
  check(
    events.every((e) => e.agent === "codebuddy"),
    "全部事件 agent='codebuddy'",
  );
  const s = sumTokens(events);
  check(
    s.i > 0 && s.o > 0,
    "累计 input/output 均>0",
    "in=" + s.i + " out=" + s.o,
  );
  const models = new Set(events.map((e) => e.model));
  check(
    models.has("glm-5.3-flash") || models.has("hy4-preview"),
    "包含 CodeBuddy 模型",
    [...models].join(","),
  );
  const cost = events.reduce((a, e) => a + e.costUSD, 0);
  console.log(
    "  events=" +
      events.length +
      ", span=" +
      span(events) +
      ", totalCost=$" +
      cost.toFixed(2),
  );
} catch (err) {
  check(false, "codebuddy collector 未抛错", err.message);
}

// ---------- Pi ----------
section("pi");
try {
  const events = collectPi();
  check(events.length > 0, "事件数>0", "n=" + events.length);
  check(
    events.every((e) => e.agent === "pi"),
    "全部事件 agent='pi'",
  );
  const s = sumTokens(events);
  check(
    s.i > 0 && s.o > 0,
    "累计 input/output 均>0",
    "in=" + s.i + " out=" + s.o,
  );
  const cost = events.reduce((a, e) => a + e.costUSD, 0);
  console.log(
    "  events=" +
      events.length +
      ", span=" +
      span(events) +
      ", totalCost=$" +
      cost.toFixed(2),
  );
} catch (err) {
  check(false, "pi collector 未抛错", err.message);
}

// ---------- Agy ----------
section("agy");
try {
  const events = collectAgy();
  check(events.length > 0, "事件数>0", "n=" + events.length);
  check(
    events.every((e) => e.agent === "agy"),
    "全部事件 agent='agy'",
  );
  const s = sumTokens(events);
  check(
    s.i > 0 && s.o > 0 && s.cr > 0,
    "累计 input/output/cacheRead 均>0",
    "in=" + s.i + " out=" + s.o + " cr=" + s.cr,
  );
  const models = new Set(events.map((e) => e.model));
  // 不再断言具体的默认模型名(那只会验证兜底值), 改验解析质量
  check(
    [...models].every((m) => m.startsWith("gemini")),
    "模型名均为 gemini 系",
    [...models].join(","),
  );
  const unknown = events.filter((e) => e.model === "gemini-unknown").length;
  check(
    unknown / events.length < 0.05,
    "解析不到模型的事件占比 <5%",
    unknown + "/" + events.length,
  );
  const uuidProj = events.filter((e) => /^[0-9a-f]{8}-/.test(e.project)).length;
  check(
    uuidProj / events.length < 0.05,
    "取到真实工作区路径(非会话 id)占比 >95%",
    uuidProj + "/" + events.length,
  );
  const cost = events.reduce((a, e) => a + e.costUSD, 0);
  console.log(
    "  events=" +
      events.length +
      ", span=" +
      span(events) +
      ", totalCost=$" +
      cost.toFixed(2),
  );
} catch (err) {
  check(false, "agy collector 未抛错", err.message);
}

// ---------- Cursor ----------
section("cursor");
try {
  const events = collectCursor();
  check(events.length > 0, "事件数>0", "n=" + events.length);
  check(
    events.every((e) => e.agent === "cursor"),
    "全部事件 agent='cursor'",
  );
  const s = sumTokens(events);
  check(
    s.i > 0 && s.o > 0,
    "累计 input/output 均>0",
    "in=" + s.i + " out=" + s.o,
  );
  const models = new Set(events.map((e) => e.model));
  check(
    models.has("grok-4.6") ||
      models.has("grok-4.5") ||
      models.has("claude-opus-5") ||
      models.has("cursor-small"),
    "包含 Cursor 实际模型",
    [...models].join(","),
  );
  const cost = events.reduce((a, e) => a + e.costUSD, 0);
  console.log(
    "  events=" +
      events.length +
      ", span=" +
      span(events) +
      ", totalCost=$" +
      cost.toFixed(2),
  );
} catch (err) {
  check(false, "cursor collector 未抛错", err.message);
}

// ---------- 汇总 ----------
console.log("\n=== result ===");
if (failures.length) {
  console.log(
    "FAILED: " + failures.length + " check(s): " + failures.join("; "),
  );
  process.exit(1);
} else {
  console.log("ALL PASS");
}
