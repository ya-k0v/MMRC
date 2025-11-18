// devices-manager.js - ПОЛНЫЙ код управления устройствами из admin.js

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
    tvList.innerHTML = `
      <li class="item" style="text-align:center; padding:var(--space-xl)">
        <div style="width:100%">
          <div class="title">Нет устройств</div>
          <div class="meta">Откройте плеер или добавьте устройство</div>
        </div>
      </li>
    `;
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

  tvList.innerHTML = pageItems.map(d => {
    const name = d.name || nodeNames[d.device_id] || d.device_id;
    const filesCount = d.files?.length ?? 0;
    const isActive = d.device_id === currentDeviceId;
    const isReady = readyDevices.has(d.device_id);
    return `
      <li class="tvTile${isActive ? ' active' : ''}" data-id="${d.device_id}">
        <div class="tvTile-content">
          <div class="tvTile-header">
            <div class="title tvTile-name">${name}</div>
            <span class="tvTile-status ${isReady ? 'online' : 'offline'}" 
                  title="${isReady ? 'Готов' : 'Не готов'}" 
                  aria-label="${isReady ? 'online' : 'offline'}"></span>
          </div>
          <div class="meta tvTile-meta">ID: ${d.device_id}</div>
          <div class="meta">Файлов: ${filesCount}</div>
        </div>
      </li>
    `;
  }).join('');

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
  pager.innerHTML = `
    <button class="secondary" id="tvPrev" ${tvPage<=0?'disabled':''} style="min-width:80px">Назад</button>
    <span style="white-space:nowrap">Стр. ${tvPage+1} из ${totalPages}</span>
    <button class="secondary" id="tvNext" ${tvPage>=totalPages-1?'disabled':''} style="min-width:80px">Вперёд</button>
  `;
  const prev = document.getElementById('tvPrev');
  const next = document.getElementById('tvNext');
  if (prev) prev.onclick = () => { if (tvPage>0) { tvPage--; renderTVList(devicesCache, readyDevices, currentDeviceId, nodeNames, tvPage, getPageSize, sortDevices, openDevice, renderFilesPane, adminFetch); } };
  if (next) next.onclick = () => { if (tvPage<totalPages-1) { tvPage++; renderTVList(devicesCache, readyDevices, currentDeviceId, nodeNames, tvPage, getPageSize, sortDevices, openDevice, renderFilesPane, adminFetch); } };
}
