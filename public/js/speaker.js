import { initThemeToggle } from './theme.js';
import { sortDevices, debounce, loadNodeNames } from './utils.js';
import { ensureAuth, speakerFetch, logout } from './speaker/auth.js';

const socket = io();

// Фиксированное количество элементов на странице для спикера
const SPEAKER_PAGE_SIZE = 10;

const tvList = document.getElementById('tvList');
const fileList = document.getElementById('fileList');
const filePreview = document.getElementById('filePreview');

const STATIC_CONTENT_TYPES = new Set(['pdf', 'pptx', 'folder']);
let previewLoadToken = 0;

const THUMB_STYLE_ID = 'speaker-thumbnail-styles';
function ensureThumbnailStyles() {
  if (document.getElementById(THUMB_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = THUMB_STYLE_ID;
  style.textContent = `
    #filePreview .thumbnail-preview {
      aspect-ratio: 16 / 9;
      background: var(--panel-2);
      border-radius: var(--radius-sm);
      overflow: hidden;
      position: relative;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    #filePreview .thumbnail-preview.is-active {
      border: 4px solid var(--brand);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.3), 0 4px 12px rgba(59, 130, 246, 0.5);
      transform: scale(1.06);
    }
    #filePreview .thumbnail-preview:not(.is-active):hover {
      transform: scale(1.03);
      border-color: rgba(255, 255, 255, 0.2);
    }
  `;
  document.head.appendChild(style);
}

function escapeAttr(value = '') {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isStaticContent(type = '') {
  return STATIC_CONTENT_TYPES.has(type);
}

// Флаг что пользователь явно закрыл превью (не автооткрывать)
let previewManuallyClosed = false;

let readyDevices = new Set();
let devices = [];
let currentDevice = null;  // device_id
let currentFile = null;    // имя файла из /api/devices/:id/files
let tvPage = 0;
let filePage = 0;
let nodeNames = {}; // { device_id: name }
let allFiles = []; // Список всех файлов для текущего устройства (для отображения названий в прогресс-баре)
// Прогресс воспроизведения по устройству
const playbackProgressByDevice = new Map(); // device_id -> { file, currentTime, duration }
const playerStateByDevice = new Map(); // device_id -> { type, file, page }
let currentPreviewContext = { deviceId: null, file: null, page: null };

function resetPreviewHighlightState() {
  currentPreviewContext = { deviceId: null, file: null, page: null };
  filePreview.querySelectorAll('.thumbnail-preview').forEach((thumb) => {
    thumb.classList.remove('is-active');
    thumb.removeAttribute('data-selected');
  });
}

function getPreviewContext() {
  const sampleThumb = filePreview.querySelector('.thumbnail-preview');
  return {
    deviceId: sampleThumb?.getAttribute('data-device-id') || currentPreviewContext.deviceId,
    file: sampleThumb?.getAttribute('data-file') || currentPreviewContext.file,
    page: currentPreviewContext.page,
  };
}

async function fetchStaticPreviewImages(deviceId, safeName, contentType) {
  if (!deviceId || !safeName) return [];
  try {
    if (contentType === 'folder') {
      const res = await speakerFetch(`/api/devices/${encodeURIComponent(deviceId)}/folder/${encodeURIComponent(safeName)}/images`);
      if (!res.ok) return [];
      const data = await res.json();
      const items = data.images || [];
      return items.map((_, idx) =>
        `/api/devices/${encodeURIComponent(deviceId)}/folder/${encodeURIComponent(safeName)}/image/${idx + 1}`
      );
    }
    if (contentType === 'pdf' || contentType === 'pptx') {
      const res = await speakerFetch(`/api/devices/${encodeURIComponent(deviceId)}/slides-count?file=${encodeURIComponent(safeName)}`);
      if (!res.ok) return [];
      const data = await res.json();
      const count = Math.min(Number(data.count) || 0, 20);
      const urlType = contentType === 'pdf' ? 'page' : 'slide';
      return Array.from({ length: count }, (_, idx) =>
        `/api/devices/${encodeURIComponent(deviceId)}/converted/${encodeURIComponent(safeName)}/${urlType}/${idx + 1}`
      );
    }
  } catch (error) {
    console.error('[Speaker] Ошибка загрузки статического превью', error);
  }
  return [];
}

function renderThumbnailGrid(deviceId, safeName, contentType, imageUrls) {
  ensureThumbnailStyles();
  currentPreviewContext = { deviceId, file: safeName, page: null };
  if (!imageUrls.length) {
    filePreview.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary)">Нет миниатюр для этого файла</div>`;
    return;
  }

  filePreview.innerHTML = `
    <div style="width:100%; height:100%; overflow-y:auto; padding:var(--space-md); background:var(--panel)">
      <div class="thumbnail-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(110px, 1fr)); gap:var(--space-sm)">
        ${imageUrls.map((url, idx) => `
          <div class="thumbnail-preview"
               data-device-id="${escapeAttr(deviceId)}"
               data-file="${escapeAttr(safeName)}"
               data-page="${idx + 1}"
               data-type="${escapeAttr(contentType)}">
            <img src="${url}"
                 alt="${idx + 1}"
                 loading="lazy"
                 style="width:100%; height:100%; object-fit:cover; display:block; pointer-events:none"
                 onerror="this.parentElement.innerHTML='<div style=&quot;display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-size:10px&quot;>✗</div>'" />
            <div style="position:absolute; bottom:2px; right:4px; background:rgba(0,0,0,0.7); color:#fff; padding:2px 4px; border-radius:3px; font-size:10px; pointer-events:none">${idx + 1}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  filePreview.querySelectorAll('.thumbnail-preview').forEach((thumb, idx) => {
    thumb.addEventListener('click', () => {
      const page = idx + 1;
      socket.emit('control/play', {
        device_id: deviceId,
        file: safeName,
        page,
      });
    });
  });
}

async function showStaticPreview(deviceId, safeName, contentType, { initiatedByUser = false } = {}) {
  if (!deviceId || !safeName || !isStaticContent(contentType)) return;
  if (initiatedByUser) {
    previewManuallyClosed = false;
  }

  const loadToken = ++previewLoadToken;
  filePreview.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary)">Загрузка превью…</div>`;

  const images = await fetchStaticPreviewImages(deviceId, safeName, contentType);
  if (loadToken !== previewLoadToken) return;

  renderThumbnailGrid(deviceId, safeName, contentType, images);
  currentPreviewContext = { deviceId, file: safeName, page: null };

  const state = playerStateByDevice.get(deviceId);
  if (state && state.file === safeName && state.page) {
    highlightCurrentThumbnail(state.page, currentPreviewContext);
  }
}

async function syncPreviewWithPlayerState() {
  if (!currentDevice || previewManuallyClosed) return;
  const state = playerStateByDevice.get(currentDevice);
  if (!state || !state.file || !isStaticContent(state.type)) {
    showLivePreviewForTV(currentDevice, true);
    return;
  }

  const currentPreviewFile = filePreview.querySelector('.thumbnail-preview')?.getAttribute('data-file');
  if (currentPreviewFile !== state.file) {
    await showStaticPreview(currentDevice, state.file, state.type);
  }

  highlightCurrentThumbnail(state.page || 1, { deviceId: currentDevice, file: state.file });
}

function requestPreviewSync() {
  syncPreviewWithPlayerState().catch(err => console.error('[Speaker] Ошибка синхронизации превью', err));
}

// Обрезка текста с многоточием (адаптивно для мобильных)
function truncateText(text, maxLength = 40) {
  if (!text) return text;
  
  // Для мобильных устройств (включая iPad) - короче
  const isMobile = window.innerWidth <= 1024;
  const limit = isMobile ? 25 : maxLength;
  
  if (text.length <= limit) return text;
  return text.substring(0, limit) + '...';
}

document.addEventListener('DOMContentLoaded', async () => {
  initThemeToggle(document.getElementById('themeBtn'), 'vc_theme_speaker');
  
  try {
    const authorized = await ensureAuth();
    if (!authorized) return;
  } catch (err) {
    return;
  }
  
  // Показываем ФИО пользователя
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const userFullName = document.getElementById('userFullName');
  if (userFullName && user.full_name) {
    userFullName.textContent = user.full_name;
  } else if (userFullName && user.username) {
    userFullName.textContent = user.username; // Fallback на username
  }
  
  // Обработчик выхода (теперь это span)
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.onclick = (e) => {
      e.preventDefault();
      logout();
    };
    logoutBtn.style.cursor = 'pointer';
  }
  
  nodeNames = await loadNodeNames();
  await loadDevices();
  attachTouchGestures();

  // Автовыбор из URL, если есть
  const url = new URL(location.href);
  const qid = url.searchParams.get('device_id');
  if (qid && devices.find(d => d.device_id === qid)) {
    await selectDevice(qid);
  } else if (devices[0]) {
    await selectDevice(devices[0].device_id);
  }
});

/* Загрузка списка устройств */
async function loadDevices() {
  try {
    const res = await speakerFetch('/api/devices');
    if (!res.ok) {
      console.error('Failed to load devices:', res.status);
      return;
    }
    const newDevices = await res.json();
    
    // КРИТИЧНО: Сохраняем локальное состояние устройств (current) при обновлении списка
    // чтобы не потерять информацию о паузе/воспроизведении при переключении
    if (devices.length > 0) {
      newDevices.forEach(newDev => {
        const oldDev = devices.find(d => d.device_id === newDev.device_id);
        if (oldDev && oldDev.current) {
          // Сохраняем локальное состояние (state, file, type)
          newDev.current = oldDev.current;
        }
      });
    }
    
    devices = newDevices;
    // Сортируем устройства по алфавиту: А-Я, A-Z, 0-9
    devices = sortDevices(devices, nodeNames);
    devices.forEach(d => {
      if (d.current && d.current.file) {
        playerStateByDevice.set(d.device_id, {
          type: d.current.type,
          file: d.current.file,
          page: Number(d.current.page) || 1,
        });
      }
    });
    const pageSize = SPEAKER_PAGE_SIZE; // Фиксированное значение 10
    const totalPages = Math.max(1, Math.ceil(devices.length / pageSize));
    if (tvPage >= totalPages) tvPage = totalPages - 1;
    renderTVList();
  } catch (error) {
    console.error('Failed to load devices:', error);
  }
}

/* Рендер списка ТВ (информативный, с подсветкой выбранного) */
function renderTVList() {
  // Сортируем устройства перед отображением (на случай если список обновился)
  const sortedDevices = sortDevices(devices);
  const pageSize = SPEAKER_PAGE_SIZE; // Фиксированное значение 10
  const totalPages = Math.max(1, Math.ceil(sortedDevices.length / pageSize));
  if (tvPage >= totalPages) tvPage = totalPages - 1;
  const start = tvPage * pageSize;
  const end = Math.min(start + pageSize, sortedDevices.length);
  const pageItems = sortedDevices.slice(start, end);

  // Рендерим устройства (стили задаются в CSS)
  tvList.innerHTML = pageItems.map(d => {
    const name = d.name || nodeNames[d.device_id] || d.device_id;
    const filesCount = d.files?.length ?? 0;
    const isActive = d.device_id === currentDevice;
    const isReady = readyDevices.has(d.device_id);
    return `
      <li class="tvTile${isActive ? ' active' : ''}" data-id="${d.device_id}">
        <div class="tvTile-content">
          <div class="tvTile-header">
            <div class="title tvTile-name">${name}</div>
            <span class="tvTile-status ${isReady ? 'online' : 'offline'}" 
                  title="${isReady ? 'Готов' : 'Не готов'}" 
                  aria-label="${isReady ? 'online' : 'offline'}"></span>
          </div>
          <div class="meta tvTile-meta">ID: ${d.device_id}</div>
          <div class="meta">Файлов: ${filesCount}</div>
        </div>
      </li>
    `;
  }).join('');

  tvList.querySelectorAll('.tvTile').forEach(item => {
    item.onclick = async () => { await selectDevice(item.dataset.id); };
  });

  // рендер пейджера под списком
  let pager = document.getElementById('tvPager');
  if (!pager) {
    pager = document.createElement('div');
    pager.id = 'tvPager';
    pager.className = 'meta';
    pager.style.display = 'flex';
    pager.style.justifyContent = 'space-between';
    pager.style.alignItems = 'center';
    pager.style.gap = '8px';
    tvList.parentElement && tvList.parentElement.appendChild(pager);
  }
  
  // Показываем пагинацию только если больше 1 страницы
  if (totalPages > 1) {
  pager.innerHTML = `
    <button class="secondary" id="tvPrev" ${tvPage<=0?'disabled':''} style="min-width:80px">Назад</button>
    <span style="white-space:nowrap">Стр. ${tvPage+1} из ${totalPages}</span>
    <button class="secondary" id="tvNext" ${tvPage>=totalPages-1?'disabled':''} style="min-width:80px">Вперёд</button>
  `;
  const prev = document.getElementById('tvPrev');
  const next = document.getElementById('tvNext');
  if (prev) prev.onclick = () => { if (tvPage>0) { tvPage--; renderTVList(); } };
  if (next) next.onclick = () => { if (tvPage<totalPages-1) { tvPage++; renderTVList(); } };
  } else {
    // Если только 1 страница - скрываем пагинацию
    pager.innerHTML = '';
  }
}

// Update TV list on resize for responsive grid
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (tvList) renderTVList();
    // Также перерисовываем список файлов если он открыт
    if (currentDevice && fileList) loadFiles();
  }, 250);
});

function showLivePreviewForTV(deviceId, force = false) {
  // ИСПРАВЛЕНО: Если force=true - принудительно очищаем превью
  // Это используется при явном переключении устройства
  if (force) {
    console.log('[Speaker] 🔄 Принудительное обновление превью для устройства:', deviceId);
    resetPreviewHighlightState();
    currentPreviewContext = { deviceId, file: null, page: null };
    filePreview.innerHTML = `<iframe src="/player-videojs.html?device_id=${encodeURIComponent(deviceId)}&preview=1&muted=1" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen"></iframe>`;
    return;
  }
  
  // Не переключаем превью если показана сетка миниатюр (только при НЕ принудительном вызове)
  const hasThumbnails = filePreview.querySelector('.thumbnail-preview');
  if (hasThumbnails) {
    console.debug('[Speaker] ℹ️ Превью показывает миниатюры, не переключаем на заглушку');
    return;
  }
  
  // Показываем превью с живым состоянием устройства (всегда без звука)
  const device = devices.find(d => d.device_id === deviceId);
  if (!device) {
    resetPreviewHighlightState();
    filePreview.innerHTML = `<iframe src="/player-videojs.html?device_id=${encodeURIComponent(deviceId)}&preview=1&muted=1" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen"></iframe>`;
    return;
  }
  
  // ВСЕГДА показываем заглушку в live preview (не контент устройства)
  // Логика: Preview используется только для предпросмотра файлов (кнопка "Превью")
  // Когда устройство воспроизводит контент - показываем заглушку, избегая двойной загрузки
  const placeholderUrl = `/player-videojs.html?device_id=${encodeURIComponent(deviceId)}&preview=1&muted=1`;
  const frame = filePreview.querySelector('iframe');
  if (frame && !frame.src.includes(placeholderUrl)) {
    frame.src = placeholderUrl;
    resetPreviewHighlightState();
    currentPreviewContext = { deviceId, file: null, page: null };
  } else if (!frame) {
    resetPreviewHighlightState();
    currentPreviewContext = { deviceId, file: null, page: null };
    filePreview.innerHTML = `<iframe src="${placeholderUrl}" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen"></iframe>`;
  }
}

/* Выбор устройства: обновляем подсветку и список файлов, не сбрасывая выбранный файл, если он ещё существует */
async function selectDevice(id, resetPage = true) {
  currentDevice = id;
  
  // ИСПРАВЛЕНО: При явном выборе устройства сбрасываем выбранный файл
  if (resetPage) {
    filePage = 0; // Сброс пагинации файлов при смене устройства
    currentFile = null; // Сброс выбранного файла
    // КРИТИЧНО: Очищаем выделение миниатюр (состояние хранится по устройствам)
    // Сбрасываем выделение миниатюр
    filePreview.querySelectorAll('.thumbnail-preview[data-selected="1"]').forEach(t => t.removeAttribute('data-selected'));
    filePreview.querySelectorAll('.thumbnail-preview').forEach(t => {
      t.style.border = '';
      t.style.borderColor = '';
      t.style.boxShadow = '';
    });
  }
  
  // Обновляем URL при переключении устройства
  const url = new URL(location.href);
  url.searchParams.set('device_id', id);
  history.replaceState(null, '', url.toString());
  
  tvList.querySelectorAll('.tvTile').forEach(li => li.classList.remove('active'));
  const item = tvList.querySelector(`.tvTile[data-id="${id}"]`);
  if (item) item.classList.add('active');
  
  // ИСПРАВЛЕНО: При явном выборе устройства снимаем подсветку файлов
  if (resetPage) {
    fileList.querySelectorAll('.file-item').forEach(item => item.classList.remove('active'));
  }
  
  await loadFiles();
  await syncPreviewWithPlayerState();
  
}

/* Загрузка и рендер файлов для текущего ТВ */
async function loadFiles() {
  if (!currentDevice) return;
  
  // Находим устройство для отображения имени и количества файлов
  const device = devices.find(d => d.device_id === currentDevice);
  const deviceName = device ? (device.name || nodeNames[currentDevice] || currentDevice) : currentDevice;
  
  // Обновляем заголовок плитки файлов
  const title = document.getElementById('filesPaneTitle');
  const meta = document.getElementById('filesPaneMeta');
  if (title) title.textContent = `Файлы на ${deviceName}`;
  if (meta) meta.textContent = 'Загрузка...';
  
  // Обновим информацию о прогрессе под заголовком панели превью
  updatePlaybackInfoUI();
  
  try {
    // КРИТИЧНО: Используем files-with-status для получения разрешения видео
    const res = await speakerFetch(`/api/devices/${encodeURIComponent(currentDevice)}/files-with-status`);
    if (!res.ok) {
      console.error('Failed to load files:', res.status);
      fileList.innerHTML = '<li class="item" style="text-align:center; padding:var(--space-xl)"><div class="meta">Ошибка загрузки файлов</div></li>';
      if (meta) meta.textContent = '0 файлов';
      return;
    }
    const filesData = await res.json();

  // Поддержка старого формата (массив строк) и нового формата (массив объектов)
  // ВАЖНО: Фильтруем заглушки - спикеру они не нужны в списке файлов
  allFiles = filesData
    .filter(item => {
      // Убираем заглушки из списка
      if (typeof item === 'object' && item.isPlaceholder) {
        return false;
      }
      return true;
    })
    .map(item => {
      if (typeof item === 'string') {
        return { safeName: item, originalName: item, resolution: null };
      }
      return { 
        safeName: item.name || item.safeName || item.originalName, 
        originalName: item.originalName || item.name || item.safeName,
        resolution: item.resolution || null
      };
    });

  if (!allFiles || allFiles.length === 0) {
    fileList.innerHTML = `
      <li class="item" style="text-align:center; padding:var(--space-xl)">
        <div class="meta">Нет файлов</div>
      </li>
    `;
    // Очистить пейджер файлов если есть
    const pager = document.getElementById('filePager');
    if (pager) pager.innerHTML = '';
    if (meta) meta.textContent = '0 файлов';
    return;
  }
  
  // Обновляем счетчик файлов
  const totalFilesCount = allFiles.length;
  if (meta) meta.textContent = `${totalFilesCount} файл${totalFilesCount === 1 ? '' : totalFilesCount > 1 && totalFilesCount < 5 ? 'а' : 'ов'}`;
  
  // Обновляем отображение прогресса из кэша (если есть)
  updatePlaybackInfoUI();

  // Пагинация файлов
  const pageSize = SPEAKER_PAGE_SIZE; // Фиксированное значение 10
  const totalPages = Math.max(1, Math.ceil(allFiles.length / pageSize));
  if (filePage >= totalPages) filePage = totalPages - 1;
  const start = filePage * pageSize;
  const end = Math.min(start + pageSize, allFiles.length);
  const files = allFiles.slice(start, end);

  fileList.innerHTML = files.map(({ safeName, originalName, resolution }) => {
    // Определяем расширение файла
    const hasExtension = safeName.includes('.');
    const ext = hasExtension ? safeName.split('.').pop().toLowerCase() : '';
    
    // Определяем тип файла (включая папки)
    let type = 'VID'; // По умолчанию
    let typeLabel = 'Видео'; // Русское название
    
    if (ext === 'pdf') {
      type = 'PDF';
      typeLabel = 'PDF';
    } else if (ext === 'pptx') {
      type = 'PPTX';
      typeLabel = 'Презентация';
    } else if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
      type = 'IMG';
      typeLabel = 'Изображение';
    } else if (ext === 'zip' || !hasExtension) {
      // ZIP или папка без расширения - это папка с изображениями
      type = 'FOLDER';
      typeLabel = 'Папка';
    }
    
    // НОВОЕ: Определяем разрешение для видео
    let resolutionLabel = '';
    if (type === 'VID' && resolution) {
      const width = resolution.width || 0;
      const height = resolution.height || 0;
      
      if (width >= 3840 || height >= 2160) {
        resolutionLabel = '4K';
      } else if (width >= 1920 || height >= 1080) {
        resolutionLabel = 'FHD';
      } else if (width >= 1280 || height >= 720) {
        resolutionLabel = 'HD';
      } else if (width > 0) {
        resolutionLabel = 'SD';
      }
    }
    
    // Используем safeName для сравнения с currentFile (для обратной совместимости)
    const active = currentFile === safeName || currentFile === originalName;
    // Убираем расширение из отображаемого имени (как в админке)
    const displayName = originalName.replace(/\.[^.]+$/, '');
    
    return `
      <li class="file-item ${active ? 'active' : ''}" 
          data-safe="${encodeURIComponent(safeName)}" 
          data-original="${encodeURIComponent(originalName)}"
          style="
            display:grid; 
            grid-template-columns:3fr 1fr; 
            cursor:pointer; 
            padding:0; 
            border-radius:var(--radius-md);
            border:1px solid var(--border);
            overflow:hidden;
            background:transparent;
            transition:all 0.2s;
            min-height:72px;
          ">
        
        <!-- Левая часть: информация о файле (75%) -->
        <div class="file-info" style="
          padding:8px 12px; 
          min-width:0; 
          display:flex; 
          flex-direction:column; 
          justify-content:center;
          background:var(--panel);
        ">
          <div class="file-item-name" title="${displayName}" 
               style="font-size:1rem; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-bottom:3px; line-height:1.3;">
            ${displayName}
          </div>
          <div class="file-meta" style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            <span class="file-type-badge" style="
              display:inline-block;
              padding:2px 6px;
              border:1px solid rgba(255,255,255,0.15);
              border-radius:3px;
              font-size:0.75rem;
              font-weight:500;
              color:var(--text);
              background:rgba(255,255,255,0.05);
              white-space:nowrap;
              line-height:1.2;
            ">${typeLabel}</span>
            ${resolutionLabel ? `
              <span class="resolution-badge" style="
                display:inline-block;
                padding:2px 6px;
                border:1px solid var(--brand);
                border-radius:3px;
                font-size:0.75rem;
                font-weight:500;
                color:var(--brand);
                background:var(--brand-light);
                white-space:nowrap;
                line-height:1.2;
              ">${resolutionLabel}</span>
            ` : ''}
          </div>
        </div>
        
        <!-- Правая часть: Play зона (25%) - часть карточки -->
        <div class="playBtn" 
             data-safe="${encodeURIComponent(safeName)}" 
             data-original="${encodeURIComponent(originalName)}"
             style="
               background:var(--brand);
               color:white;
               display:flex;
               align-items:center;
               justify-content:center;
               font-size:2rem;
               cursor:pointer;
               transition:background 0.2s;
               user-select:none;
             "
             onmouseover="this.style.background='var(--brand-hover)'"
             onmouseout="this.style.background='var(--brand)'"
             role="button"
             tabindex="0"
             aria-label="Воспроизвести ${displayName}">
          ▶
        </div>
      </li>
    `;
  }).join('');

  // Если выбранного файла больше нет — сбросить выбор и показать живое превью ТВ
  const fileExists = allFiles.some(f => f.safeName === currentFile || f.originalName === currentFile);
  if (currentFile && !fileExists) {
    currentFile = null;
    showLivePreviewForTV(currentDevice);
  } else if (!allFiles.length && !currentFile) {
    showLivePreviewForTV(currentDevice);
  }

  // Рендер пейджера файлов
  let filePager = document.getElementById('filePager');
  if (!filePager) {
    filePager = document.createElement('div');
    filePager.id = 'filePager';
    filePager.className = 'meta';
    filePager.style.display = 'flex';
    filePager.style.justifyContent = 'space-between';
    filePager.style.alignItems = 'center';
    filePager.style.gap = '8px';
    filePager.style.marginTop = 'var(--space-md)';
    fileList.parentElement && fileList.parentElement.appendChild(filePager);
  }
  
  if (totalPages > 1) {
    filePager.innerHTML = `
      <button class="secondary" id="filePrev" ${filePage<=0?'disabled':''} style="min-width:80px">Назад</button>
      <span style="white-space:nowrap">Стр. ${filePage+1} из ${totalPages}</span>
      <button class="secondary" id="fileNext" ${filePage>=totalPages-1?'disabled':''} style="min-width:80px">Вперёд</button>
    `;
    const prev = document.getElementById('filePrev');
    const next = document.getElementById('fileNext');
    if (prev) prev.onclick = () => { if (filePage>0) { filePage--; loadFiles(); } };
    if (next) next.onclick = () => { if (filePage<totalPages-1) { filePage++; loadFiles(); } };
  } else {
    filePager.innerHTML = '';
  }

  // Клик по карточке файла (кроме кнопки) - показать превью
  fileList.querySelectorAll('.file-item').forEach(item => {
    item.onclick = async (e) => {
      // Если кликнули по кнопке "Воспроизвести" - не обрабатываем (у кнопки свой обработчик)
      if (e.target.closest('.playBtn')) return;
      
      const safeName = decodeURIComponent(item.getAttribute('data-safe'));
      const originalName = decodeURIComponent(item.getAttribute('data-original'));
      
      setCurrentFileSelection(safeName, item);
      previewManuallyClosed = false;
      
      // Определяем тип файла
      const hasExtension = safeName.includes('.');
      const ext = hasExtension ? safeName.split('.').pop().toLowerCase() : '';
      
      // Для папок, PDF и PPTX показываем сетку миниатюр
      if (!hasExtension || ext === 'pdf' || ext === 'pptx') {
        await showStaticPreview(currentDevice, safeName, !hasExtension ? 'folder' : ext, { initiatedByUser: true });
      } else {
        // Для видео и обычных изображений показываем в iframe
        let src = `/player-videojs.html?device_id=${encodeURIComponent(currentDevice)}&preview=1&muted=1&file=${encodeURIComponent(safeName)}`;
        
        if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
          src += `&type=image&page=1`;
        }
        
        src += `&t=${Date.now()}`;
        
        const frame = filePreview.querySelector('iframe');
        if (frame) {
          frame.src = src;
        } else {
          filePreview.innerHTML = `<iframe src="${src}" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen"></iframe>`;
        }
      }
    };
  });

  fileList.querySelectorAll('.playBtn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation(); // Останавливаем всплытие, чтобы не вызвался клик по карточке
      
      const safeName = decodeURIComponent(btn.getAttribute('data-safe'));
      const originalName = decodeURIComponent(btn.getAttribute('data-original'));
      setCurrentFileSelection(safeName, btn.closest('.file-item'));
      
      // Сбрасываем флаг закрытия при новом воспроизведении
      previewManuallyClosed = false;
      
      socket.emit('control/play', { device_id: currentDevice, file: safeName });
      
      // Определяем тип файла
      const hasExtension = safeName.includes('.');
      const ext = hasExtension ? safeName.split('.').pop().toLowerCase() : '';
      const isStaticContent = !hasExtension || ext === 'pdf' || ext === 'pptx';
      
      // Для PDF/PPTX/FOLDER - открываем превью автоматически
      if (isStaticContent) {
        console.log('[Speaker] 📊 Открываем превью для статичного контента:', safeName);
      } else {
      // Для видео и обычных изображений - показываем заглушку
        // Чтобы не было двойной загрузки (preview + основной плеер)
        setTimeout(() => {
          const placeholderUrl = `/player-videojs.html?device_id=${encodeURIComponent(currentDevice)}&preview=1&muted=1`;
          const frame = filePreview.querySelector('iframe');
          if (frame) {
            frame.src = placeholderUrl;
          } else {
            filePreview.innerHTML = `<iframe src="${placeholderUrl}" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen"></iframe>`;
          }
        }, 300);
      }
    };
  });
  
  } catch (error) {
    console.error('Failed to render files:', error);
    fileList.innerHTML = '<li class="item" style="text-align:center; padding:var(--space-xl)"><div class="meta">Ошибка загрузки файлов</div></li>';
  }

  await syncPreviewWithPlayerState();
}

/* Установка выбранного файла и подсветка строки */
function setCurrentFileSelection(filename, itemEl) {
  currentFile = filename;
  // Убираем активное состояние у всех элементов
  fileList.querySelectorAll('.file-item').forEach(li => {
    li.classList.remove('active');
  });
  
  // Добавляем активное состояние выбранному элементу
  if (itemEl) {
    itemEl.classList.add('active');
  }
}

// Форматирование времени в mm:ss
function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function updatePlaybackInfoUI() {
  const infoEl = document.getElementById('previewPlaybackInfo');
  if (!infoEl || !currentDevice) return;

  // Показываем таймер ТОЛЬКО когда реально играет видео
  const device = devices.find(d => d.device_id === currentDevice);
  if (!device || !device.current || device.current.type !== 'video') {
    infoEl.textContent = '';
    return;
  }

  const prog = playbackProgressByDevice.get(currentDevice);
  if (!prog) {
    infoEl.textContent = '';
    return;
  }
  
  // Находим файл в списке по имени файла (может быть safeName или originalName)
  let displayName = (prog.file || '').replace(/\.[^.]+$/, ''); // Fallback на имя файла без расширения
  if (prog.file && allFiles && allFiles.length > 0) {
    const fileInfo = allFiles.find(f => 
      f.safeName === prog.file || 
      f.originalName === prog.file ||
      f.safeName === prog.file.replace(/\.[^.]+$/, '') ||
      f.originalName === prog.file.replace(/\.[^.]+$/, '')
    );
    if (fileInfo && fileInfo.originalName) {
      // Используем originalName из списка файлов (как в списке на панели)
      displayName = fileInfo.originalName.replace(/\.[^.]+$/, '');
    }
  }
  
  const total = (prog.duration && prog.duration > 0) ? formatTime(prog.duration) : '--:--';
  infoEl.textContent = `Сейчас: ${displayName} — ${formatTime(prog.currentTime)} / ${total}`;
}

// Прием прогресса от плееров
socket.on('player/progress', ({ device_id, type, file, currentTime, duration }) => {
  if (!device_id) return;
  playbackProgressByDevice.set(device_id, { file, currentTime: Number(currentTime)||0, duration: Number(duration)||0 });
  if (device_id === currentDevice) {
    updatePlaybackInfoUI();
  }
});

/* Верхняя панель управления */
document.getElementById('playBtn').onclick = () => {
  if (!currentDevice) return;
  
  const device = devices.find(d => d.device_id === currentDevice);
  
  // Если устройство на паузе - продолжаем воспроизведение (resume)
  if (device && device.current && device.current.state === 'paused') {
    console.log(`[Speaker] ▶️ Resume: ${currentDevice} (файл: ${device.current.file || 'unknown'})`);
    socket.emit('control/play', { device_id: currentDevice }); // Сервер отправит player/resume
    // Обновляем локальное состояние
    device.current.state = 'playing';
  } 
  // Если выбран файл из списка - воспроизводим его
  else if (currentFile) {
    console.log(`[Speaker] ▶️ Play файл: ${currentFile}`);
    socket.emit('control/play', { device_id: currentDevice, file: currentFile });
  }
  // Иначе пробуем resume (если было что-то до перезапуска сервера)
  else {
    console.log(`[Speaker] ▶️ Resume (нет currentFile)`);
    socket.emit('control/play', { device_id: currentDevice });
  }
};

document.getElementById('pauseBtn').onclick = () => {
  if (!currentDevice) return;
  
  const device = devices.find(d => d.device_id === currentDevice);
  
  // Обновляем локальное состояние устройства на "пауза"
  if (device && device.current) {
    device.current.state = 'paused';
    console.log(`[Speaker] ⏸️ Пауза: ${currentDevice} (файл: ${device.current.file || 'unknown'})`);
  }
  
  socket.emit('control/pause', { device_id: currentDevice });
};
document.getElementById('restartBtn').onclick = () => {
  if (!currentDevice) return;
  socket.emit('control/restart', { device_id: currentDevice });
};
document.getElementById('stopBtn').onclick = () => {
  if (!currentDevice) return;
  socket.emit('control/stop', { device_id: currentDevice });
  // Мгновенно убираем таймер при стопе
  playbackProgressByDevice.delete(currentDevice);
  updatePlaybackInfoUI();
};
document.getElementById('pdfPrevBtn').onclick = () => {
  if (!currentDevice) return;
  socket.emit('control/pdfPrev', { device_id: currentDevice });
};
document.getElementById('pdfNextBtn').onclick = () => {
  if (!currentDevice) return;
  socket.emit('control/pdfNext', { device_id: currentDevice });
};
document.getElementById('pdfCloseBtn').onclick = () => {
  if (!currentDevice) return;
  
  // Устанавливаем флаг что пользователь ЯВНО закрыл превью
  previewManuallyClosed = true;
  
  // Останавливаем воспроизведение
  socket.emit('control/stop', { device_id: currentDevice });
  
  // Сбрасываем выбранный файл
  currentFile = null;
  
  // Убираем active класс со всех файлов
  fileList.querySelectorAll('.file-item').forEach(item => {
    item.classList.remove('active');
  });
  
  // Возвращаем preview в исходное состояние (показываем live preview устройства)
  showLivePreviewForTV(currentDevice, true);
  
  console.log('[Speaker] ✕ Закрыть: preview возвращён в исходное состояние, автооткрытие отключено');
};

/* Реакция на обновления с сервера — дебаунс + сохранение выбора */
const onDevicesUpdated = debounce(async () => {
  const prevDevice = currentDevice;
  const prevFile = currentFile;
  await loadDevices();
  if (prevDevice && devices.find(d => d.device_id === prevDevice)) {
    // ИСПРАВЛЕНО: НЕ сбрасываем страницу при обновлении (false)
    await selectDevice(prevDevice, false);
    if (prevFile) {
      const btn = fileList.querySelector(`.previewBtn[data-safe='${encodeURIComponent(prevFile)}']`);
      if (btn) {
        const itemEl = btn.closest('.file-item');
        if (itemEl) itemEl.classList.add('active');
        currentFile = prevFile;
      } else {
        currentFile = null;
        showLivePreviewForTV(prevDevice);
      }
    } else {
      showLivePreviewForTV(prevDevice);
    }
  }
}, 150);

// онлайн/офлайн статусы плееров
socket.on('player/online', ({ device_id }) => {
  readyDevices.add(device_id);
  renderTVList();
});
socket.on('player/offline', ({ device_id }) => {
  readyDevices.delete(device_id);
  renderTVList();
});

// Initialize online statuses on load/refresh
socket.on('players/onlineSnapshot', (list) => {
  try {
    readyDevices = new Set(Array.isArray(list) ? list : []);
  } catch {
    readyDevices = new Set();
  }
  renderTVList();
});

socket.on('devices/updated', onDevicesUpdated);
const onPreviewRefresh = debounce(async ({ device_id }) => {
  try {
    const res = await speakerFetch('/api/devices');
    if (!res.ok) return;
    devices = sortDevices(await res.json());
  } catch (err) {
    console.error('Failed to refresh devices:', err);
    return;
  }

  if (!device_id) return;
  const device = devices.find(d => d.device_id === device_id);
  if (!device || !device.current) return;

  playerStateByDevice.set(device_id, {
    type: device.current.type,
    file: device.current.file,
    page: Number(device.current.page) || 1,
  });

  if (device_id === currentDevice) {
    requestPreviewSync();
  }
}, 200);

socket.on('preview/refresh', onPreviewRefresh);

// Функция для выделения текущей миниатюры
function highlightCurrentThumbnail(pageNumber, context) {
  const normalizedPage = Math.max(1, Number(pageNumber) || 1);
  const previewContext = context || getPreviewContext();
  if (!previewContext.deviceId || !previewContext.file) return;

  currentPreviewContext = { ...previewContext, page: normalizedPage };

  const thumbnails = filePreview.querySelectorAll('.thumbnail-preview');
  if (!thumbnails.length) return;

  thumbnails.forEach((thumb) => {
    const thumbPage = parseInt(thumb.getAttribute('data-page'), 10);
    thumb.classList.toggle('is-active', thumbPage === normalizedPage);
    if (thumbPage === normalizedPage) {
      thumb.setAttribute('data-selected', '1');
    } else {
      thumb.removeAttribute('data-selected');
    }
  });

  const targetThumb = Array.from(thumbnails).find(
    (thumb) => parseInt(thumb.getAttribute('data-page'), 10) === normalizedPage
  );
  if (targetThumb) {
    targetThumb.scrollIntoView({ behavior: 'smooth', block: 'center' });
    console.log('[Speaker] 🎯 Выделена миниатюра:', normalizedPage);
  }
}

// Слушаем события смены страниц для выделения активной миниатюры
['pdfPage', 'pptxPage', 'folderPage'].forEach(eventName => {
  socket.on(`player/${eventName}`, (pageNumber) => {
    const page = Math.max(1, Number(pageNumber) || 1);
    const state = playerStateByDevice.get(currentDevice) || {};
    if (!state.file) return;
    playerStateByDevice.set(currentDevice, { ...state, page });
    requestPreviewSync();
  });
});

/* ===== Жесты для тач: свайп по превью PDF (Prev/Next) ===== */
function attachTouchGestures() {
  const area = document.getElementById('filePreview');
  if (!area) return;
  let startX = 0, startY = 0, active = false;
  area.addEventListener('touchstart', (e) => {
    if (!e.touches || !e.touches.length) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; active = true;
  }, { passive: true });
  area.addEventListener('touchend', (e) => {
    if (!active) return; active = false;
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      if (!currentDevice) return;
      if (dx < 0) socket.emit('control/pdfNext', { device_id: currentDevice });
      else socket.emit('control/pdfPrev', { device_id: currentDevice });
    }
  }, { passive: true });
}

