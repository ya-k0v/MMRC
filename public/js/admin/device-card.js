// device-card.js - ПОЛНЫЙ код renderDeviceCard из admin.js
import { DEVICE_ICONS, DEVICE_TYPE_NAMES } from '../shared/constants.js';
import { getCheckIcon, getCrossIcon, getFileIcon, getFolderIcon, getVolumeMutedIcon, getVolumeOnIcon, getVolumeUnknownIcon } from '../shared/svg-icons.js';
import { adminFetch } from './auth.js';
import { clearDetail, clearFilesPane } from './ui-helpers.js';
import { setupUploadUI } from './upload-ui.js';

export function renderDeviceCard(d, nodeNames, readyDevices, loadDevices, renderTVList, openDevice, renderFilesPane, socket) {
  const did = encodeURIComponent(d.device_id);
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user.role === 'admin';
  
  const card = document.createElement('div');
  card.className = 'card';
  card.style.display = 'flex';
  card.style.flexDirection = 'column';
  card.style.height = '100%';
  card.style.minHeight = '0';
  const name = d.name || nodeNames[d.device_id] || d.device_id;
  const playerUrl = `${window.location.origin}/player-videojs.html?device_id=${did}`;
  card.innerHTML = `
    <div class="header" style="margin-bottom:0">
      <div style="flex:1; display:flex; align-items:stretch; gap:var(--space-sm)">
        <div class="title" id="deviceName" style="flex:1; ${isAdmin ? 'cursor:pointer;' : ''} padding:var(--space-sm) var(--space-md); border-radius:var(--radius-sm); transition:all 0.2s; display:flex; align-items:center; min-height:36px; font-size:var(--font-size-base); margin:0" contenteditable="false">${name}</div>
        ${isAdmin ? `<button class="meta-lg" id="renameSaveBtn" style="display:none; min-width:36px; width:36px; height:36px; padding:0; border-radius:var(--radius-sm); flex-shrink:0; align-items:center; justify-content:center; font-size:var(--font-size-lg); line-height:1; transition:all 0.2s; box-shadow:var(--shadow-sm)" title="Сохранить">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:block">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </button>` : ''}
        ${isAdmin ? `<button class="danger meta-lg delBtn" style="min-width:36px; width:36px; height:36px; padding:0; border-radius:var(--radius-sm); flex-shrink:0; align-items:center; justify-content:center; font-size:var(--font-size-lg); line-height:1; transition:all 0.2s; box-shadow:var(--shadow-sm)" title="Удалить устройство">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:block">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>` : ''}
      </div>
    </div>
    <div class="meta" style="margin-top:var(--space-sm); margin-bottom:var(--space-sm); display:flex; align-items:center; flex-wrap:wrap; gap:4px">
      ${DEVICE_ICONS[d.deviceType] || DEVICE_ICONS['browser']} <strong>${DEVICE_TYPE_NAMES[d.deviceType] || d.deviceType || 'Browser'}</strong>
      ${d.platform && d.platform !== 'Unknown' ? `<span>• ${d.platform}</span>` : ''}
      ${d.ipAddress ? `<span>• IP: ${d.ipAddress}</span>` : ''}
      <span>• ID: ${d.device_id}</span>
      <span>• Файлов: ${d.files?.length || 0}</span>
      <span style="display:inline-flex; align-items:center;">• ${readyDevices.has(d.device_id) ? getCheckIcon(14, 'var(--success)') + ' Готов' : getCrossIcon(14, 'var(--danger)') + ' Не готов'}</span>
      <span>• <a href="#" style="color:var(--primary); text-decoration:underline; cursor:pointer;" class="playerLink" data-url="${playerUrl}">Плеер</a></span>
    </div>

    <!-- Превью (визуальный контроль) -->
    <div class="preview-container" style="margin-top:var(--space-md); padding:var(--space-md); display:flex; flex-direction:column; gap:var(--space-sm);">
      <div class="preview panel preview-compact" style="display:block; aspect-ratio:16/9; max-height:120px; width:100%; position:relative; border-radius:var(--radius-md); overflow:hidden; background:rgba(0,0,0,.06);">
        <div class="previewHolder" style="width:100%; height:100%; border-radius:var(--radius-md); overflow:hidden;">
          <iframe src="/player-videojs.html?device_id=${did}&preview=1&muted=1" style="width:100%; height:100%; border:0;"></iframe>
        </div>
      </div>
      <div class="preview panel preview-expanded" style="display:none; flex:1 1 auto; min-height:0; aspect-ratio:16/9; max-height:380px; position:relative; border-radius:var(--radius-md); overflow:hidden; background:rgba(0,0,0,.06);">
        <div class="previewHolder" style="width:100%; height:100%; border-radius:var(--radius-md); overflow:hidden">
          <iframe src="/player-videojs.html?device_id=${did}&preview=1&muted=1" style="width:100%; height:100%; border:0"></iframe>
        </div>
      </div>
    </div>

    <!-- Управление воспроизведением -->
    <div class="device-controls-row" style="margin-top:var(--space-md); display:grid; grid-template-columns:1fr; gap:var(--space-md); align-items:stretch;">
      <!-- Громкость -->
      <div class="card" style="padding:var(--space-md); display:flex; flex-direction:column; gap:var(--space-sm);" id="adminVolumePanel">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm);">
          <div class="title" style="margin:0; font-size:var(--font-size-base)">Громкость</div>
          <div style="display:flex; align-items:center; gap:var(--space-sm); flex-wrap:wrap;">
            <div class="meta" id="adminVolumeStatus" style="color:var(--muted); font-size:var(--font-size-sm);">Выберите устройство</div>
            <div class="meta" id="adminVolumeValue" style="font-weight:600">--%</div>
            <button class="meta-lg" id="adminVolumeMute" style="min-width:auto; padding:4px 12px; display:flex; align-items:center; justify-content:center;" type="button" disabled>
              <span class="volume-btn-icon" aria-hidden="true">${getVolumeUnknownIcon(20, 'var(--muted)')}</span>
            </button>
          </div>
        </div>
        <input type="range" id="adminVolumeSlider" min="0" max="100" step="5" value="50" disabled style="width:100%"/>
      </div>
    </div>

    <div class="uploadBox card" style="margin-top:var(--space-md)">
      <div class="header" style="display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm); margin-bottom:var(--space-sm);">
        <div class="title" style="margin:0; font-size:var(--font-size-base)">Загрузка файлов</div>
        <button class="meta-lg queueToggleBtn" style="min-width:auto; padding:4px 8px; display:none;" title="Показать очередь">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
      </div>
      <div style="display:flex; gap:var(--space-sm); flex-wrap:wrap; width:100%">
        <input type="file" class="fileInput" multiple accept=".mp4,.webm,.ogg,.mkv,.mov,.avi,.mp3,.wav,.m4a,.png,.jpg,.jpeg,.gif,.webp,.pdf,.pptx,.zip" style="display:none"/>
        <input type="file" class="folderInput" webkitdirectory directory multiple style="display:none"/>
        <button class="meta-lg pickBtn" style="flex:1; min-width:90px; display:flex; align-items:center; justify-content:center; gap:4px;">${getFileIcon(14)}<span>Файлы</span></button>
        <button class="meta-lg pickFolderBtn" style="flex:1; min-width:90px; display:flex; align-items:center; justify-content:center; gap:4px;">${getFolderIcon(14)}<span>Папка</span></button>
        ${isAdmin ? '<button class="meta-lg addStreamBtn" style="flex:1; min-width:90px;">+ Стрим</button>' : ''}
        <button class="danger meta-lg clearBtn" style="flex:1; min-width:90px;">Очистить</button>
        <button class="primary meta-lg uploadBtn" style="flex:1; min-width:90px;">Загрузить</button>
      </div>
      <div class="dropZone" style="margin-top:var(--space-sm); min-height:60px; padding:var(--space-md); font-size:var(--font-size-sm);">
        Перетащите файлы/папки сюда или нажмите "${getFileIcon(12)} Файлы" / "${getFolderIcon(12)} Папка"
      </div>
      <ul class="queue" style="display:none; margin-top:var(--space-sm); max-height:200px; overflow-y:auto; list-style:none; padding:0; margin-left:0;"></ul>
    </div>
  `;

  // Обработчик ссылки на плеер в meta (копирование в буфер обмена)
  const playerLink = card.querySelector('.playerLink');
  if (playerLink) {
    playerLink.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = playerLink.getAttribute('data-url');
      
      // Функция копирования с fallback
      const copyToClipboard = (text) => {
        // Пробуем использовать Clipboard API
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
        }
        
        // Fallback: используем старый метод через textarea
        try {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.left = '-999999px';
          textarea.style.top = '-999999px';
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          
          const successful = document.execCommand('copy');
          document.body.removeChild(textarea);
          
          return successful ? Promise.resolve(true) : Promise.resolve(false);
        } catch (err) {
          console.error('Failed to copy URL:', err);
          return Promise.resolve(false);
        }
      };
      
      copyToClipboard(url).then((success) => {
        if (success) {
          const orig = playerLink.textContent;
          playerLink.textContent = 'Скопировано!';
          setTimeout(() => {
            playerLink.textContent = orig;
          }, 1000);
        } else {
          // Если не удалось скопировать, показываем URL в prompt
          const userUrl = prompt('Скопируйте URL плеера:', url);
          if (userUrl) {
            // Пользователь мог скопировать вручную
            playerLink.textContent = 'Скопировано!';
            setTimeout(() => {
              playerLink.textContent = 'Плеер';
            }, 1000);
          }
        }
      });
    };
  }
  
  // Удаление только для admin
  const delBtn = card.querySelector('.delBtn');
  if (delBtn) {
    delBtn.onclick = async () => {
    if (!confirm(`Удалить устройство ${d.device_id}?`)) return;
    await adminFetch(`/api/devices/${encodeURIComponent(d.device_id)}`, { method:'DELETE' });
    await loadDevices();
    clearDetail();
    clearFilesPane();
    renderTVList();
  };
  }

  // Inline редактирование имени устройства (только для admin)
  const nameEl = card.querySelector('#deviceName');
  const saveBtn = card.querySelector('#renameSaveBtn');
  let originalName = name;
  let isEditing = false;
  let savingFromButton = false;

  if (nameEl && isAdmin) {
    nameEl.addEventListener('click', () => {
      if (!isEditing) {
        isEditing = true;
        originalName = nameEl.textContent.trim();
        nameEl.contentEditable = 'true';
        nameEl.style.background = 'var(--bg-input)';
        nameEl.style.border = 'var(--border)';
        nameEl.style.padding = 'var(--space-sm) var(--space-md)';
        nameEl.focus();
        // Выделяем весь текст
        const range = document.createRange();
        range.selectNodeContents(nameEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        saveBtn.style.display = 'flex';
      }
    });

    nameEl.addEventListener('blur', () => {
      if (isEditing && !savingFromButton) {
        const newName = nameEl.textContent.trim();
        if (newName && newName !== originalName) {
          saveName(newName);
        } else {
          cancelEdit();
        }
      }
      savingFromButton = false;
    });

    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const newName = nameEl.textContent.trim();
        if (newName && newName !== originalName) {
          saveName(newName);
        } else {
          cancelEdit();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    });

    const saveName = async (newName) => {
      try {
        await adminFetch(`/api/devices/${encodeURIComponent(d.device_id)}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName })
        });
        await loadDevices();
        renderTVList();
        openDevice(d.device_id);
      } catch (err) {
        console.error('Failed to rename device:', err);
        cancelEdit();
      }
    };

    const cancelEdit = () => {
      isEditing = false;
      nameEl.contentEditable = 'false';
      nameEl.textContent = originalName;
      nameEl.style.background = 'transparent';
      nameEl.style.border = 'none';
      nameEl.style.padding = 'var(--space-sm) var(--space-md)';
      saveBtn.style.display = 'none';
    };

    if (saveBtn) {
      saveBtn.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        savingFromButton = true;
        const newName = nameEl.textContent.trim();
        if (newName && newName !== originalName) {
          await saveName(newName);
        } else {
          cancelEdit();
        }
      });
    }
  }

  // Инициализация загрузки
  setupUploadUI(card, d.device_id, document.getElementById('filesPanel'), renderFilesPane, socket);

  // Вспомогательная функция для определения типа потока
  function guessStreamProtocolFromUrl(url = '') {
    const lower = url.toLowerCase();
    if (lower.includes('.m3u8') || lower.includes('format=m3u8')) return 'hls';
    if (lower.includes('.mpd') || lower.includes('format=mpd') || lower.includes('dash')) return 'dash';
    return 'mpegts';
  }

  // Обработчик кнопки добавления стрима
  const addStreamBtn = card.querySelector('.addStreamBtn');
  if (addStreamBtn && isAdmin) {
    addStreamBtn.onclick = async () => {
      const name = prompt('Название стрима');
      if (!name) return;
      const url = prompt('URL стрима (http/https)');
      if (!url) return;
      const suggested = guessStreamProtocolFromUrl(url);
      const protoInput = prompt('Тип потока (hls/dash/mpegts, пусто = авто)', suggested || 'auto');
      const protocol = (protoInput || '').trim().toLowerCase() || 'auto';
      try {
        const res = await adminFetch(`/api/devices/${encodeURIComponent(d.device_id)}/streams`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), url: url.trim(), protocol })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Не удалось создать стрим');
        }
        await renderFilesPane(d.device_id);
      } catch (error) {
        alert(error.message || 'Ошибка создания стрима');
      }
    };
  }

  // Функционал переключения превью (компактное/развернутое)
  const previewToggleBtn = card.querySelector('.previewToggleBtn');
  const previewCompact = card.querySelector('.preview-compact');
  const previewExpanded = card.querySelector('.preview-expanded');
  const previewContainer = card.querySelector('.preview-container');
  const controlsRow = card.querySelector('.device-controls-row');
  let isPreviewExpanded = false;

  if (previewToggleBtn && previewCompact && previewExpanded && controlsRow) {
    previewToggleBtn.onclick = () => {
      isPreviewExpanded = !isPreviewExpanded;
      
      if (isPreviewExpanded) {
        // Разворачиваем превью - перемещаем в отдельную строку
        previewCompact.style.display = 'none';
        previewExpanded.style.display = 'block';
        previewContainer.style.gridColumn = '1 / -1'; // Занимает обе колонки
        previewContainer.style.gridRow = '2'; // Перемещаем во вторую строку
        previewToggleBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3m18 0v3a2 2 0 0 1-2 2h-3M3 8V5a2 2 0 0 1 2-2h3"></path>
          </svg>
        `;
        previewToggleBtn.title = 'Свернуть превью';
        
        // Обновляем iframe в развернутом превью
        const expandedIframe = previewExpanded.querySelector('iframe');
        if (expandedIframe) {
          expandedIframe.src = `/player-videojs.html?device_id=${did}&preview=1&muted=1&t=${Date.now()}`;
        }
      } else {
        // Сворачиваем превью - возвращаем в одну колонку
        previewCompact.style.display = 'block';
        previewExpanded.style.display = 'none';
        previewContainer.style.gridColumn = ''; // Возвращаем в одну колонку
        previewContainer.style.gridRow = ''; // Возвращаем в первую строку
        previewToggleBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
          </svg>
        `;
        previewToggleBtn.title = 'Развернуть превью';
      }
    };
  }

  // Функционал показа/скрытия очереди загрузки
  const queueToggleBtn = card.querySelector('.queueToggleBtn');
  const queue = card.querySelector('.queue');
  
  if (queueToggleBtn && queue) {
    let isQueueVisible = true; // По умолчанию показываем очередь
    
    // Показываем кнопку только если есть файлы в очереди
    const updateQueueVisibility = () => {
      const hasItems = queue.children.length > 0;
      if (hasItems) {
        queueToggleBtn.style.display = 'flex';
        // Показываем очередь по умолчанию, если она не была скрыта пользователем
        if (isQueueVisible) {
          queue.style.display = 'block';
        }
      } else {
        queueToggleBtn.style.display = 'none';
        queue.style.display = 'none';
        isQueueVisible = true; // Сбрасываем состояние при очистке
      }
    };
    
    queueToggleBtn.onclick = () => {
      isQueueVisible = !isQueueVisible;
      queue.style.display = isQueueVisible ? 'block' : 'none';
      
      queueToggleBtn.innerHTML = isQueueVisible ? `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="18 15 12 9 6 15"></polyline>
        </svg>
      ` : `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      `;
      queueToggleBtn.title = isQueueVisible ? 'Скрыть очередь' : 'Показать очередь';
    };
    
    // Наблюдаем за изменениями в очереди
    const queueObserver = new MutationObserver(updateQueueVisibility);
    queueObserver.observe(queue, { childList: true, subtree: true });
    updateQueueVisibility();
  }

  return card;
}

