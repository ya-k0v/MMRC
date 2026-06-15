import { setXhrAuth } from './auth.js';

const ALLOWED = /\.(mp4|webm|ogg|mkv|mov|avi|mp3|wav|m4a|png|jpg|jpeg|gif|webp|pdf|pptx|zip)$/i;
const PROCESSING_EXTENSIONS = /\.(pdf|pptx|zip|mp4|webm|ogg|mkv|mov|avi|m4v)$/i;

export function setupUploadModal(getDeviceId, getSocket) {
  const modal = document.getElementById('uploadModal');
  const closeBtn = document.getElementById('uploadModalClose');
  const openBtn = document.getElementById('uploadBtn');
  const dropZone = document.getElementById('uploadDropZone');
  const fileInput = document.getElementById('uploadFileInput');
  const queue = document.getElementById('uploadQueue');
  const progress = document.getElementById('uploadProgress');
  const progressBar = document.getElementById('uploadProgressBar');
  const progressBarContainer = progress;
  const progressText = document.getElementById('uploadProgressText');
  const progressPercent = document.getElementById('uploadProgressPercent');
  const status = document.getElementById('uploadStatus');
  const clearBtn = document.getElementById('uploadClearBtn');
  const submitBtn = document.getElementById('uploadSubmitBtn');

  let processingStatusEl = null;
  let processingInterval = null;
  let processingCleanup = null;

  if (!modal || !openBtn) return;

  let pendingFiles = [];

  function resetProgress() {
    progress.style.display = 'none';
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    progressText.textContent = '';
    submitBtn.disabled = false;
    clearBtn.disabled = false;
  }

  function show() {
    resetProgress();
    clearProcessingStatus();
    modal.style.display = 'flex';
  }
  function hide() { modal.style.display = 'none'; }

  function open() {
    const deviceId = getDeviceId();
    if (!deviceId) {
      status.textContent = 'Сначала выберите устройство';
      return;
    }
    show();
  }

  closeBtn.onclick = hide;
  modal.onclick = (e) => { if (e.target === modal) hide(); };

  openBtn.style.display = 'inline-flex';
  openBtn.onclick = open;

  function addFiles(files) {
    for (const f of files) {
      if (!ALLOWED.test(f.name)) {
        status.textContent = `Файл "${f.name}" имеет неподдерживаемый формат`;
        continue;
      }
      if (f.size > 5 * 1024 * 1024 * 1024) {
        status.textContent = `Файл "${f.name}" превышает 5GB`;
        continue;
      }
      pendingFiles.push(f);
    }
    renderQueue();
  }

  dropZone.onclick = () => fileInput.click();

  dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.style.borderColor = '#3b82f6';
    dropZone.style.background = 'var(--panel)';
  };
  dropZone.ondragleave = () => {
    dropZone.style.borderColor = 'var(--border)';
    dropZone.style.background = 'var(--panel-2)';
  };
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--border)';
    dropZone.style.background = 'var(--panel-2)';
    addFiles(e.dataTransfer.files);
  };

  fileInput.onchange = () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  };

  function renderQueue() {
    if (pendingFiles.length === 0) {
      queue.style.display = 'none';
      submitBtn.disabled = true;
      return;
    }
    queue.style.display = 'flex';
    queue.innerHTML = pendingFiles.map((f, i) =>
      `<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:var(--panel-2); border-radius:var(--radius-sm); font-size:var(--font-size-sm);">
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;">${f.name}</span>
        <span style="color:var(--muted); margin:0 8px; white-space:nowrap;">${(f.size / 1024 / 1024).toFixed(1)} MB</span>
        <button class="secondary remove-file-btn" data-index="${i}" type="button" style="padding:2px 8px; min-width:auto; border-radius:var(--radius-sm);">✕</button>
      </div>`
    ).join('');

    queue.querySelectorAll('.remove-file-btn').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.index);
        pendingFiles.splice(idx, 1);
        renderQueue();
      };
    });

    submitBtn.disabled = false;
    status.textContent = `${pendingFiles.length} файл(ов) ожидают загрузки`;
  }

  function clearProcessingStatus() {
    if (processingInterval) {
      clearInterval(processingInterval);
      processingInterval = null;
    }
    if (processingCleanup) {
      processingCleanup();
      processingCleanup = null;
    }
    if (processingStatusEl) {
      processingStatusEl.remove();
      processingStatusEl = null;
    }
  }

  function showProcessingStatus(uploadedFiles, deviceId) {
    clearProcessingStatus();
    submitBtn.disabled = true;
    clearBtn.disabled = true;

    const el = document.createElement('div');
    el.style.cssText = 'margin-top:8px; font-size:var(--font-size-sm); color:var(--muted); text-align:center;';
    el.textContent = '⏳ Идет обработка файлов...';
    status.parentNode.insertBefore(el, status.nextSibling);
    processingStatusEl = el;

    const total = uploadedFiles.length;
    let doneCount = 0;
    let started = false;
    let progressPct = 0;

    const socket = getSocket ? getSocket() : null;

    if (socket) {
      const onReady = (data) => {
        if (data.device_id === deviceId && uploadedFiles.includes(data.file)) {
          doneCount++;
          updateDisplay();
          if (doneCount >= total) finishProcessing();
        }
      };
      const onProgress = (data) => {
        if (data.device_id === deviceId && uploadedFiles.includes(data.file)) {
          started = true;
          if (typeof data.progress === 'number' && data.progress > progressPct) {
            progressPct = data.progress;
          }
          updateDisplay();
        }
      };
      socket.on('file/ready', onReady);
      socket.on('file/progress', onProgress);

      processingCleanup = () => {
        socket.off('file/ready', onReady);
        socket.off('file/progress', onProgress);
      };
    }

    function updateDisplay() {
      if (doneCount >= total) {
        el.textContent = '✅ Обработка завершена';
        return;
      }
      const pct = progressPct > 0 ? Math.min(progressPct, 99) : 0;
      el.textContent = started
        ? `⏳ Идет обработка: ${doneCount}/${total} файлов (${pct}%)`
        : `⏳ Идет обработка: ${doneCount}/${total} файлов`;
    }

    function finishProcessing() {
      clearProcessingStatus();
      status.textContent = 'Файлы успешно загружены';
      status.style.color = '#4caf50';
      pendingFiles = [];
      renderQueue();
      setTimeout(() => { hide(); status.textContent = ''; }, 2000);
    }

    processingInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/files-with-status`, { credentials: 'include' });
        if (!res.ok) return;
        const files = await res.json();
        doneCount = uploadedFiles.filter(name => {
          const found = files.find(f => f.safeName === name);
          if (found) {
            started = true;
            if (typeof found.progress === 'number' && found.progress > progressPct) {
              progressPct = found.progress;
            }
            return found.status === 'ready' && found.canPlay !== false;
          }
          const ext = '.' + name.split('.').pop();
          if (PROCESSING_EXTENSIONS.test(ext)) {
            const folderName = name.replace(/\.(pdf|pptx|zip)$/i, '');
            const folderFound = files.find(f => f.safeName === folderName);
            if (folderFound) {
              started = true;
              if (typeof folderFound.folderImageCount === 'number' && folderFound.folderImageCount > 0) {
                return true;
              }
            }
            return false;
          }
          return false;
        }).length;
        updateDisplay();
        if (doneCount >= total) {
          clearInterval(processingInterval);
          processingInterval = null;
          finishProcessing();
        }
      } catch (e) {
        // polling error, ignore
      }
    }, 3000);
  }

  clearBtn.onclick = () => {
    pendingFiles = [];
    renderQueue();
    resetProgress();
    clearProcessingStatus();
    status.textContent = '';
  };

  submitBtn.onclick = async () => {
    const deviceId = getDeviceId();
    if (!deviceId) {
      status.textContent = 'Устройство не выбрано';
      return;
    }
    if (pendingFiles.length === 0) return;

    submitBtn.disabled = true;
    clearBtn.disabled = true;
    progress.style.display = 'block';
    status.textContent = '';

    const formData = new FormData();
    for (const f of pendingFiles) {
      formData.append('files', f);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/devices/${encodeURIComponent(deviceId)}/upload`);
    setXhrAuth(xhr);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressBar.style.width = pct + '%';
        progressPercent.textContent = pct + '%';
        progressText.textContent = `Загрузка... ${(e.loaded / 1024 / 1024).toFixed(1)} MB / ${(e.total / 1024 / 1024).toFixed(1)} MB`;
      }
    };

    xhr.onload = () => {
      progressBar.style.width = '100%';
      progressPercent.textContent = '100%';
      progressText.textContent = 'Обработка...';

      if (xhr.status === 200 || xhr.status === 201) {
        let response;
        try { response = JSON.parse(xhr.responseText); } catch {}
        const needsProcessing = response && response.needsProcessing;
        const uploadedFiles = (response && response.uploaded) || [];

        if (needsProcessing && uploadedFiles.length > 0) {
          status.textContent = 'Файлы успешно загружены';
          status.style.color = '#4caf50';
          pendingFiles = [];
          renderQueue();
          showProcessingStatus(uploadedFiles, deviceId);
        } else {
          status.textContent = 'Файлы успешно загружены';
          status.style.color = '#4caf50';
          pendingFiles = [];
          renderQueue();
          setTimeout(() => { hide(); status.textContent = ''; }, 2000);
        }
      } else {
        let msg = 'Ошибка загрузки';
        try {
          const err = JSON.parse(xhr.responseText);
          msg = err.error || err.message || msg;
        } catch {}
        status.textContent = `${msg}`;
        status.style.color = '#ef5350';
        submitBtn.disabled = false;
        clearBtn.disabled = false;
      }
    };

    xhr.onerror = () => {
      status.textContent = 'Ошибка сети';
      status.style.color = '#ef5350';
      submitBtn.disabled = false;
      clearBtn.disabled = false;
    };

    xhr.send(formData);
  };

  return { open, close: hide };
}
