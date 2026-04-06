// devices-manager.js - ПОЛНЫЙ код управления устройствами из admin.js
import { escapeHtml } from '../shared/utils.js';

export async function loadDevices(adminFetch, sortDevices, nodeNames) {
  const res = await adminFetch('/api/devices');
  let devices = await res.json();
  devices = sortDevices(devices, nodeNames);
  return devices;
}

export function renderTVList(devicesCache, readyDevices, currentDeviceId, nodeNames, tvPage, getPageSize, sortDevices, openDevice, renderFilesPane, adminFetch) {
  const tvList = document.getElementById('tvList');
  if (!tvList) return;

  if (!devicesCache.length) {
    // Используем DOM методы вместо innerHTML
    tvList.innerHTML = '';
    const emptyItem = document.createElement('li');
    emptyItem.className = 'item';
    emptyItem.style.cssText = 'text-align:center; padding:var(--space-xl)';
    const emptyDiv = document.createElement('div');
    emptyDiv.style.width = '100%';
    const emptyTitle = document.createElement('div');
    emptyTitle.className = 'title';
    emptyTitle.textContent = 'Нет устройств';
    const emptyMeta = document.createElement('div');
    emptyMeta.className = 'meta';
    emptyMeta.textContent = 'Откройте плеер или добавьте устройство';
    emptyDiv.appendChild(emptyTitle);
    emptyDiv.appendChild(emptyMeta);
    emptyItem.appendChild(emptyDiv);
    tvList.appendChild(emptyItem);
    const pager = document.getElementById('tvPager');
    if (pager) pager.innerHTML = '';
    return;
  }

  const sortedDevices = sortDevices(devicesCache);
  const pageSize = getPageSize();
  const totalPages = Math.max(1, Math.ceil(sortedDevices.length / pageSize));
  if (tvPage >= totalPages) tvPage = totalPages - 1;
  const start = tvPage * pageSize;
  const end = Math.min(start + pageSize, sortedDevices.length);
  const pageItems = sortedDevices.slice(start, end);

  // Используем DOM методы вместо innerHTML для безопасности
  tvList.innerHTML = '';
  pageItems.forEach(d => {
    const name = d.name || nodeNames[d.device_id] || d.device_id;
    const filesCount = d.files?.length ?? 0;
    const isActive = d.device_id === currentDeviceId;
    const isReady = readyDevices.has(d.device_id);
    
    // Экранируем пользовательские данные
    const safeName = escapeHtml(name);
    const safeDeviceId = escapeHtml(d.device_id);
    const safeIpAddress = d.ipAddress ? escapeHtml(d.ipAddress) : null;
    
    const li = document.createElement('li');
    li.className = `tvTile${isActive ? ' active' : ''}`;
    li.setAttribute('data-id', d.device_id);
    
    const content = document.createElement('div');
    content.className = 'tvTile-content';
    
    const header = document.createElement('div');
    header.className = 'tvTile-header';
    
    const nameDiv = document.createElement('div');
    nameDiv.className = 'title tvTile-name';
    nameDiv.textContent = name; // Используем textContent для безопасности
    
    const statusSpan = document.createElement('span');
    statusSpan.className = `tvTile-status ${isReady ? 'online' : 'offline'}`;
    statusSpan.title = isReady ? 'Готов' : 'Не готов';
    statusSpan.setAttribute('aria-label', isReady ? 'online' : 'offline');
    
    header.appendChild(nameDiv);
    header.appendChild(statusSpan);
    
    const metaDiv = document.createElement('div');
    metaDiv.className = 'meta tvTile-meta';
    const metaText = `ID: ${d.device_id}${safeIpAddress ? ` • IP: ${d.ipAddress}` : ''}`;
    metaDiv.textContent = metaText; // Используем textContent для безопасности
    
    const filesDiv = document.createElement('div');
    filesDiv.className = 'meta';
    filesDiv.textContent = `Файлов: ${filesCount}`;
    
    content.appendChild(header);
    content.appendChild(metaDiv);
    content.appendChild(filesDiv);
    li.appendChild(content);
    tvList.appendChild(li);
  });

  tvList.querySelectorAll('.tvTile').forEach(item => {
    const targetDeviceId = item.dataset.id;
    
    item.onclick = async () => {
      currentDeviceId = item.dataset.id;
      openDevice(currentDeviceId);
      renderFilesPane(currentDeviceId);
      renderTVList(devicesCache, readyDevices, currentDeviceId, nodeNames, tvPage, getPageSize, sortDevices, openDevice, renderFilesPane, adminFetch);
    };
    
    // Drag & Drop zone - карточки устройств принимают файлы
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      item.style.outline = '3px dashed var(--brand)';
      item.style.background = 'rgba(59, 130, 246, 0.1)';
      item.style.transform = 'scale(1.02)';
    });
    
    item.addEventListener('dragleave', (e) => {
      e.preventDefault();
      item.style.outline = '';
      item.style.background = '';
      item.style.transform = '';
    });
    
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.style.outline = '';
      item.style.background = '';
      item.style.transform = '';
      
      try {
        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
        const { sourceDeviceId, fileName } = data;
        const move = !e.ctrlKey;
        
        if (!sourceDeviceId || !fileName) {
          return;
        }
        
        if (sourceDeviceId === targetDeviceId) {
          return;
        }
        
        const sourceDevice = devicesCache.find(dev => dev.device_id === sourceDeviceId);
        const targetDevice = devicesCache.find(dev => dev.device_id === targetDeviceId);
        const sourceName = sourceDevice ? (sourceDevice.name || sourceDeviceId) : sourceDeviceId;
        const targetName = targetDevice ? (targetDevice.name || targetDeviceId) : targetDeviceId;
        
        const action = move ? 'Переместить' : 'Скопировать';
        
        
        const response = await adminFetch(`/api/devices/${encodeURIComponent(targetDeviceId)}/copy-file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceDeviceId,
            fileName: decodeURIComponent(fileName),
            move
          })
        });
        
        const result = await response.json();
        
        if (result.ok) {
          
          // КРИТИЧНО: Перезагружаем список устройств через Socket.IO событие
          // Socket.IO сервер отправит devices/updated, который обновит devicesCache
          // Это гарантирует что все клиенты увидят изменения
          
          // Небольшая задержка чтобы Socket.IO событие успело обработаться
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Обновляем панель файлов если одно из устройств открыто
          if (currentDeviceId === sourceDeviceId || currentDeviceId === targetDeviceId) {
            await renderFilesPane(currentDeviceId);
          }
        } else {
          console.error(`[DragDrop] ❌ Ошибка: ${result.error || 'Unknown error'}`);
        }
        
      } catch (error) {
        console.error('[DragDrop] ❌ Ошибка:', error);
      }
    });
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
  // Используем DOM методы вместо innerHTML для безопасности
  pager.innerHTML = '';
  const prevBtn = document.createElement('button');
  prevBtn.className = 'secondary';
  prevBtn.id = 'tvPrev';
  prevBtn.disabled = tvPage <= 0;
  prevBtn.style.cssText = 'min-width:80px';
  prevBtn.textContent = 'Назад';
  
  const pageSpan = document.createElement('span');
  pageSpan.style.cssText = 'white-space:nowrap';
  pageSpan.textContent = `Стр. ${tvPage+1} из ${totalPages}`;
  
  const nextBtn = document.createElement('button');
  nextBtn.className = 'secondary';
  nextBtn.id = 'tvNext';
  nextBtn.disabled = tvPage >= totalPages - 1;
  nextBtn.style.cssText = 'min-width:80px';
  nextBtn.textContent = 'Вперёд';
  
  pager.appendChild(prevBtn);
  pager.appendChild(pageSpan);
  pager.appendChild(nextBtn);
  // Используем уже созданные элементы
  prevBtn.onclick = () => { if (tvPage>0) { tvPage--; renderTVList(devicesCache, readyDevices, currentDeviceId, nodeNames, tvPage, getPageSize, sortDevices, openDevice, renderFilesPane, adminFetch); } };
  nextBtn.onclick = () => { if (tvPage<totalPages-1) { tvPage++; renderTVList(devicesCache, readyDevices, currentDeviceId, nodeNames, tvPage, getPageSize, sortDevices, openDevice, renderFilesPane, adminFetch); } };
}
