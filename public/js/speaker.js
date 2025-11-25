import { initThemeToggle } from './theme.js';
import { sortDevices, debounce, loadNodeNames, getPageSize } from './utils.js';
import { ensureAuth, speakerFetch, logout } from './speaker/auth.js';
import { getCrossIcon, getVolumeMutedIcon, getVolumeOnIcon, getVolumeUnknownIcon } from './shared/svg-icons.js';

const SPEAKER_CACHE_SESSION_FLAG = 'vc-speaker-cache-cleared-v1';

clearPwaCachesOnLaunch();

async function clearPwaCachesOnLaunch() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  if (!navigator.onLine) return; // Не чистим кэш офлайн, иначе пропадёт офлайн-режим
  if (sessionStorage.getItem(SPEAKER_CACHE_SESSION_FLAG) === '1') return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration?.active;
    if (!worker) return;

    const result = await sendMessageToServiceWorker(worker, { type: 'CLEAR_CACHE' });
    sessionStorage.setItem(SPEAKER_CACHE_SESSION_FLAG, '1');
    console.log('[Speaker] PWA cache cleared on launch', result);

    // После очистки кэша перезагружаем страницу, чтобы все ресурсы подтянулись заново
    setTimeout(() => {
      window.location.reload();
    }, 150);
  } catch (err) {
    sessionStorage.removeItem(SPEAKER_CACHE_SESSION_FLAG);
    console.warn('[Speaker] Не удалось очистить PWA-кэш при запуске:', err);
  }
}

function sendMessageToServiceWorker(worker, message, timeoutMs = 5000) {
  if (typeof MessageChannel === 'undefined') {
    // Фолбэк: отправляем без подтверждения
    worker.postMessage(message);
    return Promise.resolve({ success: false, note: 'MessageChannel not supported' });
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.onmessage = null;
      reject(new Error('Service Worker response timeout'));
    }, timeoutMs);

    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };

    try {
      worker.postMessage(message, [channel.port2]);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

const socket = io();

const tvList = document.getElementById('tvList');
const fileList = document.getElementById('fileList');
const filePreview = document.getElementById('filePreview');
const pdfPrevBtn = document.getElementById('pdfPrevBtn');
const pdfNextBtn = document.getElementById('pdfNextBtn');
const pdfCloseBtn = document.getElementById('pdfCloseBtn');
const volumePanel = document.getElementById('volumePanel');
const volumeSlider = document.getElementById('volumeSlider');
const volumeLevelLabel = document.getElementById('volumeLevelLabel');
const volumeMuteStatus = document.getElementById('volumeMuteStatus');
const volumeMuteBtn = document.getElementById('volumeMuteBtn');

const STATIC_CONTENT_TYPES = new Set(['pdf', 'pptx', 'folder']);
const FOLDER_INTERVAL_OPTIONS = [5, 10, 15, 20];
const DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS = 10;
let previewLoadToken = 0;
const formatDuration = (value) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).toString().padStart(2, '0')}`;
};

function clampVolumePercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return Math.max(0, Math.min(100, Math.round(clamped / VOLUME_STEP) * VOLUME_STEP));
}

function resolveVolumeIndicator(volumeState, isReady) {
  const hasVolumeState = Boolean(volumeState);
  const clampedLevel = hasVolumeState ? clampVolumePercent(volumeState.level) : null;
  const levelText = (hasVolumeState && clampedLevel !== null) ? `${clampedLevel}%` : '--%';
  const isMuted = Boolean(volumeState?.muted);
  let statusText;
  if (!isReady) {
    statusText = 'Устройство офлайн';
  } else if (!hasVolumeState) {
    statusText = 'Нет данных';
  } else {
    statusText = isMuted ? 'Звук выключен' : 'Звук включен';
  }
  let color;
  if (!isReady) {
    color = 'var(--muted-2)';
  } else if (!hasVolumeState) {
    color = 'var(--muted)';
  } else if (isMuted) {
    color = 'var(--danger)';
  } else {
    color = 'var(--success)';
  }
  return { hasVolumeState, isMuted, levelText, statusText, color };
}

function getVolumeIconSvg({ hasVolumeState, isMuted, color, size = 18 }) {
  if (hasVolumeState) {
    return isMuted ? getVolumeMutedIcon(size, color) : getVolumeOnIcon(size, color);
  }
  return getVolumeUnknownIcon(size, color);
}

function updateVolumeMuteButtonUI(volumeState, isReady) {
  if (!volumeMuteBtn) return;
  const info = resolveVolumeIndicator(volumeState, isReady);
  const iconHtml = getVolumeIconSvg({ ...info, size: 20 });
  let actionLabel;
  if (!isReady) {
    actionLabel = 'Устройство офлайн';
  } else if (!info.hasVolumeState) {
    actionLabel = 'Нет данных';
  } else {
    actionLabel = info.isMuted ? 'Включить звук' : 'Заглушить звук';
  }
  volumeMuteBtn.innerHTML = `
    <span class="volume-btn-icon" aria-hidden="true">${iconHtml}</span>
  `;
  volumeMuteBtn.setAttribute('aria-label', actionLabel);
  volumeMuteBtn.setAttribute('title', actionLabel);
}

function storeVolumeState(deviceId, state = {}) {
  if (!deviceId) return;
  const prev = volumeStateByDevice.get(deviceId) || { level: 50, muted: false, updatedAt: null };
  const levelCandidate = typeof state.level === 'number' ? clampVolumePercent(state.level) : null;
  const nextLevel = levelCandidate !== null ? levelCandidate : prev.level;
  const nextMuted = typeof state.muted === 'boolean' ? state.muted : prev.muted;
  volumeStateByDevice.set(deviceId, {
    level: nextLevel,
    muted: nextMuted,
    updatedAt: state.updated_at || prev.updatedAt || null
  });
  clearVolumeFallback(deviceId);
  if (deviceId === currentDevice) {
    updateVolumeUI();
  }
  if (tvList) {
    renderTVList();
  }
}

function getVolumeState(deviceId) {
  return volumeStateByDevice.get(deviceId) || null;
}

async function fetchDeviceVolumeState(deviceId) {
  if (!deviceId) return;
  try {
    const res = await speakerFetch(`/api/devices/${encodeURIComponent(deviceId)}/volume`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    storeVolumeState(deviceId, data);
  } catch (err) {
    console.warn('[Speaker] Не удалось получить громкость устройства', deviceId, err.message);
  }
}

async function ensureVolumeState(deviceId) {
  if (!deviceId) {
    updateVolumeUI();
    return;
  }
  if (volumeStateByDevice.has(deviceId)) {
    updateVolumeUI();
    return;
  }
  setVolumeWaitingUI('Ждём данные от устройства...');
  scheduleVolumeFallback(deviceId);
}

function sendVolumeCommand(command = {}) {
  if (!currentDevice || !readyDevices.has(currentDevice)) return;
  const payload = {
    device_id: currentDevice,
    ...command
  };
  const hasLevelChange = typeof payload.level === 'number' && !Number.isNaN(payload.level);
  const hasDeltaChange = typeof payload.delta === 'number' && !Number.isNaN(payload.delta);
  if (typeof payload.muted === 'undefined' && (hasLevelChange || hasDeltaChange)) {
    payload.muted = false;
  }
  socket.emit('control/volume', payload);
}

/**
 * Отправляет текущее состояние громкости перед запуском контента
 * Это гарантирует, что громкость будет применена даже если синхронизация при регистрации не сработала
 */
function sendVolumeBeforePlay(deviceId) {
  if (!deviceId) return;
  const volumeState = getVolumeState(deviceId);
  if (volumeState) {
    // Отправляем текущее состояние громкости перед play
    socket.emit('control/volume', {
      device_id: deviceId,
      level: volumeState.level,
      muted: volumeState.muted
    });
    console.log('[Speaker] 🔊 Sending volume before play:', { deviceId, level: volumeState.level, muted: volumeState.muted });
  }
}

function setVolumeControlsDisabled(disabled) {
  if (volumeSlider) volumeSlider.disabled = disabled;
  if (volumeMuteBtn) volumeMuteBtn.disabled = disabled;
}

function setVolumeWaitingUI(message) {
  if (!volumePanel) return;
  setVolumeControlsDisabled(true);
  if (volumeLevelLabel) volumeLevelLabel.textContent = '--%';
  if (volumeSlider) volumeSlider.value = 0;
  updateVolumeMuteButtonUI(null, false);
}

function updateVolumeUI() {
  if (!volumePanel) return;
  const state = currentDevice ? getVolumeState(currentDevice) : null;
  const isReady = currentDevice ? readyDevices.has(currentDevice) : false;
  const hasDevice = Boolean(currentDevice);
  const disabled = !state || !isReady;
  setVolumeControlsDisabled(disabled);
  
  if (!state) {
    if (!hasDevice) {
      setVolumeWaitingUI('Выберите устройство');
    } else if (!isReady) {
      setVolumeWaitingUI('Устройство офлайн');
    } else {
      setVolumeWaitingUI();
    }
    return;
  }
  
  const volumeInfo = resolveVolumeIndicator(state, isReady);
  const displayLevel = clampVolumePercent(state.level) ?? 0;
  if (volumeLevelLabel) volumeLevelLabel.textContent = volumeInfo.levelText;
  if (volumeSlider) {
    volumeSlider.value = displayLevel;
  }
  updateVolumeMuteButtonUI(state, isReady);
}

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

function escapeHtml(value = '') {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
let folderPlaylistState = null;
let folderPlaylistIntervalSeconds = DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS;
const volumeStateByDevice = new Map();
const VOLUME_STEP = 5;
const VOLUME_SOCKET_WAIT_MS = 1500;
const volumeFallbackTimers = new Map();

function clearVolumeFallback(deviceId) {
  if (!deviceId) return;
  const timer = volumeFallbackTimers.get(deviceId);
  if (timer) {
    clearTimeout(timer);
    volumeFallbackTimers.delete(deviceId);
  }
}

function scheduleVolumeFallback(deviceId) {
  if (!deviceId) return;
  clearVolumeFallback(deviceId);
  const timer = setTimeout(() => {
    volumeFallbackTimers.delete(deviceId);
    fetchDeviceVolumeState(deviceId);
  }, VOLUME_SOCKET_WAIT_MS);
  volumeFallbackTimers.set(deviceId, timer);
}

if (volumeSlider) {
  volumeSlider.addEventListener('input', () => {
    if (volumeLevelLabel) volumeLevelLabel.textContent = `${volumeSlider.value}%`;
  });
  volumeSlider.addEventListener('change', () => {
    if (volumeSlider.disabled || !currentDevice) return;
    sendVolumeCommand({ level: Number(volumeSlider.value) });
  });
}

if (volumeMuteBtn) {
  volumeMuteBtn.addEventListener('click', () => {
    if (volumeMuteBtn.disabled) return;
    const state = getVolumeState(currentDevice) || {};
    sendVolumeCommand({ muted: !state.muted });
  });
}

/**
 * Управление видимостью кнопок навигации (Назад, Вперёд, Закрыть)
 * Показываем только для папок с плейлистом
 */
function updatePreviewControlButtons() {
  if (!pdfPrevBtn || !pdfNextBtn || !pdfCloseBtn) return;
  
  // Проверяем, есть ли в превью сетка миниатюр папки (это означает, что открыто превью папки)
  const hasThumbnails = filePreview.querySelector('.thumbnail-preview');
  
  // Проверяем, есть ли iframe напрямую в filePreview (видео превью) - если есть, кнопки должны быть скрыты
  // НО если iframe внутри static-preview-layout, это не считается видео превью
  const hasDirectIframe = filePreview.querySelector(':scope > iframe');
  const hasStaticLayout = filePreview.querySelector('.static-preview-layout');
  
  // Также проверяем, есть ли активный плейлист папки
  const device = devices.find(d => d.device_id === currentDevice);
  const isFolderWithPlaylist = device && 
    device.current && 
    device.current.type === 'folder' && 
    device.current.playlistActive === true;
  
  // Показываем кнопки ТОЛЬКО для папок: либо когда открыто превью (миниатюры), либо когда активен плейлист
  // НО скрываем, если показывается iframe напрямую (видео превью), а не внутри static-preview-layout
  const shouldShow = (hasThumbnails || isFolderWithPlaylist) && !hasDirectIframe;
  
  pdfPrevBtn.style.display = shouldShow ? 'inline-block' : 'none';
  pdfNextBtn.style.display = shouldShow ? 'inline-block' : 'none';
  pdfCloseBtn.style.display = shouldShow ? 'inline-block' : 'none';

  if (volumePanel) {
    volumePanel.style.display = shouldShow ? 'none' : 'flex';
  }
}

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

function isFolderPlaylistActiveFor(deviceId, file) {
  return (
    !!folderPlaylistState &&
    folderPlaylistState.deviceId === deviceId &&
    folderPlaylistState.file === file
  );
}

function updateFolderPlaylistIntervalButtons(value = folderPlaylistIntervalSeconds) {
  const buttons = document.querySelectorAll('.folder-playlist-interval-btn');
  if (!buttons.length) return;
  const normalizedValue = Math.max(1, Number(value) || DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS);
  
  // Проверяем, запущен ли плейлист
  const isPlaylistRunning = !!folderPlaylistState;
  
  let matched = false;
  buttons.forEach((btn) => {
    const interval = Number(btn.getAttribute('data-interval'));
    const isActive = interval === normalizedValue;
    btn.classList.toggle('is-active', isActive);
    // Добавляем класс is-running только если плейлист запущен И это выбранный интервал
    btn.classList.toggle('is-running', isActive && isPlaylistRunning);
    if (isActive) {
      folderPlaylistIntervalSeconds = interval;
      matched = true;
    }
  });
  if (!matched) {
    buttons.forEach((btn, idx) => {
      const shouldActivate = idx === 1; // по умолчанию 10 секунд
      btn.classList.toggle('is-active', shouldActivate);
      btn.classList.toggle('is-running', shouldActivate && isPlaylistRunning);
      if (shouldActivate) {
        folderPlaylistIntervalSeconds = Number(btn.getAttribute('data-interval'));
      }
    });
  }
}

function updateFolderPlaylistButtonState() {
  const btn = document.getElementById('folderPlaylistBtn');
  if (!btn) return;
  const deviceId = btn.getAttribute('data-device');
  const file = btn.getAttribute('data-file');
  
  if (!deviceId || !file) return;
  
  // Проверяем состояние на сервере
  const device = devices.find(d => d.device_id === deviceId);
  const serverPlaylistActive = device && device.current && 
    device.current.type === 'folder' && 
    device.current.playlistActive && 
    (device.current.playlistFile === file || device.current.file === file);
  
  // Локальное состояние или состояние с сервера
  const isActive = isFolderPlaylistActiveFor(deviceId, file) || serverPlaylistActive;
  
  // Всегда обновляем и класс, и текст синхронно
  if (isActive) {
    btn.classList.add('is-active');
    btn.textContent = 'Остановить слайдшоу';
  } else {
    btn.classList.remove('is-active');
    btn.textContent = 'Запустить как слайдшоу';
  }
  
  // Обновляем состояние кнопок интервала (добавляем is-running если плейлист активен)
  updateFolderPlaylistIntervalButtons();
  
  // Если плейлист активен на сервере, но не локально - обновляем интервал
  if (serverPlaylistActive && !isFolderPlaylistActiveFor(deviceId, file)) {
    const playlistInterval = device.current.playlistInterval || 10;
    if (playlistInterval !== folderPlaylistIntervalSeconds) {
      folderPlaylistIntervalSeconds = playlistInterval;
      updateFolderPlaylistIntervalButtons(playlistInterval);
    }
  }
}

function updateFolderPlaylistButtonStateForDevice(deviceId, file, isActive, intervalSeconds) {
  // Обновляем кнопку плейлиста если она видна для этого устройства
  const btn = document.getElementById('folderPlaylistBtn');
  if (!btn) return;
  
  const btnDeviceId = btn.getAttribute('data-device');
  const btnFile = btn.getAttribute('data-file');
  
  // Обновляем только если это та же папка
  if (btnDeviceId === deviceId && btnFile === file) {
    btn.classList.toggle('is-active', isActive);
    btn.textContent = isActive ? 'Остановить плейлист' : 'Плейлист';
    
    // Обновляем интервал если указан
    if (intervalSeconds) {
      folderPlaylistIntervalSeconds = intervalSeconds;
      updateFolderPlaylistIntervalButtons(intervalSeconds);
    }
  }
  
  // Также обновляем через основную функцию для синхронизации
  updateFolderPlaylistButtonState();
}

function startFolderPlaylist(deviceId, file, imageCount, intervalSeconds = folderPlaylistIntervalSeconds) {
  if (!deviceId || !file || imageCount < 1) return;
  
  // Останавливаем предыдущий плейлист, если он был активен и запускался для другого файла
  if (folderPlaylistState && folderPlaylistState.deviceId === deviceId && folderPlaylistState.file !== file) {
    stopFolderPlaylist('switching to different folder');
  }
  
  // Определяем начальную страницу: используем текущую страницу устройства, выделенную миниатюру или начинаем с начала
  let startPage = 1;
  
  // Сначала проверяем текущую страницу устройства из состояния
  const device = devices.find(d => d.device_id === deviceId);
  if (device && device.current && device.current.type === 'folder' && 
      (device.current.file === file || device.current.playlistFile === file)) {
    const currentPage = Number(device.current.page);
    if (currentPage && currentPage >= 1 && currentPage <= imageCount) {
      startPage = currentPage;
    }
  } else {
    // Если текущая страница устройства не найдена - проверяем выделенную миниатюру
    const activeThumbnail = filePreview.querySelector('.thumbnail-preview.is-active, .thumbnail-preview[data-selected="1"]');
    if (activeThumbnail) {
      const thumbPage = parseInt(activeThumbnail.getAttribute('data-page'), 10);
      if (thumbPage && thumbPage >= 1 && thumbPage <= imageCount) {
        startPage = thumbPage;
      }
    } else {
      // Если миниатюра не найдена - проверяем playerStateByDevice
      const state = playerStateByDevice.get(deviceId);
      if (state && state.file === file && state.page) {
        const statePage = Number(state.page);
        if (statePage && statePage >= 1 && statePage <= imageCount) {
          startPage = statePage;
        }
      }
    }
  }
  
  folderPlaylistIntervalSeconds = Math.max(1, intervalSeconds || DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS);
  folderPlaylistState = {
    deviceId,
    file,
    currentIndex: startPage,
    intervalSeconds: folderPlaylistIntervalSeconds,
  };
  // Сохраняем состояние плейлиста в localStorage
  try {
    localStorage.setItem('folderPlaylistState', JSON.stringify({
      deviceId,
      file,
      intervalSeconds: folderPlaylistIntervalSeconds,
      currentIndex: startPage,
    }));
  } catch (e) {
    // Failed to save playlist state
  }
  
  // Сообщаем серверу о новом плейлисте с начальной страницей
  // Сервер сразу покажет начальную страницу на устройстве
  socket.emit('control/playlistStart', {
    device_id: deviceId,
    file,
    intervalSeconds: folderPlaylistIntervalSeconds,
    startPage: startPage
  });
  
  updateFolderPlaylistButtonState();
  updateFolderPlaylistIntervalButtons(); // Обновляем состояние кнопок интервала (добавляем is-running)
  updatePreviewControlButtons();
}

function stopFolderPlaylist(reason = '', notifyServer = true) {
  if (!folderPlaylistState) {
    return;
  }
  const { deviceId } = folderPlaylistState;
  folderPlaylistState = null;
  // Удаляем состояние плейлиста из localStorage
  try {
    localStorage.removeItem('folderPlaylistState');
  } catch (e) {
    // Failed to remove playlist state
  }
  // Отправляем остановку плейлиста на сервер для синхронизации между панелями
  if (notifyServer && deviceId) {
    socket.emit('control/playlistStop', { device_id: deviceId });
  }
  updateFolderPlaylistButtonState();
  updateFolderPlaylistIntervalButtons(); // Обновляем состояние кнопок интервала (убираем is-running)
}

function stopFolderPlaylistIfNeeded(reason = '', context = {}) {
  if (!folderPlaylistState) return;
  const { deviceId, file } = context;
  if (deviceId && folderPlaylistState.deviceId !== deviceId) return;
  if (file && folderPlaylistState.file === file) return;
  stopFolderPlaylist(reason);
}

function toggleFolderPlaylist(deviceId, file, imageCount) {
  if (!deviceId || !file) return;
  
  // Проверяем состояние на сервере
  const device = devices.find(d => d.device_id === deviceId);
  const serverPlaylistActive = device && device.current && 
    device.current.type === 'folder' && 
    device.current.playlistActive === true && 
    (device.current.playlistFile === file || device.current.file === file);
  
  // Если плейлист активен локально или на сервере - останавливаем
  if (isFolderPlaylistActiveFor(deviceId, file) || serverPlaylistActive) {
    // Если плейлист был активен локально - останавливаем локально
    // (stopFolderPlaylist уже отправит команду на сервер)
    if (isFolderPlaylistActiveFor(deviceId, file)) {
      stopFolderPlaylist('manual toggle');
    } else {
      // Если плейлист был активен только на сервере - отправляем команду на сервер
      // Сервер отправит событие playlist/state, которое обновит UI на всех панелях
      socket.emit('control/playlistStop', { device_id: deviceId });
    }
    return;
  }
  
  // Запускаем плейлист
  const activeBtn = document.querySelector('.folder-playlist-interval-btn.is-active');
  const intervalValue = activeBtn ? Number(activeBtn.getAttribute('data-interval')) : folderPlaylistIntervalSeconds;
  startFolderPlaylist(deviceId, file, imageCount, intervalValue);
}

async function restoreFolderPlaylist() {
  try {
    const savedState = localStorage.getItem('folderPlaylistState');
    if (!savedState) return;
    
    const state = JSON.parse(savedState);
    const { deviceId, file, intervalSeconds } = state;
    
    if (!deviceId || !file) return;
    
    const device = devices.find(d => d.device_id === deviceId);
    const playlistStillActive = device &&
      device.current &&
      device.current.type === 'folder' &&
      device.current.playlistActive &&
      (device.current.playlistFile === file || device.current.file === file);
    
    if (!playlistStillActive) {
      try {
        localStorage.removeItem('folderPlaylistState');
      } catch {}
      folderPlaylistState = null;
      return;
    }
    
    folderPlaylistIntervalSeconds = intervalSeconds || DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS;
    const currentPage = Number(device.current.page) || 1;
    
    folderPlaylistState = {
      deviceId,
      file,
      currentIndex: currentPage,
      intervalSeconds: folderPlaylistIntervalSeconds,
    };
    
    updateFolderPlaylistIntervalButtons(folderPlaylistIntervalSeconds);
    updateFolderPlaylistButtonState();
  } catch (e) {
    try {
      localStorage.removeItem('folderPlaylistState');
    } catch {}
    folderPlaylistState = null;
  }
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
  const showPlaylistButton = contentType === 'folder' && imageUrls.length > 1;
  const playlistIntervalSeconds = Math.max(1, folderPlaylistIntervalSeconds || DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS);

  filePreview.innerHTML = `
    <div class="static-preview-layout">
      <div class="static-preview-scroll">
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
                   onerror="this.parentElement.innerHTML='<div style=&quot;display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-size:10px&quot;><svg xmlns=&quot;http://www.w3.org/2000/svg&quot; width=&quot;14&quot; height=&quot;14&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;2.5&quot; stroke-linecap=&quot;round&quot; stroke-linejoin=&quot;round&quot; style=&quot;display:inline-block&quot;><line x1=&quot;18&quot; y1=&quot;6&quot; x2=&quot;6&quot; y2=&quot;18&quot;></line><line x1=&quot;6&quot; y1=&quot;6&quot; x2=&quot;18&quot; y2=&quot;18&quot;></line></svg></div>'" />
              <div style="position:absolute; bottom:2px; right:4px; background:rgba(0,0,0,0.7); color:#fff; padding:2px 4px; border-radius:3px; font-size:10px; pointer-events:none">${idx + 1}</div>
            </div>
          `).join('')}
        </div>
      </div>
      ${
        showPlaylistButton
          ? `
        <div class="folder-playlist-toolbar">
          <button 
            id="folderPlaylistBtn"
            class="secondary folder-playlist-btn"
            data-device="${escapeAttr(deviceId)}"
            data-file="${escapeAttr(safeName)}"
            data-count="${imageUrls.length}">
            Плейлист
          </button>
          <div class="folder-playlist-hint">
            <span class="folder-playlist-interval-label">Интервал:</span>
            <div class="folder-playlist-interval-options">
              ${FOLDER_INTERVAL_OPTIONS.map(val => `
                <button
                  type="button"
                  class="folder-playlist-interval-btn ${playlistIntervalSeconds === val ? 'is-active' : ''}"
                  data-interval="${val}"
                >${val}</button>
              `).join('')}
              <span class="folder-playlist-interval-label">сек.</span>
            </div>
          </div>
        </div>`
          : ''
      }
    </div>
  `;

  filePreview.querySelectorAll('.thumbnail-preview').forEach((thumb, idx) => {
    thumb.addEventListener('click', () => {
      const page = idx + 1;
      stopFolderPlaylistIfNeeded('manual thumbnail click', { deviceId, file: safeName });
      
      // Отправляем громкость перед запуском контента
      sendVolumeBeforePlay(deviceId);
      
      socket.emit('control/play', {
        device_id: deviceId,
        file: safeName,
        page,
      });
    });
  });

  const playlistBtn = document.getElementById('folderPlaylistBtn');
  if (playlistBtn) {
    playlistBtn.addEventListener('click', () => {
      const btnDevice = playlistBtn.getAttribute('data-device');
      const btnFile = playlistBtn.getAttribute('data-file');
      const count = Number(playlistBtn.getAttribute('data-count')) || imageUrls.length;
      toggleFolderPlaylist(btnDevice, btnFile, count);
      // updateFolderPlaylistButtonState вызывается внутри toggleFolderPlaylist
    });
    // Обновляем состояние кнопки после рендера
    setTimeout(() => updateFolderPlaylistButtonState(), 0);
  }
  const intervalButtons = document.querySelectorAll('.folder-playlist-interval-btn');
  if (intervalButtons.length) {
    intervalButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextValue = Number(btn.getAttribute('data-interval'));
        if (!Number.isFinite(nextValue)) return;
        folderPlaylistIntervalSeconds = nextValue;
        updateFolderPlaylistIntervalButtons(nextValue);
        if (folderPlaylistState) {
          folderPlaylistState.intervalSeconds = nextValue;
          // Отправляем обновление интервала на сервер для синхронизации
          socket.emit('control/playlistStart', {
            device_id: folderPlaylistState.deviceId,
            file: folderPlaylistState.file,
            intervalSeconds: nextValue
          });
        }
      });
    });
    updateFolderPlaylistIntervalButtons();
  }
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
  
  // Проверяем состояние плейлиста на сервере при открытии папки
  if (contentType === 'folder') {
    // Обновляем состояние кнопки плейлиста
    updateFolderPlaylistButtonState();
  }
  updatePreviewControlButtons();
}

async function syncPreviewWithPlayerState() {
  if (!currentDevice || previewManuallyClosed) return;
  const state = playerStateByDevice.get(currentDevice);
  if (!state || !state.file || !isStaticContent(state.type)) {
    showLivePreviewForTV(currentDevice, true);
    return;
  }

  // Если пользователь явно выбрал другой файл для превью, не переключать автоматически
  if (currentFile && currentFile !== state.file) {
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
  
  // Загружаем данные параллельно для ускорения
  [nodeNames] = await Promise.all([
    loadNodeNames(),
    loadDevices()
  ]);
  
  // Синхронизируем состояние плейлиста с сервера после загрузки устройств
  devices.forEach(device => {
    if (device.current && device.current.type === 'folder' && device.current.playlistActive) {
      const playlistFile = device.current.playlistFile || device.current.file;
      const playlistInterval = device.current.playlistInterval || 10;
      updateFolderPlaylistButtonStateForDevice(device.device_id, playlistFile, true, playlistInterval);
    }
  });
  
  attachTouchGestures();
  updatePreviewControlButtons(); // Инициализация видимости кнопок

  // Автовыбор из URL, если есть - откладываем на следующий тик для неблокирующей загрузки
  setTimeout(async () => {
    const url = new URL(location.href);
    const qid = url.searchParams.get('device_id');
    if (qid && devices.find(d => d.device_id === qid)) {
      await selectDevice(qid);
    } else if (devices[0]) {
      await selectDevice(devices[0].device_id);
    }
    
    // Восстанавливаем плейлист после загрузки устройств
    await restoreFolderPlaylist();
  }, 0);
});

/* Загрузка списка устройств */
// Обновление количества устройств в заголовке
function updateDevicesCount() {
  const devicesMeta = document.getElementById('devicesMeta');
  if (devicesMeta) {
    const count = devices.length;
    devicesMeta.textContent = count > 0 ? `${count}` : '0';
  }
}

async function loadDevices() {
  try {
    const res = await speakerFetch('/api/devices');
    if (!res.ok) {
      console.error('Не удалось загрузить устройства:', res.status);
      return;
    }
    const newDevices = await res.json();
    
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
    const pageSize = getPageSize(); // Динамическое значение на основе высоты экрана
    const totalPages = Math.max(1, Math.ceil(devices.length / pageSize));
    if (tvPage >= totalPages) tvPage = totalPages - 1;
    updateDevicesCount();
    renderTVList();
  } catch (error) {
    console.error('Не удалось загрузить устройства:', error);
  }
}

/* Рендер списка ТВ (информативный, с подсветкой выбранного) */
function renderTVList() {
  // Сортируем устройства перед отображением (на случай если список обновился)
  const sortedDevices = sortDevices(devices);
  const pageSize = getPageSize(); // Динамическое значение на основе высоты экрана
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
    const volumeState = getVolumeState(d.device_id);
    const volumeInfo = resolveVolumeIndicator(volumeState, isReady);
    const volumeIcon = getVolumeIconSvg({ ...volumeInfo, size: 18 });
    const ariaLabel = `Громкость ${volumeInfo.levelText}, ${volumeInfo.statusText}`;
    const volumeRow = `
        <div class="tvTile-volume${!isReady ? ' is-offline' : ''}" aria-label="${escapeAttr(ariaLabel)}">
          ${volumeIcon}
          <span class="volume-level">${volumeInfo.levelText}</span>
        </div>
      `;
    const metaRow = `
        <div class="tvTile-metaRow">
          <span class="meta tvTile-meta">ID: ${d.device_id}</span>
          <span class="meta tvTile-files">Файлов: ${filesCount}</span>
        </div>
      `;
    return `
      <li class="tvTile${isActive ? ' active' : ''}" data-id="${d.device_id}">
        <div class="tvTile-content">
          <div class="tvTile-header">
            <div class="title tvTile-name">${name}</div>
            <span class="tvTile-status ${isReady ? 'online' : 'offline'}" 
                  title="${isReady ? 'Готов' : 'Не готов'}" 
                  aria-label="${isReady ? 'online' : 'offline'}"></span>
          </div>
          ${metaRow}
          ${volumeRow}
        </div>
      </li>
    `;
  }).join('');

  tvList.querySelectorAll('.tvTile').forEach(item => {
    item.onclick = async () => { await selectDevice(item.dataset.id); };
  });

  // Рендер пейджера под списком (теперь находится в HTML)
  const pager = document.getElementById('tvPager');
  
  // Показываем пагинацию только если больше 1 страницы
  if (pager) {
    if (totalPages > 1) {
      pager.innerHTML = `
        <button class="secondary" id="tvPrev" ${tvPage<=0?'disabled':''} style="min-width:80px">Назад</button>
        <span style="white-space:nowrap">${tvPage+1} из ${totalPages}</span>
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
    resetPreviewHighlightState();
    currentPreviewContext = { deviceId, file: null, page: null };
    filePreview.innerHTML = `<iframe src="/player-videojs.html?device_id=${encodeURIComponent(deviceId)}&preview=1&muted=1" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen"></iframe>`;
    updatePreviewControlButtons();
    return;
  }
  
  // Не переключаем превью если показана сетка миниатюр (только при НЕ принудительном вызове)
  const hasThumbnails = filePreview.querySelector('.thumbnail-preview');
  if (hasThumbnails) {
    return;
  }
  
  // Показываем превью с живым состоянием устройства (всегда без звука)
  const device = devices.find(d => d.device_id === deviceId);
  if (!device) {
    resetPreviewHighlightState();
    filePreview.innerHTML = `<iframe src="/player-videojs.html?device_id=${encodeURIComponent(deviceId)}&preview=1&muted=1" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen"></iframe>`;
    updatePreviewControlButtons();
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
  const previousDevice = currentDevice;
  currentDevice = id;
  if (previousDevice && previousDevice !== id) {
    clearVolumeFallback(previousDevice);
  }
  
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
  updateVolumeUI();
  await ensureVolumeState(currentDevice);
  
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
      console.error('Не удалось загрузить файлы:', res.status);
      fileList.innerHTML = '<li class="item" style="text-align:center; padding:var(--space-xl)"><div class="meta">Ошибка загрузки файлов</div></li>';
      if (meta) meta.textContent = '0 файлов';
      return;
    }
    const filesData = await res.json();

    // Поддержка старого формата (массив строк) и нового формата (массив объектов)
    // ВАЖНО: Фильтруем заглушки - спикеру они не нужны в списке файлов
    allFiles = filesData
      .filter(item => !(typeof item === 'object' && item.isPlaceholder))
      .map(item => {
        if (typeof item === 'string') {
          return { safeName: item, originalName: item, resolution: null, durationSeconds: null, folderImageCount: null };
        }
        return { 
          safeName: item.name || item.safeName || item.originalName, 
          originalName: item.originalName || item.name || item.safeName,
          resolution: item.resolution || null,
          durationSeconds: typeof item.durationSeconds === 'number' ? item.durationSeconds : null,
          folderImageCount: typeof item.folderImageCount === 'number' ? item.folderImageCount : null
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

  // Пагинация файлов (используем меньшую высоту для файлов)
  const pageSize = getPageSize('file'); // Динамическое значение на основе высоты экрана (60px для файлов)
  const totalPages = Math.max(1, Math.ceil(allFiles.length / pageSize));
  if (filePage >= totalPages) filePage = totalPages - 1;
  const start = filePage * pageSize;
  const end = Math.min(start + pageSize, allFiles.length);
  const files = allFiles.slice(start, end);

  fileList.innerHTML = files.map(({ safeName, originalName, resolution, durationSeconds, folderImageCount }) => {
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
    
    const metaBadges = [];
    if (type === 'FOLDER' && typeof folderImageCount === 'number') {
      metaBadges.push(`${folderImageCount} фото`);
    }
    if (type === 'VID' && typeof durationSeconds === 'number' && durationSeconds > 0) {
      const mins = Math.floor(durationSeconds / 60);
      const secs = Math.floor(durationSeconds % 60);
      metaBadges.push(`${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`);
    }
    const typeBadgeLabel = metaBadges.length ? `${typeLabel} · ${metaBadges.join(' · ')}` : typeLabel;
    
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
            ">${typeBadgeLabel}</span>
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

  // Рендер пейджера файлов (теперь находится в HTML)
  const filePager = document.getElementById('filePager');
  
  if (filePager) {
    if (totalPages > 1) {
      filePager.innerHTML = `
        <button class="secondary" id="filePrev" ${filePage<=0?'disabled':''} style="min-width:80px">Назад</button>
        <span style="white-space:nowrap">${filePage+1} из ${totalPages}</span>
        <button class="secondary" id="fileNext" ${filePage>=totalPages-1?'disabled':''} style="min-width:80px">Вперёд</button>
      `;
      const prev = document.getElementById('filePrev');
      const next = document.getElementById('fileNext');
      if (prev) prev.onclick = () => { if (filePage>0) { filePage--; loadFiles(); } };
      if (next) next.onclick = () => { if (filePage<totalPages-1) { filePage++; loadFiles(); } };
    } else {
      filePager.innerHTML = '';
    }
  }

  // Клик по карточке файла (кроме кнопки) - показать превью
  fileList.querySelectorAll('.file-item').forEach(item => {
    item.onclick = (e) => {
      // Если кликнули по кнопке "Воспроизвести" - не обрабатываем (у кнопки свой обработчик)
      if (e.target.closest('.playBtn')) return;
      
      const safeName = decodeURIComponent(item.getAttribute('data-safe'));
      const originalName = decodeURIComponent(item.getAttribute('data-original'));
      
      setCurrentFileSelection(safeName, item);
      previewManuallyClosed = false;
      
      // Определяем тип файла
      const hasExtension = safeName.includes('.');
      const ext = hasExtension ? safeName.split('.').pop().toLowerCase() : '';
      
      // Для папок, PDF и PPTX показываем сетку миниатюр - откладываем тяжелую операцию
      if (!hasExtension || ext === 'pdf' || ext === 'pptx') {
        // Используем requestIdleCallback для неблокирующей загрузки, fallback на setTimeout
        const loadPreview = async () => {
          await showStaticPreview(currentDevice, safeName, !hasExtension ? 'folder' : ext, { initiatedByUser: true });
        };
        
        if ('requestIdleCallback' in window) {
          requestIdleCallback(loadPreview, { timeout: 100 });
        } else {
          setTimeout(loadPreview, 0);
        }
      } else {
        // Для видео и обычных изображений показываем в iframe - быстрая операция
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
        // Скрываем кнопки при показе фото/видео (вызываем после небольшой задержки, чтобы DOM обновился)
        setTimeout(() => updatePreviewControlButtons(), 10);
      }
    };
  });

  fileList.querySelectorAll('.playBtn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation(); // Останавливаем всплытие, чтобы не вызвался клик по карточке
      
      const safeName = decodeURIComponent(btn.getAttribute('data-safe'));
      const originalName = decodeURIComponent(btn.getAttribute('data-original'));
      setCurrentFileSelection(safeName, btn.closest('.file-item'));
      
      // Сбрасываем флаг закрытия при новом воспроизведении
      previewManuallyClosed = false;
      stopFolderPlaylistIfNeeded('manual play button', { deviceId: currentDevice, file: safeName });
      
      // Отправляем громкость перед запуском контента
      sendVolumeBeforePlay(currentDevice);
      
      socket.emit('control/play', { device_id: currentDevice, file: safeName });
      
      // Определяем тип файла
      const hasExtension = safeName.includes('.');
      const ext = hasExtension ? safeName.split('.').pop().toLowerCase() : '';
      const isStaticContent = !hasExtension || ext === 'pdf' || ext === 'pptx';
      
      // Для PDF/PPTX/FOLDER - открываем превью автоматически (откладываем тяжелую операцию)
      if (isStaticContent) {
        const loadPreview = async () => {
          await showStaticPreview(currentDevice, safeName, !hasExtension ? 'folder' : ext, { initiatedByUser: true });
        };
        
        if ('requestIdleCallback' in window) {
          requestIdleCallback(loadPreview, { timeout: 100 });
        } else {
          setTimeout(loadPreview, 0);
        }
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
          updatePreviewControlButtons();
        }, 300);
      }
    };
  });
  
  } catch (error) {
    console.error('Не удалось отобразить файлы:', error);
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
  if (!infoEl || !currentDevice) {
    if (infoEl) infoEl.innerHTML = '';
    updatePreviewControlButtons();
    return;
  }

  const device = devices.find(d => d.device_id === currentDevice);
  if (!device || !device.current) {
    infoEl.innerHTML = '';
    updatePreviewControlButtons();
    return;
  }

  // Показываем информацию о плейлисте папки
  if (device.current.type === 'folder' && device.current.playlistActive === true) {
    const playlistFile = device.current.playlistFile || device.current.file;
    const currentPage = Number(device.current.page) || 1;
    
    // Находим папку в списке файлов для получения количества изображений
    let folderImageCount = 0;
    let displayName = (playlistFile || '').replace(/\.[^.]+$/, '');
    
    if (playlistFile && allFiles && allFiles.length > 0) {
      const fileInfo = allFiles.find(f => 
        f.safeName === playlistFile || 
        f.originalName === playlistFile ||
        f.safeName === playlistFile.replace(/\.[^.]+$/, '') ||
        f.originalName === playlistFile.replace(/\.[^.]+$/, '')
      );
      if (fileInfo) {
        if (fileInfo.originalName) {
          displayName = fileInfo.originalName.replace(/\.[^.]+$/, '');
        }
        if (typeof fileInfo.folderImageCount === 'number' && fileInfo.folderImageCount > 0) {
          folderImageCount = fileInfo.folderImageCount;
        }
      }
    }
    
    // Если не нашли количество изображений в allFiles, пробуем получить из device
    if (folderImageCount === 0 && device.current.folderImageCount) {
      folderImageCount = Number(device.current.folderImageCount) || 0;
    }
    
    const safeName = escapeHtml(truncateText(displayName, 50)) || '—';
    const pageInfo = folderImageCount > 0 ? `Кадр ${currentPage} из ${folderImageCount}` : `Кадр ${currentPage}`;
    
    infoEl.innerHTML = `
      <div class="meta-line">
        <span class="meta-title">${safeName}</span>
        <span class="meta-value">${pageInfo} | Плейлист</span>
      </div>
    `;
    updatePreviewControlButtons();
    return;
  }

  // Показываем таймер ТОЛЬКО когда реально играет видео
  if (device.current.type !== 'video') {
    infoEl.innerHTML = '';
    updatePreviewControlButtons();
    return;
  }

  const prog = playbackProgressByDevice.get(currentDevice);
  if (!prog || !prog.file) {
    infoEl.innerHTML = '';
    updatePreviewControlButtons();
    return;
  }
  
  // Проверяем, что файл в прогрессе совпадает с текущим файлом устройства
  if (prog.file !== device.current.file) {
    infoEl.innerHTML = '';
    updatePreviewControlButtons();
    return;
  }
  
  // Проверяем, не закончилось ли видео (с небольшой погрешностью)
  if (prog.duration > 0 && prog.currentTime >= prog.duration - 0.5) {
    infoEl.innerHTML = '';
    updatePreviewControlButtons();
    return;
  }
  
  // Проверяем, не является ли файл заглушкой
  if (prog.file && allFiles && allFiles.length > 0) {
    const fileInfo = allFiles.find(f => 
      f.safeName === prog.file || 
      f.originalName === prog.file ||
      f.safeName === prog.file.replace(/\.[^.]+$/, '') ||
      f.originalName === prog.file.replace(/\.[^.]+$/, '')
    );
    if (fileInfo && fileInfo.isPlaceholder) {
      infoEl.innerHTML = '';
      updatePreviewControlButtons();
      return;
    }
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
  
  const safeName = escapeHtml(truncateText(displayName, 50)) || '—';
  const currentTimeLabel = formatTime(prog.currentTime);
  const total = (prog.duration && prog.duration > 0) ? formatTime(prog.duration) : '--:--';
  
  infoEl.innerHTML = `
    <div class="meta-line">
      <span class="meta-title">${safeName}</span>
      <span class="meta-value">${currentTimeLabel} / ${total}</span>
    </div>
  `;
  updatePreviewControlButtons();
}

// Прием прогресса от плееров
socket.on('player/progress', ({ device_id, type, file, currentTime, duration }) => {
  if (!device_id) return;
  
  if (type !== 'video' || !file) {
    playbackProgressByDevice.delete(device_id);
    if (device_id === currentDevice) {
      updatePlaybackInfoUI();
    }
    return;
  }
  
  playbackProgressByDevice.set(device_id, { file, currentTime: Number(currentTime)||0, duration: Number(duration)||0 });
  if (device_id === currentDevice) {
    updatePlaybackInfoUI();
  }
});

/* Верхняя панель управления */
document.getElementById('playBtn').onclick = () => {
  if (!currentDevice) return;
  
  const device = devices.find(d => d.device_id === currentDevice);
  
  // Отправляем громкость перед запуском контента
  sendVolumeBeforePlay(currentDevice);
  
  // Если устройство на паузе - продолжаем воспроизведение (resume)
  if (device && device.current && device.current.state === 'paused') {
    socket.emit('control/play', { device_id: currentDevice }); // Сервер отправит player/resume
    // Обновляем локальное состояние
    device.current.state = 'playing';
  } 
  // Если выбран файл из списка - воспроизводим его
  else if (currentFile) {
    stopFolderPlaylistIfNeeded('toolbar play', { deviceId: currentDevice, file: currentFile });
    socket.emit('control/play', { device_id: currentDevice, file: currentFile });
  }
  // Иначе пробуем resume (если было что-то до перезапуска сервера)
  else {
    socket.emit('control/play', { device_id: currentDevice });
  }
};

document.getElementById('pauseBtn').onclick = () => {
  if (!currentDevice) return;
  
  const device = devices.find(d => d.device_id === currentDevice);
  
  // Обновляем локальное состояние устройства на "пауза"
  if (device && device.current) {
    device.current.state = 'paused';
  }
  
  socket.emit('control/pause', { device_id: currentDevice });
};
document.getElementById('restartBtn').onclick = () => {
  if (!currentDevice) return;
  socket.emit('control/restart', { device_id: currentDevice });
};
document.getElementById('stopBtn').onclick = () => {
  if (!currentDevice) return;
  stopFolderPlaylist('toolbar stop');
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
  
  // Останавливаем плейлист ТОЛЬКО для текущего устройства (локально и на сервере)
  const device = devices.find(d => d.device_id === currentDevice);
  const hasActivePlaylist = device && device.current && 
    device.current.type === 'folder' && 
    device.current.playlistActive === true;
  
  if (hasActivePlaylist) {
    // Проверяем, что плейлист активен именно для текущего устройства
    const playlistFile = device.current.playlistFile || device.current.file;
    if (isFolderPlaylistActiveFor(currentDevice, playlistFile)) {
      // Если плейлист активен локально для текущего устройства - останавливаем локально
      stopFolderPlaylist('preview closed');
    } else {
      // Если плейлист активен только на сервере для текущего устройства - отправляем команду на сервер
      socket.emit('control/playlistStop', { device_id: currentDevice });
    }
  } else {
    // Проверяем, есть ли локальный плейлист для ТЕКУЩЕГО устройства
    // Если плейлист активен для другого устройства - НЕ останавливаем его!
    if (folderPlaylistState && folderPlaylistState.deviceId === currentDevice) {
      stopFolderPlaylist('preview closed');
    }
  }
  
  // Останавливаем воспроизведение
  socket.emit('control/stop', { device_id: currentDevice });
  
  // Сбрасываем выбранный файл
  currentFile = null;
  updatePreviewControlButtons();
  
  // Убираем active класс со всех файлов
  fileList.querySelectorAll('.file-item').forEach(item => {
    item.classList.remove('active');
  });
  
  // Возвращаем preview в исходное состояние (показываем live preview устройства)
  showLivePreviewForTV(currentDevice, true);
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
    // Обновляем информацию о плейлисте после обновления устройств
    updatePlaybackInfoUI();
    updatePreviewControlButtons();
  }
}, 150);

// онлайн/офлайн статусы плееров
socket.on('player/online', ({ device_id }) => {
  readyDevices.add(device_id);
  renderTVList();
  if (device_id === currentDevice) {
    updateVolumeUI();
    ensureVolumeState(device_id);
  }
});
socket.on('player/offline', ({ device_id }) => {
  readyDevices.delete(device_id);
  renderTVList();
  if (device_id === currentDevice) {
    updateVolumeUI();
  }
});

// Initialize online statuses on load/refresh
socket.on('players/onlineSnapshot', (list) => {
  try {
    readyDevices = new Set(Array.isArray(list) ? list : []);
  } catch {
    readyDevices = new Set();
  }
  renderTVList();
  updateVolumeUI();
});

// Синхронизация состояния плейлиста между панелями
socket.on('playlist/state', ({ device_id, active, file, intervalSeconds }) => {
  if (!device_id) return;
  
  // Обновляем состояние устройства в локальном массиве
  const device = devices.find(d => d.device_id === device_id);
  if (device) {
    if (!device.current) {
      device.current = { type: 'folder', file: file || null, state: 'playing', page: 1 };
    }
    if (active) {
      device.current.playlistActive = true;
      device.current.playlistInterval = intervalSeconds || 10;
      device.current.playlistFile = file;
      // Убеждаемся, что file также установлен
      if (!device.current.file || device.current.file !== file) {
        device.current.file = file;
      }
    } else {
      device.current.playlistActive = false;
      device.current.playlistInterval = undefined;
      device.current.playlistFile = undefined;
    }
  }
  
  // Обновляем UI кнопки плейлиста для всех панелей с небольшой задержкой
  // чтобы убедиться, что состояние обновлено
  setTimeout(() => {
    updateFolderPlaylistButtonState();
    updatePreviewControlButtons();
    // Если это текущее устройство - обновляем информацию о плейлисте
    if (device_id === currentDevice) {
      updatePlaybackInfoUI();
    }
  }, 50);
  
  // Если это текущее устройство - обновляем локальное состояние
  if (active) {
    if (device && file) {
      // Если плейлист уже активен локально - синхронизируем интервал
      if (isFolderPlaylistActiveFor(device_id, file)) {
        if (intervalSeconds && intervalSeconds !== folderPlaylistIntervalSeconds) {
          folderPlaylistIntervalSeconds = intervalSeconds;
          if (folderPlaylistState) {
            folderPlaylistState.intervalSeconds = intervalSeconds;
          }
          updateFolderPlaylistIntervalButtons(intervalSeconds);
        }
      } else {
        // Плейлист запущен на другой панели - обновляем интервал в UI
        if (intervalSeconds) {
          folderPlaylistIntervalSeconds = intervalSeconds;
          updateFolderPlaylistIntervalButtons(intervalSeconds);
        }
      }
    }
  } else {
    // Плейлист остановлен - обновляем UI для всех панелей
    if (isFolderPlaylistActiveFor(device_id, file || folderPlaylistState?.file)) {
      // Если это наш локальный плейлист - останавливаем его
      stopFolderPlaylist('stopped from another panel', false);
    }
    // Обновляем UI кнопки плейлиста
    updateFolderPlaylistButtonState();
  }
});

socket.on('devices/updated', onDevicesUpdated);
const onPreviewRefresh = debounce(async ({ device_id }) => {
  // Сохраняем состояние плейлиста перед загрузкой устройств
  const playlistStates = {};
  devices.forEach(d => {
    if (d.current && d.current.playlistActive) {
      playlistStates[d.device_id] = {
        playlistActive: d.current.playlistActive,
        playlistInterval: d.current.playlistInterval,
        playlistFile: d.current.playlistFile
      };
    }
  });
  
  try {
    const res = await speakerFetch('/api/devices');
    if (!res.ok) return;
    const newDevices = sortDevices(await res.json());
    
    // Восстанавливаем состояние плейлиста после загрузки
    newDevices.forEach(d => {
      if (playlistStates[d.device_id]) {
        if (!d.current) {
          d.current = { type: 'folder', file: playlistStates[d.device_id].playlistFile, state: 'playing', page: 1 };
        }
        d.current.playlistActive = playlistStates[d.device_id].playlistActive;
        d.current.playlistInterval = playlistStates[d.device_id].playlistInterval;
        d.current.playlistFile = playlistStates[d.device_id].playlistFile;
      }
    });
    
    devices = newDevices;
    updateDevicesCount();
  } catch (err) {
    console.error('Не удалось обновить устройства:', err);
    return;
  }

  if (!device_id) return;
  const device = devices.find(d => d.device_id === device_id);
  if (!device || !device.current) {
    // Если устройство не воспроизводит ничего, очищаем прогресс
    playbackProgressByDevice.delete(device_id);
    if (device_id === currentDevice) {
      updatePlaybackInfoUI();
    }
    return;
  }

  // Если тип контента изменился или файл изменился, очищаем старый прогресс
  const oldState = playerStateByDevice.get(device_id);
  if (oldState && (oldState.type !== device.current.type || oldState.file !== device.current.file)) {
    playbackProgressByDevice.delete(device_id);
    if (device_id === currentDevice) {
      updatePlaybackInfoUI();
    }
  }

  playerStateByDevice.set(device_id, {
    type: device.current.type,
    file: device.current.file,
    page: Number(device.current.page) || 1,
  });

  // Синхронизация плейлиста с состоянием устройства с сервера
  if (device.current && device.current.type === 'folder' && device.current.playlistActive) {
    // Плейлист активен на сервере - синхронизируем локальное состояние
    const playlistFile = device.current.playlistFile || device.current.file;
    const playlistInterval = device.current.playlistInterval || 10;
    
    if (isFolderPlaylistActiveFor(device_id, playlistFile)) {
      // Локальный плейлист уже активен - синхронизируем интервал
      if (playlistInterval !== folderPlaylistIntervalSeconds) {
        folderPlaylistIntervalSeconds = playlistInterval;
        if (folderPlaylistState) {
          folderPlaylistState.intervalSeconds = playlistInterval;
        }
        updateFolderPlaylistIntervalButtons(playlistInterval);
      }
      // Синхронизируем текущую страницу
      if (device.current.page) {
        folderPlaylistState.currentIndex = Number(device.current.page) || folderPlaylistState.currentIndex;
      }
    }
    // Обновляем UI кнопки плейлиста
    updateFolderPlaylistButtonState();
  } else if (folderPlaylistState && folderPlaylistState.deviceId === device_id) {
    // Локальный плейлист активен - проверяем состояние на сервере
    if (device.current && device.current.type === 'folder') {
      // Если файл совпадает, но плейлист не активен на сервере - возможно, он еще не обновился
      // Не останавливаем плейлист сразу, если файл совпадает
      if (device.current.file === folderPlaylistState.file) {
        // Синхронизируем текущую страницу
        if (device.current.page) {
          folderPlaylistState.currentIndex = Number(device.current.page) || folderPlaylistState.currentIndex;
        }
        // Если плейлист активен на сервере - синхронизируем интервал
        if (device.current.playlistActive) {
          const playlistInterval = device.current.playlistInterval || 10;
          if (playlistInterval !== folderPlaylistIntervalSeconds) {
            folderPlaylistIntervalSeconds = playlistInterval;
            folderPlaylistState.intervalSeconds = playlistInterval;
            updateFolderPlaylistIntervalButtons(playlistInterval);
          }
        }
      } else {
        // Файл изменился - останавливаем плейлист
        stopFolderPlaylist('контент сменился', false);
      }
    } else if (!device.current || device.current.type !== 'idle') {
      // Устройство не воспроизводит папку - останавливаем плейлист только если это не idle
      // (idle может быть временным состоянием)
      if (device.current && device.current.type !== 'folder') {
        stopFolderPlaylist('контент сменился', false);
      }
    }
    // Обновляем UI кнопки плейлиста
    updateFolderPlaylistButtonState();
  } else {
    // Обновляем UI кнопки плейлиста в любом случае
    updateFolderPlaylistButtonState();
  }

  if (device_id === currentDevice) {
    requestPreviewSync();
    // Обновляем информацию о плейлисте после обновления состояния устройства
    updatePlaybackInfoUI();
  }
}, 200);

socket.on('preview/refresh', onPreviewRefresh);

socket.on('devices/volume/stateBatch', (snapshot = {}) => {
  if (!snapshot || typeof snapshot !== 'object') return;
  Object.entries(snapshot).forEach(([deviceId, state]) => {
    storeVolumeState(deviceId, state || {});
  });
});

socket.on('devices/volume/state', (payload = {}) => {
  const deviceId = payload.device_id || payload.deviceId;
  if (!deviceId) return;
  storeVolumeState(deviceId, payload);
});

// Функция для выделения текущей миниатюры
function highlightCurrentThumbnail(pageNumber, context) {
  const normalizedPage = Math.max(1, Number(pageNumber) || 1);
  const previewContext = context || getPreviewContext();
  if (!previewContext.deviceId || !previewContext.file) return;

  currentPreviewContext = { ...previewContext, page: normalizedPage };

  if (isFolderPlaylistActiveFor(previewContext.deviceId, previewContext.file)) {
    folderPlaylistState.currentIndex = normalizedPage;
  }

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
  }
}

// Слушаем события смены страниц для выделения активной миниатюры
['pdfPage', 'pptxPage', 'folderPage'].forEach(eventName => {
  socket.on(`player/${eventName}`, (pageNumber) => {
    // Событие приходит как число (номер страницы), а не объект
    const page = Math.max(1, Number(pageNumber) || 1);
    const state = playerStateByDevice.get(currentDevice) || {};
    if (!state.file) return;
    playerStateByDevice.set(currentDevice, { ...state, page });
    
    // Обновляем device.current.page для плейлиста папки
    const device = devices.find(d => d.device_id === currentDevice);
    if (device && device.current && device.current.type === 'folder' && device.current.playlistActive) {
      device.current.page = page;
      updatePlaybackInfoUI();
    }
    
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

