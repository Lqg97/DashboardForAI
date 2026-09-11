// 总览: 统计块 + 生效中订阅卡片(含 5h 与周额度)
// 全部用 DOM 构建(h() 见 app.js), 不拼 HTML 字符串: 文本走 textContent, 天然转义。

VIEWS.overview = {
  render(root, now) {
    const subs = SNAP.subscriptions || [];
    const agents = SNAP.agents || [];
    const activeSubs = subs.filter((s) => !s.isHistorical);
    const paid = activeSubs.filter(
      (s) => (s.priceMonthly || 0) > 0 || (s.finance?.yearlyCost || 0) > 0,
    );
    const yearly = paid.reduce((s, x) => s + (x.finance?.yearlyCost || 0), 0);
    const tok5hTotal = agents.reduce(
      (s, a) => s + (a.usage.last5h.tokens || 0),
      0,
    );
    const cost5h = agents.reduce((s, a) => s + (a.usage.last5h.c || 0), 0);
    const max5h = Math.max(...agents.map((a) => a.usage.last5h.tokens || 0), 0);

    const miniRows = agents.map((a) => {
      const t = a.usage.last5h.tokens || 0;
      const w = max5h ? Math.max(2, (t / max5h) * 100) : 0;
      const showUsers = !!(a.users && SNAP.hub && SNAP.hub.user === "__all__");
      return h(
        "div",
        { class: "mrow" },
        h(
          "span",
          { class: "mname" },
          a.name,
          showUsers
            ? h(
                "span",
                { style: { fontSize: "10px", color: "var(--muted)" } },
                " (" + a.users.map((u) => u.user).join("/") + ")",
              )
            : null,
        ),
        h(
          "span",
          { class: "mtrack" },
          h("span", {
            class: "mfill",
            style: {
              width: w.toFixed(1) + "%",
              background: colorFor(a.agent, 0),
            },
          }),
        ),
        h("span", { class: "mval" }, t ? fmtTokens(t) : "—"),
      );
    });

    const isRemoteView =
      (typeof HUB_MODE !== "undefined" && HUB_MODE) ||
      (typeof CURRENT_SOURCE !== "undefined" && CURRENT_SOURCE !== "__local__");

    // 卡片显隐: 偏好来自 app.js 的 localStorage(默认全部显示)
    const statBlocks = [
      {
        id: "subs",
        node: statBlock(
          "生效中订阅/预付",
          [
            String(activeSubs.length) + " ",
            h(
              "span",
              {
                style: {
                  fontSize: "12.5px",
                  color: "var(--muted)",
                  fontWeight: "400",
                },
              },
              "个",
            ),
          ],
          "当前生效订阅与预付费项目",
        ),
      },
      {
        id: "cost30d",
        node: statBlock(
          "折算总成本(30d)",
          fmtUSD0(SNAP.global.cost30d),
          "按官方 API 单价折算",
          "green",
        ),
      },
      {
        id: "yearly",
        node: statBlock(
          "生效订阅年花费 (已支出)",
          fmtUSD0(yearly),
          "生效订阅自开始时间起累计已付",
        ),
      },
      { id: "users", node: hubUsersStat() },
      {
        id: "usage5h",
        node: statBlock(
          "近 5h 工具用量",
          [
            fmtTokens(tok5hTotal) + " ",
            h(
              "span",
              {
                style: {
                  fontSize: "13px",
                  color: "var(--muted)",
                  fontWeight: "400",
                },
              },
              "· " + fmtUSD0(cost5h),
            ),
          ],
          h("div", { class: "mini5h" }, miniRows),
        ),
      },
    ].filter((b) => b.node && isStatVisible(b.id));

    const visibleSubs = activeSubs.filter((s) => isSubVisible(s.id));
    const countText =
      visibleSubs.length === activeSubs.length
        ? String(activeSubs.length)
        : visibleSubs.length + " / " + activeSubs.length;

    let cardsNode;
    if (!activeSubs.length) {
      cardsNode = h(
        "div",
        { class: "empty-tip" },
        "暂无生效中订阅条目。去右上角「管理订阅」添加。",
      );
    } else if (visibleSubs.length) {
      cardsNode = h(
        "div",
        { class: "cards" },
        visibleSubs.map((s) => subCard(s, now)),
      );
    } else {
      cardsNode = h(
        "div",
        { class: "empty-tip" },
        "订阅卡片已全部隐藏,点右上角「卡片显示」恢复。",
      );
    }

    root.textContent = "";
    root.append(
      h(
        "div",
        { class: "view-head" },
        h(
          "h2",
          {},
          "总览",
          h("span", { class: "hint" }, "当前生效中订阅及 5h / 周额度与用量"),
        ),
        h("button", { onclick: () => openCardsModal() }, "卡片显示"),
        isRemoteView
          ? null
          : h("button", { onclick: () => openManageModal() }, "管理订阅"),
      ),
      attributionNotice(),
      h(
        "div",
        { class: "stats" },
        statBlocks.map((b) => b.node),
      ),
      h("h3", { class: "sect" }, "当前生效订阅与额度 (" + countText + ")"),
      cardsNode,
    );
  },
};

// 统计块: tail 为字符串时渲染成 .foot, 为节点时原样插入(如 .mini5h)
// 订阅归属提示: 仅在存在未匹配用量或归属冲突时显示, 避免无事时也占版面
function attributionNotice() {
  const a = SNAP && SNAP.attribution;
  if (!a) return null;
  const unmatched = (a.stats && a.stats.unmatched) || 0;
  const conflicts = a.conflicts || [];
  if (!unmatched && !conflicts.length) return null;

  const nameOf = (id) => {
    const sub = (SNAP.subscriptions || []).find((x) => x.id === id);
    return sub ? sub.name : id;
  };
  const rows = [];
  if (unmatched) {
    rows.push(
      h(
        "div",
        {},
        "有 " +
          unmatched +
          " 条用量没有订阅认领(落在套餐空档期或订阅开始之前), 不计入任何订阅成本。",
      ),
    );
  }
  for (const c of conflicts) {
    const kindText =
      c.kind === "identical" ? "认领范围完全重叠" : "认领范围可能重叠";
    rows.push(
      h(
        "div",
        {},
        "⚠ " +
          c.tool +
          " 有两个订阅" +
          kindText +
          ": " +
          c.subscriptionIds.map(nameOf).join(" / ") +
          ",当前用量记在「" +
          nameOf(c.winnerSubscriptionId) +
          "」。建议给它们补上不同的模型或项目过滤条件。",
      ),
    );
  }
  return h("div", { class: "attr-note" }, rows);
}

function statBlock(label, valueChildren, tail, extraClass) {
  let tailNode = null;
  if (typeof tail === "string") {
    if (tail !== "") tailNode = h("div", { class: "foot" }, tail);
  } else if (tail) {
    tailNode = tail;
  }
  return h(
    "div",
    { class: "stat" },
    h("div", { class: "label" }, label),
    h(
      "div",
      { class: "value" + (extraClass ? " " + extraClass : "") },
      valueChildren,
    ),
    tailNode,
  );
}

// 联机模式: 在线用户统计块(全部用户视图)
function hubUsersStat() {
  if (!SNAP.hub || SNAP.hub.user !== "__all__" || !SNAP.hub.users) return null;
  const total = SNAP.hub.users.length;
  const online = SNAP.hub.users.filter((u) => u.online !== false).length;
  const top = SNAP.hub.users
    .slice(0, 3)
    .map((u) => u.userId)
    .join(" / ");
  const all = SNAP.hub.users.map((u) => u.userId).join(", ");
  return h(
    "div",
    { class: "stat" },
    h("div", { class: "label" }, "接入用户"),
    h(
      "div",
      { class: "value" },
      String(online) + " ",
      h(
        "span",
        {
          style: {
            fontSize: "12.5px",
            color: "var(--muted)",
            fontWeight: "400",
          },
        },
        "/ " + total + " 人",
      ),
    ),
    h("div", { class: "foot", title: all }, top + (total > 3 ? " ..." : "")),
  );
}

function subCard(s, now) {
  const isPrepaid =
    s.billingType === "prepaid" || (s.plan && s.plan.includes("预付费"));
  const badges = [];
  if (s.user) {
    badges.push(
      h(
        "span",
        {
          class: "badge",
          style: {
            background: "rgba(144,133,233,.15)",
            color: "#b0a8f5",
            borderColor: "rgba(144,133,233,.3)",
          },
        },
        "👤 " + s.user,
      ),
    );
  }
  if (isPrepaid) {
    badges.push(
      h(
        "span",
        {
          class: "badge",
          style: {
            background: "rgba(87,199,255,.15)",
            color: "#57c7ff",
            borderColor: "rgba(87,199,255,.3)",
          },
        },
        "预付费",
      ),
    );
  }
  if (s.agentIds && s.agentIds.length) {
    badges.push(h("span", { class: "badge" }, s.agentIds.join(" / ")));
  }
  if (s.quota && s.quota.source) {
    const srcMap = {
      official: "官方数据",
      api: "官方接口",
      estimate: "本地推算",
      manual: "手动配置",
    };
    const srcText = s.quota.mixed
      ? "混合来源"
      : srcMap[s.quota.source] || s.quota.source;
    badges.push(h("span", { class: "badge src-" + s.quota.source }, srcText));
    if (s.quota.provider) {
      const providerText = s.quota.planLabel
        ? s.quota.provider + " · " + s.quota.planLabel
        : s.quota.provider;
      badges.push(h("span", { class: "badge" }, providerText));
    }
    if (s.quota.stale)
      badges.push(h("span", { class: "badge warn" }, "额度缓存"));
  }
  if (s.expireAt) {
    const days = (s.expireAt - now) / 86400000;
    if (days <= 7 && days > 0) {
      badges.push(
        h(
          "span",
          { class: "badge warn" },
          countdown(s.expireAt - now) + "后到期",
        ),
      );
    }
  }
  const dm = s.insights.dormant;
  if (dm && dm.dormant) {
    badges.push(
      h(
        "span",
        { class: "badge dormant" },
        "沉睡 " + dm.daysSinceActive.toFixed(0) + " 天",
      ),
    );
  }
  const roi = s.insights.roiMonthly;

  let detail = null;
  if (s.agentUsage && s.agentUsage.length > 1) {
    detail = h(
      "table",
      { style: { marginTop: "10px", fontSize: "11.5px" } },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { style: { textAlign: "left" } }, "关联工具"),
          h("th", {}, "tokens"),
          h("th", {}, "成本"),
        ),
      ),
      h(
        "tbody",
        {},
        s.agentUsage.map((a) =>
          h(
            "tr",
            {},
            h("td", { style: { textAlign: "left" } }, a.agent),
            h("td", {}, fmtTokens(a.tokens30d)),
            h("td", {}, fmtUSD(a.cost30d)),
          ),
        ),
      ),
    );
  }

  let cursorModelBox = null;
  if (s.quota?.month?.thirdParty) {
    const tp = s.quota.month.thirdParty;
    const nat = s.quota.month.native;
    cursorModelBox = h(
      "div",
      {
        style: {
          marginTop: "10px",
          padding: "8px 10px",
          background: "rgba(255,255,255,0.025)",
          border: "1px solid var(--border)",
          borderRadius: "6px",
          fontSize: "11.5px",
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "3px",
          },
        },
        h(
          "span",
          { style: { color: "var(--text1)", fontWeight: "600" } },
          "🤖 第三方高级模型",
        ),
        h(
          "span",
          { style: { color: "#57c7ff", fontWeight: "600" } },
          tp.requests + " 次 · " + fmtTokens(tp.tokens),
        ),
      ),
      h(
        "div",
        {
          style: {
            fontSize: "10.5px",
            color: "var(--muted)",
            marginBottom: "6px",
            lineHeight: "1.4",
          },
        },
        tp.models.length ? tp.models.join(", ") : "暂无",
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "1px dashed var(--border)",
            paddingTop: "5px",
          },
        },
        h(
          "span",
          { style: { color: "var(--text1)", fontWeight: "600" } },
          "⚡ 自有模型",
        ),
        h(
          "span",
          { style: { color: "#52c41a" } },
          (nat.models.join(", ") || "cursor-small") +
            " · " +
            fmtTokens(nat.tokens),
        ),
      ),
    );
  }

  const planText =
    (s.plan || (isPrepaid ? "预付费 / 按量" : "—")) +
    (!isPrepaid && s.priceMonthly ? " · $" + s.priceMonthly + "/月" : "") +
    (isPrepaid && s.balance !== null && s.balance !== undefined
      ? " · 余额 $" + s.balance
      : "");

  const smallMuted = { fontSize: "11px", color: "var(--muted)" };
  const row30d = h(
    "div",
    { class: "srow" },
    h("span", { class: "k" }, "30d API 折算"),
    h(
      "span",
      { class: "v" },
      fmtTokens(s.usage.tokens30d) + " · " + fmtUSD(s.usage.cost30d),
      s.usage?.windowDays && s.usage.windowDays < 30
        ? h("span", { style: smallMuted }, " (" + s.usage.windowDays + "天)")
        : null,
    ),
  );

  const yearlyVal =
    s.finance?.yearlyCost !== null && s.finance?.yearlyCost !== undefined
      ? fmtUSD(s.finance.yearlyCost)
      : "—";
  const yearTail = s.startDate
    ? h(
        "span",
        { style: smallMuted },
        " (" +
          s.startDate.slice(0, 10) +
          " 起 " +
          (s.finance?.monthsSinceStart || 0) +
          "个月)",
      )
    : isPrepaid
      ? h("span", { style: smallMuted }, " (预付/余额)")
      : null;
  const rowYear = h(
    "div",
    { class: "srow" },
    h("span", { class: "k" }, "年花费(已付)"),
    h("span", { class: "v" }, yearlyVal, yearTail),
  );

  const rowRoi = h(
    "div",
    { class: "srow" },
    h("span", { class: "k" }, "ROI(月)"),
    h(
      "span",
      { class: "v" },
      isPrepaid
        ? h("span", { style: { color: "var(--muted)" } }, "按量实销")
        : roi
          ? roi.ratio.toFixed(1) + "x"
          : "—",
    ),
  );

  const rowActive = h(
    "div",
    { class: "srow" },
    h("span", { class: "k" }, "最近活跃"),
    h(
      "span",
      { class: "v" },
      s.usage.lastActiveAt ? fmtDT(s.usage.lastActiveAt) : "—",
    ),
  );

  const btnStyle = { padding: "3px 12px", fontSize: "11.5px" };

  return h(
    "div",
    { class: "card" + (dm && dm.dormant ? " dormant" : "") },
    h(
      "div",
      { class: "card-header" },
      h(
        "div",
        {},
        h("div", { class: "name" }, s.name),
        h("div", { class: "plan" }, planText),
      ),
      h("div", { class: "badges" }, badges),
    ),
    quotaRow(s.quota, "fiveHour", now),
    quotaRow(s.quota, "week", now),
    quotaRow(s.quota, "month", now),
    cursorModelBox,
    h("div", { class: "stat-rows" }, row30d, rowYear, rowRoi, rowActive),
    detail,
    h(
      "div",
      { style: { marginTop: "12px", display: "flex", gap: "8px" } },
      h("button", { style: btnStyle, onclick: () => editSub(s.id) }, "编辑"),
      h(
        "button",
        { style: btnStyle, onclick: () => toggleSubCard(s.id) },
        "隐藏",
      ),
    ),
  );
}

function quotaRow(q, kind, now) {
  let label = "额度";
  if (kind === "fiveHour") label = "5h 额度";
  else if (kind === "week") label = "周额度";
  else if (kind === "month")
    label = q && q.month && q.month.thirdParty ? "月额度 (高级模型)" : "月额度";

  if (!q || !q[kind]) return null;
  const w = q[kind];
  const hasPct = w.usedPct !== null && w.usedPct !== undefined;
  const width = hasPct ? Math.min(100, Math.max(1, w.usedPct)) : 0;
  let cls = "";
  if (hasPct && w.usedPct >= 90) cls = "crit";
  else if (hasPct && w.usedPct >= 70) cls = "high";

  let vText;
  if (w.limit && w.requests !== undefined) {
    vText = w.requests + " / " + w.limit + " 次 (" + (w.usedPct ?? 0) + "%)";
  } else if (w.limit && w.tokens !== undefined && hasPct) {
    vText =
      fmtTokens(w.tokens) +
      " / " +
      fmtTokens(w.limit) +
      " (" +
      w.usedPct.toFixed(0) +
      "%)";
  } else if (hasPct) {
    vText = w.usedPct.toFixed(0) + "%";
  } else {
    vText = "用量 " + fmtTokens(w.tokens || 0);
  }

  return h(
    "div",
    { class: "qrow" },
    h(
      "div",
      { class: "qhead" },
      h("span", { class: "k" }, label),
      h("span", { class: "v" }, vText),
    ),
    h(
      "div",
      { class: "qbar" },
      h("div", { class: "fill " + cls, style: { width: width + "%" } }),
    ),
    w.resetAt
      ? h("div", { class: "qreset" }, "重置 " + countdown(w.resetAt - now))
      : null,
  );
}
