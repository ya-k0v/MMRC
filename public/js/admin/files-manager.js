// files-manager.js - ПОЛНЫЙ код управления файлами из admin.js
import { adminFetch } from './auth.js';
import { getCheckIcon, getCrossIcon, getClockIcon } from '../shared/svg-icons.js';
import { formatTime } from '../shared/formatters.js';
import { escapeHtml } from '../shared/utils.js';
import {
  VIDEO_EXTENSIONS,
  STATIC_CONTENT_TYPES,
  resolveContentType,
  getFileExtension,
  getContentTypeInfo
} from '../shared/content-type-helper.js';

/**
 * Универсальная функция для показа модального окна стрима (добавление/редактирование)
 * @param {Object} options
 * @param {string} options.deviceId - ID устройства
 * @param {string} options.mode - 'add' или 'edit'
 * @param {string} [options.safeName] - Имя файла (только для режима edit)
 * @param {string} [options.originalName] - Отображаемое имя (только для режима edit)
 * @param {string} [options.streamUrl] - URL стрима (только для режима edit)
 * @param {string} [options.streamProtocol] - Протокол стрима (только для режима edit)
 * @param {Function} [options.onSuccess] - Callback после успешного сохранения
 */
export async function showStreamModal({ deviceId, mode = 'add', safeName = null, originalName = '', streamUrl = '', streamProtocol = 'auto', onSuccess = null }) {
  const { showModal, closeModal } = await import('./modal.js');
  
  const isEdit = mode === 'edit';
  const title = isEdit ? 'Изменить стрим' : 'Добавить стрим';
  
  const content = `
    <div style="display:flex; flex-direction:column; gap:var(--space-md);">
      <div>
        <label style="display:block; margin-bottom:4px; font-weight:500;">Название стрима</label>
        <input id="streamModalName" class="input" value="${escapeHtml(originalName || '')}" placeholder="Название стрима" />
      </div>
      
      <div>
        <label style="display:block; margin-bottom:4px; font-weight:500;">URL стрима</label>
        <input id="streamModalUrl" class="input" value="${escapeHtml(streamUrl || '')}" placeholder="https://example.com/stream.m3u8" spellcheck="false" />
        <div class="meta" style="margin-top:4px; font-size:0.85rem; color:var(--text-secondary);">
          Поддерживаются HTTP/HTTPS стримы (HLS, DASH, MPEG-TS)
        </div>
      </div>
      
      <div>
        <label style="display:block; margin-bottom:4px; font-weight:500;">Протокол</label>
        <select id="streamModalProtocol" class="input">
          <option value="auto" ${streamProtocol === 'auto' || !streamProtocol ? 'selected' : ''}>Автоопределение</option>
          <option value="hls" ${streamProtocol === 'hls' ? 'selected' : ''}>HLS (.m3u8)</option>
          <option value="dash" ${streamProtocol === 'dash' ? 'selected' : ''}>DASH (.mpd)</option>
          <option value="mpegts" ${streamProtocol === 'mpegts' ? 'selected' : ''}>MPEG-TS</option>
        </select>
        <div class="meta" style="margin-top:4px; font-size:0.85rem; color:var(--text-secondary);">
          Если не уверены, оставьте "Автоопределение"
        </div>
      </div>
      
      <div id="streamModalError" style="color:var(--danger); font-size:0.875rem; display:none;"></div>
      
      <div style="display:flex; gap:var(--space-sm);">
        <button id="streamModalSaveBtn" class="primary" style="flex:1;">${isEdit ? 'Сохранить' : 'Добавить'}</button>
        <button id="streamModalCancelBtn" class="secondary" style="flex:1;">Отмена</button>
      </div>
    </div>
  `;
  
  showModal(title, content);
  
  // Обработчики после рендера модального окна
  setTimeout(() => {
    const nameInput = document.getElementById('streamModalName');
    const urlInput = document.getElementById('streamModalUrl');
    const protocolSelect = document.getElementById('streamModalProtocol');
    const saveBtn = document.getElementById('streamModalSaveBtn');
    const cancelBtn = document.getElementById('streamModalCancelBtn');
    const errorEl = document.getElementById('streamModalError');
    
    if (!nameInput || !urlInput || !protocolSelect || !saveBtn || !cancelBtn) return;
    
    // Автоопределение протокола при вводе URL
    urlInput.addEventListener('input', () => {
      const url = urlInput.value.trim().toLowerCase();
      if (!url) return;
      
      // Автоматически определяем протокол
      if (url.includes('.m3u8') || url.includes('format=m3u8')) {
        protocolSelect.value = 'hls';
      } else if (url.includes('.mpd') || url.includes('format=mpd') || url.includes('dash')) {
        protocolSelect.value = 'dash';
      } else if (protocolSelect.value === 'auto') {
        // Оставляем auto если не определили
      }
    });
    
    const doSave = async () => {
      const newName = nameInput.value.trim();
      const newUrl = urlInput.value.trim();
      const newProtocol = protocolSelect.value;
      
      if (!newName) {
        errorEl.textContent = 'Введите название стрима';
        errorEl.style.display = 'block';
        return;
      }
      
      if (!newUrl) {
        errorEl.textContent = 'Введите URL стрима';
        errorEl.style.display = 'block';
        return;
      }
      
      // Валидация URL
      try {
        const urlObj = new URL(newUrl);
        if (!['http:', 'https:'].includes(urlObj.protocol)) {
          errorEl.textContent = 'Поддерживаются только HTTP/HTTPS стримы';
          errorEl.style.display = 'block';
          return;
        }
      } catch (e) {
        errorEl.textContent = 'Некорректный URL';
        errorEl.style.display = 'block';
        return;
      }
      
      saveBtn.disabled = true;
      saveBtn.textContent = isEdit ? 'Сохранение...' : 'Добавление...';
      errorEl.style.display = 'none';
      
      try {
        let res;
        if (isEdit) {
          // Редактирование существующего стрима
          res = await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/streams/${encodeURIComponent(safeName)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: newName,
              url: newUrl,
              protocol: newProtocol
            })
          });
        } else {
          // Добавление нового стрима
          res = await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/streams`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: newName,
              url: newUrl,
              protocol: newProtocol
            })
          });
        }
        
        if (res.ok) {
          closeModal();
          if (onSuccess) {
            await onSuccess();
          }
        } else {
          const error = await res.json();
          errorEl.textContent = error.error || (isEdit ? 'Ошибка сохранения' : 'Ошибка добавления');
          errorEl.style.display = 'block';
          saveBtn.disabled = false;
          saveBtn.textContent = isEdit ? 'Сохранить' : 'Добавить';
        }
      } catch (err) {
        errorEl.textContent = 'Ошибка подключения';
        errorEl.style.display = 'block';
        saveBtn.disabled = false;
        saveBtn.textContent = isEdit ? 'Сохранить' : 'Добавить';
      }
    };
    
    saveBtn.onclick = doSave;
    cancelBtn.onclick = () => closeModal();
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') urlInput.focus(); });
    
    // Фокус на первое пустое поле
    if (isEdit) {
      nameInput.focus();
    } else {
      nameInput.focus();
    }
  }, 100);
}

export async function loadFilesWithStatus(deviceId) {
  const res = await adminFetch(`/api/devices/${deviceId}/files-with-status`);
  return await res.json();
}

export async function refreshFilesPanel(deviceId, panelEl, adminFetch, getPageSize, filePage, socket, onPageUpdate = null) {
  // НОВОЕ: Используем API с статусами файлов
  const res = await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/files-with-status`);
  const filesData = await res.json();
  
  // Файлы уже в формате { safeName, originalName, status, progress, canPlay, error, resolution, isPlaceholder }
  const allFiles = filesData.map(item => {
    if (typeof item === 'string') {
      // Старый формат (для обратной совместимости)
      return { safeName: item, originalName: item, status: 'ready', progress: 100, canPlay: true, resolution: null, isPlaceholder: false, durationSeconds: null, folderImageCount: null, contentType: null, streamUrl: null, streamProxyUrl: null };
    }
    return { 
      safeName: item.safeName || item.name || '',
      originalName: item.originalName || item.safeName || item.name || 'unknown',
      status: item.status || 'ready',
      progress: item.progress || 100,
      canPlay: item.canPlay !== false,
      error: item.error || null,
      resolution: item.resolution || null,
      isPlaceholder: !!item.isPlaceholder,  // НОВОЕ: Флаг заглушки
      durationSeconds: typeof item.durationSeconds === 'number' ? item.durationSeconds : null,
      folderImageCount: typeof item.folderImageCount === 'number' ? item.folderImageCount : null,
      contentType: item.contentType || null,
      streamUrl: item.streamUrl || null,
      streamProxyUrl: item.streamProxyUrl || null,
      streamProtocol: item.streamProtocol || null
    };
  }).filter(f => f.safeName); // Фильтруем пустые имена
  
  // НОВОЕ: Сортируем - заглушка всегда первая
  allFiles.sort((a, b) => {
    if (a.isPlaceholder && !b.isPlaceholder) return -1;
    if (!a.isPlaceholder && b.isPlaceholder) return 1;
    return a.originalName.localeCompare(b.originalName, 'ru', { numeric: true });
  });
  
  if (!allFiles || allFiles.length === 0) {
    // Используем DOM методы вместо innerHTML
    panelEl.innerHTML = '';
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'meta';
    emptyDiv.style.cssText = 'text-align:center; padding:var(--space-xl)';
    emptyDiv.textContent = 'Нет файлов. Загрузите файлы через панель слева.';
    panelEl.appendChild(emptyDiv);
    // Очистить пейджер файлов если есть (теперь находится в filesPane, а не в panelEl)
    const filesPane = document.getElementById('filesPane');
    const pager = filesPane ? filesPane.querySelector('#filePagerAdmin') : null;
    if (pager) pager.innerHTML = '';
    return;
  }
  
  // Пагинация файлов
  const pageSize = getPageSize();
  const totalPages = Math.max(1, Math.ceil(allFiles.length / pageSize));
  // ИСПРАВЛЕНО: Корректируем страницу если она выходит за пределы
  let currentPage = filePage;
  if (currentPage >= totalPages) currentPage = Math.max(0, totalPages - 1);
  if (currentPage < 0) currentPage = 0;
  const start = currentPage * pageSize;
  const end = Math.min(start + pageSize, allFiles.length);
  const files = allFiles.slice(start, end);
  
  // Используем DOM методы вместо innerHTML для безопасности
  panelEl.innerHTML = '';
  const fileList = document.createElement('ul');
  fileList.className = 'list';
  fileList.style.cssText = 'display:grid; gap:var(--space-sm)';
  
  files.forEach(({ safeName, originalName, status, progress, canPlay, error, resolution, isPlaceholder, durationSeconds, folderImageCount, contentType, streamUrl, streamProtocol }) => {
        // placeholders allowed only for image/video (no pdf/pptx/folders)
        const isStreaming = contentType === 'streaming';
        const isEligible = !isStreaming && /\.(mp4|webm|ogg|mkv|mov|avi|mp3|wav|m4a|png|jpg|jpeg|gif|webp)$/i.test(safeName);
        
        // safeExt из safeName - для проверок типа файла на диске
        const safeExt = getFileExtension(safeName);
        
        // НОВОЕ: Убираем расширение из отображаемого имени (как на спикере)
        const displayName = originalName.replace(/\.[^.]+$/, '');
        
        // Определяем метку типа файла
        // КРИТИЧНО: Сначала проверяем contentType из метаданных БД, потом fallback на расширение
        let typeLabel = 'VID'; // По умолчанию
        const normalizedType = resolveContentType({
          contentType,
          fileName: safeName,
          originalName,
          fallbackToFolder: true
        });
        if (normalizedType === 'streaming') {
          typeLabel = 'STREAM';
        } else if (normalizedType && normalizedType !== 'unknown') {
          typeLabel = getContentTypeInfo(normalizedType, streamProtocol).shortLabel;
        }
        
        // НОВОЕ: Определяем статус для видео из safeExt (фактический файл)
        const isVideo = !isStreaming && (normalizedType === 'video' || VIDEO_EXTENSIONS.includes(safeExt));
        const fileStatus = status || 'ready';
        const isProcessing = fileStatus === 'processing' || fileStatus === 'checking';
        const hasError = fileStatus === 'error';
        const fileProgress = progress || 100;
        
        // Определяем разрешение для видео
        let resolutionLabel = '';
        if (isVideo && resolution) {
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
        
        // Иконки статуса
        let statusIcon = '';
        let statusText = '';
        let statusColor = '';
        
        const isStaticDoc = STATIC_CONTENT_TYPES.has(normalizedType);
        
        if (isVideo || isStaticDoc) {
          if (isProcessing) {
            statusColor = 'var(--warning)';
            statusIcon = getClockIcon(14, statusColor);
            statusText = `Обработка... ${fileProgress}%`;
          } else if (hasError) {
            statusColor = 'var(--danger)';
            statusIcon = getCrossIcon(14, statusColor);
            statusText = 'Ошибка обработки';
          } else if (fileStatus === 'ready') {
            statusColor = 'var(--success)';
            statusIcon = getCheckIcon(14, statusColor);
            statusText = 'Готов';
          }
        }
        
        const metaBadges = [];
        if (typeLabel === 'FOLDER' && folderImageCount !== null) {
          metaBadges.push(`${folderImageCount} фото`);
        }
        if (isVideo && durationSeconds && typeof durationSeconds === 'number' && durationSeconds > 0) {
          metaBadges.push(formatTime(durationSeconds));
        }
        if (isStreaming && streamProtocol) {
          metaBadges.unshift(streamProtocol.toUpperCase());
        }
        const typeBadge = `${typeLabel}${metaBadges.length ? ` · ${metaBadges.join(' · ')}` : ''}`;
        
        // Создаем элементы через DOM API для безопасности
        const li = document.createElement('li');
        li.className = 'file-item';
        li.draggable = canPlay;
        li.setAttribute('data-device-id', deviceId || '');
        li.setAttribute('data-file-name', encodeURIComponent(safeName));
        li.setAttribute('data-content-type', contentType || '');
        li.setAttribute('data-stream-protocol', streamProtocol || '');
        
        let bgColor = isPlaceholder ? 'rgba(59, 130, 246, 0.1)' : 'var(--panel-2)';
        let borderLeft = isPlaceholder ? 'border-left: 3px solid rgba(59, 130, 246, 0.6);' : '';
        let opacity = isProcessing ? 'opacity:0.7;' : '';
        let cursor = canPlay ? 'cursor:move;' : '';
        li.style.cssText = `border:var(--border); background:${bgColor}; ${borderLeft} ${opacity} ${cursor}`;
        
        const header = document.createElement('div');
        header.className = 'file-item-header';
        
        const headerLeft = document.createElement('div');
        headerLeft.style.cssText = 'flex:1; display:flex; align-items:stretch; gap:var(--space-xs); min-width:0;';
        
        if (isPlaceholder) {
          const placeholderSpan = document.createElement('span');
          placeholderSpan.style.cssText = 'background:rgba(59, 130, 246, 0.8); color:var(--panel); padding:2px 6px; border-radius:4px; font-size:0.7rem; font-weight:600; align-self:center; flex-shrink:0;';
          placeholderSpan.textContent = '📌 ЗАГЛУШКА';
          headerLeft.appendChild(placeholderSpan);
        }
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-item-name fileName-editable';
        nameSpan.setAttribute('data-safe', encodeURIComponent(safeName));
        nameSpan.setAttribute('data-original-full', encodeURIComponent(originalName));
        nameSpan.style.cssText = 'cursor:pointer; padding:var(--space-xs) var(--space-sm); border-radius:var(--radius-sm); transition:all 0.2s; flex:1; min-width:0;';
        nameSpan.contentEditable = 'false';
        nameSpan.textContent = displayName; // Используем textContent для безопасности
        
        const saveBtn = document.createElement('button');
        saveBtn.className = 'primary fileRenameSaveBtn';
        saveBtn.style.cssText = 'display:none; min-width:28px; width:28px; height:28px; padding:0; border-radius:var(--radius-sm); flex-shrink:0';
        saveBtn.title = 'Сохранить';
        const saveSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        saveSvg.setAttribute('width', '14');
        saveSvg.setAttribute('height', '14');
        saveSvg.setAttribute('viewBox', '0 0 24 24');
        saveSvg.setAttribute('fill', 'none');
        saveSvg.setAttribute('stroke', 'currentColor');
        saveSvg.setAttribute('stroke-width', '2.5');
        saveSvg.setAttribute('stroke-linecap', 'round');
        saveSvg.setAttribute('stroke-linejoin', 'round');
        saveSvg.style.display = 'block';
        const savePolyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        savePolyline.setAttribute('points', '20 6 9 17 4 12');
        saveSvg.appendChild(savePolyline);
        saveBtn.appendChild(saveSvg);
        
        headerLeft.appendChild(nameSpan);
        headerLeft.appendChild(saveBtn);
        
        const headerRight = document.createElement('div');
        headerRight.style.cssText = 'display:flex; align-items:center; gap:var(--space-sm);';
        
        if (statusText) {
          const statusSpan = document.createElement('span');
          statusSpan.style.cssText = `font-size:var(--font-size-sm); color:${statusColor}; white-space:nowrap; display:flex; align-items:center; gap:var(--space-xs);`;
          statusSpan.innerHTML = `${statusIcon} ${escapeHtml(statusText)}`;
          headerRight.appendChild(statusSpan);
        }
        
        const metaDiv = document.createElement('div');
        metaDiv.style.cssText = 'display:flex; align-items:center; gap:4px; flex-wrap:wrap;';
        
        if (resolutionLabel) {
          const resSpan = document.createElement('span');
          resSpan.style.cssText = 'font-size:10px; opacity:0.7;';
          resSpan.textContent = resolutionLabel;
          metaDiv.appendChild(resSpan);
        }
        
        const typeSpan = document.createElement('span');
        typeSpan.className = 'file-item-type';
        typeSpan.textContent = typeBadge; // Используем textContent для безопасности
        metaDiv.appendChild(typeSpan);
        
        headerRight.appendChild(metaDiv);
        header.appendChild(headerLeft);
        header.appendChild(headerRight);
        
        const actions = document.createElement('div');
        actions.className = 'file-item-actions';
        
        if (isStreaming) {
          const editBtn = document.createElement('button');
          editBtn.className = 'meta-lg editStreamBtn';
          editBtn.setAttribute('data-safe', encodeURIComponent(safeName));
          editBtn.setAttribute('data-original', encodeURIComponent(originalName));
          editBtn.setAttribute('data-stream-url', encodeURIComponent(streamUrl || ''));
          editBtn.setAttribute('data-stream-protocol', encodeURIComponent(streamProtocol || ''));
          editBtn.setAttribute('data-content-type', contentType || '');
          editBtn.title = 'Изменить стрим';
          editBtn.textContent = 'Изменить';
          actions.appendChild(editBtn);
        } else {
          const previewBtn = document.createElement('button');
          previewBtn.className = 'meta-lg previewFileBtn';
          previewBtn.setAttribute('data-safe', encodeURIComponent(safeName));
          previewBtn.setAttribute('data-original', encodeURIComponent(originalName));
          previewBtn.setAttribute('data-stream-protocol', streamProtocol || '');
          previewBtn.setAttribute('data-content-type', contentType || '');
          previewBtn.title = 'Предпросмотр';
          previewBtn.disabled = !canPlay;
          previewBtn.textContent = 'Превью';
          actions.appendChild(previewBtn);
        }
        
        if (isEligible) {
          const makeDefaultBtn = document.createElement('button');
          makeDefaultBtn.className = 'meta-lg makeDefaultBtn';
          makeDefaultBtn.setAttribute('data-safe', encodeURIComponent(safeName));
          makeDefaultBtn.setAttribute('data-original', encodeURIComponent(originalName));
          makeDefaultBtn.title = 'Сделать заглушкой';
          makeDefaultBtn.disabled = !canPlay;
          makeDefaultBtn.textContent = 'Заглушка';
          actions.appendChild(makeDefaultBtn);
        }
        
        const delBtn = document.createElement('button');
        delBtn.className = 'danger meta-lg delFileBtn';
        delBtn.setAttribute('data-safe', encodeURIComponent(safeName));
        delBtn.setAttribute('data-original', encodeURIComponent(originalName));
        delBtn.title = 'Удалить';
        delBtn.textContent = 'Удалить';
        actions.appendChild(delBtn);
        
        li.appendChild(header);
        li.appendChild(actions);
        fileList.appendChild(li);
  });
  
  panelEl.appendChild(fileList);
  
  // Рендер пейджера файлов (теперь находится вне panelEl, в filesPane)
  const filesPane = document.getElementById('filesPane');
  let filePagerAdmin = filesPane ? filesPane.querySelector('#filePagerAdmin') : null;
  
  if (totalPages > 1) {
    if (!filePagerAdmin && filesPane) {
      // Если не найден, значит он уже в HTML (создан в renderLayout)
      filePagerAdmin = filesPane.querySelector('#filePagerAdmin');
    }
    
    if (filePagerAdmin) {
      filePagerAdmin.innerHTML = '';
      const prevBtn = document.createElement('button');
      prevBtn.className = 'secondary';
      prevBtn.id = 'filePrevAdmin';
      prevBtn.disabled = currentPage <= 0;
      prevBtn.style.cssText = 'min-width:80px';
      prevBtn.textContent = 'Назад';
      filePagerAdmin.appendChild(prevBtn);
      const pageSpan = document.createElement('span');
      pageSpan.style.cssText = 'white-space:nowrap';
      pageSpan.textContent = `Стр. ${currentPage+1} из ${totalPages}`;
      filePagerAdmin.appendChild(pageSpan);
      const nextBtn = document.createElement('button');
      nextBtn.className = 'secondary';
      nextBtn.id = 'fileNextAdmin';
      nextBtn.disabled = currentPage >= totalPages - 1;
      nextBtn.style.cssText = 'min-width:80px';
      nextBtn.textContent = 'Вперед';
      filePagerAdmin.appendChild(nextBtn);
      const prev = filePagerAdmin.querySelector('#filePrevAdmin');
      const next = filePagerAdmin.querySelector('#fileNextAdmin');
      if (prev) prev.onclick = async () => { 
        if (currentPage > 0) { 
          const updatedPage = await refreshFilesPanel(deviceId, panelEl, adminFetch, getPageSize, currentPage - 1, socket, onPageUpdate);
          if (updatedPage !== undefined && onPageUpdate) {
            onPageUpdate(updatedPage);
          }
        }
      };
      if (next) next.onclick = async () => { 
        if (currentPage < totalPages - 1) { 
          const updatedPage = await refreshFilesPanel(deviceId, panelEl, adminFetch, getPageSize, currentPage + 1, socket, onPageUpdate);
          if (updatedPage !== undefined && onPageUpdate) {
            onPageUpdate(updatedPage);
          }
        }
      };
    }
  } else if (filePagerAdmin) {
    filePagerAdmin.innerHTML = '';
  }

  // Обработчик кнопки "Изменить" для стримов
  panelEl.querySelectorAll('.editStreamBtn').forEach(btn => {
    btn.onclick = async () => {
      const safeName = decodeURIComponent(btn.getAttribute('data-safe'));
      const originalName = decodeURIComponent(btn.getAttribute('data-original'));
      const currentStreamUrl = decodeURIComponent(btn.getAttribute('data-stream-url') || '');
      const currentProtocol = decodeURIComponent(btn.getAttribute('data-stream-protocol') || '');
      
      await showStreamModal({
        deviceId,
        mode: 'edit',
        safeName,
        originalName,
        streamUrl: currentStreamUrl,
        streamProtocol: currentProtocol,
        onSuccess: async () => {
          await refreshFilesPanel(deviceId, panelEl, adminFetch, getPageSize, currentPage, socket, onPageUpdate);
          socket.emit('devices/updated');
        }
      });
    };
  });

  panelEl.querySelectorAll('.previewFileBtn').forEach(btn => {
    btn.onclick = async () => {
      const safeName = decodeURIComponent(btn.getAttribute('data-safe'));
      const originalName = decodeURIComponent(btn.getAttribute('data-original') || safeName);
      const previewContainer = document.querySelector('#detailPane .previewHolder');
      if (!previewContainer) return;
      const contentType = btn.closest('.file-item')?.getAttribute('data-content-type') || null;

      // Определяем тип файла
      const normalizedType = resolveContentType({
        contentType,
        fileName: safeName,
        originalName,
        fallbackToFolder: true
      });
      const isAudio = normalizedType === 'audio';

      if (normalizedType === 'streaming') {
        const protocol = btn.getAttribute('data-stream-protocol') || '';
        const protocolParam = protocol ? `&protocol=${encodeURIComponent(protocol)}` : '';
        const iframe = document.createElement('iframe');
        iframe.src = `/player-videojs.html?device_id=${encodeURIComponent(deviceId)}&preview=1&type=streaming&file=${encodeURIComponent(safeName)}&originalName=${encodeURIComponent(originalName)}${protocolParam}`;
        iframe.style.cssText = 'width:100%;height:100%;border:0';
        iframe.allow = 'autoplay; fullscreen';
        previewContainer.innerHTML = '';
        previewContainer.appendChild(iframe);
        return;
      }

      if (isAudio) {
        // Для аудио: всегда очищаем контейнер и показываем только один iframe с логотипом аудио
        const audioPreviewUrl = `/player-videojs.html?device_id=${encodeURIComponent(deviceId)}&preview=1&type=audio&file=${encodeURIComponent(safeName)}`;
        previewContainer.innerHTML = '';
        const frame = document.createElement('iframe');
        frame.style.cssText = 'width:100%;height:100%;border:0';
        frame.src = audioPreviewUrl;
        frame.allow = 'autoplay; fullscreen';
        previewContainer.appendChild(frame);
        return;
      }

      // КРИТИЧНО: Определяем статический контент по contentType из метаданных БД
      const isStaticContent = STATIC_CONTENT_TYPES.has(normalizedType);

      // Для папок, PDF и PPTX показываем сетку миниатюр
      if (isStaticContent) {
        let images = [];
        let folderName = safeName;

        // КРИТИЧНО: Используем contentType из метаданных БД, fallback на определение по расширению
        const previewContentType = normalizedType || 'folder';

       if (previewContentType === 'folder') {
          // Это папка с изображениями
          try {
            const res = await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/folder/${encodeURIComponent(safeName)}/images`);
            const data = await res.json();
            images = data.images || [];
            // Создаем URLs для изображений из папки
            images = images.map((_, idx) => 
              `/api/devices/${encodeURIComponent(deviceId)}/folder/${encodeURIComponent(safeName)}/image/${idx + 1}`
            );
          } catch (e) {
            console.error('[Admin] Ошибка загрузки изображений папки:', e);
          }
        } else if (previewContentType === 'pdf' || previewContentType === 'pptx') {
          // Это презентация
          try {
            const urlType = previewContentType === 'pdf' ? 'page' : 'slide';
            const res = await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/slides-count?file=${encodeURIComponent(safeName)}`);
            const data = await res.json();
            const count = data.count || 0;
            // Создаем URLs для слайдов
            for (let i = 1; i <= Math.min(count, 20); i++) { // Максимум 20 миниатюр
              images.push(`/api/devices/${encodeURIComponent(deviceId)}/converted/${encodeURIComponent(safeName)}/${urlType}/${i}`);
            }
          } catch (e) {
            console.error('[Admin] Ошибка загрузки слайдов:', e);
          }
        }
        
        // Показываем сетку миниатюр (только для просмотра, без кликов)
        if (images.length > 0) {
          // Используем DOM методы вместо innerHTML для безопасности
          const outerDiv = document.createElement('div');
          outerDiv.style.cssText = 'width:100%; height:100%; overflow-y:auto; padding:var(--space-md); background:var(--panel)';
          
          const gridDiv = document.createElement('div');
          gridDiv.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:var(--space-sm)';
          
          images.forEach((url, idx) => {
            const itemDiv = document.createElement('div');
            itemDiv.style.cssText = 'aspect-ratio:16/9; background:var(--panel-2); border-radius:var(--radius-sm); overflow:hidden; position:relative';
            
            const img = document.createElement('img');
            img.src = url; // URL безопасен, так как создается на сервере
            img.alt = String(idx + 1);
            img.loading = 'lazy';
            img.style.cssText = 'width:100%; height:100%; object-fit:contain; display:block';
            img.onerror = function() {
              // Используем DOM методы для обработки ошибки
              const parent = this.parentElement;
              parent.innerHTML = '';
              const errorDiv = document.createElement('div');
              errorDiv.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-size:10px';
              errorDiv.textContent = 'Ошибка';
              parent.appendChild(errorDiv);
            };
            
            const indexDiv = document.createElement('div');
            indexDiv.style.cssText = 'position:absolute; bottom:2px; right:4px; background:rgba(0,0,0,0.7); color:var(--text); padding:2px 4px; border-radius:3px; font-size:10px';
            indexDiv.textContent = String(idx + 1);
            
            itemDiv.appendChild(img);
            itemDiv.appendChild(indexDiv);
            gridDiv.appendChild(itemDiv);
          });
          
          outerDiv.appendChild(gridDiv);
          previewContainer.innerHTML = '';
          previewContainer.appendChild(outerDiv);
        } else {
          // Используем DOM методы вместо innerHTML
          previewContainer.innerHTML = '';
          const emptyDiv = document.createElement('div');
          emptyDiv.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary)';
          emptyDiv.textContent = 'Нет изображений для превью';
          previewContainer.appendChild(emptyDiv);
        }
      } else {
        // Для видео и обычных изображений показываем в iframe
        const frame = previewContainer.querySelector('iframe') || document.createElement('iframe');
        let u = `/player-videojs.html?device_id=${encodeURIComponent(deviceId)}&preview=1&muted=1&file=${encodeURIComponent(safeName)}&originalName=${encodeURIComponent(originalName)}`;

        if (normalizedType === 'image') {
          u += `&type=image&page=1`;
        }

        u += `&t=${Date.now()}`;

        if (!previewContainer.querySelector('iframe')) {
          frame.style.cssText = 'width:100%;height:100%;border:0';
          previewContainer.innerHTML = '';
          previewContainer.appendChild(frame);
        }

        frame.src = u;
      }
    };
  });

  panelEl.querySelectorAll('.makeDefaultBtn').forEach(btn => {
    btn.onclick = async () => {
      const safeName = decodeURIComponent(btn.getAttribute('data-safe'));
      const originalName = decodeURIComponent(btn.getAttribute('data-original'));
      try {
        await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/make-default`, {
          method: 'POST',
          headers: { 'Content-Type':'application/json' },
          body: JSON.stringify({ file: safeName })
        });
        
        // КРИТИЧНО: Задержка перед обновлением UI
        // Даем серверу время скопировать файл и установить права
        // Preview iframe обновится через событие placeholder/refresh от сервера
        await new Promise(resolve => setTimeout(resolve, 600));
        
        await refreshFilesPanel(deviceId, panelEl, adminFetch, getPageSize, currentPage, socket, onPageUpdate);
        socket.emit('devices/updated');
      } catch (e) { console.error(e); }
    };
  });

  panelEl.querySelectorAll('.delFileBtn').forEach(btn => {
    btn.onclick = async () => {
      const safeName = decodeURIComponent(btn.getAttribute('data-safe'));
      const originalName = decodeURIComponent(btn.getAttribute('data-original'));
      if (!confirm(`Удалить файл ${originalName}?`)) return;
      await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/files/${encodeURIComponent(safeName)}`, { method: 'DELETE' });
      await refreshFilesPanel(deviceId, panelEl, adminFetch, getPageSize, currentPage, socket, onPageUpdate);
      socket.emit('devices/updated');
    };
  });
  
  // НОВОЕ: Drag & Drop для перемещения файлов между устройствами
  panelEl.querySelectorAll('.file-item[draggable="true"]').forEach(fileItem => {
    fileItem.addEventListener('dragstart', (e) => {
      const sourceDeviceId = fileItem.getAttribute('data-device-id');
      const fileName = decodeURIComponent(fileItem.getAttribute('data-file-name'));
      
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', JSON.stringify({
        sourceDeviceId,
        fileName
      }));
      
      fileItem.style.opacity = '0.5';
    });
    
    fileItem.addEventListener('dragend', (e) => {
      fileItem.style.opacity = '1';
    });
  });
  
  // Переименование файлов - аналогично переименованию устройств
  panelEl.querySelectorAll('.fileName-editable').forEach(nameEl => {
    const fileItem = nameEl.closest('.file-item');
    const saveBtn = fileItem.querySelector('.fileRenameSaveBtn');
    const safeName = decodeURIComponent(nameEl.getAttribute('data-safe'));
    const originalFullName = decodeURIComponent(nameEl.getAttribute('data-original-full'));
    
    // НОВОЕ: Извлекаем расширение из originalFullName для автодобавления
    const fileExt = originalFullName.includes('.') ? originalFullName.substring(originalFullName.lastIndexOf('.')) : '';
    
    let originalDisplayName = nameEl.textContent.trim();
    let isEditing = false;
    let savingFromButton = false;
    
    nameEl.addEventListener('click', () => {
      if (!isEditing) {
        isEditing = true;
        originalDisplayName = nameEl.textContent.trim();
        nameEl.contentEditable = 'true';
        nameEl.style.background = 'var(--panel)';
        nameEl.style.border = 'var(--border)';
        nameEl.focus();
        
        // Выделяем весь текст
        const range = document.createRange();
        range.selectNodeContents(nameEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        
        if (saveBtn) saveBtn.style.display = 'flex';
      }
    });
    
    nameEl.addEventListener('blur', () => {
      if (isEditing && !savingFromButton) {
        const newDisplayName = nameEl.textContent.trim();
        if (newDisplayName && newDisplayName !== originalDisplayName) {
          saveFileName(newDisplayName);
        } else {
          cancelEdit();
        }
      }
      savingFromButton = false;
    });
    
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const newDisplayName = nameEl.textContent.trim();
        if (newDisplayName && newDisplayName !== originalDisplayName) {
          saveFileName(newDisplayName);
        } else {
          cancelEdit();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    });
    
    const saveFileName = async (newDisplayName) => {
      try {
        // КРИТИЧНО: Добавляем расширение обратно из safeName
        const newName = newDisplayName + fileExt;
        
        const response = await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/files/${encodeURIComponent(safeName)}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newName })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
          isEditing = false;
          nameEl.contentEditable = 'false';
          if (saveBtn) saveBtn.style.display = 'none';
          
          // Очищаем превью перед обновлением списка файлов
          const previewContainer = document.querySelector('#detailPane .previewHolder');
          if (previewContainer) {
            previewContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary)">Выберите файл для превью</div>';
          }
          
          await refreshFilesPanel(deviceId, panelEl, adminFetch, getPageSize, currentPage, socket, onPageUpdate);
          socket.emit('devices/updated');
        } else {
          alert(`Ошибка переименования: ${data.error || 'Неизвестная ошибка'}`);
          cancelEdit();
        }
      } catch (err) {
        console.error('Failed to rename file:', err);
        alert('Не удалось переименовать файл');
        cancelEdit();
      }
    };
    
    const cancelEdit = () => {
      isEditing = false;
      nameEl.contentEditable = 'false';
      nameEl.textContent = originalDisplayName;
      nameEl.style.background = 'transparent';
      nameEl.style.border = 'none';
      if (saveBtn) saveBtn.style.display = 'none';
    };
    
    if (saveBtn) {
      saveBtn.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        savingFromButton = true;
        const newDisplayName = nameEl.textContent.trim();
        if (newDisplayName && newDisplayName !== originalDisplayName) {
          await saveFileName(newDisplayName);
        } else {
          cancelEdit();
        }
      });
    }
  });
  
  // ИСПРАВЛЕНО: Возвращаем текущую страницу для сохранения
  return currentPage;
}

// setupUploadUI перенесена в upload-ui.js