// 用量分析: 大盘概览 + 横版 Tab 分页 (趋势 / 模型 / 工具分布 / 渠道订阅)
const RANGE_NAMES = {
  today: '当天',
  last24h: '近 24 小时',
  last7d: '近 7 天',
  last30d: '近 30 天',
};
let _selectedRange = 'today';
let _selectedAgent = 'all';
let _activeTab = 'trends';
const _charts = { trend: null, modelDist: null, stacked: null, cost: null, dist: null, subCost: null };

VIEWS.analytics = {
  render(root) {
    const agents = SNAP.agents || [];
    const agentOptions = agents.map(a =>
      '<option value="' + esc(a.agent) + '"' + (_selectedAgent === a.agent ? ' selected' : '') + '>' +
      esc(a.name) + '</option>').join('');

    root.innerHTML =
      '<div class="view-head">' +
        '<div><h2>用量分析<span class="hint">多维度时序用量、模型消耗、缓存命中与折算成本</span></h2></div>' +
        '<div class="analytics-controls">' +
          '<div class="filter-group">' +
            '<label>时间范围</label>' +
            '<select id="trendRangeSelect" onchange="changeTrendRange(this.value)">' +
              '<option value="today"' + (_selectedRange === 'today' ? ' selected' : '') + '>当天</option>' +
              '<option value="last24h"' + (_selectedRange === 'last24h' ? ' selected' : '') + '>近 24 小时</option>' +
              '<option value="last7d"' + (_selectedRange === 'last7d' ? ' selected' : '') + '>近 7 天</option>' +
              '<option value="last30d"' + (_selectedRange === 'last30d' ? ' selected' : '') + '>近 30 天</option>' +
            '</select>' +
          '</div>' +
          '<div class="filter-group">' +
            '<label>工具筛选</label>' +
            '<select id="trendAgentSelect" onchange="changeTrendAgent(this.value)">' +
              '<option value="all"' + (_selectedAgent === 'all' ? ' selected' : '') + '>全部工具 (全局)</option>' +
              agentOptions +
            '</select>' +
          '</div>' +
        '</div>' +
      '</div>' +

      // 顶部指标大盘(全 Tab 共享)
      '<div class="usage-hero">' +
        '<div class="hero-card main-tok-card">' +
          '<div class="hero-top">' +
            '<div class="hero-title-wrap">' +
              '<span class="hero-icon">⚡</span>' +
              '<span class="hero-label">真实消耗 Tokens</span>' +
            '</div>' +
            '<div class="hero-side-metrics">' +
              '<div class="side-item"><span class="s-lab">总请求数</span><span class="s-val" id="sumRequests">—</span></div>' +
              '<div class="side-item"><span class="s-lab">总成本</span><span class="s-val green" id="sumCost">—</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="hero-big-num">' +
            '<span class="num-main" id="sumTotalTokens">0</span>' +
            '<span class="num-cn" id="sumTotalTokensCN"></span>' +
          '</div>' +
          '<div class="sub-tok-grid">' +
            '<div class="sub-tok-item">' +
              '<div class="st-head"><span class="st-icon">↓</span> 新增输入</div>' +
              '<div class="st-val" id="sumInputTokens">0</div>' +
              '<div class="st-sub" id="sumInputTokensSub">0</div>' +
            '</div>' +
            '<div class="sub-tok-item">' +
              '<div class="st-head"><span class="st-icon">↑</span> 输出 (Output)</div>' +
              '<div class="st-val" id="sumOutputTokens">0</div>' +
              '<div class="st-sub" id="sumOutputTokensSub">0</div>' +
            '</div>' +
            '<div class="sub-tok-item">' +
              '<div class="st-head" title="Prompt Cache 写入/创建 (跨轮次复用)"><span class="st-icon">⛃</span> 缓存创建</div>' +
              '<div class="st-val" id="sumCacheWriteTokens">0</div>' +
              '<div class="st-sub" id="sumCacheWriteTokensSub">0</div>' +
            '</div>' +
            '<div class="sub-tok-item">' +
              '<div class="st-head" title="Prompt Cache 读取/命中"><span class="st-icon">✨</span> 缓存命中</div>' +
              '<div class="st-val" id="sumCacheReadTokens">0</div>' +
              '<div class="st-sub" id="sumCacheReadTokensSub">0</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="hero-card hit-rate-card">' +
          '<div class="hr-title">缓存命中率</div>' +
          '<div class="hr-val-wrap"><span class="hr-val green" id="sumHitRate">0.0%</span></div>' +
          '<div class="hr-bar-track"><div class="hr-bar-fill" id="sumHitRateBar" style="width:0%"></div></div>' +
          '<div class="hr-foot" id="sumHitRateFoot">命中 / (命中 + 新增输入)</div>' +
        '</div>' +
      '</div>' +

      // 横版 Tab 导航
      '<div class="analytics-tabs-wrap">' +
        '<div class="analytics-tabs">' +
          '<button class="tab-btn' + (_activeTab === 'trends' ? ' active' : '') + '" data-tab="trends" onclick="switchAnalyticsTab(\'trends\')">' +
            '<span>📈 用量趋势</span>' +
          '</button>' +
          '<button class="tab-btn' + (_activeTab === 'models' ? ' active' : '') + '" data-tab="models" onclick="switchAnalyticsTab(\'models\')">' +
            '<span>🤖 模型分析</span>' +
            '<span class="tab-badge" id="tabModelCount">—</span>' +
          '</button>' +
          '<button class="tab-btn' + (_activeTab === 'distribution' ? ' active' : '') + '" data-tab="distribution" onclick="switchAnalyticsTab(\'distribution\')">' +
            '<span>🧭 工具分布与热力</span>' +
          '</button>' +
          '<button class="tab-btn' + (_activeTab === 'subscriptions' ? ' active' : '') + '" data-tab="subscriptions" onclick="switchAnalyticsTab(\'subscriptions\')">' +
            '<span>💳 订阅投入产出与 ROI</span>' +
            '<span class="tab-badge" id="tabSubRoiRatio">—</span>' +
          '</button>' +
        '</div>' +
      '</div>' +

      // Tab 1: 用量与趋势
      '<div id="pane-trends" class="tab-pane' + (_activeTab === 'trends' ? ' active' : '') + '">' +
        '<div class="chart-box" style="margin-bottom:14px">' +
          '<h3>使用趋势</h3>' +
          '<div class="csub" id="trendSubText">双轴时序对比 · 左轴 Tokens / 右轴成本 (USD)</div>' +
          '<div class="cwrap tall"><canvas id="usageTrendChart"></canvas></div>' +
        '</div>' +
        '<div class="charts">' +
          '<div class="chart-box"><h3>每日 tokens 用量</h3><div class="csub">按工具堆叠 · 近 30 天</div>' +
            '<div class="cwrap tall"><canvas id="stackedChart"></canvas></div></div>' +
          '<div class="chart-box"><h3>每日折算成本</h3><div class="csub">按官方 API 单价折算 · USD</div>' +
            '<div class="cwrap tall"><canvas id="costChart"></canvas></div></div>' +
        '</div>' +
      '</div>' +

      // Tab 2: 模型分析
      '<div id="pane-models" class="tab-pane' + (_activeTab === 'models' ? ' active' : '') + '">' +
        '<div class="charts2">' +
          '<div class="chart-box">' +
            '<h3>模型用量占比</h3>' +
            '<div class="csub" id="modelDistSub">Top 模型 Tokens 占比</div>' +
            '<div class="cwrap tall"><canvas id="modelDistChart"></canvas></div>' +
          '</div>' +
          '<div class="chart-box">' +
            '<h3>模型消耗明细</h3>' +
            '<div class="csub" id="modelTableSub">当前时间窗口模型统计</div>' +
            '<div id="model-breakdown-list" style="max-height:360px;overflow-y:auto"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      // Tab 3: 工具分布与热力
      '<div id="pane-distribution" class="tab-pane' + (_activeTab === 'distribution' ? ' active' : '') + '">' +
        '<div class="charts2" style="margin-bottom:14px">' +
          '<div class="chart-box"><h3>工具用量占比</h3><div class="csub" id="distSubText">近 30 天 tokens</div>' +
            '<div class="cwrap"><canvas id="distChart"></canvas></div></div>' +
          '<div class="chart-box"><h3>工具用量小计</h3><div class="csub" id="agentTotalsSubText">近 30 天</div><div id="agent-totals"></div></div>' +
        '</div>' +
        '<div class="chart-box"><h3>使用热力图</h3><div class="csub" id="hm-sub">7 × 24 · 本地时区</div>' +
          '<div class="hm-legend">少<div class="hm-scale" id="hm-scale"></div>多 <span id="hm-max"></span></div>' +
          '<div class="hm-grid" id="heatmap"></div>' +
        '</div>' +
      '</div>' +

      // Tab 4: 订阅投入产出与 ROI 分析
      '<div id="pane-subscriptions" class="tab-pane' + (_activeTab === 'subscriptions' ? ' active' : '') + '">' +
        '<div id="sub-roi-container"></div>' +
      '</div>';

    renderActiveTab();
  },
  unmount() {
    for (const k of Object.keys(_charts)) {
      if (_charts[k]) { _charts[k].destroy(); _charts[k] = null; }
    }
  },
};

function getActiveAnalytics() {
  if (!SNAP) return null;
  if (_selectedAgent === 'all') {
    return SNAP.global?.analytics || null;
  }
  const a = (SNAP.agents || []).find(x => x.agent === _selectedAgent);
  return a?.analytics || null;
}
function renderHeroSummary() {
  const an = getActiveAnalytics();
  const sum = an?.summary?.[_selectedRange] || {
    totalTokens: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0,
    requests: 0, cacheHitRate: 0,
  };

  const setT = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  setT('sumTotalTokens', fmtTokensExact(sum.totalTokens));
  setT('sumTotalTokensCN', fmtTokensCN(sum.totalTokens));
  setT('sumRequests', Number(sum.requests || 0).toLocaleString('en-US'));
  setT('sumCost', fmtUSD4(sum.costUSD));

  setT('sumInputTokens', fmtTokensShortCN(sum.inputTokens));
  setT('sumInputTokensSub', fmtTokensExact(sum.inputTokens));

  setT('sumOutputTokens', fmtTokensShortCN(sum.outputTokens));
  setT('sumOutputTokensSub', fmtTokensExact(sum.outputTokens));

  setT('sumCacheWriteTokens', fmtTokensShortCN(sum.cacheWriteTokens || 0));
  setT('sumCacheWriteTokensSub', sum.cacheWriteTokens ? fmtTokensExact(sum.cacheWriteTokens) : '0 (复用已有缓存)');

  setT('sumCacheReadTokens', fmtTokensShortCN(sum.cacheReadTokens || 0));
  setT('sumCacheReadTokensSub', fmtTokensExact(sum.cacheReadTokens || 0));

  const hr = sum.cacheHitRate ?? 0;
  setT('sumHitRate', hr.toFixed(1) + '%');
  const bar = $('sumHitRateBar');
  if (bar) bar.style.width = Math.min(100, Math.max(0, hr)).toFixed(1) + '%';

  const inTot = (sum.cacheReadTokens || 0) + (sum.inputTokens || 0);
  setT('sumHitRateFoot', '命中 ' + fmtTokens(sum.cacheReadTokens) + ' / 输入 ' + fmtTokens(inTot));
}

function renderUsageTrend() {
  const chartEl = $('usageTrendChart');
  if (!chartEl) return;
  const an = getActiveAnalytics();
  const points = an?.trends?.[_selectedRange] || [];
  const labels = points.map(p => p.label);

  const rangeTextMap = {
    today: '当天 (小时)',
    last24h: '近 24 小时 (滚动)',
    last7d: '近 7 天 (按日)',
    last30d: '近 30 天 (按日)',
  };
  const agentName = _selectedAgent === 'all'
    ? '全部工具'
    : ((SNAP.agents || []).find(a => a.agent === _selectedAgent)?.name || _selectedAgent);
  const subText = $('trendSubText');
  if (subText) subText.textContent = agentName + ' · ' + (rangeTextMap[_selectedRange] || _selectedRange) + ' · 双轴对比';

  if (_charts.trend) _charts.trend.destroy();

  _charts.trend = new Chart(chartEl, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '成本',
          data: points.map(p => p.costUSD),
          borderColor: '#e66767',
          borderWidth: 2,
          borderDash: [4, 4],
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: '#e66767',
          pointHoverBorderColor: '#1a1d27',
          pointHoverBorderWidth: 2,
          tension: 0.35,
          yAxisID: 'yCost',
        },
        {
          label: '缓存创建',
          data: points.map(p => p.cacheWriteTokens),
          borderColor: '#d95926',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: '#d95926',
          pointHoverBorderColor: '#1a1d27',
          pointHoverBorderWidth: 2,
          tension: 0.35,
          yAxisID: 'yTokens',
        },
        {
          label: '缓存命中',
          data: points.map(p => p.cacheReadTokens),
          borderColor: '#9085e9',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: '#9085e9',
          pointHoverBorderColor: '#1a1d27',
          pointHoverBorderWidth: 2,
          tension: 0.35,
          fill: true,
          backgroundColor: (ctx) => {
            const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height || 300);
            g.addColorStop(0, 'rgba(144,133,233,0.24)');
            g.addColorStop(1, 'rgba(144,133,233,0.01)');
            return g;
          },
          yAxisID: 'yTokens',
        },
        {
          label: '输入',
          data: points.map(p => p.inputTokens),
          borderColor: '#3987e5',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: '#3987e5',
          pointHoverBorderColor: '#1a1d27',
          pointHoverBorderWidth: 2,
          tension: 0.35,
          yAxisID: 'yTokens',
        },
        {
          label: '输出',
          data: points.map(p => p.outputTokens),
          borderColor: '#199e70',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: '#199e70',
          pointHoverBorderColor: '#1a1d27',
          pointHoverBorderWidth: 2,
          tension: 0.35,
          yAxisID: 'yTokens',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
        },
        yTokens: {
          type: 'linear',
          position: 'left',
          grid: GRID,
          border: { display: false },
          ticks: { callback: v => fmtTokens(v), maxTicksLimit: 6 },
        },
        yCost: {
          type: 'linear',
          position: 'right',
          grid: { display: false },
          border: { display: false },
          ticks: {
            callback: v => '$' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : (v >= 1 ? v.toFixed(0) : v.toFixed(2))),
            maxTicksLimit: 6,
          },
        },
      },
      plugins: {
        legend: {
          position: 'bottom',
          align: 'center',
          labels: { color: '#b9bdcb', padding: 14, usePointStyle: true, pointStyle: 'circle' },
        },
        tooltip: {
          callbacks: {
            label: (c) => {
              if (c.dataset.yAxisID === 'yCost') {
                return ' ' + c.dataset.label + ': ' + fmtUSD4(c.parsed.y);
              }
              return ' ' + c.dataset.label + ': ' + fmtTokensExact(c.parsed.y) + ' (' + fmtTokens(c.parsed.y) + ')';
            },
            footer: (items) => {
              const tokItems = items.filter(it => it.dataset.yAxisID === 'yTokens');
              const total = tokItems.reduce((s, it) => s + it.parsed.y, 0);
              return '真实消耗合计: ' + fmtTokensExact(total);
            },
          },
          footerColor: '#e6e8ee',
          footerMarginTop: 6,
        },
      },
    },
  });
}

function renderModelAnalytics() {
  const an = getActiveAnalytics();
  const models = an?.models?.[_selectedRange] || [];
  const chartEl = $('modelDistChart');
  const listEl = $('model-breakdown-list');
  const subEl = $('modelDistSub');
  const tblSubEl = $('modelTableSub');

  const rangeTextMap = {
    today: '当天',
    last24h: '近 24 小时',
    last7d: '近 7 天',
    last30d: '近 30 天',
  };
  const rangeTxt = rangeTextMap[_selectedRange] || _selectedRange;
  if (subEl) subEl.textContent = rangeTxt + ' · Top 模型 Tokens 占比';
  if (tblSubEl) tblSubEl.textContent = rangeTxt + ' · 共 ' + models.length + ' 个活跃模型';

  const colors = [
    '#3987e5', '#d95926', '#199e70', '#c98500', '#9085e9',
    '#d55181', '#57c7ff', '#8b90a0', '#e66767', '#3ecf8e'
  ];

  if (!models.length) {
    if (_charts.modelDist) { _charts.modelDist.destroy(); _charts.modelDist = null; }
    if (listEl) listEl.innerHTML = '<div class="empty-tip" style="padding:24px">所选时间范围与工具下暂无模型用量记录</div>';
    return;
  }

  // 1. 模型环形图 (Top 6 + 其他)
  const topModels = models.slice(0, 6);
  const otherModels = models.slice(6);
  const otherTokens = otherModels.reduce((s, m) => s + m.tokens, 0);

  const chartLabels = topModels.map(m => m.model + ' ' + (m.pctTokens ?? 0).toFixed(1) + '%');
  const chartData = topModels.map(m => m.tokens);

  if (otherTokens > 0) {
    const totalTokens = models.reduce((s, m) => s + m.tokens, 0);
    const otherPct = totalTokens > 0 ? (otherTokens / totalTokens * 100).toFixed(1) : 0;
    chartLabels.push('其他 (' + otherModels.length + ') ' + otherPct + '%');
    chartData.push(otherTokens);
  }

  if (_charts.modelDist) _charts.modelDist.destroy();
  if (chartEl) {
    _charts.modelDist = new Chart(chartEl, {
      type: 'doughnut',
      data: {
        labels: chartLabels,
        datasets: [{
          data: chartData,
          backgroundColor: colors.slice(0, chartData.length),
          borderColor: '#1a1d27',
          borderWidth: 2,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        layout: { padding: 8 },
        plugins: {
          legend: { position: 'right', labels: { color: '#b9bdcb', padding: 8 } },
          tooltip: {
            callbacks: {
              label: (c) => ' ' + fmtTokens(c.parsed) + ' tokens (' + fmtTokensCN(c.parsed) + ')',
            },
            footerColor: '#e6e8ee',
          },
        },
      },
    });
  }

  // 2. 模型明细列表
  if (listEl) {
    const maxTokens = Math.max(...models.map(m => m.tokens), 0);
    listEl.innerHTML =
      '<div class="prov-head" style="grid-template-columns: minmax(0, 1.4fr) 52px 85px 75px 58px 75px; gap: 8px;">' +
        '<span>模型</span>' +
        '<span>请求</span>' +
        '<span>真实 Tokens</span>' +
        '<span>折算成本</span>' +
        '<span>命中率</span>' +
        '<span>占比</span>' +
      '</div>' +
      models.map((m, i) => {
        const barWidth = maxTokens > 0 ? Math.max(2, (m.tokens / maxTokens) * 100) : 0;
        const color = colors[i % colors.length];
        const agentBadges = (m.agents || []).map(a =>
          '<span class="badge agent-tag" style="font-size:9.5px;padding:1px 5px;margin-left:4px">' + esc(a) + '</span>'
        ).join('');

        return '<div class="prov-row" style="grid-template-columns: minmax(0, 1.4fr) 52px 85px 75px 58px 75px; gap: 8px; font-size: 12px; padding: 6px 4px;">' +
          '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(m.model) + '">' +
            '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + color + ';margin-right:6px"></span>' +
            '<b>' + esc(m.model) + '</b>' + agentBadges +
          '</div>' +
          '<span class="prov-req">' + m.requests + '</span>' +
          '<span class="prov-tok">' + fmtTokens(m.tokens) + '</span>' +
          '<span class="prov-cost" style="color:#3ecf8e">' + fmtUSD4(m.costUSD) + '</span>' +
          '<span class="prov-req" style="color:var(--text2)">' + (m.cacheHitRate ? m.cacheHitRate.toFixed(1) + '%' : '—') + '</span>' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            '<span class="mtrack" style="flex:1;height:5px;background:var(--card2);border-radius:3px;overflow:hidden">' +
              '<span class="mfill" style="display:block;width:' + barWidth.toFixed(1) + '%;height:100%;background:' + color + '"></span>' +
            '</span>' +
            '<span style="font-size:11px;color:var(--muted);width:32px;text-align:right">' + (m.pctTokens ?? 0).toFixed(0) + '%</span>' +
          '</div>' +
        '</div>';
      }).join('');
  }
}

function updateTabBadges() {
  const an = getActiveAnalytics();
  const models = an?.models?.[_selectedRange] || [];
  const badge = $('tabModelCount');
  if (badge) badge.textContent = models.length || '0';

  const subs = (SNAP?.subscriptions || []).filter(s => !s.isHistorical);
  const totalCost = subs.reduce((sum, s) => sum + (s.priceMonthly || 0), 0);
  const totalVal = subs.reduce((sum, s) => sum + (s.usage?.cost30d || 0), 0);
  const roiBadge = $('tabSubRoiRatio');
  if (roiBadge) {
    roiBadge.textContent = totalCost > 0 ? (totalVal / totalCost).toFixed(1) + 'x' : '—';
  }
}

window.switchAnalyticsTab = function(tabId) {
  _activeTab = tabId;
  document.querySelectorAll('.analytics-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === 'pane-' + tabId);
  });
  renderActiveTab();
};

function renderActiveTab() {
  renderHeroSummary();
  updateTabBadges();

  if (_activeTab === 'trends') {
    renderUsageTrend();
    renderStacked();
    renderCost();
  } else if (_activeTab === 'models') {
    renderModelAnalytics();
  } else if (_activeTab === 'distribution') {
    renderDist();
    renderAgentTotals();
    renderHeatmap();
  } else if (_activeTab === 'subscriptions') {
    renderSubUsage();
  }
}

window.changeTrendRange = function(range) {
  _selectedRange = range;
  renderActiveTab();
};

window.changeTrendAgent = function(agentId) {
  _selectedAgent = agentId;
  renderActiveTab();
};

function last30Labels() {
  return SNAP.agents[0]?.usage.last30dByDay?.map(d => d.day.slice(5)) || [];
}

function renderStacked() {
  const labels = last30Labels();
  if (!labels.length) return;
  const n = SNAP.agents.length;
  const datasets = SNAP.agents.map((a, i) => ({
    label: a.name,
    data: a.usage.last30dByDay.map(d => d.tokens),
    backgroundColor: colorFor(a.agent, i),
    stack: 't',
    borderColor: '#1a1d27',
    borderWidth: 2,
    borderRadius: i === n - 1 ? 3 : 0,
    borderSkipped: false,
    maxBarThickness: 26,
  }));
  if (_charts.stacked) _charts.stacked.destroy();
  _charts.stacked = new Chart($('stackedChart'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { display: false },
             ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: { stacked: true, grid: GRID, border: { display: false },
             ticks: { callback: v => fmtTokens(v), maxTicksLimit: 6 } },
      },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { color: '#b9bdcb', padding: 14 } },
        tooltip: {
          callbacks: {
            label: (c) => ' ' + c.dataset.label + ': ' + fmtTokens(c.parsed.y),
            footer: (items) => '合计 ' + fmtTokens(items.reduce((s, it) => s + it.parsed.y, 0)),
          },
          footerColor: '#e6e8ee',
          footerMarginTop: 6,
        },
      },
    },
  });
}

function renderCost() {
  const labels = last30Labels();
  const totals = labels.map((_, di) =>
    SNAP.agents.reduce((s, a) => s + (a.usage.last30dByDay[di]?.costUSD || 0), 0));
  if (_charts.cost) _charts.cost.destroy();
  _charts.cost = new Chart($('costChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '折算成本',
        data: totals,
        borderColor: '#3987e5',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: '#3987e5',
        pointHoverBorderColor: '#1a1d27',
        pointHoverBorderWidth: 2,
        tension: .3,
        fill: true,
        backgroundColor: (ctx) => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height || 300);
          g.addColorStop(0, 'rgba(57,135,229,.28)');
          g.addColorStop(1, 'rgba(57,135,229,.02)');
          return g;
        },
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } },
        y: { grid: GRID, border: { display: false },
             ticks: { callback: v => '$' + (v >= 1000 ? (v/1000).toFixed(1) + 'k' : v.toFixed(0)), maxTicksLimit: 6 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => ' ' + fmtUSD(c.parsed.y) } },
      },
    },
  });
}

function renderDist() {
  const rangeName = RANGE_NAMES[_selectedRange] || '近 30 天';
  const subEl = $('distSubText');
  if (subEl) subEl.textContent = rangeName + ' · 工具用量占比';

  const chartEl = $('distChart');
  if (!chartEl) return;

  const dist = SNAP.global?.analytics?.distributions?.[_selectedRange] || SNAP.global?.distribution || [];
  if (!dist.length) {
    if (_charts.dist) { _charts.dist.destroy(); _charts.dist = null; }
    return;
  }
  if (_charts.dist) _charts.dist.destroy();
  const total = dist.reduce((s, d) => s + d.tokens, 0);
  _charts.dist = new Chart(chartEl, {
    type: 'doughnut',
    data: {
      labels: dist.map(d => d.agent + ' ' + (d.pctTokens ?? 0).toFixed(1) + '%'),
      datasets: [{
        data: dist.map(d => d.tokens),
        backgroundColor: dist.map((d, i) => colorFor(d.agent, i)),
        borderColor: '#1a1d27',
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '62%',
      layout: { padding: 8 },
      plugins: {
        legend: { position: 'right', labels: { color: '#b9bdcb', padding: 10 } },
        tooltip: {
          callbacks: {
            label: (c) => ' ' + fmtTokens(c.parsed) + ' tokens',
            footer: () => '总计 ' + fmtTokens(total),
          },
          footerColor: '#e6e8ee',
        },
      },
    },
  });
}

function renderHeatmap() {
  const el = $('heatmap');
  if (!el) return;
  const an = getActiveAnalytics();
  const grid = an?.heatmaps?.[_selectedRange] || SNAP.global?.heatmap;
  if (!grid) { el.innerHTML = '<div style="color:var(--muted);padding:24px;text-align:center">当前时段无热力数据</div>'; return; }

  const rangeName = RANGE_NAMES[_selectedRange] || '近 30 天';
  const agentName = _selectedAgent === 'all' ? '全部工具' : ((SNAP.agents || []).find(a => a.agent === _selectedAgent)?.name || _selectedAgent);
  const tzShiftMin = -new Date().getTimezoneOffset();
  const tzStr = 'UTC' + (tzShiftMin >= 0 ? '+' : '-') +
    String(Math.floor(Math.abs(tzShiftMin) / 60)).padStart(2, '0') + ':' +
    String(Math.abs(tzShiftMin) % 60).padStart(2, '0');

  const subEl = $('hm-sub');
  if (subEl) {
    subEl.textContent = agentName + ' · ' + rangeName + ' · 7 × 24 · 本地时区 (' + tzStr + ')';
  }

  let max = 0;
  let totalTokensInGrid = 0;
  for (const row of grid) {
    for (const c of row) {
      if (c.tokens > max) max = c.tokens;
      totalTokensInGrid += c.tokens;
    }
  }

  const maxEl = $('hm-max');
  if (maxEl) {
    maxEl.textContent = max ? '时段峰值 ' + fmtTokens(max) : (totalTokensInGrid === 0 ? '该时段暂无活跃' : '');
  }

  const scaleEl = $('hm-scale');
  if (scaleEl) {
    scaleEl.innerHTML = [0.06, 0.3, 0.55, 0.8, 1].map(a =>
      '<i style="background:rgba(57,135,229,' + a + ')"></i>').join('');
  }

  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  let html = '<div></div>';
  for (let h = 0; h < 24; h++) {
    html += '<div class="hm-hour">' + (h % 2 === 0 ? String(h).padStart(2, '0') : '') + '</div>';
  }
  for (const d of order) {
    html += '<div class="hm-lab">' + dayNames[d] + '</div>';
    for (let h = 0; h < 24; h++) {
      const utcMin = h * 60 - tzShiftMin;
      let srcD = d, srcH = Math.floor(utcMin / 60);
      if (utcMin < 0) { srcD = (d - 1 + 7) % 7; srcH = (srcH + 24) % 24; }
      else if (utcMin >= 1440) { srcD = (d + 1) % 7; srcH = srcH % 24; }
      const cell = grid[srcD] && grid[srcD][srcH] ? grid[srcD][srcH] : { tokens: 0, costUSD: 0 };
      const intensity = max ? cell.tokens / max : 0;
      const alpha = intensity === 0 ? 0 : 0.08 + intensity * 0.92;
      const bg = intensity === 0 ? '#1f2330' : 'rgba(57,135,229,' + alpha.toFixed(3) + ')';
      const tip = dayNames[d] + ' ' + String(h).padStart(2, '0') + ':00 · ' +
        (cell.tokens ? (fmtTokens(cell.tokens) + ' · ' + fmtUSD(cell.costUSD || 0)) : '无请求');
      html += '<div class="hm-cell" style="background:' + bg + '" title="' + esc(tip) + '"></div>';
    }
  }
  el.innerHTML = html;
}

function renderAgentTotals() {
  const el = $('agent-totals');
  if (!el) return;
  const rangeName = RANGE_NAMES[_selectedRange] || '近 30 天';
  const subEl = $('agentTotalsSubText');
  if (subEl) subEl.textContent = rangeName + ' · 按工具分列';

  const rows = (SNAP.agents || []).map(a => {
    const sum = a.analytics?.summary?.[_selectedRange];
    const tok = sum ? sum.totalTokens : (a.usage?.last7d?.tokens || 0);
    const cost = sum ? sum.costUSD : (a.usage?.last7d?.c || 0);
    const modelList = a.analytics?.models?.[_selectedRange] || a.models || [];
    return {
      name: a.name,
      agent: a.agent,
      tokens: tok,
      cost: cost,
      models: modelList.length,
      isSelected: _selectedAgent === a.agent,
    };
  }).sort((a, b) => b.tokens - a.tokens);

  const max = Math.max(...rows.map(r => r.tokens), 0);
  el.innerHTML = '<div class="prov-head"><span></span><span>工具</span><span>' + rangeName + ' tokens</span><span>' + rangeName + ' 成本</span><span>模型数</span><span></span><span></span></div>' +
    rows.map((r, i) => {
      const w = max ? Math.max(2, (r.tokens / max) * 100) : 0;
      const highlight = r.isSelected ? ' style="background:rgba(57,135,229,0.12);border-radius:6px;"' : '';
      return '<div class="prov-row"' + highlight + ' style="grid-template-columns:10px minmax(0,1fr) 90px 74px 58px minmax(0,1fr) 90px">' +
        '<span class="prov-dot off" style="background:' + colorFor(r.agent, i) + '"></span>' +
        '<span class="prov-name">' + esc(r.name) + (r.isSelected ? ' <b style="color:var(--accent);font-size:11px">●</b>' : '') + '</span>' +
        '<span class="prov-tok">' + fmtTokens(r.tokens) + '</span>' +
        '<span class="prov-cost">' + fmtUSD(r.cost) + '</span>' +
        '<span class="prov-req">' + r.models + '</span>' +
        '<span class="mtrack" style="height:6px;background:var(--card2);border-radius:3px;overflow:hidden">' +
          '<span class="mfill" style="display:block;width:' + w.toFixed(1) + '%;height:100%;background:' + colorFor(r.agent, i) + '"></span></span>' +
        '<span></span></div>';
    }).join('');
}

let _subRoiFilter = 'active'; // 'active' | 'all'

window.setSubRoiFilter = function(filter) {
  _subRoiFilter = filter;
  renderSubUsage();
};

function renderSubUsage() {
  const container = $('sub-roi-container');
  if (!container) return;

  const allSubs = SNAP.subscriptions || [];
  const activeSubs = allSubs.filter(s => !s.isHistorical);
  const displaySubs = _subRoiFilter === 'active' ? activeSubs : allSubs;

  if (!displaySubs.length) {
    container.innerHTML =
      '<div class="chart-box"><div class="empty-tip">暂无符合条件的订阅条目，可前往 <b>订阅台账</b> 新增。</div></div>';
    return;
  }

  // 汇总当前生效中订阅的全局财务与回报指标
  const totalMonthlyCost = activeSubs.reduce((sum, s) => sum + (s.priceMonthly || 0), 0);
  const totalEquivalentValue = activeSubs.reduce((sum, s) => sum + (s.usage?.cost30d || 0), 0);
  const overallRoiRatio = totalMonthlyCost > 0 ? (totalEquivalentValue / totalMonthlyCost) : null;
  const netSavings = totalEquivalentValue - totalMonthlyCost;

  // 排序：优先按等效价值高低排序，使柱状图层级明晰
  const sortedSubs = [...displaySubs].sort((a, b) => (b.usage?.cost30d || 0) - (a.usage?.cost30d || 0));

  // 顶部 4 KPI 概览卡片
  const kpiHtml =
    '<div class="sub-roi-hero">' +
      '<div class="sub-roi-kpi">' +
        '<div class="kpi-lab">月度固定支出 (总月费)</div>' +
        '<div class="kpi-val">$' + totalMonthlyCost.toFixed(2) + ' <span style="font-size:12px;color:var(--muted);font-weight:400">/ 月</span></div>' +
        '<div class="kpi-foot">' + activeSubs.length + ' 个生效中订阅</div>' +
      '</div>' +
      '<div class="sub-roi-kpi">' +
        '<div class="kpi-lab">API 等效总产出 (价值)</div>' +
        '<div class="kpi-val green">$' + totalEquivalentValue.toFixed(2) + '</div>' +
        '<div class="kpi-foot">按模型官方 API 单价折算</div>' +
      '</div>' +
      '<div class="sub-roi-kpi">' +
        '<div class="kpi-lab">综合投资回报率 (ROI)</div>' +
        '<div class="kpi-val" style="color:#57c7ff">' + (overallRoiRatio ? overallRoiRatio.toFixed(1) + 'x' : '—') + '</div>' +
        '<div class="kpi-foot">' + (overallRoiRatio && overallRoiRatio >= 1 ? '已大幅回本盈利' : '尚未收回成本') + '</div>' +
      '</div>' +
      '<div class="sub-roi-kpi">' +
        '<div class="kpi-lab">累计净节省支出</div>' +
        '<div class="kpi-val" style="color:' + (netSavings >= 0 ? '#52c41a' : '#ff4d4f') + '">' +
          (netSavings >= 0 ? '+$' + netSavings.toFixed(2) : '-$' + Math.abs(netSavings).toFixed(2)) +
        '</div>' +
        '<div class="kpi-foot">等效总产出 - 实际月费</div>' +
      '</div>' +
    '</div>';

  // 主布局：左侧投入产出条形对比图，右侧订阅性价比榜单
  container.innerHTML =
    kpiHtml +
    '<div class="charts2">' +
      '<div class="chart-box">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">' +
          '<div>' +
            '<h3>投入 vs 产出对比</h3>' +
            '<div class="csub">月费支出（成本） vs API 等效价值（产出） · USD</div>' +
          '</div>' +
          '<div style="display:flex;gap:4px">' +
            '<button class="' + (_subRoiFilter === 'active' ? 'primary' : '') + '" style="padding:2px 10px;font-size:11.5px" onclick="setSubRoiFilter(\'active\')">正在使用 (' + activeSubs.length + ')</button>' +
            '<button class="' + (_subRoiFilter === 'all' ? 'primary' : '') + '" style="padding:2px 10px;font-size:11.5px" onclick="setSubRoiFilter(\'all\')">全部 (' + allSubs.length + ')</button>' +
          '</div>' +
        '</div>' +
        '<div class="cwrap tall" style="height:360px"><canvas id="subRoiChart"></canvas></div>' +
      '</div>' +
      '<div class="chart-box">' +
        '<h3>订阅性价比与回本效率榜</h3>' +
        '<div class="csub">按产出价值与 ROI 综合分析 · 辅助续费决策</div>' +
        '<div id="sub-roi-card-list" style="max-height:360px;overflow-y:auto;padding-right:4px"></div>' +
      '</div>' +
    '</div>';

  // 渲染左侧双柱条形图
  const chartEl = $('subRoiChart');
  if (chartEl) {
    if (_charts.subCost) { _charts.subCost.destroy(); _charts.subCost = null; }
    if (_charts.subRoi) { _charts.subRoi.destroy(); _charts.subRoi = null; }

    const labels = sortedSubs.map(s => s.name);
    const costData = sortedSubs.map(s => s.billingType === 'prepaid' ? 0 : (s.priceMonthly || 0));
    const valueData = sortedSubs.map(s => s.usage?.cost30d || 0);

    _charts.subRoi = new Chart(chartEl, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: '实际月费支出',
            data: costData,
            backgroundColor: 'rgba(245, 108, 108, 0.75)',
            borderColor: '#f56c6c',
            borderWidth: 1,
            borderRadius: { topRight: 3, bottomRight: 3 },
            maxBarThickness: 12,
          },
          {
            label: 'API 等效价值',
            data: valueData,
            backgroundColor: 'rgba(62, 207, 142, 0.85)',
            borderColor: '#3ecf8e',
            borderWidth: 1,
            borderRadius: { topRight: 3, bottomRight: 3 },
            maxBarThickness: 12,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: GRID,
            border: { display: false },
            ticks: { callback: v => '$' + v, maxTicksLimit: 6 },
          },
          y: {
            grid: { display: false },
            ticks: { color: '#e6e8ee', font: { weight: '500' } },
          },
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: { boxWidth: 10, boxHeight: 10, color: '#b9bdcb', font: { size: 11 } },
          },
          tooltip: {
            callbacks: {
              afterBody: (items) => {
                const idx = items[0]?.dataIndex;
                if (idx === undefined) return '';
                const s = sortedSubs[idx];
                const roi = s.insights?.roiMonthly?.ratio;
                const price = s.priceMonthly || 0;
                const val = s.usage?.cost30d || 0;
                const net = val - price;
                const lines = [];
                if (s.usage?.windowDays && s.usage.windowDays < 30) {
                  lines.push('统计窗口: ' + s.usage.windowDays + ' 天 (开始于 ' + (s.startDate ? s.startDate.slice(0, 10) : '近期') + ')');
                }
                if (roi) lines.push('回报率 (ROI): ' + roi.toFixed(1) + 'x');
                if (s.billingType !== 'prepaid' && price > 0) {
                  lines.push('净省金额: ' + (net >= 0 ? '+$' + net.toFixed(2) : '-$' + Math.abs(net).toFixed(2)));
                }
                return lines.join('\n');
              },
            },
          },
        },
      },
    });
  }

  // 渲染右侧卡片列表
  const listEl = $('sub-roi-card-list');
  if (listEl) {
    listEl.innerHTML = sortedSubs.map(s => {
      const isPrepaid = s.billingType === 'prepaid' || (s.plan && s.plan.includes('预付费'));
      const isHist = !!s.isHistorical;
      const price = s.priceMonthly || 0;
      const val = s.usage?.cost30d || 0;
      const net = val - price;
      const roi = s.insights?.roiMonthly?.ratio;
      const dm = s.insights?.dormant;
      const windowDays = s.usage?.windowDays;

      // 状态与回报标签
      let badgeHtml = '';
      if (isHist) {
        badgeHtml = '<span class="badge" style="background:rgba(180,185,200,.12);color:var(--muted);border-color:rgba(180,185,200,.25)">已归档</span>';
      } else if (dm && dm.dormant) {
        badgeHtml = '<span class="badge warn">💤 沉睡 ' + dm.daysSinceActive.toFixed(0) + ' 天</span>';
      } else if (isPrepaid) {
        badgeHtml = '<span class="badge" style="background:rgba(87,199,255,.15);color:#57c7ff;border-color:rgba(87,199,255,.3)">🟡 按量实销</span>';
      } else if (roi && roi >= 3.0) {
        badgeHtml = '<span class="badge" style="background:rgba(62,207,142,.15);color:#3ecf8e;border-color:rgba(62,207,142,.3)">🚀 超高回报 ' + roi.toFixed(1) + 'x</span>';
      } else if (roi && roi >= 1.0) {
        badgeHtml = '<span class="badge" style="background:rgba(82,196,26,.15);color:#52c41a;border-color:rgba(82,196,26,.3)">🟢 稳健回本 ' + roi.toFixed(1) + 'x</span>';
      } else if (roi && roi > 0) {
        badgeHtml = '<span class="badge" style="background:rgba(255,77,79,.15);color:#ff4d4f;border-color:rgba(255,77,79,.3)">⚠️ 投入偏高 ' + roi.toFixed(1) + 'x</span>';
      } else {
        badgeHtml = '<span class="badge" style="background:rgba(255,77,79,.15);color:#ff4d4f;border-color:rgba(255,77,79,.3)">🔴 暂无产出</span>';
      }

      // 进度条与回本百分比
      let progressHtml = '';
      if (isPrepaid) {
        progressHtml =
          '<div class="sub-roi-progress-wrap">' +
            '<div class="sub-roi-progress-bar"><div class="sub-roi-progress-fill" style="width:100%;background:#57c7ff"></div></div>' +
            '<span>按需抵扣 · 无固定月费风险</span>' +
          '</div>';
      } else if (price > 0) {
        const pctVal = Math.round((val / price) * 100);
        const fillWidth = Math.min(100, Math.max(3, pctVal));
        const fillBg = pctVal >= 100 ? 'linear-gradient(90deg, #3ecf8e, #52c41a)' : 'linear-gradient(90deg, #ff7875, #ff4d4f)';
        const progressTip = pctVal >= 100
          ? '已回本 ' + pctVal + '% (超额收益)'
          : '仅回本 ' + pctVal + '% (建议评估是否降级或提升用量)';
        progressHtml =
          '<div class="sub-roi-progress-wrap">' +
            '<div class="sub-roi-progress-bar"><div class="sub-roi-progress-fill" style="width:' + fillWidth + '%;background:' + fillBg + '"></div></div>' +
            '<span>' + progressTip + '</span>' +
          '</div>';
      }

      return '<div class="sub-roi-card">' +
        '<div class="card-top">' +
          '<div class="card-title">' +
            '<span>' + esc(s.name) + '</span>' +
            (s.plan ? '<span style="font-size:11px;color:var(--muted);font-weight:400">(' + esc(s.plan) + ')</span>' : '') +
          '</div>' +
          '<div>' + badgeHtml + '</div>' +
        '</div>' +
        '<div class="card-metrics">' +
          '<div class="metric-item">' +
            '<span class="metric-label">实际月费支出</span>' +
            '<span class="metric-value">' + (isPrepaid ? '按量预付' : (price ? '$' + price.toFixed(2) + '/月' : '免费/内部')) + '</span>' +
          '</div>' +
          '<div class="metric-item">' +
            '<span class="metric-label">API 等效产出</span>' +
            '<span class="metric-value green">$' + val.toFixed(2) +
              (windowDays && windowDays < 30 ? ' <span style="font-size:10px;color:var(--muted)">(' + windowDays + '天)</span>' : '') +
            '</span>' +
          '</div>' +
          '<div class="metric-item">' +
            '<span class="metric-label">净节省 / 盈亏</span>' +
            '<span class="metric-value">' +
              (isPrepaid ? '<span style="color:var(--muted)">实销实折</span>' : (!price ? '—' : (net >= 0 ? '<span style="color:#52c41a">+$' + net.toFixed(2) + '</span>' : '<span style="color:#ff4d4f">-$' + Math.abs(net).toFixed(2) + '</span>'))) +
            '</span>' +
          '</div>' +
        '</div>' +
        progressHtml +
      '</div>';
    }).join('');
  }
}
