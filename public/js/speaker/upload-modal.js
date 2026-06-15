import { speakerFetch, setXhrAuth } from './auth.js';

const ALLOWED = /\.(mp4|webm|ogg|mkv|mov|avi|mp3|wav|m4a|png|jpg|jpeg|gif|webp|pdf|pptx|zip)$/i;

export function setupUploadModal(user) {
  const modal = document.getElementById('uploadModal');
  const closeBtn = document.getElementById('uploadModalClose');
  const openBtn = document.getElementById('uploadBtn');
  const deviceSelect = document.getElementById('uploadDeviceSelect');
  const dropZone = document.getElementById('uploadDropZone');
  const fileInput = document.getElementById('uploadFileInput');
  const queue = document.getElementById('uploadQueue');
  const progress = document.getElementById('uploadProgress');
  const progressBar = document.getElementById('uploadProgressBar');
  const progressText = document.getElementById('uploadProgressText');
  const progressPercent = document.getElementById('uploadProgressPercent');
  const status = document.getElementById('uploadStatus');
  const clearBtn = document.getElementById('uploadClearBtn');
  const submitBtn = document.getElementById('uploadSubmitBtn');

  if (!modal || !openBtn) return;

  let pendingFiles = [];
  let devicesCache = [];

  function show() { modal.style.display = 'flex'; }
  function hide() { modal.style.display = 'none'; }

  function open() {
    loadDevices();
    show();
  }

  closeBtn.onclick = hide;
  modal.onclick = (e) => { if (e.target === modal) hide(); };

  openBtn.style.display = 'inline-flex';
  openBtn.onclick = open;

  async function loadDevices() {
    try {
      const res = await speakerFetch('/api/devices');
      const data = await res.json();
      devicesCache = data.devices || data || [];
      deviceSelect.innerHTML = `<option value="">— Выберите устройство —</option>` +
        devicesCache.map(d => `<option value="${d.device_id}">${d.name || d.device_id}</option>`).join('');
    } catch (e) {
      status.textContent = 'Ошибка загрузки устройств';
    }
  }

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

  clearBtn.onclick = () => {
    pendingFiles = [];
    renderQueue();
    progress.style.display = 'none';
    status.textContent = '';
  };

  submitBtn.onclick = async () => {
    const deviceId = deviceSelect.value;
    if (!deviceId) {
      status.textContent = 'Выберите устройство';
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
        status.textContent = '✅ Файлы успешно загружены';
        status.style.color = '#4caf50';
        pendingFiles = [];
        renderQueue();
        setTimeout(() => { hide(); status.textContent = ''; }, 2000);
      } else {
        let msg = 'Ошибка загрузки';
        try {
          const err = JSON.parse(xhr.responseText);
          msg = err.error || err.message || msg;
        } catch {}
        status.textContent = `❌ ${msg}`;
        status.style.color = '#ef5350';
        submitBtn.disabled = false;
        clearBtn.disabled = false;
      }
    };

    xhr.onerror = () => {
      status.textContent = '❌ Ошибка сети';
      status.style.color = '#ef5350';
      submitBtn.disabled = false;
      clearBtn.disabled = false;
    };

    xhr.open('POST', `/api/devices/${encodeURIComponent(deviceId)}/upload`);
    xhr.send(formData);
  };

  return { open, close: hide };
}
