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

  const { inApp, docker, redis, postgres, queues, system, flowMap, nginx, replicaMetrics } = data;
  const parts = [];

  parts.push(renderSummaryCards(inApp, docker, system, nginx));
  if (flowMap) parts.push(renderFlowMap(flowMap));
  if (inApp) parts.push(renderCharts(inApp));
  if (system) parts.push(renderSystem(system));
  if (docker) parts.push(renderDocker(docker));
  if (nginx) parts.push(renderNginxStats(nginx));
  if (replicaMetrics) parts.push(renderReplicaMetrics(replicaMetrics));
  if (redis) parts.push(renderRedis(redis));
  if (postgres) parts.push(renderPostgres(postgres));
  if (queues) parts.push(renderQueues(queues));
  parts.push(renderFooter(data));

  document.getElementById('app').innerHTML = parts.join('');
  initCharts(data);
  initFlowInteractions();
}

function fmt(s) {
  if (s === undefined || s === null) return '\u2014';
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
  if (!seconds) return '\u2014';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}\u0434`);
  if (h > 0) parts.push(`${h}\u0447`);
  if (m > 0) parts.push(`${m}\u043C`);
  if (s > 0 || parts.length === 0) parts.push(`${s}\u0441`);
  return parts.join(' ');
}

function renderSummaryCards(inApp, docker, system, nginx) {
  const uptime = inApp?.uptime || 0;
  const reqs = inApp?.requests?.total || 0;
  const errors = inApp?.requests?.errors || 0;
  const errRate = inApp?.requests?.errorRate || '0%';
  const containers = docker?.total || 0;
  const running = docker?.running || 0;
  const cpu = system?.cpu?.usage || 0;
  const mem = system?.memory?.usagePercent || '0';
  const nginxReqs = nginx?.total || 0;

  let extraCards = '';
  if (docker) {
    extraCards += `
      <div class="card" style="padding:16px;">
        <div class="card-value">${running}/${containers}</div>
        <div class="card-label">\u041A\u043E\u043D\u0442\u0435\u0439\u043D\u0435\u0440\u044B (\u0437\u0430\u043F\u0443\u0449\u0435\u043D\u043E/\u0432\u0441\u0435\u0433\u043E)</div>
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
        <div class="card-label">\u041F\u0430\u043C\u044F\u0442\u044C</div>
      </div>`;
  }
  if (nginxReqs > 0) {
    extraCards += `
      <div class="card" style="padding:16px;">
        <div class="card-value">${nginxReqs.toLocaleString()}</div>
        <div class="card-label">NGINX \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432</div>
      </div>`;
  }

  return `
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        <div class="card-value">${fmtUptime(uptime)}</div>
        <div class="card-label">\u0410\u043F\u0442\u0430\u0439\u043C</div>
      </div>
      <div class="card" style="padding:16px;">
        <div class="card-value">${reqs.toLocaleString()}</div>
        <div class="card-label">\u0417\u0430\u043F\u0440\u043E\u0441\u043E\u0432</div>
      </div>
      <div class="card" style="padding:16px;">
        <div class="card-value">${errors.toLocaleString()}</div>
        <div class="card-label">\u041E\u0448\u0438\u0431\u043E\u043A (${errRate})</div>
      </div>
      ${extraCards}
    </div>`;
}

function renderFlowMap(flowMap) {
  if (!flowMap.nodes || flowMap.nodes.length === 0) return '';
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const colors = isDark
    ? { bg: '#1e1e2e', text: '#cdd6f4', muted: '#6c7086', border: '#313244', accent: '#3b82f6', green: '#22c55e', red: '#ef4444', yellow: '#eab308' }
    : { bg: '#ffffff', text: '#333333', muted: '#888888', border: '#cccccc', accent: '#3b82f6', green: '#22c55e', red: '#ef4444', yellow: '#eab308' };

  const nodeColors = {
    source: '#22c55e',
    lb: '#eab308',
    app: '#3b82f6',
    service: '#6c7086'
  };

  const nodes = flowMap.nodes;
  const edges = flowMap.edges;

  const gapX = 220;
  const gapY = 120;
  const nodeW = 170;
  const nodeH = 56;

  const positions = {};
  const layers = { source: 0, lb: 1, app: 2, service: 3 };

  const byLayer = {};
  for (const n of nodes) {
    const l = layers[n.type] || 0;
    if (!byLayer[l]) byLayer[l] = [];
    byLayer[l].push(n);
  }

  for (const [layerIdx, layerNodes] of Object.entries(byLayer)) {
    const ln = parseInt(layerIdx);
    const startX = 60;
    let x = startX;
    const y = 50 + ln * (nodeH + gapY);
    for (const n of layerNodes) {
      positions[n.id] = { x, y };
      x += nodeW + gapX;
    }
  }

  let svgW = 200;
  let svgH = 200;
  for (const [id, pos] of Object.entries(positions)) {
    svgW = Math.max(svgW, pos.x + nodeW + 60);
    svgH = Math.max(svgH, pos.y + nodeH + 60);
  }

  const edgeLines = edges.map(e => {
    const from = positions[e.from];
    const to = positions[e.to];
    if (!from || !to) return '';
    const x1 = from.x + nodeW / 2;
    const y1 = from.y + nodeH;
    const x2 = to.x + nodeW / 2;
    const y2 = to.y;
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const reqs = e.requests ? e.requests.toLocaleString() : (e.requests === undefined ? '' : '0');
    return `
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colors.muted}" stroke-width="2" stroke-dasharray="6,3" class="flow-edge" data-from="${e.from}" data-to="${e.to}" data-label="${e.label}" data-requests="${reqs}"/>
      <text x="${midX}" y="${midY - 8}" text-anchor="middle" fill="${colors.muted}" font-size="11" class="flow-edge-label">${e.label}${reqs ? ' [' + reqs + ']' : ''}</text>
    `;
  }).join('');

  const nodeRects = nodes.map(n => {
    const pos = positions[n.id];
    if (!pos) return '';
    const color = nodeColors[n.type] || colors.accent;
    let details = '';
    if (n.requests !== undefined) details += `\u0417\u0430\u043F\u0440: ${n.requests.toLocaleString()}\n`;
    if (n.socketConns !== undefined) details += `Socket: ${n.socketConns}\n`;
    if (n.commands !== undefined) details += `\u041A\u043E\u043C\u0430\u043D\u0434: ${n.commands.toLocaleString()}\n`;
    if (n.clients !== undefined) details += `\u041A\u043B\u0438\u0435\u043D\u0442\u044B: ${n.clients}\n`;
    if (n.cpu) details += `CPU: ${n.cpu}\n`;
    if (n.mem) details += `RAM: ${n.mem}\n`;
    if (n.version) details += `v${n.version}`;
    if (n.memory) details += `\u041F\u0430\u043C\u044F\u0442\u044C: ${n.memory}`;

    const statusDot = n.status?.includes('Up')
      ? `<circle cx="${pos.x + nodeW - 12}" cy="${pos.y + 12}" r="5" fill="${colors.green}"/>`
      : n.status
        ? `<circle cx="${pos.x + nodeW - 12}" cy="${pos.y + 12}" r="5" fill="${colors.red}"/>`
        : '';

    return `
      <g class="flow-node" data-id="${n.id}" data-details="${details.replace(/"/g, '&quot;').trim()}">
        <rect x="${pos.x}" y="${pos.y}" width="${nodeW}" height="${nodeH}" rx="10" fill="${color}" opacity="0.15" stroke="${color}" stroke-width="2" class="flow-node-bg"/>
        ${statusDot}
        <text x="${pos.x + nodeW / 2}" y="${pos.y + nodeH / 2 + 5}" text-anchor="middle" fill="${colors.text}" font-size="13" font-weight="600">${n.label}</text>
      </g>
    `;
  }).join('');

  return `
    <div class="section-title">\u041A\u0430\u0440\u0442\u0430 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432</div>
    <div class="flow-controls">
      <button id="flowZoomFit" type="button">\u041F\u043E \u0440\u0430\u0437\u043C\u0435\u0440\u0443</button>
      <label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;color:var(--muted,#6c7086);">
        \u041C\u0430\u0441\u0448\u0442\u0430\u0431:
        <input type="range" id="flowZoomRange" min="25" max="200" value="100" style="width:100px;">
        <span id="flowZoomPct">100%</span>
      </label>
      <button id="flowFullscreenBtn" type="button">\uD83D\uDDD2 \u041D\u0430 \u0432\u0435\u0441\u044C \u044D\u043A\u0440\u0430\u043D</button>
    </div>
    <div class="analytics-grid" style="overflow:visible;">
      <div class="card flow-map-container" style="padding:0;position:relative;">
        <div id="flowSvgWrapper" style="overflow:auto;width:100%;min-height:500px;max-height:700px;">
          <svg id="flowSvg" viewBox="0 0 ${svgW} ${svgH}" style="width:${Math.max(svgW, 900)}px;height:auto;display:block;" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill="${colors.muted}"/>
              </marker>
            </defs>
            <rect width="${svgW}" height="${svgH}" fill="transparent"/>
            ${edgeLines}
            ${nodeRects}
          </svg>
        </div>
        <div id="flowTooltip" style="display:none;position:absolute;background:${colors.bg};border:1px solid ${colors.border};border-radius:6px;padding:8px 12px;font-size:0.85rem;color:${colors.text};pointer-events:none;z-index:100;white-space:pre-line;max-width:280px;box-shadow:0 4px 12px rgba(0,0,0,0.3);"></div>
      </div>
    </div>`;
}

function initFlowInteractions() {
  const tooltip = document.getElementById('flowTooltip');
  const svg = document.getElementById('flowSvg');
  const wrapper = document.getElementById('flowSvgWrapper');
  if (!svg) return;

  const zoomRange = document.getElementById('flowZoomRange');
  const zoomPct = document.getElementById('flowZoomPct');
  const zoomFit = document.getElementById('flowZoomFit');
  const fsBtn = document.getElementById('flowFullscreenBtn');
  const container = svg.closest('.flow-map-container');

  if (zoomRange && zoomPct) {
    zoomRange.addEventListener('input', () => {
      const scale = parseInt(zoomRange.value) / 100;
      svg.style.transform = `scale(${scale})`;
      svg.style.transformOrigin = 'top left';
      zoomPct.textContent = zoomRange.value + '%';
    });
  }

  if (zoomFit && svg) {
    zoomFit.addEventListener('click', () => {
      const parentW = wrapper.clientWidth - 20;
      const scale = Math.min(1, parentW / svg.scrollWidth) * 100;
      zoomRange.value = Math.round(scale);
      zoomRange.dispatchEvent(new Event('input'));
    });
  }

  if (fsBtn && container) {
    fsBtn.addEventListener('click', () => {
      container.classList.toggle('fullscreen');
      if (container.classList.contains('fullscreen')) {
        wrapper.style.maxHeight = 'none';
        wrapper.style.minHeight = 'calc(100vh - 80px)';
        setTimeout(() => zoomFit?.click(), 100);
      } else {
        wrapper.style.maxHeight = '700px';
        wrapper.style.minHeight = '500px';
      }
    });
  }

  if (!tooltip) return;

  let tooltipTimeout;
  function showTooltip(e, text) {
    clearTimeout(tooltipTimeout);
    tooltip.textContent = text;
    tooltip.style.display = 'block';
    const rect = container.getBoundingClientRect();
    let left = e.clientX - rect.left + 14;
    let top = e.clientY - rect.top - 10;
    if (left + 280 > rect.width) left = rect.width - 290;
    if (top < 0) top = e.clientY - rect.top + 20;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }
  function hideTooltip() {
    tooltipTimeout = setTimeout(() => { tooltip.style.display = 'none'; }, 100);
  }

  document.querySelectorAll('.flow-node').forEach(el => {
    el.addEventListener('mouseenter', (e) => {
      const details = el.dataset.details;
      if (!details) return;
      showTooltip(e, details);
    });
    el.addEventListener('mousemove', (e) => {
      const details = el.dataset.details;
      if (!details) return;
      showTooltip(e, details);
    });
    el.addEventListener('mouseleave', hideTooltip);
  });

  document.querySelectorAll('.flow-edge').forEach(el => {
    el.addEventListener('mouseenter', (e) => {
      showTooltip(e, `${el.dataset.label}: ${el.dataset.requests || '0'} \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432`);
    });
    el.addEventListener('mousemove', (e) => {
      showTooltip(e, `${el.dataset.label}: ${el.dataset.requests || '0'} \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432`);
    });
    el.addEventListener('mouseleave', hideTooltip);
  });
}

function renderCharts(inApp) {
  const r = inApp.requests;
  const d = inApp.database;
  return `
    <div class="section-title">\u041C\u0435\u0442\u0440\u0438\u043A\u0438 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u044F</div>
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        <div class="card-label">\u0412\u0440\u0435\u043C\u044F \u043E\u0442\u0432\u0435\u0442\u0430 (\u043C\u0441)</div>
        <div class="chart-container"><canvas id="chartResponseTime"></canvas></div>
      </div>
      <div class="card" style="padding:16px;">
        <div class="card-label">\u0421\u0442\u0430\u0442\u0443\u0441 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432</div>
        <div class="chart-container"><canvas id="chartRequestStatus"></canvas></div>
      </div>
      <div class="card" style="padding:16px;">
        <div class="card-label">\u041C\u0435\u0442\u043E\u0434\u044B \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432</div>
        <div class="chart-container"><canvas id="chartMethods"></canvas></div>
      </div>
      <div class="card" style="padding:16px;">
        <div class="card-label">\u041C\u0435\u0442\u0440\u0438\u043A\u0438 \u0411\u0414</div>
        <div style="padding:8px 0;">
          <div class="card-row"><span class="label">\u0417\u0430\u043F\u0440\u043E\u0441\u043E\u0432</span><span class="value">${d?.queries?.toLocaleString() || '\u2014'}</span></div>
          <div class="card-row"><span class="label">\u041E\u0448\u0438\u0431\u043E\u043A</span><span class="value">${d?.errors?.toLocaleString() || '\u2014'} (${d?.errorRate || '0%'})</span></div>
          <div class="card-row"><span class="label">\u041C\u0435\u0434\u043B\u0435\u043D\u043D\u044B\u0445</span><span class="value">${d?.slowQueries?.toLocaleString() || '\u2014'}</span></div>
          <div class="card-row"><span class="label">\u0421\u0440\u0435\u0434\u043D\u0435\u0435 \u0432\u0440\u0435\u043C\u044F</span><span class="value">${d?.queryTime?.avg || '\u2014'} \u043C\u0441</span></div>
          <div class="card-row"><span class="label">p95</span><span class="value">${d?.queryTime?.p95 || '\u2014'} \u043C\u0441</span></div>
        </div>
      </div>
    </div>`;
}

function renderSystem(system) {
  const cpu = system.cpu;
  const mem = system.memory;
  const p = mem.process;
  return `
    <div class="section-title">\u0421\u0438\u0441\u0442\u0435\u043C\u0430</div>
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        <div style="margin-bottom:8px;font-weight:600;">CPU</div>
        <div class="card-row"><span class="label">\u041C\u043E\u0434\u0435\u043B\u044C</span><span class="value">${fmt(cpu?.model)}</span></div>
        <div class="card-row"><span class="label">\u042F\u0434\u0435\u0440</span><span class="value">${fmt(cpu?.count)}</span></div>
        <div class="card-row"><span class="label">\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430</span><span class="value">${fmt(cpu?.usage)}%</span></div>
        <div class="card-row"><span class="label">Load Avg</span><span class="value">${cpu?.loadAverage?.map(v => v.toFixed(2)).join(' / ') || '\u2014'}</span></div>
      </div>
      <div class="card" style="padding:16px;">
        <div style="margin-bottom:8px;font-weight:600;">\u041F\u0430\u043C\u044F\u0442\u044C</div>
        <div class="card-row"><span class="label">\u0412\u0441\u0435\u0433\u043E</span><span class="value">${fmtBytes(mem?.total)}</span></div>
        <div class="card-row"><span class="label">\u0418\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u043E</span><span class="value">${fmtBytes(mem?.used)} (${mem?.usagePercent}%)</span></div>
        <div class="card-row"><span class="label">\u0421\u0432\u043E\u0431\u043E\u0434\u043D\u043E</span><span class="value">${fmtBytes(mem?.free)}</span></div>
        <div class="card-row"><span class="label">Node RSS</span><span class="value">${fmtBytes(p?.rss)}</span></div>
        <div class="card-row"><span class="label">Heap</span><span class="value">${fmtBytes(p?.heapUsed)} / ${fmtBytes(p?.heapTotal)}</span></div>
      </div>
      <div class="card" style="padding:16px;">
        <div style="margin-bottom:8px;font-weight:600;">\u0425\u043E\u0441\u0442</div>
        <div class="card-row"><span class="label">Hostname</span><span class="value">${fmt(system.hostname)}</span></div>
        <div class="card-row"><span class="label">\u041F\u043B\u0430\u0442\u0444\u043E\u0440\u043C\u0430</span><span class="value">${fmt(system.platform)} ${fmt(system.arch)}</span></div>
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
        ${fmt(c.status?.split(' ')[0])} | CPU: ${c.cpuPercent || '\u2014'} | RAM: ${c.memoryPercent || '\u2014'}
      </span>
    </div>`).join('');

  return `
    <div class="section-title">Docker \u043A\u043E\u043D\u0442\u0435\u0439\u043D\u0435\u0440\u044B (${docker.running}/${docker.total})</div>
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        ${rows || '<div class="empty-state">\u041D\u0435\u0442 \u043A\u043E\u043D\u0442\u0435\u0439\u043D\u0435\u0440\u043E\u0432</div>'}
      </div>
    </div>`;
}

function renderNginxStats(nginx) {
  if (!nginx || !nginx.upstreams) return '';
  const upstreamRows = Object.entries(nginx.upstreams).sort((a, b) => b[1] - a[1]).map(([addr, count]) => {
    const pct = nginx.total > 0 ? ((count / nginx.total) * 100).toFixed(1) : 0;
    return `<div class="card-row"><span class="label">${addr}</span><span class="value">${count.toLocaleString()} (${pct}%)</span></div>`;
  }).join('');
  const statusRows = Object.entries(nginx.statusCodes || {}).sort((a, b) => b[1] - a[1]).map(([code, count]) => {
    return `<div class="card-row"><span class="label">${code}</span><span class="value">${count.toLocaleString()}</span></div>`;
  }).join('');

  return `
    <div class="section-title">NGINX (\u0432\u0441\u0435\u0433\u043E ${nginx.total.toLocaleString()} \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432)</div>
    <div class="analytics-grid two-col">
      <div class="card" style="padding:16px;">
        <div style="margin-bottom:8px;font-weight:600;">\u0423\u043F\u0441\u0442\u0440\u0438\u043C\u044B (replica)</div>
        ${upstreamRows || '<div class="empty-state">\u041D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445</div>'}
      </div>
      <div class="card" style="padding:16px;">
        <div style="margin-bottom:8px;font-weight:600;">HTTP \u0441\u0442\u0430\u0442\u0443\u0441\u044B</div>
        ${statusRows || '<div class="empty-state">\u041D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445</div>'}
      </div>
    </div>`;
}

function renderReplicaMetrics(replicaMetrics) {
  if (!replicaMetrics) return '';
  const rows = Object.entries(replicaMetrics).map(([name, m]) => {
    if (!m) return '';
    const reqs = m.requests?.total || 0;
    const errs = m.requests?.errors || 0;
    const socketAct = m.socket?.activeConnections || 0;
    const socketMsgs = m.socket?.messages || 0;
    const dbQ = m.database?.queries || 0;
    const rt = m.requests?.responseTime;
    return `
      <div style="margin-bottom:16px;">
        <div style="font-weight:600;margin-bottom:8px;">${name}</div>
        <div class="card-row"><span class="label">\u0417\u0430\u043F\u0440\u043E\u0441\u043E\u0432</span><span class="value">${reqs.toLocaleString()}</span></div>
        <div class="card-row"><span class="label">\u041E\u0448\u0438\u0431\u043E\u043A</span><span class="value">${errs.toLocaleString()}</span></div>
        <div class="card-row"><span class="label">Socket \u043A\u043B\u0438\u0435\u043D\u0442\u043E\u0432</span><span class="value">${socketAct.toLocaleString()}</span></div>
        <div class="card-row"><span class="label">Socket \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439</span><span class="value">${socketMsgs.toLocaleString()}</span></div>
        <div class="card-row"><span class="label">\u0417\u0430\u043F\u0440\u043E\u0441\u043E\u0432 \u043A \u0411\u0414</span><span class="value">${dbQ.toLocaleString()}</span></div>
        <div class="card-row"><span class="label">\u0421\u0440\u0435\u0434\u043D\u0435\u0435 \u0432\u0440\u0435\u043C\u044F \u043E\u0442\u0432\u0435\u0442\u0430</span><span class="value">${rt?.avg || '\u2014'} \u043C\u0441</span></div>
      </div>
    `;
  }).filter(Boolean).join('');

  return `
    <div class="section-title">\u041C\u0435\u0442\u0440\u0438\u043A\u0438 \u0440\u0435\u043F\u043B\u0438\u043A</div>
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        ${rows || '<div class="empty-state">\u041D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445</div>'}
      </div>
    </div>`;
}

function renderRedis(redis) {
  return `
    <div class="section-title">Redis</div>
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        <div class="card-row"><span class="label">\u0412\u0435\u0440\u0441\u0438\u044F</span><span class="value">${fmt(redis.version)}</span></div>
        <div class="card-row"><span class="label">\u0420\u043E\u043B\u044C</span><span class="value">${fmt(redis.role)}</span></div>
        <div class="card-row"><span class="label">\u0410\u043F\u0442\u0430\u0439\u043C</span><span class="value">${fmtUptime(redis.uptime)}</span></div>
        <div class="card-row"><span class="label">\u041A\u043B\u0438\u0435\u043D\u0442\u044B</span><span class="value">${fmt(redis.connectedClients)}</span></div>
        <div class="card-row"><span class="label">\u041F\u0430\u043C\u044F\u0442\u044C</span><span class="value">${fmt(redis.usedMemoryHuman)}</span></div>
        <div class="card-row"><span class="label">\u041A\u043E\u043C\u0430\u043D\u0434 \u0432\u0441\u0435\u0433\u043E</span><span class="value">${(redis.totalCommands || 0).toLocaleString()}</span></div>
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
        <div class="card-row"><span class="label">\u0412\u0435\u0440\u0441\u0438\u044F</span><span class="value">${fmt(pg.version)}</span></div>
        <div class="card-row"><span class="label">\u0420\u0430\u0437\u043C\u0435\u0440 \u0411\u0414</span><span class="value">${fmtBytes(pg.databaseSize)}</span></div>
        <div class="card-row"><span class="label">\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0435 \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u044F</span><span class="value">${fmt(pg.activeConnections)}</span></div>
        <div class="card-row"><span class="label">Backends</span><span class="value">${fmt(pg.backends)}</span></div>
        <div class="card-row"><span class="label">Commit / Rollback</span><span class="value">${(pg.transactions?.commit || 0).toLocaleString()} / ${(pg.transactions?.rollback || 0).toLocaleString()}</span></div>
        <div class="card-row"><span class="label">Cache Hit Ratio</span><span class="value">${fmt(pg.cacheHitRatio)}</span></div>
      </div>
    </div>`;
}

function renderQueues(queues) {
  const rows = Object.entries(queues).map(([name, stats]) => {
    if (!stats) return `<div class="card-row"><span class="label">${name}</span><span class="value">\u041E\u0448\u0438\u0431\u043A\u0430</span></div>`;
    return `
      <div style="margin-bottom:12px;">
        <div style="font-weight:600;margin-bottom:8px;">${name}</div>
        <div class="card-row"><span class="label">\u041E\u0436\u0438\u0434\u0430\u044E\u0442</span><span class="value">${stats.waiting || 0}</span></div>
        <div class="card-row"><span class="label">\u0410\u043A\u0442\u0438\u0432\u043D\u044B</span><span class="value">${stats.active || 0}</span></div>
        <div class="card-row"><span class="label">\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u044B</span><span class="value">${stats.completed || 0}</span></div>
        <div class="card-row"><span class="label">\u041E\u0448\u0438\u0431\u043A\u0438</span><span class="value">${stats.failed || 0}</span></div>
        <div class="card-row"><span class="label">\u041E\u0442\u043B\u043E\u0436\u0435\u043D\u044B</span><span class="value">${stats.delayed || 0}</span></div>
      </div>`;
  }).join('');

  return `
    <div class="section-title">\u041E\u0447\u0435\u0440\u0435\u0434\u0438 Bull</div>
    <div class="analytics-grid">
      <div class="card" style="padding:16px;">
        ${rows}
      </div>
    </div>`;
}

function renderFooter(data) {
  return `
    <div style="text-align:center;padding:16px;color:var(--muted,#6c7086);font-size:0.8rem;">
      \u0421\u043E\u0431\u0440\u0430\u043D\u043E \u0437\u0430 ${data.collectTimeMs} \u043C\u0441 • ${new Date(data.timestamp).toLocaleString()}
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

  const rtEl = document.getElementById('chartResponseTime');
  if (rtEl && inApp.requests?.responseTime) {
    const rt = inApp.requests.responseTime;
    charts.responseTime = new Chart(rtEl, {
      type: 'bar',
      data: {
        labels: ['\u0421\u0440\u0435\u0434\u043D\u0435\u0435', 'p50', 'p95', 'p99'],
        datasets: [{
          label: '\u043C\u0441',
          data: [rt.avg, rt.p50, rt.p95, rt.p99],
          backgroundColor: ['#3b82f6', '#22c55e', '#eab308', '#ef4444'],
          borderRadius: 4
        }]
      },
      options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { display: false } } }
    });
  }

  const rsEl = document.getElementById('chartRequestStatus');
  if (rsEl && inApp.requests) {
    const ok = inApp.requests.total - inApp.requests.errors;
    charts.requestStatus = new Chart(rsEl, {
      type: 'doughnut',
      data: {
        labels: ['\u0423\u0441\u043F\u0435\u0448\u043D\u043E', '\u041E\u0448\u0438\u0431\u043A\u0438'],
        datasets: [{
          data: [Math.max(ok, 0), inApp.requests.errors],
          backgroundColor: ['#22c55e', '#ef4444']
        }]
      },
      options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { position: 'bottom', labels: { color: textColor } } } }
    });
  }

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
          label: '\u0417\u0430\u043F\u0440\u043E\u0441\u043E\u0432',
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
