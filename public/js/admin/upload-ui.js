// upload-ui.js - ПОЛНЫЙ код setupUploadUI из admin.js
import { setXhrAuth, adminFetch } from './auth.js';
import { calculateFileMD5 } from './md5-helper.js';
import { getFolderIcon, getSuccessIcon, getFileIcon, getFilmIcon } from '../shared/svg-icons.js';

const YTDLP_ACTIVE_STATUSES = new Set(['queued', 'waiting_resources', 'preparing', 'downloading', 'processing']);
const ytDownloadRuntimeByDevice = new Map();
const ytDownloadUiByDevice = new Map();

// Активные загрузки по всем устройствам.
// Раньше window.isUploadingFiles перезаписывался на каждый вызов setupUploadUI
// и закрывался на локальный isUploading последней отрисованной карточки,
// поэтому гвард в admin.js проверял состояние чужого устройства.
const uploadingDevices = new Set();

if (typeof window !== 'undefined') {
  window.isUploadingFiles = () => uploadingDevices.size > 0;
}

async function reportUploadNotification(payload = {}) {
  try {
    await adminFetch('/api/notifications/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: payload.type || 'upload_ui_event',
        severity: payload.severity || 'info',
        title: payload.title || 'Уведомление загрузки',
        message: payload.message || '',
        details: payload.details || {},
        key: payload.key || null,
        source: 'admin-upload-ui'
      })
    });
  } catch (error) {
    console.error('[Upload UI] Failed to report notification:', error);
  }
}

function getYtRuntime(deviceId) {
  if (!ytDownloadRuntimeByDevice.has(deviceId)) {
    ytDownloadRuntimeByDevice.set(deviceId, {
      deviceId,
      jobId: null,
      status: 'idle',
      progress: 0,
      speed: null,
      eta: null,
      fileName: null,
      title: null,
      error: null,
      visible: false,
      synced: false,
      pollTimer: null,
      updatedAt: Date.now()
    });
  }

  return ytDownloadRuntimeByDevice.get(deviceId);
}

function notifyYtRuntimeChanged(deviceId) {
  const render = ytDownloadUiByDevice.get(deviceId);
  if (typeof render === 'function') {
    render();
  }
}

function setYtRuntime(deviceId, patch = {}) {
  const runtime = getYtRuntime(deviceId);
  const next = {
    ...runtime,
    ...patch,
    updatedAt: Date.now()
  };

  ytDownloadRuntimeByDevice.set(deviceId, next);
  notifyYtRuntimeChanged(deviceId);
  return next;
}

function clearYtPollTimer(deviceId) {
  const runtime = getYtRuntime(deviceId);
  if (runtime.pollTimer) {
    clearInterval(runtime.pollTimer);
    runtime.pollTimer = null;
    ytDownloadRuntimeByDevice.set(deviceId, runtime);
  }
}

function normalizeYtProgress(progress = 0) {
  return Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
}

function getYtStatusLabel(status) {
  return {
    queued: 'В очереди',
    waiting_resources: 'Ожидание ресурсов',
    preparing: 'Подготовка',
    downloading: 'Загрузка',
    processing: 'Обработка',
    completed: 'Готово',
    failed: 'Ошибка',
    cancelled: 'Отменено'
  }[status] || 'Загрузка';
}

function buildYtStatusText(runtime) {
  if (!runtime) return '';

  const progress = normalizeYtProgress(runtime.progress);
  const speedText = runtime.speed ? ` • ${runtime.speed}` : '';
  const etaText = runtime.eta ? ` • ETA ${runtime.eta}` : '';

  if (runtime.status === 'completed') {
    return `Загрузка завершена: ${runtime.fileName || runtime.title || 'файл готов'}`;
  }

  if (runtime.status === 'failed') {
    return `Ошибка загрузки: ${runtime.error || 'неизвестная ошибка'}`;
  }

  if (runtime.status === 'cancelled') {
    return runtime.error || 'Загрузка отменена';
  }

  if (runtime.status === 'idle') {
    return '';
  }

  return `${getYtStatusLabel(runtime.status)}: ${progress}%${speedText}${etaText}`;
}

function buildYtInlineText(runtime) {
  if (!runtime) return '';

  const progress = normalizeYtProgress(runtime.progress);
  const speedText = runtime.speed ? ` • ${runtime.speed}` : '';
  const etaText = runtime.eta ? ` • ETA ${runtime.eta}` : '';

  if (YTDLP_ACTIVE_STATUSES.has(runtime.status)) {
    return `${getYtStatusLabel(runtime.status)}: ${progress}%${speedText}${etaText}`;
  }

  return '';
}

function getYtVisualState(runtime) {
  if (!runtime) return 'downloading';
  if (runtime.status === 'completed') return 'completed';
  if (runtime.status === 'failed' || runtime.status === 'cancelled') return 'failed';
  return 'downloading';
}

async function pollYtDownloadStatusForDevice(deviceId) {
  const runtime = getYtRuntime(deviceId);
  if (!runtime.jobId) {
    clearYtPollTimer(deviceId);
    return;
  }

  try {
    const statusRes = await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/download-url/${encodeURIComponent(runtime.jobId)}`);
    const statusData = await statusRes.json();

    if (!statusRes.ok || !statusData?.ok) {
      throw new Error(statusData?.error || 'Не удалось получить статус загрузки');
    }

    const job = statusData.job || {};
    const patch = {
      status: job.status || runtime.status,
      progress: typeof job.progress === 'number' ? job.progress : runtime.progress,
      speed: job.speed || null,
      eta: job.eta || null,
      fileName: job.fileName || runtime.fileName,
      title: job.title || runtime.title,
      error: job.error || null,
      visible: true
    };

    if (job.status === 'completed') {
      Object.assign(patch, {
        progress: 100,
        speed: null,
        eta: null,
        jobId: null,
        error: null,
        synced: false
      });
      clearYtPollTimer(deviceId);
    }

    if (job.status === 'failed' || job.status === 'cancelled') {
      Object.assign(patch, {
        speed: null,
        eta: null,
        jobId: null,
        synced: false
      });
      clearYtPollTimer(deviceId);
    }

    setYtRuntime(deviceId, patch);
  } catch (error) {
    const current = getYtRuntime(deviceId);
    if (current.status === 'cancelled') {
      clearYtPollTimer(deviceId);
      setYtRuntime(deviceId, { jobId: null, visible: true });
      return;
    }

    clearYtPollTimer(deviceId);
    setYtRuntime(deviceId, {
      status: 'failed',
      error: `Ошибка статуса: ${error.message}`,
      speed: null,
      eta: null,
      jobId: null,
      visible: true,
      synced: false
    });
  }
}

function ensureYtDownloadPolling(deviceId) {
  const runtime = getYtRuntime(deviceId);
  if (!runtime.jobId || runtime.pollTimer) return;

  runtime.pollTimer = setInterval(() => {
    pollYtDownloadStatusForDevice(deviceId);
  }, 1200);

  ytDownloadRuntimeByDevice.set(deviceId, runtime);
  pollYtDownloadStatusForDevice(deviceId);
}

function stopYtDownloadPolling(deviceId) {
  clearYtPollTimer(deviceId);
}

export function setupUploadUI(card, deviceId, filesPanelEl, renderFilesPane, socket) {
  const dropZone = card.querySelector('.dropZone');
  const fileInput = card.querySelector('.fileInput');
  const folderInput = card.querySelector('.folderInput');
  const pickBtn = card.querySelector('.pickBtn');
  const pickFolderBtn = card.querySelector('.pickFolderBtn');
  const clearBtn = card.querySelector('.clearBtn');
  const uploadBtn = card.querySelector('.uploadBtn');
  const queue = card.querySelector('.queue');
  const ytDownloadBtn = card.querySelector('.ytDownloadBtn');
  const ytDownloadStatus = card.querySelector('.ytDownloadStatus');
  const ytDownloadStatusText = card.querySelector('.ytDownloadStatusText');
  const ytDownloadProgressFill = card.querySelector('.ytDownloadProgressFill');
  const uploadStatusInline = card.querySelector('.uploadStatusInline');
  const uploadProgressPanel = card.querySelector('.uploadProgressPanel');
  const uploadProgressLabel = card.querySelector('.uploadProgressLabel');
  const uploadProgressStats = card.querySelector('.uploadProgressStats');
  const uploadProgressCheckFill = card.querySelector('.uploadProgressCheckFill');
  const uploadProgressSendFill = card.querySelector('.uploadProgressSendFill');
  if (!fileInput || !pickBtn || !clearBtn || !uploadBtn || !queue) return;

  let pending = [];
  let folderName = null; // Имя выбранной папки
  let isUploading = false; // Флаг активной загрузки (предотвращает обновление UI)
  let isClearingUploads = false;
  const activeUploadRequests = new Set();
  const allowed = /\.(mp4|webm|ogg|mkv|mov|avi|mp3|wav|m4a|png|jpg|jpeg|gif|webp|pdf|pptx|zip)$/i;
  const imageExtensions = /\.(png|jpg|jpeg|gif|webp)$/i;
  const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB

  function trackUploadRequest(xhr) {
    activeUploadRequests.add(xhr);
    xhr.addEventListener('loadend', () => {
      activeUploadRequests.delete(xhr);
    }, { once: true });
    return xhr;
  }

  function updateYtDownloadStatusUI({ visible = false, text = '', progress = 0, state = 'downloading', inlineText = '' } = {}) {
    if (ytDownloadStatus && ytDownloadStatusText && ytDownloadProgressFill) {
      ytDownloadStatus.style.display = visible ? 'block' : 'none';
      ytDownloadStatusText.textContent = text;

      const normalizedProgress = normalizeYtProgress(progress);
      ytDownloadProgressFill.style.width = `${normalizedProgress}%`;

      if (state === 'failed') {
        ytDownloadProgressFill.style.background = 'linear-gradient(90deg, #ef5350, #e53935)';
      } else if (state === 'completed') {
        ytDownloadProgressFill.style.background = 'linear-gradient(90deg, #4CAF50, #8BC34A)';
      } else {
        ytDownloadProgressFill.style.background = 'linear-gradient(90deg, #42a5f5, #1e88e5)';
      }
    }

    if (uploadStatusInline) {
      uploadStatusInline.style.display = inlineText ? 'inline' : 'none';
      uploadStatusInline.textContent = inlineText;
      if (state === 'failed') {
        uploadStatusInline.style.color = '#e53935';
      } else if (state === 'completed') {
        uploadStatusInline.style.color = '#43a047';
      } else {
        uploadStatusInline.style.color = 'var(--text-dim)';
      }
    }
  }

  function syncYtDownloadUI() {
    if (!document.body.contains(card)) {
      if (ytDownloadUiByDevice.get(deviceId) === syncYtDownloadUI) {
        ytDownloadUiByDevice.delete(deviceId);
      }
      return;
    }

    const runtime = getYtRuntime(deviceId);
    const state = getYtVisualState(runtime);
    const text = buildYtStatusText(runtime);
    const hasPendingFiles = pending.length > 0;
    const inlineText = (isUploading || hasPendingFiles) ? '' : buildYtInlineText(runtime);

    updateYtDownloadStatusUI({
      visible: Boolean(text),
      state,
      progress: runtime.progress,
      text,
      inlineText
    });

    if (ytDownloadBtn) {
      ytDownloadBtn.disabled = false;
    }

    if (runtime.status === 'completed' && !runtime.synced) {
      runtime.synced = true;
      ytDownloadRuntimeByDevice.set(deviceId, runtime);

      Promise.resolve().then(async () => {
        await renderFilesPane(deviceId);
      }).catch((error) => {
        console.error('[Upload] Ошибка обновления списка после yt-dlp:', error);
      });
    }
  }

  ytDownloadUiByDevice.set(deviceId, syncYtDownloadUI);
  const runtime = getYtRuntime(deviceId);
  if (runtime.jobId && YTDLP_ACTIVE_STATUSES.has(runtime.status)) {
    ensureYtDownloadPolling(deviceId);
  }
  syncYtDownloadUI();

  // Состояния строки очереди. Цвет НЕ единственный носитель смысла:
  // у каждого состояния есть своя подпись, иначе по одним оттенкам
  // отличить «ошибка» от «копирование» невозможно.
  const UPLOAD_STATES = {
    queued:    { label: 'В очереди',     color: 'var(--muted)' },
    checking:  { label: 'Проверка',      color: 'var(--warning)' },
    duplicate: { label: 'Дубликат',      color: 'var(--brand)' },
    sending:   { label: 'Отправка',      color: 'var(--brand)' },
    done:      { label: 'Готово',        color: 'var(--success)' },
    error:     { label: 'Ошибка',        color: 'var(--danger)' }
  };

  const BAR_BASE = 'height:100%; width:0%; transition:width 0.3s ease;';

  // Строка очереди разделена на три смысловые зоны, чтобы «название»,
  // «размер» и «проценты» больше не стояли одной строкой и не сливались:
  //   глиф | имя + метаданные | колонка процентов
  //     └── полоса под строкой на всю ширину
  function buildQueueRow(deviceId, key, { name, sizeText, glyph, isFolder = false }) {
    const li = document.createElement('li');
    li.className = 'uploadRow';
    li.style.cssText = [
      'display:flex',
      'flex-direction:column',
      // .queue li в app.css оставляет align-items:center и
      // justify-content:space-between от горизонтального списка. В
      // колоночной раскладке align-items действует на ГОРИЗОНТАЛЬНУЮ ось,
      // из-за чего всё в строке центрировалось по ширине. Обе оси задаём
      // явно, чтобы правило .queue li не протекало в новую вёрстку.
      'align-items:stretch',
      'justify-content:flex-start',
      'gap:6px',
      'padding:8px 10px',
      'border-radius:var(--radius-sm)',
      'background:var(--panel-2)',
      // Пунктир от .queue li не нужен: у строки своя карточка с фоном.
      'border-bottom:none',
      isFolder ? 'border:1px solid var(--border-2)' : ''
    ].filter(Boolean).join(';');

    const top = document.createElement('div');
    top.style.cssText = 'display:flex; align-items:center; gap:10px; min-width:0;';

    const glyphBox = document.createElement('span');
    glyphBox.className = 'uploadRowGlyph';
    glyphBox.id = `g_${deviceId}_${key}`;
    glyphBox.style.cssText = [
      'flex-shrink:0',
      'width:32px',
      'height:32px',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'border-radius:var(--radius-sm)',
      'background:var(--panel)',
      'color:var(--muted)'
    ].join(';');
    glyphBox.insertAdjacentHTML('beforeend', glyph);
    top.appendChild(glyphBox);

    const main = document.createElement('div');
    main.style.cssText = 'flex:1; min-width:0;';

    const nameEl = document.createElement('div');
    nameEl.className = 'uploadRowName';
    nameEl.textContent = name;
    nameEl.title = name;
    nameEl.style.cssText = [
      'font-size:var(--font-size-sm)',
      'font-weight:var(--font-weight-medium)',
      'color:var(--text)',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
      'text-align:left'
    ].join(';');

    const metaEl = document.createElement('div');
    metaEl.className = 'uploadRowMeta';
    metaEl.id = `m_${deviceId}_${key}`;
    metaEl.style.cssText = [
      'font-size:var(--font-size-xs)',
      'color:var(--muted)',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
      'margin-top:2px'
    ].join(';');

    main.appendChild(nameEl);
    main.appendChild(metaEl);
    top.appendChild(main);

    // Проценты живут в отдельной колонке фиксированной ширины с
    // табличными цифрами: без этого цифры «прыгают» по горизонтали
    // при каждом обновлении, и строка визуально дрожит.
    const pctEl = document.createElement('span');
    pctEl.className = 'uploadRowPct';
    pctEl.id = `p_${deviceId}_${key}`;
    pctEl.style.cssText = [
      'flex-shrink:0',
      'min-width:46px',
      'text-align:right',
      'font-size:var(--font-size-sm)',
      'font-weight:var(--font-weight-semibold)',
      'font-variant-numeric:tabular-nums',
      'font-feature-settings:"tnum"',
      'color:var(--text-2)'
    ].join(';');
    pctEl.textContent = '0%';
    top.appendChild(pctEl);

    const bar = document.createElement('div');
    bar.className = 'uploadBar';
    bar.style.cssText = 'height:3px; border-radius:2px; background:var(--border-2); overflow:hidden;';

    const fill = document.createElement('div');
    fill.className = 'uploadBarFill';
    fill.id = `b_${deviceId}_${key}`;
    fill.style.cssText = BAR_BASE;
    bar.appendChild(fill);

    li.appendChild(top);
    li.appendChild(bar);

    li.dataset.sizeText = sizeText || '';
    li.dataset.state = 'queued';
    return li;
  }

  function rowParts(deviceId, key) {
    return {
      li: queue.querySelector(`#g_${deviceId}_${key}`)?.closest('.uploadRow') || null,
      pct: queue.querySelector(`#p_${deviceId}_${key}`),
      fill: queue.querySelector(`#b_${deviceId}_${key}`),
      meta: queue.querySelector(`#m_${deviceId}_${key}`),
      glyph: queue.querySelector(`#g_${deviceId}_${key}`)
    };
  }

  // Ширина полосы и цифры обновляются из одного места — разойтись они
  // уже не могут.
  function setUploadProgress(deviceId, key, percent) {
    const { pct, fill } = rowParts(deviceId, key);
    const value = Number(percent);
    const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
    if (fill) fill.style.width = `${safe}%`;
    if (pct) pct.textContent = `${Math.round(safe)}%`;
    return safe;
  }

  // Состояние перекрашивает полосу и подпись. Подпись остаётся читаемой
  // при любом цвете, а размер файла в метаданных не теряется.
  function setUploadState(deviceId, key, stateName, note) {
    const def = UPLOAD_STATES[stateName] || UPLOAD_STATES.queued;
    const { li, fill, meta, glyph } = rowParts(deviceId, key);
    if (fill) fill.style.background = def.color;
    if (glyph) glyph.style.color = def.color;
    if (meta) {
      const size = li?.dataset.sizeText || '';
      const parts = [size, def.label];
      if (note) parts.push(note);
      meta.textContent = parts.filter(Boolean).join(' · ');
    }
    if (li) li.dataset.state = stateName;
  }

  // Галочка в глифе вместо процентов: у завершённого файла результат
  // важнее числа, которое всё равно равно 100.
  function markRowDone(deviceId, key, note) {
    const { glyph, pct } = rowParts(deviceId, key);
    setUploadState(deviceId, key, 'done', note);
    if (glyph) {
      glyph.innerHTML = '';
      glyph.insertAdjacentHTML('beforeend', getSuccessIcon(16));
      glyph.style.color = 'var(--success)';
    }
    if (pct) pct.textContent = '100%';
  }

  // ---- Сводный прогресс загрузки ---------------------------------------
  // Отслеживает пофазовый вклад каждого файла, взвешенный по размеру,
  // поэтому крупный файл двигает общую полосу заметнее мелких.
  // Фазы одного файла: проверка (MD5 + поиск дубликата) 0-25%,
  // передача 25-100%. Итог пересчитывается по байтам, а не по числу файлов.
  const PHASE_CHECK_END = 25;

  // Сколько байт уже учтено по каждому индексу: события onprogress иногда
  // приходят повторно с тем же loaded, и без этого скорость завышалась бы.
  const lastSentBytes = new Map();
  let folderSentBytes = 0;

  const overall = {
    totalBytes: 0,
    sizesByKey: new Map(),    // key -> размер в байтах
    progressByFile: new Map(), // key -> 0..100
    transferBytes: 0,
    transferStartedAt: 0,
    shown: 0,          // максимум показанного: полоса не откатывается
    hideTimer: null,
    completed: false
  };

  function overallPercent() {
    if (!overall.totalBytes) return 0;
    let acc = 0;
    let bytes = 0;
    for (const [key, size] of overall.sizesByKey) {
      acc += size * (overall.progressByFile.get(key) || 0);
      bytes += size;
    }
    if (!bytes) return 0;
    return Math.max(0, Math.min(100, acc / bytes));
  }

  // Разбивка по фазам для двухтоновой полосы. Считается по той же
  // байтовой формуле, что и общий процент, поэтому сегменты всегда
  // в сумме дают ровно показанный итог.
  function overallPhaseSplit() {
    let checkAcc = 0;
    let sendAcc = 0;
    let bytes = 0;
    for (const [key, size] of overall.sizesByKey) {
      const p = overall.progressByFile.get(key) || 0;
      checkAcc += size * Math.min(p, PHASE_CHECK_END);
      sendAcc += size * Math.max(0, p - PHASE_CHECK_END);
      bytes += size;
    }
    if (!bytes) return { check: 0, send: 0 };
    return {
      check: Math.max(0, Math.min(100, checkAcc / bytes)),
      send: Math.max(0, Math.min(100, sendAcc / bytes))
    };
  }

  // Русские единицы с пробелом и без скобок: интерфейс на русском,
  // поэтому «12.4 МБ» вместо «(11.78 MB)».
  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '0 Б';
    const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let unitIndex = 0;
    let scaled = bytes;
    while (scaled >= 1024 && unitIndex < units.length - 1) {
      scaled /= 1024;
      unitIndex += 1;
    }
    // Байты целые, остальные единицы — с одним знаком, но без хвоста «.0».
    const digits = unitIndex === 0 ? 0 : (scaled < 10 ? 1 : 0);
    return `${Number(scaled.toFixed(digits))} ${units[unitIndex]}`;
  }

  function renderOverall(labelText) {
    // Проверяем сегменты, а не контейнер: контейнер существует всегда,
    // а сегменты — то, что реально рисуется.
    if (!uploadProgressPanel || (!uploadProgressCheckFill && !uploadProgressSendFill)) return;
    // Полоса не должна «откатываться» назад: дубликат отдавал свои 100%
    // ещё на фазе проверки, и следующий файл съедал их обратно — визуально
    // это выглядело как зависание на 100%. Показываем максимум.
    overall.shown = Math.max(overall.shown, overallPercent());
    const percent = overall.shown;
    const rounded = Math.round(percent);
    const split = overallPhaseSplit();
    if (uploadProgressCheckFill) uploadProgressCheckFill.style.width = `${split.check}%`;
    if (uploadProgressSendFill) uploadProgressSendFill.style.width = `${split.send}%`;

    if (labelText && uploadProgressLabel) uploadProgressLabel.textContent = labelText;

    // Скорость считаем только по реально переданным байтам и только пока
    // передача идёт, иначе среднее «размазывается» паузами проверки.
    let stats = `${rounded}%`;
    const elapsedMs = overall.transferStartedAt ? Date.now() - overall.transferStartedAt : 0;
    if (overall.transferBytes > 0 && elapsedMs > 500) {
      const bytesPerSec = overall.transferBytes / (elapsedMs / 1000);
      if (bytesPerSec > 1) {
        stats += ` · ${formatBytes(bytesPerSec)}/с`;
        const remainingBytes = overall.totalBytes * (1 - percent / 100);
        if (remainingBytes > 0) {
          const etaSec = remainingBytes / bytesPerSec;
          if (etaSec < 90) stats += ` · ~${Math.ceil(etaSec)} с`;
          else stats += ` · ~${Math.ceil(etaSec / 60)} мин`;
        }
      }
    }
    if (uploadProgressStats) uploadProgressStats.textContent = stats;
  }

  function showOverall(labelText) {
    if (!uploadProgressPanel) return;
    uploadProgressPanel.style.display = 'block';
    renderOverall(labelText);
  }

  function hideOverall() {
    if (uploadProgressPanel) uploadProgressPanel.style.display = 'none';
  }

  function setFileOverall(key, percent) {
    overall.progressByFile.set(key, Math.max(0, Math.min(100, percent)));
    renderOverall();
  }

  // Загрузка папки идёт одним XHR, поэтому у события onprogress нет
  // индекса файла. Раскладываем этот процент по всем ключам папки —
  // иначе сводная полоса оставалась бы на 0%, пока строка папки идёт.
  // Проверки дубликатов у папки нет, поэтому фаза отправки идёт с нуля.
  function setFolderOverall(percent) {
    for (const key of overall.sizesByKey.keys()) {
      overall.progressByFile.set(key, Math.max(0, Math.min(100, percent)));
    }
  }

  function accountTransferBytes(deltaBytes) {
    if (!(deltaBytes > 0)) return;
    if (!overall.transferStartedAt) overall.transferStartedAt = Date.now();
    overall.transferBytes += deltaBytes;
  }

  function resetOverall(sizesByKey) {
    overall.sizesByKey = sizesByKey instanceof Map ? sizesByKey : new Map();
    overall.totalBytes = Array.from(overall.sizesByKey.values())
      .reduce((sum, size) => sum + (Number(size) || 0), 0);
    overall.progressByFile = new Map();
    overall.transferBytes = 0;
    overall.transferStartedAt = 0;
    overall.shown = 0;
    overall.completed = false;
    if (overall.hideTimer) {
      clearTimeout(overall.hideTimer);
      overall.hideTimer = null;
    }
  }

  function renderQueue() {
    if (!pending.length) {
      queue.innerHTML = '';
      folderName = null;
      return;
    }

    queue.innerHTML = '';

    // Папка показывается одной сводной строкой: в S3 она кладётся одним
    // объектом, поэтому и прогресс у неё один, а не по каждому файлу.
    if (folderName) {
      const imageCount = pending.filter(f => imageExtensions.test(f.name)).length;
      const totalSize = pending.reduce((sum, f) => sum + f.size, 0);

      const li = buildQueueRow(deviceId, 'folder', {
        name: folderName,
        sizeText: formatBytes(totalSize),
        glyph: getFolderIcon(18)
      });

      const meta = li.querySelector(`#m_${deviceId}_folder`);
      if (meta) {
        meta.textContent = [
          formatBytes(totalSize),
          `${imageCount} ${pluralFiles(imageCount)}`,
          UPLOAD_STATES.queued.label
        ].join(' · ');
      }

      queue.appendChild(li);
      setUploadState(deviceId, 'folder', 'queued');
      return;
    }

    pending.forEach((f, i) => {
      const li = buildQueueRow(deviceId, i, {
        name: f.name,
        sizeText: formatBytes(f.size),
        glyph: getFileGlyph(f.name)
      });
      queue.appendChild(li);
      setUploadState(deviceId, i, 'queued');
    });
  }

  // «1 файл / 2 файла / 5 файлов» — без этого в интерфейсе появляются
  // конструкции вроде «1 файла».
  function pluralFiles(count) {
    const n = Math.abs(Number(count) || 0);
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'файл';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'файла';
    return 'файлов';
  }

  // Глиф по типу файла: видео, изображение, документ, архив. Помогает
  // сканировать очередь глазами, не читая названия.
  const VIDEO_RE = /\.(mp4|mkv|webm|mov|m4v|avi|mpe?g)$/i;

  // Набор иконок в проекте ограничен (общие svg-icons.js), поэтому глиф
  // различается только по принципу «видео против остального»: плёнка
  // читается мгновенно, остальное — обычный файл.
  function getFileGlyph(name) {
    return VIDEO_RE.test(name) ? getFilmIcon(18) : getFileIcon(18);
  }

  function addToQueue(files) {
    const rejected = [];
    for (const f of files) {
      // Проверка расширения
      if (!allowed.test(f.name)) {
        rejected.push({ name: f.name, reason: 'Неподдерживаемый формат' });
        continue;
      }
      
      // Проверка размера файла
      if (f.size > MAX_FILE_SIZE) {
        rejected.push({ 
          name: f.name, 
          reason: `Размер ${(f.size/1024/1024/1024).toFixed(2)} GB превышает лимит 5 GB` 
        });
        continue;
      }
      
      pending.push(f);
    }
    
    // Показываем предупреждение о отклоненных файлах
    if (rejected.length > 0) {
      const messages = rejected.map(r => `• ${r.name}\n  ${r.reason}`).join('\n\n');
      reportUploadNotification({
        type: 'upload_rejected_files',
        severity: 'warning',
        title: 'Часть файлов отклонена',
        message: 'Некоторые файлы не были добавлены в очередь загрузки',
        key: `upload-rejected:${deviceId}`,
        details: {
          deviceId,
          rejectedCount: rejected.length,
          rejected
        }
      });
    }
    
    renderQueue();
  }

  pickBtn.onclick = () => fileInput.click();
  pickFolderBtn.onclick = () => {
    if (folderInput) {
      folderInput.click();
    }
  };
  clearBtn.onclick = async () => {
    pending = [];
    folderName = null;
    renderQueue();
    // «Очистить» сбрасывает и идущую загрузку: панель не должна остаться
    // висеть с процентами по уже отменённым файлам.
    hideOverall();

    isClearingUploads = true;

    if (activeUploadRequests.size > 0) {
      for (const xhr of Array.from(activeUploadRequests)) {
        try {
          xhr.abort();
        } catch (error) {
          console.warn('[Upload] Не удалось прервать XMLHttpRequest:', error);
        }
      }
      activeUploadRequests.clear();
    }

    if (isUploading) {
      isUploading = false;
      uploadingDevices.delete(deviceId);
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Загрузить';
    }

    try {
      const cancelRes = await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/download-url/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true })
      });
      const cancelData = await cancelRes.json();

      if (!cancelRes.ok || !cancelData?.ok) {
        throw new Error(cancelData?.error || 'Не удалось отменить задачи загрузки');
      }

      const runtime = getYtRuntime(deviceId);
      if (cancelData.cancelled > 0 || (runtime.jobId && YTDLP_ACTIVE_STATUSES.has(runtime.status))) {
        stopYtDownloadPolling(deviceId);
        setYtRuntime(deviceId, {
          jobId: null,
          status: 'cancelled',
          error: 'Загрузка отменена пользователем',
          speed: null,
          eta: null,
          visible: true,
          synced: false
        });
      } else {
        stopYtDownloadPolling(deviceId);
        setYtRuntime(deviceId, {
          jobId: null,
          status: 'idle',
          progress: 0,
          speed: null,
          eta: null,
          fileName: null,
          title: null,
          error: null,
          visible: false,
          synced: false
        });
      }
    } catch (error) {
      console.warn('[Upload] Не удалось отменить задачи загрузки:', error);
      syncYtDownloadUI();
    } finally {
      isClearingUploads = false;
      syncYtDownloadUI();
    }
  };
  fileInput.onchange = e => { 
    folderName = null; // Сбрасываем режим папки
    addToQueue(Array.from(e.target.files || [])); 
    fileInput.value=''; 
  };
  
  // Обработка выбора папки
  if (folderInput) {
    folderInput.onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      
      // Фильтруем только изображения
      const imageFiles = files.filter(f => imageExtensions.test(f.name));
      
      if (imageFiles.length === 0) {
        await reportUploadNotification({
          type: 'folder_without_images',
          severity: 'warning',
          title: 'В папке нет изображений',
          message: 'Поддерживаются форматы: PNG, JPG, JPEG, GIF, WEBP',
          key: `folder-no-images:${deviceId}`,
          details: {
            deviceId,
            selectedCount: files.length
          }
        });
        folderInput.value = '';
        return;
      }
      
      // Определяем имя папки из первого файла
      // webkitRelativePath имеет формат "folder/subfolder/file.jpg"
      const firstFile = imageFiles[0];
      if (firstFile.webkitRelativePath) {
        const pathParts = firstFile.webkitRelativePath.split('/');
        folderName = pathParts[0]; // Имя корневой папки
      } else {
        folderName = 'uploaded_folder';
      }
      
      // Проверка размера файлов в папке
      const rejected = [];
      const validFiles = [];
      for (const f of imageFiles) {
        if (f.size > MAX_FILE_SIZE) {
          rejected.push({ 
            name: f.name, 
            reason: `Размер ${(f.size/1024/1024/1024).toFixed(2)} GB превышает лимит 5 GB` 
          });
        } else {
          validFiles.push(f);
        }
      }
      
      if (rejected.length > 0) {
        await reportUploadNotification({
          type: 'folder_rejected_files',
          severity: 'warning',
          title: 'Часть файлов из папки отклонена',
          message: 'Некоторые изображения превышают лимит 5 GB и не будут загружены',
          key: `folder-rejected:${deviceId}`,
          details: {
            deviceId,
            folderName,
            rejectedCount: rejected.length,
            rejected
          }
        });
      }
      
      if (validFiles.length === 0) {
        await reportUploadNotification({
          type: 'folder_no_valid_files',
          severity: 'warning',
          title: 'Нет файлов для загрузки',
          message: 'Все файлы превышают лимит 5 GB',
          key: `folder-no-valid:${deviceId}`,
          details: {
            deviceId,
            folderName,
            imageFiles: imageFiles.length
          }
        });
        folderInput.value = '';
        return;
      }
      
      pending = validFiles;
      renderQueue();
      folderInput.value = '';
    };
  }

  if (dropZone) {
    ['dragenter','dragover','dragleave','drop'].forEach(ev => {
      dropZone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); });
    });
    dropZone.addEventListener('dragenter', () => dropZone.classList.add('hover'));
    dropZone.addEventListener('dragover', () => dropZone.classList.add('hover'));
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('hover'));
    dropZone.addEventListener('drop', async e => {
      dropZone.classList.remove('hover');
      const dt = e.dataTransfer;
      if (!dt) return;
      
      const items = dt.items;
      if (items && items.length > 0) {
        // Проверяем, есть ли папки в перетаскиваемых элементах
        let hasFolder = false;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind === 'file') {
            const entry = item.webkitGetAsEntry?.() || item.getAsEntry?.();
            if (entry && entry.isDirectory) {
              hasFolder = true;
              // Обрабатываем первую найденную папку с изображениями
              const files = await readDirectoryRecursive(entry);
              const imageFiles = files.filter(f => imageExtensions.test(f.name));
              
              if (imageFiles.length > 0) {
                folderName = entry.name;
                
                // Проверка размера файлов в папке
                const rejected = [];
                const validFiles = [];
                for (const f of imageFiles) {
                  if (f.size > MAX_FILE_SIZE) {
                    rejected.push({ 
                      name: f.name, 
                      reason: `Размер ${(f.size/1024/1024/1024).toFixed(2)} GB превышает лимит 5 GB` 
                    });
                  } else {
                    validFiles.push(f);
                  }
                }
                
                if (rejected.length > 0) {
                  await reportUploadNotification({
                    type: 'drop_folder_rejected_files',
                    severity: 'warning',
                    title: 'Часть файлов из папки отклонена',
                    message: 'Некоторые изображения превышают лимит 5 GB и не будут загружены',
                    key: `drop-folder-rejected:${deviceId}`,
                    details: {
                      deviceId,
                      folderName,
                      rejectedCount: rejected.length,
                      rejected
                    }
                  });
                }
                
                if (validFiles.length === 0) {
                  await reportUploadNotification({
                    type: 'drop_folder_no_valid_files',
                    severity: 'warning',
                    title: 'Нет файлов для загрузки',
                    message: 'Все файлы превышают лимит 5 GB',
                    key: `drop-folder-no-valid:${deviceId}`,
                    details: {
                      deviceId,
                      folderName,
                      imageFiles: imageFiles.length
                    }
                  });
                  return;
                }
                
                pending = validFiles;
                renderQueue();
                return;
              }
            }
          }
        }
      }
      
      // Если папок не было, обрабатываем как обычные файлы
      folderName = null;
      addToQueue(Array.from(dt.files || []));
    });
  }
  
  // Рекурсивное чтение папки
  async function readDirectoryRecursive(dirEntry) {
    const files = [];
    const reader = dirEntry.createReader();
    
    const readEntries = () => new Promise((resolve, reject) => {
      reader.readEntries((entries) => resolve(entries), (error) => reject(error));
    });
    
    let entries = await readEntries();
    while (entries.length > 0) {
      for (const entry of entries) {
        if (entry.isFile) {
          const file = await new Promise((resolve, reject) => {
            entry.file((file) => resolve(file), (error) => reject(error));
          });
          files.push(file);
        } else if (entry.isDirectory) {
          const subFiles = await readDirectoryRecursive(entry);
          files.push(...subFiles);
        }
      }
      entries = await readEntries();
    }
    
    return files;
  }

  if (ytDownloadBtn) {
    ytDownloadBtn.onclick = async () => {
      const currentRuntime = getYtRuntime(deviceId);
      const hasTrackedActiveJob = Boolean(
        currentRuntime.jobId && YTDLP_ACTIVE_STATUSES.has(currentRuntime.status)
      );

      const inputUrl = prompt('Вставьте ссылку на видео для загрузки через yt-dlp:');
      const targetUrl = (inputUrl || '').trim();
      if (!targetUrl) return;

      if (!hasTrackedActiveJob) {
        setYtRuntime(deviceId, {
          status: 'preparing',
          progress: 0,
          speed: null,
          eta: null,
          fileName: null,
          title: null,
          error: null,
          visible: true,
          synced: false
        });
      }

      try {
        const startRes = await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/download-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: targetUrl })
        });
        const startData = await startRes.json();

        if (!startRes.ok || !startData?.ok || !startData?.jobId) {
          throw new Error(startData?.error || 'Не удалось запустить загрузку');
        }

        if (hasTrackedActiveJob) {
          await reportUploadNotification({
            type: 'yt_dlp_queued',
            severity: 'info',
            title: 'Загрузка по ссылке добавлена в очередь',
            message: `Новая задача поставлена в очередь для устройства ${deviceId}`,
            key: `yt-dlp-queued:${deviceId}:${startData.jobId}`,
            details: {
              deviceId,
              queuedJobId: startData.jobId,
              status: startData.status || 'queued'
            }
          });

          ensureYtDownloadPolling(deviceId);
          return;
        }

        setYtRuntime(deviceId, {
          jobId: startData.jobId,
          status: startData.status || 'queued',
          progress: 0,
          speed: null,
          eta: null,
          error: null,
          visible: true,
          synced: false
        });
        ensureYtDownloadPolling(deviceId);
      } catch (error) {
        if (hasTrackedActiveJob) {
          await reportUploadNotification({
            type: 'yt_dlp_queue_error',
            severity: 'warning',
            title: 'Не удалось добавить задачу в очередь',
            message: error.message,
            key: `yt-dlp-queue-error:${deviceId}`,
            details: {
              deviceId
            }
          });
          return;
        }

        setYtRuntime(deviceId, {
          jobId: null,
          status: 'failed',
          progress: 0,
          speed: null,
          eta: null,
          error: `Ошибка запуска: ${error.message}`,
          visible: true,
          synced: false
        });
      }
    };
  }

  uploadBtn.onclick = async () => {
    if (!pending.length) return;

    isUploading = true;
    uploadingDevices.add(deviceId);
    syncYtDownloadUI();
    
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Проверка...';

    // Взвешиваем файлы по размеру: без этого общая полоса считала бы файлы
    // равными и 2 ГБ видео висело бы на 0% столько же, сколько 1 МБ картинка.
    const initialSizes = new Map();
    pending.forEach((f, i) => initialSizes.set(i, Number(f.size) || 0));
    resetOverall(initialSizes);
    lastSentBytes.clear();
    folderSentBytes = 0;
    showOverall('Проверка файлов...');
    
    try {
      // STEP 1: Проверяем дубликаты ДО загрузки (экономим трафик!)
      const filesToUpload = [];
      const duplicates = [];
      const fileIndexMap = new Map(); // Маппинг файл → индекс в pending
      
      for (let i = 0; i < pending.length; i++) {
        const file = pending[i];
        fileIndexMap.set(file, i); // Запоминаем индекс
        
        
        // Вычисляем MD5 (первые 10MB для больших файлов)
        setUploadProgress(deviceId, i, 0);
        setUploadState(deviceId, i, 'checking');
        setFileOverall(i, 0);
        renderOverall(`Проверка ${i + 1}/${pending.length}…`);
        const startTime = Date.now();
        const md5 = await calculateFileMD5(file, (progress) => {
          setUploadProgress(deviceId, i, progress);
          setFileOverall(i, (progress / 100) * PHASE_CHECK_END);
        });
        const md5Time = Date.now() - startTime;
        
        
        // Проверяем дубликат на сервере. Бар остаётся на 100% от фазы MD5,
        // чтобы строка не «прыгала» назад без видимой причины.
        setUploadProgress(deviceId, i, 100);
        setUploadState(deviceId, i, 'checking', 'поиск дубликата');
        setFileOverall(i, PHASE_CHECK_END);
        
        const checkRes = await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/check-duplicate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            md5, 
            size: file.size, 
            filename: file.name 
          })
        });
        
        const checkData = await checkRes.json();
        
        if (checkData.duplicate) {
          // Дубликат найден! Копируем с другого устройства
          setUploadProgress(deviceId, i, 100);
          setUploadState(deviceId, i, 'duplicate', 'копирование');
          renderOverall(`Копирование дубликата ${i + 1}/${pending.length}…`);
          // Дубликат не передаётся по сети: его вклад ограничен фазой
          // проверки, иначе он «съедал» 75% синего сегмента без единого байта.
          setFileOverall(i, PHASE_CHECK_END);
          
          const copyRes = await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/copy-from-duplicate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceDevice: checkData.sourceDevice,
              sourceFile: checkData.sourceFile,
              targetFilename: file.name,
              originalName: file.name,
              md5,
              size: file.size
            })
          });
          
          const copyData = await copyRes.json();
          
          if (copyData.ok) {
            duplicates.push({
              name: file.name,
              from: checkData.sourceDevice,
              savedMB: copyData.savedTrafficMB
            });
            // «Скопирован» — это состояние строки, а не процент:
            // текст принадлежит meta-строке, колонка % остаётся числовой.
            markRowDone(deviceId, i, `скопирован с ${checkData.sourceDevice}`);
          }
        } else {
          // Уникальный файл - добавляем в очередь загрузки
          filesToUpload.push(file);
          setUploadProgress(deviceId, i, 0);
          setUploadState(deviceId, i, 'queued');
        }
      }
      
      // STEP 2: Загружаем только уникальные файлы ПО ОЧЕРЕДИ (последовательно)
      if (filesToUpload.length > 0) {
        uploadBtn.textContent = `Загрузка (0/${filesToUpload.length})...`;
        
        let uploadedCount = 0;
        
        // КРИТИЧНО: Если это папка, загружаем все файлы одним запросом
        // (папка должна создаваться со всеми файлами сразу)
        if (folderName) {
          const form = new FormData();
          form.append('folderName', folderName);
          
          // КРИТИЧНО: Передаем ПОЛНЫЙ список файлов которые должны быть в папке
          // (не только те что загружаются, но и все из pending)
          const allFileNamesInFolder = pending.map(f => {
            const relativePath = f.webkitRelativePath || f.name;
            // Берем только имя файла без пути
            return relativePath.includes('/') ? relativePath.split('/').pop() : relativePath;
          });
          form.append('expectedFiles', JSON.stringify(allFileNamesInFolder));
          
          filesToUpload.forEach(f => {
            const relativePath = f.webkitRelativePath || f.name;
            form.append('files', f, relativePath);
          });

          await new Promise((resolve, reject) => {
            const xhr = trackUploadRequest(new XMLHttpRequest());
            xhr.open('POST', `/api/devices/${encodeURIComponent(deviceId)}/upload`);
            setXhrAuth(xhr);
            xhr.upload.onprogress = e => {
              if (!e.lengthComputable) return;
              const percent = Math.round((e.loaded / e.total) * 100);
              setUploadProgress(deviceId, 'folder', percent);
              setUploadState(deviceId, 'folder', 'sending');
              accountTransferBytes(e.loaded - folderSentBytes);
              folderSentBytes = e.loaded;
              setFolderOverall(percent);
              renderOverall(`Загрузка папки (${percent}%)`);
            };
            xhr.onload = () => xhr.status<300 ? resolve() : reject(new Error(xhr.statusText || 'Ошибка загрузки'));
            xhr.onerror = () => reject(new Error('Ошибка сети'));
            xhr.onabort = () => reject(new Error('Загрузка отменена пользователем'));
            xhr.send(form);
          });
          
          uploadedCount = filesToUpload.length;
        } else {
          // КРИТИЧНО: Загружаем файлы ПО ОЧЕРЕДИ (один за другим)
          for (let i = 0; i < filesToUpload.length; i++) {
            const file = filesToUpload[i];
            const origIdx = fileIndexMap.get(file);
            setUploadProgress(deviceId, origIdx, 0);
            setUploadState(deviceId, origIdx, 'sending', 'подготовка');
            uploadBtn.textContent = `Загрузка (${i + 1}/${filesToUpload.length})...`;
            renderOverall(`Отправка ${i + 1}/${filesToUpload.length}…`);
            
            const form = new FormData();
            form.append('files', file);
            
            await new Promise((resolve, reject) => {
              const xhr = trackUploadRequest(new XMLHttpRequest());
              xhr.open('POST', `/api/devices/${encodeURIComponent(deviceId)}/upload`);
              setXhrAuth(xhr);
              
              xhr.upload.onprogress = e => {
                if (!e.lengthComputable) return;
                const percent = Math.round((e.loaded / e.total) * 100);
                setUploadProgress(deviceId, origIdx, percent);
                setUploadState(deviceId, origIdx, 'sending');
                accountTransferBytes(e.loaded - lastSentBytes[origIdx]);
                lastSentBytes[origIdx] = e.loaded;
                setFileOverall(
                  origIdx,
                  PHASE_CHECK_END + (e.loaded / e.total) * (100 - PHASE_CHECK_END)
                );
                renderOverall(`Отправка ${i + 1}/${filesToUpload.length}…`);
              };
              
              xhr.onload = () => {
                if (xhr.status < 300) {
                  setUploadProgress(deviceId, origIdx, 100);
                  setFileOverall(origIdx, 100);
                  markRowDone(deviceId, origIdx);
                  resolve();
                } else {
                  let errorMsg = xhr.statusText || `HTTP ${xhr.status}`;
                  try {
                    const response = JSON.parse(xhr.responseText);
                    if (response.error) errorMsg = response.error;
                  } catch (e) {
                    // Игнорируем ошибку парсинга, используем statusText
                  }
                  reject(new Error(errorMsg));
                }
              };
              
              xhr.onerror = () => reject(new Error('Ошибка сети'));
              xhr.onabort = () => reject(new Error('Загрузка отменена пользователем'));
              xhr.send(form);
            }).catch(err => {
              // Обрабатываем ошибку для текущего файла
              setUploadProgress(deviceId, origIdx, 0);
              setUploadState(deviceId, origIdx, 'error', err.message);
              throw err; // Пробрасываем дальше, чтобы остановить загрузку
            });
            
            uploadedCount++;
          }
        }
        
        uploadBtn.innerHTML = `${getSuccessIcon(16)} Загружено (${uploadedCount})`;
      }
      
      // STEP 3: Показываем сводку дедупликации
      if (duplicates.length > 0) {
        const totalSavedMB = duplicates.reduce((sum, d) => sum + parseFloat(d.savedMB), 0);
        const message = duplicates.map(d => 
          `${getSuccessIcon(14)} ${d.name}\n   Скопирован с ${d.from} (${d.savedMB} MB)`
        ).join('\n\n');
      }
      
      // Итог по реальной скорости до очистки состояния, иначе панель
      // гаснет раньше, чем пользователь успевает её прочитать.
      const totalSec = overall.transferStartedAt
        ? (Date.now() - overall.transferStartedAt) / 1000
        : 0;
      const avgSpeed = totalSec > 0 ? overall.transferBytes / totalSec : 0;
      // Сегменты дводим до реального соотношения фаз, а не рисуем
      // жёсткие 100%/0%: иначе полностью «янтарная» полоса выглядит как
      // зависшая проверка, хотя всё давно отправлено.
      for (const key of overall.sizesByKey.keys()) {
        overall.progressByFile.set(key, 100);
      }
      overall.shown = 100;
      const finalSplit = overallPhaseSplit();
      if (uploadProgressCheckFill) {
        uploadProgressCheckFill.style.width = `${finalSplit.check}%`;
      }
      if (uploadProgressSendFill) {
        uploadProgressSendFill.style.width = `${finalSplit.send}%`;
      }
      if (uploadProgressLabel) {
        uploadProgressLabel.textContent = 'Загрузка завершена';
      }
      if (uploadProgressStats) {
        uploadProgressStats.textContent = avgSpeed > 1
          ? `100% · средняя ${formatBytes(avgSpeed)}/с`
          : '100%';
      }
      // Успешный финал держим несколько секунд, поэтому отмечаем completed:
      // блок finally не должен погасить панель раньше времени.
      overall.completed = true;
      if (overall.hideTimer) clearTimeout(overall.hideTimer);
      overall.hideTimer = setTimeout(() => {
        hideOverall();
        overall.hideTimer = null;
      }, 4000);

      pending = [];
      folderName = null;
      renderQueue();
      
      // Сбрасываем флаг загрузки ПЕРЕД обновлением UI,
      // чтобы emit ниже не попал под гвард isUploadingFiles
      isUploading = false;
      uploadingDevices.delete(deviceId);
      syncYtDownloadUI();
      
      // После загрузки — обновить правую колонку файлов
      await renderFilesPane(deviceId);
      
    } catch (error) {
      console.error('[Upload] Ошибка:', error);
      // Переводим стандартные сообщения об ошибках на русский
      let errorMessage = error.message;
      if (errorMessage === 'Network error' || errorMessage === 'Ошибка сети') {
        errorMessage = 'Ошибка сети';
      } else if (errorMessage === 'Upload failed' || errorMessage === 'Ошибка загрузки') {
        errorMessage = 'Ошибка загрузки';
      }

      if (errorMessage !== 'Загрузка отменена пользователем' || !isClearingUploads) {
        await reportUploadNotification({
          type: 'file_upload_error',
          severity: 'warning',
          title: 'Ошибка загрузки файлов',
          message: errorMessage,
          details: {
            deviceId,
            pendingCount: pending.length,
            folderName: folderName || null
          }
        });
      }
    } finally {
      isUploading = false; // Сбрасываем флаг в любом случае
      uploadingDevices.delete(deviceId);
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Загрузить';
      // Гасим панель сразу только если загрузка сорвалась. Успешный итог
      // уже запланировал собственный таймер.
      if (!overall.completed) {
        if (overall.hideTimer) {
          clearTimeout(overall.hideTimer);
          overall.hideTimer = null;
        }
        hideOverall();
      }
      syncYtDownloadUI();
    }
  };
}

