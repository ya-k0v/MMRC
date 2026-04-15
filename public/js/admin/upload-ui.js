// upload-ui.js - ПОЛНЫЙ код setupUploadUI из admin.js
import { setXhrAuth, adminFetch } from './auth.js';
import { calculateFileMD5 } from './md5-helper.js';
import { getFolderIcon, getSuccessIcon } from '../shared/svg-icons.js';

const YTDLP_ACTIVE_STATUSES = new Set(['queued', 'waiting_resources', 'preparing', 'downloading', 'processing']);
const ytDownloadRuntimeByDevice = new Map();
const ytDownloadUiByDevice = new Map();

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
  if (!fileInput || !pickBtn || !clearBtn || !uploadBtn || !queue) return;

  let pending = [];
  let folderName = null; // Имя выбранной папки
  let isUploading = false; // Флаг активной загрузки (предотвращает обновление UI)
  let isClearingUploads = false;
  const activeUploadRequests = new Set();
  const allowed = /\.(mp4|webm|ogg|mkv|mov|avi|mp3|wav|m4a|png|jpg|jpeg|gif|webp|pdf|pptx|zip)$/i;
  const imageExtensions = /\.(png|jpg|jpeg|gif|webp)$/i;
  const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB
  
  // Экспортируем функцию для проверки состояния загрузки
  window.isUploadingFiles = () => isUploading;

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
        socket.emit('devices/updated');
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

  function renderQueue() {
    if (!pending.length) { 
      queue.innerHTML = ''; 
      folderName = null;
      return; 
    }
    
    // Используем DOM методы вместо innerHTML для безопасности
    queue.innerHTML = '';
    
    // Если это папка с изображениями, показываем специальное сообщение
    if (folderName) {
      const imageCount = pending.filter(f => imageExtensions.test(f.name)).length;
      const totalSize = pending.reduce((sum, f) => sum + f.size, 0);
      
      const li = document.createElement('li');
      li.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px; background:var(--panel-2); border-radius:var(--radius-sm)';
      
      const leftSpan = document.createElement('span');
      leftSpan.style.cssText = 'display:flex; align-items:center; gap:4px;';
      // getFolderIcon возвращает безопасную SVG иконку из константы
      // Используем временный контейнер для безопасного парсинга
      const iconTemp = document.createElement('span');
      iconTemp.insertAdjacentHTML('beforeend', getFolderIcon(16));
      while (iconTemp.firstChild) {
        leftSpan.appendChild(iconTemp.firstChild);
      }
      
      const folderNameStrong = document.createElement('strong');
      folderNameStrong.textContent = folderName; // Используем textContent для безопасности
      leftSpan.appendChild(folderNameStrong);
      
      const metaSpan = document.createElement('span');
      metaSpan.className = 'meta';
      metaSpan.textContent = `(${imageCount} изображений, ${(totalSize/1024/1024).toFixed(2)} MB)`;
      leftSpan.appendChild(metaSpan);
      
      const progressSpan = document.createElement('span');
      progressSpan.className = 'meta';
      progressSpan.id = `p_${deviceId}_folder`;
      progressSpan.textContent = '0%';
      
      li.appendChild(leftSpan);
      li.appendChild(progressSpan);
      queue.appendChild(li);
    } else {
      pending.forEach((f, i) => {
        const li = document.createElement('li');
        li.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border-2);';
        
        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        nameSpan.textContent = f.name; // Используем textContent для безопасности
        
        const sizeMetaSpan = document.createElement('span');
        sizeMetaSpan.className = 'meta';
        sizeMetaSpan.textContent = `(${(f.size/1024/1024).toFixed(2)} MB)`;
        nameSpan.appendChild(sizeMetaSpan);
        
        const progressSpan = document.createElement('span');
        progressSpan.className = 'meta';
        progressSpan.id = `p_${deviceId}_${i}`;
        progressSpan.style.cssText = 'flex-shrink:0; margin-left:var(--space-sm);';
        progressSpan.textContent = '0%';
        
        li.appendChild(nameSpan);
        li.appendChild(progressSpan);
        queue.appendChild(li);
      });
    }
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
    syncYtDownloadUI();
    
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Проверка...';
    
    try {
      // STEP 1: Проверяем дубликаты ДО загрузки (экономим трафик!)
      const filesToUpload = [];
      const duplicates = [];
      const fileIndexMap = new Map(); // Маппинг файл → индекс в pending
      
      for (let i = 0; i < pending.length; i++) {
        const file = pending[i];
        const progressEl = queue.querySelector(`#p_${deviceId}_${i}`);
        fileIndexMap.set(file, i); // Запоминаем индекс
        
        
        // Вычисляем MD5 (первые 10MB для больших файлов)
        if (progressEl) progressEl.textContent = 'MD5...';
        const startTime = Date.now();
        const md5 = await calculateFileMD5(file, (progress) => {
          if (progressEl) progressEl.textContent = `MD5: ${progress}%`;
        });
        const md5Time = Date.now() - startTime;
        
        
        // Проверяем дубликат на сервере
        if (progressEl) progressEl.textContent = 'Проверка...';
        
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
          if (progressEl) progressEl.textContent = 'Копирование...';
          
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
            if (progressEl) progressEl.innerHTML = `${getSuccessIcon(14)} Скопирован`;
          }
        } else {
          // Уникальный файл - добавляем в очередь загрузки
          filesToUpload.push(file);
          if (progressEl) progressEl.textContent = '0%';
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

          const folderProgressEl = queue.querySelector(`#p_${deviceId}_folder`);
          await new Promise((resolve, reject) => {
            const xhr = trackUploadRequest(new XMLHttpRequest());
            xhr.open('POST', `/api/devices/${encodeURIComponent(deviceId)}/upload`);
            setXhrAuth(xhr);
            xhr.upload.onprogress = e => {
              if (!e.lengthComputable) return;
              const percent = Math.round((e.loaded / e.total) * 100);
              if (folderProgressEl) folderProgressEl.textContent = `${percent}%`;
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
            const progressEl = queue.querySelector(`#p_${deviceId}_${origIdx}`);
            
            if (progressEl) progressEl.textContent = 'Подготовка...';
            uploadBtn.textContent = `Загрузка (${i + 1}/${filesToUpload.length})...`;
            
            const form = new FormData();
            form.append('files', file);
            
            await new Promise((resolve, reject) => {
              const xhr = trackUploadRequest(new XMLHttpRequest());
              xhr.open('POST', `/api/devices/${encodeURIComponent(deviceId)}/upload`);
              setXhrAuth(xhr);
              
              xhr.upload.onprogress = e => {
                if (!e.lengthComputable) return;
                const percent = Math.round((e.loaded / e.total) * 100);
                if (progressEl) progressEl.textContent = `${percent}%`;
              };
              
              xhr.onload = () => {
                if (xhr.status < 300) {
                  if (progressEl) progressEl.innerHTML = getSuccessIcon(14);
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
              if (progressEl) progressEl.textContent = `❌ ${err.message}`;
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
      
      pending = [];
      folderName = null;
      renderQueue();
      
      // Сбрасываем флаг загрузки ПЕРЕД обновлением UI
      isUploading = false;
      syncYtDownloadUI();
      
      // После загрузки — обновить правую колонку файлов
      await renderFilesPane(deviceId);
      socket.emit('devices/updated');
      
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
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Загрузить';
      syncYtDownloadUI();
    }
  };
}

