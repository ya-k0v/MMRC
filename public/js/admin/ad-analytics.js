import { ensureAuth, adminFetch } from './auth.js';
import { initThemeToggle } from '../theme.js';
import { escapeHtml } from '../shared/utils.js';

let adDevices = [];
let _lastData = null;

document.addEventListener('DOMContentLoaded', async () => {
  const themeBtn = document.getElementById('themeBtn');
  if (themeBtn) initThemeToggle(themeBtn, 'vc_theme_ad');
  try {
    const user = await ensureAuth();
    if (!user || user.role !== 'admin') { window.location.href = '/admin.html'; return; }
  } catch { return; }

  document.getElementById('backBtn').onclick = () => window.location.href = '/admin.html';

  const today = new Date();
  document.getElementById('filterTo').value = today.toISOString().substring(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  document.getElementById('filterFrom').value = weekAgo.toISOString().substring(0, 10);

  await loadAdDevices();
  document.getElementById('loadBtn').onclick = loadStats;
  document.getElementById('exportBtn').onclick = exportCsv;
  loadStats();
});

async function loadAdDevices() {
  try {
    const list = await (await adminFetch('/api/devices')).json();
    adDevices = list.filter(d => d.deviceType === 'ad_monitor' || d.device_id.startsWith('ad_'));
    const sel = document.getElementById('filterDevice');
    adDevices.forEach(d => { const o = document.createElement('option'); o.value = d.device_id; o.textContent = d.name || d.device_id; sel.appendChild(o); });
  } catch { adDevices = []; }
}

async function loadStats() {
  const params = new URLSearchParams();
  const from = document.getElementById('filterFrom').value;
  const to = document.getElementById('filterTo').value;
  if (from) params.set('from', from);
  if (to) params.set('to', to + 'T23:59:59');
  if (document.getElementById('filterDevice').value) params.set('device_id', document.getElementById('filterDevice').value);

  const res = await adminFetch(`/api/ad/analytics/stats?${params}`);
  _lastData = await res.json();
  renderResults(_lastData);
}

function aggregateByFile(rows) {
  const map = {};
  for (const r of rows) {
    const k = r.file_name;
    if (!map[k]) map[k] = { file_name: k, plays: 0, completed: 0, totalDuration: 0, durationCount: 0, dates: {} };
    map[k].plays += r.plays;
    map[k].completed += r.completed || 0;
    if (r.total_duration) map[k].totalDuration += r.total_duration;
    if (r.avg_duration) map[k].durationCount += r.plays;
    const dk = r.play_date;
    if (!map[k].dates[dk]) map[k].dates[dk] = { date: dk, plays: 0, completed: 0, hours: {} };
    map[k].dates[dk].plays += r.plays;
    map[k].dates[dk].completed += r.completed || 0;
    const hk = String(r.play_hour);
    if (!map[k].dates[dk].hours[hk]) map[k].dates[dk].hours[hk] = { hour: hk, plays: 0 };
    map[k].dates[dk].hours[hk].plays += r.plays;
  }
  return Object.values(map).sort((a, b) => b.plays - a.plays);
}

function aggregateByDevice(rows) {
  const map = {};
  for (const r of rows) {
    const k = r.device_id;
    if (!map[k]) map[k] = { device_id: k, plays: 0, dates: {} };
    map[k].plays += r.total_plays;
    const dk = r.play_date;
    if (!map[k].dates[dk]) map[k].dates[dk] = { date: dk, plays: 0 };
    map[k].dates[dk].plays += r.total_plays;
  }
  return Object.values(map).sort((a, b) => b.plays - a.plays);
}

function renderResults(data) {
  const el = document.getElementById('results');
  const s = data.summary || {};

  let html = `<div class="card" style="padding:var(--space-md); margin-bottom:var(--space-md);">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:var(--space-sm);">
      <div><div class="meta">Показов</div><div style="font-size:1.5rem;font-weight:600;">${s.total_plays || 0}</div></div>
      <div><div class="meta">Устройств</div><div style="font-size:1.5rem;font-weight:600;">${s.unique_devices || 0}</div></div>
      <div><div class="meta">Файлов</div><div style="font-size:1.5rem;font-weight:600;">${s.unique_files || 0}</div></div>
      <div><div class="meta">Завершено</div><div style="font-size:1.5rem;font-weight:600;">${s.completed_plays || 0} <span class="meta" style="font-size:0.85rem;">(${s.completion_rate || 0}%)</span></div></div>
      <div><div class="meta">Средняя длит.</div><div style="font-size:1.2rem;font-weight:600;">${s.avg_duration_sec || 0}с</div></div>
      ${s.last_date ? `<div><div class="meta">Последний показ</div><div style="font-size:1rem;">${String(s.last_date).substring(0, 10)}</div></div>` : ''}
    </div>
  </div>`;

  if (data.perFile?.length) {
    const files = aggregateByFile(data.perFile);
    html += `<div class="card" style="padding:var(--space-md); margin-bottom:var(--space-md);">
      <div style="display:flex;align-items:center;gap:var(--space-sm);margin-bottom:var(--space-sm);">
        <span style="font-weight:600;">По файлам</span>
        <span class="meta">${files.length} файлов</span>
      </div>
      <div style="overflow-x:auto;">
        <table class="ad-analytics-table" style="width:100%;border-collapse:collapse;font-size:0.85rem;">
          <thead><tr style="border-bottom:2px solid var(--border);">
            <th style="text-align:left;padding:6px 8px;"></th>
            <th style="text-align:left;padding:6px 8px;">Файл</th>
            <th style="text-align:right;padding:6px 8px;">Показы</th>
            <th style="text-align:right;padding:6px 8px;">Заверш.</th>
            <th style="text-align:right;padding:6px 8px;">% заверш.</th>
            <th style="text-align:right;padding:6px 8px;">Ср. длит.</th>
          </tr></thead>
          <tbody>${files.map((f, fi) => {
    const pct = f.plays ? Math.round((f.completed / f.plays) * 100) : 0;
    const avg = f.plays ? Math.round(f.totalDuration / (f.durationCount || f.plays)) : 0;
    return `<tr class="file-group-row" style="border-bottom:1px solid var(--border);cursor:pointer;" onclick="toggleFileDetail(${fi})">
            <td style="padding:6px 8px;text-align:center;"><span id="fileToggle_${fi}">▶</span></td>
            <td style="padding:6px 8px;">${escapeHtml(f.file_name)}</td>
            <td style="padding:6px 8px;text-align:right;font-weight:600;">${f.plays}</td>
            <td style="padding:6px 8px;text-align:right;">${f.completed}</td>
            <td style="padding:6px 8px;text-align:right;">${pct}%</td>
            <td style="padding:6px 8px;text-align:right;">${avg}с</td>
          </tr>
          <tr id="fileDetail_${fi}" style="display:none;">
            <td colspan="6" style="padding:0;">
              <div style="padding:8px 8px 8px 32px;background:var(--bg-secondary,rgba(255,255,255,0.02));">
                <table style="width:100%;border-collapse:collapse;font-size:0.8rem;">
                  <thead><tr style="border-bottom:1px solid var(--border);">
                    <th style="text-align:left;padding:4px 6px;">Дата</th>
                    <th style="text-align:right;padding:4px 6px;">Показы</th>
                    <th style="text-align:right;padding:4px 6px;">Заверш.</th>
                    <th style="text-align:left;padding:4px 6px;">По часам</th>
                  </tr></thead>
                  <tbody>${Object.values(f.dates).sort((a, b) => b.date.localeCompare(a.date)).map(d => {
    const hours = Object.values(d.hours).sort((a, b) => a.hour.localeCompare(b.hour));
    return `<tr>
                      <td style="padding:4px 6px;">${d.date}</td>
                      <td style="padding:4px 6px;text-align:right;">${d.plays}</td>
                      <td style="padding:4px 6px;text-align:right;">${d.completed}</td>
                      <td style="padding:4px 6px;">${hours.map(h => h.plays > 0 ? `${h.hour}:00 (${h.plays})` : '').filter(Boolean).join(', ')}</td>
                    </tr>`;
  }).join('')}</tbody>
                </table>
              </div>
            </td>
          </tr>`;
  }).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }

  if (data.perDevice?.length) {
    const devices = aggregateByDevice(data.perDevice);
    html += `<div class="card" style="padding:var(--space-md); margin-bottom:var(--space-md);">
      <div style="font-weight:600;margin-bottom:var(--space-sm);">По устройствам</div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
          <thead><tr style="border-bottom:2px solid var(--border);">
            <th style="text-align:left;padding:6px 8px;">Устройство</th>
            <th style="text-align:right;padding:6px 8px;">Всего показов</th>
            <th style="text-align:left;padding:6px 8px;">По дням</th>
          </tr></thead>
          <tbody>${devices.map(d => {
    const days = Object.values(d.dates).sort((a, b) => b.date.localeCompare(a.date));
    return `<tr style="border-bottom:1px solid var(--border);">
              <td style="padding:6px 8px;">${escapeHtml(d.device_id)}</td>
              <td style="padding:6px 8px;text-align:right;font-weight:600;">${d.plays}</td>
              <td style="padding:6px 8px;">${days.map(dd => `${dd.date} (${dd.plays})`).join(', ')}</td>
            </tr>`;
  }).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }

  if (!data.perFile?.length && !data.perDevice?.length) {
    html += '<div class="meta">Нет данных за выбранный период.</div>';
  }

  el.innerHTML = html;
}

window.toggleFileDetail = function(idx) {
  const row = document.getElementById('fileDetail_' + idx);
  const toggle = document.getElementById('fileToggle_' + idx);
  if (!row) return;
  const hidden = row.style.display === 'none';
  row.style.display = hidden ? 'table-row' : 'none';
  if (toggle) toggle.textContent = hidden ? '▼' : '▶';
};

function formatCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function exportCsv() {
  const d = _lastData;
  if (!d) { alert('Сначала загрузите данные'); return; }
  const raw = d.raw || [];
  let csv = '\uFEFF';
  csv += 'device_id;file_name;played_at;duration_sec;completed\n';
  for (const r of raw) {
    csv += `${formatCell(r.device_id)};${formatCell(r.file_name)};${formatCell(r.played_at)};${r.duration_sec != null ? r.duration_sec : ''};${r.completed || 0}\n`;
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ad-analytics-${new Date().toISOString().substring(0, 10)}.csv`;
  a.click();
}
