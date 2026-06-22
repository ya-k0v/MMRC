import { ensureAuth, adminFetch } from './auth.js';
import { initThemeToggle } from '../theme.js';
import { escapeHtml } from '../shared/utils.js';

let currentTab = 'videos';
let videos = [];
let displays = [];
let currentDisplayId = null;

document.addEventListener('DOMContentLoaded', async () => {
  initThemeToggle(document.getElementById('themeBtn'), 'vc_theme_ad');

  try {
    const user = await ensureAuth();
    if (!user || user.role !== 'admin') {
      window.location.href = '/admin.html';
      return;
    }
  } catch {
    return;
  }

  document.getElementById('backBtn').onclick = () => {
    window.location.href = '/admin.html';
  };

  await loadVideos();
  await loadDisplays();
  renderLayout();
});

async function loadVideos() {
  try {
    const res = await adminFetch('/api/ad/videos');
    const data = await res.json();
    videos = data.videos || [];
  } catch { videos = []; }
}

async function loadDisplays() {
  try {
    const res = await adminFetch('/api/ad/displays');
    const data = await res.json();
    displays = data.displays || [];
  } catch { displays = []; }
}

function renderLayout() {
  document.getElementById('content').innerHTML = `
    <div style="display:flex; gap:var(--space-sm); margin-bottom:var(--space-md); flex-wrap:wrap;">
      <button class="${currentTab === 'videos' ? 'primary' : 'secondary'}" data-tab="videos">Ролики</button>
      <button class="${currentTab === 'displays' ? 'primary' : 'secondary'}" data-tab="displays">Дисплеи</button>
      <button class="${currentTab === 'schedule' ? 'primary' : 'secondary'}" data-tab="schedule">Расписание</button>
      <button class="${currentTab === 'analytics' ? 'primary' : 'secondary'}" data-tab="analytics">Аналитика</button>
    </div>
    <div id="tabContent"></div>
  `;

  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => {
      currentTab = btn.dataset.tab;
      renderLayout();
    };
  });

  renderTabContent();
}

function renderTabContent() {
  const el = document.getElementById('tabContent');
  switch (currentTab) {
    case 'videos': renderVideosTab(el); break;
    case 'displays': renderDisplaysTab(el); break;
    case 'schedule': renderScheduleTab(el); break;
    case 'analytics': renderAnalyticsTab(el); break;
  }
}

// ========= VIDEOS TAB =========

function renderVideosTab(el) {
  el.innerHTML = `
    <div class="card" style="padding:var(--space-md); margin-bottom:var(--space-md);">
      <div style="display:flex; gap:var(--space-sm); align-items:flex-end; flex-wrap:wrap;">
        <div>
          <div class="meta" style="margin-bottom:4px;">Название</div>
          <input id="videoName" class="input" placeholder="Название ролика" />
        </div>
        <div>
          <div class="meta" style="margin-bottom:4px;">Длительность (сек)</div>
          <input id="videoDuration" class="input" type="number" placeholder="0" style="width:100px;" />
        </div>
        <div>
          <div class="meta" style="margin-bottom:4px;">Видеофайл</div>
          <input id="videoFile" type="file" accept="video/*" />
        </div>
        <button id="uploadVideoBtn" class="primary">Загрузить</button>
      </div>
    </div>
    <div id="videoList"></div>
  `;

  document.getElementById('uploadVideoBtn').onclick = uploadVideo;
  renderVideoList();
}

async function uploadVideo() {
  const name = document.getElementById('videoName').value.trim();
  const duration = document.getElementById('videoDuration').value;
  const fileInput = document.getElementById('videoFile');
  if (!name || !fileInput.files.length) return;

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('name', name);
  formData.append('duration', duration || '0');

  try {
    const res = await adminFetch('/api/ad/videos', {
      method: 'POST',
      body: formData
    });
    if (res.ok) {
      await loadVideos();
      renderVideoList();
      document.getElementById('videoName').value = '';
      document.getElementById('videoDuration').value = '';
      document.getElementById('videoFile').value = '';
    } else {
      const data = await res.json();
      alert(data.error || 'Ошибка загрузки');
    }
  } catch (err) {
    alert('Ошибка загрузки: ' + err.message);
  }
}

function renderVideoList() {
  const el = document.getElementById('videoList');
  if (!videos.length) {
    el.innerHTML = '<div class="meta">Нет загруженных роликов</div>';
    return;
  }

  el.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:var(--space-sm);">
      ${videos.map(v => `
        <div class="card" style="padding:var(--space-sm); display:flex; align-items:center; gap:var(--space-sm); flex-wrap:wrap;">
          <div style="flex:1; min-width:150px;">
            <div style="font-weight:500;">${escapeHtml(v.name)}</div>
            <div class="meta">${v.duration || 0}с ${v.is_default ? '• ⭐ Заглушка' : ''} ${!v.is_active ? '• ❌ Неактивен' : ''}</div>
          </div>
          <div style="display:flex; gap:var(--space-xs);">
            <button class="secondary set-default-btn" data-id="${v.id}" style="font-size:0.8rem;${v.is_default ? 'opacity:0.5;' : ''}">${v.is_default ? '⭐' : '☆'} Заглушка</button>
            <button class="secondary toggle-active-btn" data-id="${v.id}" style="font-size:0.8rem;">${v.is_active ? 'Выкл' : 'Вкл'}</button>
            <button class="secondary delete-video-btn" data-id="${v.id}" style="font-size:0.8rem; color:var(--danger);">✕</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  el.querySelectorAll('.set-default-btn').forEach(btn => {
    btn.onclick = async () => {
      await adminFetch(`/api/ad/videos/${btn.dataset.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_default: true })
      });
      await loadVideos();
      renderVideoList();
    };
  });

  el.querySelectorAll('.toggle-active-btn').forEach(btn => {
    btn.onclick = async () => {
      const v = videos.find(x => x.id == btn.dataset.id);
      await adminFetch(`/api/ad/videos/${btn.dataset.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !v.is_active })
      });
      await loadVideos();
      renderVideoList();
    };
  });

  el.querySelectorAll('.delete-video-btn').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Удалить ролик?')) return;
      await adminFetch(`/api/ad/videos/${btn.dataset.id}`, { method: 'DELETE' });
      await loadVideos();
      renderVideoList();
    };
  });
}

// ========= DISPLAYS TAB =========

function renderDisplaysTab(el) {
  el.innerHTML = `
    <div class="card" style="padding:var(--space-md); margin-bottom:var(--space-md);">
      <div style="display:flex; gap:var(--space-sm); align-items:flex-end; flex-wrap:wrap;">
        <div>
          <div class="meta" style="margin-bottom:4px;">Название</div>
          <input id="dispName" class="input" placeholder="Например: Холл 1 этаж" />
        </div>
        <div>
          <div class="meta" style="margin-bottom:4px;">Расположение</div>
          <input id="dispLocation" class="input" placeholder="Где находится" />
        </div>
        <div>
          <div class="meta" style="margin-bottom:4px;">Интервал (сек)</div>
          <input id="dispInterval" class="input" type="number" value="30" style="width:80px;" />
        </div>
        <button id="createDispBtn" class="primary">Создать дисплей</button>
      </div>
      <div class="meta" style="margin-top:var(--space-sm);">
        URL плеера: <code>${location.origin}/ad-display.html?display_id=ID</code>
      </div>
    </div>
    <div id="displayList"></div>
  `;

  document.getElementById('createDispBtn').onclick = createDisplay;
  renderDisplayList();
}

async function createDisplay() {
  const name = document.getElementById('dispName').value.trim();
  const location = document.getElementById('dispLocation').value.trim();
  const interval = document.getElementById('dispInterval').value;
  if (!name) return;

  await adminFetch('/api/ad/displays', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, location, rotation_interval: parseInt(interval) || 30 })
  });
  await loadDisplays();
  renderDisplayList();
  document.getElementById('dispName').value = '';
  document.getElementById('dispLocation').value = '';
}

function renderDisplayList() {
  const el = document.getElementById('displayList');
  if (!displays.length) {
    el.innerHTML = '<div class="meta">Нет дисплеев. Создайте первый.</div>';
    return;
  }

  el.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:var(--space-sm);">
      ${displays.map(d => `
        <div class="card" style="padding:var(--space-sm); display:flex; align-items:center; gap:var(--space-sm); flex-wrap:wrap;">
          <div style="flex:1; min-width:150px;">
            <div style="font-weight:500;">${escapeHtml(d.name)}</div>
            <div class="meta">${d.location || ''} • Интервал: ${d.rotation_interval || 30}с ${!d.is_active ? '• ❌ Неактивен' : ''}</div>
          </div>
          <div class="meta">ID: ${d.id}</div>
          <div style="display:flex; gap:var(--space-xs);">
            <button class="secondary schedule-disp-btn" data-id="${d.id}" style="font-size:0.8rem;">📅 Расписание</button>
            <button class="secondary disp-url-btn" data-id="${d.id}" style="font-size:0.8rem;">🔗 URL</button>
            <button class="secondary delete-disp-btn" data-id="${d.id}" style="font-size:0.8rem; color:var(--danger);">✕</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  el.querySelectorAll('.schedule-disp-btn').forEach(btn => {
    btn.onclick = () => {
      currentDisplayId = parseInt(btn.dataset.id);
      currentTab = 'schedule';
      renderLayout();
    };
  });

  el.querySelectorAll('.disp-url-btn').forEach(btn => {
    btn.onclick = () => {
      const url = `${location.origin}/ad-display.html?display_id=${btn.dataset.id}`;
      prompt('URL плеера для этого дисплея:', url);
    };
  });

  el.querySelectorAll('.delete-disp-btn').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Удалить дисплей?')) return;
      await adminFetch(`/api/ad/displays/${btn.dataset.id}`, { method: 'DELETE' });
      await loadDisplays();
      renderDisplayList();
    };
  });
}

// ========= SCHEDULE TAB =========

function renderScheduleTab(el) {
  if (!displays.length) {
    el.innerHTML = '<div class="card" style="padding:var(--space-md);"><div class="meta">Сначала создайте дисплей и загрузите ролики.</div></div>';
    return;
  }

  if (!currentDisplayId) {
    const first = displays.find(d => d.is_active) || displays[0];
    currentDisplayId = first?.id;
  }

  el.innerHTML = `
    <div style="display:flex; gap:var(--space-sm); flex-wrap:wrap; margin-bottom:var(--space-md);">
      <select id="scheduleDisplaySelect" class="input" style="max-width:300px;">
        ${displays.map(d => `<option value="${d.id}" ${d.id === currentDisplayId ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
      </select>
      <button id="saveScheduleBtn" class="primary">Сохранить расписание</button>
    </div>
    <div id="scheduleEditor"></div>
  `;

  document.getElementById('scheduleDisplaySelect').onchange = (e) => {
    currentDisplayId = parseInt(e.target.value);
    renderScheduleTab(el);
  };

  renderScheduleEditor();
}

async function renderScheduleEditor() {
  const editor = document.getElementById('scheduleEditor');

  if (!videos.length) {
    editor.innerHTML = '<div class="meta">Сначала загрузите ролики во вкладке «Ролики».</div>';
    return;
  }

  let schedule = [];
  try {
    const res = await adminFetch(`/api/ad/displays/${currentDisplayId}/schedule`);
    const data = await res.json();
    schedule = data.schedule || [];
  } catch {}

  const scheduledIds = new Set(schedule.map(s => s.video_id));

  editor.innerHTML = `
    <div class="card" style="padding:var(--space-md);">
      <div class="meta" style="margin-bottom:var(--space-sm);">
        Выберите ролики для дисплея и настройте приоритет:
      </div>
      <div style="display:flex; flex-direction:column; gap:var(--space-sm);">
        ${videos.filter(v => v.is_active).map(v => {
          const isScheduled = scheduledIds.has(v.id);
          const s = schedule.find(x => x.video_id === v.id);
          return `
            <label style="display:flex; align-items:center; gap:var(--space-sm); padding:var(--space-xs); border:1px solid var(--border); border-radius:var(--radius-sm); ${isScheduled ? 'background:var(--panel-2);' : ''}">
              <input type="checkbox" class="schedule-checkbox" data-video-id="${v.id}" ${isScheduled ? 'checked' : ''} />
              <div style="flex:1;">
                <span style="font-weight:500;">${escapeHtml(v.name)}</span>
                ${v.is_default ? '<span class="meta">⭐ Заглушка</span>' : ''}
              </div>
              <div>
                <span class="meta">Приоритет:</span>
                <input type="number" class="schedule-weight input" data-video-id="${v.id}" value="${s ? s.weight : 1.0}" min="0.1" step="0.1" style="width:70px;" />
              </div>
            </label>
          `;
        }).join('')}
      </div>
    </div>
  `;

  document.getElementById('saveScheduleBtn').onclick = async () => {
    const checked = editor.querySelectorAll('.schedule-checkbox:checked');
    const videoIds = Array.from(checked).map(cb => {
      const videoId = parseInt(cb.dataset.videoId);
      const weightInput = editor.querySelector(`.schedule-weight[data-video-id="${videoId}"]`);
      const weight = weightInput ? parseFloat(weightInput.value) || 1.0 : 1.0;
      return { video_id: videoId, weight };
    });

    await adminFetch(`/api/ad/displays/${currentDisplayId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_ids: videoIds })
    });
    alert('Расписание сохранено');
  };
}

// ========= ANALYTICS TAB =========

function renderAnalyticsTab(el) {
  const today = new Date().toISOString().substring(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().substring(0, 10);

  el.innerHTML = `
    <div class="card" style="padding:var(--space-md); margin-bottom:var(--space-md);">
      <div style="display:flex; gap:var(--space-sm); align-items:flex-end; flex-wrap:wrap;">
        <div>
          <div class="meta" style="margin-bottom:4px;">С</div>
          <input id="analyticsFrom" class="input" type="date" value="${weekAgo}" />
        </div>
        <div>
          <div class="meta" style="margin-bottom:4px;">По</div>
          <input id="analyticsTo" class="input" type="date" value="${today}" />
        </div>
        <div>
          <div class="meta" style="margin-bottom:4px;">Дисплей</div>
          <select id="analyticsDisplay" class="input">
            <option value="">Все</option>
            ${displays.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="meta" style="margin-bottom:4px;">Ролик</div>
          <select id="analyticsVideo" class="input">
            <option value="">Все</option>
            ${videos.map(v => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join('')}
          </select>
        </div>
        <button id="loadAnalyticsBtn" class="primary">Загрузить</button>
        <button id="exportAnalyticsBtn" class="secondary">CSV</button>
      </div>
    </div>
    <div id="analyticsResults">
      <div class="meta">Нажмите «Загрузить» для просмотра статистики</div>
    </div>
  `;

  document.getElementById('loadAnalyticsBtn').onclick = loadAnalytics;
  document.getElementById('exportAnalyticsBtn').onclick = exportAnalytics;
}

async function loadAnalytics() {
  const from = document.getElementById('analyticsFrom').value;
  const to = document.getElementById('analyticsTo').value;
  const displayId = document.getElementById('analyticsDisplay').value;
  const videoId = document.getElementById('analyticsVideo').value;

  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to + 'T23:59:59');
  if (displayId) params.set('display_id', displayId);
  if (videoId) params.set('video_id', videoId);

  try {
    const res = await adminFetch(`/api/ad/analytics/stats?${params}`);
    const data = await res.json();
    renderAnalyticsResults(data);
  } catch (err) {
    document.getElementById('analyticsResults').innerHTML = `<div class="meta" style="color:var(--danger);">Ошибка загрузки: ${err.message}</div>`;
  }
}

function renderAnalyticsResults(data) {
  const el = document.getElementById('analyticsResults');
  const s = data.summary || {};

  let html = `
    <div class="card" style="padding:var(--space-md); margin-bottom:var(--space-md);">
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:var(--space-sm);">
        <div><div class="meta">Всего показов</div><div style="font-size:1.5rem; font-weight:600;">${s.total_plays || 0}</div></div>
        <div><div class="meta">Уникальных роликов</div><div style="font-size:1.5rem; font-weight:600;">${s.unique_videos || 0}</div></div>
        <div><div class="meta">Дисплеев</div><div style="font-size:1.5rem; font-weight:600;">${s.unique_displays || 0}</div></div>
      </div>
    </div>
  `;

  // Per video breakdown
  if (data.perVideo?.length) {
    html += `<div class="card" style="padding:var(--space-md); margin-bottom:var(--space-md);">
      <div style="font-weight:600; margin-bottom:var(--space-sm);">По роликам и часам</div>
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:0.85rem;">
          <thead><tr style="border-bottom:1px solid var(--border);">
            <th style="text-align:left; padding:6px 8px;">Ролик</th>
            <th style="text-align:left; padding:6px 8px;">Дата</th>
            <th style="text-align:left; padding:6px 8px;">Час</th>
            <th style="text-align:right; padding:6px 8px;">Показы</th>
          </tr></thead>
          <tbody>
            ${data.perVideo.map(r => `<tr style="border-bottom:1px solid var(--border);">
              <td style="padding:6px 8px;">${escapeHtml(r.video_name)}</td>
              <td style="padding:6px 8px;">${r.play_date}</td>
              <td style="padding:6px 8px;">${r.play_hour}:00</td>
              <td style="padding:6px 8px; text-align:right;">${r.plays}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  if (data.perDisplay?.length) {
    html += `<div class="card" style="padding:var(--space-md);">
      <div style="font-weight:600; margin-bottom:var(--space-sm);">По дисплеям</div>
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:0.85rem;">
          <thead><tr style="border-bottom:1px solid var(--border);">
            <th style="text-align:left; padding:6px 8px;">Дисплей</th>
            <th style="text-align:left; padding:6px 8px;">Дата</th>
            <th style="text-align:right; padding:6px 8px;">Показы</th>
          </tr></thead>
          <tbody>
            ${data.perDisplay.map(r => `<tr style="border-bottom:1px solid var(--border);">
              <td style="padding:6px 8px;">${escapeHtml(r.display_name)}</td>
              <td style="padding:6px 8px;">${r.play_date}</td>
              <td style="padding:6px 8px; text-align:right;">${r.total_plays}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  if (!data.perVideo?.length && !data.perDisplay?.length) {
    html += `<div class="meta">Нет данных за выбранный период</div>`;
  }

  el.innerHTML = html;
}

function exportAnalytics() {
  const table = document.querySelector('#analyticsResults table');
  if (!table) { alert('Сначала загрузите данные'); return; }
  let csv = '\uFEFF'; // BOM for Excel
  const rows = table.querySelectorAll('tr');
  rows.forEach(tr => {
    const cols = tr.querySelectorAll('th, td');
    csv += Array.from(cols).map(c => '"' + (c.textContent || '').replace(/"/g, '""') + '"').join(';') + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `ad-analytics-${new Date().toISOString().substring(0, 10)}.csv`;
  link.click();
}
