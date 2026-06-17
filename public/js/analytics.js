import { ensureAuth, adminFetch, logout } from '/js/admin/auth.js';

let charts = {};
let refreshInterval = null;

async function init() {
  const user = await ensureAuth();
  if (!user) return;
  document.getElementById('userFullName').textContent = user.fullName || user.full_name || user.username;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('adminBtn').addEventListener('click', () => window.location.href = '/admin.html');
  document.getElementById('refreshBtn').addEventListener('click', loadAnalytics);

  const themeBtn = document.getElementById('themeBtn');
  themeBtn.addEventListener('click', () => {
    const html = document.documentElement;
    html.setAttribute('data-theme', html.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
    try { localStorage.setItem('theme', html.getAttribute('data-theme')); } catch {}
  });
  try {
    const saved = localStorage.getItem('theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch {}

  await loadAnalytics();
  refreshInterval = setInterval(loadAnalytics, 30000);
}

async function loadAnalytics() {
  try {
    const res = await adminFetch('/api/analytics');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data);
  } catch (e) {
    console.error('[Analytics] Failed to load:', e);
    document.getElementById('app').innerHTML = `<div class="empty-state">Ошибка загрузки: ${e.message}</div>`;
  }
}

function render(data) {
  document.getElementById('lastUpdated').textContent = new Date(data.timestamp).toLocaleTimeString();

  const { inApp, docker, redis, postgres, queues, system } = data;
  const parts = [];

  parts.push(renderSummaryCards(inApp, docker, system));
  if (inApp) parts.push(renderCharts(inApp));
  if (system) parts.push(renderSystem(system));
  if (docker) parts.push(renderDocker(docker));
  if (redis) parts.push(renderRedis(redis));
  if (postgres) parts.push(renderPostgres(postgres));
  if (queues) parts.push(renderQueues(queues));
  parts.push(renderFooter(data));

  document.getElementById('app').innerHTML = parts.join('');
  initCharts(data);
}

function fmt(s) {
  if (s === undefined || s === null) return '—';
  return s;
}

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function fmtUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}д`);
  if (h > 0) parts.push(`${h}ч`);
  if (m > 0) parts.push(`${m}м`);
  if (s > 0 || parts.length === 0) parts.push(`${s}с`);
  return parts.join(' ');
}

function renderSummaryCards(inApp, docker, system) {
  const uptime = inApp?.uptime || 0;
  const reqs = inApp?.requests?.total || 0;
  const errors = inApp?.requests?.errors || 0;
  const errRate = inApp?.requests?.errorRate || '0%';
  const containers = docker?.total || 0;
  const running = docker?.running || 0;
  const cpu = system?.cpu?.usage || 0;
  const mem = system?.memory?.usagePercent || '0';

  let extraCards = '';
  if (docker) {
    extraCards += `
      <div class="card" style="padding:16px;">
        <div class="card-value">${running}/${containers}</div>
        <div class="card-label">Контейнеры (запущено/всего)</div>
      </div>`;
  }
  if (system) {
    extraCards += `
      <div class="card" style="padding:16px;">
        <div class="card-value">${cpu}%</div>
        <div class="card-label">CPU</div>
      </div>
      <div class="card" style="padding:16px;">
        <div class="card-value">${mem}%</div>
        <div class="card-label">Память</div>
      </div>`;
  }

  return `
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        <div class="card-value">${fmtUptime(uptime)}</div>
        <div class="card-label">Аптайм</div>
      </div>
      <div class="card" style="padding:16px;">
        <div class="card-value">${reqs.toLocaleString()}</div>
        <div class="card-label">Запросов</div>
      </div>
      <div class="card" style="padding:16px;">
        <div class="card-value">${errors.toLocaleString()}</div>
        <div class="card-label">Ошибок (${errRate})</div>
      </div>
      ${extraCards}
    </div>`;
}

function renderCharts(inApp) {
  const r = inApp.requests;
  const d = inApp.database;
  return `
    <div class="section-title">Метрики приложения</div>
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        <div class="card-label">Время ответа (мс)</div>
        <div class="chart-container"><canvas id="chartResponseTime"></canvas></div>
      </div>
      <div class="card" style="padding:16px;">
        <div class="card-label">Статус запросов</div>
        <div class="chart-container"><canvas id="chartRequestStatus"></canvas></div>
      </div>
      <div class="card" style="padding:16px;">
        <div class="card-label">Методы запросов</div>
        <div class="chart-container"><canvas id="chartMethods"></canvas></div>
      </div>
      <div class="card" style="padding:16px;">
        <div class="card-label">Метрики БД</div>
        <div style="padding:8px 0;">
          <div class="card-row"><span class="label">Запросов</span><span class="value">${d?.queries?.toLocaleString() || '—'}</span></div>
          <div class="card-row"><span class="label">Ошибок</span><span class="value">${d?.errors?.toLocaleString() || '—'} (${d?.errorRate || '0%'})</span></div>
          <div class="card-row"><span class="label">Медленных</span><span class="value">${d?.slowQueries?.toLocaleString() || '—'}</span></div>
          <div class="card-row"><span class="label">Среднее время</span><span class="value">${d?.queryTime?.avg || '—'} мс</span></div>
          <div class="card-row"><span class="label">p95</span><span class="value">${d?.queryTime?.p95 || '—'} мс</span></div>
        </div>
      </div>
    </div>`;
}

function renderSystem(system) {
  const cpu = system.cpu;
  const mem = system.memory;
  const p = mem.process;
  return `
    <div class="section-title">Система</div>
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        <div style="margin-bottom:8px;font-weight:600;">CPU</div>
        <div class="card-row"><span class="label">Модель</span><span class="value">${fmt(cpu?.model)}</span></div>
        <div class="card-row"><span class="label">Ядер</span><span class="value">${fmt(cpu?.count)}</span></div>
        <div class="card-row"><span class="label">Загрузка</span><span class="value">${fmt(cpu?.usage)}%</span></div>
        <div class="card-row"><span class="label">Load Avg</span><span class="value">${cpu?.loadAverage?.map(v => v.toFixed(2)).join(' / ') || '—'}</span></div>
      </div>
      <div class="card" style="padding:16px;">
        <div style="margin-bottom:8px;font-weight:600;">Память</div>
        <div class="card-row"><span class="label">Всего</span><span class="value">${fmtBytes(mem?.total)}</span></div>
        <div class="card-row"><span class="label">Использовано</span><span class="value">${fmtBytes(mem?.used)} (${mem?.usagePercent}%)</span></div>
        <div class="card-row"><span class="label">Свободно</span><span class="value">${fmtBytes(mem?.free)}</span></div>
        <div class="card-row"><span class="label">Node RSS</span><span class="value">${fmtBytes(p?.rss)}</span></div>
        <div class="card-row"><span class="label">Heap</span><span class="value">${fmtBytes(p?.heapUsed)} / ${fmtBytes(p?.heapTotal)}</span></div>
      </div>
      <div class="card" style="padding:16px;">
        <div style="margin-bottom:8px;font-weight:600;">Хост</div>
        <div class="card-row"><span class="label">Hostname</span><span class="value">${fmt(system.hostname)}</span></div>
        <div class="card-row"><span class="label">Платформа</span><span class="value">${fmt(system.platform)} ${fmt(system.arch)}</span></div>
        <div class="card-row"><span class="label">Node.js</span><span class="value">${fmt(system.nodeVersion)}</span></div>
        <div class="card-row"><span class="label">Uptime</span><span class="value">${fmtUptime(system.uptime)}</span></div>
      </div>
    </div>`;
}

function renderDocker(docker) {
  const rows = docker.containers.map(c => `
    <div class="card-row">
      <span class="label">
        <span class="status-dot ${c.status?.includes('Up') ? 'up' : 'down'}"></span>
        ${c.name}
        <span style="font-size:0.75rem;color:var(--muted,#6c7086);margin-left:4px;">${c.id}</span>
      </span>
      <span class="value">
        ${fmt(c.status?.split(' ')[0])} | CPU: ${c.cpuPercent || '—'} | RAM: ${c.memoryPercent || '—'}
      </span>
    </div>`).join('');

  return `
    <div class="section-title">Docker контейнеры (${docker.running}/${docker.total})</div>
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        ${rows || '<div class="empty-state">Нет контейнеров</div>'}
      </div>
    </div>`;
}

function renderRedis(redis) {
  return `
    <div class="section-title">Redis</div>
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        <div class="card-row"><span class="label">Версия</span><span class="value">${fmt(redis.version)}</span></div>
        <div class="card-row"><span class="label">Роль</span><span class="value">${fmt(redis.role)}</span></div>
        <div class="card-row"><span class="label">Аптайм</span><span class="value">${fmtUptime(redis.uptime)}</span></div>
        <div class="card-row"><span class="label">Клиенты</span><span class="value">${fmt(redis.connectedClients)}</span></div>
        <div class="card-row"><span class="label">Память</span><span class="value">${fmt(redis.usedMemoryHuman)}</span></div>
        <div class="card-row"><span class="label">Команд всего</span><span class="value">${(redis.totalCommands || 0).toLocaleString()}</span></div>
        <div class="card-row"><span class="label">Hit Rate</span><span class="value">${fmt(redis.hitRate)}</span></div>
        <div class="card-row"><span class="label">Connections</span><span class="value">${(redis.totalConnections || 0).toLocaleString()}</span></div>
      </div>
    </div>`;
}

function renderPostgres(pg) {
  return `
    <div class="section-title">PostgreSQL</div>
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        <div class="card-row"><span class="label">Версия</span><span class="value">${fmt(pg.version)}</span></div>
        <div class="card-row"><span class="label">Размер БД</span><span class="value">${fmtBytes(pg.databaseSize)}</span></div>
        <div class="card-row"><span class="label">Активные соединения</span><span class="value">${fmt(pg.activeConnections)}</span></div>
        <div class="card-row"><span class="label">Backends</span><span class="value">${fmt(pg.backends)}</span></div>
        <div class="card-row"><span class="label">Commit / Rollback</span><span class="value">${(pg.transactions?.commit || 0).toLocaleString()} / ${(pg.transactions?.rollback || 0).toLocaleString()}</span></div>
        <div class="card-row"><span class="label">Cache Hit Ratio</span><span class="value">${fmt(pg.cacheHitRatio)}</span></div>
      </div>
    </div>`;
}

function renderQueues(queues) {
  const rows = Object.entries(queues).map(([name, stats]) => {
    if (!stats) return `<div class="card-row"><span class="label">${name}</span><span class="value">Ошибка</span></div>`;
    return `
      <div style="margin-bottom:12px;">
        <div style="font-weight:600;margin-bottom:8px;">${name}</div>
        <div class="card-row"><span class="label">Ожидают</span><span class="value">${stats.waiting || 0}</span></div>
        <div class="card-row"><span class="label">Активны</span><span class="value">${stats.active || 0}</span></div>
        <div class="card-row"><span class="label">Завершены</span><span class="value">${stats.completed || 0}</span></div>
        <div class="card-row"><span class="label">Ошибки</span><span class="value">${stats.failed || 0}</span></div>
        <div class="card-row"><span class="label">Отложены</span><span class="value">${stats.delayed || 0}</span></div>
      </div>`;
  }).join('');

  return `
    <div class="section-title">Очереди Bull</div>
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        ${rows}
      </div>
    </div>`;
}

function renderFooter(data) {
  return `
    <div style="text-align:center;padding:16px;color:var(--muted,#6c7086);font-size:0.8rem;">
      Собрано за ${data.collectTimeMs} мс • ${new Date(data.timestamp).toLocaleString()}
    </div>`;
}

function initCharts(data) {
  const inApp = data.inApp;
  if (!inApp) return;

  Object.values(charts).forEach(c => { try { c.destroy(); } catch {} });
  charts = {};

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
  const textColor = isDark ? '#cdd6f4' : '#333';
  const chartDefaults = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: textColor } } }, scales: { x: { ticks: { color: textColor }, grid: { color: gridColor } }, y: { ticks: { color: textColor }, grid: { color: gridColor } } } };

  // Response time chart
  const rtEl = document.getElementById('chartResponseTime');
  if (rtEl && inApp.requests?.responseTime) {
    const rt = inApp.requests.responseTime;
    charts.responseTime = new Chart(rtEl, {
      type: 'bar',
      data: {
        labels: ['Среднее', 'p50', 'p95', 'p99'],
        datasets: [{
          label: 'мс',
          data: [rt.avg, rt.p50, rt.p95, rt.p99],
          backgroundColor: ['#3b82f6', '#22c55e', '#eab308', '#ef4444'],
          borderRadius: 4
        }]
      },
      options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { display: false } } }
    });
  }

  // Request status doughnut
  const rsEl = document.getElementById('chartRequestStatus');
  if (rsEl && inApp.requests) {
    const ok = inApp.requests.total - inApp.requests.errors;
    charts.requestStatus = new Chart(rsEl, {
      type: 'doughnut',
      data: {
        labels: ['Успешно', 'Ошибки'],
        datasets: [{
          data: [Math.max(ok, 0), inApp.requests.errors],
          backgroundColor: ['#22c55e', '#ef4444']
        }]
      },
      options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { position: 'bottom', labels: { color: textColor } } } }
    });
  }

  // Methods chart
  const mtEl = document.getElementById('chartMethods');
  if (mtEl && inApp.requests?.byMethod) {
    const methods = inApp.requests.byMethod;
    const labels = Object.keys(methods);
    const values = labels.map(m => methods[m].total);
    charts.methods = new Chart(mtEl, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Запросов',
          data: values,
          backgroundColor: ['#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7'],
          borderRadius: 4
        }]
      },
      options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { display: false } } }
    });
  }
}

init();
