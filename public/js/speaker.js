import { initThemeToggle } from './theme.js';
import { sortDevices, debounce, loadNodeNames, getPageSize } from './utils.js';
import { ensureAuth, speakerFetch, logout } from './speaker/auth.js';
import { getCrossIcon, getVolumeMutedIcon, getVolumeOnIcon, getVolumeUnknownIcon } from './shared/svg-icons.js';
import { formatTime } from './shared/formatters.js';
import {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  STATIC_CONTENT_TYPES,
  resolveContentType,
  getFileExtension,
  getContentTypeInfo
} from './shared/content-type-helper.js';

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
const filesModeDeviceBtn = document.getElementById('filesModeDevice');
const filesModeAllBtn = document.getElementById('filesModeAll');
const pdfPrevBtn = document.getElementById('pdfPrevBtn');
const pdfNextBtn = document.getElementById('pdfNextBtn');
const pdfCloseBtn = document.getElementById('pdfCloseBtn');
const volumePanel = document.getElementById('volumePanel');
const volumeSlider = document.getElementById('volumeSlider');
const volumeLevelLabel = document.getElementById('volumeLevelLabel');
const volumeMuteStatus = document.getElementById('volumeMuteStatus');
const volumeMuteBtn = document.getElementById('volumeMuteBtn');

const FOLDER_INTERVAL_OPTIONS = [5, 10, 15, 20];
const DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS = 10;
let previewLoadToken = 0;
let fileListMode = 'device'; // device | all
let currentFileSourceDevice = null;
const ALL_FILES_LIMIT = 500;

async function reportSpeakerNotification(payload = {}) {
  try {
    await speakerFetch('/api/notifications/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: payload.type || 'speaker_ui_event',
        severity: payload.severity || 'warning',
        title: payload.title || 'Событие speaker панели',
        message: payload.message || '',
        details: payload.details || {},
        key: payload.key || null,
        source: 'speaker-ui'
      })
    });
  } catch (error) {
    console.error('[Speaker] Failed to report notification:', error);
  }
}

function getDeviceDisplayName(deviceId) {
  if (!deviceId) return '';
  const fromNodes = nodeNames?.[deviceId];
  if (fromNodes) return fromNodes;
  const found = devices?.find?.(d => d.device_id === deviceId);
  if (found) return found.name || deviceId;
  return deviceId;
}

// Fallback helper для построения URL стримов/файлов, если нет proxyUrl в данных
function getStreamPlaybackUrl(deviceId, safeName) {
  if (!deviceId || !safeName) return '';
  return `/api/files/resolve/${encodeURIComponent(deviceId)}/${encodeURIComponent(safeName)}`;
}

function renderFilesModeSwitch(activeMode = fileListMode) {
  const isMultiSelection = getSelectedDeviceIds().length > 1;
  const effectiveMode = isMultiSelection ? 'all' : activeMode;

  if (filesModeDeviceBtn) {
    filesModeDeviceBtn.style.display = isMultiSelection ? 'none' : '';
  }
  if (filesModeAllBtn) {
    filesModeAllBtn.style.display = '';
  }

  const activate = (btn, active) => {
    if (!btn) return;
    btn.style.background = active ? 'var(--panel)' : 'var(--panel-2)';
    btn.style.color = active ? 'var(--text)' : 'var(--muted)';
    btn.style.borderBottomColor = active ? 'transparent' : 'var(--border)';
    btn.style.boxShadow = active ? '0 -1px 0 var(--panel)' : 'none';
  };

  activate(filesModeDeviceBtn, effectiveMode === 'device');
  activate(filesModeAllBtn, effectiveMode === 'all');
}

function syncFilesModeWithSelection({ skipLoad = false } = {}) {
  const desiredMode = getSelectedDeviceIds().length > 1 ? 'all' : 'device';
  if (fileListMode !== desiredMode) {
    setFilesMode(desiredMode, { skipLoad });
    return;
  }
  renderFilesModeSwitch(fileListMode);
}

function setFilesMode(mode = 'device', { skipLoad = false } = {}) {
  if (mode !== 'device' && mode !== 'all') return;

  if (getSelectedDeviceIds().length > 1) {
    mode = 'all';
  }

  fileListMode = mode;
  filePage = 0;
  currentFile = null;
  currentFileSourceDevice = null;
  renderFilesModeSwitch(mode);
  // Сбрасываем превью при переключении режима
  if (filePreview) {
    filePreview.innerHTML = '<div class="meta" style="padding:12px; color:var(--muted);">Выберите файл</div>';
  }
  
  // КРИТИЧНО: При переключении режима обновляем кэш для текущего устройства
  // Это гарантирует, что resolveFileDisplayData найдет правильные originalName
  if (currentDevice) {
    const device = devices.find(d => d.device_id === currentDevice);
    if (device) {
      prefillDeviceFileMeta(device);
      // Обновляем превью TV для текущего устройства, чтобы отобразилось правильное имя
      refreshTvTilePlaybackInfo(currentDevice);
    }
  }
  
  if (!skipLoad) {
    loadFiles();
  }
}

if (filesModeDeviceBtn) {
  filesModeDeviceBtn.addEventListener('click', () => setFilesMode('device'));
}
if (filesModeAllBtn) {
  filesModeAllBtn.addEventListener('click', () => setFilesMode('all'));
}

// КРИТИЧНО: Отслеживание активных превью стримов (теперь по safeName, без deviceId)
const activePreviewStreams = new Map(); // safeName -> {timestamp, iframe, isPlaying}
// formatDuration удалена - используем унифицированную функцию formatTime

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
  const targetDeviceIds = getPanelControlTargetDeviceIds();
  if (!targetDeviceIds.length) return;

  targetDeviceIds.forEach((deviceId) => {
    const payload = {
      device_id: deviceId,
      ...command
    };
    const hasLevelChange = typeof payload.level === 'number' && !Number.isNaN(payload.level);
    const hasDeltaChange = typeof payload.delta === 'number' && !Number.isNaN(payload.delta);
    if (typeof payload.muted === 'undefined' && (hasLevelChange || hasDeltaChange)) {
      payload.muted = false;
    }
    socket.emit('control/volume', payload);
  });
}

/**
 * Отправляет текущее состояние громкости перед запуском контента
 * Это гарантирует, что громкость будет применена даже если синхронизация при регистрации не сработала
 */
/**
 * Проверяет что устройство онлайн
 * @param {string} deviceId - ID устройства
 * @returns {boolean} true если устройство онлайн
 */
function isDeviceReady(deviceId) {
  return deviceId && readyDevices.has(deviceId);
}

/**
 * Требует что устройство онлайн, иначе блокирует действие
 * @param {string} deviceId - ID устройства
 * @param {boolean} allowWithPlayerInfo - если true, разрешает действие при наличии информации о воспроизведении
 * @returns {boolean} true если устройство онлайн и действие разрешено
 */
function requireDeviceReady(deviceId, allowWithPlayerInfo = false) {
  if (!isDeviceReady(deviceId)) {
    // Если разрешено действие при наличии информации о воспроизведении, проверяем наличие информации
    if (allowWithPlayerInfo) {
      const hasInfo = hasPlayerInfo();
      if (hasInfo) {
        console.log('[Speaker] Устройство офлайн, но есть информация о воспроизведении - действие разрешено', { deviceId });
        return true;
      } else {
        console.log('[Speaker] Устройство офлайн и нет информации о воспроизведении', { deviceId });
      }
    }
    console.warn('[Speaker] Устройство офлайн, действие заблокировано', { deviceId, allowWithPlayerInfo });
    return false;
  }
  return true;
}

function sendVolumeBeforePlay(deviceId) {
  if (!deviceId) return;
  // КРИТИЧНО: Проверяем что устройство онлайн перед отправкой команды
  if (!requireDeviceReady(deviceId)) return;
  
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

/**
 * Проверяет наличие информации в элементах с классом meta-value-player или meta-value
 * @returns {boolean} true если есть информация
 */
function hasPlayerInfo() {
  // Ищем элемент в previewPlaybackInfo
  const infoEl = document.getElementById('previewPlaybackInfo');
  if (infoEl) {
    // Проверяем meta-value-player (информация от плеера)
    const metaValuePlayer = infoEl.querySelector('.meta-value-player');
    if (metaValuePlayer) {
      const text = metaValuePlayer.textContent?.trim() || '';
      if (text.length > 0) return true;
    }
    // Также проверяем любой meta-value с информацией (например, "Кадр 4 из 10 | Плейлист")
    const metaValue = infoEl.querySelector('.meta-value');
    if (metaValue) {
      const text = metaValue.textContent?.trim() || '';
      // Проверяем, что это не просто пустая строка или дефолтные значения
      if (text.length > 0 && text !== '--:--' && !text.match(/^\s*$/)) {
        return true;
      }
    }
  }
  // Также проверяем глобально на случай, если элемент находится в другом месте
  const metaValuePlayer = document.querySelector('.meta-value-player');
  if (metaValuePlayer) {
    const text = metaValuePlayer.textContent?.trim() || '';
    if (text.length > 0) return true;
  }
  return false;
}

/**
 * Блокирует/разблокирует все элементы управления (кнопки, миниатюры, прогресс-бар)
 * @param {boolean} disabled - true для блокировки, false для разблокировки
 * @param {boolean} allowStopAndClose - если true, разрешает кнопки стоп и закрыть даже при disabled
 */
function setControlButtonsDisabled(disabled, allowStopAndClose = false) {
  // Кнопки навигации PDF/PPTX/папок
  if (pdfPrevBtn) pdfPrevBtn.disabled = disabled;
  if (pdfNextBtn) pdfNextBtn.disabled = disabled;
  // Кнопка закрыть может быть активна, если есть информация о воспроизведении
  if (pdfCloseBtn) pdfCloseBtn.disabled = allowStopAndClose ? false : disabled;
  
  // Кнопки управления воспроизведением
  const playBtn = document.getElementById('playBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const restartBtn = document.getElementById('restartBtn');
  const stopBtn = document.getElementById('stopBtn');
  const videoProgressBar = document.getElementById('videoProgressBar');
  
  if (playBtn) playBtn.disabled = disabled;
  if (pauseBtn) pauseBtn.disabled = disabled;
  if (restartBtn) restartBtn.disabled = disabled;
  // Кнопка стоп может быть активна, если есть информация о воспроизведении
  if (stopBtn) stopBtn.disabled = allowStopAndClose ? false : disabled;
  if (videoProgressBar) videoProgressBar.disabled = disabled;
  
  // Кнопка плейлиста
  const folderPlaylistBtn = document.getElementById('folderPlaylistBtn');
  if (folderPlaylistBtn) folderPlaylistBtn.disabled = disabled;
  
  // КРИТИЧНО: Блокируем клики по миниатюрам через CSS
  const thumbnails = filePreview ? filePreview.querySelectorAll('.thumbnail-preview') : [];
  thumbnails.forEach(thumb => {
    if (disabled) {
      thumb.classList.add('is-disabled');
      thumb.style.pointerEvents = 'none';
      thumb.style.opacity = '0.5';
      thumb.style.cursor = 'not-allowed';
    } else {
      thumb.classList.remove('is-disabled');
      thumb.style.pointerEvents = '';
      thumb.style.opacity = '';
      thumb.style.cursor = '';
    }
  });
  
  // Блокируем кнопки интервала плейлиста
  const intervalButtons = document.querySelectorAll('.folder-playlist-interval-btn');
  intervalButtons.forEach(btn => {
    btn.disabled = disabled;
  });
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
  
  // КРИТИЧНО: Блокируем все кнопки управления при офлайне
  // Но разрешаем кнопки стоп и закрыть, если есть информация о воспроизведении
  const controlsDisabled = !currentDevice || !isReady;
  const allowStopAndClose = controlsDisabled && hasPlayerInfo();
  setControlButtonsDisabled(controlsDisabled, allowStopAndClose);
  
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
    #filePreview .thumbnail-preview.is-disabled {
      opacity: 0.5;
      cursor: not-allowed;
      pointer-events: none;
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
let allFilesCache = []; // Кэш файлов из режима "Все файлы" (сохраняется при переключении режимов для поиска originalName)
// Прогресс воспроизведения по устройству
// device_id -> { file, currentTime, duration, durationKnownFromStart }
// durationKnownFromStart: true если duration был известен с самого начала (для работы перемотки)
const playbackProgressByDevice = new Map();
const playerStateByDevice = new Map(); // device_id -> { type, file, page }
const fileMetaCache = new Map(); // device_id -> Map(fileName|safeKey -> { displayName, folderImageCount })
const staticMetaRequests = new Map(); // `${deviceId}:${file}` -> Promise
let currentPreviewContext = { deviceId: null, file: null, page: null };
let folderPlaylistState = null;
let folderPlaylistIntervalSeconds = DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS;
const volumeStateByDevice = new Map();
const VOLUME_STEP = 5;
const selectedDeviceIds = new Set();
let touchMultiSelectMode = false;
const TV_TILE_LONG_PRESS_MS = 450;

function isDesktopMultiSelectEvent(event) {
  return Boolean(event && (event.ctrlKey || event.metaKey));
}

function getSelectedDeviceIds() {
  const selected = Array.from(selectedDeviceIds);
  if (selected.length) return selected;
  return currentDevice ? [currentDevice] : [];
}

function setSingleDeviceSelection(deviceId) {
  selectedDeviceIds.clear();
  if (deviceId) {
    selectedDeviceIds.add(deviceId);
  }
  touchMultiSelectMode = false;
}

function toggleDeviceSelection(deviceId) {
  if (!deviceId) return;
  if (selectedDeviceIds.has(deviceId)) {
    selectedDeviceIds.delete(deviceId);
  } else {
    selectedDeviceIds.add(deviceId);
  }
  if (!selectedDeviceIds.size) {
    touchMultiSelectMode = false;
  }
}

function pruneSelectedDevices() {
  const knownDeviceIds = new Set(devices.map((device) => device.device_id));
  Array.from(selectedDeviceIds).forEach((deviceId) => {
    if (!knownDeviceIds.has(deviceId)) {
      selectedDeviceIds.delete(deviceId);
    }
  });

  if (currentDevice && !knownDeviceIds.has(currentDevice)) {
    currentDevice = null;
  }

  if (!currentDevice && selectedDeviceIds.size) {
    const [firstSelectedDevice] = Array.from(selectedDeviceIds);
    currentDevice = firstSelectedDevice || null;
  }

  if (!selectedDeviceIds.size && currentDevice) {
    selectedDeviceIds.add(currentDevice);
  }
}

function refreshTvSelectionClasses() {
  if (!tvList) return;
  tvList.querySelectorAll('.tvTile').forEach((tile) => {
    const tileId = tile.dataset.id;
    tile.classList.toggle('active', tileId === currentDevice);
    tile.classList.toggle('selected', selectedDeviceIds.has(tileId));
  });
}

function formatFilesMetaWithSelection(baseText = '') {
  const selectedCount = getSelectedDeviceIds().length;
  const cleanBase = (baseText || '').replace(/\s*·\s*выбрано устройств:\s*\d+/i, '').trim();
  if (!selectedCount) {
    return cleanBase;
  }
  return cleanBase ? `${cleanBase} · выбрано устройств: ${selectedCount}` : `Выбрано устройств: ${selectedCount}`;
}

function getPanelControlTargetDeviceIds({ allowWithPlayerInfo = false } = {}) {
  const selectedTargets = getSelectedDeviceIds();
  if (!selectedTargets.length) return [];
  return selectedTargets.filter((deviceId) => requireDeviceReady(deviceId, allowWithPlayerInfo));
}

function emitControlToSelected(eventName, payloadFactory, options = {}) {
  const targetDeviceIds = getPanelControlTargetDeviceIds(options);
  if (!targetDeviceIds.length) return [];

  targetDeviceIds.forEach((deviceId) => {
    const payload = typeof payloadFactory === 'function'
      ? payloadFactory(deviceId)
      : { ...payloadFactory };
    socket.emit(eventName, { device_id: deviceId, ...(payload || {}) });
  });

  return targetDeviceIds;
}

// --- Android Launch Button Logic ---
const launchAndroidBtn = document.getElementById('launchAndroidBtn');
let speakerInitialChecked = false; // После загрузки страницы через 2с разрешаем показывать кнопку

function updateLaunchAndroidBtn() {
  if (!launchAndroidBtn) return;
  // Пока не прошла первичная задержка после загрузки — не показываем кнопку
  if (!speakerInitialChecked) return;

  let show = false;
  let disabled = true;
  let device = null;
  if (currentDevice && devices && Array.isArray(devices)) {
    device = devices.find(d => d.device_id === currentDevice);
    if (device && device.platform && device.platform.toLowerCase().includes('android')) {
      // offline = не в readyDevices
      if (!readyDevices.has(currentDevice)) {
        show = true;
        disabled = false;
      }
    }
  }
  launchAndroidBtn.style.display = show ? '' : 'none';
  launchAndroidBtn.disabled = disabled;
  launchAndroidBtn.title = disabled ? 'Доступно только для оффлайн Android-устройств' : 'Запустить Android-приложение';
}

if (launchAndroidBtn) {
  launchAndroidBtn.addEventListener('click', async () => {
    if (launchAndroidBtn.disabled) return;
    launchAndroidBtn.disabled = true;
    launchAndroidBtn.title = 'Запуск...';
    let device = devices.find(d => d.device_id === currentDevice);
    try {
      const resp = await speakerFetch(`/api/devices/${encodeURIComponent(currentDevice)}/launch-app`, { method: 'POST' });
      const result = await resp.json();
      if (result.ok) {
        // Успех: сразу скрываем кнопку
        launchAndroidBtn.style.display = 'none';
        return;
      } else {
        await reportSpeakerNotification({
          type: 'speaker_launch_app_error',
          title: 'Ошибка запуска Android-приложения',
          message: result.error || 'Неизвестная ошибка',
          details: {
            deviceId: currentDevice
          }
        });
      }
    } catch (e) {
      await reportSpeakerNotification({
        type: 'speaker_launch_app_network_error',
        title: 'Ошибка соединения',
        message: 'Не удалось отправить команду на сервер',
        details: {
          deviceId: currentDevice
        }
      });
    }
    launchAndroidBtn.disabled = false;
    updateLaunchAndroidBtn();
  });
}

// Вызов обновления кнопки при смене устройства/статуса
function triggerLaunchAndroidBtnUpdate() {
  setTimeout(updateLaunchAndroidBtn, 0);
}

// Следим за изменением currentDevice (выбор устройства)
let lastDeviceId = null;
function monitorCurrentDeviceChange() {
  if (currentDevice !== lastDeviceId) {
    lastDeviceId = currentDevice;
    updateLaunchAndroidBtn();
  }
  requestAnimationFrame(monitorCurrentDeviceChange);
}
monitorCurrentDeviceChange();

// Хук везде где меняется currentDevice, readyDevices, devices
const origSetFilesMode = setFilesMode;
setFilesMode = function(...args) {
  const res = origSetFilesMode.apply(this, args);
  triggerLaunchAndroidBtnUpdate();
  return res;
};
const origRenderTVList = typeof renderTVList === 'function' ? renderTVList : null;
if (origRenderTVList) {
  window.renderTVList = function(...args) {
    const res = origRenderTVList.apply(this, args);
    triggerLaunchAndroidBtnUpdate();
    return res;
  };
}
socket.on('devices/updated', triggerLaunchAndroidBtnUpdate);
socket.on('devices/status', triggerLaunchAndroidBtnUpdate);
// Первичная инициализация
if (launchAndroidBtn) {
  // Скрываем кнопку сразу при загрузке и делаем первичную проверку через 2 секунды
  launchAndroidBtn.style.display = 'none';
  setTimeout(() => {
    speakerInitialChecked = true;
    updateLaunchAndroidBtn();
  }, 2000);
}
const VOLUME_SOCKET_WAIT_MS = 1500;
const volumeFallbackTimers = new Map();
let isVideoSeeking = false;
let videoProgressTooltip = null;

// Получение размера страницы с учетом мобильных устройств
// На мобильных (≤767px) всегда возвращает 5, на десктопе - динамический расчет
function getMobilePageSize(itemType = null) {
  // На мобильных используем фиксированное значение 5
  if (window.innerWidth <= 767) {
    return 5;
  }
  // На десктопе используем динамический расчет
  return getPageSize(itemType);
}

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
  
  // Проверяем, есть ли в превью сетка миниатюр папки/PDF/PPTX (это означает, что открыто превью статического контента)
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
  
  // Показываем кнопки навигации для статического контента (папки, PDF, PPTX):
  // - когда открыто превью с миниатюрами (hasThumbnails)
  // - или когда активен плейлист папки
  // НО скрываем, если показывается iframe напрямую (видео превью), а не внутри static-preview-layout
  const shouldShowNavButtons = (hasThumbnails || isFolderWithPlaylist) && !hasDirectIframe;
  
  // Кнопки навигации (Назад/Вперед/Закрыть) показываем только для превью папок
  pdfPrevBtn.style.display = shouldShowNavButtons ? 'block' : 'none';
  pdfNextBtn.style.display = shouldShowNavButtons ? 'block' : 'none';
  pdfCloseBtn.style.display = shouldShowNavButtons ? 'block' : 'none';
  
  // Включаем/отключаем pointer-events для надежности
  pdfPrevBtn.style.pointerEvents = shouldShowNavButtons ? 'auto' : 'none';
  pdfNextBtn.style.pointerEvents = shouldShowNavButtons ? 'auto' : 'none';
  pdfCloseBtn.style.pointerEvents = shouldShowNavButtons ? 'auto' : 'none';

  // Кнопки управления плеером (Play/Pause/Restart/Stop) скрываем когда открыто превью папки
  // и показываем когда показывается видео или заглушка
  const playerControls = document.getElementById('playerControls');
  if (playerControls) {
    playerControls.style.display = shouldShowNavButtons ? 'none' : 'flex';
  }

  // Панель громкости скрываем когда показываются кнопки навигации (превью папки)
  if (volumePanel) {
    volumePanel.style.display = shouldShowNavButtons ? 'none' : 'flex';
  }
}

function resetPreviewHighlightState() {
  currentPreviewContext = { deviceId: null, file: null, page: null };
  filePreview.querySelectorAll('.thumbnail-preview').forEach((thumb) => {
    thumb.classList.remove('is-active');
    thumb.removeAttribute('data-selected');
  });
}

/**
 * Начинает отслеживание превью стрима
 * @param {string} deviceId 
 * @param {string} safeName 
 */
function startPreviewStreamTracking(safeName) {
  // КРИТИЧНО: Теперь отслеживаем только по safeName (стримы общие для всех устройств)
  const iframe = filePreview.querySelector('iframe');
  
  activePreviewStreams.set(safeName, {
    timestamp: Date.now(),
    iframe: iframe,
    isPlaying: false
  });
  
  console.log('[Speaker] 📡 Начато отслеживание превью стрима:', { safeName });
  
  // Отслеживаем события плеера для определения активности
  if (iframe) {
    const checkPlaying = () => {
      try {
        // Пытаемся определить, играет ли плеер (через события iframe)
        const entry = activePreviewStreams.get(safeName);
        if (entry) {
          entry.isPlaying = true;
        }
      } catch (e) {
        // Игнорируем ошибки cross-origin
      }
    };
    
    iframe.addEventListener('load', () => {
      // Плеер загружен, начинаем отслеживание
      setTimeout(checkPlaying, 1000);
    });
  }
}

/**
 * Останавливает отслеживание превью стрима
 * КРИТИЧНО: Теперь не запускаем таймеры - сервер сам проверит активность через idleTimeout (20 сек для превью)
 * @param {string} safeName 
 */
function stopPreviewStreamTracking(safeName) {
  const entry = activePreviewStreams.get(safeName);
  
  if (!entry) {
    return; // Уже остановлено или не отслеживалось
  }
  
  console.log('[Speaker] 📡 Остановка отслеживания превью стрима:', { safeName });
  
  // Просто удаляем из отслеживания - сервер сам проверит активность
  activePreviewStreams.delete(safeName);
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
  
  // КРИТИЧНО: Проверяем что устройство онлайн
  if (!requireDeviceReady(deviceId)) return;
  
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
  // КРИТИЧНО: Проверяем онлайн статус перед отправкой команды
  // Разрешаем остановку при наличии информации о воспроизведении
  if (notifyServer && deviceId) {
    if (requireDeviceReady(deviceId, true)) {
      socket.emit('control/playlistStop', { device_id: deviceId });
    } else {
      // Устройство офлайн - только очищаем локальное состояние
      console.warn('[Speaker] Устройство офлайн, плейлист остановлен локально', { deviceId, reason });
    }
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
  
  // КРИТИЧНО: Проверяем что устройство онлайн
  if (!requireDeviceReady(deviceId)) return;
  
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
      if (requireDeviceReady(deviceId)) {
        socket.emit('control/playlistStop', { device_id: deviceId });
      }
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
      // КРИТИЧНО: После конвертации PDF/PPTX превращается в папку с именем без расширения
      // Проверяем, существует ли папка (файл уже конвертирован) или еще исходный файл
      // Используем имя папки для получения изображений
      const folderName = safeName.replace(/\.(pdf|pptx)$/i, '');
      
      // Пробуем получить количество слайдов по исходному имени файла
      let res = await speakerFetch(`/api/devices/${encodeURIComponent(deviceId)}/slides-count?file=${encodeURIComponent(safeName)}`);
      let count = 0;
      
      if (res.ok) {
        const data = await res.json();
        count = Math.min(Number(data.count) || 0, 20);
      }
      
      // Если не получилось по исходному имени, пробуем по имени папки (файл уже конвертирован)
      if (count === 0) {
        res = await speakerFetch(`/api/devices/${encodeURIComponent(deviceId)}/slides-count?file=${encodeURIComponent(folderName)}`);
        if (res.ok) {
          const data = await res.json();
          count = Math.min(Number(data.count) || 0, 20);
        }
      }
      
      if (count === 0) return [];
      
      const urlType = contentType === 'pdf' ? 'page' : 'slide';
      // КРИТИЧНО: Используем имя папки для получения изображений (после конвертации исходный файл удален)
      return Array.from({ length: count }, (_, idx) =>
        `/api/devices/${encodeURIComponent(deviceId)}/converted/${encodeURIComponent(folderName)}/${urlType}/${idx + 1}`
      );
    }
  } catch (error) {
    console.error('[Speaker] Ошибка загрузки статического превью', error);
  }
  return [];
}

function renderThumbnailGrid(deviceId, safeName, contentType, imageUrls) {
  ensureThumbnailStyles();
  // deviceId здесь — устройство, где хранится контент
  // Для управления (плейлист/слайды) используем устройство воспроизведения
  const playbackDeviceId = (currentDevice && isDeviceReady(currentDevice)) ? currentDevice : deviceId;
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
                   style="width:100%; height:100%; object-fit:contain; display:block; pointer-events:none"
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
            data-device="${escapeAttr(playbackDeviceId)}"
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
    thumb.addEventListener('click', async () => {
      const sourceDeviceId = deviceId;
      const selectedTargets = getSelectedDeviceIds();
      const targetDeviceIds = selectedTargets.length
        ? selectedTargets.filter((id) => isDeviceReady(id))
        : [];
      if (!targetDeviceIds.length) return;

      const page = idx + 1;
      targetDeviceIds.forEach((targetDeviceId) => {
        stopFolderPlaylistIfNeeded('manual thumbnail click', { deviceId: targetDeviceId, file: safeName });
      });

      for (const targetDeviceId of targetDeviceIds) {
        if (targetDeviceId === sourceDeviceId) continue;
        try {
          const res = await speakerFetch('/api/devices/play-from-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceDeviceId,
              targetDeviceId,
              safeName,
              page
            })
          });
          if (!res.ok) {
            console.error('Не удалось подготовить файл на целевом устройстве:', res.status);
            await reportSpeakerNotification({
              type: 'speaker_play_target_error',
              title: 'Не удалось запустить файл',
              message: 'Не удалось запустить файл на выбранном устройстве',
              details: {
                sourceDeviceId,
                targetDeviceId,
                safeName,
                status: res.status
              }
            });
            return;
          }
        } catch (err) {
          console.error('play-from-all error for thumbnails', err);
          await reportSpeakerNotification({
            type: 'speaker_play_target_error',
            title: 'Не удалось запустить файл',
            message: 'Не удалось запустить файл на выбранном устройстве',
            details: {
              sourceDeviceId,
              targetDeviceId,
              safeName,
              error: err.message
            }
          });
          return;
        }
      }

      targetDeviceIds.forEach((targetDeviceId) => {
        sendVolumeBeforePlay(targetDeviceId);
      });

      const useBatchSync = targetDeviceIds.length > 1;
      if (useBatchSync) {
        socket.emit('control/play-batch', {
          device_ids: targetDeviceIds,
          file: safeName,
          page,
          originDeviceId: sourceDeviceId,
          startDelayMs: 1800
        });
        return;
      }

      socket.emit('control/play', {
        device_id: targetDeviceIds[0],
        file: safeName,
        page,
        originDeviceId: sourceDeviceId,
      });
    });
  });

  const playlistBtn = document.getElementById('folderPlaylistBtn');
  if (playlistBtn) {
    playlistBtn.addEventListener('click', () => {
      const btnDevice = playlistBtn.getAttribute('data-device');
      const btnFile = playlistBtn.getAttribute('data-file');
      const count = Number(playlistBtn.getAttribute('data-count')) || imageUrls.length;

      const targetDeviceIds = getPanelControlTargetDeviceIds();
      const useMultiSelection = targetDeviceIds.length > 1;

      if (!useMultiSelection) {
        toggleFolderPlaylist(btnDevice, btnFile, count);
        return;
      }

      const isActive = playlistBtn.classList.contains('is-active');
      const intervalSeconds = Math.max(1, folderPlaylistIntervalSeconds || DEFAULT_FOLDER_PLAYLIST_INTERVAL_SECONDS);
      const activeThumbnail = filePreview.querySelector('.thumbnail-preview.is-active, .thumbnail-preview[data-selected="1"]');
      const startPage = Math.max(1, Number(activeThumbnail?.getAttribute('data-page')) || 1);

      targetDeviceIds.forEach((targetDeviceId) => {
        if (isActive) {
          socket.emit('control/playlistStop', { device_id: targetDeviceId });
        } else {
          socket.emit('control/playlistStart', {
            device_id: targetDeviceId,
            file: btnFile,
            intervalSeconds,
            startPage
          });
        }
      });

      if (isActive) {
        playlistBtn.classList.remove('is-active');
        playlistBtn.textContent = 'Плейлист';
      } else {
        playlistBtn.classList.add('is-active');
        playlistBtn.textContent = 'Остановить плейлист';
      }
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
        const selectedTargets = getPanelControlTargetDeviceIds();
        const playlistBtn = document.getElementById('folderPlaylistBtn');
        const buttonActive = playlistBtn?.classList?.contains('is-active');
        const buttonFile = playlistBtn?.getAttribute('data-file') || safeName;

        if (selectedTargets.length > 1 && buttonActive) {
          selectedTargets.forEach((targetDeviceId) => {
            socket.emit('control/playlistStart', {
              device_id: targetDeviceId,
              file: buttonFile,
              intervalSeconds: nextValue
            });
          });
        }
        if (folderPlaylistState) {
          folderPlaylistState.intervalSeconds = nextValue;
          // КРИТИЧНО: Проверяем что устройство онлайн перед отправкой команды
          if (requireDeviceReady(folderPlaylistState.deviceId)) {
            socket.emit('control/playlistStart', {
              device_id: folderPlaylistState.deviceId,
              file: folderPlaylistState.file,
              intervalSeconds: nextValue
            });
          }
        }
      });
    });
    updateFolderPlaylistIntervalButtons();
  }
}

async function showStaticPreview(deviceId, safeName, contentType, { initiatedByUser = false } = {}) {
  if (!deviceId || !safeName || !isStaticContent(contentType)) return;
  
  // КРИТИЧНО: Останавливаем отслеживание превью стрима если было активно
  if (currentPreviewContext.deviceId && currentPreviewContext.file) {
    const fileData = allFiles.find(f => f.safeName === currentPreviewContext.file);
    if (fileData && fileData.contentType === 'streaming' && 
        currentPreviewContext.deviceId === deviceId && 
        currentPreviewContext.file !== safeName) {
      stopPreviewStreamTracking(currentPreviewContext.file);
    }
  }
  
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
  
  // КРИТИЧНО: Обновляем видимость кнопок после рендера миниатюр
  // Используем небольшой timeout, чтобы DOM успел обновиться
  setTimeout(() => {
    updatePreviewControlButtons();
  }, 50);
}

async function syncPreviewWithPlayerState() {
  if (!currentDevice || previewManuallyClosed) return;
  const state = playerStateByDevice.get(currentDevice);
  
  // КРИТИЧНО: Если показывается превью папки (миниатюры), не перезаписывать заглушкой
  // Пользователь только что открыл папку через playBtn - даем время на обновление состояния
  const hasThumbnails = filePreview.querySelector('.thumbnail-preview');
  if (hasThumbnails) {
    // Если есть миниатюры и состояние еще не обновилось - ждем немного
    if (!state || !state.file) {
      // Не перезаписываем превью папки заглушкой сразу после открытия
      return;
    }
    // Если состояние обновилось и это та же папка - синхронизируем страницу
    const currentPreviewFile = filePreview.querySelector('.thumbnail-preview')?.getAttribute('data-file');
    if (state.file === currentPreviewFile && isStaticContent(state.type)) {
      // КРИТИЧНО: Активируем thumbnail только если есть данные от плеера (state.page)
      if (state.page) {
        highlightCurrentThumbnail(state.page, { deviceId: currentDevice, file: state.file });
      }
      return;
    }
  }
  
  // КРИТИЧНО: Проверяем, показывается ли превью стрима
  const hasStreamingPreview = filePreview.querySelector('iframe')?.src?.includes('type=streaming');
  
  if (!state || !state.file) {
    // Показываем заглушку только если нет превью папки и нет превью стрима
    if (!hasThumbnails && !hasStreamingPreview) {
      showLivePreviewForTV(currentDevice, true);
    }
    return;
  }
  
  // КРИТИЧНО: Если показывается превью стрима - не переключать на заглушку
  if (state.type === 'streaming' && hasStreamingPreview) {
    return; // Оставляем превью стрима как есть
  }
  
  // Для статического контента продолжаем обычную логику
  if (!isStaticContent(state.type)) {
    // Если это не статический контент и не стрим - показываем заглушку
    if (!hasThumbnails && !hasStreamingPreview) {
      showLivePreviewForTV(currentDevice, true);
    }
    return;
  }

  // Если пользователь явно выбрал другой файл для превью, не переключать автоматически
  if (currentFile && currentFile !== state.file) {
    return;
  }

  const currentPreviewFile = filePreview.querySelector('.thumbnail-preview')?.getAttribute('data-file');
  if (currentPreviewFile !== state.file) {
    await showStaticPreview(currentDevice, state.file, state.type);
    // КРИТИЧНО: После открытия превью заново получаем актуальный state из playerStateByDevice
    // так как он мог обновиться пока открывалось превью (например, пришел player/progress)
    const updatedState = playerStateByDevice.get(currentDevice);
    if (updatedState && updatedState.file === state.file && updatedState.page) {
      highlightCurrentThumbnail(updatedState.page, { deviceId: currentDevice, file: updatedState.file });
      return;
    }
  }

  // КРИТИЧНО: Активируем thumbnail только если есть данные от плеера (state.page)
  // Не устанавливаем is-active автоматически - ждем данные от плеера через player/progress
  if (state.page) {
    highlightCurrentThumbnail(state.page, { deviceId: currentDevice, file: state.file });
  }
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
    loadNodeNames(speakerFetch),
    loadDevices()
  ]);

  // Инициализация режима списка (по умолчанию — файлы выбранного устройства)
  setFilesMode('device', { skipLoad: true });

  // Инициализируем режим списка файлов (подсветка кнопок)
  setFilesMode(fileListMode || 'device');
  
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

async function showStreamingPreview(deviceId, safeName, streamProtocol = '') {
  if (!deviceId || !safeName) return;
  previewManuallyClosed = false;
  
  // КРИТИЧНО: Логика такая же, как на плеере - просто запускаем стрим через API и показываем в iframe
  try {
    console.log('[Speaker] 📡 Запускаем стрим для превью:', { deviceId, safeName, streamProtocol });
    
    // Показываем индикатор "Стрим запускается..."
    filePreview.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);gap:20px">
        <div style="font-size:18px;font-weight:500">Стрим запускается...</div>
        <div style="width:40px;height:40px;border:4px solid var(--border-color);border-top-color:var(--accent-color);border-radius:50%;animation:spin 1s linear infinite"></div>
        <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
      </div>
    `;
    
    // КРИТИЧНО: Retry логика для получения streamProxyUrl
    // ensureStreamRunning может вернуть null, если плейлист еще не создан
    let retryCount = 0;
    const maxRetries = 10; // Увеличено до 10 попыток (до 20 секунд)
    const retryDelay = 2000; // 2 секунды между попытками
    
    const tryGetStreamUrl = async () => {
      try {
        // Запускаем стрим через API (точно так же, как на плеере)
        const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/streams/${encodeURIComponent(safeName)}`);
        if (!res.ok) {
          console.error('[Speaker] ❌ Не удалось запустить стрим для превью:', res.status);
          if (retryCount < maxRetries) {
            retryCount++;
            console.log(`[Speaker] ⏳ Повтор запроса через ${retryDelay}ms (попытка ${retryCount}/${maxRetries})`);
            setTimeout(tryGetStreamUrl, retryDelay);
          } else {
            filePreview.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary)">Ошибка запуска стрима (HTTP ${res.status})</div>`;
          }
          return;
        }
        
        const data = await res.json();
        console.log('[Speaker] ✅ Ответ API:', { streamProxyUrl: data.streamProxyUrl, protocol: data.protocol, attempt: retryCount + 1 });
        
        // КРИТИЧНО: Используем ИСКЛЮЧИТЕЛЬНО streamProxyUrl (без fallback) - точно как на плеере
        const playbackUrl = data?.streamProxyUrl;
        if (!playbackUrl) {
          if (retryCount < maxRetries) {
            retryCount++;
            console.log(`[Speaker] ⏳ streamProxyUrl еще не готов, повтор через ${retryDelay}ms (попытка ${retryCount}/${maxRetries})`);
            setTimeout(tryGetStreamUrl, retryDelay);
            return;
          } else {
            console.warn('[Speaker] ⚠️ streamProxyUrl не получен после всех попыток');
            filePreview.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary)">Стрим не готов. Попробуйте позже.</div>`;
            return;
          }
        }
        
        // КРИТИЧНО: Если URL содержит .m3u8 (проксированный HLS), всегда используем 'hls'
        // независимо от исходного протокола, так как все стримы рестримятся в HLS
        let proto = data?.protocol || streamProtocol || 'hls';
        if (playbackUrl && playbackUrl.includes('.m3u8')) {
          proto = 'hls';
        }
        
        console.log('[Speaker] 📡 Используем streamProxyUrl для превью (из API):', { playbackUrl, proto });
        
        // Обновляем контекст превью
        currentPreviewContext = { deviceId, file: safeName, page: null };
        
        // Отслеживаем активное превью стрима (теперь только по safeName)
        startPreviewStreamTracking(safeName);
        
        // КРИТИЧНО: Для HLS стримов проверяем доступность плейлиста с retry (точно как на плеере)
        if (playbackUrl.includes('.m3u8') || proto === 'hls') {
          console.log('[Speaker] 📡 Проверяем доступность HLS плейлиста для превью...');
          let playlistRetryCount = 0;
          const maxPlaylistRetries = 5;
          const playlistRetryDelay = 1000; // 1 секунда
          
          const tryLoadStream = async () => {
            try {
              // Проверяем доступность плейлиста
              const checkRes = await fetch(playbackUrl, { method: 'HEAD', cache: 'no-cache' });
              if (checkRes.ok) {
                console.log('[Speaker] ✅ HLS плейлист доступен, показываем плеер');
                showStreamPlayer(playbackUrl, deviceId, safeName, proto);
              } else if (playlistRetryCount < maxPlaylistRetries) {
                playlistRetryCount++;
                console.log(`[Speaker] ⏳ HLS плейлист еще не готов, повтор через ${playlistRetryDelay}ms (попытка ${playlistRetryCount}/${maxPlaylistRetries})`);
                setTimeout(tryLoadStream, playlistRetryDelay);
              } else {
                console.warn('[Speaker] ⚠️ HLS плейлист не стал доступен после всех попыток, пробуем запустить');
                showStreamPlayer(playbackUrl, deviceId, safeName, proto);
              }
            } catch (err) {
              if (playlistRetryCount < maxPlaylistRetries) {
                playlistRetryCount++;
                console.log(`[Speaker] ⏳ Ошибка проверки плейлиста, повтор через ${playlistRetryDelay}ms (попытка ${playlistRetryCount}/${maxPlaylistRetries}):`, err.message);
                setTimeout(tryLoadStream, playlistRetryDelay);
              } else {
                console.warn('[Speaker] ⚠️ Не удалось проверить HLS плейлист, пробуем запустить:', err);
                showStreamPlayer(playbackUrl, deviceId, safeName, proto);
              }
            }
          };
          
          // Начинаем с небольшой задержки
          setTimeout(tryLoadStream, 500);
        } else {
          // Для не-HLS стримов показываем сразу
          showStreamPlayer(playbackUrl, deviceId, safeName, proto);
        }
      } catch (error) {
        console.error('[Speaker] ❌ Ошибка при получении streamProxyUrl:', error);
        if (retryCount < maxRetries) {
          retryCount++;
          console.log(`[Speaker] ⏳ Ошибка, повтор через ${retryDelay}ms (попытка ${retryCount}/${maxRetries})`);
          setTimeout(tryGetStreamUrl, retryDelay);
        } else {
          const safeError = escapeHtml(error?.message || 'Неизвестная ошибка');
          filePreview.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary)">Ошибка: ${safeError}</div>`;
        }
      }
    };
    
    // Начинаем запрос
    tryGetStreamUrl();
  } catch (error) {
    console.error('[Speaker] ❌ Ошибка при запуске стрима для превью:', error);
    const safeError = escapeHtml(error?.message || 'Неизвестная ошибка');
    filePreview.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary)">Ошибка: ${safeError}</div>`;
  }
}


function showStreamPlayer(streamProxyUrl, deviceId, safeName, streamProtocol) {
  // Обновляем контекст превью
  currentPreviewContext = { deviceId, file: safeName, page: null };
  
  // Отслеживаем активное превью стрима (теперь только по safeName)
  startPreviewStreamTracking(safeName);
  
  // Показываем плеер с прямым streamProxyUrl (как для обычного плеера)
  const protocolParam = streamProtocol ? `&protocol=${encodeURIComponent(streamProtocol)}` : '';
  const streamUrlParam = `&stream_url=${encodeURIComponent(streamProxyUrl)}`;
  const src = `/player-videojs.html?device_id=${encodeURIComponent(deviceId)}&preview=1&type=streaming&file=${encodeURIComponent(safeName)}${protocolParam}${streamUrlParam}&t=${Date.now()}`;
  
  const frame = filePreview.querySelector('iframe');
  if (frame) {
    frame.src = src;
  } else {
    filePreview.innerHTML = `<iframe src="${src}" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen"></iframe>`;
  }
  setTimeout(() => updatePreviewControlButtons(), 10);
}

async function loadDevices() {
  try {
    const res = await speakerFetch('/api/devices');
    if (!res.ok) {
      console.error('Не удалось загрузить устройства:', res.status);
      return;
    }
    const newDevices = await res.json();
    
    newDevices.forEach(device => {
      prefillDeviceFileMeta(device);
    });
    
    devices = newDevices;
    // Сортируем устройства по алфавиту: А-Я, A-Z, 0-9
    devices = sortDevices(devices, nodeNames);
    devices.forEach(d => {
      prefillDeviceFileMeta(d);
      if (d.current && d.current.file) {
        playerStateByDevice.set(d.device_id, {
          type: d.current.type,
          file: d.current.file,
          page: Number(d.current.page) || 1,
        });
      }
    });
    const pageSize = getMobilePageSize(); // Фиксированное значение 5 на мобильных
    const totalPages = Math.max(1, Math.ceil(devices.length / pageSize));
    if (tvPage >= totalPages) tvPage = totalPages - 1;
    pruneSelectedDevices();
    syncFilesModeWithSelection({ skipLoad: true });
    updateDevicesCount();
    renderTVList();
  } catch (error) {
    console.error('Не удалось загрузить устройства:', error);
  }
}

/* Рендер списка ТВ (информативный, с подсветкой выбранного) */
function renderTvTile(device) {
  const name = device.name || nodeNames[device.device_id] || device.device_id;
  const filesCount = device.files?.length ?? 0;
  const isActive = device.device_id === currentDevice;
  const isSelected = selectedDeviceIds.has(device.device_id);
  const isReady = readyDevices.has(device.device_id);
  const volumeState = getVolumeState(device.device_id);
  const volumeInfo = resolveVolumeIndicator(volumeState, isReady);
  const volumeIcon = getVolumeIconSvg({ ...volumeInfo, size: 18 });
  const playbackInfo = buildPreviewPlaybackInfo(device);
  const playbackBlock = `
      <div class="tvTile-previewInfo${playbackInfo ? '' : ' is-empty'}">
        ${playbackInfo ? getPlaybackInfoInnerHtml(playbackInfo) : ''}
      </div>
    `;
  const ariaLabel = `Громкость ${volumeInfo.levelText}, ${volumeInfo.statusText}`;
  const volumeRow = `
      <div class="tvTile-volumeRow">
        ${playbackBlock}
        <div class="tvTile-volume${!isReady ? ' is-offline' : ''}" aria-label="${escapeAttr(ariaLabel)}">
          ${volumeIcon}
          <span class="volume-level">${volumeInfo.levelText}</span>
        </div>
      </div>
    `;
  const metaRow = `
      <div class="tvTile-metaRow">
        <span class="meta tvTile-meta">ID: ${device.device_id}</span>
        <span class="meta tvTile-files">Файлов: ${filesCount}</span>
      </div>
    `;
  return `
    <li class="tvTile${isActive ? ' active' : ''}${isSelected ? ' selected' : ''}" data-id="${device.device_id}">
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
}


function renderTVList() {
  // Сортируем устройства перед отображением (на случай если список обновился)
  const sortedDevices = sortDevices(devices);
  const pageSize = getMobilePageSize(); // Фиксированное значение 5 на мобильных
  const totalPages = Math.max(1, Math.ceil(sortedDevices.length / pageSize));
  if (tvPage >= totalPages) tvPage = totalPages - 1;
  const start = tvPage * pageSize;
  const end = Math.min(start + pageSize, sortedDevices.length);
  const pageItems = sortedDevices.slice(start, end);

  // Рендерим устройства (стили задаются в CSS)
  tvList.innerHTML = pageItems.map(renderTvTile).join('');

  tvList.querySelectorAll('.tvTile').forEach(item => {
    const deviceId = item.dataset.id;
    if (!deviceId) return;

    let longPressTimer = null;
    const clearLongPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    item.addEventListener('touchstart', () => {
      clearLongPress();
      longPressTimer = setTimeout(async () => {
        item.dataset.longPressTriggered = '1';

        if (!touchMultiSelectMode) {
          touchMultiSelectMode = true;
          selectedDeviceIds.clear();
          selectedDeviceIds.add(deviceId);
        } else {
          toggleDeviceSelection(deviceId);
        }

        syncFilesModeWithSelection({ skipLoad: true });

        await selectDevice(deviceId, false, { preserveSelection: true });
      }, TV_TILE_LONG_PRESS_MS);
    }, { passive: true });

    item.addEventListener('touchend', clearLongPress, { passive: true });
    item.addEventListener('touchcancel', clearLongPress, { passive: true });
    item.addEventListener('touchmove', clearLongPress, { passive: true });

    item.addEventListener('click', async (event) => {
      if (item.dataset.longPressTriggered === '1') {
        item.dataset.longPressTriggered = '0';
        event.preventDefault();
        return;
      }

      const isMultiSelect = isDesktopMultiSelectEvent(event) || touchMultiSelectMode;
      if (!isMultiSelect) {
        setSingleDeviceSelection(deviceId);
        await selectDevice(deviceId, true, { preserveSelection: true });
        return;
      }

      toggleDeviceSelection(deviceId);

      if (!selectedDeviceIds.size) {
        setSingleDeviceSelection(currentDevice || deviceId);
      }

      if (currentDevice && !selectedDeviceIds.has(currentDevice)) {
        const [nextPrimaryDevice] = Array.from(selectedDeviceIds);
        if (nextPrimaryDevice) {
          await selectDevice(nextPrimaryDevice, false, { preserveSelection: true });
          return;
        }
      }

      syncFilesModeWithSelection();

      refreshTvSelectionClasses();
      const meta = document.getElementById('filesPaneMeta');
      if (meta) {
        meta.textContent = formatFilesMetaWithSelection(meta.textContent || '');
      }
    });
  });

  refreshTvSelectionClasses();

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
  // КРИТИЧНО: Останавливаем отслеживание превью стрима если было активно
  if (currentPreviewContext.deviceId && currentPreviewContext.file) {
    const device = devices.find(d => d.device_id === currentPreviewContext.deviceId);
    if (device) {
      const fileData = allFiles.find(f => f.safeName === currentPreviewContext.file);
      if (fileData && fileData.contentType === 'streaming') {
        stopPreviewStreamTracking(currentPreviewContext.file);
      }
    }
  }
  
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
async function selectDevice(id, resetPage = true, { preserveSelection = false } = {}) {
  if (!id) return;

  if (!preserveSelection) {
    setSingleDeviceSelection(id);
  } else {
    selectedDeviceIds.add(id);
  }

  const previousDevice = currentDevice;
  currentDevice = id;
  syncFilesModeWithSelection({ skipLoad: true });
  const isDeviceSwitch = previousDevice && previousDevice !== id;
  if (isDeviceSwitch) {
    previewManuallyClosed = false;
    showLivePreviewForTV(id, true);
  }
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
  refreshTvSelectionClasses();
  
  // ИСПРАВЛЕНО: При явном выборе устройства снимаем подсветку файлов
  if (resetPage) {
    fileList.querySelectorAll('.file-item').forEach(item => item.classList.remove('active'));
  }
  
  // КРИТИЧНО: Обновляем кэш метаданных для нового устройства ДО загрузки файлов
  // Это гарантирует, что resolveFileDisplayData найдет правильные originalName
  const newDevice = devices.find(d => d.device_id === id);
  if (newDevice) {
    prefillDeviceFileMeta(newDevice);
    // Обновляем превью TV для нового устройства, чтобы отобразилось правильное имя
    refreshTvTilePlaybackInfo(id);
  }

  await loadFiles();
  await syncPreviewWithPlayerState();
  updateVolumeUI();
  await ensureVolumeState(currentDevice);
  
}

/* Загрузка и рендер файлов для текущего ТВ или агрегата */
async function loadFiles() {
  if (fileListMode === 'all') {
    return loadAllFilesAggregated();
  }
  if (!currentDevice) return;
  
  const device = devices.find(d => d.device_id === currentDevice);
  const deviceName = device ? (device.name || nodeNames[currentDevice] || currentDevice) : currentDevice;
  
  const meta = document.getElementById('filesPaneMeta');
  if (meta) meta.textContent = formatFilesMetaWithSelection('Загрузка...');
  
  updatePlaybackInfoUI();
  
  try {
    const res = await speakerFetch(`/api/devices/${encodeURIComponent(currentDevice)}/files-with-status?readyOnly=1`);
    if (!res.ok) {
      console.error('Не удалось загрузить файлы:', res.status);
      fileList.innerHTML = '<li class="item" style="text-align:center; padding:var(--space-xl)"><div class="meta">Ошибка загрузки файлов</div></li>';
      if (meta) meta.textContent = formatFilesMetaWithSelection('0 файлов');
      return;
    }
    const filesData = await res.json();

    allFiles = filesData
      .filter(item => !(typeof item === 'object' && item.isPlaceholder))
      .map(item => {
        if (typeof item === 'string') {
          return { safeName: item, originalName: item, resolution: null, durationSeconds: null, folderImageCount: null, contentType: null, streamUrl: null, streamProxyUrl: null, streamProtocol: null, sourceDeviceId: currentDevice };
        }
        const itemSafeName = item.name || item.safeName || item.originalName;
        return { 
          safeName: itemSafeName, 
          // КРИТИЧНО: Не используем safeName как fallback
          // Если originalName нет или равен safeName, оставляем null, чтобы resolveFileDisplayData мог найти его из device.fileNames
          originalName: (item.originalName && item.originalName !== itemSafeName) ? item.originalName : null,
          resolution: item.resolution || null,
          durationSeconds: typeof item.durationSeconds === 'number' ? item.durationSeconds : null,
          folderImageCount: typeof item.folderImageCount === 'number' ? item.folderImageCount : null,
          contentType: item.contentType || null,
          streamUrl: item.streamUrl || null,
          streamProxyUrl: item.streamProxyUrl || getStreamPlaybackUrl(currentDevice, item.safeName || item.name || item.originalName),
          streamProtocol: item.streamProtocol || null,
          hasTrailer: item.hasTrailer || false,
          trailerUrl: item.trailerUrl || null,
          sourceDeviceId: currentDevice
        };
      });

    cacheDeviceFileMeta(currentDevice, allFiles);
    refreshTvTilePlaybackInfo(currentDevice);

  if (!allFiles || allFiles.length === 0) {
    fileList.innerHTML = `
      <li class="item" style="text-align:center; padding:var(--space-xl)">
        <div class="meta">Нет файлов</div>
      </li>
    `;
    const pager = document.getElementById('filePager');
    if (pager) pager.innerHTML = '';
    if (meta) meta.textContent = formatFilesMetaWithSelection('0 файлов');
    return;
  }
  
  const totalFilesCount = allFiles.length;
  if (meta) {
    const filesText = `${totalFilesCount} файл${totalFilesCount === 1 ? '' : totalFilesCount > 1 && totalFilesCount < 5 ? 'а' : 'ов'}`;
    meta.textContent = formatFilesMetaWithSelection(filesText);
  }
  
  updatePlaybackInfoUI();

  const pageSize = getMobilePageSize('file');
  const totalPages = Math.max(1, Math.ceil(allFiles.length / pageSize));
  if (filePage >= totalPages) filePage = totalPages - 1;
  const start = filePage * pageSize;
  const end = Math.min(start + pageSize, allFiles.length);
  const files = allFiles.slice(start, end);

  fileList.innerHTML = files.map(({ safeName, originalName, resolution, durationSeconds, folderImageCount, contentType, streamProtocol, hasTrailer, trailerUrl }) => {
    // КРИТИЧНО: Используем resolveFileDisplayData для получения правильного оригинального имени
    // Это гарантирует, что будет использовано оригинальное имя из всех доступных источников
    const { displayName: resolvedDisplayName } = resolveFileDisplayData(currentDevice, safeName);
    // КРИТИЧНО: НЕ используем safeName как fallback - только resolvedDisplayName или originalName
    // Если оба отсутствуют, используем resolvedDisplayName (который может быть safeName только как последний fallback)
    const effectiveOriginalName = resolvedDisplayName || originalName;
    // Определяем тип файла (включая папки)
    // КРИТИЧНО: Сначала проверяем contentType из метаданных БД, потом fallback на расширение
    let type = 'VID'; // По умолчанию
    let typeLabel = 'Видео'; // Русское название

    const normalizedType = resolveContentType({
      contentType,
      fileName: safeName,
      originalName,
      fallbackToFolder: true
    });

    if (normalizedType === 'streaming') {
      type = 'STREAM';
      typeLabel = streamProtocol ? `Стрим (${streamProtocol.toUpperCase()})` : 'Стрим';
    } else if (normalizedType && normalizedType !== 'unknown') {
      const typeInfo = getContentTypeInfo(normalizedType, streamProtocol);
      type = typeInfo.shortLabel;
      typeLabel = typeInfo.label;
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
    // КРИТИЧНО: Проверяем только safeName, так как currentFile всегда устанавливается в safeName
    // originalName может быть null, поэтому не используем его для сравнения
    const active = currentFile === safeName || (originalName && currentFile === originalName);
    // КРИТИЧНО: Используем resolvedDisplayName (уже без расширения) или effectiveOriginalName
    // НЕ используем safeName как fallback - только если resolvedDisplayName и effectiveOriginalName отсутствуют
    // resolvedDisplayName уже должен содержать правильное оригинальное имя из resolveFileDisplayData
    const displayName = resolvedDisplayName || (effectiveOriginalName ? effectiveOriginalName.replace(/\.[^.]+$/, '') : '');
    
    const metaBadges = [];
    if (type === 'FOLDER' && typeof folderImageCount === 'number') {
      metaBadges.push(`${folderImageCount} фото`);
    }
    if ((type === 'VID' || type === 'AUDIO') && typeof durationSeconds === 'number' && durationSeconds > 0) {
      metaBadges.push(formatTime(durationSeconds));
    }
    if (type === 'STREAM') {
      metaBadges.push(streamProtocol ? streamProtocol.toUpperCase() : 'онлайн');
    }
    const typeBadgeLabel = metaBadges.length ? `${typeLabel} · ${metaBadges.join(' · ')}` : typeLabel;
    
    return `
      <li class="file-item ${active ? 'active' : ''}" 
          data-safe="${encodeURIComponent(safeName)}" 
          data-original="${encodeURIComponent(originalName)}"
          data-content-type="${contentType || ''}"
          data-stream-protocol="${streamProtocol || ''}"
          data-has-trailer="${hasTrailer ? '1' : '0'}"
          data-trailer-url="${trailerUrl || ''}"
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
             data-stream-protocol="${streamProtocol || ''}"
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
      const contentType = item.getAttribute('data-content-type') || null;
      const streamProtocol = item.getAttribute('data-stream-protocol') || '';
      const originalName = decodeURIComponent(item.getAttribute('data-original'));
      
      // КРИТИЧНО: Останавливаем отслеживание предыдущего превью стрима если было активно
      if (currentPreviewContext.deviceId && currentPreviewContext.file) {
        const prevFileData = allFiles.find(f => f.safeName === currentPreviewContext.file);
        if (prevFileData && prevFileData.contentType === 'streaming' && 
            currentPreviewContext.deviceId === currentDevice && 
            currentPreviewContext.file !== safeName) {
          stopPreviewStreamTracking(currentPreviewContext.file);
        }
      }
      
      setCurrentFileSelection(safeName, item, currentDevice);
      previewManuallyClosed = false;
      
      // КРИТИЧНО: Для стримов показываем превью через showStreamingPreview
      if (contentType === 'streaming') {
        console.log('[Speaker] 📡 Показываем превью стрима:', safeName);
        showStreamingPreview(currentDevice, safeName, streamProtocol);
        return;
      }

      // Определяем тип файла
      const normalizedType = resolveContentType({
        contentType,
        fileName: safeName,
        originalName,
        fallbackToFolder: true
      });
      
      // Для папок, PDF и PPTX показываем сетку миниатюр - откладываем тяжелую операцию
      // КРИТИЧНО: Определяем статический контент по contentType из метаданных БД
      const isStaticContentForPreview = STATIC_CONTENT_TYPES.has(normalizedType);
      if (isStaticContentForPreview) {
        // Используем requestIdleCallback для неблокирующей загрузки, fallback на setTimeout
        const loadPreview = async () => {
          await showStaticPreview(currentDevice, safeName, normalizedType, { initiatedByUser: true });
        };
        
        if ('requestIdleCallback' in window) {
          requestIdleCallback(loadPreview, { timeout: 100 });
        } else {
          setTimeout(loadPreview, 0);
        }
      } else {
        // На мобильных отключаем превью для видео и изображений (только папки/PPTX/PDF)
        if (window.innerWidth <= 767) {
          return; // Не показываем превью для видео/изображений на мобильных
        }
        // Для видео и обычных изображений показываем в iframe - быстрая операция
        
        // КРИТИЧНО: Останавливаем отслеживание превью стрима если было активно
        if (currentPreviewContext.deviceId && currentPreviewContext.file) {
          const prevFileData = allFiles.find(f => f.safeName === currentPreviewContext.file);
          if (prevFileData && prevFileData.contentType === 'streaming' && 
              currentPreviewContext.deviceId === currentDevice && 
              currentPreviewContext.file !== safeName) {
            stopPreviewStreamTracking(currentPreviewContext.file);
          }
        }
        
        // КРИТИЧНО: Обновляем контекст превью
        currentPreviewContext = { deviceId: currentDevice, file: safeName, page: null };
        
        // Универсальная функция формирования src для превью
        function buildPreviewSrc({ deviceId, fileName, type, trailerUrl, page }) {
          let src = `/player-videojs.html?device_id=${encodeURIComponent(deviceId)}&file=${encodeURIComponent(fileName)}&preview=1&muted=1`;
          if (type) src += `&type=${encodeURIComponent(type)}`;
          if (typeof page !== 'undefined') src += `&page=${encodeURIComponent(page)}`;
          if (trailerUrl) src += `&trailerUrl=${encodeURIComponent(trailerUrl)}`;
          src += `&t=${Date.now()}`;
          return src;
        }

        const ext = getFileExtension(safeName);
        let type = null;
        let page = undefined;
        let trailerUrl = null;
        if (normalizedType === 'image' || IMAGE_EXTENSIONS.includes(ext)) {
          type = 'image';
          page = 1;
        } else if (normalizedType === 'video' || VIDEO_EXTENSIONS.includes(ext)) {
          const hasTrailer = item.getAttribute('data-has-trailer') === '1';
          trailerUrl = item.getAttribute('data-trailer-url');
          if (!(hasTrailer && trailerUrl)) trailerUrl = null;
          type = 'video';
        } else if (normalizedType === 'audio') {
          type = 'audio';
        } else if (STATIC_CONTENT_TYPES.has(normalizedType)) {
          type = normalizedType;
        }
        const src = buildPreviewSrc({
          deviceId: currentDevice,
          fileName: safeName,
          type,
          trailerUrl,
          page
        });
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
      const containerItem = btn.closest('.file-item');
      const contentType = containerItem?.getAttribute('data-content-type') || null;
      const streamProtocol = btn.getAttribute('data-stream-protocol') || containerItem?.getAttribute('data-stream-protocol') || '';
      const originalName = decodeURIComponent(btn.getAttribute('data-original'));
      const sourceDeviceId = decodeURIComponent(btn.getAttribute('data-source-device') || '') || null;

      // Если текущее устройство офлайн, но источник онлайн — используем источник
      const targetDeviceId = (currentDevice && isDeviceReady(currentDevice))
        ? currentDevice
        : (sourceDeviceId && isDeviceReady(sourceDeviceId) ? sourceDeviceId : currentDevice);

      if (!requireDeviceReady(targetDeviceId)) return;

      setCurrentFileSelection(safeName, containerItem, sourceDeviceId || targetDeviceId);
      
      // Сбрасываем флаг закрытия при новом воспроизведении
      previewManuallyClosed = false;
      stopFolderPlaylistIfNeeded('manual play button', { deviceId: targetDeviceId, file: safeName });
      
      // Отправляем громкость перед запуском контента
      sendVolumeBeforePlay(targetDeviceId);
      
      // Определяем тип файла (приоритет contentType из БД)
      const normalizedType = resolveContentType({
        contentType,
        fileName: safeName,
        originalName,
        fallbackToFolder: true
      });

      if (normalizedType === 'streaming') {
        previewManuallyClosed = false;
        stopFolderPlaylistIfNeeded('streaming play', { deviceId: targetDeviceId, file: safeName });
        sendVolumeBeforePlay(targetDeviceId);
        socket.emit('control/play', { device_id: targetDeviceId, file: safeName, type: 'streaming', streamProtocol: streamProtocol || undefined });
        return;
      }

      // КРИТИЧНО: Определяем статический контент по contentType из метаданных БД
      const isStaticContent = STATIC_CONTENT_TYPES.has(normalizedType);
      const isAudio = normalizedType === 'audio';

      if (isAudio) {
        // Для аудио: показываем только логотип аудио (iframe), без миниатюр и заглушек
        const audioPreviewUrl = `/player-videojs.html?device_id=${encodeURIComponent(targetDeviceId)}&preview=1&type=audio&file=${encodeURIComponent(safeName)}`;
        const frame = filePreview.querySelector('iframe');
        if (frame) {
          frame.src = audioPreviewUrl;
        } else {
          filePreview.innerHTML = `<iframe src="${audioPreviewUrl}" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen"></iframe>`;
        }
        updatePreviewControlButtons();
        socket.emit('control/play', { device_id: targetDeviceId, file: safeName, type: 'audio' });
        return;
      }

      if (isStaticContent) {
        // Превью всегда берём с устройства-источника (там лежат файлы)
        const previewDeviceId = sourceDeviceId || targetDeviceId;
        const previewContentType = normalizedType || 'folder';

        const loadPreview = async () => {
          await showStaticPreview(previewDeviceId, safeName, previewContentType, { initiatedByUser: true });
        };
        if ('requestIdleCallback' in window) {
          requestIdleCallback(loadPreview, { timeout: 100 });
        } else {
          setTimeout(loadPreview, 0);
        }

        // Если целевое устройство отличается от источника — готовим файл на целевом (копирование/линк) через play-from-all
        if (targetDeviceId && sourceDeviceId && targetDeviceId !== sourceDeviceId) {
          speakerFetch('/api/devices/play-from-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceDeviceId,
              targetDeviceId,
              safeName
            })
          }).catch(err => {
            console.error('play-from-all (static) failed', err);
          });
        }

        // Отправляем команду play на целевое устройство (ожидается, что файл доступен после play-from-all или уже есть)
        socket.emit('control/play', { device_id: targetDeviceId, file: safeName, type: normalizedType || previewContentType || 'folder', page: 1 });
        return;
      }

      // Изображения (одиночные) — отправляем как image
      if (normalizedType === 'image') {
        // Если целевое устройство отличается от источника — готовим файл на целевом
        if (targetDeviceId && sourceDeviceId && targetDeviceId !== sourceDeviceId) {
          speakerFetch('/api/devices/play-from-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceDeviceId,
              targetDeviceId,
              safeName
            })
          }).catch(err => console.error('play-from-all (image) failed', err));
        }
        socket.emit('control/play', { device_id: targetDeviceId, file: safeName, type: 'image', page: 1 });
        return;
      }

      // Видео/изображения — показываем корректное превью выбранного файла (или трейлера)
      setTimeout(() => {
        // Универсальная функция формирования src для превью (дублирует buildPreviewSrc выше)
        function buildPreviewSrc({ deviceId, fileName, type, trailerUrl, page }) {
          let src = `/player-videojs.html?device_id=${encodeURIComponent(deviceId)}&file=${encodeURIComponent(fileName)}&preview=1&muted=1`;
          if (type) src += `&type=${encodeURIComponent(type)}`;
          if (typeof page !== 'undefined') src += `&page=${encodeURIComponent(page)}`;
          if (trailerUrl) src += `&trailerUrl=${encodeURIComponent(trailerUrl)}`;
          src += `&t=${Date.now()}`;
          return src;
        }
        let type = null;
        let page = undefined;
        let trailerUrl = null;
        if (IMAGE_EXTENSIONS.includes(ext)) {
          type = 'image';
          page = 1;
        } else if (VIDEO_EXTENSIONS.includes(ext)) {
          // Проверяем наличие трейлера
          const hasTrailer = containerItem.getAttribute('data-has-trailer') === '1';
          trailerUrl = containerItem.getAttribute('data-trailer-url');
          if (!(hasTrailer && trailerUrl)) trailerUrl = null;
          type = 'video';
        }
        const src = buildPreviewSrc({
          deviceId: targetDeviceId,
          fileName: safeName,
          type,
          trailerUrl,
          page
        });
        const frame = filePreview.querySelector('iframe');
        if (frame) {
          frame.src = src;
        } else {
          filePreview.innerHTML = `<iframe src="${src}" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen"></iframe>`;
        }
        updatePreviewControlButtons();
      }, 300);
      socket.emit('control/play', { device_id: targetDeviceId, file: safeName });
    };
  });
  
  } catch (error) {
    console.error('Не удалось отобразить файлы:', error);
    fileList.innerHTML = '<li class="item" style="text-align:center; padding:var(--space-xl)"><div class="meta">Ошибка загрузки файлов</div></li>';
  }

  await syncPreviewWithPlayerState();
}

/* Агрегированный список файлов по всем устройствам с запуском на выбранные устройства */
async function loadAllFilesAggregated() {
  const title = document.getElementById('filesPaneTitle');
  const meta = document.getElementById('filesPaneMeta');

  if (!currentDevice) {
    if (title) title.textContent = 'Все файлы';
    if (meta) meta.textContent = 'Выберите устройство слева';
    fileList.innerHTML = '<li class="item" style="text-align:center; padding:var(--space-xl)"><div class="meta">Выберите устройство слева</div></li>';
    return;
  }

  if (title) title.textContent = 'Все файлы';
  if (meta) meta.textContent = formatFilesMetaWithSelection('Загрузка...');

  try {
    const res = await speakerFetch(`/api/devices/all/files?limit=${ALL_FILES_LIMIT}&readyOnly=1`);
    if (!res.ok) {
      console.error('Не удалось загрузить все файлы:', res.status);
      fileList.innerHTML = '<li class="item" style="text-align:center; padding:var(--space-xl)"><div class="meta">Ошибка загрузки файлов</div></li>';
      if (meta) meta.textContent = formatFilesMetaWithSelection('0 файлов');
      return;
    }
    const data = await res.json();
    const items = data.items || [];

    // КРИТИЧНО: Дополнительная фильтрация плейсхолдеров на фронте
    const filteredItems = items.filter(item => {
      const name = item.safeName || '';
      const ct = (item.contentType || '').toLowerCase();
      const isTemp = name.startsWith('.optimizing_') || name.startsWith('.placeholder') || name === 'placeholder.mp4';
      const isPlaceholderType = ct === 'placeholder';
      return !isTemp && !isPlaceholderType;
    });

    allFiles = filteredItems.map((item) => {
      const video = item.video || {};
      return {
        safeName: item.safeName || item.originalName,
        // КРИТИЧНО: Не используем safeName как fallback
        // Если originalName нет, оставляем null, чтобы resolveFileDisplayData мог найти его из других источников
        originalName: item.originalName || null,
        resolution: video.width && video.height ? { width: video.width, height: video.height } : null,
        durationSeconds: typeof video.duration === 'number' ? video.duration : null,
        folderImageCount: item.pagesCount || null,
        contentType: item.contentType || null,
        streamUrl: item.streamUrl || null,
        streamProxyUrl: null,
        streamProtocol: item.streamProtocol || null,
        hasTrailer: false,
        trailerUrl: null,
        sourceDeviceId: item.deviceId,
        sourceDeviceName: getDeviceDisplayName(item.deviceId)
      };
    });

    // КРИТИЧНО: Сохраняем копию в кэш для поиска файлов после переключения режимов
    allFilesCache = [...allFiles];

    if (!allFiles.length) {
      fileList.innerHTML = `
        <li class="item" style="text-align:center; padding:var(--space-xl)">
          <div class="meta">Нет файлов</div>
        </li>
      `;
      const pager = document.getElementById('filePager');
      if (pager) pager.innerHTML = '';
      if (meta) meta.textContent = formatFilesMetaWithSelection('0 файлов');
      return;
    }

    const totalFilesCount = data.total || allFiles.length;
    if (meta) {
      const filesText = `${totalFilesCount} файл${totalFilesCount === 1 ? '' : totalFilesCount > 1 && totalFilesCount < 5 ? 'а' : 'ов'} · все устройства`;
      meta.textContent = formatFilesMetaWithSelection(filesText);
    }

    const pageSize = getMobilePageSize('file');
    const totalPages = Math.max(1, Math.ceil(allFiles.length / pageSize));
    if (filePage >= totalPages) filePage = totalPages - 1;
    const start = filePage * pageSize;
    const end = Math.min(start + pageSize, allFiles.length);
    const files = allFiles.slice(start, end);

    fileList.innerHTML = files.map(({ safeName, originalName, resolution, durationSeconds, folderImageCount, contentType, streamProtocol, sourceDeviceName, sourceDeviceId }) => {
      // КРИТИЧНО: Используем resolveFileDisplayData для получения правильного оригинального имени
      // Это гарантирует, что будет использовано оригинальное имя из всех доступных источников
      const { displayName: resolvedDisplayName } = resolveFileDisplayData(sourceDeviceId, safeName);
      // КРИТИЧНО: НЕ используем safeName как fallback - только resolvedDisplayName или originalName
      const effectiveOriginalName = resolvedDisplayName || originalName;
      
      let type = 'VID';
      let typeLabel = 'Видео';
      const normalizedType = resolveContentType({
        contentType,
        fileName: safeName,
        originalName,
        fallbackToFolder: true
      });
      // КРИТИЧНО: сначала используем contentType из БД/бэкенда, затем fallback по расширению
      if (normalizedType === 'streaming') {
        type = 'STREAM';
        typeLabel = streamProtocol ? `Стрим (${(streamProtocol || '').toUpperCase()})` : 'Стрим';
      } else if (normalizedType && normalizedType !== 'unknown') {
        const typeInfo = getContentTypeInfo(normalizedType, streamProtocol);
        type = typeInfo.shortLabel;
        typeLabel = typeInfo.label;
      }

      let resolutionLabel = '';
      if (type === 'VID' && resolution) {
        const width = resolution.width || 0;
        const height = resolution.height || 0;
        if (width >= 3840 || height >= 2160) resolutionLabel = '4K';
        else if (width >= 1920 || height >= 1080) resolutionLabel = 'FHD';
        else if (width >= 1280 || height >= 720) resolutionLabel = 'HD';
        else if (width > 0) resolutionLabel = 'SD';
      }

      const active = currentFile === safeName && currentFileSourceDevice === sourceDeviceId;
      // КРИТИЧНО: Используем resolvedDisplayName (уже без расширения) или effectiveOriginalName
      // НЕ используем safeName как fallback - только если resolvedDisplayName и effectiveOriginalName отсутствуют
      const displayName = resolvedDisplayName || (effectiveOriginalName ? effectiveOriginalName.replace(/\.[^.]+$/, '') : '');

      const metaBadges = [];
      if (type === 'FOLDER' && typeof folderImageCount === 'number' && folderImageCount > 0) metaBadges.push(`${folderImageCount} фото`);
      if (type === 'VID' && typeof durationSeconds === 'number' && durationSeconds > 0) metaBadges.push(formatTime(durationSeconds));
      if (type === 'STREAM') metaBadges.push(streamProtocol ? streamProtocol.toUpperCase() : 'онлайн');
      const typeBadgeLabel = metaBadges.length ? `${typeLabel} · ${metaBadges.join(' · ')}` : typeLabel;

      return `
        <li class="file-item ${active ? 'active' : ''}" 
            data-safe="${encodeURIComponent(safeName)}" 
            data-original="${encodeURIComponent(originalName)}"
            data-content-type="${contentType || ''}"
            data-stream-protocol="${streamProtocol || ''}"
            data-source-device="${encodeURIComponent(sourceDeviceId || '')}"
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
              min-height:78px;
            ">
          
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
              <span class="device-badge" style="
                display:inline-block;
                padding:2px 6px;
                border:1px solid rgba(255,255,255,0.15);
                border-radius:3px;
                font-size:0.75rem;
                font-weight:500;
                color:var(--text);
                background:rgba(255,255,255,0.08);
                white-space:nowrap;
                line-height:1.2;
              ">${sourceDeviceName || sourceDeviceId}</span>
            </div>
          </div>
          
          <div class="playBtn" 
               data-safe="${encodeURIComponent(safeName)}" 
               data-original="${encodeURIComponent(originalName)}"
               data-stream-protocol="${streamProtocol || ''}"
               data-source-device="${encodeURIComponent(sourceDeviceId || '')}"
               style="
                 display:flex; 
                 align-items:center; 
                 justify-content:center; 
                 font-size:2rem;
                 background:var(--brand);
                 color:white;
                 transition:background 0.2s;
                 min-height:100%;
                 min-width:72px;
                 cursor:pointer;
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

    // Клик по карточке: просто выделить, без превью
    fileList.querySelectorAll('.file-item').forEach(item => {
      item.onclick = (e) => {
        if (e.target.closest('.playBtn')) return;
        const safeName = decodeURIComponent(item.getAttribute('data-safe'));
        const sourceDeviceId = decodeURIComponent(item.getAttribute('data-source-device') || '') || null;
        const contentType = item.getAttribute('data-content-type') || null;
        const streamProtocol = item.getAttribute('data-stream-protocol') || '';
        const originalName = decodeURIComponent(item.getAttribute('data-original'));
        const normalizedType = resolveContentType({
          contentType,
          fileName: safeName,
          originalName,
          fallbackToFolder: true
        });

        setCurrentFileSelection(safeName, item, sourceDeviceId);
        previewManuallyClosed = false;

        // Стримы — превью через stream preview
        if (normalizedType === 'streaming') {
          showStreamingPreview(sourceDeviceId, safeName, streamProtocol);
          return;
        }

        // Папки / PDF / PPTX — статический превью (учитываем contentType)
        if (STATIC_CONTENT_TYPES.has(normalizedType)) {
          showStaticPreview(sourceDeviceId, safeName, normalizedType || 'folder', { initiatedByUser: true });
          return;
        }

        // Видео / изображения — превью через iframe плеера
        const iframeSrcBase = `/player-videojs.html?device_id=${encodeURIComponent(sourceDeviceId || '')}&preview=1&muted=1&file=${encodeURIComponent(safeName)}`;
        const src = `${iframeSrcBase}&t=${Date.now()}`;
        const frame = filePreview.querySelector('iframe');
        if (frame) {
          frame.src = src;
        } else {
          filePreview.innerHTML = `<iframe src="${src}" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen"></iframe>`;
        }
        setTimeout(() => updatePreviewControlButtons(), 10);
      };
    });

    fileList.querySelectorAll('.playBtn').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const safeName = decodeURIComponent(btn.getAttribute('data-safe'));
        const contentType = (btn.closest('.file-item')?.getAttribute('data-content-type')) || null;
        const streamProtocol = btn.getAttribute('data-stream-protocol') || '';
        const sourceDeviceId = decodeURIComponent(btn.getAttribute('data-source-device') || '') || null;
        const row = btn.closest('.file-item');
        await handlePlayAggregated({ sourceDeviceId, safeName, contentType, streamProtocol, rowEl: row });
      };
    });

  } catch (error) {
    console.error('Не удалось отобразить все файлы:', error);
    fileList.innerHTML = '<li class="item" style="text-align:center; padding:var(--space-xl)"><div class="meta">Ошибка загрузки файлов</div></li>';
  }
}

async function handlePlayAggregated({ sourceDeviceId, safeName, contentType, streamProtocol, rowEl }) {
  if (!sourceDeviceId) {
    await reportSpeakerNotification({
      type: 'speaker_play_missing_source',
      severity: 'info',
      title: 'Не указан источник файла',
      message: 'Не удалось определить устройство-источник для запуска',
      details: {
        safeName
      }
    });
    return;
  }

  const selectedTargets = getSelectedDeviceIds();
  const targetDeviceIds = selectedTargets.length
    ? selectedTargets
    : (currentDevice ? [currentDevice] : [sourceDeviceId]);
  const readyTargetDeviceIds = targetDeviceIds.filter((deviceId) => isDeviceReady(deviceId));

  if (!readyTargetDeviceIds.length) {
    await reportSpeakerNotification({
      type: 'speaker_no_ready_devices',
      severity: 'info',
      title: 'Нет онлайн-устройств',
      message: 'Нет онлайн-устройств для запуска выбранного файла',
      details: {
        sourceDeviceId,
        safeName,
        selectedTargets: targetDeviceIds
      }
    });
    return;
  }

  setCurrentFileSelection(safeName, rowEl, sourceDeviceId);
  previewManuallyClosed = false;

  // Определяем тип файла (приоритет contentType из БД)
  const normalizedType = resolveContentType({
    contentType,
    fileName: safeName,
    fallbackToFolder: true
  });

  const useBatchSync = readyTargetDeviceIds.length > 1;
  const emitPlayCommand = (payload = {}) => {
    if (useBatchSync) {
      socket.emit('control/play-batch', {
        device_ids: readyTargetDeviceIds,
        ...payload,
        startDelayMs: 1800
      });
      return;
    }

    socket.emit('control/play', {
      device_id: readyTargetDeviceIds[0],
      ...payload
    });
  };

  // Для нескольких выбранных устройств запускаем отправку максимально близко по времени
  readyTargetDeviceIds.forEach((deviceId) => {
    stopFolderPlaylistIfNeeded('manual play button', { deviceId, file: safeName });
    sendVolumeBeforePlay(deviceId);
  });

  // Стримы
  if (normalizedType === 'streaming') {
    emitPlayCommand({
      file: safeName,
      type: 'streaming',
      streamProtocol: streamProtocol || undefined,
      originDeviceId: sourceDeviceId // КРИТИЧНО: Указываем устройство-источник для поиска стрима
    });
    return;
  }

  // Статический контент (папка/PDF/PPTX) — показываем превью как локальный клик
  const isStaticContent = STATIC_CONTENT_TYPES.has(normalizedType);
  if (isStaticContent) {
    const previewDeviceId = sourceDeviceId || readyTargetDeviceIds[0];
    const previewContentType = normalizedType || 'folder';

    const loadPreview = async () => {
      await showStaticPreview(previewDeviceId, safeName, previewContentType, { initiatedByUser: true });
    };
    if ('requestIdleCallback' in window) {
      requestIdleCallback(loadPreview, { timeout: 100 });
    } else {
      setTimeout(loadPreview, 0);
    }

    emitPlayCommand({
      file: safeName,
      type: normalizedType || previewContentType || 'folder',
      page: 1,
      originDeviceId: sourceDeviceId
    });
    return;
  }

  // Одиночные изображения
  if (normalizedType === 'image') {
    emitPlayCommand({
      file: safeName,
      type: 'image',
      page: 1,
      originDeviceId: sourceDeviceId
    });
    return;
  }

  // Видео по умолчанию (без копирования)
  emitPlayCommand({
    file: safeName,
    type: normalizedType || 'video',
    streamProtocol: undefined,
    originDeviceId: sourceDeviceId
  });
}

/* Установка выбранного файла и подсветка строки */
function setCurrentFileSelection(filename, itemEl, sourceDeviceId = null) {
  currentFile = filename;
  currentFileSourceDevice = sourceDeviceId || currentDevice || null;
  // Убираем активное состояние у всех элементов
  fileList.querySelectorAll('.file-item').forEach(li => {
    li.classList.remove('active');
  });
  
  // Добавляем активное состояние выбранному элементу
  if (itemEl) {
    itemEl.classList.add('active');
  }
}

// formatTime импортируется из './shared/formatters.js'

function cacheDeviceFileMeta(deviceId, files = [], { merge = false } = {}) {
  if (!deviceId) return;
  const map = merge && fileMetaCache.has(deviceId)
    ? new Map(fileMetaCache.get(deviceId))
    : new Map();

  files.forEach(file => {
    if (!file) return;
    const safeName = file.safeName || file.name || file.fileName;
    // КРИТИЧНО: Не используем safeName как fallback для originalName
    // Если originalName нет, оставляем null, чтобы resolveFileDisplayData мог найти его из других источников
    const originalName = file.originalName || file.displayName || (file.name && file.name !== safeName ? file.name : null) || null;
    if (!safeName && !originalName) return;

    // КРИТИЧНО: displayName должен быть ТОЛЬКО из originalName, без fallback на safeName
    // Если originalName нет, не кэшируем displayName, чтобы resolveFileDisplayData мог найти его из device.fileMetadata или device.fileNames
    const displayName = originalName ? (originalName.replace(/\.[^.]+$/, '') || originalName) : null;
    const folderImageCount = typeof file.folderImageCount === 'number' ? file.folderImageCount : null;
    const contentType = file.contentType || null;
    const streamUrl = file.streamUrl || null;
    const streamProxyUrl = file.streamProxyUrl || null;
    const streamProtocol = file.streamProtocol || null;
    const meta = { displayName, folderImageCount, contentType, streamUrl, streamProxyUrl, streamProtocol };

    const keys = new Set();
    [safeName, originalName].forEach(name => {
      normalizeFileNameVariants(name).forEach(v => keys.add(v));
    });

    keys.forEach(key => {
      if (!key) return;
      if (merge && map.has(key) && map.get(key)?.folderImageCount) {
        return;
      }
      map.set(key, meta);
    });
  });

  fileMetaCache.set(deviceId, map);
}

function resolveCachedFileMeta(deviceId, fileName) {
  if (!deviceId || !fileName) return null;
  const map = fileMetaCache.get(deviceId);
  if (!map || map.size === 0) return null;
  const candidates = normalizeFileNameVariants(fileName);
  for (const key of candidates) {
    if (map.has(key)) {
      return map.get(key);
    }
  }
  return null;
}

function normalizeFileNameVariants(name) {
  if (!name) return [];
  const trimmed = name.trim();
  if (!trimmed) return [];
  const variants = [trimmed.toLowerCase()];
  const withoutExt = trimmed.replace(/\.[^.]+$/, '');
  if (withoutExt && withoutExt !== trimmed) {
    variants.push(withoutExt.toLowerCase());
  }
  return variants;
}

function findFileInfoForDevice(deviceId, fileName) {
  if (!fileName) return null;
  
  // Шаг 1: Проверяем allFilesCache (файлы из "Все файлы" - сохраняются при переключении режимов)
  if (allFilesCache && allFilesCache.length > 0) {
    const targetVariants = normalizeFileNameVariants(fileName);
    if (targetVariants.length) {
      // Сначала ищем с проверкой sourceDeviceId (если deviceId указан)
      let found = null;
      if (deviceId) {
        found = allFilesCache.find(f => {
          if (f.sourceDeviceId !== deviceId) {
            return false;
          }
          const variants = [
            ...normalizeFileNameVariants(f.safeName),
            ...normalizeFileNameVariants(f.originalName),
          ];
          if (!variants.length) return false;
          return variants.some(value => targetVariants.includes(value));
        });
      }
      
      // Если не найдено с проверкой sourceDeviceId, ищем без проверки (для совместимости)
      if (!found) {
        found = allFilesCache.find(f => {
          const variants = [
            ...normalizeFileNameVariants(f.safeName),
            ...normalizeFileNameVariants(f.originalName),
          ];
          if (!variants.length) return false;
          return variants.some(value => targetVariants.includes(value));
        });
      }
      
      if (found) return found;
    }
  }
  
  // Шаг 2: Проверяем allFiles (текущий список файлов)
  if (allFiles && allFiles.length > 0) {
    const targetVariants = normalizeFileNameVariants(fileName);
    if (targetVariants.length) {
      const found = allFiles.find(f => {
        // Если deviceId указан и не совпадает с currentDevice, проверяем sourceDeviceId
        if (deviceId && deviceId !== currentDevice && f.sourceDeviceId !== deviceId) {
          return false;
        }
        const variants = [
          ...normalizeFileNameVariants(f.safeName),
          ...normalizeFileNameVariants(f.originalName),
        ];
        if (!variants.length) return false;
        return variants.some(value => targetVariants.includes(value));
      });
      if (found) return found;
    }
  }
  
  // Если не найдено в allFilesCache и allFiles - возвращаем null
  // resolveFileDisplayData будет использовать другие источники (device.fileMetadata, device.fileNames)
  return null;
}

function resolveFileDisplayData(deviceId, fileName) {
  if (!deviceId || !fileName) {
    return { displayName: fileName || '', fileInfo: null, folderImageCount: null, contentType: null, streamUrl: null, streamProxyUrl: null, streamProtocol: null };
  }
  
  const device = devices.find(d => d.device_id === deviceId);
  
  // Приоритет получения originalName для отображения:
  // 1. fileInfo.originalName (из allFiles для currentDevice)
  // 2. cachedMeta.displayName (из кэша fileMetaCache, заполняется через prefillDeviceFileMeta)
  // 3. device.fileMetadata[].originalName (из метаданных устройства с сервера)
  // 4. device.fileNames[] (по индексу safeName в device.files)
  // 5. fileName (fallback, только если ничего не найдено)
  
  // Шаг 1: Проверяем allFiles и allFilesCache
  // КРИТИЧНО: Для файлов из "Все файлы" с originDeviceId, ищем в allFilesCache по sourceDeviceId
  let baseInfo = null;
  if (device?.current?.originDeviceId) {
    // Файл из "Все файлы" - ищем в allFilesCache по originDeviceId
    baseInfo = findFileInfoForDevice(device.current.originDeviceId, fileName);
  }
  // Если не найдено, ищем по переданному deviceId
  if (!baseInfo) {
    baseInfo = findFileInfoForDevice(deviceId, fileName);
  }
  
  const currentMatches = device?.current && (device.current.file === fileName || device.current.playlistFile === fileName);
  const fileInfo = currentMatches && device.current.folderImageCount
    ? { ...baseInfo, folderImageCount: device.current.folderImageCount }
    : baseInfo;
    
  let displayName = null;
  let folderImageCount = fileInfo?.folderImageCount ?? null;
  let contentType = fileInfo?.contentType || null;
  let streamUrl = fileInfo?.streamUrl || null;
  let streamProxyUrl = fileInfo?.streamProxyUrl || null;
  let streamProtocol = fileInfo?.streamProtocol || null;
  let cachedMeta = null;
  
  if (fileInfo && fileInfo.originalName) {
    // Нашли в allFiles
    displayName = fileInfo.originalName.replace(/\.[^.]+$/, '') || fileInfo.originalName;
  } else if (device) {
    // КРИТИЧНО: Если файл из "Все файлы" с originDeviceId, но originalName не найден в allFilesCache,
    // ищем оригинальное имя в device.fileMetadata и device.fileNames устройства-источника
    let searchDevice = device;
    if (device.current?.originDeviceId && device.current.originDeviceId !== deviceId) {
      const sourceDevice = devices.find(d => d.device_id === device.current.originDeviceId);
      if (sourceDevice) {
        searchDevice = sourceDevice;
      }
    }
    
    // Шаг 2: Проверяем device.fileMetadata (метаданные с сервера) - самый надежный источник
    const targetVariants = normalizeFileNameVariants(fileName);
    let metaFromDevice = null;
    if (searchDevice.fileMetadata && Array.isArray(searchDevice.fileMetadata) && targetVariants.length > 0) {
      metaFromDevice = searchDevice.fileMetadata.find(m => {
        if (!m || !m.safeName) return false;
        const metaVariants = normalizeFileNameVariants(m.safeName);
        return metaVariants.some(v => targetVariants.includes(v));
      });
    }
    
    if (metaFromDevice?.originalName) {
      displayName = metaFromDevice.originalName.replace(/\.[^.]+$/, '') || metaFromDevice.originalName;
      if (folderImageCount == null) folderImageCount = metaFromDevice.folderImageCount ?? null;
      if (!contentType) contentType = metaFromDevice.contentType || null;
    } else {
      // Шаг 3: Проверяем кэш fileMetaCache (заполняется через prefillDeviceFileMeta при загрузке устройств)
      // КРИТИЧНО: Для файлов из "Все файлы" проверяем кэш устройства-источника
      const cacheDeviceId = searchDevice.device_id || deviceId;
      cachedMeta = resolveCachedFileMeta(cacheDeviceId, fileName);
      // КРИТИЧНО: Используем displayName из кэша только если он есть и не равен safeName
      // Если displayName отсутствует или равен safeName, продолжаем поиск в device.fileNames
      const fileNameWithoutExt = (fileName || '').replace(/\.[^.]+$/, '') || fileName || '';
      if (cachedMeta?.displayName && cachedMeta.displayName !== fileNameWithoutExt) {
        displayName = cachedMeta.displayName;
        if (folderImageCount == null) folderImageCount = cachedMeta.folderImageCount ?? null;
        if (!contentType) contentType = cachedMeta.contentType || null;
        if (!streamUrl) streamUrl = cachedMeta.streamUrl || null;
        if (!streamProxyUrl) streamProxyUrl = cachedMeta.streamProxyUrl || null;
        if (!streamProtocol) streamProtocol = cachedMeta.streamProtocol || null;
      } else {
        // Шаг 4: Проверяем device.fileNames по индексу
        // КРИТИЧНО: Используем searchDevice (устройство-источник для файлов из "Все файлы")
        const files = searchDevice.files || [];
        // КРИТИЧНО: fileNames может быть равен files (безопасные имена), если оригинальные имена не загружены
        // В этом случае нужно проверить, что fileNames !== files, иначе это безопасные имена
        const fileNames = searchDevice.fileNames;
        const fileNamesIsOriginal = fileNames && fileNames !== files && Array.isArray(fileNames);
        
        let fileIndex = -1;
        if (targetVariants.length > 0 && files.length > 0) {
          fileIndex = files.findIndex(f => {
            const fileVariants = normalizeFileNameVariants(f);
            return fileVariants.some(v => targetVariants.includes(v));
          });
        }
        
        if (fileIndex >= 0 && fileNamesIsOriginal && fileIndex < fileNames.length && fileNames[fileIndex]) {
          // КРИТИЧНО: Используем fileNames[fileIndex] только если fileNames содержит оригинальные имена
          // и fileNames[fileIndex] отличается от files[fileIndex] (safeName)
          const safeNameAtIndex = files[fileIndex];
          const originalNameFromFileNames = fileNames[fileIndex];
          // Используем оригинальное имя только если оно отличается от безопасного
          if (originalNameFromFileNames !== safeNameAtIndex) {
            displayName = originalNameFromFileNames.replace(/\.[^.]+$/, '') || originalNameFromFileNames;
          } else {
            // Если fileNames[fileIndex] === files[fileIndex], значит fileNames содержит безопасные имена
            // В этом случае не используем его, и переходим к следующему источнику
            // Но это не должно происходить, если fileNamesIsOriginal === true
            // Fallback на fileName (который является safeName) - это последний вариант
            displayName = (fileName || '').replace(/\.[^.]+$/, '') || (fileName || '');
          }
        } else {
          // Шаг 5: Fallback - используем fileName (который является safeName)
          // Это происходит только если:
          // 1. fileIndex < 0 (файл не найден в device.files)
          // 2. fileNames не содержит оригинальные имена (fileNamesIsOriginal === false)
          // 3. fileNames[fileIndex] отсутствует или равен safeName
          // В этом случае используем fileName (safeName) как последний fallback
          displayName = (fileName || '').replace(/\.[^.]+$/, '') || (fileName || '');
        }
      }
    }
  } else {
    // Устройство не найдено - проверяем кэш как последний шанс, затем fallback
    cachedMeta = resolveCachedFileMeta(deviceId, fileName);
    if (cachedMeta?.displayName) {
      displayName = cachedMeta.displayName;
      if (folderImageCount == null) folderImageCount = cachedMeta.folderImageCount ?? null;
      if (!contentType) contentType = cachedMeta.contentType || null;
      if (!streamUrl) streamUrl = cachedMeta.streamUrl || null;
      if (!streamProxyUrl) streamProxyUrl = cachedMeta.streamProxyUrl || null;
      if (!streamProtocol) streamProtocol = cachedMeta.streamProtocol || null;
    } else {
      displayName = (fileName || '').replace(/\.[^.]+$/, '') || (fileName || '');
    }
  }
  
  // Дополнительно обновляем данные из cachedMeta если они есть и не были заполнены ранее
  // (для случаев, когда displayName был найден из других источников, но метаданные отсутствуют)
  if (!cachedMeta && (folderImageCount == null || !contentType || !streamUrl || !streamProxyUrl || !streamProtocol)) {
    cachedMeta = resolveCachedFileMeta(deviceId, fileName);
    if (cachedMeta) {
      if (folderImageCount == null) folderImageCount = cachedMeta.folderImageCount ?? null;
      if (!contentType) contentType = cachedMeta.contentType || null;
      if (!streamUrl) streamUrl = cachedMeta.streamUrl || null;
      if (!streamProxyUrl) streamProxyUrl = cachedMeta.streamProxyUrl || null;
      if (!streamProtocol) streamProtocol = cachedMeta.streamProtocol || null;
    }
  }

  return { displayName, fileInfo, folderImageCount, contentType, streamUrl, streamProxyUrl, streamProtocol };
}

function formatStaticPlaybackLabel(type, page, totalCount, isPlaylist) {
  const descriptor = type === 'folder' ? 'Кадр' : type === 'pptx' ? 'Слайд' : 'Страница';
  if (type === 'streaming') {
    return 'Стрим (онлайн)';
  }
  let label = `${descriptor} ${page}`;
  if (totalCount && Number(totalCount) > 0) {
    label += ` из ${totalCount}`;
  }
  if (type === 'folder' && isPlaylist) {
    label += ' | Плейлист';
  }
  return label;
}

function prefillDeviceFileMeta(device) {
  if (!device || !device.device_id) return;
  const files = device.files || [];
  const fileNames = device.fileNames || files;
  const fileMetadataList = Array.isArray(device.fileMetadata) ? device.fileMetadata : [];
  if (!files.length && (!fileNames || !fileNames.length)) return;

  const metaBySafe = new Map(
    fileMetadataList
      .filter(meta => meta && meta.safeName)
      .map(meta => [meta.safeName, meta])
  );

  const items = files.map((safeName, idx) => {
    const meta = metaBySafe.get(safeName);
    // КРИТИЧНО: Приоритет originalName:
    // 1. meta?.originalName (из device.fileMetadata с сервера - самый надежный источник)
    // 2. fileNames[idx] (из device.fileNames - маппинг имен), но только если он отличается от safeName
    // НЕ используем safeName как fallback - если originalName нет, оставляем null
    // чтобы resolveFileDisplayData мог найти его из device.fileNames напрямую
    const fileNamesValue = fileNames[idx];
    const originalName = meta?.originalName || (fileNamesValue && fileNamesValue !== safeName ? fileNamesValue : null) || null;
    return {
      safeName,
      originalName: originalName,
      folderImageCount: meta?.folderImageCount ?? null,
      contentType: meta?.contentType || null,
      streamUrl: meta?.streamUrl || null,
      streamProxyUrl: meta?.streamProxyUrl || null,
      streamProtocol: meta?.streamProtocol || null
    };
  });

  cacheDeviceFileMeta(device.device_id, items, { merge: true });
}

function ensureStaticContentMeta(deviceId, fileName, { force = false } = {}) {
  if (!deviceId || !fileName) return;
  const key = `${deviceId}:${fileName}`;
  if (!force && staticMetaRequests.has(key)) {
    return staticMetaRequests.get(key);
  }
  const request = (async () => {
    try {
      const res = await speakerFetch(`/api/devices/${encodeURIComponent(deviceId)}/slides-count?file=${encodeURIComponent(fileName)}`);
      if (!res.ok) return;
      const data = await res.json();
      const count = Number(data.count) || 0;
      if (count > 0) {
        cacheDeviceFileMeta(deviceId, [{
          safeName: fileName,
          originalName: fileName,
          folderImageCount: count,
        }], { merge: true });
        // Обновляем текущее состояние устройства, если оно воспроизводит этот файл
        const targetDevice = devices.find(d => d.device_id === deviceId);
        if (targetDevice && targetDevice.current && (targetDevice.current.file === fileName || targetDevice.current.playlistFile === fileName)) {
          targetDevice.current.folderImageCount = count;
        }
        refreshTvTilePlaybackInfo(deviceId);
        if (deviceId === currentDevice) {
          updatePlaybackInfoUI();
        }
      }
    } catch (err) {
      console.warn('[Speaker] Не удалось получить количество кадров', deviceId, fileName, err?.message);
    } finally {
      staticMetaRequests.delete(key);
    }
  })();
  staticMetaRequests.set(key, request);
  return request;
}

function getPlaybackInfoInnerHtml(playbackInfo) {
  if (!playbackInfo) {
    return '';
  }
  // Определяем цвет meta-value в зависимости от источника duration
  const durationFromDatabase = playbackInfo.progress?.durationFromDatabase || false;
  const metaValueClass = durationFromDatabase ? 'meta-value-db' : 'meta-value-player';
  return `
    <span class="tvTile-previewTitle">${playbackInfo.title}</span>
    <span class="tvTile-previewValue ${metaValueClass}">${playbackInfo.value}</span>
  `;
}

function buildPreviewPlaybackInfo(device) {
  if (!device || !device.current) {
    return null;
  }

  // КРИТИЧНО: Для idle/placeholder - не показываем статус вообще
  // Статусы должны браться ТОЛЬКО с плеера, а при idle/placeholder плеер не показывает статус
  if (device.current.type === 'idle' || device.current.type === 'placeholder') {
    return null;
  }

  // КРИТИЧНО: Определяем устройство-источник файла
  // Если файл запущен из "Все файлы", originDeviceId указывает на устройство-источник
  // Если файл запущен с текущего устройства, используем device.device_id
  let sourceDeviceId = device.current.originDeviceId || device.device_id;
  
  // КРИТИЧНО: Если originDeviceId установлен, файл точно из "Все файлы" - ищем в allFilesCache
  if (device.current.originDeviceId && allFilesCache && allFilesCache.length > 0) {
    const currentFileName = device.current.file || device.current.playlistFile || '';
    const fileInfo = allFilesCache.find(f => {
      if (!currentFileName) return false;
      // Точный поиск: sourceDeviceId должен совпадать с originDeviceId
      if (f.sourceDeviceId !== device.current.originDeviceId) return false;
      const variants = [
        ...normalizeFileNameVariants(f.safeName),
        ...normalizeFileNameVariants(f.originalName)
      ];
      const targetVariants = normalizeFileNameVariants(currentFileName);
      if (!targetVariants.length) return false;
      return variants.some(v => targetVariants.includes(v));
    });
    if (fileInfo && fileInfo.sourceDeviceId) {
      sourceDeviceId = fileInfo.sourceDeviceId;
    }
  } else if (!device.current.originDeviceId && allFiles && allFiles.length > 0) {
    // Fallback: если originDeviceId не установлен, ищем в текущем allFiles
    const currentFileName = device.current.file || device.current.playlistFile || '';
    const fileInfo = allFiles.find(f => {
      if (!currentFileName) return false;
      const variants = [
        ...normalizeFileNameVariants(f.safeName),
        ...normalizeFileNameVariants(f.originalName)
      ];
      const targetVariants = normalizeFileNameVariants(currentFileName);
      if (!targetVariants.length) return false;
      return variants.some(v => targetVariants.includes(v));
    });
    if (fileInfo && fileInfo.sourceDeviceId) {
      sourceDeviceId = fileInfo.sourceDeviceId;
    }
  }

  if (device.current.type === 'streaming') {
    const { displayName } = resolveFileDisplayData(sourceDeviceId, device.current.file);
    const protocolLabel = device.current.streamProtocol ? device.current.streamProtocol.toUpperCase() : 'онлайн';
    const safeName = escapeHtml(truncateText(displayName, 50)) || 'Стрим';
    const playbackInfo = {
      title: safeName,
      value: `Стрим (${protocolLabel})`,
      mode: 'streaming',
      progress: null
    };
    // Убрано избыточное логирование - функция вызывается слишком часто при обновлении UI
    return playbackInfo;
  }

  if (STATIC_CONTENT_TYPES.has(device.current.type)) {
    const staticFile = device.current.playlistFile || device.current.file;
    const currentPage = Number(device.current.page) || 1;
    const { displayName, fileInfo, folderImageCount: cachedFolderCount } = resolveFileDisplayData(sourceDeviceId, staticFile);
    let folderImageCount = cachedFolderCount || 0;

    if (folderImageCount === 0) {
      ensureStaticContentMeta(device.device_id, staticFile);
      if (device.current.folderImageCount) {
        folderImageCount = Number(device.current.folderImageCount) || 0;
      }
    }
    const safeName = escapeHtml(truncateText(displayName, 50)) || '—';
    const pageInfo = formatStaticPlaybackLabel(
      device.current.type,
      currentPage,
      folderImageCount,
      device.current.playlistActive
    );
    return {
      title: safeName,
      value: escapeHtml(pageInfo),
      mode: 'static',
      progress: null,
    };
  }

  // Для изображений - показываем информацию о воспроизведении
  if (device.current.type === 'image') {
    const { displayName, fileInfo } = resolveFileDisplayData(sourceDeviceId, device.current.file);
    if (fileInfo && fileInfo.isPlaceholder) {
      return null;
    }
    const safeName = escapeHtml(truncateText(displayName, 50)) || '—';
    return {
      title: safeName,
      value: 'Изображение',
      mode: 'image',
      progress: null
    };
  }

  // Показываем прогресс-бар для видео и аудио
  if (device.current.type === 'video' || device.current.type === 'audio') {
    // Для видео и аудио статусы должны браться ТОЛЬКО из playbackProgressByDevice (данные от плеера)
    const prog = playbackProgressByDevice.get(device.device_id);
    if (!prog || !prog.file || prog.file !== device.current.file) {
      return null;
    }
    const { displayName, fileInfo } = resolveFileDisplayData(sourceDeviceId, prog.file);
    if (fileInfo && fileInfo.isPlaceholder) {
      return null;
    }
    const safeName = escapeHtml(truncateText(displayName, 50)) || '—';
    const currentTimeLabel = formatTime(prog.currentTime);
    const durationFromPlayer = (prog.duration && prog.duration > 0) ? prog.duration : null;
    let durationSecondsFromDB = fileInfo?.durationSeconds;
    if (!durationSecondsFromDB && device) {
      const metaFromDevice = device.fileMetadata?.find(m => {
        const variants = [
          ...normalizeFileNameVariants(m.safeName || ''),
          ...normalizeFileNameVariants(m.originalName || '')
        ];
        const targetVariants = normalizeFileNameVariants(prog.file);
        return variants.some(v => targetVariants.includes(v));
      });
      durationSecondsFromDB = metaFromDevice?.durationSeconds;
      if (!durationSecondsFromDB && device.device_id === currentDevice && allFiles) {
        const fileInAllFiles = allFiles.find(f => {
          const variants = [
            ...normalizeFileNameVariants(f.safeName || ''),
            ...normalizeFileNameVariants(f.originalName || '')
          ];
          const targetVariants = normalizeFileNameVariants(prog.file);
          return variants.some(v => targetVariants.includes(v));
        });
        durationSecondsFromDB = fileInAllFiles?.durationSeconds;
      }
    }
    const durationFromDatabase = (!durationFromPlayer && durationSecondsFromDB && durationSecondsFromDB > 0) 
      ? durationSecondsFromDB 
      : null;
    const duration = durationFromPlayer || durationFromDatabase;
    const isDurationFromDatabase = !!durationFromDatabase;
    // Если видео/аудио закончилось - не показываем информацию (проверяем общий duration)
    if (duration && duration > 0 && prog.currentTime >= duration - 0.5) {
      // Для аудио и видео: после окончания сбрасываем прогресс и инфо (заглушка)
      setTimeout(() => {
        if (playbackProgressByDevice.get(device.device_id)?.file === prog.file) {
          playbackProgressByDevice.delete(device.device_id);
          updatePlaybackInfoUI();
        }
      }, 500);
      return null;
    }
    const total = duration ? formatTime(duration) : '--:--';
    let progressPercent = null;
    if (duration && duration > 0) {
      progressPercent = Math.min(100, Math.max(0, (prog.currentTime / duration) * 100));
    }
    return {
      title: safeName,
      value: escapeHtml(`${currentTimeLabel} / ${total}`),
      mode: device.current.type, // 'video' or 'audio'
      progress: duration && duration > 0 ? {
        percent: progressPercent,
        duration: duration,
        currentTime: prog.currentTime,
        file: prog.file,
        durationKnownFromStart: prog.durationKnownFromStart || false,
        durationFromDatabase: isDurationFromDatabase
      } : null,
    };
  }
}

function updatePlaybackInfoUI() {
  const infoEl = document.getElementById('previewPlaybackInfo');
  const progressContainer = document.getElementById('videoProgressContainer');
  const progressBar = document.getElementById('videoProgressBar');

  if (!infoEl || !currentDevice) {
    if (infoEl) infoEl.innerHTML = '';
    if (progressContainer) progressContainer.style.display = 'none';
    updatePreviewControlButtons();
    return;
  }

  const device = devices.find(d => d.device_id === currentDevice);
  const playbackInfo = buildPreviewPlaybackInfo(device);

  if (!device || !device.current) {
    infoEl.innerHTML = '';
    if (progressContainer) progressContainer.style.display = 'none';
    updatePreviewControlButtons();
    return;
  }

  // КРИТИЧНО: Для стримов всегда показываем информацию, даже если buildPreviewPlaybackInfo вернул null
  if (device.current.type === 'streaming' && !playbackInfo) {
    const { displayName } = resolveFileDisplayData(device.device_id, device.current.file);
    const protocolLabel = device.current.streamProtocol ? device.current.streamProtocol.toUpperCase() : 'онлайн';
    const safeName = escapeHtml(truncateText(displayName, 50)) || 'Стрим';
    infoEl.innerHTML = `
      <div class="meta-line">
        <span class="meta-title">${safeName}</span>
        <span class="meta-value">Стрим (${protocolLabel})</span>
      </div>
    `;
    if (progressContainer) progressContainer.style.display = 'none';
    updatePreviewControlButtons();
    return;
  }

  if (!playbackInfo) {
    infoEl.innerHTML = '';
    if (progressContainer) progressContainer.style.display = 'none';
    updatePreviewControlButtons();
    return;
  }

  // Определяем цвет meta-value в зависимости от источника duration
  const durationFromDatabase = playbackInfo.progress?.durationFromDatabase || false;
  const metaValueClass = durationFromDatabase ? 'meta-value-db' : 'meta-value-player';
  

  infoEl.innerHTML = `
    <div class="meta-line">
      <span class="meta-title">${playbackInfo.title}</span>
      <span class="meta-value ${metaValueClass}">${playbackInfo.value}</span>
    </div>
  `;

  if (progressContainer && progressBar) {
    if (
      (playbackInfo.mode === 'video' || playbackInfo.mode === 'audio') &&
      playbackInfo.progress &&
      playbackInfo.progress.duration &&
      playbackInfo.progress.duration > 0
    ) {
      if (!isVideoSeeking) {
        progressBar.value = playbackInfo.progress.percent ?? 0;
      }
      progressBar.max = 100;
      progressBar.dataset.currentTime = playbackInfo.progress.currentTime;
      progressBar.dataset.duration = playbackInfo.progress.duration;
      progressBar.dataset.file = playbackInfo.progress.file;
      progressBar.dataset.durationFromDatabase = playbackInfo.progress.durationFromDatabase ? 'true' : 'false';
      progressBar.dataset.mediaType = playbackInfo.mode || '';
      const allowSeek = playbackInfo.mode === 'audio' || !playbackInfo.progress.durationFromDatabase;
      // Если duration из базы - отключаем перемотку для видео, но разрешаем для аудио
      if (!allowSeek) {
        progressBar.disabled = true;
        progressBar.style.cursor = 'not-allowed';
        progressBar.style.opacity = '0.6';
      } else {
        progressBar.disabled = false;
        progressBar.style.cursor = 'pointer';
        progressBar.style.opacity = '1';
      }
      progressContainer.style.display = 'block';
    } else {
      progressContainer.style.display = 'none';
    }
  }

  updatePreviewControlButtons();
  refreshTvTilePlaybackInfo(currentDevice);
  // Обновляем состояние кнопок с учетом информации о воспроизведении
  updateVolumeUI();
}

function refreshTvTilePlaybackInfo(deviceId) {
  if (!tvList || !deviceId) return;
  const index = devices.findIndex(d => d.device_id === deviceId);

  const actualTile = tvList.querySelector(`.tvTile[data-id="${deviceId}"]`);
  if (!actualTile) return;

  const volumeRow = actualTile.querySelector('.tvTile-volumeRow');
  if (!volumeRow) return;

  const device = devices.find(d => d.device_id === deviceId);
  if (!device || !device.current) {
    const infoEl = volumeRow.querySelector('.tvTile-previewInfo');
    if (infoEl) {
      infoEl.classList.add('is-empty');
      infoEl.innerHTML = '';
    }
    return;
  }

  const playbackInfo = buildPreviewPlaybackInfo(device);
  let infoEl = volumeRow.querySelector('.tvTile-previewInfo');
  const volumeEl = volumeRow.querySelector('.tvTile-volume');

  if (!infoEl) {
    infoEl = document.createElement('div');
    infoEl.className = 'tvTile-previewInfo is-empty';
    if (volumeEl) {
      volumeRow.insertBefore(infoEl, volumeEl);
    } else {
      volumeRow.appendChild(infoEl);
    }
  }

  // КРИТИЧНО: Для стримов всегда показываем информацию, даже если buildPreviewPlaybackInfo вернул null
  if (device.current.type === 'streaming' && !playbackInfo) {
    const { displayName } = resolveFileDisplayData(device.device_id, device.current.file);
    const protocolLabel = device.current.streamProtocol ? device.current.streamProtocol.toUpperCase() : 'онлайн';
    const safeName = escapeHtml(truncateText(displayName, 50)) || 'Стрим';
    infoEl.classList.remove('is-empty');
    infoEl.innerHTML = getPlaybackInfoInnerHtml({
      title: safeName,
      value: `Стрим (${protocolLabel})`,
      mode: 'streaming',
      progress: null
    });
    const indicator = actualTile.querySelector('.tvTile-status');
    if (indicator) {
      indicator.setAttribute('title', `Стрим (${protocolLabel})`);
      indicator.setAttribute('aria-label', `Стрим (${protocolLabel})`);
    }
    return;
  }

  if (!playbackInfo) {
    infoEl.classList.add('is-empty');
    infoEl.innerHTML = '';
    return;
  }

  infoEl.classList.remove('is-empty');
  infoEl.innerHTML = getPlaybackInfoInnerHtml(playbackInfo);
  const indicator = actualTile.querySelector('.tvTile-status');
  if (indicator) {
    indicator.setAttribute('title', playbackInfo.value);
    indicator.setAttribute('aria-label', playbackInfo.value.replace(/<[^>]+>/g, ''));
  }
}

// Прием прогресса от плееров
socket.on('player/progress', ({ device_id, type, file, currentTime, duration, page }) => {
  if (!device_id) return;
  
  // Для видео и аудио - сохраняем прогресс воспроизведения
  if ((type === 'video' || type === 'audio') && file) {
    const existingProg = playbackProgressByDevice.get(device_id);
    const numDuration = Number(duration) || 0;
    const numCurrentTime = Number(currentTime) || 0;
    
    // КРИТИЧНО: Определяем, был ли duration известен с самого начала
    let durationKnownFromStart = false;
    
    // Проверяем, тот же ли это файл
    if (existingProg && existingProg.file === file) {
      // Это продолжение того же файла - сохраняем флаг
      durationKnownFromStart = existingProg.durationKnownFromStart || false;
      
      // Если duration был 0 и стал > 0 - значит он стал известен позже
      if (existingProg.duration === 0 && numDuration > 0) {
        durationKnownFromStart = false;
      }
      
      // Если duration был > 0 с самого начала - устанавливаем флаг
      if (existingProg.duration > 0 && durationKnownFromStart === false) {
        // Проверяем, был ли это первый прогресс (currentTime близко к 0)
        if (numCurrentTime <= 2 && existingProg.currentTime <= 2) {
          durationKnownFromStart = true;
        }
      }
    } else {
      // Новый файл или файл изменился - сбрасываем старый прогресс
      if (existingProg && existingProg.file !== file) {
        playbackProgressByDevice.delete(device_id);
      }
      
      // Новый файл - проверяем, известен ли duration с самого начала
      // Если duration > 0 при currentTime близком к 0 - значит известен с начала
      durationKnownFromStart = (numDuration > 0 && numCurrentTime <= 2);
    }
    
    playbackProgressByDevice.set(device_id, { 
      file, 
      currentTime: numCurrentTime, 
      duration: numDuration,
      durationKnownFromStart
    });

    if (type === 'audio') {
      const device = devices.find(d => d.device_id === device_id);
      if (device) {
        if (!device.current) {
          device.current = { type: 'audio', file, page: 1, state: 'playing' };
        } else {
          device.current.type = 'audio';
          device.current.file = file;
          device.current.page = 1;
          device.current.state = device.current.state || 'playing';
        }
      }

      const state = playerStateByDevice.get(device_id) || {};
      state.type = 'audio';
      state.file = file;
      state.page = 1;
      playerStateByDevice.set(device_id, state);
    }
    
    refreshTvTilePlaybackInfo(device_id);
    if (device_id === currentDevice) {
      updatePlaybackInfoUI();
    }
    return;
  }
  
  // Для стримов - обновляем UI (стримы не имеют прогресса, но нужно показать информацию)
  if (type === 'streaming' && file) {
    refreshTvTilePlaybackInfo(device_id);
    if (device_id === currentDevice) {
      updatePlaybackInfoUI();
    }
    return;
  }
  
  // Для изображений - обновляем состояние устройства и выделение thumbnail (если изображение в папке)
  if (type === 'image' && file) {
    playbackProgressByDevice.delete(device_id);
    const device = devices.find(d => d.device_id === device_id);
    if (device) {
      if (!device.current) {
        device.current = { type: 'image', file, page: 1, state: 'playing' };
      } else {
        device.current.type = 'image';
        device.current.file = file;
        device.current.page = 1;
        device.current.state = 'playing';
      }
      
      // Обновляем состояние в playerStateByDevice для синхронизации превью
      const state = playerStateByDevice.get(device_id) || {};
      state.type = 'image';
      state.file = file;
      state.page = 1;
      playerStateByDevice.set(device_id, state);
      
      // Обновляем выделение текущего изображения на спикер панели
      if (device_id === currentDevice) {
        const thumbnails = filePreview.querySelectorAll('.thumbnail-preview');
        const deviceFile = device.current.file;
        // Нормализуем имена файлов (убираем .zip если есть)
        const normalizedDeviceFile = deviceFile.replace(/\.zip$/i, '');
        
        // Если есть thumbnails (превью папки открыто), ищем соответствующий thumbnail
        if (thumbnails.length > 0) {
          const currentPreviewFile = thumbnails[0].getAttribute('data-file');
          const normalizedPreviewFile = currentPreviewFile ? currentPreviewFile.replace(/\.zip$/i, '') : null;
          
          // Если это превью папки, ищем thumbnail с этим изображением
          if (normalizedPreviewFile && normalizedPreviewFile !== normalizedDeviceFile) {
            // Ищем thumbnail, который соответствует этому изображению
            let foundThumbnail = null;
            thumbnails.forEach(thumb => {
              const thumbFile = thumb.getAttribute('data-file');
              if (thumbFile && thumbFile.replace(/\.zip$/i, '') === normalizedDeviceFile) {
                foundThumbnail = thumb;
              }
            });
            
            if (foundThumbnail) {
              // Нашли thumbnail для этого изображения - активируем его
              const thumbPage = parseInt(foundThumbnail.getAttribute('data-page'), 10);
              if (thumbPage) {
                highlightCurrentThumbnail(thumbPage, { deviceId: device_id, file: normalizedPreviewFile });
              }
            }
          } else if (normalizedPreviewFile === normalizedDeviceFile) {
            // Превью этого изображения открыто напрямую (как папка с одним изображением)
            highlightCurrentThumbnail(1, { deviceId: device_id, file: deviceFile });
          }
        } else {
          // Превью не открыто или это iframe - используем синхронизацию
          requestPreviewSync();
        }
      }
    }
    refreshTvTilePlaybackInfo(device_id);
    if (device_id === currentDevice) {
      updatePlaybackInfoUI();
    }
    return;
  }
  
  // Для папок/PDF/PPTX - обновляем состояние устройства с информацией о текущей странице
  if ((type === 'folder' || type === 'pdf' || type === 'pptx') && file && typeof page === 'number') {
    const device = devices.find(d => d.device_id === device_id);
    if (device) {
      if (!device.current) {
        device.current = { type, file, page, state: 'playing' };
      } else {
        device.current.type = type;
        device.current.file = file;
        device.current.page = page;
        device.current.state = 'playing';
      }
      if ((type === 'folder' || type === 'pdf' || type === 'pptx') && typeof duration === 'number' && duration > 0) {
        if (type === 'folder') {
          device.current.folderImageCount = duration;
        } else {
          device.current.totalSlides = duration;
        }
      }
      
      // Обновляем состояние в playerStateByDevice для синхронизации превью
      const state = playerStateByDevice.get(device_id) || {};
      state.type = type;
      state.file = file;
      state.page = page;
      if ((type === 'folder' || type === 'pdf' || type === 'pptx') && typeof duration === 'number' && duration > 0) {
        state.total = duration;
      }
      playerStateByDevice.set(device_id, state);
      
      // Обновляем выделение текущего слайда на спикер панели
      if (device_id === currentDevice) {
        const currentPreviewFile = filePreview.querySelector('.thumbnail-preview')?.getAttribute('data-file');
        const deviceFile = device.current.file;
        // Нормализуем имена файлов (убираем .zip если есть)
        const normalizedDeviceFile = deviceFile.replace(/\.zip$/i, '');
        const normalizedPreviewFile = currentPreviewFile ? currentPreviewFile.replace(/\.zip$/i, '') : null;
        
        if (normalizedPreviewFile === normalizedDeviceFile && isStaticContent(type)) {
          // Превью этой папки/файла открыто - обновляем выделение напрямую
          highlightCurrentThumbnail(page, { deviceId: device_id, file: deviceFile });
        } else {
          // Превью не открыто или другой файл - используем синхронизацию
          requestPreviewSync();
          // КРИТИЧНО: После вызова requestPreviewSync() добавляем небольшую задержку
          // чтобы убедиться, что превью открылось, и затем устанавливаем is-active на основе данных от плеера
          setTimeout(() => {
            const thumbnails = filePreview.querySelectorAll('.thumbnail-preview');
            if (thumbnails.length > 0) {
              const previewFile = thumbnails[0].getAttribute('data-file');
              const normalizedPreviewFileAfter = previewFile ? previewFile.replace(/\.zip$/i, '') : null;
              if (normalizedPreviewFileAfter === normalizedDeviceFile) {
                // Превью открылось - устанавливаем is-active на основе данных от плеера
                highlightCurrentThumbnail(page, { deviceId: device_id, file: deviceFile });
              }
            }
          }, 100);
        }
      }
    }
    refreshTvTilePlaybackInfo(device_id);
    if (device_id === currentDevice) {
      updatePlaybackInfoUI();
    }
    return;
  }
  
  // Для idle/placeholder - очищаем прогресс
  if (type === 'idle' || type === 'placeholder') {
    playbackProgressByDevice.delete(device_id);
    refreshTvTilePlaybackInfo(device_id);
    if (device_id === currentDevice) {
      updatePlaybackInfoUI();
    }
  }
});

/* Верхняя панель управления */
// playBtn в head - ТОЛЬКО для снятия видео с паузы (resume)
// Для запуска файла используется playBtn в списке файлов
document.getElementById('playBtn').onclick = () => {
  const targetDeviceIds = getPanelControlTargetDeviceIds();
  if (!targetDeviceIds.length) return;

  targetDeviceIds.forEach((deviceId) => {
    const device = devices.find(d => d.device_id === deviceId);
    sendVolumeBeforePlay(deviceId);
    socket.emit('control/play', { device_id: deviceId }); // Сервер отправит player/resume
    if (device && device.current && device.current.state === 'paused') {
      device.current.state = 'playing';
    }
  });
  // КРИТИЧНО: НЕ запускаем файл из currentFile - для этого используется playBtn в списке файлов
};

document.getElementById('pauseBtn').onclick = () => {
  const targetDeviceIds = getPanelControlTargetDeviceIds();
  if (!targetDeviceIds.length) return;

  targetDeviceIds.forEach((deviceId) => {
    const device = devices.find(d => d.device_id === deviceId);
    if (device && device.current) {
      device.current.state = 'paused';
    }
    socket.emit('control/pause', { device_id: deviceId });
  });
};
document.getElementById('restartBtn').onclick = () => {
  const targetDeviceIds = getPanelControlTargetDeviceIds();
  if (!targetDeviceIds.length) return;
  targetDeviceIds.forEach((deviceId) => {
    socket.emit('control/restart', { device_id: deviceId });
  });
};
document.getElementById('stopBtn').onclick = () => {
  const targetDeviceIds = getPanelControlTargetDeviceIds({ allowWithPlayerInfo: true });
  if (!targetDeviceIds.length) return; // Разрешаем стоп при наличии информации о воспроизведении

  stopFolderPlaylist('toolbar stop');
  targetDeviceIds.forEach((deviceId) => {
    socket.emit('control/playlistStop', { device_id: deviceId });
    socket.emit('control/stop', { device_id: deviceId });
    playbackProgressByDevice.delete(deviceId);
  });
  updatePlaybackInfoUI();
};

// Обработчик перемотки видео через прогресс-бар
const videoProgressBar = document.getElementById('videoProgressBar');
if (videoProgressBar) {
  const progressBarContainer = document.getElementById('videoProgressContainer');
  if (progressBarContainer) {
    progressBarContainer.style.position = 'relative';
    videoProgressTooltip = document.createElement('div');
    videoProgressTooltip.className = 'video-progress-tooltip';
    videoProgressTooltip.style.position = 'absolute';
    videoProgressTooltip.style.padding = '2px 6px';
    videoProgressTooltip.style.background = 'rgba(0,0,0,0.8)';
    videoProgressTooltip.style.color = '#fff';
    videoProgressTooltip.style.fontSize = '12px';
    videoProgressTooltip.style.borderRadius = '4px';
    videoProgressTooltip.style.pointerEvents = 'none';
    videoProgressTooltip.style.transform = 'translate(-50%, -140%)';
    videoProgressTooltip.style.display = 'none';
    progressBarContainer.appendChild(videoProgressTooltip);
  }
  
  const updateTooltipPosition = (progress) => {
    if (!videoProgressTooltip) return;
    const duration = parseFloat(videoProgressBar.dataset.duration);
    if (!duration || duration <= 0) {
      videoProgressTooltip.style.display = 'none';
      return;
    }
    const targetTime = Math.floor((progress / 100) * duration);
    videoProgressTooltip.textContent = formatTime(targetTime);
    videoProgressTooltip.style.display = 'block';
    if (progressBarContainer) {
      const barRect = videoProgressBar.getBoundingClientRect();
      const containerRect = progressBarContainer.getBoundingClientRect();
      const offsetX = (barRect.left - containerRect.left) + (barRect.width * (progress / 100));
      videoProgressTooltip.style.left = `${offsetX}px`;
    }
  };
  
  videoProgressBar.addEventListener('input', (e) => {
    // Не показываем tooltip если progress bar disabled (duration из базы)
    if (e.target.disabled) {
      if (videoProgressTooltip) videoProgressTooltip.style.display = 'none';
      return;
    }
    isVideoSeeking = true;
    updateTooltipPosition(parseFloat(e.target.value));
  });
  
  videoProgressBar.addEventListener('change', (e) => {
    const targetDeviceIds = getPanelControlTargetDeviceIds();
    if (!targetDeviceIds.length) {
      isVideoSeeking = false;
      if (videoProgressTooltip) videoProgressTooltip.style.display = 'none';
      return;
    }
    
    const progressBar = e.target;
    const duration = parseFloat(progressBar.dataset.duration);
    const file = progressBar.dataset.file;
    const durationFromDatabase = progressBar.dataset.durationFromDatabase === 'true';
    const mediaType = progressBar.dataset.mediaType || '';
    
    // Блокируем перемотку если duration из базы данных (кроме аудио)
    if (durationFromDatabase && mediaType !== 'audio') {
      isVideoSeeking = false;
      if (videoProgressTooltip) videoProgressTooltip.style.display = 'none';
      return;
    }
    
    if (!duration || !file || duration <= 0) {
      isVideoSeeking = false;
      if (videoProgressTooltip) videoProgressTooltip.style.display = 'none';
      return;
    }
    
    const percent = parseFloat(progressBar.value);
    const targetTime = Math.floor((percent / 100) * duration);
    
    targetDeviceIds.forEach((deviceId) => {
      socket.emit('control/seek', {
        device_id: deviceId,
        file: file,
        position: targetTime
      });
      socket.emit('player/seek', {
        device_id: deviceId,
        position: targetTime
      });
    });
    
    // Обновляем локальный прогресс только если файл совпадает
    const prog = playbackProgressByDevice.get(currentDevice);
    if (prog && prog.file === file) {
      prog.currentTime = targetTime;
      playbackProgressByDevice.set(currentDevice, prog);
      updatePlaybackInfoUI();
    }
    
    isVideoSeeking = false;
    if (videoProgressTooltip) videoProgressTooltip.style.display = 'none';
  });
}
// Обработчики для кнопок навигации (Назад/Вперед) - используются для папок, PDF, PPTX
// Используем уже полученные ссылки на элементы вместо getElementById
if (pdfPrevBtn) {
  pdfPrevBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const targetDeviceIds = getPanelControlTargetDeviceIds();
    if (!targetDeviceIds.length) return;
    console.log('[Speaker] ◀ Назад clicked');
    targetDeviceIds.forEach((deviceId) => {
      socket.emit('control/pdfPrev', { device_id: deviceId });
    });
  };
}
if (pdfNextBtn) {
  pdfNextBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const targetDeviceIds = getPanelControlTargetDeviceIds();
    if (!targetDeviceIds.length) return;
    console.log('[Speaker] Вперёд ▶ clicked');
    targetDeviceIds.forEach((deviceId) => {
      socket.emit('control/pdfNext', { device_id: deviceId });
    });
  };
}
document.getElementById('pdfCloseBtn').onclick = () => {
  const targetDeviceIds = getPanelControlTargetDeviceIds({ allowWithPlayerInfo: true });
  if (!targetDeviceIds.length) return; // Разрешаем закрыть при наличии информации о воспроизведении
  
  // Устанавливаем флаг что пользователь ЯВНО закрыл превью
  previewManuallyClosed = true;
  
  // КРИТИЧНО: Останавливаем отслеживание превью стрима если было активно
  if (currentPreviewContext.deviceId && currentPreviewContext.file) {
    const fileData = allFiles.find(f => f.safeName === currentPreviewContext.file);
    if (fileData && fileData.contentType === 'streaming') {
      stopPreviewStreamTracking(currentPreviewContext.deviceId, currentPreviewContext.file);
    }
  }
  
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
      if (requireDeviceReady(currentDevice, true)) { // Разрешаем при наличии информации о воспроизведении
        socket.emit('control/playlistStop', { device_id: currentDevice });
      }
    }
  } else {
    // Проверяем, есть ли локальный плейлист для ТЕКУЩЕГО устройства
    // Если плейлист активен для другого устройства - НЕ останавливаем его!
    if (folderPlaylistState && folderPlaylistState.deviceId === currentDevice) {
      stopFolderPlaylist('preview closed');
    }
  }
  
  // Останавливаем воспроизведение и серверный плейлист на всех выбранных устройствах
  targetDeviceIds.forEach((deviceId) => {
    socket.emit('control/playlistStop', { device_id: deviceId });
    socket.emit('control/stop', { device_id: deviceId });
    playbackProgressByDevice.delete(deviceId);
  });
  
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
  
  // КРИТИЧНО: Обновляем кэш метаданных для всех устройств после загрузки
  // Это гарантирует, что resolveFileDisplayData найдет правильные originalName
  devices.forEach(device => {
    prefillDeviceFileMeta(device);
  });
  
  if (prevDevice && devices.find(d => d.device_id === prevDevice)) {
    // ИСПРАВЛЕНО: НЕ сбрасываем страницу при обновлении (false)
    await selectDevice(prevDevice, false, { preserveSelection: true });
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
    // Если устройство стало онлайн — скрываем кнопку сразу
    updateLaunchAndroidBtn();
  }
});
socket.on('player/offline', ({ device_id }) => {
  readyDevices.delete(device_id);
  renderTVList();
  if (device_id === currentDevice) {
    updateVolumeUI();
    // Ждём 3 секунды — если устройство всё ещё оффлайн, показываем кнопку
    setTimeout(() => {
      if (!readyDevices.has(device_id)) {
        // Разрешаем показать (если первичная загрузка уже прошла)
        if (speakerInitialChecked) updateLaunchAndroidBtn();
      }
    }, 3000);
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
    refreshTvTilePlaybackInfo(device_id);
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
  
  refreshTvTilePlaybackInfo(device_id);
});

socket.on('devices/updated', onDevicesUpdated);

// Обработчик обновления устройств пользователя (для спикеров)
socket.on('user/devices/updated', async ({ userId }) => {
  // Проверяем, что это обновление для текущего пользователя
  try {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    if (user.id && user.id === userId) {
      // Обновляем список устройств для текущего пользователя
      console.log('[Speaker] User devices updated, refreshing device list...');
      await loadDevices();
    }
  } catch (err) {
    console.error('[Speaker] Error handling user/devices/updated:', err);
  }
});
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
    renderTVList();
    
    // КРИТИЧНО: После renderTVList обновляем UI для всех устройств, которые воспроизводят стримы
    // Это гарантирует, что информация о стримах отображается на карточках устройств
    devices.forEach(d => {
      if (d.current && d.current.type === 'streaming') {
        refreshTvTilePlaybackInfo(d.device_id);
        if (d.device_id === currentDevice) {
          console.log('[onPreviewRefresh] Updating UI for current streaming device after renderTVList', {
            deviceId: d.device_id,
            file: d.current.file,
            streamProtocol: d.current.streamProtocol
          });
          updatePlaybackInfoUI();
        }
      }
    });
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

  // КРИТИЧНО: Обновляем UI для стримов (как для видео)
  // Это должно происходить сразу после обновления device.current из сервера
  if (device.current && device.current.type === 'streaming') {
    console.log('[onPreviewRefresh] Streaming detected, updating UI', {
      deviceId: device_id,
      file: device.current.file,
      streamProtocol: device.current.streamProtocol,
      streamUrl: device.current.streamUrl
    });
    refreshTvTilePlaybackInfo(device_id);
    if (device_id === currentDevice) {
      updatePlaybackInfoUI();
    }
  }

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
    // КРИТИЧНО: Обновляем выделение сразу после обновления состояния
    if (device_id === currentDevice && device.current) {
      const state = playerStateByDevice.get(device_id);
      if (state && state.file && state.page) {
        // Проверяем, открыто ли превью этой папки/файла
        const currentPreviewFile = filePreview.querySelector('.thumbnail-preview')?.getAttribute('data-file');
        const deviceFile = device.current.file || state.file;
        // Нормализуем имена файлов (убираем .zip если есть)
        const normalizedDeviceFile = deviceFile.replace(/\.zip$/i, '');
        const normalizedPreviewFile = currentPreviewFile ? currentPreviewFile.replace(/\.zip$/i, '') : null;
        
        if (normalizedPreviewFile === normalizedDeviceFile && isStaticContent(state.type)) {
          // Превью этой папки/файла открыто - обновляем выделение напрямую
          highlightCurrentThumbnail(state.page, { deviceId: currentDevice, file: deviceFile });
        } else {
          // Превью не открыто или другой файл - используем синхронизацию
          requestPreviewSync();
        }
      } else {
        requestPreviewSync();
      }
    } else {
      requestPreviewSync();
    }
    // Обновляем информацию о плейлисте после обновления состояния устройства
    updatePlaybackInfoUI();
  }
  refreshTvTilePlaybackInfo(device_id);
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
  let previewContext = context;
  
  // Если контекст не передан, пытаемся получить из текущего превью
  if (!previewContext || !previewContext.file) {
    previewContext = getPreviewContext();
    // Также проверяем DOM на наличие открытого превью
    const thumbnails = filePreview.querySelectorAll('.thumbnail-preview');
    if (thumbnails.length > 0 && !previewContext.file) {
      const firstThumb = thumbnails[0];
      previewContext = {
        deviceId: firstThumb.getAttribute('data-device-id'),
        file: firstThumb.getAttribute('data-file'),
        page: null
      };
    }
  }
  
  if (!previewContext || !previewContext.deviceId || !previewContext.file) {
    console.warn('[Speaker] highlightCurrentThumbnail: нет контекста', { context, previewContext, currentDevice });
    return;
  }

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
    
    if (!currentDevice) return;
    
    // Получаем актуальное состояние устройства из списка устройств
    const device = devices.find(d => d.device_id === currentDevice);
    if (!device || !device.current) {
      return;
    }
    
    // Определяем тип контента из eventName
    const contentType = eventName === 'folderPage' ? 'folder' : 
                       eventName === 'pptxPage' ? 'pptx' : 'pdf';
    
    // Проверяем, что тип контента совпадает
    if (device.current.type !== contentType) {
      return;
    }
    
    const deviceFile = device.current.file;
    if (!deviceFile) {
      return;
    }
    
    // Обновляем состояние
    const state = playerStateByDevice.get(currentDevice) || {};
    const updatedState = { ...state, type: contentType, file: deviceFile, page };
    playerStateByDevice.set(currentDevice, updatedState);
    
    // Обновляем device.current.page
    device.current.page = page;
    if (device.current.type === 'folder' && device.current.playlistActive) {
      updatePlaybackInfoUI();
    }
    
    // КРИТИЧНО: Сразу обновляем выделение напрямую
    // Проверяем, открыто ли превью этой папки/файла
    const thumbnails = filePreview.querySelectorAll('.thumbnail-preview');
    if (thumbnails.length > 0) {
      // Есть превью - проверяем, соответствует ли оно текущему файлу
      const firstThumb = thumbnails[0];
      const previewDeviceId = firstThumb.getAttribute('data-device-id');
      const previewFile = firstThumb.getAttribute('data-file');
      
      // Нормализуем имена файлов (убираем .zip если есть) для корректного сравнения
      const normalizedPreviewFile = previewFile ? previewFile.replace(/\.zip$/i, '') : null;
      const normalizedDeviceFile = deviceFile ? deviceFile.replace(/\.zip$/i, '') : null;
      
      if (previewDeviceId === currentDevice && normalizedPreviewFile === normalizedDeviceFile) {
        // Превью этой папки/файла открыто - обновляем выделение напрямую
        highlightCurrentThumbnail(page, { deviceId: currentDevice, file: deviceFile });
        return;
      }
    }
    
    // Превью не открыто или другой файл - используем синхронизацию
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
      const targetDeviceIds = getPanelControlTargetDeviceIds();
      if (!targetDeviceIds.length) return;
      targetDeviceIds.forEach((deviceId) => {
        if (dx < 0) socket.emit('control/pdfNext', { device_id: deviceId });
        else socket.emit('control/pdfPrev', { device_id: deviceId });
      });
    }
  }, { passive: true });
}

// Мобильные табы
function initMobileTabs() {
  const mobileTabs = document.getElementById('mobileTabs');
  if (!mobileTabs) return;
  
  // Показываем табы только на мобильных
  const checkMobile = () => {
    const isMobile = window.innerWidth <= 767;
    mobileTabs.style.display = isMobile ? 'flex' : 'none';
    
    if (isMobile) {
      // По умолчанию показываем устройства
      if (!document.querySelector('.active-tab')) {
        showTab('devices');
      }
    } else {
      // На десктопе показываем все панели
      document.querySelectorAll('.devices-panel, .files-panel, .preview-panel').forEach(panel => {
        panel.style.display = '';
        panel.classList.add('active-tab');
      });
    }
  };
  
  // Обработчики кликов по табам
  mobileTabs.querySelectorAll('.mobile-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      showTab(tab);
    });
  });
  
  // Функция переключения таба
  window.showTab = (tabName) => {
    // Убираем активный класс со всех кнопок
    mobileTabs.querySelectorAll('.mobile-tab-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    
    // Убираем активный класс со всех панелей
    document.querySelectorAll('.devices-panel, .files-panel, .preview-panel').forEach(panel => {
      panel.classList.remove('active-tab');
    });
    
    // Активируем выбранную кнопку
    const activeBtn = mobileTabs.querySelector(`[data-tab="${tabName}"]`);
    if (activeBtn) {
      activeBtn.classList.add('active');
    }
    
    // Показываем выбранную панель
    let activePanel = null;
    if (tabName === 'devices') {
      activePanel = document.querySelector('.devices-panel');
    } else if (tabName === 'files') {
      activePanel = document.querySelector('.files-panel');
    } else if (tabName === 'preview') {
      activePanel = document.querySelector('.preview-panel');
    }
    
    if (activePanel) {
      activePanel.classList.add('active-tab');
    }
  };
  
  // Проверяем при загрузке и изменении размера
  checkMobile();
  window.addEventListener('resize', debounce(checkMobile, 250));
  
  // Автоматическое переключение на файлы при выборе устройства
  const originalOpenDevice = window.openDevice;
  if (typeof originalOpenDevice === 'function') {
    window.openDevice = function(...args) {
      originalOpenDevice.apply(this, args);
      if (window.innerWidth <= 767) {
        setTimeout(() => showTab('files'), 100);
      }
    };
  }
  
  // Автоматическое переключение на превью при выборе файла (только если не видео)
  // Это нужно добавить в функцию, которая обрабатывает клик по файлу
}

// Инициализация мобильных табов при загрузке
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMobileTabs);
} else {
  initMobileTabs();
}

// Мобильный аккордеон
function initMobileAccordion() {
  const isMobile = () => window.innerWidth <= 767;
  
  // Функция переключения панели
  const togglePanel = (panelName) => {
    if (!isMobile()) return;
    
    const header = document.querySelector(`.accordion-header[data-panel="${panelName}"]`);
    const panel = document.querySelector(`.${panelName}-panel`);
    
    if (!header || !panel) return;
    
    const isExpanded = panel.classList.contains('expanded');
    
    // Закрываем все панели
    document.querySelectorAll('.devices-panel, .files-panel, .preview-panel').forEach(p => {
      p.classList.remove('expanded');
    });
    document.querySelectorAll('.accordion-header').forEach(h => {
      h.classList.remove('expanded', 'active');
    });
    
    // Если панель была закрыта - открываем её
    if (!isExpanded) {
      panel.classList.add('expanded');
      header.classList.add('expanded', 'active');
    }
  };
  
  // Обработчики кликов по заголовкам
  document.querySelectorAll('.accordion-header').forEach(header => {
    header.addEventListener('click', () => {
      const panelName = header.getAttribute('data-panel');
      togglePanel(panelName);
    });
  });
  
  // Инициализация: открываем первую панель (Устройства) на мобильных
  const initAccordion = () => {
    if (isMobile()) {
      // По умолчанию открываем устройства
      if (!document.querySelector('.expanded')) {
        togglePanel('devices');
      }
    } else {
      // На десктопе показываем все панели
      document.querySelectorAll('.devices-panel, .files-panel, .preview-panel').forEach(panel => {
        panel.classList.add('expanded');
      });
    }
  };
  
  // Синхронизация счетчиков между мобильным и десктопным заголовками
  const syncCounters = () => {
    const devicesMeta = document.getElementById('devicesMeta');
    const devicesMetaMobile = document.getElementById('devicesMetaMobile');
    if (devicesMeta && devicesMetaMobile) {
      devicesMetaMobile.textContent = devicesMeta.textContent;
    }
    
    const filesMeta = document.getElementById('filesPaneMeta');
    const filesMetaMobile = document.getElementById('filesPaneMetaMobile');
    if (filesMeta && filesMetaMobile) {
      filesMetaMobile.textContent = filesMeta.textContent;
    }
    
    const filesTitle = document.getElementById('filesPaneTitle');
    const filesTitleMobile = document.getElementById('filesPaneTitleMobile');
    if (filesTitle && filesTitleMobile) {
      filesTitleMobile.textContent = filesTitle.textContent;
    }
  };
  
  // Обсервер для синхронизации счетчиков
  const observer = new MutationObserver(syncCounters);
  const devicesMeta = document.getElementById('devicesMeta');
  const filesMeta = document.getElementById('filesPaneMeta');
  const filesTitle = document.getElementById('filesPaneTitle');
  
  if (devicesMeta) observer.observe(devicesMeta, { childList: true, characterData: true, subtree: true });
  if (filesMeta) observer.observe(filesMeta, { childList: true, characterData: true, subtree: true });
  if (filesTitle) observer.observe(filesTitle, { childList: true, characterData: true, subtree: true });
  
  // Автоматическое переключение на файлы при выборе устройства
  const originalSelectDevice = window.selectDevice || (async () => {});
  window.selectDevice = async function(...args) {
    await originalSelectDevice.apply(this, args);
    if (isMobile()) {
      setTimeout(() => togglePanel('files'), 100);
    }
  };
  
  // Проверяем при загрузке и изменении размера
  initAccordion();
  syncCounters();
  window.addEventListener('resize', debounce(() => {
    initAccordion();
    syncCounters();
  }, 250));
}

// Инициализация мобильного аккордеона
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMobileAccordion);
} else {
  initMobileAccordion();
}


