// device-card.js - ПОЛНЫЙ код renderDeviceCard из admin.js
import { DEVICE_ICONS, DEVICE_TYPE_NAMES } from '../shared/constants.js';
import { escapeHtml } from '../shared/utils.js';
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
  const safeName = escapeHtml(name);
  const safeDeviceType = escapeHtml(DEVICE_TYPE_NAMES[d.deviceType] || d.deviceType || 'Browser');
  const safePlatform = escapeHtml(d.platform || '');
  const safeIpAddress = escapeHtml(d.ipAddress || '');
  const safeDeviceId = escapeHtml(d.device_id || '');
  const safePlayerUrl = escapeHtml(playerUrl);
  
  // Используем DOM методы для безопасного создания элементов
  const header = document.createElement('div');
  header.className = 'header';
  header.style.cssText = 'margin-bottom:0';
  
  const headerInner = document.createElement('div');
  headerInner.style.cssText = 'flex:1; display:flex; align-items:stretch; gap:var(--space-sm)';
  
  const deviceNameEl = document.createElement('div');
  deviceNameEl.className = 'title';
  deviceNameEl.id = 'deviceName';
  deviceNameEl.style.cssText = `flex:1; ${isAdmin ? 'cursor:pointer;' : ''} padding:var(--space-sm) var(--space-md); border-radius:var(--radius-sm); transition:all 0.2s; display:flex; align-items:center; min-height:36px; font-size:var(--font-size-base); margin:0`;
  deviceNameEl.contentEditable = 'false';
  deviceNameEl.textContent = name; // Используем textContent для безопасности
  
  headerInner.appendChild(deviceNameEl);
  
  if (isAdmin) {
    const renameSaveBtn = document.createElement('button');
    renameSaveBtn.className = 'primary meta-lg';
    renameSaveBtn.id = 'renameSaveBtn';
    renameSaveBtn.style.cssText = 'display:none; min-width:36px; width:36px; height:36px; padding:0; border-radius:var(--radius-sm); flex-shrink:0; align-items:center; justify-content:center; font-size:var(--font-size-lg); line-height:1; transition:all 0.2s; box-shadow:var(--shadow-sm)';
    renameSaveBtn.title = 'Сохранить';
    const saveSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    saveSvg.setAttribute('width', '18');
    saveSvg.setAttribute('height', '18');
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
    renameSaveBtn.appendChild(saveSvg);
    headerInner.appendChild(renameSaveBtn);
    
    const delBtn = document.createElement('button');
    delBtn.className = 'danger meta-lg delBtn';
    delBtn.style.cssText = 'min-width:36px; width:36px; height:36px; padding:0; border-radius:var(--radius-sm); flex-shrink:0; align-items:center; justify-content:center; font-size:var(--font-size-lg); line-height:1; transition:all 0.2s; box-shadow:var(--shadow-sm)';
    delBtn.title = 'Удалить устройство';
    const delSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    delSvg.setAttribute('width', '18');
    delSvg.setAttribute('height', '18');
    delSvg.setAttribute('viewBox', '0 0 24 24');
    delSvg.setAttribute('fill', 'none');
    delSvg.setAttribute('stroke', 'currentColor');
    delSvg.setAttribute('stroke-width', '2.5');
    delSvg.setAttribute('stroke-linecap', 'round');
    delSvg.setAttribute('stroke-linejoin', 'round');
    delSvg.style.display = 'block';
    const delPolyline1 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    delPolyline1.setAttribute('points', '3 6 5 6 21 6');
    const delPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    delPath.setAttribute('d', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');
    delSvg.appendChild(delPolyline1);
    delSvg.appendChild(delPath);
    delBtn.appendChild(delSvg);
    headerInner.appendChild(delBtn);

    // Кнопка запуска Android-приложения (справа)
    if (d.platform && d.platform.toLowerCase().includes('android')) {
      import('./notifications.js').then(({ showToastNotification }) => {
        const launchAppBtn = document.createElement('button');
        launchAppBtn.className = 'meta-lg';
        launchAppBtn.style.cssText = 'margin-left:auto; min-width:36px; width:36px; height:36px; padding:0; border-radius:var(--radius-sm); flex-shrink:0; align-items:center; justify-content:center; font-size:var(--font-size-lg); line-height:1; transition:all 0.2s; box-shadow:var(--shadow-sm); background:#4caf50; color:#fff;';
        launchAppBtn.title = 'Запустить Android-приложение';
        const playSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        playSvg.setAttribute('width', '18');
        playSvg.setAttribute('height', '18');
        playSvg.setAttribute('viewBox', '0 0 24 24');
        playSvg.setAttribute('fill', 'none');
        playSvg.setAttribute('stroke', 'currentColor');
        playSvg.setAttribute('stroke-width', '2.5');
        playSvg.setAttribute('stroke-linecap', 'round');
        playSvg.setAttribute('stroke-linejoin', 'round');
        playSvg.style.display = 'block';
        const playPolygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        playPolygon.setAttribute('points', '6,4 20,12 6,20');
        playSvg.appendChild(playPolygon);
        launchAppBtn.appendChild(playSvg);
        launchAppBtn.onclick = async () => {
          launchAppBtn.disabled = true;
          launchAppBtn.title = 'Запуск...';
          try {
            const resp = await adminFetch(`/api/devices/${encodeURIComponent(d.device_id)}/launch-app`, { method: 'POST' });
            const result = await resp.json();
            if (result.ok) {
              showToastNotification({
                title: 'Android-приложение',
                message: 'Команда на запуск приложения отправлена!',
                severity: 'info',
                timestamp: Date.now()
              });
            } else {
              showToastNotification({
                title: 'Ошибка запуска',
                message: result.error || 'Неизвестная ошибка',
                severity: 'warning',
                timestamp: Date.now()
              });
            }
          } catch (e) {
            showToastNotification({
              title: 'Ошибка соединения',
              message: 'Не удалось отправить команду на сервер',
              severity: 'critical',
              timestamp: Date.now()
            });
          }
          launchAppBtn.disabled = false;
          launchAppBtn.title = 'Запустить Android-приложение';
        };
        headerInner.appendChild(launchAppBtn);
      });
    }
  }
  
  header.appendChild(headerInner);
  card.appendChild(header);
  
  // Meta секция с информацией об устройстве
  const metaDiv = document.createElement('div');
  metaDiv.className = 'meta';
  metaDiv.style.cssText = 'margin-top:var(--space-sm); margin-bottom:var(--space-sm); display:flex; align-items:center; flex-wrap:wrap; gap:4px';
  
  // Добавляем иконку устройства (безопасно, так как это константа из DEVICE_ICONS)
  const deviceIcon = document.createElement('span');
  // DEVICE_ICONS содержит только безопасные SVG строки из константы
  // Используем insertAdjacentHTML для вставки константы (безопасно, так как не пользовательский ввод)
  const iconHtml = DEVICE_ICONS[d.deviceType] || DEVICE_ICONS['browser'];
  deviceIcon.insertAdjacentHTML('beforeend', iconHtml);
  metaDiv.appendChild(deviceIcon);
  
  const deviceTypeStrong = document.createElement('strong');
  deviceTypeStrong.textContent = DEVICE_TYPE_NAMES[d.deviceType] || d.deviceType || 'Browser';
  metaDiv.appendChild(deviceTypeStrong);
  
  if (d.platform && d.platform !== 'Unknown') {
    const platformSpan = document.createElement('span');
    platformSpan.textContent = `• ${d.platform}`;
    metaDiv.appendChild(platformSpan);
  }
  
  if (d.ipAddress) {
    const ipSpan = document.createElement('span');
    ipSpan.textContent = `• IP: ${d.ipAddress}`;
    metaDiv.appendChild(ipSpan);
  }
  
  const idSpan = document.createElement('span');
  idSpan.textContent = `• ID: ${d.device_id}`;
  metaDiv.appendChild(idSpan);
  
  const filesSpan = document.createElement('span');
  filesSpan.textContent = `• Файлов: ${d.files?.length || 0}`;
  metaDiv.appendChild(filesSpan);
  
  const readySpan = document.createElement('span');
  readySpan.style.cssText = 'display:inline-flex; align-items:center;';
  const readyIcon = readyDevices.has(d.device_id) ? getCheckIcon(14, 'var(--success)') : getCrossIcon(14, 'var(--danger)');
  readySpan.innerHTML = `• ${readyIcon} ${readyDevices.has(d.device_id) ? 'Готов' : 'Не готов'}`;
  metaDiv.appendChild(readySpan);
  
  const playerLinkSpan = document.createElement('span');
  const playerLink = document.createElement('a');
  playerLink.href = '#';
  playerLink.className = 'playerLink';
  playerLink.setAttribute('data-url', playerUrl);
  playerLink.style.cssText = 'color:var(--primary); text-decoration:underline; cursor:pointer;';
  playerLink.textContent = 'Плеер';
  playerLinkSpan.appendChild(document.createTextNode('• '));
  playerLinkSpan.appendChild(playerLink);
  metaDiv.appendChild(playerLinkSpan);
  
  card.appendChild(metaDiv);
  
  // Превью контейнер
  const previewContainer = document.createElement('div');
  previewContainer.className = 'preview-container';
  previewContainer.style.cssText = 'margin-top:var(--space-md); padding:var(--space-md); display:flex; flex-direction:column; gap:var(--space-sm);';
  
  const previewCompact = document.createElement('div');
  previewCompact.className = 'preview panel preview-compact';
  previewCompact.style.cssText = 'display:block; aspect-ratio:16/9; max-height:120px; width:100%; position:relative; border-radius:var(--radius-md); overflow:hidden; background:var(--panel-2);';
  const previewHolderCompact = document.createElement('div');
  previewHolderCompact.className = 'previewHolder';
  previewHolderCompact.style.cssText = 'width:100%; height:100%; border-radius:var(--radius-md); overflow:hidden;';
  const iframeCompact = document.createElement('iframe');
  iframeCompact.src = `/player-videojs.html?device_id=${did}&preview=1&muted=1`;
  iframeCompact.style.cssText = 'width:100%; height:100%; border:0;';
  previewHolderCompact.appendChild(iframeCompact);
  previewCompact.appendChild(previewHolderCompact);
  
  const previewExpanded = document.createElement('div');
  previewExpanded.className = 'preview panel preview-expanded';
  previewExpanded.style.cssText = 'display:none; flex:1 1 auto; min-height:0; aspect-ratio:16/9; max-height:380px; position:relative; border-radius:var(--radius-md); overflow:hidden; background:var(--panel-2);';
  const previewHolderExpanded = document.createElement('div');
  previewHolderExpanded.className = 'previewHolder';
  previewHolderExpanded.style.cssText = 'width:100%; height:100%; border-radius:var(--radius-md); overflow:hidden';
  const iframeExpanded = document.createElement('iframe');
  iframeExpanded.src = `/player-videojs.html?device_id=${did}&preview=1&muted=1`;
  iframeExpanded.style.cssText = 'width:100%; height:100%; border:0';
  previewHolderExpanded.appendChild(iframeExpanded);
  previewExpanded.appendChild(previewHolderExpanded);
  
  previewContainer.appendChild(previewCompact);
  previewContainer.appendChild(previewExpanded);
  card.appendChild(previewContainer);
  
  // Управление воспроизведением
  const deviceControlsRow = document.createElement('div');
  deviceControlsRow.className = 'device-controls-row';
  deviceControlsRow.style.cssText = 'margin-top:var(--space-md); display:grid; grid-template-columns:1fr; gap:var(--space-md); align-items:stretch;';
  
  const volumePanel = document.createElement('div');
  volumePanel.className = 'card';
  volumePanel.id = 'adminVolumePanel';
  volumePanel.style.cssText = 'padding:var(--space-md); display:flex; flex-direction:column; gap:var(--space-sm);';
  
  const volumeHeader = document.createElement('div');
  volumeHeader.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm);';
  
  const volumeTitle = document.createElement('div');
  volumeTitle.className = 'title';
  volumeTitle.style.cssText = 'margin:0; font-size:var(--font-size-base)';
  volumeTitle.textContent = 'Громкость';
  
  const volumeControls = document.createElement('div');
  volumeControls.style.cssText = 'display:flex; align-items:center; gap:var(--space-sm); flex-wrap:wrap;';
  
  const volumeStatus = document.createElement('div');
  volumeStatus.className = 'meta';
  volumeStatus.id = 'adminVolumeStatus';
  volumeStatus.style.cssText = 'color:var(--muted); font-size:var(--font-size-sm);';
  volumeStatus.textContent = 'Выберите устройство';
  
  const volumeValue = document.createElement('div');
  volumeValue.className = 'meta';
  volumeValue.id = 'adminVolumeValue';
  volumeValue.style.cssText = 'font-weight:600';
  volumeValue.textContent = '--%';
  
  const volumeMuteBtn = document.createElement('button');
  volumeMuteBtn.className = 'meta-lg';
  volumeMuteBtn.id = 'adminVolumeMute';
  volumeMuteBtn.style.cssText = 'min-width:auto; padding:4px 12px; display:flex; align-items:center; justify-content:center;';
  volumeMuteBtn.type = 'button';
  volumeMuteBtn.disabled = true;
  const volumeIconSpan = document.createElement('span');
  volumeIconSpan.className = 'volume-btn-icon';
  volumeIconSpan.setAttribute('aria-hidden', 'true');
  volumeIconSpan.innerHTML = getVolumeUnknownIcon(20, 'var(--muted)');
  volumeMuteBtn.appendChild(volumeIconSpan);
  
  volumeControls.appendChild(volumeStatus);
  volumeControls.appendChild(volumeValue);
  volumeControls.appendChild(volumeMuteBtn);
  volumeHeader.appendChild(volumeTitle);
  volumeHeader.appendChild(volumeControls);
  
  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.id = 'adminVolumeSlider';
  volumeSlider.min = '0';
  volumeSlider.max = '100';
  volumeSlider.step = '5';
  volumeSlider.value = '50';
  volumeSlider.disabled = true;
  volumeSlider.style.width = '100%';
  
  volumePanel.appendChild(volumeHeader);
  volumePanel.appendChild(volumeSlider);
  deviceControlsRow.appendChild(volumePanel);
  card.appendChild(deviceControlsRow);
  
  // Upload box
  const uploadBox = document.createElement('div');
  uploadBox.className = 'uploadBox card';
  uploadBox.style.cssText = 'margin-top:var(--space-md)';
  
  const uploadHeader = document.createElement('div');
  uploadHeader.className = 'header';
  uploadHeader.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm); margin-bottom:var(--space-sm);';
  
  const uploadTitle = document.createElement('div');
  uploadTitle.className = 'title';
  uploadTitle.style.cssText = 'margin:0; font-size:var(--font-size-base)';
  uploadTitle.textContent = 'Загрузка файлов';
  
  const queueToggleBtn = document.createElement('button');
  queueToggleBtn.className = 'meta-lg queueToggleBtn';
  queueToggleBtn.style.cssText = 'min-width:auto; padding:4px 8px; display:none;';
  queueToggleBtn.title = 'Показать очередь';
  const queueToggleSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  queueToggleSvg.setAttribute('width', '14');
  queueToggleSvg.setAttribute('height', '14');
  queueToggleSvg.setAttribute('viewBox', '0 0 24 24');
  queueToggleSvg.setAttribute('fill', 'none');
  queueToggleSvg.setAttribute('stroke', 'currentColor');
  queueToggleSvg.setAttribute('stroke-width', '2');
  queueToggleSvg.setAttribute('stroke-linecap', 'round');
  queueToggleSvg.setAttribute('stroke-linejoin', 'round');
  const queueTogglePolyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  queueTogglePolyline.setAttribute('points', '6 9 12 15 18 9');
  queueToggleSvg.appendChild(queueTogglePolyline);
  queueToggleBtn.appendChild(queueToggleSvg);
  
  uploadHeader.appendChild(uploadTitle);
  uploadHeader.appendChild(queueToggleBtn);
  
  const uploadButtons = document.createElement('div');
  uploadButtons.style.cssText = 'display:flex; gap:var(--space-sm); flex-wrap:wrap; width:100%';
  
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.className = 'fileInput';
  fileInput.multiple = true;
  fileInput.accept = '.mp4,.webm,.ogg,.mkv,.mov,.avi,.mp3,.wav,.m4a,.png,.jpg,.jpeg,.gif,.webp,.pdf,.pptx,.zip';
  fileInput.style.display = 'none';
  
  const folderInput = document.createElement('input');
  folderInput.type = 'file';
  folderInput.className = 'folderInput';
  folderInput.setAttribute('webkitdirectory', '');
  folderInput.setAttribute('directory', '');
  folderInput.multiple = true;
  folderInput.style.display = 'none';
  
  const pickBtn = document.createElement('button');
  pickBtn.className = 'meta-lg pickBtn';
  pickBtn.style.cssText = 'flex:1; min-width:90px; display:flex; align-items:center; justify-content:center; gap:4px;';
  pickBtn.innerHTML = `${getFileIcon(14)}<span>Файлы</span>`;
  
  const pickFolderBtn = document.createElement('button');
  pickFolderBtn.className = 'meta-lg pickFolderBtn';
  pickFolderBtn.style.cssText = 'flex:1; min-width:90px; display:flex; align-items:center; justify-content:center; gap:4px;';
  pickFolderBtn.innerHTML = `${getFolderIcon(14)}<span>Папка</span>`;
  
  uploadButtons.appendChild(fileInput);
  uploadButtons.appendChild(folderInput);
  uploadButtons.appendChild(pickBtn);
  uploadButtons.appendChild(pickFolderBtn);
  
  if (isAdmin) {
    const addStreamBtn = document.createElement('button');
    addStreamBtn.className = 'meta-lg addStreamBtn';
    addStreamBtn.style.cssText = 'flex:1; min-width:90px;';
    addStreamBtn.textContent = '+ Стрим';
    uploadButtons.appendChild(addStreamBtn);
  }
  
  const clearBtn = document.createElement('button');
  clearBtn.className = 'danger meta-lg clearBtn';
  clearBtn.style.cssText = 'flex:1; min-width:90px;';
  clearBtn.textContent = 'Очистить';
  
  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'primary meta-lg uploadBtn';
  uploadBtn.style.cssText = 'flex:1; min-width:90px;';
  uploadBtn.textContent = 'Загрузить';
  
  uploadButtons.appendChild(clearBtn);
  uploadButtons.appendChild(uploadBtn);
  
  const dropZone = document.createElement('div');
  dropZone.className = 'dropZone';
  dropZone.style.cssText = 'margin-top:var(--space-sm); min-height:60px; padding:var(--space-md); font-size:var(--font-size-sm);';
  const fileIconText = getFileIcon(12);
  const folderIconText = getFolderIcon(12);
  dropZone.innerHTML = `Перетащите файлы/папки сюда или нажмите "${fileIconText} Файлы" / "${folderIconText} Папка"`;
  
  const queue = document.createElement('ul');
  queue.className = 'queue';
  queue.style.cssText = 'display:none; margin-top:var(--space-sm); max-height:200px; overflow-y:auto; list-style:none; padding:0; margin-left:0;';
  
  uploadBox.appendChild(uploadHeader);
  uploadBox.appendChild(uploadButtons);
  uploadBox.appendChild(dropZone);
  uploadBox.appendChild(queue);
  card.appendChild(uploadBox);

  // Обработчик ссылки на плеер в meta (копирование в буфер обмена)
  // Используем уже созданный элемент playerLink
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
      const { showStreamModal } = await import('./files-manager.js');
      await showStreamModal({
        deviceId: d.device_id,
        mode: 'add',
        onSuccess: async () => {
          await renderFilesPane(d.device_id);
        }
      });
    };
  }

  // Функционал переключения превью (компактное/развернутое)
  // Используем уже созданные элементы
  const previewToggleBtn = null; // Кнопка переключения превью не создана в текущей структуре
  const controlsRow = deviceControlsRow;
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
  // Используем уже созданные элементы
  
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

