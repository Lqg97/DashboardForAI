// ---------- 工具 ----------
const $ = (id) => document.getElementById(id);
const fmtTokens = (n) => {
  if (n === null || n === undefined) return "-";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
};
const fmtTokensExact = (n) =>
  n === null || n === undefined ? "-" : Number(n).toLocaleString("en-US");
const fmtTokensCN = (n) => {
  if (n === null || n === undefined || n === 0) return "";
  if (n >= 1e8) return "≈ " + (n / 1e8).toFixed(2) + " 亿";
  if (n >= 1e4) return "≈ " + (n / 1e4).toFixed(1) + " 万";
  return "";
};
const fmtTokensShortCN = (n) => {
  if (n === null || n === undefined) return "-";
  if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
  return Number(n).toLocaleString("en-US");
};
const fmtUSD = (n) =>
  n === null || n === undefined ? "-" : "$" + n.toFixed(2);
const fmtUSD0 = (n) =>
  n === null || n === undefined
    ? "-"
    : n >= 100
      ? "$" + n.toFixed(0)
      : "$" + n.toFixed(2);
const fmtMoney = (n, currency = "USD") => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "-";
  const value = Number(n).toFixed(2);
  if (currency === "CNY") return "¥" + value;
  if (currency === "USD") return "$" + value;
  return value + " " + currency;
};
const fmtUSD4 = (n) => {
  if (n === null || n === undefined) return "-";
  if (n === 0) return "$0.00";
  const s = n.toFixed(4);
  return "$" + s;
};
const fmtDT = (t) =>
  t
    ? new Date(t).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// 轻量 DOM 构建助手: 视图用它替代 HTML 字符串拼接。
// 文本子节点一律走 textContent(天然转义, 不产生 XSS 面), 只有 Node 才作为元素插入。
// 用法: h('div', { class: 'x', style: { fontSize: '12px' }, onclick: fn }, '文本', childNode, [a, b])
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = String(v);
      else if (k === "style" && typeof v === "object")
        Object.assign(node.style, v);
      else if (k === "dataset" && typeof v === "object")
        Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function")
        node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, String(v));
    }
  }
  appendNodes(node, children);
  return node;
}

function appendNodes(node, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === "") continue;
    if (Array.isArray(c)) appendNodes(node, c);
    else if (c instanceof Node) node.append(c);
    else node.append(document.createTextNode(String(c)));
  }
}

function countdown(ms) {
  if (ms === null || ms === undefined || !isFinite(ms)) return "-";
  if (ms <= 0) return "已过期";
  const h = Math.floor(ms / 3600000);
  if (h >= 24) return Math.floor(h / 24) + "天" + (h % 24) + "h";
  if (h >= 1) return h + "h" + Math.floor((ms % 3600000) / 60000) + "m";
  return Math.floor(ms / 60000) + "m";
}

// 已校验色板(dataviz dark, 表面 #1a1d27)
const AGENT_COLOR = {
  claude: "#3987e5",
  codex: "#d95926",
  opencode: "#199e70",
  codebuddy: "#c98500",
  pi: "#d55181",
  agy: "#9085e9",
  cursor: "#00c389",
};
const FALLBACK = ["#9085e9", "#e66767", "#199e70", "#c98500"];
const colorFor = (agent, i) =>
  AGENT_COLOR[agent] || FALLBACK[i % FALLBACK.length];
const GRID = { color: "rgba(42,46,63,.6)", drawTicks: false };

// ---------- Chart.js 全局基调 ----------
Chart.defaults.color = "#8b90a0";
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
Chart.defaults.font.size = 12;
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.boxHeight = 10;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.pointStyle = "circle";
Chart.defaults.plugins.tooltip.backgroundColor = "#222636";
Chart.defaults.plugins.tooltip.borderColor = "#3a4058";
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.titleColor = "#e6e8ee";
Chart.defaults.plugins.tooltip.bodyColor = "#c3c8d4";
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 8;
Chart.defaults.plugins.tooltip.boxPadding = 4;

// ---------- 数据层(VIEWS 注册表在 index.html 内联脚本中先于视图文件创建) ----------
let SNAP = null;
let activeName = null;
let HUB_MODE = false; // /api/me 返回 hub 模式 -> 联机 Hub
let ME = null; // 当前访问者身份({user, storage, online...})
let CURRENT_SOURCE = "__local__"; // 默认选择本机
let MACHINES_INFO = null;

// 联机模式探测: /api/me 200=已认定身份; 401=hub 但未带个人链接; 其他错误=单机模式
async function loadMe() {
  try {
    const r = await fetch("/api/me");
    if (r.ok) {
      ME = await r.json();
      HUB_MODE = true;
    } else if (r.status === 401) {
      ME = await r.json();
      HUB_MODE = true;
    } else {
      HUB_MODE = false;
    }
  } catch {
    HUB_MODE = false;
  }
  renderUserBar();
}

function renderUserBar() {
  const bar = $("userBar");
  if (!bar) return;
  // 单机模式无身份概念, 隐藏用户栏
  bar.style.display = HUB_MODE ? "block" : "none";
  const identity = $("userIdentity");
  if (identity) {
    if (ME && ME.user) {
      const tag = ME.admin ? " (管理员·全部用户)" : "";
      identity.textContent = ME.user + tag;
    } else {
      identity.innerHTML =
        '<span style="color:var(--muted);font-weight:400;font-size:11.5px">未认定身份</span>';
    }
  }
  const meta = $("userMeta");
  if (meta) {
    if (ME && ME.user) {
      meta.textContent =
        (ME.online ? "● 客户端在线" : "○ 客户端离线") +
        " · 存储: " +
        (ME.storage || "file");
    } else {
      meta.textContent = "请通过客户端打印的个人看板链接访问";
    }
  }
  const manageBtn = $("manageBtn");
  if (manageBtn)
    manageBtn.style.display =
      !HUB_MODE && CURRENT_SOURCE === "__local__" ? "block" : "none";
}

async function loadMachines() {
  try {
    const r = await fetch("/api/machines");
    if (!r.ok) return;
    MACHINES_INFO = await r.json();
    renderMachineSelect();
  } catch (e) {
    console.warn("[machines] 获取机器列表失败:", e);
  }
}

function renderMachineSelect() {
  const sel = $("sourceSelect");
  const badge = $("sourceBadge");
  if (!sel) return;

  const prevVal = CURRENT_SOURCE;
  sel.innerHTML = "";

  if (HUB_MODE) {
    // Hub 服务端视图: 默认看总计(__all__), 支持切换看各机器
    if (CURRENT_SOURCE === "__local__") CURRENT_SOURCE = "__all__";
    const optAll = document.createElement("option");
    optAll.value = "__all__";
    optAll.textContent = "🌐 总计 (多机汇总)";
    sel.append(optAll);

    const machines =
      MACHINES_INFO && Array.isArray(MACHINES_INFO.machines)
        ? MACHINES_INFO.machines
        : [];
    for (const m of machines) {
      const opt = document.createElement("option");
      opt.value = m.machine;
      const status = m.online ? "● 在线" : "○ 离线";
      const userTag = ME && ME.admin && m.userId ? ` [${m.userId}]` : "";
      opt.textContent = `🖥️ ${m.machine}${userTag} (${status})`;
      sel.append(opt);
    }
  } else {
    // 本机客户端视图: 默认本机(__local__)
    const localName = MACHINES_INFO?.localMachine || "本机";
    const optLocal = document.createElement("option");
    optLocal.value = "__local__";
    optLocal.textContent = `💻 本机 (${localName})`;
    sel.append(optLocal);

    if (MACHINES_INFO && MACHINES_INFO.online) {
      const optAll = document.createElement("option");
      optAll.value = "__all__";
      optAll.textContent = "🌐 总计 (多机汇总)";
      sel.append(optAll);

      const machines = (
        Array.isArray(MACHINES_INFO.machines) ? MACHINES_INFO.machines : []
      ).filter((m) => m && m.machine && m.machine !== localName);
      for (const m of machines) {
        const opt = document.createElement("option");
        opt.value = m.machine;
        const status = m.online ? "● 在线" : "○ 离线";
        opt.textContent = `🖥️ ${m.machine} (${status})`;
        sel.append(opt);
      }
    }
  }

  const hasPrev = Array.from(sel.options).some((o) => o.value === prevVal);
  sel.value = hasPrev ? prevVal : HUB_MODE ? "__all__" : "__local__";
  CURRENT_SOURCE = sel.value;

  if (badge) {
    if (CURRENT_SOURCE === "__local__") {
      badge.textContent = "本机";
      badge.style.background = "rgba(57,135,229,.15)";
      badge.style.color = "#6ea8f0";
    } else if (CURRENT_SOURCE === "__all__") {
      badge.textContent = "总计";
      badge.style.background = "rgba(62,207,142,.15)";
      badge.style.color = "#3ecf8e";
    } else {
      badge.textContent = "远端";
      badge.style.background = "rgba(176,168,245,.15)";
      badge.style.color = "#b0a8f5";
    }
  }

  const manageBtn = $("manageBtn");
  if (manageBtn) {
    manageBtn.style.display =
      !HUB_MODE && CURRENT_SOURCE === "__local__" ? "block" : "none";
  }
}

async function onSourceChange(val) {
  CURRENT_SOURCE = val;
  const badge = $("sourceBadge");
  if (badge) {
    if (CURRENT_SOURCE === "__local__") {
      badge.textContent = "本机";
      badge.style.background = "rgba(57,135,229,.15)";
      badge.style.color = "#6ea8f0";
    } else if (CURRENT_SOURCE === "__all__") {
      badge.textContent = "总计";
      badge.style.background = "rgba(62,207,142,.15)";
      badge.style.color = "#3ecf8e";
    } else {
      badge.textContent = "远端";
      badge.style.background = "rgba(176,168,245,.15)";
      badge.style.color = "#b0a8f5";
    }
  }
  const manageBtn = $("manageBtn");
  if (manageBtn) {
    manageBtn.style.display =
      !HUB_MODE && CURRENT_SOURCE === "__local__" ? "block" : "none";
  }
  await loadSnapshotAndRender();
}

async function loadSnapshotAndRender() {
  try {
    $("generatedAt").textContent = "加载数据中...";
    let url = "/api/agents";
    if (HUB_MODE) {
      url += "?machine=" + encodeURIComponent(CURRENT_SOURCE);
    } else {
      url += "?source=" + encodeURIComponent(CURRENT_SOURCE);
    }
    const r = await fetch(url);
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: "HTTP " + r.status }));
      showToast("加载失败: " + (err.error || r.statusText));
      $("generatedAt").textContent = "加载失败: " + (err.error || r.statusText);
      return;
    }
    SNAP = await r.json();
    renderActive();
    if (SNAP.generatedAt) {
      let text = "数据: " + new Date(SNAP.generatedAt).toLocaleString("zh-CN");
      if (CURRENT_SOURCE === "__local__") {
        text += " · 本机数据";
      } else if (CURRENT_SOURCE === "__all__") {
        text += " · 多机汇总";
      } else {
        text += ` · 机器: ${CURRENT_SOURCE}`;
      }
      if (SNAP.hub && SNAP.hub.storage) text += " · " + SNAP.hub.storage;
      $("generatedAt").textContent = text;
    }
  } catch (e) {
    console.error(e);
    $("generatedAt").textContent = "加载失败: " + e.message;
  }
}

async function loadAll() {
  await loadMe();
  await loadOnlineStatus();
  await loadMachines();
  await loadSnapshotAndRender();
}

async function doRefresh() {
  $("generatedAt").textContent = "刷新中...";
  try {
    if (HUB_MODE) {
      await fetch("/api/refresh", { method: "POST" });
      showToast("已通知客户端重扫上报, 数据到位后自动刷新");
      await loadSnapshotAndRender();
    } else {
      await fetch("/api/refresh?source=" + encodeURIComponent(CURRENT_SOURCE), {
        method: "POST",
      });
      if (CURRENT_SOURCE !== "__local__") {
        showToast("已通知云端重扫并重新加载");
      }
      await loadSnapshotAndRender();
    }
  } catch (e) {
    showToast("刷新失败: " + e.message);
  }
}

function doExport(format) {
  window.open("/api/export?format=" + format);
}

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}

// ---------- 联机上报设置(仅单机模式; Hub 模式下由客户端自行上报) ----------
let ONLINE = null;

async function loadOnlineStatus() {
  try {
    const r = await fetch("/api/online");
    ONLINE = r.ok ? await r.json() : null;
  } catch {
    ONLINE = null;
  }
  renderOnlineBar();
}

function renderOnlineBar() {
  const bar = $("onlineBar");
  if (!bar) return;
  // Hub 模式(正在被浏览器访问远端看板)不展示本机开关; 服务器无该接口(如老版本)也不展示
  if (HUB_MODE || !ONLINE) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "block";
  const st = $("onlineStatus");
  const btn = $("onlineToggleBtn");
  if (!st || !btn) return;
  if (ONLINE.enabled) {
    st.textContent = "";
    const dot = document.createElement("span");
    dot.style.color = "#3ecf8e";
    dot.textContent = "● 已开启";
    st.append(dot);
    if (!ONLINE.running) st.append(document.createTextNode(" · ⚠ 未运行"));
    if (ONLINE.lastReportAt) {
      st.append(
        document.createTextNode(
          " · 上次上报 " +
            new Date(ONLINE.lastReportAt).toLocaleTimeString("zh-CN"),
        ),
      );
    }
    if (ONLINE.lastError) {
      st.append(
        document.createTextNode(
          " · ⚠ " + String(ONLINE.lastError).slice(0, 60),
        ),
      );
    }
    const meta = document.createElement("div");
    meta.style.fontSize = "10px";
    meta.style.color = "var(--muted)";
    meta.style.marginTop = "2px";
    meta.append(document.createTextNode("用户 " + (ONLINE.user || "")));
    if (ONLINE.personalUrl) {
      const link = document.createElement("a");
      link.href = ONLINE.personalUrl;
      link.target = "_blank";
      link.style.color = "#6ea8f0";
      link.textContent = "打开我的看板";
      meta.append(document.createTextNode(" · "), link);
    }
    st.append(meta);
    btn.textContent = "关闭";
    btn.classList.remove("primary");
  } else {
    st.textContent = "未开启 · 本机数据不会上传";
    btn.textContent = "开启";
    btn.classList.add("primary");
  }
}

window.toggleOnline = async () => {
  const target = !(ONLINE && ONLINE.enabled);
  try {
    const r = await fetch("/api/online/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: target }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      showToast("操作失败: " + (j.error || r.status));
      return;
    }
    await loadOnlineStatus();
    if (j.personalUrl) showToast("已开启! 你的看板: " + j.personalUrl);
    else if (target === false) showToast("已关闭, 本机数据不再上传");
  } catch (e) {
    showToast("操作失败: " + e.message);
  }
};

window.openOnlineSettings = () => {
  $("onlineFormErr").textContent = "";
  const f = $("onlineForm").elements;
  $("onlineForm").reset();
  f.hubUrl.value = (ONLINE && ONLINE.hubUrl) || "";
  f.token.value = "";
  f.token.placeholder =
    ONLINE && ONLINE.token ? "已保存(输入新值以更换)" : "未设置";
  f.user.value = (ONLINE && ONLINE.user) || "";
  f.machine.value = (ONLINE && ONLINE.machine) || "";
  f.intervalMs.value = (ONLINE && ONLINE.intervalMs) || 300000;
  $("onlineModal").classList.add("show");
};
function closeOnlineSettings() {
  $("onlineModal").classList.remove("show");
}
window.closeOnlineSettings = closeOnlineSettings;

window.saveOnlineSettings = async () => {
  const f = $("onlineForm").elements;
  const next = {
    online: {
      enabled: true,
      hubUrl: f.hubUrl.value.trim(),
      token: f.token.value, // 空 -> 服务端保留旧值
      tokenCleared: false,
      user: f.user.value.trim(),
      machine: f.machine.value.trim(),
      intervalMs:
        Number(f.intervalMs.value) > 0 ? Number(f.intervalMs.value) : 300000,
    },
  };
  try {
    const r = await fetch("/api/online", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      $("onlineFormErr").textContent = "保存失败: " + (j.error || r.status);
      return;
    }
    closeOnlineSettings();
    await loadOnlineStatus();
    showToast("已保存并启用联机上报" + (j.personalUrl ? "" : ""));
    if (j.personalUrl) showToast("你的看板: " + j.personalUrl);
  } catch (e) {
    $("onlineFormErr").textContent = "保存失败: " + e.message;
  }
};

// ---------- 路由 ----------
function currentView() {
  const h = (location.hash || "").replace(/^#\//, "");
  return VIEWS[h] ? h : "overview";
}

function renderActive() {
  const name = currentView();
  if (activeName && activeName !== name && VIEWS[activeName].unmount) {
    VIEWS[activeName].unmount();
  }
  activeName = name;
  for (const a of document.querySelectorAll("#side-nav a")) {
    a.classList.toggle("active", a.dataset.view === name);
  }
  const view = VIEWS[name];
  $("view-root").innerHTML = "";
  view.render($("view-root"), Date.now());
}

window.addEventListener("hashchange", renderActive);

// ---------- 卡片显隐偏好 ----------
// 存浏览器 localStorage: 单机与联机看板都生效, 不随上报上传, 也不进 config.json。
// 结构: { stats: { <id>: bool }, subs: { <订阅id>: bool } }, 字段缺失即视为显示。
const CARD_PREFS_KEY = "ai-sub-dashboard.cards.v1";
const STAT_META = [
  { id: "subs", label: "生效中订阅/预付" },
  { id: "cost30d", label: "折算总成本(30d)" },{ id: "yearly", label: "生效订阅年花费(已支出)" },
  { id: "users", label: "接入用户(联机汇总视图)" },
  { id: "usage5h", label: "近 5h 工具用量" },
];
let CARD_PREFS = loadCardPrefs();

function loadCardPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(CARD_PREFS_KEY) || "{}") || {};
    return {
      stats: raw.stats && typeof raw.stats === "object" ? raw.stats : {},
      subs: raw.subs && typeof raw.subs === "object" ? raw.subs : {},
    };
  } catch {
    return { stats: {}, subs: {} };
  }
}
function saveCardPrefs() {
  try {
    localStorage.setItem(CARD_PREFS_KEY, JSON.stringify(CARD_PREFS));
  } catch {
    /* 隐私模式忽略 */
  }
}
function isStatVisible(id) {
  return CARD_PREFS.stats[id] !== false;
}
function isSubVisible(id) {
  return CARD_PREFS.subs[id] !== false;
}
function setStatVisible(id, v) {
  CARD_PREFS.stats[id] = !!v;
  saveCardPrefs();
}
function setSubVisible(id, v) {
  CARD_PREFS.subs[id] = !!v;
  saveCardPrefs();
}
window.isStatVisible = isStatVisible;
window.isSubVisible = isSubVisible;

function openCardsModal() {
  renderCardsList();
  $("cardsModal").classList.add("show");
}
function closeCardsModal() {
  $("cardsModal").classList.remove("show");
}
window.openCardsModal = openCardsModal;
window.closeCardsModal = closeCardsModal;

// 用 DOM API 构建(不拼 HTML 字符串, 订阅名/用户名为纯文本渲染)
function cardPrefRow(label, subLabel, checked, onToggle) {
  const row = document.createElement("label");
  row.className = "cardpref-row";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = !!checked;
  box.addEventListener("change", () => onToggle(box.checked));
  const text = document.createElement("span");
  text.textContent = label;
  if (subLabel) {
    const tail = document.createElement("span");
    tail.style.color = "var(--muted)";
    tail.textContent = " \uD83D\uDC64 " + subLabel;
    text.append(tail);
  }
  row.append(box, text);
  return row;
}

function cardPrefSection(title) {
  const h = document.createElement("div");
  h.className = "cardpref-sect";
  h.textContent = title;
  return h;
}

function renderCardsList() {
  const el = $("cardsList");
  if (!el) return;
  el.textContent = "";
  el.append(cardPrefSection("统计块"));
  for (const m of STAT_META) {
    el.append(
      cardPrefRow(m.label, null, isStatVisible(m.id), (v) =>
        setStatFromUi(m.id, v),
      ),
    );
  }
  const subSection = cardPrefSection("订阅卡片");
  subSection.style.marginTop = "14px";
  el.append(subSection);

  const subs = ((SNAP && SNAP.subscriptions) || []).filter(
    (s) => s && !s.isHistorical,
  );
  if (!subs.length) {
    const tip = document.createElement("div");
    tip.className = "csub";
    tip.textContent = "暂无生效中订阅";
    el.append(tip);
    return;
  }
  for (const s of subs) {
    el.append(
      cardPrefRow(s.name, s.user, isSubVisible(s.id), (v) =>
        setSubFromUi(s.id, v),
      ),
    );
  }
  const hiddenCount =
    subs.filter((s) => !isSubVisible(s.id)).length +
    STAT_META.filter((m) => !isStatVisible(m.id)).length;
  if (hiddenCount) {
    const tip = document.createElement("div");
    tip.className = "csub";
    tip.style.marginTop = "12px";
    tip.textContent = "当前已隐藏 " + hiddenCount + " 项。";
    el.append(tip);
  }
}

function setStatFromUi(id, v) {
  setStatVisible(id, v);
  renderActive();
}
function setSubFromUi(id, v) {
  setSubVisible(id, v);
  renderActive();
}
window.setStatFromUi = setStatFromUi;
window.setSubFromUi = setSubFromUi;

// 卡片上的快捷隐藏/恢复
function toggleSubCard(id) {
  const next = !isSubVisible(id);
  setSubVisible(id, next);
  renderActive();
  showToast(next ? "已显示该卡片" : "已隐藏该卡片, 可在「卡片显示」里恢复");
}
window.toggleSubCard = toggleSubCard;

function resetCardPrefs() {
  CARD_PREFS = { stats: {}, subs: {} };
  saveCardPrefs();
  renderCardsList();
  renderActive();
  showToast("已恢复全部卡片显示");
}
window.resetCardPrefs = resetCardPrefs;

// ---------- 订阅表单/管理弹窗 ----------
let CONFIG = null;

function requireLocalMode() {
  if (HUB_MODE) {
    showToast("联机模式: 订阅请在客户端本机管理, 上报后自动同步");
    return true;
  }
  return false;
}

async function loadConfig() {
  const r = await fetch("/api/config");
  CONFIG = await r.json();
}

function openManageModal() {
  if (requireLocalMode()) return;
  loadConfig().then(() => {
    renderManageList();
    $("manageModal").classList.add("show");
  });
}
function closeManageModal() {
  $("manageModal").classList.remove("show");
}

function renderManageList() {
  const el = $("manageList");
  const subs = (CONFIG.subscriptions || []).slice().sort((a, b) => {
    const aHist =
      a.status === "historical" ||
      a.status === "expired" ||
      a.status === "canceled";
    const bHist =
      b.status === "historical" ||
      b.status === "expired" ||
      b.status === "canceled";
    if (aHist !== bHist) return aHist ? 1 : -1;
    return 0;
  });
  el.textContent = "";
  if (!subs.length) {
    const tip = document.createElement("div");
    tip.className = "empty-tip";
    tip.style.padding = "16px";
    tip.textContent = "暂无订阅条目,点击下方按钮新增";
    el.append(tip);
    return;
  }
  for (const s of subs) {
    const isHist =
      s.status === "historical" ||
      s.status === "expired" ||
      s.status === "canceled";
    const rel = s.agentIds && s.agentIds.length ? s.agentIds.join(" / ") : null;
    const row = document.createElement("div");
    row.className = "mrow2";
    if (isHist) {
      row.style.opacity = "0.75";
      row.style.background = "rgba(255,255,255,0.01)";
    }
    const grow = document.createElement("span");
    grow.className = "grow";
    grow.textContent = s.name;
    if (isHist) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.style.fontSize = "10px";
      badge.style.color = "var(--muted)";
      badge.style.padding = "1px 6px";
      badge.textContent = "历史";
      grow.append(badge);
    }
    const mut = document.createElement("span");
    mut.className = "mut";
    mut.textContent =
      " · " +
      (s.plan || "—") +
      (s.priceMonthly ? " · $" + s.priceMonthly + "/月" : "") +
      (s.quotaProvider ? " · 额度: " + s.quotaProvider : "") +
      (rel ? " · 工具: " + rel : "");
    grow.append(mut);

    const editBtn = document.createElement("button");
    editBtn.style.padding = "3px 10px";
    editBtn.style.fontSize = "11.5px";
    editBtn.textContent = "编辑";
    editBtn.addEventListener("click", () => editSub(s.id));
    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.style.padding = "3px 10px";
    delBtn.style.fontSize = "11.5px";
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", () => deleteSub(s.id));

    row.append(grow, editBtn, delBtn);
    el.append(row);
  }
}

// 表单: 新增(sub=null)或编辑(subId)
function openAgentForm() {
  if (requireLocalMode()) return;
  openSubForm(null);
}

function openSubForm(sub) {
  if (requireLocalMode()) return;
  const f = $("subForm").elements;
  $("subFormTitle").textContent = sub ? "编辑订阅 · " + sub.name : "新增订阅";
  $("subFormErr").textContent = "";
  // 工具多选(reset 会清掉动态状态,先 reset 再赋值)
  const agentIds = (sub && sub.agentIds) || [];
  $("subForm").reset();
  const agentBox = document.getElementById("agentChecks");
  agentBox.textContent = "";
  for (const a of SNAP.agents || []) {
    const chip = document.createElement("span");
    chip.className = "chip" + (agentIds.includes(a.agent) ? " on" : "");
    chip.dataset.agent = a.agent;
    chip.textContent = a.name;
    agentBox.append(chip);
  }
  agentBox.onclick = (e) => {
    const c = e.target.closest(".chip");
    if (c) c.classList.toggle("on");
  };
  window.onBillingTypeChange = (type) => {
    const isPre = type === "prepaid";
    const pm = $("priceMonthlyField");
    const bf = $("balanceField");
    const sf = $("startDateField");
    const ef = $("expireAtField");
    const rf = $("autoRenewField");
    if (pm) pm.style.display = isPre ? "none" : "block";
    if (bf) bf.style.display = isPre ? "block" : "none";
    if (sf) sf.style.display = isPre ? "none" : "block";
    if (ef) ef.style.display = isPre ? "none" : "block";
    if (rf) rf.style.display = isPre ? "none" : "block";
    const qf = $("quotaConfigFields");
    if (qf) qf.style.display = isPre ? "none" : "block";
    if (!isPre && window.onQuotaProviderChange)
      window.onQuotaProviderChange(f.quotaProvider.value);
  };
  window.onQuotaProviderChange = (provider) => {
    const team = provider === "zhipu_team";
    const volcengine = provider === "volcengine";
    const customBase =
      !provider ||
      ["zhipu", "zhipu_team", "minimax", "zenmux", "volcengine"].includes(
        provider,
      );
    $("zhipuTeamFields").style.display = team ? "grid" : "none";
    $("volcengineFields").style.display = volcengine ? "grid" : "none";
    $("apiKeyField").style.display = volcengine ? "none" : "block";
    $("quotaBaseUrlField").style.display = customBase ? "block" : "none";
  };

  const bType =
    sub?.billingType ||
    (sub?.plan?.includes("预付费") ? "prepaid" : "subscription");
  f.billingType.value = bType;
  window.onBillingTypeChange(bType);
  f.status.value = sub?.status || (sub?.isHistorical ? "historical" : "active");
  f.name.value = sub ? sub.name : "";
  f.plan.value = sub ? sub.plan || "" : "";
  f.priceMonthly.value =
    sub && sub.priceMonthly !== null && sub.priceMonthly !== undefined
      ? sub.priceMonthly
      : "";
  f.balance.value =
    sub && sub.balance !== null && sub.balance !== undefined ? sub.balance : "";
  f.startDate.value =
    sub && sub.startDate
      ? new Date(sub.startDate).toISOString().slice(0, 10)
      : "";
  f.expireAt.value =
    sub && sub.expireAt
      ? new Date(sub.expireAt).toISOString().slice(0, 10)
      : "";
  f.autoRenew.value = sub
    ? String(!!sub.autoRenew)
    : bType === "prepaid"
      ? "false"
      : "true";
  f.quotaProvider.value = sub ? sub.quotaProvider || "" : "";
  f.quotaBaseUrl.value = sub ? sub.quotaBaseUrl || sub.baseUrl || "" : "";
  f.apiKey.value = sub ? sub.apiKey || "" : "";
  f.teamOrganizationId.value = sub ? sub.teamOrganizationId || "" : "";
  f.teamProjectId.value = sub ? sub.teamProjectId || "" : "";
  f.accessKeyId.value = sub ? sub.accessKeyId || "" : "";
  f.secretAccessKey.value = sub ? sub.secretAccessKey || "" : "";
  window.onQuotaProviderChange(f.quotaProvider.value);
  f.note.value = sub ? sub.note || "" : "";
  $("subForm").dataset.editId = sub ? sub.id : "";
  $("agentFormModal").classList.add("show");
}
function closeAgentForm() {
  $("agentFormModal").classList.remove("show");
}

async function saveSubForm() {
  const form = $("subForm");
  const f = form.elements;
  const name = f.name.value.trim();
  if (!name) {
    $("subFormErr").textContent = "名称必填";
    return false;
  }
  const agentIds = [...form.querySelectorAll("#agentChecks .chip.on")].map(
    (c) => c.dataset.agent,
  );
  const isPrepaid = f.billingType.value === "prepaid";
  const entry = {
    name,
    status: f.status.value || "active",
    billingType: isPrepaid ? "prepaid" : "subscription",
    plan: f.plan.value.trim() || (isPrepaid ? "预付费 / 按量" : null),
    priceMonthly: isPrepaid
      ? null
      : f.priceMonthly.value === ""
        ? null
        : Number(f.priceMonthly.value),
    balance: isPrepaid
      ? f.balance.value === ""
        ? null
        : Number(f.balance.value)
      : null,
    startDate: isPrepaid ? null : f.startDate.value || null,
    expireAt: isPrepaid ? null : f.expireAt.value || null,
    autoRenew: isPrepaid ? false : f.autoRenew.value === "true",
    quotaProvider: isPrepaid ? null : f.quotaProvider.value || null,
    quotaBaseUrl: isPrepaid ? null : f.quotaBaseUrl.value.trim() || null,
    apiKey: isPrepaid ? null : f.apiKey.value.trim() || null,
    teamOrganizationId: isPrepaid
      ? null
      : f.teamOrganizationId.value.trim() || null,
    teamProjectId: isPrepaid ? null : f.teamProjectId.value.trim() || null,
    accessKeyId: isPrepaid ? null : f.accessKeyId.value.trim() || null,
    secretAccessKey: isPrepaid ? null : f.secretAccessKey.value.trim() || null,
    agentIds,
    note: f.note.value.trim() || null,
  };
  await loadConfig();
  const editId = form.dataset.editId;
  if (editId) {
    const idx = CONFIG.subscriptions.findIndex((x) => x.id === editId);
    if (idx >= 0)
      CONFIG.subscriptions[idx] = { ...CONFIG.subscriptions[idx], ...entry };
  } else {
    entry.id = "sub-" + Math.random().toString(16).slice(2, 10);
    CONFIG.subscriptions.push(entry);
  }
  try {
    const r = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CONFIG),
    });
    if (!r.ok) {
      $("subFormErr").textContent =
        "保存失败: " + (await r.text()).slice(0, 160);
      return false;
    }
  } catch (e) {
    $("subFormErr").textContent = "保存失败: " + e.message;
    return false;
  }
  closeAgentForm();
  closeManageModal();
  showToast("已保存,刷新中...");
  await doRefresh();
  return true;
}

async function deleteSub(subId) {
  if (requireLocalMode()) return;
  if (!confirm("删除该订阅条目?")) return;
  await loadConfig();
  CONFIG.subscriptions = CONFIG.subscriptions.filter((x) => x.id !== subId);
  try {
    const r = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CONFIG),
    });
    if (!r.ok) {
      showToast("删除失败: " + (await r.text()).slice(0, 120));
      return;
    }
  } catch (e) {
    showToast("删除失败: " + e.message);
    return;
  }
  closeManageModal();
  showToast("已删除,刷新中...");
  await doRefresh();
}

(async function init() {
  await loadAll();
  setInterval(() => loadAll(), 60000);
})();

async function editSub(subId) {
  if (requireLocalMode()) return;
  await loadConfig();
  const sub = (CONFIG.subscriptions || []).find((x) => x.id === subId);
  if (!sub) {
    showToast("订阅不存在: " + subId);
    return;
  }
  openSubForm(sub, null);
}

// ---------- 跨文件全局契约 ----------
// 下面这些是本文件提供给 public/views/*.js 与 index.html 内联 onclick 的入口。
// views 通过独立 <script> 加载、共享全局作用域,单文件静态检查看不到它们的引用,
// 这里显式导出:既固化契约,也避免被误判为未使用。
Object.assign(window, {
  // 格式化工具(被 views 大量复用)
  fmtTokens,
  fmtTokensExact,
  fmtTokensCN,
  fmtTokensShortCN,
  fmtUSD,
  fmtUSD0,
  fmtUSD4,
  fmtMoney,
  fmtDT,
  esc,
  colorFor,
  countdown,
  GRID,
  h,
  // index.html 内联 handler
  onSourceChange,
  doExport,
  openManageModal,
  closeManageModal,
  openAgentForm,
  saveSubForm,
  editSub,
  deleteSub,
  openSubForm,
});
