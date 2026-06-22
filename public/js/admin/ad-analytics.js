import { ensureAuth, adminFetch } from './auth.js';
import { initThemeToggle } from '../theme.js';
import { escapeHtml } from '../shared/utils.js';

let displays = [];
let videos = [];

document.addEventListener('DOMContentLoaded', async () => {
  initThemeToggle(document.getElementById('themeBtn'), 'vc_theme_ad');
  try {
    const user = await ensureAuth();
    if (!user || user.role !== 'admin') { window.location.href = '/admin.html'; return; }
  } catch { return; }

  document.getElementById('backBtn').onclick = () => window.location.href = '/ad-admin.html';

  const today = new Date();
  document.getElementById('filterTo').value = today.toISOString().substring(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  document.getElementById('filterFrom').value = weekAgo.toISOString().substring(0, 10);

  await Promise.all([loadDisplays(), loadVideos()]);
  populateFilters();
  document.getElementById('loadBtn').onclick = loadStats;
  document.getElementById('exportBtn').onclick = exportCsv;
  loadStats();
});

async function loadDisplays() {
  try { displays = (await (await adminFetch('/api/ad/displays')).json()).displays || []; } catch { displays = []; }
}

async function loadVideos() {
  try { videos = (await (await adminFetch('/api/ad/videos')).json()).videos || []; } catch { videos = []; }
}

function populateFilters() {
  const dispSel = document.getElementById('filterDisplay');
  displays.forEach(d => { const o = document.createElement('option'); o.value = d.id; o.textContent = d.name; dispSel.appendChild(o); });
  const vidSel = document.getElementById('filterVideo');
  videos.forEach(v => { const o = document.createElement('option'); o.value = v.id; o.textContent = v.name; vidSel.appendChild(o); });
}

async function loadStats() {
  const params = new URLSearchParams();
  const from = document.getElementById('filterFrom').value;
  const to = document.getElementById('filterTo').value;
  if (from) params.set('from', from);
  if (to) params.set('to', to + 'T23:59:59');
  if (document.getElementById('filterDisplay').value) params.set('display_id', document.getElementById('filterDisplay').value);
  if (document.getElementById('filterVideo').value) params.set('video_id', document.getElementById('filterVideo').value);

  const res = await adminFetch(`/api/ad/analytics/stats?${params}`);
  const data = await res.json();
  renderResults(data);
}

function renderResults(data) {
  const el = document.getElementById('results');
  const s = data.summary || {};

  let html = `<div class="card" style="padding:var(--space-md); margin-bottom:var(--space-md);">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:var(--space-sm);">
      <div><div class="meta">Показов</div><div style="font-size:1.5rem;font-weight:600;">${s.total_plays || 0}</div></div>
      <div><div class="meta">Роликов</div><div style="font-size:1.5rem;font-weight:600;">${s.unique_videos || 0}</div></div>
      <div><div class="meta">Дисплеев</div><div style="font-size:1.5rem;font-weight:600;">${s.unique_displays || 0}</div></div>
      ${s.last_date ? `<div><div class="meta">Последний показ</div><div style="font-size:1rem;">${s.last_date.substring(0, 10)}</div></div>` : ''}
    </div>
  </div>`;

  if (data.perVideo?.length) {
    html += `<div class="card" style="padding:var(--space-md); margin-bottom:var(--space-md);">
      <div style="font-weight:600;margin-bottom:var(--space-sm);">По роликам и часам</div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
          <thead><tr style="border-bottom:1px solid var(--border);">
            <th style="text-align:left;padding:6px 8px;">Ролик</th>
            <th style="text-align:left;padding:6px 8px;">Тип</th>
            <th style="text-align:left;padding:6px 8px;">Дата</th>
            <th style="text-align:left;padding:6px 8px;">Час</th>
            <th style="text-align:right;padding:6px 8px;">Показы</th>
          </tr></thead>
          <tbody>${data.perVideo.map(r => `<tr style="border-bottom:1px solid var(--border);">
            <td style="padding:6px 8px;">${escapeHtml(r.video_name)}</td>
            <td style="padding:6px 8px;">${r.type === 'image' ? '🖼' : '🎬'}</td>
            <td style="padding:6px 8px;">${r.play_date}</td>
            <td style="padding:6px 8px;">${r.play_hour}:00</td>
            <td style="padding:6px 8px;text-align:right;">${r.plays}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }

  if (data.perDisplay?.length) {
    html += `<div class="card" style="padding:var(--space-md);">
      <div style="font-weight:600;margin-bottom:var(--space-sm);">По дисплеям</div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
          <thead><tr style="border-bottom:1px solid var(--border);">
            <th style="text-align:left;padding:6px 8px;">Дисплей</th>
            <th style="text-align:left;padding:6px 8px;">Дата</th>
            <th style="text-align:right;padding:6px 8px;">Показы</th>
          </tr></thead>
          <tbody>${data.perDisplay.map(r => `<tr style="border-bottom:1px solid var(--border);">
            <td style="padding:6px 8px;">${escapeHtml(r.display_name)}</td>
            <td style="padding:6px 8px;">${r.play_date}</td>
            <td style="padding:6px 8px;text-align:right;">${r.total_plays}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }

  if (!data.perVideo?.length && !data.perDisplay?.length) {
    html += '<div class="meta">Нет данных за выбранный период.</div>';
  }

  el.innerHTML = html;
}

function exportCsv() {
  const table = document.querySelector('#results table');
  if (!table) { alert('Сначала загрузите данные'); return; }
  let csv = '\uFEFF';
  table.querySelectorAll('tr').forEach(tr => {
    csv += [...tr.querySelectorAll('th,td')].map(c => '"' + (c.textContent || '').replace(/"/g, '""') + '"').join(';') + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ad-analytics-${new Date().toISOString().substring(0, 10)}.csv`;
  a.click();
}
