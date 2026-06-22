import { ensureAuth, adminFetch } from './auth.js';
import { initThemeToggle } from '../theme.js';
import { escapeHtml } from '../shared/utils.js';

let currentTab = 'videos';
let videos = [];
let displays = [];
let currentDisplayId = null;

const TABS = [
  { id: 'videos', label: 'Ролики' },
  { id: 'displays', label: 'Дисплеи' },
  { id: 'schedule', label: 'Расписание' }
];

document.addEventListener('DOMContentLoaded', async () => {
  initThemeToggle(document.getElementById('themeBtn'), 'vc_theme_ad');
  try {
    const user = await ensureAuth();
    if (!user || user.role !== 'admin') { window.location.href = '/admin.html'; return; }
  } catch { return; }

  document.getElementById('backBtn').onclick = () => window.location.href = '/admin.html';
  document.getElementById('analyticsBtn').onclick = () => window.location.href = '/ad-analytics.html';

  await Promise.all([loadVideos(), loadDisplays()]);
  renderLayout();
});

async function loadVideos() {
  try {
    const res = await adminFetch('/api/ad/videos');
    videos = (await res.json()).videos || [];
  } catch { videos = []; }
}

async function loadDisplays() {
  try {
    const res = await adminFetch('/api/ad/displays');
    displays = (await res.json()).displays || [];
  } catch { displays = []; }
}

function renderLayout() {
  document.getElementById('tabBar').innerHTML = TABS.map(t =>
    `<button class="${currentTab === t.id ? 'primary' : 'secondary'}" data-tab="${t.id}">${t.label}</button>`
  ).join('');

  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => { currentTab = btn.dataset.tab; renderLayout(); };
  });

  const el = document.getElementById('tabContent');
  if (currentTab === 'videos') renderVideos(el);
  else if (currentTab === 'displays') renderDisplays(el);
  else renderSchedule(el);
}

// ========= VIDEOS =========

function renderVideos(el) {
  el.innerHTML = `
    <div class="card" style="padding:var(--space-md); margin-bottom:var(--space-md);">
      <div style="display:flex; gap:var(--space-sm); align-items:flex-end; flex-wrap:wrap;">
        <div>
          <div class="meta" style="margin-bottom:4px;">Название</div>
          <input id="adName" class="input" placeholder="Например: Ролик_1" />
        </div>
        <div id="durationField">
          <div class="meta" style="margin-bottom:4px;">Длительность показа (сек)</div>
          <input id="adDuration" class="input" type="number" value="10" style="width:100px;" />
        </div>
        <div>
          <div class="meta" style="margin-bottom:4px;">Файл</div>
          <input id="adFile" type="file" accept="video/*,image/*" />
        </div>
        <button id="uploadBtn" class="primary">+ Добавить</button>
      </div>
      <div id="uploadHint" class="meta" style="margin-top:var(--space-xs);">
        Видео — длительность определится автоматически. Изображение — укажи длительность показа.
      </div>
    </div>
    <div id="videoList"></div>
  `;

  document.getElementById('adFile').onchange = () => {
    const file = document.getElementById('adFile').files[0];
    const isImage = file && /^image\//.test(file.type);
    document.getElementById('durationField').style.display = isImage ? '' : 'none';
  };

  document.getElementById('uploadBtn').onclick = uploadVideo;
  renderVideoList();
}

async function uploadVideo() {
  const name = document.getElementById('adName').value.trim();
  const fileInput = document.getElementById('adFile');
  if (!name || !fileInput.files.length) return;

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('name', name);

  const file = fileInput.files[0];
  if (/^image\//.test(file.type)) {
    formData.append('display_duration', document.getElementById('adDuration').value || '10');
  }

  const res = await adminFetch('/api/ad/videos', { method: 'POST', body: formData });
  if (res.ok) {
    await loadVideos();
    renderVideoList();
    document.getElementById('adName').value = '';
    document.getElementById('adFile').value = '';
  } else {
    alert((await res.json()).error || 'Ошибка');
  }
}

function renderVideoList() {
  const el = document.getElementById('videoList');
  if (!videos.length) { el.innerHTML = '<div class="meta">Нет файлов. Добавьте первый.</div>'; return; }

  el.innerHTML = `<div style="display:flex; flex-direction:column; gap:var(--space-sm);">${
    videos.map(v => {
      const isImage = v.type === 'image';
      const dur = isImage ? `${v.display_duration || 0}с` : `${Math.round(v.duration || 0)}с`;
      return `<div class="card" style="padding:var(--space-sm); display:flex; align-items:center; gap:var(--space-sm); flex-wrap:wrap;">
        <div style="flex:1; min-width:150px;">
          <div style="font-weight:500;">${escapeHtml(v.name)} <span class="meta">${isImage ? '🖼' : '🎬'} ${dur}</span></div>
          <div class="meta">${isImage ? 'Изображение' : 'Видео'} ${v.is_default ? '• ⭐ Заглушка' : ''} ${!v.is_active ? '• ❌ Неактивен' : ''}</div>
        </div>
        <div style="display:flex; gap:var(--space-xs);">
          ${isImage ? `<input class="input" type="number" value="${v.display_duration || 10}" min="1" style="width:60px;font-size:0.8rem;" data-dur="${v.id}" title="Длительность показа (сек)" />` : ''}
          <button class="secondary set-default-btn" data-id="${v.id}" style="font-size:0.8rem;${v.is_default ? 'opacity:0.5;' : ''}">${v.is_default ? '⭐' : '☆'}</button>
          <button class="secondary toggle-active-btn" data-id="${v.id}" style="font-size:0.8rem;">${v.is_active ? 'Выкл' : 'Вкл'}</button>
          <button class="secondary delete-video-btn" data-id="${v.id}" style="font-size:0.8rem;color:var(--danger);">✕</button>
        </div>
      </div>`;
    }).join('')
  }</div>`;

  el.querySelectorAll('.set-default-btn').forEach(b => b.onclick = async () => {
    await adminFetch(`/api/ad/videos/${b.dataset.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_default: true }) });
    await loadVideos(); renderVideoList();
  });

  el.querySelectorAll('.toggle-active-btn').forEach(b => b.onclick = async () => {
    const v = videos.find(x => x.id == b.dataset.id);
    await adminFetch(`/api/ad/videos/${b.dataset.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: !v.is_active }) });
    await loadVideos(); renderVideoList();
  });

  el.querySelectorAll('.delete-video-btn').forEach(b => b.onclick = async () => {
    if (!confirm('Удалить?')) return;
    await adminFetch(`/api/ad/videos/${b.dataset.id}`, { method: 'DELETE' });
    await loadVideos(); renderVideoList();
  });

  el.querySelectorAll('[data-dur]').forEach(inp => {
    let t;
    inp.oninput = () => { clearTimeout(t); t = setTimeout(async () => {
      await adminFetch(`/api/ad/videos/${inp.dataset.dur}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ display_duration: parseFloat(inp.value) || 0 }) });
    }, 500); };
  });
}

// ========= DISPLAYS =========

function renderDisplays(el) {
  el.innerHTML = `
    <div class="card" style="padding:var(--space-md); margin-bottom:var(--space-md);">
      <div style="display:flex; gap:var(--space-sm); align-items:flex-end; flex-wrap:wrap;">
        <div>
          <div class="meta" style="margin-bottom:4px;">Название</div>
          <input id="dispName" class="input" placeholder="Холл 1 этаж" />
        </div>
        <div>
          <div class="meta" style="margin-bottom:4px;">Расположение</div>
          <input id="dispLocation" class="input" placeholder="Где находится" />
        </div>
        <div>
          <div class="meta" style="margin-bottom:4px;">Интервал (сек)</div>
          <input id="dispInterval" class="input" type="number" value="30" style="width:80px;" />
        </div>
        <button id="createDispBtn" class="primary">+ Создать</button>
      </div>
    </div>
    <div id="displayList"></div>
  `;

  document.getElementById('createDispBtn').onclick = async () => {
    const name = document.getElementById('dispName').value.trim();
    if (!name) return;
    await adminFetch('/api/ad/displays', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, location: document.getElementById('dispLocation').value.trim(), rotation_interval: parseInt(document.getElementById('dispInterval').value) || 30 })
    });
    await loadDisplays();
    renderDisplayList();
    document.getElementById('dispName').value = '';
    document.getElementById('dispLocation').value = '';
  };

  renderDisplayList();
}

function renderDisplayList() {
  const el = document.getElementById('displayList');
  if (!displays.length) { el.innerHTML = '<div class="meta">Нет дисплеев.</div>'; return; }

  el.innerHTML = `<div style="display:flex; flex-direction:column; gap:var(--space-sm);">${
    displays.map(d => `<div class="card" style="padding:var(--space-sm); display:flex; align-items:center; gap:var(--space-sm); flex-wrap:wrap;">
      <div style="flex:1; min-width:150px;">
        <div style="font-weight:500;">${escapeHtml(d.name)}</div>
        <div class="meta">${d.location || ''} • Интервал: ${d.rotation_interval || 30}с • ID: ${d.id} ${!d.is_active ? '• ❌' : ''}</div>
      </div>
      <div style="display:flex; gap:var(--space-xs);">
        <button class="secondary schedule-btn" data-id="${d.id}" style="font-size:0.8rem;">📅</button>
        <button class="secondary url-btn" data-id="${d.id}" style="font-size:0.8rem;">🔗</button>
        <button class="secondary delete-disp-btn" data-id="${d.id}" style="font-size:0.8rem;color:var(--danger);">✕</button>
      </div>
    </div>`).join('')
  }</div>`;

  el.querySelectorAll('.schedule-btn').forEach(b => b.onclick = () => { currentDisplayId = parseInt(b.dataset.id); currentTab = 'schedule'; renderLayout(); });
  el.querySelectorAll('.url-btn').forEach(b => b.onclick = () => prompt('URL плеера:', `${location.origin}/ad-display.html?display_id=${b.dataset.id}`));
  el.querySelectorAll('.delete-disp-btn').forEach(b => b.onclick = async () => {
    if (!confirm('Удалить дисплей?')) return;
    await adminFetch(`/api/ad/displays/${b.dataset.id}`, { method: 'DELETE' });
    await loadDisplays(); renderDisplayList();
  });
}

// ========= SCHEDULE =========

function renderSchedule(el) {
  if (!displays.length) { el.innerHTML = '<div class="card" style="padding:var(--space-md);"><div class="meta">Сначала создайте дисплей.</div></div>'; return; }
  if (!videos.length) { el.innerHTML = '<div class="card" style="padding:var(--space-md);"><div class="meta">Сначала загрузите ролики.</div></div>'; return; }

  if (!currentDisplayId || !displays.find(d => d.id === currentDisplayId)) {
    currentDisplayId = (displays.find(d => d.is_active) || displays[0]).id;
  }

  el.innerHTML = `
    <div style="display:flex; gap:var(--space-sm); flex-wrap:wrap; margin-bottom:var(--space-md);">
      <select id="scheduleDisplay" class="input" style="max-width:300px;">
        ${displays.map(d => `<option value="${d.id}" ${d.id === currentDisplayId ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
      </select>
      <button id="saveSchedule" class="primary">Сохранить</button>
      <a href="/ad-display.html?display_id=${currentDisplayId}" target="_blank" class="secondary" style="padding:8px 12px;text-decoration:none;border:1px solid var(--border);border-radius:var(--radius-sm);display:flex;align-items:center;">▶ Открыть плеер</a>
    </div>
    <div id="scheduleEditor"></div>
  `;

  document.getElementById('scheduleDisplay').onchange = e => { currentDisplayId = parseInt(e.target.value); renderSchedule(el); };
  renderScheduleEditor();
}

async function renderScheduleEditor() {
  const editor = document.getElementById('scheduleEditor');
  let schedule = [];
  try {
    schedule = (await (await adminFetch(`/api/ad/displays/${currentDisplayId}/schedule`)).json()).schedule || [];
  } catch {}
  const scheduledIds = new Set(schedule.map(s => s.video_id));

  editor.innerHTML = `<div class="card" style="padding:var(--space-md);">
    ${videos.filter(v => v.is_active).map(v => {
      const isSched = scheduledIds.has(v.id);
      const s = schedule.find(x => x.video_id === v.id);
      const dur = v.type === 'image' ? `${v.display_duration || 0}с` : `${Math.round(v.duration || 0)}с`;
      return `<label style="display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-xs);border:1px solid var(--border);border-radius:var(--radius-sm);${isSched ? 'background:var(--panel-2);' : ''}">
        <input type="checkbox" class="sched-cb" data-id="${v.id}" ${isSched ? 'checked' : ''} />
        <div style="flex:1;"><span style="font-weight:500;">${escapeHtml(v.name)}</span> <span class="meta">${v.type === 'image' ? '🖼' : '🎬'} ${dur}</span>${v.is_default ? ' <span class="meta">⭐</span>' : ''}</div>
        <div><span class="meta">Вес:</span> <input type="number" class="sched-weight" data-id="${v.id}" value="${s ? s.weight : 1.0}" min="0.1" step="0.1" style="width:60px;font-size:0.8rem;" /></div>
      </label>`;
    }).join('')}
  </div>`;

  document.getElementById('saveSchedule').onclick = async () => {
    const checked = [...editor.querySelectorAll('.sched-cb:checked')];
    const videoIds = checked.map(cb => ({
      video_id: parseInt(cb.dataset.id),
      weight: parseFloat(editor.querySelector(`.sched-weight[data-id="${cb.dataset.id}"]`)?.value) || 1.0
    }));
    await adminFetch(`/api/ad/displays/${currentDisplayId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_ids: videoIds })
    });
    alert('Сохранено');
  };
}
