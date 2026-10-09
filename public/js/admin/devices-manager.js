// devices-manager.js - список устройств админ-панели: пагинация, рендер и точечные обновления
import { createCopyOpId, showCopyProgress, finishCopyProgress } from './copy-progress.js';

/**
 * Состояние пагинации принадлежит модулю.
 * Раньше tvPage передавался в renderTVList() числом (по значению), поэтому
 * кнопки пагинации меняли локальную копию, а глобальная переменная оставалась 0.
 * Любое внешнее обновление (devices/updated, player/online, resize) рисовало
 * страницу 0 — список сбрасывался на первую страницу.
 */
const state = {
  page: 0,
  pagerKey: ''
};

export function getTvPage() {
  return state.page;
}

export function setTvPage(page) {
  const value = Number(page);
  state.page = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return state.page;
}

export async function loadDevices(adminFetch, sortDevices, nodeNames) {
  const res = await adminFetch('/api/devices');
  let devices = await res.json();
  devices = sortDevices(devices, nodeNames);
  return devices;
}

// Делегирование ленивое: геттеры читаются в момент обращения, а не копируются
// на момент рендера. Иначе обработчики, привязанные к плитке, работали бы
// со снимком контекста и не видели бы последующих изменений.
function resolveCtx(ctx) {
  const c = ctx || {};
  return {
    getDevicesCache: () => (c.getDevicesCache ? c.getDevicesCache() : []),
    getReadyDevices: () => (c.getReadyDevices ? c.getReadyDevices() : new Set()),
    getCurrentDeviceId: () => (c.getCurrentDeviceId ? c.getCurrentDeviceId() : null),
    getNodeNames: () => (c.getNodeNames ? c.getNodeNames() : {}),
    getPageSize: () => (c.getPageSize ? c.getPageSize() : 5),
    sortDevices: c.sortDevices,
    openDevice: c.openDevice,
    renderFilesPane: c.renderFilesPane,
    adminFetch: c.adminFetch
  };
}

function readTileState(d, readyDevices, currentDeviceId, nodeNames) {
  const name = d.name || nodeNames[d.device_id] || d.device_id;
  const filesCount = d.files?.length ?? 0;
  const isActive = d.device_id === currentDeviceId;
  const isReady = readyDevices.has(d.device_id);
  return {
    name,
    filesCount,
    isActive,
    isReady,
    // Хранимое на сервере состояние питания: «спит» перебивает «готов/не готов».
    powerState: d.powerState === 'sleep' ? 'sleep' : null,
    metaText: `ID: ${d.device_id}${d.ipAddress ? ` • IP: ${d.ipAddress}` : ''}`,
    filesText: `Файлов: ${filesCount}`
  };
}

// Сигнал содержит только текст. Статус и активность всегда синхронизируются
// дешёвыми идемпотентными записями, поэтому staleness сигнала их не ломает.
function contentSignature(tileState) {
  return `${tileState.name}\u0001${tileState.metaText}\u0001${tileState.filesText}`;
}

function applyStatus(li, isReady, powerState) {
  const statusSpan = li.querySelector('.tvTile-status');
  if (!statusSpan) return;
  if (powerState === 'sleep') {
    const nextClass = 'tvTile-status sleeping';
    const nextLabel = 'sleep';
    const nextTitle = 'Спит';
    if (statusSpan.className !== nextClass) statusSpan.className = nextClass;
    if (statusSpan.getAttribute('aria-label') !== nextLabel) statusSpan.setAttribute('aria-label', nextLabel);
    if (statusSpan.title !== nextTitle) statusSpan.title = nextTitle;
    return;
  }
  const nextClass = isReady ? 'tvTile-status online' : 'tvTile-status offline';
  const nextLabel = isReady ? 'online' : 'offline';
  const nextTitle = isReady ? 'Готов' : 'Не готов';
  if (statusSpan.className !== nextClass) statusSpan.className = nextClass;
  if (statusSpan.getAttribute('aria-label') !== nextLabel) statusSpan.setAttribute('aria-label', nextLabel);
  if (statusSpan.title !== nextTitle) statusSpan.title = nextTitle;
}

function applyTile(li, tileState) {
  applyStatus(li, tileState.isReady, tileState.powerState);
  li.classList.toggle('active', tileState.isActive);
  const signature = contentSignature(tileState);
  if (li.dataset.sig === signature) return;
  li.dataset.sig = signature;

  const nameEl = li.querySelector('.tvTile-name');
  if (nameEl && nameEl.textContent !== tileState.name) nameEl.textContent = tileState.name;

  const metaEl = li.querySelector('.tvTile-meta');
  if (metaEl && metaEl.textContent !== tileState.metaText) metaEl.textContent = tileState.metaText;

  const filesEl = li.querySelector('.tvTile-files');
  if (filesEl && filesEl.textContent !== tileState.filesText) filesEl.textContent = tileState.filesText;
}

function createTile(d, tileState) {
  const li = document.createElement('li');
  li.className = 'tvTile';
  li.dataset.id = d.device_id;
  li.dataset.sig = contentSignature(tileState);

  const content = document.createElement('div');
  content.className = 'tvTile-content';

  const header = document.createElement('div');
  header.className = 'tvTile-header';

  const nameDiv = document.createElement('div');
  nameDiv.className = 'title tvTile-name';
  nameDiv.textContent = tileState.name;

  const statusSpan = document.createElement('span');
  statusSpan.className = `tvTile-status ${tileState.powerState === 'sleep' ? 'sleeping' : (tileState.isReady ? 'online' : 'offline')}`;
  statusSpan.title = tileState.powerState === 'sleep' ? 'Спит' : (tileState.isReady ? 'Готов' : 'Не готов');
  statusSpan.setAttribute('aria-label', tileState.powerState === 'sleep' ? 'sleep' : (tileState.isReady ? 'online' : 'offline'));

  header.appendChild(nameDiv);
  header.appendChild(statusSpan);

  const metaDiv = document.createElement('div');
  metaDiv.className = 'meta tvTile-meta';
  metaDiv.textContent = tileState.metaText;

  const filesDiv = document.createElement('div');
  filesDiv.className = 'meta tvTile-files';
  filesDiv.textContent = tileState.filesText;

  content.appendChild(header);
  content.appendChild(metaDiv);
  content.appendChild(filesDiv);
  li.appendChild(content);

  applyStatus(li, tileState.isReady, tileState.powerState);
  li.classList.toggle('active', tileState.isActive);
  return li;
}

function bindTileEvents(li, ctx) {
  const targetDeviceId = li.dataset.id;

  li.onclick = async () => {
    const currentDeviceId = ctx.getCurrentDeviceId();
    ctx.openDevice(targetDeviceId);
    ctx.renderFilesPane(targetDeviceId);
    // Активная плитка обновляется точечно, страница не перерисовывается
    renderTVList(ctx);
  };

  // Drag & Drop zone - карточки устройств принимают файлы
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
    li.style.outline = '3px dashed var(--brand)';
    li.style.background = 'rgba(59, 130, 246, 0.1)';
    li.style.transform = 'scale(1.02)';
  });

  li.addEventListener('dragleave', (e) => {
    e.preventDefault();
    li.style.outline = '';
    li.style.background = '';
    li.style.transform = '';
  });

  li.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    li.style.outline = '';
    li.style.background = '';
    li.style.transform = '';

    // opId сшивает HTTP-ответ с событиями copy/* из сокета: итоговый тост
    // и карточка прогресса должны закрыться ровно один раз.
    const opId = createCopyOpId();

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

      const devicesCache = ctx.getDevicesCache() || [];
      const currentDeviceId = ctx.getCurrentDeviceId();
      const sourceDevice = devicesCache.find(dev => dev.device_id === sourceDeviceId);
      const targetDevice = devicesCache.find(dev => dev.device_id === targetDeviceId);
      const safeFileName = decodeURIComponent(fileName);

      // Карточка появляется сразу, не дожидаясь первого события сокета:
      // копирование большой папки идёт минуты, и молчание выглядит как зависание.
      showCopyProgress({
        opId,
        from: sourceDeviceId,
        to: targetDeviceId,
        fromName: sourceDevice?.name || sourceDeviceId,
        toName: targetDevice?.name || targetDeviceId,
        folder: safeFileName,
        action: move ? 'move' : 'copy'
      });

      const response = await ctx.adminFetch(`/api/devices/${encodeURIComponent(targetDeviceId)}/copy-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceDeviceId,
          fileName: safeFileName,
          move,
          opId
        })
      });

      const result = await response.json();

      if (result.ok) {
        // Список устройств обновится через событие devices/updated,
        // renderTVList() точечно обновит счётчики файлов, не сбрасывая страницу.
        finishCopyProgress({
          opId,
          ok: true,
          from: sourceDeviceId,
          to: targetDeviceId,
          fromName: sourceDevice?.name || sourceDeviceId,
          toName: targetDevice?.name || targetDeviceId,
          folder: result.file || safeFileName,
          action: move ? 'move' : 'copy'
        });

        await new Promise(resolve => setTimeout(resolve, 100));

        if (currentDeviceId === sourceDeviceId || currentDeviceId === targetDeviceId) {
          await ctx.renderFilesPane(currentDeviceId);
        }
      } else {
        console.error(`[DragDrop] Ошибка: ${result.error || 'Unknown error'}`);
        finishCopyProgress({
          opId,
          ok: false,
          error: result.error || result.detail || 'Не удалось выполнить операцию'
        });
      }
    } catch (error) {
      console.error('[DragDrop] Ошибка:', error);
      finishCopyProgress({ opId, ok: false, error: error.message || 'Ошибка соединения' });
    }
  });
}

function renderEmptyState(tvList) {
  tvList.innerHTML = '';
  const emptyItem = document.createElement('li');
  emptyItem.className = 'item';
  emptyItem.style.cssText = 'text-align:center; padding:var(--space-lg)';
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
  state.page = 0;
  state.pagerKey = '';
  const pager = document.getElementById('tvPager');
  if (pager) {
    pager.innerHTML = '';
    pager.dataset.pagerKey = '';
  }
}

function ensurePager(tvList) {
  let pager = document.getElementById('tvPager');
  if (!pager) {
    pager = document.createElement('div');
    pager.id = 'tvPager';
    pager.className = 'meta';
    pager.style.display = 'flex';
    pager.style.justifyContent = 'space-between';
    pager.style.alignItems = 'center';
    pager.style.gap = '8px';
    if (tvList.parentElement) tvList.parentElement.appendChild(pager);
  }
  return pager;
}

function currentTotalPages(ctx) {
  const devices = ctx.getDevicesCache() || [];
  const pageSize = Math.max(1, ctx.getPageSize());
  return Math.max(1, Math.ceil(devices.length / pageSize));
}

function renderPager(tvList, totalPages, ctx) {
  const pager = ensurePager(tvList);
  if (!pager) return;

  const key = `${state.page}|${totalPages}`;
  // Пагинатор переиспользуется только если он совпадает по состоянию И кнопки
  // действительно подписаны: renderLayout()/пересборка разметки создают новые
  // узлы, у которых обработчики ещё не назначены.
  const existingNext = pager.querySelector('#tvNext');
  const reusable = state.pagerKey === key
    && pager.dataset.pagerKey === key
    && existingNext
    && typeof existingNext.onclick === 'function';
  if (reusable) return;
  state.pagerKey = key;
  pager.dataset.pagerKey = key;

  pager.innerHTML = '';
  const prevBtn = document.createElement('button');
  prevBtn.className = 'secondary';
  prevBtn.id = 'tvPrev';
  prevBtn.disabled = state.page <= 0;
  prevBtn.style.cssText = 'min-width:80px';
  prevBtn.textContent = 'Назад';

  const pageSpan = document.createElement('span');
  pageSpan.style.cssText = 'white-space:nowrap';
  pageSpan.textContent = `Стр. ${state.page + 1} из ${totalPages}`;

  const nextBtn = document.createElement('button');
  nextBtn.className = 'secondary';
  nextBtn.id = 'tvNext';
  nextBtn.disabled = state.page >= totalPages - 1;
  nextBtn.style.cssText = 'min-width:80px';
  nextBtn.textContent = 'Вперёд';

  pager.appendChild(prevBtn);
  pager.appendChild(pageSpan);
  pager.appendChild(nextBtn);

  // Границы пересчитываются на момент клика: список устройств мог измениться
  // между рендерами (например, пришёл devices/updated без перерисовки пагинатора).
  prevBtn.onclick = () => {
    const maxPage = currentTotalPages(ctx) - 1;
    setTvPage(Math.min(Math.max(state.page - 1, 0), maxPage));
    renderTVList(ctx);
  };
  nextBtn.onclick = () => {
    const maxPage = currentTotalPages(ctx) - 1;
    setTvPage(Math.min(state.page + 1, maxPage));
    renderTVList(ctx);
  };
}

export function renderTVList(context) {
  const ctx = resolveCtx(context || {});
  const tvList = document.getElementById('tvList');
  if (!tvList) return;

  const devices = ctx.getDevicesCache() || [];
  const readyDevices = ctx.getReadyDevices() || new Set();
  const currentDeviceId = ctx.getCurrentDeviceId();
  const nodeNames = ctx.getNodeNames() || {};

  if (!devices.length) {
    renderEmptyState(tvList);
    return;
  }

  const sortedDevices = ctx.sortDevices(devices, nodeNames);
  const pageSize = Math.max(1, ctx.getPageSize());
  const totalPages = Math.max(1, Math.ceil(sortedDevices.length / pageSize));
  if (state.page >= totalPages) state.page = totalPages - 1;
  if (state.page < 0) state.page = 0;

  const start = state.page * pageSize;
  const pageItems = sortedDevices.slice(start, start + pageSize);
  const tileStates = pageItems.map(d => readTileState(d, readyDevices, currentDeviceId, nodeNames));

  // Состав страницы не изменился -> обновляем плитки на месте.
  // Пересоздаём DOM только когда состав/порядок устройств реально другой.
  const scrollTop = tvList.scrollTop;
  const renderedIds = Array.from(tvList.querySelectorAll('.tvTile'), el => el.dataset.id || '');
  const sameComposition = renderedIds.length === pageItems.length
    && renderedIds.every((id, i) => id === pageItems[i].device_id);

  if (sameComposition) {
    const tiles = tvList.querySelectorAll('.tvTile');
    tileStates.forEach((tileState, i) => applyTile(tiles[i], tileState));
  } else {
    const fragment = document.createDocumentFragment();
    pageItems.forEach((d, i) => {
      const li = createTile(d, tileStates[i]);
      bindTileEvents(li, ctx);
      fragment.appendChild(li);
    });
    tvList.innerHTML = '';
    tvList.appendChild(fragment);
  }

  // Фоновое обновление не должно прокручивать список к началу
  tvList.scrollTop = scrollTop;

  renderPager(tvList, totalPages, ctx);
}

/**
 * Точечное обновление статусов "готов/не готов" без перерисовки списка.
 * Используется для player/online, player/offline и players/onlineSnapshot.
 */
export function syncDeviceStatuses(context) {
  const ctx = resolveCtx(context || {});
  const tvList = document.getElementById('tvList');
  if (!tvList) return;
  const readyDevices = ctx.getReadyDevices() || new Set();
  const currentDeviceId = ctx.getCurrentDeviceId();
  const devices = ctx.getDevicesCache() || [];
  tvList.querySelectorAll('.tvTile').forEach((li) => {
    const deviceId = li.dataset.id || '';
    const device = devices.find((d) => d.device_id === deviceId);
    applyStatus(li, readyDevices.has(deviceId), device?.powerState || null);
    li.classList.toggle('active', deviceId === currentDeviceId);
  });
}

/**
 * Точечное обновление одной плитки (device/updated): имя, IP и счётчик файлов.
 */
export function updateDeviceTile(deviceId, device, context) {
  const ctx = resolveCtx(context || {});
  const tvList = document.getElementById('tvList');
  if (!tvList || !deviceId || !device) return;
  const devices = ctx.getDevicesCache() || [];
  // device — более свежие данные, поэтому они имеют приоритет над кэшем
  const cached = devices.find(d => d.device_id === deviceId) || {};
  const merged = { ...cached, ...device };
  const readyDevices = ctx.getReadyDevices() || new Set();
  const tileState = readTileState(merged, readyDevices, ctx.getCurrentDeviceId(), ctx.getNodeNames() || {});
  // Пересобираем сигнал: контент мог измениться, а прошлый renderTVList()
  // ещё не успевал обновить dataset.sig.
  tvList.querySelectorAll('.tvTile').forEach((li) => {
    if ((li.dataset.id || '') === deviceId) applyTile(li, tileState);
  });
}
/**
 * Переводит список на страницу, где находится устройство, и перерисовывает его.
 * Нужно после переименования: сортировка по имени может переместить устройство
 * на другую страницу, и без этого пользователь его теряет из вида.
 */
export function focusDeviceInList(deviceId, context) {
  const ctx = resolveCtx(context || {});
  const devices = ctx.getDevicesCache() || [];
  if (!devices.length || !deviceId) {
    renderTVList(ctx);
    return;
  }

  const nodeNames = ctx.getNodeNames() || {};
  const pageSize = Math.max(1, ctx.getPageSize());
  const sortedDevices = ctx.sortDevices(devices, nodeNames);
  const index = sortedDevices.findIndex(d => d.device_id === deviceId);

  if (index >= 0) setTvPage(Math.floor(index / pageSize));
  renderTVList(ctx);
}
