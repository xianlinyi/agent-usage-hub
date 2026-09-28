const $ = selector => document.querySelector(selector);
const number = new Intl.NumberFormat('zh-CN');
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const labels = {
  day: '日期', month: '月份', collectorId: '采集器', source: '来源', agent: 'Agent',
  model: '模型', project: '项目', sessionId: '会话', events: '记录数',
  totalTokens: '总 Token', inputTokens: '输入 Token', outputTokens: '输出 Token',
  cacheReadTokens: '缓存读取', cacheWriteTokens: '缓存写入', otherTokens: '其他 Token',
  reasoningTokens: '推理 Token', costUsd: '参考费用',
};
const label = key => key.startsWith('ext.') ? `扩展 · ${key.slice(4)}` : labels[key] || key;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let token = sessionStorage.getItem('agentUsageAdminToken') || '';
let toastTimer;

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3000);
}

async function api(endpoint, params) {
  const url = new URL(endpoint, location.origin);
  if (params) for (const [key, value] of params) url.searchParams.append(key, value);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error('TOKEN_INVALID');
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function currentParams() {
  const params = new URLSearchParams();
  const from = $('#fromDate').value;
  const to = $('#toDate').value;
  if (from && to && from > to) throw new Error('开始日期不能晚于结束日期');
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const field = $('#filterField').value;
  const value = $('#filterValue').value.trim();
  if (field && value) params.set(`filter.${field}`, value);
  if ($('#searchText').value.trim()) params.set('q', $('#searchText').value.trim());
  return params;
}

function fillSelect(select, keys, current) {
  select.replaceChildren();
  for (const key of keys) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = label(key);
    select.append(option);
  }
  select.value = keys.includes(current) ? current : keys[0] || '';
}

function updateFields(fields) {
  const currentFilter = $('#filterField').value;
  const filter = $('#filterField');
  fillSelect(filter, ['', ...fields.dimensions.filter(key => !['day', 'month'].includes(key))], currentFilter);
  filter.options[0].textContent = '全部字段';
  fillSelect($('#groupBy'), fields.dimensions, $('#groupBy').value || 'day');
  fillSelect($('#metric'), fields.metrics, $('#metric').value || 'totalTokens');
}

function updateSummary(data) {
  $('#totalTokens').textContent = compact.format(data.totalTokens);
  $('#totalEvents').textContent = `${number.format(data.events)} 条记录`;
  $('#inputTokens').textContent = compact.format(data.inputTokens);
  $('#outputTokens').textContent = compact.format(data.outputTokens);
  $('#cacheTokens').textContent = compact.format(data.cacheReadTokens + data.cacheWriteTokens);
  $('#costUsd').textContent = data.costKnownEvents ? money.format(data.costUsd) : '—';
  $('#costNote').textContent = data.costKnownEvents ? `${number.format(data.costKnownEvents)} / ${number.format(data.events)} 条有费用数据` : '来源未提供费用数据';
}

function updateChart(rows) {
  const root = $('#dailyChart');
  root.replaceChildren();
  if (!rows.length) { root.innerHTML = '<div class="chart-empty">此范围内没有每日数据</div>'; return; }
  const max = Math.max(...rows.map(row => Number(row.value) || 0), 1);
  const visible = rows.slice(0, 36).reverse();
  visible.forEach((row, index) => {
    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    bar.title = `${row.label} · ${number.format(row.value || 0)} Token`;
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.setProperty('--h', `${Math.max(1, (Number(row.value) || 0) / max * 100)}%`);
    bar.append(fill);
    if (index % Math.max(1, Math.ceil(visible.length / 7)) === 0 || index === visible.length - 1) {
      const date = document.createElement('label');
      date.textContent = String(row.label).slice(5);
      bar.append(date);
    }
    root.append(bar);
  });
}

function updateRanking(rows) {
  const root = $('#agentRanking');
  if (!rows.length) { root.innerHTML = '<div class="ranking-empty">暂无 Agent 数据</div>'; return; }
  const max = Math.max(Number(rows[0].value) || 0, 1);
  root.innerHTML = rows.slice(0, 6).map((row, index) => `<div class="rank-row"><span class="rank-num">${String(index + 1).padStart(2, '0')}</span><div class="rank-name"><strong>${escapeHtml(row.label || '未标记')}</strong><div class="rank-track"><div class="rank-fill" style="width:${Math.max(2, Math.min(100, Number(row.value) / max * 100))}%"></div></div></div><span class="rank-value">${escapeHtml(compact.format(row.value || 0))}</span></div>`).join('');
}

function updateStats(rows, metric) {
  const root = $('#statsRows');
  if (!rows.length) { root.innerHTML = '<tr><td colspan="4" class="empty-row">当前筛选范围没有数据</td></tr>'; return; }
  const max = Math.max(...rows.map(row => Number(row.value) || 0), 1);
  root.innerHTML = rows.map(row => {
    const value = metric === 'costUsd' ? money.format(row.value || 0) : number.format(row.value || 0);
    const width = Math.max(1, Math.min(100, (Number(row.value) || 0) / max * 100));
    return `<tr><td><strong>${escapeHtml(row.label ?? '未标记')}</strong></td><td class="mono">${escapeHtml(value)}</td><td class="mono">${number.format(row.events)}</td><td><div class="table-bar"><span style="width:${width}%"></span></div></td></tr>`;
  }).join('');
}

function updateEvents(rows) {
  const root = $('#eventRows');
  if (!rows.length) { root.innerHTML = '<tr><td colspan="7" class="empty-row">暂无记录</td></tr>'; return; }
  root.innerHTML = rows.map(row => {
    const extras = Object.entries(row.extensions || {}).slice(0, 5).map(([key, value]) => `<span class="badge">${escapeHtml(key)}: ${escapeHtml(value)}</span>`).join('');
    const cache = row.cacheReadTokens + row.cacheWriteTokens;
    return `<tr><td class="mono">${escapeHtml(row.occurredAt.slice(0, 16).replace('T', ' '))}</td><td><strong>${escapeHtml(row.agent)}</strong><small>${escapeHtml(row.model || '模型未标记')}</small></td><td class="mono"><strong>${number.format(row.totalTokens)}</strong></td><td class="mono">${number.format(row.inputTokens)}</td><td class="mono">${number.format(row.outputTokens)}</td><td class="mono">${number.format(cache)}</td><td>${extras || '—'}</td></tr>`;
  }).join('');
}

async function load() {
  const params = currentParams();
  const groupBy = $('#groupBy').value || 'day';
  const metric = $('#metric').value || 'totalTokens';
  const chartParams = new URLSearchParams(params);
  chartParams.set('groupBy', 'day'); chartParams.set('metric', 'totalTokens'); chartParams.set('limit', '500');
  const rankParams = new URLSearchParams(params);
  rankParams.set('groupBy', 'agent'); rankParams.set('metric', 'totalTokens'); rankParams.set('limit', '6');
  const statsParams = new URLSearchParams(params);
  statsParams.set('groupBy', groupBy); statsParams.set('metric', metric); statsParams.set('limit', '100');
  const eventParams = new URLSearchParams(params);
  eventParams.set('limit', '100');
  const [fields, summary, chart, ranking, stats, events] = await Promise.all([
    api('/api/v1/fields'), api('/api/v1/summary', params),
    api('/api/v1/stats', chartParams), api('/api/v1/stats', rankParams),
    api('/api/v1/stats', statsParams), api('/api/v1/events', eventParams),
  ]);
  updateFields(fields);
  updateSummary(summary);
  updateChart(chart.rows);
  updateRanking(ranking.rows);
  updateStats(stats.rows, metric);
  updateEvents(events.rows);
  $('#connectionText').textContent = '已连接';
}

async function attemptLoad() {
  try {
    await load();
    $('#loginOverlay').classList.add('hidden');
  } catch (error) {
    if (error.message === 'TOKEN_INVALID') {
      token = '';
      sessionStorage.removeItem('agentUsageAdminToken');
      $('#loginOverlay').classList.remove('hidden');
      $('#loginError').textContent = '管理 Token 无效，请重新输入。';
      $('#connectionText').textContent = '需要认证';
    } else toast(error.message);
  }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  token = $('#adminToken').value.trim();
  $('#loginError').textContent = '';
  sessionStorage.setItem('agentUsageAdminToken', token);
  await attemptLoad();
});
$('#applyButton').addEventListener('click', attemptLoad);
$('#refreshButton').addEventListener('click', attemptLoad);
$('#groupBy').addEventListener('change', attemptLoad);
$('#metric').addEventListener('change', attemptLoad);
$('#searchText').addEventListener('keydown', event => { if (event.key === 'Enter') attemptLoad(); });

const today = new Date();
const start = new Date(today);
start.setUTCDate(start.getUTCDate() - 29);
$('#fromDate').value = start.toISOString().slice(0, 10);
$('#toDate').value = today.toISOString().slice(0, 10);
if (token) attemptLoad();
