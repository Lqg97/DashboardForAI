// 订阅台账: 订阅条目表格 + 导出
let _ledgerFilter = 'all'; // 'all' | 'active' | 'historical'

VIEWS.ledger = {
  render(root, now) {
    const subs = SNAP.subscriptions || [];
    const activeCount = subs.filter(s => !s.isHistorical).length;
    const histCount = subs.filter(s => s.isHistorical).length;

    let filtered = subs.slice().sort((a, b) => {
      if (a.isHistorical !== b.isHistorical) return a.isHistorical ? 1 : -1;
      return 0;
    });
    if (_ledgerFilter === 'active') filtered = subs.filter(s => !s.isHistorical);
    else if (_ledgerFilter === 'historical') filtered = subs.filter(s => s.isHistorical);

    root.innerHTML =
      '<div class="view-head"><h2>订阅台账<span class="hint">按工具与账单管理，区分当前生效与历史归档</span></h2>' +
      '<div style="display:flex;gap:8px">' +
      '<button onclick="doExport(\'csv\')">导出 CSV</button>' +
      '<button onclick="doExport(\'json\')">导出 JSON</button>' +
      ((typeof HUB_MODE !== 'undefined' && HUB_MODE) ? '' : '<button class="primary" onclick="openSubForm(null)">+ 新增订阅</button>') + '</div></div>' +
      '<div style="display:flex;gap:6px;margin-bottom:14px;align-items:center">' +
        '<span style="font-size:12px;color:var(--muted);margin-right:6px">状态筛选:</span>' +
        '<button class="' + (_ledgerFilter === 'all' ? 'primary' : '') + '" style="padding:3px 12px;font-size:12px" onclick="setLedgerFilter(\'all\')">全部 (' + subs.length + ')</button>' +
        '<button class="' + (_ledgerFilter === 'active' ? 'primary' : '') + '" style="padding:3px 12px;font-size:12px" onclick="setLedgerFilter(\'active\')">正在使用 (' + activeCount + ')</button>' +
        '<button class="' + (_ledgerFilter === 'historical' ? 'primary' : '') + '" style="padding:3px 12px;font-size:12px" onclick="setLedgerFilter(\'historical\')">历史归档 (' + histCount + ')</button>' +
      '</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
      '<th>状态</th><th>订阅</th><th>套餐</th><th>月费/模式</th><th>开始时间</th><th>花费(已支出)</th><th>到期时间</th><th>关联工具</th>' +      '<th>30d API 折算</th><th>ROI(月)</th><th>沉睡</th><th>最近活跃</th><th>操作</th>' +
      '</tr></thead><tbody>' +
      (filtered.length ? filtered.map(s => subRow(s, now)).join('')
        : '<tr><td colspan="14" style="text-align:center;color:var(--muted);padding:30px">无符合筛选条件的订阅条目</td></tr>') +
      '</tbody></table></div>';
  },
};

window.setLedgerFilter = function(filter) {
  _ledgerFilter = filter;
  const root = $('view-root');
  if (root) VIEWS.ledger.render(root, Date.now());
};

function subRow(s, now) {
  const isPrepaid = s.billingType === 'prepaid' || (s.plan && s.plan.includes('预付费'));
  const isHist = !!s.isHistorical;
  const roi = s.insights.roiMonthly;
  const dm = s.insights.dormant;
  const rel = (s.agentIds || []).join(' / ') || '—';
  const startStr = (!isPrepaid && s.startDate) ? new Date(s.startDate).toLocaleDateString('zh-CN') : '—';
  const expireStr = (!isPrepaid && s.expireAt) ? new Date(s.expireAt).toLocaleDateString('zh-CN') : '—';
  const yearlyStr = (s.finance?.yearlyCost !== null && s.finance?.yearlyCost !== undefined)
    ? ('$' + s.finance.yearlyCost + (s.finance.monthsSinceStart ? ' <span style="font-size:11px;color:var(--muted)">(' + s.finance.monthsSinceStart + '个月)</span>' : ''))
    : '—';

  const statusBadge = isHist
    ? '<span class="badge" style="background:rgba(180,185,200,.12);color:var(--muted);border-color:rgba(180,185,200,.25);font-size:10.5px">历史归档</span>'
    : '<span class="badge" style="background:rgba(82,196,26,.15);color:#52c41a;border-color:rgba(82,196,26,.3);font-size:10.5px">正在使用</span>';

  const userBadge = s.user
    ? ' <span class="badge" style="background:rgba(144,133,233,.15);color:#b0a8f5;border-color:rgba(144,133,233,.3);font-size:10px">' + esc(s.user) + '</span>'
    : '';

  const priceStr = isPrepaid
    ? '<span class="badge" style="background:rgba(87,199,255,.12);color:#57c7ff;border-color:rgba(87,199,255,.25);font-size:11px">预付费' + (s.balance !== null && s.balance !== undefined ? ' · 余$' + s.balance : '') + '</span>'
    : (s.priceMonthly !== null && s.priceMonthly !== undefined ? '$' + s.priceMonthly : '-');

  const roiStr = isPrepaid
    ? '<span style="color:var(--muted);font-size:11.5px">按量实销</span>'
    : (isHist ? '<span style="color:var(--muted);font-size:11.5px">已结清</span>' : (roi ? roi.ratio.toFixed(1) + 'x' : '-'));const windowDays = s.usage?.windowDays;
    const daysTip = (windowDays && windowDays < 30) ? (' <span style="font-size:11px;color:var(--muted)">(' + windowDays + '天)</span>') : '';
    return '<tr' + (isHist ? ' style="opacity:0.75;background:rgba(255,255,255,0.01)"' : '') + '>' +
    '<td>' + statusBadge + '</td>' +
    '<td style="font-weight:' + (isHist ? '400' : '600') + '">' + esc(s.name) + userBadge + (isPrepaid ? ' <span class="badge" style="background:rgba(87,199,255,.1);color:#57c7ff;border-color:rgba(87,199,255,.2);font-size:10px">按量</span>' : '') + '</td>' +
    '<td>' + esc(s.plan || (isPrepaid ? '预付费 / 按量' : '-')) + '</td>' +
    '<td>' + priceStr + '</td>' +
    '<td>' + startStr + '</td>' +
    '<td>' + yearlyStr + '</td>' +
    '<td>' + expireStr + '</td>' +
    '<td>' + esc(rel) + '</td>' +'<td>' + fmtTokens(s.usage.tokens30d) + ' · ' + fmtUSD(s.usage.cost30d) + daysTip + '</td>' +
    '<td>' + roiStr + '</td>' +
    '<td>' + (isHist ? '—' : (dm && dm.dormant ? '是' : '否')) + '</td>' +
    '<td>' + (s.usage.lastActiveAt ? fmtDT(s.usage.lastActiveAt) : '-') + '</td>' +
    '<td style="white-space:nowrap">' +
    '<button style="padding:2px 10px;font-size:11px" onclick="editSub(\'' + esc(s.id) + '\')">编辑</button> ' +
    '<button class="danger" style="padding:2px 10px;font-size:11px" onclick="deleteSub(\'' + esc(s.id) + '\')">删除</button></td>' +
    '</tr>';
}
