// 联机 Hub 服务器: 汇总多个客户端上报的快照, 按用户区分, 对外提供合并视图
// 启动: npm run hub  (HUB_PORT 默认 4780, 绑定 0.0.0.0)
// 存储: MYSQL_HOST 配置时用 MySQL(容器), 未配置或连接失败用文件存储 DATA_DIR/users/
// 身份: 每个用户通过个人链接(?user=<userId>[&token=])认定身份(Cookie 持久化),
//       之后所有数据接口只返回该用户自己的数据; ?admin=<HUB_ADMIN_TOKEN> 管理员可看全部。
// API:
//   POST /api/report          — 客户端上报 {userId, machine, token?, snapshot}
//   GET  /api/me              — 当前访问者身份与上报状态
//   GET  /api/agents          — 当前用户快照(必须已认定身份; 管理员=合并全部)
//   POST /api/refresh         — 给当前用户下发刷新指令
//   GET  /api/kick?user=&since= — 客户端轮询刷新指令
//   GET  /api/history?user=   — 上报历史(MySQL 存储时可用)
//   GET  /api/export?format=  — 导出当前用户数据(管理员=全部)
//   GET  /api/users           — 用户列表(仅管理员)
//   POST /api/users/delete    — 删除某用户全部数据(仅管理员)
//   GET  /                    — 看板静态页面(与单机共用 public/)

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PORT as DEFAULT_PORT } from "./config.js";
import { createFileStorage, validateReport, safeUserId } from "./hub-store.js";
import { createDbStorage, dbConfigFromEnv } from "./hub-db.js";
import { resolveViewer, viewerCookieHeader } from "./hub-identity.js";
import { mergeSnapshots } from "./hub-merge.js";
const HUB_PORT = Number(process.env.HUB_PORT || DEFAULT_PORT);
const HUB_HOST = process.env.HUB_HOST || "0.0.0.0";
const HUB_TOKEN = process.env.HUB_TOKEN || "";
const HUB_ADMIN_TOKEN = process.env.HUB_ADMIN_TOKEN || "";
const ONLINE_WINDOW_MS = Number(
  process.env.HUB_ONLINE_WINDOW_MS || 10 * 60 * 1000,
);

const HUB_PUBLIC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// 刷新指令队列: userId -> 下发时间戳; 客户端以 since 参数领取
const refreshRequests = new Map();

// 存储选择: 配置了 MYSQL_HOST 用 MySQL; 初始化失败自动降级文件存储
let storage = null;
let storageType = "file";
async function initStorage() {
  if (process.env.MYSQL_HOST) {
    try {
      const db = createDbStorage(dbConfigFromEnv());
      await db.init();
      storage = db;
      storageType = "mysql";
      return;
    } catch (e) {
      console.error("[hub] MySQL 初始化失败, 降级文件存储:", e.message);
    }
  }
  storage = createFileStorage();
  storageType = "file";
  await storage.init();
}

function sendJson(res, status, obj, extraHeaders) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...(extraHeaders || {}),
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 32 * 1024 * 1024) {
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

// ---------- 静态文件(首次通过个人链接打开时下发身份 Cookie) ----------
function serveStatic(req, res, urlObj, cookieHeader) {
  let p = decodeURIComponent(urlObj.pathname);
  if (p === "/") p = "/index.html";
  const file = join(HUB_PUBLIC_DIR, p);
  if (!file.startsWith(HUB_PUBLIC_DIR)) {
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
  const headers = {
    "Content-Type": MIME[extname(file)] || "application/octet-stream",
  };
  if (cookieHeader) headers["Set-Cookie"] = cookieHeader;
  res.writeHead(200, headers);
  res.end(body);
}

// ---------- export CSV ----------
function toCsv(snapshotObj) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [
    [
      "user",
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
        s.user || "",
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

function userSummary(reports) {
  const now = Date.now();
  return reports.map((r) => {
    const snap = r.snapshot || {};
    return {
      userId: r.userId,
      machine: r.machine,
      lastReportAt: r.lastReportAt,
      generatedAt: snap.generatedAt || null,
      online: now - r.lastReportAt < ONLINE_WINDOW_MS,
      subscriptions: (snap.subscriptions || []).length,
      activeSubscriptions: (snap.subscriptions || []).filter(
        (s) => s && !s.isHistorical,
      ).length,
      cost30d: snap.global?.cost30d ?? null,
      tokens30d: snap.global?.tokens30d ?? null,
    };
  });
}

// 当前请求的访问者: {viewer, cookieHeader}
function viewerOf(req, urlObj) {
  const v = resolveViewer(req, urlObj, {
    token: HUB_TOKEN || "",
    adminToken: HUB_ADMIN_TOKEN || "",
  });
  return {
    viewer: v,
    cookieHeader: v.setCookie ? viewerCookieHeader(v.user) : null,
  };
}

// ---------- 路由 ----------
async function route(req, res) {
  const urlObj = new URL(req.url, "http://hub");
  const { pathname } = urlObj;
  const { viewer, cookieHeader } = viewerOf(req, urlObj);
  // 身份认定成功时, 所有响应(页面/API)统一下发 HttpOnly Cookie
  const cookieHeaders = cookieHeader ? { "Set-Cookie": cookieHeader } : {};

  if (
    (req.method === "GET" || req.method === "HEAD") &&
    !pathname.startsWith("/api")
  ) {
    return serveStatic(req, res, urlObj, cookieHeader);
  }

  // 客户端上报(与浏览器身份无关)
  if (req.method === "POST" && pathname === "/api/report") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    }
    if (HUB_TOKEN && body.token !== HUB_TOKEN) {
      return sendJson(res, 401, { ok: false, error: "invalid token" });
    }
    const errors = validateReport(body);
    if (errors.length)
      return sendJson(res, 400, { ok: false, error: errors.join("; ") });
    try {
      await storage.saveReport({
        userId: body.userId,
        machine: body.machine || null,
        lastReportAt: Date.now(),
        clientVersion: body.clientVersion || null,
        snapshot: body.snapshot,
      });
      return sendJson(res, 200, { ok: true, storage: storageType });
    } catch (e) {
      console.error("[hub] 保存上报失败:", e.message);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 当前访问者身份与上报状态
  if (req.method === "GET" && pathname === "/api/me") {
    if (!viewer.user)
      return sendJson(
        res,
        401,
        {
          mode: "hub",
          user: null,
          reason: viewer.reason || "NO_IDENTITY",
          message: "请使用客户端打印的个人看板链接访问",
        },
        cookieHeaders,
      );
    const reports = viewer.admin
      ? await storage.listReports()
      : await storage.listReports(viewer.user);
    const now = Date.now();
    const machines = reports.map((r) => ({
      machine: r.machine || "default",
      userId: r.userId,
      lastReportAt: r.lastReportAt || 0,
      online: now - (r.lastReportAt || 0) < ONLINE_WINDOW_MS,
      cost30d: r.snapshot?.global?.cost30d ?? 0,
      tokens30d: r.snapshot?.global?.tokens30d ?? 0,
    }));
    const latestReport = reports[0] || null;
    const snap = latestReport && latestReport.snapshot;
    return sendJson(
      res,
      200,
      {
        mode: "hub",
        user: viewer.user,
        admin: !!viewer.admin,
        storage: storageType,
        machine: latestReport ? latestReport.machine : null,
        lastReportAt: latestReport ? latestReport.lastReportAt : null,
        generatedAt: snap ? snap.generatedAt : null,
        online: latestReport
          ? now - latestReport.lastReportAt < ONLINE_WINDOW_MS
          : false,
        subscriptions: snap ? (snap.subscriptions || []).length : 0,
        activeSubscriptions: snap
          ? (snap.subscriptions || []).filter((s) => s && !s.isHistorical)
              .length
          : 0,
        cost30d: snap ? (snap.global?.cost30d ?? null) : null,
        tokens30d: snap ? (snap.global?.tokens30d ?? null) : null,
        machines,
      },
      cookieHeaders,
    );
  }

  // 机器列表(供客户端或前端下拉切换查看)
  if (req.method === "GET" && pathname === "/api/machines") {
    if (!viewer.user)
      return sendJson(
        res,
        401,
        { ok: false, error: "unauthorized" },
        cookieHeaders,
      );
    let reports = viewer.admin
      ? await storage.listReports()
      : await storage.listReports(viewer.user);
    const now = Date.now();
    const machines = reports.map((r) => ({
      machine: r.machine || "default",
      userId: r.userId,
      lastReportAt: r.lastReportAt || 0,
      online: now - (r.lastReportAt || 0) < ONLINE_WINDOW_MS,
      clientVersion: r.clientVersion || null,
      cost30d: r.snapshot?.global?.cost30d ?? 0,
      tokens30d: r.snapshot?.global?.tokens30d ?? 0,
      subscriptions: (r.snapshot?.subscriptions || []).length,
    }));
    return sendJson(
      res,
      200,
      { ok: true, user: viewer.user, admin: !!viewer.admin, machines },
      cookieHeaders,
    );
  }

  // 快照: 普通用户=多机合并/指定机器; 管理员=全部用户多机合并/指定机器
  if (req.method === "GET" && pathname === "/api/agents") {
    if (!viewer.user) {
      return sendJson(
        res,
        401,
        {
          generatedAt: Date.now(),
          agents: [],
          subscriptions: [],
          billing: { woa: null },
          global: {
            cost30d: 0,
            tokens30d: 0,
            distribution: null,
            heatmap: null,
            analytics: null,
          },
          unpricedModels: [],
          hub: { mode: "hub", user: null, storage: storageType },
          empty: true,
          message: "请使用客户端打印的个人看板链接访问",
        },
        cookieHeaders,
      );
    }
    const reqMachine = urlObj.searchParams.get("machine");
    let reports = viewer.admin
      ? await storage.listReports()
      : await storage.listReports(viewer.user);

    // 机器筛选: 指定机器 vs 全部总计
    if (reqMachine && reqMachine !== "__all__") {
      reports = reports.filter((r) => (r.machine || "default") === reqMachine);
    }

    if (!reports.length) {
      return sendJson(
        res,
        200,
        {
          generatedAt: Date.now(),
          agents: [],
          subscriptions: [],
          billing: { woa: null },
          global: {
            cost30d: 0,
            tokens30d: 0,
            distribution: null,
            heatmap: null,
            analytics: null,
          },
          unpricedModels: [],
          hub: {
            mode: "hub",
            user: viewer.user,
            machine: reqMachine || null,
            storage: storageType,
            machines: [],
          },
          empty: true,
          message: reqMachine
            ? `机器 ${reqMachine} 暂无上报数据`
            : "尚未收到该用户的客户端上报, 请在本地运行 npm run client",
        },
        cookieHeaders,
      );
    }

    const merged = mergeSnapshots(reports, Date.now(), {
      storage: storageType,
      user: viewer.admin ? "__all__" : viewer.user,
    });
    return sendJson(res, 200, merged, cookieHeaders);
  }

  // 下发刷新指令(作用于当前访问者; 管理员可指定 user)
  if (req.method === "POST" && pathname === "/api/refresh") {
    if (!viewer.user)
      return sendJson(
        res,
        401,
        { ok: false, error: "NO_IDENTITY" },
        cookieHeaders,
      );
    let target = viewer.user;
    const qUser = urlObj.searchParams.get("user");
    if (qUser) {
      if (!viewer.admin && qUser !== viewer.user)
        return sendJson(res, 403, { ok: false, error: "forbidden" });
      target = qUser;
    }
    if (target !== "__all__" && !(await storage.loadReport(target))) {
      return sendJson(res, 404, { ok: false, error: "user not found" });
    }
    refreshRequests.set(target, Date.now());
    return sendJson(res, 200, {
      ok: true,
      target,
      note: "已下发, 等待客户端下次轮询(默认<=15s)",
    });
  }

  // 客户端领取刷新指令
  if (req.method === "GET" && pathname === "/api/kick") {
    const user = urlObj.searchParams.get("user") || "";
    const since = Number(urlObj.searchParams.get("since") || 0);
    const specific = refreshRequests.get(user);
    const broadcast = refreshRequests.get("__all__");
    const hit =
      (specific && specific > since) || (broadcast && broadcast > since);
    return sendJson(res, 200, { refresh: !!hit });
  }

  // 上报历史(仅 MySQL 存储可用; 只能看自己)
  if (req.method === "GET" && pathname === "/api/history") {
    if (!viewer.user || viewer.admin)
      return sendJson(res, 403, { error: "forbidden" });
    if (!storage.history)
      return sendJson(res, 404, { error: "当前存储不支持历史" });
    const rows = await storage.history(viewer.user);
    return sendJson(res, 200, {
      user: viewer.user,
      count: rows.length,
      reports: rows,
    });
  }

  // 导出(普通用户=自己; 管理员=全部)
  if (req.method === "GET" && pathname === "/api/export") {
    if (!viewer.user)
      return sendJson(res, 401, { error: "NO_IDENTITY" }, cookieHeaders);
    const format = (urlObj.searchParams.get("format") || "json").toLowerCase();
    let snap;
    if (viewer.admin) {
      snap = mergeSnapshots(await storage.listReports());
    } else {
      const report = await storage.loadReport(viewer.user);
      if (!report) return sendJson(res, 404, { error: "no data" });
      snap = mergeSnapshots([report]);
    }
    if (!snap) return sendJson(res, 404, { error: "no data" }, cookieHeaders);
    if (format === "csv") {
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="ai-sub-hub-export.csv"',
        ...cookieHeaders,
      });
      return res.end(toCsv(snap));
    }
    return sendJson(res, 200, snap, cookieHeaders);
  }

  // 用户列表(仅管理员)
  if (req.method === "GET" && pathname === "/api/users") {
    if (!viewer.admin)
      return sendJson(res, 403, {
        error: "forbidden: 管理员视图需 ?admin=<HUB_ADMIN_TOKEN>",
      });
    const reports = await storage.listReports();
    return sendJson(res, 200, {
      mode: "hub",
      storage: storageType,
      onlineWindowMs: ONLINE_WINDOW_MS,
      hubUrl: process.env.HUB_PUBLIC_URL || "",
      users: userSummary(reports),
    });
  }

  // 删除某用户的全部数据(仅管理员)
  if (req.method === "POST" && pathname === "/api/users/delete") {
    if (!viewer.admin)
      return sendJson(res, 403, {
        ok: false,
        error: "forbidden: 管理员视图需 ?admin=<HUB_ADMIN_TOKEN>",
      });
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      /* ignore */
    }
    const userId = urlObj.searchParams.get("user") || body.userId;
    if (!userId || !safeUserId(userId))
      return sendJson(res, 400, { ok: false, error: "userId 必填" });
    const ok = await storage.deleteReport(userId);
    refreshRequests.delete(userId);
    return sendJson(res, 200, { ok, deleted: userId });
  }

  // 保留本地采集接口形状以便前端探测模式: hub 下不可用
  if (pathname === "/api/config" || pathname === "/api/pricing") {
    return sendJson(res, 405, {
      error: "hub 模式不支持本机配置; 订阅请在各客户端本机管理",
    });
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

export async function startHub() {
  await initStorage();
  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error("[hub-http]", e);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
  });
  server.listen(HUB_PORT, HUB_HOST, () => {
    console.log(
      `[hub] ai-sub-dashboard hub listening on http://${HUB_HOST}:${HUB_PORT} (storage: ${storageType})`,
    );
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE")
      console.warn(`[hub] 端口 ${HUB_PORT} 已被占用`);
    else console.error("[hub] 服务异常:", err);
  });
  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server/hub.js")) {
  startHub();
}
