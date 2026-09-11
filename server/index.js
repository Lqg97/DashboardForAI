// HTTP server: 内置 node:http, 仅监听 127.0.0.1:4780
// 路由: GET / | GET /api/agents | POST /api/refresh | GET|PUT /api/config | GET /api/export
// snapshot 缓存: 内存 + data/snapshot.json;POST /api/refresh 触发重扫;默认每5分钟自动重扫

import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import {
  PORT,
  HOST,
  PUBLIC_DIR,
  SNAPSHOT_PATH,
  RESCAN_INTERVAL_MS,
  CONFIG_PATH,
} from "./config.js";
import { buildSnapshot } from "./aggregate.js";
import { loadConfig, saveConfig } from "./store.js";
import {
  ensurePricingFresh,
  syncedPricingAge,
  TTL_MS,
  CACHE_PATH,
} from "./pricing-sync.js";
import { invalidateSyncedCache } from "./pricing-chain.js";
import { loadSettings, saveSettings } from "./settings.js";
import { createReporter } from "./reporter.js";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let snapshot = null; // 内存缓存
let rebuilding = false;
let lastBuildMs = 0;

export function loadCachedSnapshot() {
  if (snapshot) return snapshot;
  if (existsSync(SNAPSHOT_PATH)) {
    try {
      snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
      try {
        lastBuildMs = statSync(SNAPSHOT_PATH).mtimeMs || Date.now();
      } catch {
        lastBuildMs = Date.now();
      }
      return snapshot;
    } catch (e) {
      console.warn("[server] 读取磁盘快照缓存失败:", e.message);
    }
  }
  return null;
}

// 模块加载即尝试从磁盘快速预热，保证冷启动首次请求 0 延迟响应
loadCachedSnapshot();

export async function refreshSnapshot(force = false) {
  if (rebuilding) return snapshot;
  if (!snapshot) {
    loadCachedSnapshot();
  }

  const hasValidCache =
    snapshot && Date.now() - lastBuildMs < RESCAN_INTERVAL_MS;
  if (!force && hasValidCache) return snapshot;

  // Stale-While-Revalidate: 若已有快照(哪怕超出 5 分钟)，非强制请求时立即返回当前缓存，后台异步无感重扫
  if (!force && snapshot) {
    rebuilding = true;
    (async () => {
      try {
        try {
          const pricingChanged = await ensurePricingFresh(false);
          if (pricingChanged) invalidateSyncedCache();
        } catch {}
        snapshot = await buildSnapshot();
        lastBuildMs = Date.now();
        try {
          writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot), "utf8");
        } catch {}
      } catch (err) {
        console.error("[server] 异步后台刷新异常:", err);
      } finally {
        rebuilding = false;
      }
    })();
    return snapshot;
  }

  // 既无缓存或显式强制刷新时，同步等待重扫完成
  rebuilding = true;
  try {
    // 后台自动检测定价 TTL, 过期则更新 models-dev 定价并重载内存缓存
    try {
      const pricingChanged = await ensurePricingFresh(false);
      if (pricingChanged) invalidateSyncedCache();
    } catch {
      /* 容错: 定价拉取失败不影响用量重扫 */
    }

    snapshot = await buildSnapshot();
    lastBuildMs = Date.now();
    try {
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot), "utf8");
    } catch {
      /* 缓存写失败不影响服务 */
    }
    return snapshot;
  } finally {
    rebuilding = false;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------- export ----------
function toCsv(snapshotObj) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [
    [
      "id",
      "name",
      "status",
      "billingType",
      "plan",
      "priceMonthly",
      "balance",
      "startDate",
      "expireAt",
      "autoRenew",
      "yearlyCost",
      "tokens30d",
      "apiEquivalentCost30dUsd",
      "agentIds",
      "lastActiveAt",
    ].join(","),
  ];
  for (const s of snapshotObj.subscriptions || []) {
    rows.push(
      [
        s.id,
        s.name,
        s.isHistorical ? "historical" : "active",
        s.billingType || "subscription",
        s.plan || "",
        s.priceMonthly || "",
        s.balance || "",
        s.startDate || "",
        s.expireAt || "",
        s.autoRenew ? 1 : 0,
        s.finance?.yearlyCost || "",s.usage?.tokens30d || "",
        s.usage?.cost30d || "",
        (s.agentIds || []).join(";"),
        s.usage?.lastActiveAt
          ? new Date(s.usage.lastActiveAt).toISOString()
          : "",
      ]
        .map(esc)
        .join(","),
    );
  }
  return rows.join("\n") + "\n";
}

// ---------- 静态文件 ----------
function serveStatic(res, urlObj) {
  let p = decodeURIComponent(urlObj.pathname);
  if (p === "/") p = "/index.html";
  const file = join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] || "application/octet-stream",
  });
  res.end(body);
}

// ---------- 路由 ----------
async function route(req, res) {
  const urlObj = new URL(req.url, "http://localhost");
  const { pathname } = urlObj;

  // 非 /api 的 GET/HEAD 一律走静态(路径穿越防护在 serveStatic 内)
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    !pathname.startsWith("/api")
  ) {
    return serveStatic(res, urlObj);
  }

  // 机器列表(含本机与 Hub 远端机器列表)
  if (req.method === "GET" && pathname === "/api/machines") {
    const settings = loadSettings().online;
    const localMachine = settings.machine || "localhost";
    let remoteMachines = [];
    if (settings.enabled && settings.hubUrl) {
      try {
        const hub = settings.hubUrl.replace(/\/+$/, "");
        const tokenPart = settings.token
          ? `&token=${encodeURIComponent(settings.token)}`
          : "";
        const userPart = `user=${encodeURIComponent(settings.user)}`;
        const resHub = await fetch(
          `${hub}/api/machines?${userPart}${tokenPart}`,
          {
            signal: AbortSignal.timeout(4000),
          },
        );
        if (resHub.ok) {
          const j = await resHub.json();
          remoteMachines = Array.isArray(j.machines) ? j.machines : [];
        }
      } catch (err) {
        console.warn("[server] 获取 Hub 机器列表失败:", err.message);
      }
    }
    return sendJson(res, 200, {
      ok: true,
      localMachine,
      online: settings.enabled,
      hubUrl: settings.hubUrl,
      user: settings.user,
      machines: remoteMachines,
    });
  }

  if (req.method === "GET" && pathname === "/api/agents") {
    const source = urlObj.searchParams.get("source") || "__local__";
    const settings = loadSettings().online;
    const localMachine = settings.machine || "localhost";

    // 默认看本机
    if (source === "__local__" || source === localMachine) {
      const snap = await refreshSnapshot(false);
      return sendJson(res, 200, {
        ...snap,
        hub: {
          mode: "local",
          source: "__local__",
          machine: localMachine,
          user: settings.user,
        },
      });
    }

    // 看总计(__all__)或指定远程机器: 从 Hub 拉取
    if (settings.enabled && settings.hubUrl) {
      try {
        const hub = settings.hubUrl.replace(/\/+$/, "");
        const tokenPart = settings.token
          ? `&token=${encodeURIComponent(settings.token)}`
          : "";
        const userPart = `user=${encodeURIComponent(settings.user)}`;
        const machinePart =
          source === "__all__"
            ? "&machine=__all__"
            : `&machine=${encodeURIComponent(source)}`;
        const resHub = await fetch(
          `${hub}/api/agents?${userPart}${tokenPart}${machinePart}`,
          {
            signal: AbortSignal.timeout(8000),
          },
        );
        if (resHub.ok) {
          const hubSnap = await resHub.json();
          hubSnap.hub = {
            ...(hubSnap.hub || {}),
            mode: "hub_remote",
            source,
            localMachine,
          };
          return sendJson(res, 200, hubSnap);
        } else {
          const errText = await resHub.text();
          return sendJson(res, resHub.status, {
            error: `Hub 返回错误 HTTP ${resHub.status}: ${errText.slice(0, 100)}`,
          });
        }
      } catch (err) {
        return sendJson(res, 502, {
          error: `无法连接 Hub 服务器 (${settings.hubUrl}): ${err.message}`,
        });
      }
    }

    return sendJson(res, 400, {
      error:
        "联机上报未开启，无法查看云端汇总或远程机器。请在设置中开启联机上报。",
    });
  }

  if (req.method === "POST" && pathname === "/api/refresh") {
    const source = urlObj.searchParams.get("source") || "__local__";
    const settings = loadSettings().online;
    if (
      source !== "__local__" &&
      source !== settings.machine &&
      settings.enabled &&
      settings.hubUrl
    ) {
      try {
        const hub = settings.hubUrl.replace(/\/+$/, "");
        const tokenPart = settings.token
          ? `&token=${encodeURIComponent(settings.token)}`
          : "";
        const userPart = `user=${encodeURIComponent(settings.user)}`;
        await fetch(`${hub}/api/refresh?${userPart}${tokenPart}`, {
          method: "POST",
          signal: AbortSignal.timeout(4000),
        });
      } catch {}
    }
    const forcePricing =
      urlObj.searchParams.get("forcePricing") === "1" ||
      urlObj.searchParams.get("forcePricing") === "true";
    if (forcePricing) {
      try {
        const changed = await ensurePricingFresh(true);
        if (changed) invalidateSyncedCache();
      } catch {
        /* ignore */
      }
    }
    const snap = await refreshSnapshot(true);
    return sendJson(res, 200, { ok: true, generatedAt: snap.generatedAt });
  }

  if (
    req.method === "POST" &&
    (pathname === "/api/pricing/sync" || pathname === "/api/pricing/refresh")
  ) {
    try {
      const changed = await ensurePricingFresh(true);
      if (changed) invalidateSyncedCache();
      const snap = await refreshSnapshot(true);
      return sendJson(res, 200, {
        ok: true,
        synced: changed,
        generatedAt: snap.generatedAt,
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === "GET" && pathname === "/api/pricing") {
    const ageMs = syncedPricingAge();
    return sendJson(res, 200, {
      ageMs,
      ttlMs: TTL_MS,
      isFresh: ageMs < TTL_MS,
      cachePath: CACHE_PATH,
    });
  }

  if (req.method === "GET" && pathname === "/api/config") {
    return sendJson(res, 200, loadConfig());
  }

  if (req.method === "PUT" && pathname === "/api/config") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "invalid JSON" });
    }
    try {
      saveConfig(body);
      const snap = await refreshSnapshot(true);
      return sendJson(res, 200, {
        ok: true,
        config: loadConfig(),
        generatedAt: snap.generatedAt,
      });
    } catch (e) {
      if (e.statusCode === 400) return sendJson(res, 400, { error: e.message });
      console.error("[config] save failed:", e.message);
      return sendJson(res, 500, { error: "save failed: " + e.message });
    }
  }

  if (req.method === "GET" && pathname === "/api/export") {
    const format = (urlObj.searchParams.get("format") || "json").toLowerCase();
    const snap = await refreshSnapshot(false);
    if (format === "csv") {
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="ai-sub-export.csv"',
      });
      return res.end(toCsv(snap));
    }
    return sendJson(res, 200, snap);
  }

  // ---------- 联机上报(本机设置 data/settings.json, 用户可随时开关) ----------
  if (req.method === "GET" && pathname === "/api/online") {
    const settings = loadSettings().online;
    const st = reporter ? reporter.state() : null;
    const tokenPart = settings.token
      ? "&token=" + encodeURIComponent(settings.token)
      : "";
    return sendJson(res, 200, {
      ...settings,
      running: st ? st.running : false,
      lastReportAt: st ? st.lastReportAt : null,
      lastError: st ? st.lastError : null,
      reportCount: st ? st.reportCount : 0,
      personalUrl:
        settings.enabled && settings.hubUrl
          ? `${settings.hubUrl.replace(/\/+$/, "")}/?user=${encodeURIComponent(settings.user)}${tokenPart}`
          : null,
    });
  }

  if (req.method === "PUT" && pathname === "/api/online") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "invalid JSON" });
    }
    // token 为空且原值存在时保留旧 token(便于只改开关不重填凭据)
    if (
      body &&
      body.online &&
      (body.online.token === "" || body.online.token === undefined) &&
      !body.online.tokenCleared
    ) {
      body.online.token = loadSettings().online.token;
    }
    try {
      saveSettings(body);
    } catch (e) {
      if (e.statusCode === 400) return sendJson(res, 400, { error: e.message });
      return sendJson(res, 500, { error: "save failed: " + e.message });
    }
    const applied = applyOnlineReporter();
    return sendJson(res, 200, { ok: true, ...onlineStatus(applied) });
  }

  // 一键开关(桌面托盘/前端切换用): enabled=true 时需要已有合法配置
  if (req.method === "POST" && pathname === "/api/online/toggle") {
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      /* ignore */
    }
    const settings = loadSettings();
    const next =
      body.enabled === undefined ? !settings.online.enabled : !!body.enabled;
    settings.online.enabled = next;
    try {
      saveSettings(settings);
    } catch (e) {
      if (e.statusCode === 400) return sendJson(res, 400, { error: e.message });
      return sendJson(res, 500, { error: "save failed: " + e.message });
    }
    const applied = applyOnlineReporter(settings);
    return sendJson(res, 200, { ok: true, ...onlineStatus(applied) });
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

// ---------- 联机上报器管理(单例) ----------
let reporter = null;

function onlineStatus(r) {
  const settings = loadSettings().online;
  const st = r ? r.state() : null;
  const tokenPart = settings.token
    ? "&token=" + encodeURIComponent(settings.token)
    : "";
  return {
    ...settings,
    running: st ? st.running : false,
    lastReportAt: st ? st.lastReportAt : null,
    lastError: st ? st.lastError : null,
    reportCount: st ? st.reportCount : 0,
    personalUrl:
      settings.enabled && settings.hubUrl
        ? `${settings.hubUrl.replace(/\/+$/, "")}/?user=${encodeURIComponent(settings.user)}${tokenPart}`
        : null,
  };
}

// 按当前设置启/停上报器; 返回当前 reporter
function applyOnlineReporter() {
  const settings = loadSettings().online;
  if (!settings.enabled) {
    if (reporter) {
      reporter.stop();
      reporter = null;
    }
    console.log("[online] 联机上报已关闭");
    return null;
  }
  if (reporter) {
    reporter.stop();
    reporter = null;
  }
  reporter = createReporter({
    hubUrl: settings.hubUrl,
    token: settings.token,
    user: settings.user,
    machine: settings.machine,
    intervalMs: settings.intervalMs,
    buildSnapshotFn: refreshSnapshot,
    log: console,
  });
  reporter.start();
  console.log(
    `[online] 联机上报已开启 -> ${settings.hubUrl} (用户=${settings.user})`,
  );
  return reporter;
}

export function startServer() {
  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error("[http]", e);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[server] 端口 ${PORT} 已被占用，复用现有服务实例。`);
    } else {
      console.error("[server] 服务异常:", err);
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`ai-sub-dashboard listening on http://${HOST}:${PORT}`);
    ensurePricingFresh().then((changed) => {
      if (changed) invalidateSyncedCache();
    });
    // 设置里开启了联机上报 -> 随服务自动启动(桌面 App 与 npm start 同样生效)
    try {
      if (loadSettings().online.enabled) applyOnlineReporter();
    } catch (e) {
      console.warn("[online] 启动失败:", e.message);
    }
  });
  // 后台定时重扫
  const timer = setInterval(() => {
    refreshSnapshot(false).catch((e) => console.error("[rescan]", e.message));
  }, RESCAN_INTERVAL_MS);
  timer.unref?.();
  return server;
}

// 直接运行本文件时启动
if (process.argv[1] && process.argv[1].endsWith("server/index.js")) {
  startServer();
}
