import { initThemeToggle } from './theme.js';
import { sortDevices, debounce, getPageSize, loadNodeNames } from './utils.js';
import { DEVICE_ICONS, DEVICE_TYPE_NAMES } from './shared/constants.js';
import { ensureAuth, adminFetch, setXhrAuth, logout } from './admin/auth.js';
import { setupSocketListeners } from './admin/socket-listeners.js';
import { showCopyProgress, updateCopyProgress, finishCopyProgress } from './admin/copy-progress.js';
import { renderPowerControlsHtml, initPowerControls, applyPowerState, stopPowerControls } from './admin/device-power.js';
import { loadDevices as loadDevicesModule, renderTVList as renderTVListModule, syncDeviceStatuses, updateDeviceTile, focusDeviceInList as focusDeviceInListModule } from './admin/devices-manager.js';
import { createDevice, renameDevice, deleteDevice } from './admin/device-crud.js';
import { loadFilesWithStatus, refreshFilesPanel as refreshFilesPanelModule, describeProcessing } from './admin/files-manager.js';
import { previewFile, makeDefault, renameFile, deleteFile } from './admin/file-actions.js';
import { uploadFiles, copyFile } from './admin/upload-manager.js';
import { clearDetail, clearFilesPane, openDevice as openDeviceHelper } from './admin/ui-helpers.js';
import { renderDeviceCard as renderDeviceCardModule, deviceCardSignature, buildDevicePreviewUrl } from './admin/device-card.js';
import { setupUploadUI as setupUploadUIModule } from './admin/upload-ui.js';
import { showDevicesModal, showUsersModal, showSettingsModal } from './admin/modal.js';
import { initSystemMonitor, stopSystemMonitor } from './admin/system-monitor.js';
import { getSettingsIcon, getVolumeMutedIcon, getVolumeOnIcon, getVolumeUnknownIcon, getCloseIcon, getCheckIcon, getWarningIcon, getUnlockIcon, getLockIcon, getDeviceIcon, getKeyIcon, getTrashIcon, getPauseIcon, getPlayIcon, getCopyIcon, getDownloadIcon, getBellIcon, getStorageIcon, getCpuIcon, getSlidersIcon, getDatabaseIcon, getMobileIcon, getMonitorIcon, getBrowserIcon, getTVIcon, getChevronLeftIcon, getChevronRightIcon, getChevronDownIcon, getPowerIcon, getSearchIcon, getUpDownloadIcon, getRestartIcon, getUsersIcon, getPlusIcon } from './shared/svg-icons.js';
import { escapeHtml } from './shared/utils.js';
import { initNotifications } from './admin/notifications.js';
import { mountNotificationsSection } from './admin/notifications-modal.js';
import { createSidebar } from './admin/sidebar.js';

const socket = io({ auth: { token: localStorage.getItem('accessToken') } });
const grid = document.getElementById('grid');

let readyDevices = new Set();
let devicesCache = [];
let currentDeviceId = null;
let filePage = 0;
// ИСПРАВЛЕНО: Сохраняем пагинацию для каждого устройства отдельно
const filePageByDevice = new Map();
let nodeNames = {};
let user = null;
let apkMenuOutsideClick = null;
const volumeStateByDevice = new Map();
const VOLUME_STEP = 5;

// Контекст списка устройств. Передаётся геттерами, а не значениями,
// чтобы обработчики и замыкания плиток всегда видели актуальное состояние
// и не работали со снимком на момент рендера.
const deviceListCtx = {
  getDevicesCache: () => devicesCache,
  getReadyDevices: () => readyDevices,
  getCurrentDeviceId: () => currentDeviceId,
  getNodeNames: () => nodeNames,
  getPageSize: () => getPageSize(),
  sortDevices,
  openDevice,
  renderFilesPane,
  adminFetch
};

async function reportAdminUiNotification(payload = {}) {
  try {
    await adminFetch('/api/notifications/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: payload.type || 'admin_ui_event',
        severity: payload.severity || 'info',
        title: payload.title || 'Уведомление',
        message: payload.message || '',
        details: payload.details || {},
        key: payload.key || null,
        source: 'admin-main'
      })
    });
  } catch (error) {
    console.error('[Admin UI] Failed to report notification:', error);
  }
}

// Настройка Socket.IO обработчиков
setupSocketListeners(socket, {
  onDevicesUpdated: async () => {
    // КРИТИЧНО: Не обновляем UI во время активной загрузки файлов (избегаем сброса очереди)
    if (window.isUploadingFiles && window.isUploadingFiles()) {
      return; // Пропускаем обновление во время загрузки
    }
    
    const prev = currentDeviceId;
    await loadDevices();
    updateDevicesCount(); // Обновляем счетчик после загрузки устройств
    let hasSelection = false;
    if (prev && devicesCache.find(d => d.device_id === prev)) {
      openDevice(prev);
      // Пока файл в обработке — не пересоздаём список: полоса прогресса живёт
      // в DOM и анимируется по сокету (file/progress), а полная перерисовка её
      // удаляет и создаёт заново — визуально это «моргание».
      if (!hasActiveProcessing(prev)) {
        await renderFilesPane(prev);
      }
      hasSelection = true;
    } else {
      hasSelection = await ensureSelectedDevice();
    }
    if (!hasSelection) {
      clearDetail('Нет устройств', 'Откройте плеер или добавьте устройство в системе.');
      clearFilesPane('Нет устройств', 'Список файлов появится после подключения устройства.');
    }
    renderTVList();
  },
  onPowerState: (payload) => {
    applyPowerState(payload);
    // Точечно обновляем плитку и кэш: devices/updated после команды питания
    // не приходит, иначе «спит» на плитке появился бы только после перезагрузки.
    if (payload?.deviceId) {
      const dataIdx = devicesCache.findIndex(d => d.device_id === payload.deviceId);
      if (dataIdx !== -1) {
        const awake = payload.awake;
        devicesCache[dataIdx] = {
          ...devicesCache[dataIdx],
          powerState: awake == null ? null : (awake ? 'awake' : 'sleep')
        };
        updateDeviceTile(payload.deviceId, devicesCache[dataIdx], deviceListCtx);
      }
    }
  },
  onFileProcessing: (device_id, file) => {
    if (currentDeviceId === device_id) {
      const panel = document.getElementById('filesPanel');
      // ИСПРАВЛЕНО: НЕ обновляем панель при начале обработки (избегаем мерцания)
      // if (panel) refreshFilesPanel(device_id, panel, adminFetch, getPageSize, filePage, socket);
    }
  },
  onFileProgress: (device_id, file, progress) => {
    if (currentDeviceId === device_id) {
      // ИСПРАВЛЕНО: Обновляем только прогресс-бар, НЕ перерисовываем всю панель
      // Это сохраняет текущую страницу и избегает мерцания UI
      updateFileProgress(device_id, file, progress);
    }
  },
onFileReady: (device_id, file) => {
      // Запись прогресса очищаем: файл готов, а оставленная полоса на 100%
      // воскресала при каждой перерисовке панели.
      clearFileProgress(device_id, file);
      if (currentDeviceId === device_id) refreshFilesPaneContent(device_id);
    },
  onFileError: (device_id, file, error) => {
    clearFileProgress(device_id, file);
    if (currentDeviceId === device_id) refreshFilesPaneContent(device_id);
  },
  onPreviewRefresh: async () => {
    // ИСПРАВЛЕНО: раньше обработчик был пустым, и единственным способом
    // обновить превью был полный пересоздан карточки на devices/updated.
    if (!currentDeviceId) return;
    refreshDevicePreview(devicesCache.find(x => x.device_id === currentDeviceId));
  },
  onCopyProgress: (payload) => showCopyProgress(payload),
  onCopyDone: (payload) => finishCopyProgress({ ...payload, ok: true }),
  onCopyError: (payload) => finishCopyProgress({ ...payload, ok: false, error: payload.error }),
  onPlayerOnline: (device_id) => {
    readyDevices.add(device_id);
    syncDeviceListStatuses();
    if (currentDeviceId === device_id) openDevice(device_id);
  },
  onPlayerOffline: (device_id) => {
    readyDevices.delete(device_id);
    syncDeviceListStatuses();
    if (currentDeviceId === device_id) openDevice(device_id);
  },
  onPlayersSnapshot: (list) => {
    try {
      readyDevices = new Set(Array.isArray(list) ? list : []);
    } catch {
      readyDevices = new Set();
    }
    syncDeviceListStatuses();
    if (currentDeviceId) openDevice(currentDeviceId);
  },
  onVolumeBatch: handleVolumeBatch,
  onVolumeUpdate: handleVolumeUpdate,
  onDeviceUpdated: (device_id, device) => {
    // КРИТИЧНО: Обновляем информацию об устройстве без перезагрузки страницы
    const deviceIndex = devicesCache.findIndex(d => d.device_id === device_id);
    if (deviceIndex !== -1) {
      // Обновляем данные устройства в кэше
      devicesCache[deviceIndex] = {
        ...devicesCache[deviceIndex],
        ...device
      };
      
      // Обновляем отображение в списке устройств (tvTile) точечно,
      // без перерисовки списка и без сброса пагинации
      updateDeviceTile(device_id, devicesCache[deviceIndex], deviceListCtx);
      
      // Обновляем отображение в карточке устройства, если оно открыто
      if (currentDeviceId === device_id) {
        const pane = document.getElementById('detailPane');
        if (pane) {
          const metaEl = pane.querySelector('.meta');
          if (metaEl) {
            // Обновляем строку с IP адресом в карточке устройства
            // Используем DOM методы для безопасного обновления
            const safeIp = device.ipAddress ? escapeHtml(device.ipAddress) : null;
            
            // Ищем существующий span с IP адресом
            const existingIpSpan = Array.from(metaEl.querySelectorAll('span')).find(
              span => span.textContent && span.textContent.includes('IP:')
            );
            
            if (safeIp) {
              if (existingIpSpan) {
                // Обновляем существующий span через textContent (безопасно)
                existingIpSpan.textContent = `• IP: ${safeIp}`;
              } else {
                // Создаем новый span для IP адреса
                const ipSpan = document.createElement('span');
                ipSpan.textContent = `• IP: ${safeIp}`;
                
                // Находим span с ID и вставляем IP перед ним
                const idSpan = Array.from(metaEl.querySelectorAll('span')).find(
                  span => span.textContent && span.textContent.includes('ID:')
                );
                if (idSpan && idSpan.parentNode) {
                  idSpan.parentNode.insertBefore(ipSpan, idSpan);
                } else {
                  metaEl.appendChild(ipSpan);
                }
              }
            } else if (existingIpSpan) {
              // Удаляем IP span если IP адрес отсутствует
              existingIpSpan.remove();
            }
          }
        }
      }
    }
  }
});

function handleSidebarNavigation(section, action) {
  const grid = document.getElementById('grid');
  const devicesPane = document.getElementById('devicesPane');
  const detailPane = document.getElementById('detailPane');
  const filesPane = document.getElementById('filesPane');

  // Скрываем основные панели
  if (devicesPane) devicesPane.style.display = 'none';
  if (detailPane) detailPane.style.display = 'none';
  if (filesPane) filesPane.style.display = 'none';

  // Удаляем старые секции
  grid.querySelectorAll('.admin-section').forEach(el => el.remove());

  switch (section) {
    case 'devices':
      if (devicesPane) devicesPane.style.display = '';
      if (detailPane) detailPane.style.display = '';
      if (filesPane) filesPane.style.display = '';
      break;
    case 'settings':
      grid.appendChild(createSettingsSection());
      break;
    case 'users':
      grid.appendChild(createUsersSection());
      loadUsersSection();
      break;
    case 'logs':
      grid.appendChild(createLogsSection());
      break;
    case 'notifications':
      grid.appendChild(createNotificationsSection());
      break;
  }
}

function createSectionWrapper(title, icon) {
  const el = document.createElement('div');
  el.className = 'admin-section card';
  el.style.cssText = 'padding:var(--space-md); overflow-y:auto; height:100%;';
  el.innerHTML = `
    <div style="display:flex; align-items:center; gap:var(--space-sm); margin-bottom:var(--space-md);">
      ${icon}
      <h2 style="margin:0; font-size:var(--font-size-xl);">${title}</h2>
    </div>
    <div class="admin-section-body"></div>
  `;
  return el;
}

/** Короткое имя контейнера без общего префикса проекта (mmrc-postgres → postgres). */
function shortContainerName(name) {
  return String(name || '').replace(/^mmrc-/, '');
}

function createSettingsSection() {
  const el = createSectionWrapper('Настройки сервера', getSettingsIcon(24));
  const body = el.querySelector('.admin-section-body');
  body.style.cssText = 'display:flex; flex-direction:column; min-height:0; height:100%;';
  body.innerHTML = '<div class="meta" style="padding:var(--space-md); text-align:center; color:var(--muted);">Загрузка...</div>';

  adminFetch('/api/admin/settings/extended').then(async r => {
    if (!r.ok) { const e = await r.json().catch(() => ({ error: 'Ошибка загрузки' })); throw new Error(e.error || 'Ошибка загрузки'); }
    const result = await r.json();
    const data = result.settings;
    const contentRoot = data?.runtime?.contentRoot || data?.contentRoot || '';
    const version = data?.version || 'N/A';
    const dbType = data?.dbType || '';
    const isSqlite = dbType === 'sqlite';
    const modules = Array.isArray(data?.modules) ? data.modules : [];
    const docker = result.docker;
    const containers = Array.isArray(result.containers) ? result.containers : null;
    const ldap = data?.ldapAuth || {};
    // Тип хранилища приходит из бэкенда. Раньше его в ответе не было, и
    // карточка «Хранилище» не могла отличить локальное хранилище от S3.
    const storageInfo = {
      backend: 'local',
      isRemote: false,
      bucket: null,
      endpoint: null,
      region: null,
      ...(result.storage || {})
    };

    body.innerHTML = `
      <div class="settings-columns"><div class="settings-col settings-col--left">

        <!-- Система: версия/uptime/перезапуск + монитор + состояния контейнеров -->
        <div class="st-card">
          <div class="st-card-h">
            ${getCpuIcon(16)}
            <span>Система</span>
          </div>
          <div class="st-card-b">
            <div class="st-meta">
              <strong id="stSysVersion">v${escapeHtml(version)}</strong>
              <span id="stUpdateBranch" class="meta"></span>
              <span class="st-sep">·</span>
              <span>${escapeHtml(isSqlite ? 'SQLite' : 'PostgreSQL')}</span>
              <span class="st-sep">·</span>
              <span>Uptime: <strong id="stSysUptime">—</strong></span>
              ${docker && docker.enabled ? `<span class="st-sep">·</span><span>Docker: <strong>${escapeHtml((docker.mainImage || '').split('/').pop())}:${escapeHtml(docker.mainTag || '')}</strong></span>` : ''}
              <button id="stRestart" class="danger meta st-btn-danger">${getRestartIcon(14)} Перезапустить</button>
            </div>

            <div id="stSysMonitorBody">
              <div class="meta">Загрузка...</div>
            </div>

            <hr class="st-hr" />

            ${containers && containers.length ? `
            <div class="st-chip-row">
              ${containers.filter(c => shortContainerName(c.names) !== 'minio-setup').map(c => {
                const running = String(c.state || '').toLowerCase() === 'running';
                // Одноразовые контейнеры (инициализация/миграции) не должны
                // гореть красным «ошибкой»: exited (0) — штатное завершение.
                const exitCode = /Exited \((\d+)\)/.exec(String(c.status || ''));
                const exitedClean = !running && exitCode && Number(exitCode[1]) === 0;
                const dot = running ? 'st-dot--success' : exitedClean ? 'st-dot--warning' : 'st-dot--danger';
                return `<span class="st-chip" title="${escapeHtml(c.image || '')}${c.status ? ` · ${escapeHtml(c.status)}` : ''}">
                  <span class="st-dot ${dot}"></span>
                  ${escapeHtml(shortContainerName(c.names))}
                </span>`;
              }).join('<span class="st-sep">·</span>')}
            </div>` : ''}
          </div>
        </div>

        <!-- Хранилище контента -->
        <div class="st-card">
          <div class="st-card-h">
            ${getStorageIcon(16)}
            <span>Хранилище</span>
            <span class="st-badge ${storageInfo.isRemote ? 'st-badge--remote' : 'st-badge--local'}" id="stStorageBadge">${storageInfo.isRemote ? 'S3' : 'Локальное'}</span>
          </div>
          <div class="st-card-b">
            ${storageInfo.isRemote ? `
              <div class="st-kv">
                <span class="st-kv-label">Endpoint</span>
                <code class="st-kv-code">${escapeHtml(storageInfo.endpoint || 'не задан')}</code>
              </div>
              <div class="st-kv">
                <span class="st-kv-label">Bucket</span>
                <code class="st-kv-code">${escapeHtml(storageInfo.bucket || 'не задан')}</code>
              </div>
              <div class="st-kv">
                <span class="st-kv-label">Регион</span>
                <code class="st-kv-code">${escapeHtml(storageInfo.region || 'по умолчанию')}</code>
              </div>
            ` : `
              <div class="st-kv">
                <span class="st-kv-label">Путь</span>
                <code class="st-kv-code">${escapeHtml(storageInfo.hostContentRoot || contentRoot)}</code>
              </div>
            `}
            ${storageInfo.usage ? (() => {
              const u = storageInfo.usage;
              // Основной показатель — занятость раздела с контентом из statfs
              // (реальные данные системы). dataMB — объём только наших файлов.
              const occupiedMB = u.usedMB || 0;
              const pct = u.usagePercent != null
                ? Math.min(100, u.usagePercent)
                : (u.totalMB ? Math.min(100, Math.round((occupiedMB / u.totalMB) * 100)) : 0);
              const barClass = pct >= 90 ? 'st-bar-fill--danger' : pct >= 75 ? 'st-bar-fill--warning' : 'st-bar-fill--success';
              const fmt = mb => mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${mb} МБ`;
              const dataLine = u.dataMB != null
                ? `<div class="meta">Данные MMRC: <strong>${fmt(u.dataMB)}</strong></div>`
                : '';
              return `
              <div title="${escapeHtml(u.hostPath || u.path || '')}" class="st-disk">
                <div class="st-bar-head">
                  <span>Занято на диске: <strong>${fmt(occupiedMB)}</strong></span>
                  <span>свободно ${fmt(u.availableMB)} из ${fmt(u.totalMB)} · ${pct}%</span>
                </div>
                <div class="st-bar">
                  <div class="st-bar-fill ${barClass}" style="width:${pct}%;"></div>
                </div>
                ${dataLine}
              </div>`;
            })() : ''}
          </div>
        </div>

        <!-- Модули -->
        <div class="st-card">
          <div class="st-card-h">
            ${getSlidersIcon(16)}
            <span>Модули</span>
          </div>
          <div class="st-card-b">
            <div id="stModList" class="st-mod-grid">
              ${modules.length === 0 ? '<div class="meta">Нет доступных модулей</div>' :
                modules.map(m => `
                  <label class="st-mod-item">
                    <input type="checkbox" data-module-id="${escapeHtml(m.id)}" ${m.enabled ? 'checked' : ''} />
                    <div class="st-mod-body">
                      <div class="st-mod-name">
                        ${escapeHtml(m.name)}
                        <span class="st-mod-state ${m.enabled ? 'is-on' : 'is-off'}" data-mod-state>${m.enabled ? 'вкл' : 'выкл'}</span>
                      </div>
                      ${m.description ? `<div class="st-mod-desc">${escapeHtml(m.description)}</div>` : ''}
                    </div>
                  </label>
                `).join('')}
            </div>
            <div id="stModStatus" class="st-status"></div>
          </div>
        </div>

        <!-- APK -->
        <div class="st-card">
          <div class="st-card-h">
            ${getMobileIcon(16)}
            <span>APK устройств</span>
          </div>
          <div class="st-card-b">
            <div id="stApkVersion" class="meta st-actions">Загрузка...</div>
            <div class="st-actions">
              <input id="stApkIp" class="input st-input-sm" placeholder="IP" />
              <input id="stApkPort" class="input st-input-xs" placeholder="Порт" value="5555" />
              <input id="stApkId" class="input st-input-md" placeholder="ID устройства" />
              <input id="stApkName" class="input st-input-sm" placeholder="Имя" />
              <span style="position:relative; display:inline-flex; align-items:center; gap:6px;">
                <button id="stApkInstall" class="primary">${getDownloadIcon(14)} Установить</button>
                <button id="stApkMenuToggle" type="button" class="secondary" aria-expanded="false" aria-label="Дополнительные действия APK" title="Дополнительные действия APK" style="min-width:36px; width:36px; height:36px; padding:0; display:inline-flex; align-items:center; justify-content:center; border-radius:10px;"><span style="display:inline-flex; transform: rotate(-90deg);">${getChevronDownIcon(16)}</span></button>
                <div id="stApkMenu" style="display:none; position:absolute; left:calc(100% + 6px); top:50%; transform:translateY(-50%); min-width:190px; background:var(--panel); border:1px solid var(--border); border-radius:12px; box-shadow:0 12px 24px rgba(0,0,0,0.35); padding:8px; z-index:30;">
                  <button id="stApkBatch" type="button" class="secondary" style="width:100%; text-align:left; justify-content:flex-start; display:flex; align-items:center; gap:8px; border-radius:10px;">${getRestartIcon(14)} Обновить все</button>
                </div>
              </span>
            </div>
            <div class="st-actions">
              <span id="stApkStatus" class="st-status"></span>
              <span id="stApkBatchStatus" class="st-status st-ml-auto"></span>
            </div>
          </div>
        </div>

        <!-- База данных (только SQLite) -->
        ${isSqlite ? `
        <div class="st-card">
          <div class="st-card-h">
            ${getDatabaseIcon(16)}
            <span>База данных</span>
          </div>
          <div class="st-card-b">
            <div class="st-actions">
              <button id="stDbExport" class="primary">${getDownloadIcon(14)} Экспорт</button>
              <button id="stDbImport" class="secondary">${getUpDownloadIcon(14)} Импорт</button>
              <input type="file" id="stDbImportInput" accept=".db" style="display:none;" />
            </div>
            <details>
              <summary class="meta st-details-summary">Обслуживание</summary>
              <div class="st-actions st-maintenance">
                <button id="stDbCheckFiles" class="secondary meta">${getSearchIcon(14)} Проверить файлы</button>
                <button id="stDbWalCheckpoint" class="secondary meta">${getDatabaseIcon(14)} Чекпоинт WAL</button>
                <button id="stDbCleanupMissing" class="secondary meta">${getTrashIcon(14)} Очистить отсутствующие</button>
                <button id="stDbCleanupOrphaned" class="secondary meta">${getTrashIcon(14)} Очистить осиротевшие</button>
                <div id="stDbMaintStatus" class="st-status"></div>
              </div>
            </details>
          </div>
        </div>` : ''}

        <!-- LDAP (только если настроен) -->
        ${ldap && ldap.enabled ? `
        <div class="st-card">
          <div class="st-ldap">
            <span class="st-dot st-dot--success"></span>
            <span>LDAP: <code>${escapeHtml(ldap.url || '—')}</code></span>
            <span class="st-sep">·</span>
            <span>Base DN: <code>${escapeHtml(ldap.baseDN || '—')}</code></span>
          </div>
        </div>` : ''}

      </div><div class="settings-col settings-col--right">
        <!-- Управление устройствами (сон/пробуждение Android-приставок) -->
        ${renderPowerControlsHtml(devicesCache)}
      </div></div>
    `;

    // --- Bind events ---

    // Restart
    document.getElementById('stRestart').onclick = async () => {
      if (!confirm('Перезапустить сервис сейчас?')) return;
      try { await adminFetch('/api/admin/restart-service', { method: 'POST' }); alert('Перезапуск запущен'); }
      catch { alert('Ошибка перезапуска'); }
    };

    // Module toggles
    const modStatus = document.getElementById('stModStatus');
    document.querySelectorAll('#stModList .st-mod-item input[type="checkbox"]').forEach(cb => {
      cb.onchange = async () => {
        const id = cb.dataset.moduleId;
        try {
          const r = await adminFetch(`/api/admin/modules/${id}/toggle`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: cb.checked })
          });
          const result = await r.json().catch(() => ({}));
          // Бейдж вкл/выкл рисуется при рендере, поэтому после переключения
          // его надо обновить вручную — иначе ячейка противоречит самой себе.
          const badge = cb.closest('.st-mod-item')?.querySelector('[data-mod-state]');
          if (badge) {
            const on = cb.checked;
            badge.textContent = on ? 'вкл' : 'выкл';
            badge.classList.toggle('is-on', on);
            badge.classList.toggle('is-off', !on);
          }
          if (modStatus) { modStatus.innerHTML = result.message || (r.ok ? getCheckIcon(14, 'var(--success)') + ' Сохранено' : 'Ошибка'); modStatus.style.color = r.ok ? 'var(--success)' : 'var(--danger)'; }
        } catch { if (modStatus) { modStatus.textContent = 'Ошибка соединения'; modStatus.style.color = 'var(--danger)'; } }
      };
    });

    // APK Install
    const apkInstall = document.getElementById('stApkInstall');
    if (apkInstall) {
      apkInstall.onclick = async () => {
        const ip = document.getElementById('stApkIp').value.trim();
        const port = document.getElementById('stApkPort').value.trim() || '5555';
        const deviceId = document.getElementById('stApkId').value.trim();
        const deviceName = document.getElementById('stApkName').value.trim();
        const s = document.getElementById('stApkStatus');
        if (!ip || !deviceId || !deviceName) { s.textContent = 'Заполните все поля'; s.style.color = 'var(--danger)'; return; }
        apkInstall.disabled = true; s.textContent = 'Установка...'; s.style.color = 'var(--text-secondary)';
        try {
          const r = await adminFetch('/api/admin/install-apk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, port, deviceId, deviceName }) });
          const result = await r.json();
          s.innerHTML = result.ok ? getCheckIcon(14, 'var(--success)') + ' Установлено!' : (result.error || 'Ошибка'); s.style.color = result.ok ? 'var(--success)' : 'var(--danger)';
        } catch { s.textContent = 'Ошибка соединения'; s.style.color = 'var(--danger)'; }
        apkInstall.disabled = false;
      };
    }

    const apkMenuToggle = document.getElementById('stApkMenuToggle');
    const apkMenu = document.getElementById('stApkMenu');
    const closeApkMenu = () => {
      if (!apkMenu) return;
      apkMenu.style.display = 'none';
      if (apkMenuToggle) apkMenuToggle.setAttribute('aria-expanded', 'false');
    };
    if (apkMenuToggle && apkMenu) {
      if (apkMenuOutsideClick) document.removeEventListener('click', apkMenuOutsideClick);
      apkMenuOutsideClick = (e) => {
        if (!apkMenuToggle.contains(e.target) && !apkMenu.contains(e.target)) closeApkMenu();
      };
      document.addEventListener('click', apkMenuOutsideClick);
      apkMenuToggle.onclick = (e) => {
        e.stopPropagation();
        if (apkMenu.style.display === 'block') { closeApkMenu(); return; }
        apkMenu.style.display = 'block';
        apkMenuToggle.setAttribute('aria-expanded', 'true');
      };
    }

    // APK Batch
    const apkBatch = document.getElementById('stApkBatch');
    if (apkBatch) {
      apkBatch.onclick = async () => {
        closeApkMenu();
        const s = document.getElementById('stApkBatchStatus');
        apkBatch.disabled = true; s.textContent = 'Обновление...'; s.style.color = 'var(--text-secondary)';
        try {
          const r = await adminFetch('/api/admin/install-apk-bound', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const result = await r.json().catch(() => ({}));
          s.textContent = `Готово: ${result.updated || 0} обновлено, ${result.failed || 0} ошибок`;
          s.style.color = (result.failed || 0) > 0 ? 'var(--warning)' : 'var(--success)';
        } catch { s.textContent = 'Ошибка соединения'; s.style.color = 'var(--danger)'; }
        apkBatch.disabled = false;
      };
    }

    // DB Export
    const dbExport = document.getElementById('stDbExport');
    if (dbExport) {
      dbExport.onclick = async () => {
        try {
          const r = await adminFetch('/api/admin/export-database');
          if (r.ok) { const blob = await r.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `mmrc-backup-${new Date().toISOString().slice(0, 10)}.db`; a.click(); URL.revokeObjectURL(url); }
          else { const e = await r.json().catch(() => ({})); alert(e.error || 'Ошибка экспорта'); }
        } catch { alert('Ошибка соединения'); }
      };
    }

    // DB Import
    const dbImport = document.getElementById('stDbImport');
    const dbImportInput = document.getElementById('stDbImportInput');
    if (dbImport && dbImportInput) {
      dbImport.onclick = () => dbImportInput.click();
      dbImportInput.onchange = async () => {
        const file = dbImportInput.files[0];
        if (!file) return;
        if (!confirm('Импорт заменит текущую базу данных. Продолжить?')) return;
        const fd = new FormData();
        fd.append('file', file);
        const pwd = prompt('Введите пароль для подтверждения:');
        if (pwd) fd.append('confirmPassword', pwd);
        try {
          const r = await adminFetch('/api/admin/import-database', { method: 'POST', body: fd });
          if (r.ok) { const result = await r.json(); alert(result.message || 'Импорт завершён.'); }
          else { const e = await r.json().catch(() => ({})); alert(e.error || 'Ошибка импорта'); }
        } catch { alert('Ошибка соединения'); }
      };
    }

    // DB Maintenance
    const dbMaintEl = document.getElementById('stDbMaintStatus');
    function fmtMb(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '0'; }
    function fmtDbMaint(kind, result) {
      const errCount = Array.isArray(result.errors) ? result.errors.length : (Number(result.errors) || 0);
      const errSuffix = errCount > 0 ? ` Ошибок: ${errCount}.` : '';
      if (kind === 'check') {
        if (result.missingOnDisk > 0) return `Проверено файлов: ${result.checked}. Отсутствуют на диске: ${result.missingOnDisk}.${errSuffix}`;
        if (result.missingInDB > 0) return `Проверено файлов: ${result.checked}. Лишних записей в БД: ${result.missingInDB}.${errSuffix}`;
        return `Проверено файлов: ${result.checked}. Проблем не обнаружено.`;
      }
      if (kind === 'wal') {
        if (!result.success) return `Ошибка WAL: ${result.error || result.message || 'неизвестно'}`;
        if ((result.reducedMB || 0) > 0) return `WAL сжат: было ${fmtMb(result.oldSizeMB)} МБ, стало ${fmtMb(result.walSizeMB)} МБ (освобождено ${fmtMb(result.reducedMB)} МБ).`;
        return `Контрольная точка WAL выполнена. Файл WAL: ${fmtMb(result.walSizeMB)} МБ, порог 100 МБ — сжатие не требуется.`;
      }
      if (kind === 'cleanMissing') {
        if (result.deletedFromDB > 0) return `Удалено записей из БД: ${result.deletedFromDB}.${errSuffix}`;
        return `Очистка завершена. Удалять было нечего.`;
      }
      if (kind === 'cleanOrphaned') {
        const verb = result.dryRun ? 'Найдено (сухой прогон)' : 'Удалено';
        if (result.orphaned > 0) return `${verb} осиротевших файлов: ${result.orphaned} (${fmtMb(result.totalSizeMB)} МБ).${errSuffix}`;
        return `Осиротевшие файлы не найдены.`;
      }
      return JSON.stringify(result).slice(0, 200);
    }
    const dbMaintBusy = {
      check: 'Проверяю файлы...',
      wal: 'Выполняю контрольную точку WAL...',
      cleanMissing: 'Очищаю записи из БД...',
      cleanOrphaned: 'Очищаю осиротевшие файлы...'
    };
    async function dbMaint(endpoint, kind, method = 'POST') {
      if (dbMaintEl) { dbMaintEl.textContent = dbMaintBusy[kind] || 'Выполняю...'; dbMaintEl.style.color = 'var(--text-secondary)'; }
      try {
        const opts = method === 'GET' ? {} : { method };
        const r = await adminFetch(endpoint, opts);
        let result = {};
        try { result = await r.json(); } catch { /* нет тела ответа */ }
        if (!r.ok) throw new Error(result.error || 'Ошибка запроса');
        const text = fmtDbMaint(kind, result);
        const color = (kind === 'wal' && !result.success) ? 'var(--danger)' : 'var(--success)';
        if (dbMaintEl) { dbMaintEl.textContent = text; dbMaintEl.style.color = color; }
      } catch (err) { if (dbMaintEl) { dbMaintEl.textContent = `Ошибка: ${err.message}`; dbMaintEl.style.color = 'var(--danger)'; } }
    }
    const checkFiles = document.getElementById('stDbCheckFiles');
    if (checkFiles) checkFiles.onclick = () => dbMaint('/api/admin/database/check-files', 'check', 'GET');
    const walCp = document.getElementById('stDbWalCheckpoint');
    if (walCp) walCp.onclick = () => dbMaint('/api/admin/database/wal-checkpoint', 'wal');
    const cleanupMiss = document.getElementById('stDbCleanupMissing');
    if (cleanupMiss) cleanupMiss.onclick = () => {
      if (!confirm('Удалить из БД записи об отсутствующих на диске файлах?')) return;
      dbMaint('/api/admin/database/cleanup-missing-files', 'cleanMissing');
    };
    const cleanupOrph = document.getElementById('stDbCleanupOrphaned');
    if (cleanupOrph) cleanupOrph.onclick = () => {
      const dryRun = !confirm('Удалить осиротевшие файлы? Нажмите OK для удаления, Cancel для сухого прогона.');
      dbMaint(`/api/admin/database/cleanup-orphaned-files${dryRun ? '?dryRun=true' : ''}`, 'cleanOrphaned');
    };

    // APK Version — выбор одной из последних версий релиза
    (async () => {
      const el = document.getElementById('stApkVersion');
      if (!el) return;

      let data = null;
      let busy = false;

      const render = () => {
        const versions = data && Array.isArray(data.versions) ? data.versions : [];
        if (!data || !data.available || !versions.length) {
          el.textContent = data?.error ? `Версия APK: ${data.error}` : 'Версия APK: неизвестна';
          el.style.color = 'var(--muted)';
          return;
        }

        const selected = data.selectedVersion || data.latestVersion || versions[0].version;
        el.innerHTML = '';
        el.style.color = '';

        const label = document.createElement('span');
        label.textContent = 'Версия:';
        label.style.cssText = 'color:var(--muted);';
        el.appendChild(label);

        const group = document.createElement('span');
        group.style.cssText = 'display:inline-flex; gap:6px; flex-wrap:wrap; align-items:center;';
        versions.forEach((v) => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'meta st-apk-chip' + (v.version === selected ? ' is-selected' : '');
          chip.textContent = v.version;
          chip.setAttribute('aria-pressed', v.version === selected ? 'true' : 'false');
          chip.title = v.downloaded ? `Выбрать версию ${v.version}` : `Скачать и выбрать версию ${v.version}`;
          chip.disabled = busy;
          chip.onclick = () => selectVersion(v.version);
          group.appendChild(chip);
        });
        el.appendChild(group);
      };

      const load = async () => {
        try {
          const r = await adminFetch('/api/admin/apk-version');
          data = await r.json();
        } catch {
          data = { available: false, error: 'Ошибка соединения' };
        }
        render();
      };

      const selectVersion = async (version) => {
        if (busy) return;
        busy = true;
        render();
        try {
          await adminFetch('/api/admin/apk-version/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version })
          });
        } catch {}
        busy = false;
        await load();
      };

      await load();
    })();


    // Update system — показываем версию сервера в шапке
    (async () => {
      const branchEl = document.getElementById('stUpdateBranch');
      if (!branchEl) return;
      try {
        const r = await adminFetch('/api/admin/update/status');
        const data = await r.json();
        if (!data.ok) return;

        const s = data.status;
        const branch = s.branch || '—';
        const localSha = s.localSha ? s.localSha.slice(0, 7) : '—';
        const hasUpdate = s.updateAvailable && !s.dismissed;

        branchEl.innerHTML = hasUpdate ? getWarningIcon(14) : getCheckIcon(14);
        branchEl.style.color = hasUpdate ? 'var(--warning)' : 'var(--success)';
        branchEl.title = hasUpdate
          ? `${branch} (${localSha}) — доступно обновление`
          : `${branch} (${localSha}) — всё актуально`;
      } catch {}
    })();

    // System uptime
    (async () => {
      try {
        const r = await adminFetch('/api/system/info');
        if (r.ok) {
          const sys = await r.json();
          const uptimeEl = document.getElementById('stSysUptime');
          if (uptimeEl) uptimeEl.textContent = sys.processUptimeFormatted || '—';
        }
      } catch {}
    })();

    // Управление питанием Android-приставок
    initPowerControls({ devices: devicesCache, adminFetch });

    // System monitor (CPU, RAM, Disk bars)
    const monitorBody = document.getElementById('stSysMonitorBody');
    if (monitorBody) {
      initSystemMonitor(adminFetch, monitorBody);
    }

  }).catch(() => {
    const root = body;
    if (root) root.innerHTML = '<div class="meta" style="padding:var(--space-md); text-align:center; color:var(--danger);">Ошибка загрузки настроек</div>';
  });

  // Cleanup system monitor and power list observers when section is removed
  const obs = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      stopSystemMonitor();
      stopPowerControls();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  return el;
}

function createUsersSection() {
  const el = createSectionWrapper('Пользователи', `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
  `);
  const body = el.querySelector('.admin-section-body');
  body.style.cssText = 'display:flex; flex-direction:column; min-height:0; height:100%;';

  body.innerHTML = `
    <div class="us-toolbar" style="display:flex; align-items:center; gap:var(--space-sm); flex-wrap:wrap; margin-bottom:var(--space-sm); padding:var(--space-sm) var(--space-sm); background:var(--panel-2); border-radius:var(--radius-sm); border:1px solid var(--border);">
      <div style="display:flex; gap:4px;">
        <button id="usTabLocal" class="secondary meta us-tab-btn" style="background:var(--brand); color:#fff; border-color:var(--brand);">LOCAL</button>
        <button id="usTabLdap" class="secondary meta us-tab-btn">LDAP</button>
      </div>
      <input id="usSearch" class="input" placeholder="Поиск по логину или ФИО..." style="flex:1; min-width:160px; height:32px; min-height:32px; padding:4px 10px; font-size:0.85rem;" />
      <div class="meta" id="usTotalCount" style="white-space:nowrap; color:var(--muted);"></div>
      <button id="usCreateBtn" class="primary meta" style="white-space:nowrap;">${getPlusIcon(14)} Новый пользователь</button>
    </div>

    <div id="usTableWrap" style="flex:1; min-height:0; overflow-y:auto; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--panel-2);">
      <table id="usTable" style="width:100%; border-collapse:collapse; font-size:0.85rem;">
        <thead style="position:sticky; top:0; z-index:1;">
          <tr style="background:var(--panel); border-bottom:2px solid var(--border);">
            <th style="padding:10px 12px; text-align:left; font-weight:600; color:var(--text); white-space:nowrap;">Пользователь</th>
            <th style="padding:10px 12px; text-align:left; font-weight:600; color:var(--text); white-space:nowrap;">Роль</th>
            <th style="padding:10px 12px; text-align:center; font-weight:600; color:var(--text); white-space:nowrap;">Статус</th>
            <th style="padding:10px 12px; text-align:center; font-weight:600; color:var(--text); white-space:nowrap;">Устройств</th>
            <th style="padding:10px 12px; text-align:right; font-weight:600; color:var(--text); white-space:nowrap;">Действия</th>
          </tr>
        </thead>
        <tbody id="usTbody"></tbody>
      </table>
      <div id="usEmpty" style="display:none; text-align:center; padding:var(--space-lg); color:var(--muted);">Нет пользователей</div>
    </div>

    <div id="usPager" style="display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm); padding-top:var(--space-sm); margin-top:var(--space-sm);">
      <div class="meta" id="usPagInfo"></div>
      <div style="display:flex; gap:var(--space-2xs); align-items:center;">
        <button id="usPrev" class="secondary meta" disabled>${getChevronLeftIcon(14)} Назад</button>
        <span class="meta" id="usPageInfo" style="min-width:80px; text-align:center;"></span>
        <button id="usNext" class="secondary meta" disabled>Вперёд ${getChevronRightIcon(14)}</button>
      </div>
    </div>
  `;

  // Simple modal helper scoped to this section
  function showUsModal({ title, titleHtml, bodyHtml, onSave, onOpen }) {
    const existing = document.getElementById('usModalOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'usModalOverlay';
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:1000; display:flex; align-items:center; justify-content:center; padding:20px;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--panel); border-radius:var(--radius-lg); width:480px; max-height:80vh; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,0.3);';

    modal.innerHTML = `
      <div style="padding:var(--space-sm) var(--space-md); border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between;">
        <div style="font-weight:600; font-size:var(--font-size-base); display:flex; align-items:center;">${titleHtml || escapeHtml(title)}</div>
        <button id="usModalClose" class="secondary meta" style="min-width:auto; width:28px; height:28px; padding:0; border:none; background:transparent; font-size:18px; line-height:1;">${getCloseIcon(12)}</button>
      </div>
      <div style="padding:var(--space-md); flex:1; overflow:auto; max-height:calc(80vh - 120px);">${bodyHtml}</div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    modal.querySelector('#usModalClose').onclick = close;

    // Close only if both mousedown and mouseup are on overlay
    let mouseDownTarget = null;
    overlay.addEventListener('mousedown', (e) => { mouseDownTarget = e.target; });
    overlay.addEventListener('mouseup', (e) => {
      if (e.target === overlay && mouseDownTarget === overlay) close();
    });

    const saveBtn = modal.querySelector('#usModalSave');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Сохранение...';
        try {
          await onSave();
          close();
        } catch (e) {
          const errEl = modal.querySelector('.us-modal-error');
          if (errEl) { errEl.textContent = e.message || 'Ошибка'; errEl.style.display = 'block'; }
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Сохранить';
        }
      };
    }
    if (onOpen) setTimeout(onOpen, 50);
    return modal;
  }

  window._usState = { allUsers: [], filtered: [], page: 1, perPage: 20, query: '', tab: 'local', devicesById: {} };

  // Create user modal
  el.querySelector('#usCreateBtn').onclick = () => {
    showUsModal({
      title: 'Новый пользователь',
      bodyHtml: `
        <div style="display:flex; flex-direction:column; gap:var(--space-sm);">
          <input id="usCreateLogin" class="input" placeholder="Логин" autocomplete="off" />
          <input id="usCreateFullName" class="input" placeholder="ФИО" />
          <input id="usCreatePass" class="input" type="password" placeholder="Пароль (мин. 8 символов)" autocomplete="new-password" />
          <select id="usCreateRole" class="input">
            <option value="speaker">Speaker</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
          <div class="us-modal-error meta" style="color:var(--danger); display:none;"></div>
          <button id="usModalSave" class="primary" style="margin-top:var(--space-sm);">Создать</button>
        </div>
      `,
      onSave: async () => {
        const username = document.getElementById('usCreateLogin').value.trim();
        const full_name = document.getElementById('usCreateFullName').value.trim();
        const password = document.getElementById('usCreatePass').value;
        const role = document.getElementById('usCreateRole').value;
        if (!username || !password) throw new Error('Заполните логин и пароль');
        if (password.length < 8) throw new Error('Пароль минимум 8 символов');
        const res = await adminFetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, full_name, password, role }) });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Ошибка создания'); }
        loadUsersSection();
      }
    });
  };

  // Tabs
  el.querySelector('#usTabLocal').onclick = () => { window._usState.tab = 'local'; window._usState.page = 1; renderUsersSectionList(); };
  el.querySelector('#usTabLdap').onclick = () => { window._usState.tab = 'ldap'; window._usState.page = 1; renderUsersSectionList(); };

  // Search
  let searchTimer;
  el.querySelector('#usSearch').oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      window._usState.query = e.target.value.trim().toLowerCase();
      window._usState.page = 1;
      renderUsersSectionList();
    }, 250);
  };

  // Pagination
  el.querySelector('#usPrev').onclick = () => { if (window._usState.page > 1) { window._usState.page--; renderUsersSectionList(); } };
  el.querySelector('#usNext').onclick = () => {
    const tp = Math.ceil(window._usState.filtered.length / window._usState.perPage);
    if (window._usState.page < tp) { window._usState.page++; renderUsersSectionList(); }
  };

  // Reset password modal
  window._usResetPass = async (userId, username) => {
    showUsModal({
      title: `Сброс пароля — ${escapeHtml(username)}`,
      bodyHtml: `
        <div style="display:flex; flex-direction:column; gap:var(--space-sm);">
          <input id="usResetPass1" class="input" type="password" placeholder="Новый пароль (мин. 8 символов)" autocomplete="new-password" />
          <input id="usResetPass2" class="input" type="password" placeholder="Повторите пароль" autocomplete="new-password" />
          <div class="us-modal-error meta" style="color:var(--danger); display:none;"></div>
          <button id="usModalSave" class="primary" style="margin-top:var(--space-sm);">Изменить пароль</button>
        </div>
      `,
      onSave: async () => {
        const p1 = document.getElementById('usResetPass1').value;
        const p2 = document.getElementById('usResetPass2').value;
        if (!p1 || p1.length < 8) throw new Error('Пароль минимум 8 символов');
        if (p1 !== p2) throw new Error('Пароли не совпадают');
        const res = await adminFetch(`/api/auth/users/${userId}/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_password: p1 }) });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Ошибка'); }
      }
    });
  };

  // Delete user
  window._usDelete = async (id, name) => {
    if (!confirm(`Удалить пользователя "${name}"?`)) return;
    try {
      const res = await adminFetch(`/api/auth/users/${id}`, { method: 'DELETE' });
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Ошибка удаления'); return; }
      loadUsersSection();
    } catch { alert('Ошибка соединения'); }
  };

  // Toggle active
  window._usToggle = async (id, makeActive) => {
    try {
      const res = await adminFetch(`/api/auth/users/${id}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: makeActive }) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Ошибка'); return; }
      loadUsersSection();
    } catch { alert('Ошибка соединения'); }
  };

  // Revoke all sessions for a user
  window._usRevokeAllSessions = async (userId, username) => {
    if (!confirm(`Завершить все сессии пользователя "${username}"? Он будет разавторизован.`)) return;
    try {
      const userSessions = (window._usState.allSessions || []).filter(s => s.user_id === userId);
      if (!userSessions.length) { alert('Нет активных сессий'); return; }
      let ok = 0, fail = 0;
      for (const s of userSessions) {
        try {
          const r = await adminFetch(`/api/admin/sessions/${s.id}`, { method: 'DELETE' });
          if (r.ok) ok++; else fail++;
        } catch { fail++; }
      }
      if (fail > 0) alert(`Завершено: ${ok}, ошибок: ${fail}`);
      loadUsersSection();
    } catch { alert('Ошибка соединения'); }
  };

  // Edit devices modal
  window._usEditDevices = async (userId, username, role) => {
    if (role === 'admin' || role === 'hero_admin') {
      alert(role === 'admin' ? 'Admin имеет доступ ко всем устройствам' : 'Hero Admin не использует назначения');
      return;
    }
    try {
      const [devicesRes, userDevicesRes] = await Promise.all([
        adminFetch('/api/devices'),
        adminFetch(`/api/auth/users/${userId}/devices`)
      ]);
      const allDevices = await devicesRes.json();
      const userDeviceIds = await userDevicesRes.json();
      const assigned = new Set(Array.isArray(userDeviceIds) ? userDeviceIds : []);

      const listHtml = allDevices.map(d => {
        const checked = assigned.has(d.device_id);
        const deviceType = String(d.device_type || '').toLowerCase();
        const isAndroid = deviceType.includes('android') || deviceType.includes('native');
        const isBrowser = deviceType.includes('browser') || deviceType.includes('web');
        const isMpv = deviceType.includes('mpv');
        const icon = isAndroid ? getMobileIcon(24) : isMpv ? getMonitorIcon(24) : isBrowser ? getBrowserIcon(24) : getTVIcon(24);
        const statusColor = d.is_online ? 'var(--success)' : 'var(--muted)';
        return `
          <label class="device-card ${checked ? 'assigned' : ''}" style="display:flex; flex-direction:column; align-items:center; gap:6px; padding:12px 8px; border:2px solid ${checked ? 'var(--brand)' : 'var(--border)'}; border-radius:12px; cursor:pointer; transition: color, background-color, border-color, box-shadow, opacity, transform 0.2s; background:${checked ? 'rgba(var(--brand-rgb, 59,130,246),0.08)' : 'var(--panel-2)'};">
            <input type="checkbox" class="us-device-cb" value="${escapeHtml(d.device_id)}" ${checked ? 'checked' : ''} style="display:none;" />
            <div style="font-size:1.5rem;">${icon}</div>
            <div style="font-weight:500; font-size:0.85rem; text-align:center; line-height:1.2; word-break:break-word;">${escapeHtml(d.device_name || d.device_id)}</div>
            <div style="font-size:0.7rem; color:var(--text-secondary); text-align:center;">${escapeHtml(d.device_id)}</div>
            <div style="width:8px; height:8px; border-radius:50%; background:${statusColor};"></div>
            ${checked ? `<div style="position:absolute; top:6px; right:6px; width:18px; height:18px; border-radius:50%; background:var(--brand); color:white; display:flex; align-items:center; justify-content:center; font-size:10px;">${getCheckIcon(12, '#fff')}</div>` : ''}
          </label>
        `;
      }).join('');

      showUsModal({
        title: `Устройства — ${escapeHtml(username)}`,
        bodyHtml: `
          <div style="margin-bottom:var(--space-sm);">
            <div class="meta" style="margin-bottom:var(--space-sm);">Выбрано: <span id="deviceCount">${assigned.size}</span> из ${allDevices.length}</div>
            <button id="selectAllDevices" class="secondary meta" style="font-size:0.75rem; padding:4px 8px;">Выбрать все</button>
            <button id="deselectAllDevices" class="secondary meta" style="font-size:0.75rem; padding:4px 8px;">Снять все</button>
          </div>
          <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:var(--space-sm); max-height:400px; overflow-y:auto; padding:2px; position:relative;">
            ${listHtml || '<div class="meta" style="color:var(--muted); grid-column:1/-1; text-align:center;">Нет устройств</div>'}
          </div>
          <div class="us-modal-error meta" style="color:var(--danger); display:none;"></div>
          <div style="display:flex; gap:var(--space-sm); justify-content:flex-end; border-top:1px solid var(--border); padding-top:var(--space-sm); margin-top:var(--space-sm);">
            <button id="usModalSave" class="primary">Сохранить</button>
          </div>
        `,
        onSave: async () => {
          const checked = Array.from(document.querySelectorAll('.us-device-cb:checked')).map(cb => cb.value);
          const res = await adminFetch(`/api/auth/users/${userId}/devices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceIds: checked }) });
          if (!res.ok) throw new Error('Ошибка сохранения');
          loadUsersSection();
        },
        onOpen: () => {
          const updateCount = () => {
            const count = document.querySelectorAll('.us-device-cb:checked').length;
            const countEl = document.getElementById('deviceCount');
            if (countEl) countEl.textContent = count;
          };

          document.querySelectorAll('.us-device-cb').forEach(cb => {
            cb.closest('label').onclick = (e) => {
              if (e.target === cb) return;
              cb.checked = !cb.checked;
              cb.closest('label').classList.toggle('assigned', cb.checked);
              updateCount();
            };
          });

          const selectAllBtn = document.getElementById('selectAllDevices');
          const deselectAllBtn = document.getElementById('deselectAllDevices');
          if (selectAllBtn) selectAllBtn.onclick = () => {
            document.querySelectorAll('.us-device-cb').forEach(cb => {
              cb.checked = true;
              cb.closest('label').classList.add('assigned');
            });
            updateCount();
          };
          if (deselectAllBtn) deselectAllBtn.onclick = () => {
            document.querySelectorAll('.us-device-cb').forEach(cb => {
              cb.checked = false;
              cb.closest('label').classList.remove('assigned');
            });
            updateCount();
          };
        }
      });
    } catch (e) { alert('Ошибка загрузки устройств'); }
  };

  // Edit user modal (ФИО + роль + устройства)
  window._usEdit = async (userId, username, fullName, role, isLdap, isActive) => {
    isLdap = String(role || '').toLowerCase() === 'ldap';

    let allDevices = [];
    let userDeviceIds = [];
    try {
      if (role !== 'admin' && role !== 'hero_admin') {
        const [devicesRes, userDevicesRes] = await Promise.all([
          adminFetch('/api/devices'),
          adminFetch(`/api/auth/users/${userId}/devices`)
        ]);
        allDevices = await devicesRes.json();
        userDeviceIds = await userDevicesRes.json();
      }
    } catch (e) { /* ignore */ }

    const assigned = new Set(Array.isArray(userDeviceIds) ? userDeviceIds : []);
    let devicePage = 1;
    const devicePerPage = 10;
    let deviceSearch = '';

    const renderDeviceList = () => {
      const filtered = allDevices.filter(d => {
        if (!deviceSearch) return true;
        const q = deviceSearch.toLowerCase();
        return (d.device_id || '').toLowerCase().includes(q) || (d.device_name || '').toLowerCase().includes(q);
      });
      // Sort: assigned first, then by name
      filtered.sort((a, b) => {
        const aAssigned = assigned.has(a.device_id) ? 0 : 1;
        const bAssigned = assigned.has(b.device_id) ? 0 : 1;
        if (aAssigned !== bAssigned) return aAssigned - bAssigned;
        return (a.device_name || a.device_id || '').localeCompare(b.device_name || b.device_id || '');
      });
      const totalPages = Math.ceil(filtered.length / devicePerPage);
      const start = (devicePage - 1) * devicePerPage;
      const pageDevices = filtered.slice(start, start + devicePerPage);

      return pageDevices.map(d => {
        const checked = assigned.has(d.device_id);
        const isOnline = d.is_online || d.online;
        return `
          <label style="display:flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid ${checked ? 'var(--brand)' : 'var(--border)'}; border-radius:8px; cursor:pointer; background:${checked ? 'rgba(59,130,246,0.08)' : 'transparent'}; transition: color, background-color, border-color, box-shadow, opacity, transform 0.15s;">
            <input type="checkbox" class="us-device-cb" value="${escapeHtml(d.device_id)}" ${checked ? 'checked' : ''} style="display:none;" />
            <div style="flex:1; min-width:0;">
              <div style="font-weight:500; font-size:0.85rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(d.device_name || d.device_id)}</div>
              <div class="meta" style="font-size:0.7rem;">${escapeHtml(d.device_id)}</div>
            </div>
            <div style="width:8px; height:8px; border-radius:50%; background:${isOnline ? 'var(--success)' : 'var(--muted)'}; flex-shrink:0;" title="${isOnline ? 'Онлайн' : 'Оффлайн'}"></div>
          </label>
        `;
      }).join('');
    };

    const deviceSection = (role !== 'admin' && role !== 'hero_admin' && allDevices.length > 0) ? `
      <div style="border-top:1px solid var(--border); padding-top:var(--space-sm); margin-top:var(--space-sm);">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:var(--space-sm);">
          <span style="font-size:0.875rem; color:var(--text-secondary);">Устройства: <span id="usDeviceCount">${assigned.size}</span>/${allDevices.length}</span>
          <div style="display:flex; gap:4px;">
            <button id="usDeviceSelectAll" class="secondary" style="font-size:0.7rem; padding:2px 6px;">Все</button>
            <button id="usDeviceDeselectAll" class="secondary" style="font-size:0.7rem; padding:2px 6px;">Нет</button>
          </div>
        </div>
        <input id="usDeviceSearch" class="input" type="text" placeholder="Поиск устройства..." style="margin-bottom:var(--space-sm); font-size:0.85rem;" />
        <div id="usDeviceList" style="display:grid; grid-template-columns:1fr 1fr; gap:6px; max-height:360px; overflow:hidden;">
          ${renderDeviceList()}
        </div>
      </div>
    ` : '';

    const hasDevices = role !== 'admin' && role !== 'hero_admin' && allDevices.length > 0;
    const totalPages = hasDevices ? Math.ceil(allDevices.filter(d => !deviceSearch || (d.device_id || '').toLowerCase().includes(deviceSearch.toLowerCase()) || (d.device_name || '').toLowerCase().includes(deviceSearch.toLowerCase())).length / devicePerPage) : 0;

    const userActive = isActive !== 'false' && isActive !== false;
    showUsModal({
      titleHtml: `<span id="usToggleActive" style="cursor:pointer; display:inline-flex; align-items:center; gap:6px;" title="Нажмите для смены статуса"><span id="usToggleDot" style="width:8px; height:8px; border-radius:50%; background:${userActive ? 'var(--success)' : 'var(--danger)'}; display:inline-block;"></span><span style="color:${userActive ? 'var(--success)' : 'var(--danger)'}">${escapeHtml(username)}</span></span>`,
      bodyHtml: `
        <div style="display:flex; flex-direction:column; gap:var(--space-sm);">
          ${isLdap ? '<div style="font-size:0.75rem; color:var(--warning); background:rgba(245,158,11,0.1); padding:6px 10px; border-radius:6px;">LDAP пользователь — редактируется в Active Directory</div>' : ''}
          <label style="display:flex; flex-direction:column; gap:var(--space-2xs);">
            <span style="font-size:0.8rem; color:var(--text-secondary);">ФИО</span>
            <input id="usEditFullName" class="input" type="text" value="${escapeHtml(fullName)}" placeholder="Введите ФИО" ${isLdap ? 'disabled' : ''} />
          </label>
          <label style="display:flex; flex-direction:column; gap:var(--space-2xs);">
            <span style="font-size:0.8rem; color:var(--text-secondary);">Роль</span>
            <select id="usEditRole" class="input" ${isLdap ? 'disabled' : ''}>
              <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option>
              <option value="manager" ${role === 'manager' ? 'selected' : ''}>Manager</option>
              <option value="speaker" ${role === 'speaker' ? 'selected' : ''}>Speaker</option>
              <option value="hero_admin" ${role === 'hero_admin' ? 'selected' : ''}>Hero Admin</option>
            </select>
          </label>
          ${deviceSection}
        </div>
        <div id="usEditError" class="meta" style="color:var(--danger); display:none;"></div>
        <div style="display:flex; align-items:center; justify-content:space-between; border-top:1px solid var(--border); padding-top:var(--space-sm); margin-top:var(--space-sm);">
          <div id="usDevicePager" style="display:flex; align-items:center; gap:4px;">
            ${hasDevices && totalPages > 1 ? `
              <button id="usDevicePrev" class="secondary" style="min-width:28px; padding:2px 6px; font-size:0.75rem;" ${devicePage <= 1 ? 'disabled' : ''}>${getChevronLeftIcon(14)}</button>
              <span style="font-size:0.75rem; color:var(--text-secondary);">${devicePage}/${totalPages}</span>
              <button id="usDeviceNext" class="secondary" style="min-width:28px; padding:2px 6px; font-size:0.75rem;" ${devicePage >= totalPages ? 'disabled' : ''}>${getChevronRightIcon(14)}</button>
            ` : ''}
          </div>
          <button id="usModalSave" class="primary" style="font-size:0.85rem;">Сохранить</button>
        </div>
      `,
      onSave: async () => {
        const newFullName = document.getElementById('usEditFullName').value.trim();
        const newRole = document.getElementById('usEditRole').value;
        if (!newFullName) throw new Error('ФИО не может быть пустым');

        const res = await adminFetch(`/api/auth/users/${userId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ full_name: newFullName, role: newRole })
        });
        if (!res.ok) throw new Error('Ошибка сохранения');

        if (role !== 'admin' && role !== 'hero_admin' && allDevices.length > 0) {
          await adminFetch(`/api/auth/users/${userId}/devices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceIds: Array.from(assigned) })
          });
        }

        loadUsersSection();
      },
      onOpen: () => {
        let isActive = userActive;

        const toggleBtn = document.getElementById('usToggleActive');
        const toggleDot = document.getElementById('usToggleDot');
        if (toggleBtn) {
          toggleBtn.onclick = async () => {
            try {
              const res = await adminFetch(`/api/auth/users/${userId}/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_active: !isActive })
              });
              if (res.ok) {
                isActive = !isActive;
                if (toggleDot) toggleDot.style.background = isActive ? 'var(--success)' : 'var(--danger)';
                const nameSpan = toggleBtn.querySelector('span:last-child');
                if (nameSpan) nameSpan.style.color = isActive ? 'var(--success)' : 'var(--danger)';
              }
            } catch (e) { /* ignore */ }
          };
        }

        const updateDeviceCount = () => {
          const count = assigned.size;
          const el = document.getElementById('usDeviceCount');
          if (el) el.textContent = count;
        };

        document.querySelectorAll('.us-device-cb').forEach(cb => {
          cb.addEventListener('change', () => {
            if (cb.checked) {
              assigned.add(cb.value);
            } else {
              assigned.delete(cb.value);
            }
            cb.closest('label').style.borderColor = cb.checked ? 'var(--brand)' : 'var(--border)';
            cb.closest('label').style.background = cb.checked ? 'rgba(59,130,246,0.08)' : 'transparent';
            updateDeviceCount();
          });
        });

        const searchEl = document.getElementById('usDeviceSearch');
        if (searchEl) {
          let debounce;
          searchEl.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
              deviceSearch = searchEl.value;
              devicePage = 1;
              document.getElementById('usDeviceList').innerHTML = renderDeviceList();
              document.getElementById('usDevicePager').innerHTML = Array.from({length: Math.ceil(allDevices.filter(d => !deviceSearch || (d.device_id || '').toLowerCase().includes(deviceSearch.toLowerCase()) || (d.device_name || '').toLowerCase().includes(deviceSearch.toLowerCase())).length / devicePerPage)}, (_, i) => `<button class="secondary us-device-page" style="min-width:28px; padding:2px 6px; font-size:0.75rem; ${i + 1 === devicePage ? 'background:var(--brand); color:white;' : ''}" data-page="${i + 1}">${i + 1}</button>`).join('');
              document.querySelectorAll('.us-device-page').forEach(btn => {
                btn.onclick = () => { devicePage = parseInt(btn.dataset.page); document.getElementById('usDeviceList').innerHTML = renderDeviceList(); };
              });
            }, 200);
          });
        }

        document.querySelectorAll('.us-device-page').forEach(btn => {
          btn.onclick = () => { devicePage = parseInt(btn.dataset.page); document.getElementById('usDeviceList').innerHTML = renderDeviceList(); };
        });

        const selectAllBtn = document.getElementById('usDeviceSelectAll');
        const deselectAllBtn = document.getElementById('usDeviceDeselectAll');
        if (selectAllBtn) selectAllBtn.onclick = () => {
          allDevices.forEach(d => assigned.add(d.device_id));
          document.querySelectorAll('.us-device-cb').forEach(cb => { cb.checked = true; cb.closest('label').style.borderColor = 'var(--brand)'; cb.closest('label').style.background = 'rgba(59,130,246,0.08)'; });
          updateDeviceCount();
        };
        if (deselectAllBtn) deselectAllBtn.onclick = () => {
          allDevices.forEach(d => assigned.delete(d.device_id));
          document.querySelectorAll('.us-device-cb').forEach(cb => { cb.checked = false; cb.closest('label').style.borderColor = 'var(--border)'; cb.closest('label').style.background = 'transparent'; });
          updateDeviceCount();
        };

        const prevBtn = document.getElementById('usDevicePrev');
        const nextBtn = document.getElementById('usDeviceNext');
        if (prevBtn) prevBtn.onclick = () => { if (devicePage > 1) { devicePage--; refreshDeviceList(); } };
        if (nextBtn) nextBtn.onclick = () => {
          const maxPage = Math.ceil(allDevices.filter(d => !deviceSearch || (d.device_id || '').toLowerCase().includes(deviceSearch.toLowerCase()) || (d.device_name || '').toLowerCase().includes(deviceSearch.toLowerCase())).length / devicePerPage);
          if (devicePage < maxPage) { devicePage++; refreshDeviceList(); }
        };

        function refreshDeviceList() {
          document.getElementById('usDeviceList').innerHTML = renderDeviceList();
          const maxPage = Math.ceil(allDevices.filter(d => !deviceSearch || (d.device_id || '').toLowerCase().includes(deviceSearch.toLowerCase()) || (d.device_name || '').toLowerCase().includes(deviceSearch.toLowerCase())).length / devicePerPage);
          document.getElementById('usDevicePager').innerHTML = `
            <button id="usDevicePrev" class="secondary" style="min-width:28px; padding:2px 6px; font-size:0.75rem;" ${devicePage <= 1 ? 'disabled' : ''}>${getChevronLeftIcon(14)}</button>
            <span style="font-size:0.75rem; color:var(--text-secondary);">${devicePage}/${maxPage || 1}</span>
            <button id="usDeviceNext" class="secondary" style="min-width:28px; padding:2px 6px; font-size:0.75rem;" ${devicePage >= maxPage ? 'disabled' : ''}>${getChevronRightIcon(14)}</button>
          `;
          document.getElementById('usDevicePrev').onclick = () => { if (devicePage > 1) { devicePage--; refreshDeviceList(); } };
          document.getElementById('usDeviceNext').onclick = () => { if (devicePage < maxPage) { devicePage++; refreshDeviceList(); } };
          document.querySelectorAll('.us-device-cb').forEach(cb => {
            cb.addEventListener('change', () => {
              if (cb.checked) {
                assigned.add(cb.value);
              } else {
                assigned.delete(cb.value);
              }
              cb.closest('label').style.borderColor = cb.checked ? 'var(--brand)' : 'var(--border)';
              cb.closest('label').style.background = cb.checked ? 'rgba(59,130,246,0.08)' : 'transparent';
              updateDeviceCount();
            });
          });
        }
      }
    });
  };

  return el;
}

async function loadUsersSection() {
  const tbody = document.getElementById('usTbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:var(--space-lg); color:var(--muted);">Загрузка...</td></tr>';
  try {
    const [usersRes, devicesRes, sessionsRes] = await Promise.all([
      adminFetch('/api/auth/users'),
      adminFetch('/api/devices'),
      adminFetch('/api/admin/sessions')
    ]);
    if (!usersRes.ok) throw new Error('HTTP ' + usersRes.status);
    const users = await usersRes.json();
    const devices = await devicesRes.json();
    const sessions = sessionsRes.ok ? await sessionsRes.json() : [];
    window._usState.devicesById = Array.isArray(devices)
      ? devices.reduce((a, d) => { if (d?.device_id) a[d.device_id] = d; return a; }, {})
      : {};

    // Group sessions by user_id
    const sessionsByUser = {};
    (Array.isArray(sessions) ? sessions : []).forEach(s => {
      if (!sessionsByUser[s.user_id]) sessionsByUser[s.user_id] = [];
      sessionsByUser[s.user_id].push(s);
    });

    const usersWithCounts = await Promise.all(users.map(async (u) => {
      try {
        const r = await adminFetch(`/api/auth/users/${u.id}/devices`);
        if (!r.ok) return { ...u, deviceIds: [], deviceCount: 0 };
        const ids = await r.json();
        return { ...u, deviceIds: Array.isArray(ids) ? ids : [], deviceCount: (Array.isArray(ids) ? ids : []).length };
      } catch { return { ...u, deviceIds: [], deviceCount: 0 }; }
    }));

    // Attach sessions to users
    usersWithCounts.forEach(u => {
      u.sessions = sessionsByUser[u.id] || [];
      u.online = u.sessions.length > 0;
    });

    window._usState.allUsers = usersWithCounts;
    window._usState.allSessions = Array.isArray(sessions) ? sessions : [];
    renderUsersSectionList();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:var(--space-lg); color:var(--danger);">Ошибка загрузки: ${escapeHtml(e.message || '')}</td></tr>`;
  }
}

function renderUsersSectionList() {
  const s = window._usState;
  const tbody = document.getElementById('usTbody');
  const empty = document.getElementById('usEmpty');
  if (!tbody) return;

  const localBtn = document.getElementById('usTabLocal');
  const ldapBtn = document.getElementById('usTabLdap');

  const localCount = s.allUsers.filter(u => String(u.auth_source || 'local').toLowerCase() !== 'ldap').length;
  const ldapCount = s.allUsers.filter(u => String(u.auth_source || 'local').toLowerCase() === 'ldap').length;
  if (localBtn) { localBtn.textContent = `LOCAL (${localCount})`; localBtn.style.background = s.tab !== 'ldap' ? 'var(--brand)' : ''; localBtn.style.color = s.tab !== 'ldap' ? '#fff' : ''; localBtn.style.borderColor = s.tab !== 'ldap' ? 'var(--brand)' : ''; }
  if (ldapBtn) { ldapBtn.textContent = `LDAP (${ldapCount})`; ldapBtn.style.background = s.tab === 'ldap' ? 'var(--brand)' : ''; ldapBtn.style.color = s.tab === 'ldap' ? '#fff' : ''; ldapBtn.style.borderColor = s.tab === 'ldap' ? 'var(--brand)' : ''; }

  const totalEl = document.getElementById('usTotalCount');
  if (totalEl) totalEl.textContent = `Всего: ${s.allUsers.length}`;

  s.filtered = s.allUsers.filter(u => {
    const src = String(u.auth_source || 'local').toLowerCase();
    const matchTab = s.tab === 'ldap' ? src === 'ldap' : src !== 'ldap';
    if (!matchTab) return false;
    if (!s.query) return true;
    const q = s.query;
    return (u.username && u.username.toLowerCase().includes(q)) ||
           (u.full_name && u.full_name.toLowerCase().includes(q));
  });

  const tp = Math.ceil(s.filtered.length / s.perPage);
  if (tp === 0) s.page = 1; else if (s.page > tp) s.page = tp;
  const start = (s.page - 1) * s.perPage;
  const page = s.filtered.slice(start, start + s.perPage);
  const end = Math.min(start + s.perPage, s.filtered.length);

  const pagInfo = document.getElementById('usPagInfo');
  if (pagInfo) pagInfo.textContent = s.filtered.length > 0 ? `${start + 1}–${end} из ${s.filtered.length}` : '';

  const pageInfo = document.getElementById('usPageInfo');
  if (pageInfo) pageInfo.textContent = tp > 0 ? `${s.page} из ${tp}` : '';

  const prevBtn = document.getElementById('usPrev');
  const nextBtn = document.getElementById('usNext');
  if (prevBtn) prevBtn.disabled = s.page <= 1;
  if (nextBtn) nextBtn.disabled = s.page >= tp;

  if (page.length === 0) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  const roleColors = { admin: 'var(--brand)', manager: 'var(--warning)', speaker: 'var(--success)', hero_admin: 'var(--warning)' };

  tbody.innerHTML = page.map(u => {
    const isLdap = String(u.auth_source || 'local').toLowerCase() === 'ldap';
    return `<tr style="border-bottom:1px solid var(--border); transition:background 0.15s; cursor:pointer;" onmouseover="this.style.background='var(--panel-hover)'" onmouseout="this.style.background=''" onclick="window._usEdit(${u.id}, '${escapeHtml(u.username)}', '${escapeHtml(u.full_name || '')}', '${escapeHtml(u.role)}', ${isLdap}, ${u.is_active ? 'true' : 'false'})">
      <td style="padding:10px 12px;">
        <div style="display:flex; align-items:center; gap:var(--space-sm);">
          <div style="position:relative; width:32px; height:32px; flex-shrink:0;">
            <div style="width:32px; height:32px; border-radius:50%; background:${roleColors[u.role] || 'var(--muted-2)'}; color:var(--panel); display:flex; align-items:center; justify-content:center; font-weight:600; font-size:0.8rem;">${(u.username || '?')[0].toUpperCase()}</div>
            ${u.online ? `<span title="Онлайн — ${u.sessions.length} сессий" style="position:absolute; bottom:-1px; right:-1px; width:10px; height:10px; border-radius:50%; background:var(--success); border:2px solid var(--panel);"></span>` : ''}
          </div>
          <div style="min-width:0;">
            <div style="font-weight:500; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(u.username)}</div>
            <div class="meta" style="font-size:0.75rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(u.full_name || '')}</div>
          </div>
        </div>
      </td>
      <td style="padding:10px 12px;">
        <span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:0.75rem; font-weight:500; background:${roleColors[u.role] || 'var(--panel-2)'}; color:var(--panel);">${(u.role || '').toUpperCase()}</span>
        <span style="margin-left:4px; padding:2px 6px; border-radius:4px; font-size:0.7rem; background:${isLdap ? 'var(--warning)' : 'var(--panel-2)'}; color:${isLdap ? 'var(--panel)' : 'var(--muted)'};">${isLdap ? 'LDAP' : 'LOCAL'}</span>
      </td>
      <td style="padding:10px 12px; text-align:center;">
        <span style="display:inline-flex; align-items:center; gap:4px; padding:2px 10px; border-radius:999px; font-size:0.75rem; font-weight:500; background:${u.is_active ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}; color:${u.is_active ? 'var(--success)' : 'var(--danger)'};">
          <span style="width:6px; height:6px; border-radius:50%; background:${u.is_active ? 'var(--success)' : 'var(--danger)'}; display:inline-block;"></span>
          ${u.is_active ? 'Активен' : 'Отключён'}
        </span>
      </td>
      <td style="padding:10px 12px; text-align:center; color:var(--text); font-size:0.85rem;">${u.role === 'admin' ? '—' : (u.deviceCount || 0)}</td>
      <td style="padding:10px 12px; text-align:right;">
        <div style="display:inline-flex; gap:4px;">
          ${u.online ? `<button class="danger meta" style="min-width:auto; padding:4px 8px; font-size:0.75rem;" onclick="event.stopPropagation(); window._usRevokeAllSessions(${u.id}, '${escapeHtml(u.username)}')" title="Завершить все сессии (${u.sessions.length})">${getPowerIcon(16)}</button>` : ''}
          ${!isLdap ? `<button class="secondary meta" style="min-width:auto; padding:4px 8px; font-size:0.75rem;" onclick="event.stopPropagation(); window._usResetPass(${u.id}, '${escapeHtml(u.username)}')" title="Сбросить пароль">${getKeyIcon(14)}</button>` : ''}
          ${u.id !== 1 ? `<button class="danger meta" style="min-width:auto; padding:4px 8px; font-size:0.75rem;" onclick="event.stopPropagation(); window._usDelete(${u.id}, '${escapeHtml(u.username)}')" title="Удалить">${getTrashIcon(14)}</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

/**
 * Раздел «Уведомления».
 *
 * От модальных окон в проекте отказались, поэтому уведомления вынесены в
 * обычный раздел навигации наравне с «Пользователями» и «Логами». Разметка
 * списка остаётся прежней — её переиспользует notifications-modal.js,
 * теперь просто монтируя её в контейнер раздела.
 */
function createNotificationsSection() {
  const el = createSectionWrapper('Уведомления', getBellIcon(24));
  const body = el.querySelector('.admin-section-body');
  body.style.cssText = 'display:flex; flex-direction:column; min-height:0; height:100%; overflow:hidden;';
  body.innerHTML = '<div class="meta" style="padding:var(--space-md); text-align:center; color:var(--muted);">Загрузка...</div>';
  mountNotificationsSection(body, socket);
  return el;
}

function createLogsSection() {
  const el = createSectionWrapper('Логи сервиса', `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
  `);
  const body = el.querySelector('.admin-section-body');
  body.style.cssText = 'display:flex; flex-direction:column; min-height:0; height:100%;';

  body.innerHTML = `
    <div class="lg">

      <!-- Toolbar -->
      <div class="lg-toolbar">
        <select id="lgLevel" class="input lg-field lg-field--level" aria-label="Уровень логов">
          <option value="combined">все</option>
        </select>
        <select id="lgModule" class="input lg-field lg-field--module" aria-label="Модуль">
          <option value="">все модули</option>
        </select>
        <select id="lgLines" class="input lg-field lg-field--lines" aria-label="Строк">
          <option value="50">50</option>
          <option value="100" selected>100</option>
          <option value="200">200</option>
          <option value="500">500</option>
          <option value="1000">1000</option>
          <option value="2000">2000</option>
        </select>
        <label class="lg-check">
          <input type="checkbox" id="lgAutoscroll" checked /> Авто
        </label>
        <div class="lg-spacer"></div>
        <button id="lgPause" type="button" class="secondary lg-btn-icon" title="Пауза" aria-label="Пауза">${getPauseIcon(14)}</button>
        <button id="lgRefresh" type="button" class="secondary lg-btn">${getRestartIcon(14)} Обновить</button>
        <button id="lgClear" type="button" class="secondary lg-btn">${getTrashIcon(14)} Очистить</button>
        <button id="lgCopy" type="button" class="secondary lg-btn-icon" title="Копировать" aria-label="Копировать">${getCopyIcon(14)}</button>
        <button id="lgDownload" type="button" class="secondary lg-btn-icon" title="Скачать" aria-label="Скачать">${getDownloadIcon(14)}</button>
      </div>

      <!-- Info bar -->
      <div id="lgInfo" class="lg-info"></div>

      <!-- Output -->
      <pre id="lgOutput" class="lg-output">Загрузка...</pre>
    </div>
  `;

  let logsPollTimer = null;
  let paused = false;
  let incrementalOffset = -1;
  let currentFileName = '';
  let availableLevels = ['combined', 'error', 'warn', 'info', 'debug'];
  let availableModules = [];

  const ql = (sel) => el.querySelector(sel);

  const LEVEL_LABELS = { error: 'ERR', warn: 'WRN', warning: 'WRN', info: 'INF', debug: 'DBG' };

  function parseLogLine(rawLine) {
    try {
      const obj = JSON.parse(rawLine);
      return {
        timestamp: obj.timestamp || obj.time || obj.t || '',
        level: (obj.level || '').toLowerCase(),
        module: obj.module || obj.category || '',
        message: obj.message || obj.msg || rawLine,
        meta: obj
      };
    } catch {
      const tsMatch = rawLine.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*)\s/);
      if (tsMatch) {
        return { timestamp: tsMatch[1], level: '', module: '', message: rawLine, meta: null };
      }
      return { timestamp: '', level: '', module: '', message: rawLine, meta: null };
    }
  }

  function formatLogLine(rawLine) {
    const parsed = parseLogLine(rawLine);

    const ts = parsed.timestamp ? escapeHtml(parsed.timestamp) : '';
    const levelTag = parsed.level
      ? escapeHtml(LEVEL_LABELS[parsed.level] || parsed.level.toUpperCase().slice(0, 5))
      : '';
    const mod = parsed.module ? escapeHtml(parsed.module) : '';

    let rest = parsed.message;
    if (parsed.meta) {
      const skip = new Set(['level','message','msg','timestamp','time','t','module','category','service']);
      const extra = Object.entries(parsed.meta).filter(([k]) => !skip.has(k));
      if (extra.length) {
        try {
          const obj = {};
          extra.forEach(([k, v]) => obj[k] = v);
          rest += ' ' + JSON.stringify(obj);
        } catch {}
      }
    }

    const parts = [];
    if (ts) parts.push(`<span class="lg-ts">${ts}</span>`);
    if (levelTag) parts.push(`<span class="lg-level">${levelTag}</span>`);
    if (mod) parts.push(`<span class="lg-mod">[${mod}]</span>`);
    parts.push(`<span class="lg-msg">${escapeHtml(rest)}</span>`);

    return `<div class="lg-line" data-level="${escapeHtml(parsed.level || '')}">${parts.join(' ')}</div>`;
  }

  function formatLogLines(arr) {
    if (!arr.length) return '<span class="lg-empty">Логи пусты</span>';
    return arr.map(formatLogLine).join('');
  }

  function getLogTextContent() {
    const output = ql('#lgOutput');
    if (!output) return '';
    const divs = output.querySelectorAll('.lg-line');
    if (divs.length === 0) return output.textContent || '';
    return Array.from(divs).map(d => d.textContent).join('\n');
  }

  async function fetchLogs(initial) {
    const output = ql('#lgOutput');
    if (!output) return;
    const level = ql('#lgLevel').value;
    const moduleFilter = ql('#lgModule').value;
    const lines = ql('#lgLines').value;

    try {
      const params = new URLSearchParams({ lines, level });
      if (moduleFilter) params.set('module', moduleFilter);
      if (!initial && incrementalOffset >= 0) {
        params.set('offset', incrementalOffset);
        if (currentFileName) params.set('fileName', currentFileName);
      }
      const resp = await adminFetch(`/api/admin/service-logs?${params}`);
      if (!resp.ok) {
        output.textContent = 'Ошибка загрузки логов';
        return;
      }
      const result = await resp.json();
      const arr = Array.isArray(result.lines) ? result.lines : [];

      if (Array.isArray(result.availableLevels) && result.availableLevels.length) availableLevels = result.availableLevels;
      if (Array.isArray(result.availableModules) && result.availableModules.length) availableModules = result.availableModules;

      if (typeof result.nextOffset === 'number') incrementalOffset = result.nextOffset;
      if (result.fileName) currentFileName = result.fileName;

      const info = ql('#lgInfo');
      if (info) {
        const parts = [];
        if (result.source) parts.push(`[${result.source}]`);
        parts.push(`строк: ${arr.length}`);
        if (typeof result.nextOffset === 'number') parts.push(`offset: ${result.nextOffset}`);
        if (result.fileName) parts.push(`файл: ${result.fileName}`);
        info.textContent = parts.join(' · ');
      }

      if (result.reset || initial) {
        output.innerHTML = formatLogLines(arr);
      } else if (arr.length > 0) {
        const newHtml = formatLogLines(arr);
        output.insertAdjacentHTML('beforeend', newHtml);
        const maxLogLines = 2000;
        const children = output.children;
        while (children.length > maxLogLines) {
          children[0].remove();
        }
      }

      if (ql('#lgAutoscroll').checked) {
        output.scrollTop = output.scrollHeight;
      }
    } catch (e) {
      if (initial) output.textContent = 'Ошибка соединения';
    }
  }

  // Populate level select from API response
  function populateSelects(levels, modules) {
    const levelSel = ql('#lgLevel');
    if (levelSel && levels.length) {
      const current = levelSel.value;
      levelSel.innerHTML = levels.map(l =>
        `<option value="${l}" ${l === current || (current === 'combined' && l === 'combined') ? 'selected' : ''}>${l}</option>`
      ).join('');
    }
    const modSel = ql('#lgModule');
    if (modSel && modules.length) {
      modSel.innerHTML = '<option value="">все модули</option>' +
        modules.map(m => `<option value="${m}">${m}</option>`).join('');
    }
  }

  // Async fetch of available levels/modules
  (async () => {
    try {
      const resp = await adminFetch('/api/admin/service-logs?lines=1');
      if (resp.ok) {
        const info = await resp.json();
        if (Array.isArray(info.availableLevels) && info.availableLevels.length) availableLevels = info.availableLevels;
        if (Array.isArray(info.availableModules) && info.availableModules.length) availableModules = info.availableModules;
        populateSelects(availableLevels, availableModules);
      }
    } catch {}
  })();

  // Set all handlers synchronously
  ql('#lgLevel').onchange = () => { incrementalOffset = -1; currentFileName = ''; fetchLogs(true); };
  ql('#lgModule').onchange = () => { incrementalOffset = -1; currentFileName = ''; fetchLogs(true); };
  ql('#lgLines').onchange = () => { incrementalOffset = -1; currentFileName = ''; fetchLogs(true); };
  ql('#lgRefresh').onclick = () => { incrementalOffset = -1; currentFileName = ''; fetchLogs(true); };
  ql('#lgClear').onclick = () => {
    const output = ql('#lgOutput');
    if (output) { output.textContent = ''; incrementalOffset = -1; currentFileName = ''; }
  };
  ql('#lgPause').onclick = () => {
    paused = !paused;
    ql('#lgPause').innerHTML = paused ? getPlayIcon(14) : getPauseIcon(14);
    ql('#lgPause').title = paused ? 'Возобновить' : 'Пауза';
  };

  // Initial load + auto-poll
  fetchLogs(true);
  logsPollTimer = setInterval(() => {
    if (!paused) fetchLogs(false);
  }, 2000);

  // Copy
  ql('#lgCopy').onclick = () => {
    const text = getLogTextContent();
    if (!text) return;
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    });
  };

  // Download
  ql('#lgDownload').onclick = () => {
    const text = getLogTextContent();
    if (!text) return;
    const level = ql('#lgLevel').value;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `service-log-${level}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Cleanup on section remove
  const observer = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      clearInterval(logsPollTimer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return el;
}

document.addEventListener('DOMContentLoaded', async () => {
  initThemeToggle(document.getElementById('themeBtn'), 'vc_theme_admin');
  
  try {
    user = await ensureAuth();
    if (!user) return;
    if (user.role === 'hero_admin') {
      window.location.href = '/hero/admin.html';
      return;
    }
  } catch (err) {
    return;
  }

  // Initialize sidebar
  let sidebar = null;
  if (user.role === 'admin') {
    sidebar = createSidebar({
      adminFetch,
      user,
      onNavigate: handleSidebarNavigation
    });
    sidebar.init();
    document.body.classList.add('has-sidebar');
    if (sidebar.isCollapsed()) {
      document.body.classList.add('sidebar-collapsed');
    }

    // Mobile menu button
    const menuBtn = document.getElementById('sidebarMenuBtn');
    if (menuBtn) {
      menuBtn.onclick = () => sidebar.toggleMobile();
    }

    // Overlay click closes mobile sidebar
    const overlay = document.getElementById('sidebarOverlay');
    if (overlay) {
      overlay.onclick = () => sidebar.closeMobile();
    }
  }

  // Показываем ФИО пользователя
  const userFullName = document.getElementById('userFullName');
  if (userFullName && user.full_name) {
    userFullName.textContent = user.full_name;
  } else if (userFullName && user.username) {
    userFullName.textContent = user.username; // Fallback
  }
  
  // Кнопки в toolbar скрыты - навигация через сайдбар
  const usersBtn = document.getElementById('usersBtn');
  if (usersBtn) usersBtn.style.display = 'none';
  
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) settingsBtn.style.display = 'none';
  
  const heroBtn = document.getElementById('heroBtn');
  if (heroBtn) heroBtn.style.display = 'none';
  
  const speakerBtn = document.getElementById('speakerBtn');
  if (speakerBtn) {
    speakerBtn.onclick = () => {
      window.open('/speaker.html', '_blank');
    };
  }
  
  // Обработчик выхода (теперь это span)
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.onclick = (e) => {
      e.preventDefault();
      logout();
    };
    logoutBtn.style.cursor = 'pointer';
  }

  await loadAndSetNodeNames();
  await loadDevices();
  renderLayout();
  updateDevicesCount(); // Обновляем счетчик после создания layout
  clearDetail('Выберите устройство', 'Панель управления и кнопки появятся после выбора устройства из списка слева.');
  clearFilesPane('Выберите устройство слева', 'Список файлов загрузится автоматически после выбора устройства.');
  
  // Кнопка добавления устройства в devicesPane
  const devicesBtn = document.getElementById('devicesBtn');
  if (devicesBtn && user.role === 'admin') {
    devicesBtn.onclick = () => {
      showDevicesModal(adminFetch, loadDevices, renderTVList, openDevice, renderFilesPane);
    };
  } else if (devicesBtn) {
    devicesBtn.style.display = 'none';
  }
  
  await initSelectionFromUrl();
  
  // Инициализируем систему уведомлений (только для админов)
  if (user.role === 'admin' || user.role === 'hero_admin') {
    window.user = user; // Сохраняем user в window для доступа из notifications.js
    initNotifications(socket);
  }
  
  // Системный монитор теперь отображается в модальном окне настроек
});

async function loadDevices() {
  devicesCache = await loadDevicesModule(adminFetch, sortDevices, nodeNames);
  updateDevicesCount();
}

// Обновление количества устройств в заголовке панели
function updateDevicesCount() {
  const devicesMeta = document.getElementById('devicesMeta');
  if (devicesMeta) {
    const count = devicesCache.length;
    devicesMeta.textContent = count > 0 ? `${count}` : '0';
  }
  // Обновляем счетчик в header
  const devicesCount = document.getElementById('devicesCount');
  if (devicesCount) {
    const count = devicesCache.length;
    devicesCount.textContent = count > 0 ? `${count}` : '0';
  }
}

// renderTVList перенесена в devices-manager.js
function renderTVList() {
  return renderTVListModule(deviceListCtx);
}

// Точечное обновление статусов устройств без перерисовки списка
function syncDeviceListStatuses() {
  syncDeviceStatuses(deviceListCtx);
}

// Переводит список устройств на страницу с нужным устройством
function focusDeviceInList(deviceId) {
  focusDeviceInListModule(deviceId, deviceListCtx);
}

// Пересчет пагинации при изменении размера экрана (desktop/mobile)
// Перерисовка только если размер страницы реально изменился,
// иначе resize-шторм (например, при появлении скроллбара) не трогает список.
let lastDevicePageSize = null;
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    const nextPageSize = getPageSize();
    if (lastDevicePageSize !== null && nextPageSize === lastDevicePageSize) return;
    lastDevicePageSize = nextPageSize;
    if (document.getElementById('tvList')) renderTVList();
    // Также перерисовываем список файлов если он открыт
    if (currentDeviceId) renderFilesPane(currentDeviceId);
  }, 250);
});

async function loadAndSetNodeNames() {
  nodeNames = await loadNodeNames(adminFetch);
}
function renderLayout() {
  grid.innerHTML = `
    <div id="devicesPane" class="card admin-panel admin-panel-devices" style="display:flex; flex-direction:column; min-height:0">
      <div class="header" style="display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm); margin-bottom:var(--space-sm)">
        <div class="title" style="margin:0; font-size:var(--font-size-base)">Устройства</div>
        <div style="display:flex; align-items:center; gap:var(--space-sm);">
          <div class="meta" id="devicesMeta" style="margin:0; white-space:nowrap">0</div>
          <button id="devicesBtn" class="meta-lg" type="button" style="padding:6px; display:flex; align-items:center; justify-content:center; min-width:28px; height:28px; border:none; background:transparent;" title="Добавить устройство">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="admin-panel-body" style="display:flex; flex-direction:column; gap:var(--space-sm); flex:1 1 auto; min-height:0">
        <ul id="tvList" class="list" style="flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; display:flex; flex-direction:column; gap:var(--space-sm)"></ul>
        <div id="tvPager" class="meta" style="display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm); flex-wrap:wrap"></div>
      </div>
    </div>

    <div id="detailPane" class="admin-panel admin-panel-detail" style="min-height:0; display:flex; flex-direction:column"></div>

    <div id="filesPane" class="card admin-panel admin-panel-files" style="min-height:0; display:flex; flex-direction:column">
      <div class="header" style="display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm); margin-bottom:var(--space-sm)">
        <div class="title" id="filesPaneTitle" style="margin:0; font-size:var(--font-size-base)">Файлы</div>
        <div style="display:flex; align-items:center; gap:var(--space-sm); flex-wrap:wrap">
          <div class="meta" id="filesPaneMeta" style="margin:0; white-space:nowrap">Выберите устройство слева</div>
        </div>
      </div>
      <div class="admin-panel-body" style="display:flex; flex-direction:column; gap:var(--space-sm); flex:1 1 auto; min-height:0">
      <div id="filesPanel" style="flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden"></div>
        <div id="filePagerAdmin" class="meta" style="display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm); flex-wrap:wrap"></div>
      </div>
    </div>
  `;

  renderTVList();
}

async function promptAddStream() {
  if (!currentDeviceId) {
    await reportAdminUiNotification({
      type: 'stream_add_no_device',
      severity: 'info',
      title: 'Сначала выберите устройство',
      message: 'Для добавления стрима выберите устройство слева',
      key: 'stream-add-no-device'
    });
    return;
  }
  const { showStreamModal } = await import('./admin/files-manager.js');
  await showStreamModal({
    deviceId: currentDeviceId,
    mode: 'add',
    onSuccess: async () => {
      await renderFilesPane(currentDeviceId);
    }
  });
}

function guessStreamProtocolFromUrl(url = '') {
  const lower = url.toLowerCase();
  if (lower.includes('.m3u8') || lower.includes('format=m3u8')) return 'hls';
  if (lower.includes('.mpd') || lower.includes('format=mpd') || lower.includes('dash')) return 'dash';
  return 'hls';
}

// ------ Заполнение select ------
/* removed obsolete populateSelect (dropdown was removed) */

function hasDeviceId(deviceId) {
  return Boolean(resolveDeviceId(deviceId));
}

function normalizeDeviceId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveDeviceId(candidate) {
  const normalized = normalizeDeviceId(candidate);
  if (!normalized) return null;

  const exact = devicesCache.find(d => d.device_id === normalized);
  if (exact) return exact.device_id;

  const lowered = normalized.toLowerCase();
  const caseInsensitive = devicesCache.find(d => String(d.device_id || '').toLowerCase() === lowered);
  return caseInsensitive ? caseInsensitive.device_id : null;
}

function getFallbackDeviceId() {
  if (!devicesCache.length) return null;
  const ready = devicesCache.find(d => readyDevices.has(d.device_id));
  const fallback = ready || devicesCache[0];
  return fallback && fallback.device_id ? fallback.device_id : null;
}

async function ensureSelectedDevice(preferredId = null) {
  const url = new URL(location.href);
  const queryDeviceId = normalizeDeviceId(url.searchParams.get('device_id'));

  const candidates = [preferredId, queryDeviceId, currentDeviceId, getFallbackDeviceId()];
  let targetDeviceId = null;
  for (const candidate of candidates) {
    const resolved = resolveDeviceId(candidate);
    if (resolved) {
      targetDeviceId = resolved;
      break;
    }
  }

  if (!targetDeviceId && devicesCache.length) {
    targetDeviceId = devicesCache[0].device_id;
  }

  if (!targetDeviceId) {
    currentDeviceId = null;
    return false;
  }

  if (queryDeviceId && queryDeviceId !== targetDeviceId) {
    // Нормализуем URL, если параметр device_id невалиден или отличается регистром.
    openDeviceHelper(targetDeviceId);
  }

  openDevice(targetDeviceId);
  try {
    await renderFilesPane(targetDeviceId);
  } catch (err) {
    console.warn('[Admin] Не удалось загрузить список файлов для выбранного устройства', targetDeviceId, err?.message || err);
    clearFilesPane('Ошибка загрузки файлов', 'Повторите попытку позже или проверьте подключение к серверу.');
  }
  renderTVList();
  return true;
}

// ------ Старт из URL ?device_id ------
async function initSelectionFromUrl() {
  const hasSelection = await ensureSelectedDevice();
  if (!hasSelection) {
    clearDetail('Нет устройств', 'Откройте плеер или добавьте устройство, чтобы начать управление.');
    clearFilesPane('Нет устройств', 'Файлы появятся после подключения хотя бы одного устройства.');
    renderTVList();
  }
}

// clearDetail, clearFilesPane перенесены в ui-helpers.js

// ------ Открыть выбранную ноду ------

// Сигнатура карточки, которая сейчас отрисована в #detailPane.
// Пока она совпадает с сигнатурой пришедших данных, пересоздавать карточку
// не нужно: это заново вызывало setupUploadUI() и сбрасывало очередь
// загрузки/yt-dlp на каждом событии devices/updated.
let renderedDeviceCardSignature = '';

function refreshDevicePreview(device) {
  const pane = document.getElementById('detailPane');
  if (!pane || !device) return;
  const url = buildDevicePreviewUrl(device);
  if (!url) return;
  pane.querySelectorAll('iframe[data-preview-url]').forEach((iframe) => {
    const base = (iframe.getAttribute('data-preview-url') || '').split('&t=')[0];
    if (base !== url) iframe.setAttribute('data-preview-url', url);
    iframe.src = `${url}&t=${Date.now()}`;
  });
}

function openDevice(id) {
  currentDeviceId = id;
  // ИСПРАВЛЕНО: Восстанавливаем сохраненную страницу для устройства или сбрасываем на 0
  filePage = filePageByDevice.get(id) || 0;

  // Обновляем URL при переключении устройства
  openDeviceHelper(id);

  const d = devicesCache.find(x => x.device_id === id);
  const pane = document.getElementById('detailPane');
  if (!pane) return;
  if (!d) {
    clearDetail('Устройство не найдено', 'Выберите другое устройство в списке слева.');
    clearFilesPane();
    renderedDeviceCardSignature = '';
    return;
  }

  const signature = deviceCardSignature(d, readyDevices, nodeNames);
  if (pane.dataset.deviceId === id && renderedDeviceCardSignature === signature) {
    // Данные не изменились — только освежаем превью, карточку не трогаем
    refreshDevicePreview(d);
    return;
  }

  pane.innerHTML = '';
  pane.appendChild(renderDeviceCard(d));
  pane.dataset.deviceId = id;
  renderedDeviceCardSignature = signature;
  setupVolumePanel(d.device_id);
}

// renderDeviceCard перенесена в device-card.js
function renderDeviceCard(d) {
  return renderDeviceCardModule(d, nodeNames, readyDevices, loadDevices, renderTVList, openDevice, renderFilesPane, socket, focusDeviceInList);
}

// ------ Правая колонка: файлы выбранной ноды ------

// Порядковый номер последнего запуска перерисовки панели файлов.
// Нужен, чтобы устаревший ответ сетевого запроса не перерисовал панель
// поверх более свежего (панель уходит в "Загрузка списка..." и остаётся с
// устаревшими данными).
let filesPaneRenderToken = 0;

function formatFilesCountLabel(count) {
  const word = count === 1 ? '' : count > 1 && count < 5 ? 'а' : 'ов';
  return `${count} файл${word}`;
}

// Точечное обновление панели файлов текущего устройства (file/ready, file/error).
// ИСПРАВЛЕНО: используется тот же счётчик, что и renderFilesPane, поэтому
// устаревший ответ не перезапишет панель, обновляемую более новым запросом.
function refreshFilesPaneContent(deviceId) {
  const panel = document.getElementById('filesPanel');
  if (!panel) return;
  const token = filesPaneRenderToken;
  refreshFilesPanel(deviceId, panel, () => token !== filesPaneRenderToken).then(updatedPage => {
    if (token !== filesPaneRenderToken) return;
    if (updatedPage !== undefined) {
      filePageByDevice.set(deviceId, updatedPage);
      filePage = updatedPage;
    }
    reapplyFileProgress(panel, deviceId);
  });
}

async function renderFilesPane(deviceId) {
  const title = document.getElementById('filesPaneTitle');
  const meta = document.getElementById('filesPaneMeta');
  const panel = document.getElementById('filesPanel');
  if (!panel) return;

  const token = ++filesPaneRenderToken;

  // Находим устройство для отображения имени и количества файлов
  const device = devicesCache.find(d => d.device_id === deviceId);
  const deviceName = device ? (device.name || nodeNames[deviceId] || deviceId) : deviceId;
  const filesCount = device ? (device.files?.length || 0) : 0;

  // Обновляем заголовок и meta
  if (title) title.textContent = `Файлы на ${deviceName}`;
  if (meta) meta.textContent = formatFilesCountLabel(filesCount);

  // Плейсхолдер показываем только когда панель ещё не содержит этого
  // устройства. Иначе каждое фоновое обновление очищало бы панель
  // и затем перерисовывала её — то самое мерцание, которого быть не должно.
  const panelDeviceId = panel.dataset.deviceId || '';
  const showingSameDevice = panelDeviceId === deviceId && panel.childElementCount > 0;
  if (!showingSameDevice) {
    panel.dataset.deviceId = deviceId;
    panel.innerHTML = `<div class="meta">Загрузка списка...</div>`;
  }

  const scrollTop = panel.scrollTop;

  // ИСПРАВЛЕНО: Восстанавливаем сохраненную страницу для устройства
  const savedPage = filePageByDevice.get(deviceId) || 0;
  filePage = savedPage;
  const updatedPage = await refreshFilesPanel(deviceId, panel, () => token !== filesPaneRenderToken);

  // Пока ждал ответ, панель могли перерисовать для другого устройства
  if (token !== filesPaneRenderToken) return;

  if (updatedPage !== undefined) {
    filePageByDevice.set(deviceId, updatedPage);
    filePage = updatedPage;
  }

  // Фоновое обновление не должно прокручивать панель к началу
  if (showingSameDevice) panel.scrollTop = scrollTop;

  // Панель перерисована — возвращаем полосы прогресса, которые удалил innerHTML
  reapplyFileProgress(panel, deviceId);

  // Обновляем счетчик файлов после загрузки
  const updatedDevice = devicesCache.find(d => d.device_id === deviceId);
  const updatedFilesCount = updatedDevice ? (updatedDevice.files?.length || 0) : filesCount;
  if (meta) meta.textContent = formatFilesCountLabel(updatedFilesCount);
}


// refreshFilesPanel перенесена в files-manager.js
async function refreshFilesPanel(deviceId, panelEl, isStale = null) {
  // ИСПРАВЛЕНО: Используем сохраненную страницу для устройства или текущую глобальную
  const savedPage = filePageByDevice.get(deviceId) ?? filePage;
  // ИСПРАВЛЕНО: Передаем callback для обновления страницы при пагинации
  const onPageUpdate = (updatedPage) => {
    filePageByDevice.set(deviceId, updatedPage);
    filePage = updatedPage;
  };
  const updatedPage = await refreshFilesPanelModule(deviceId, panelEl, adminFetch, getPageSize, savedPage, socket, onPageUpdate, isStale);
  if (isStale && isStale()) return undefined;
  // ИСПРАВЛЕНО: Сохраняем обновленную страницу для устройства
  if (updatedPage !== undefined) {
    filePageByDevice.set(deviceId, updatedPage);
    filePage = updatedPage;
  }
  return updatedPage;
}

// Обновление только прогресс-бара файла без перерисовки всей панели.
// Раньше искался класс .file-name, которого в разметке нет (там .file-item-name),
// поэтому прогресс-бар не появлялся никогда, а поиск шёл по всему документу
// и совпадал по отображаемому имени, а не по устройству.
// Актуальный прогресс обработки хранится вне DOM: любая перерисовка панели
// файлов (devices/updated, file/ready, смена устройства) удаляет элементы
// вместе с прогресс-баром. Раньше это выглядело как мигание — бар исчезал и
// появлялся заново уже на другом значении.
const fileProgressByDevice = new Map(); // deviceId -> Map<safeName, {progress, done, ts}>

// Есть ли в уже отрисованном списке файл, который сейчас обрабатывается и чей
// прогресс приходит по сокету. Пока true, полную перерисовку списка пропускаем:
// иначе DOM полосы удаляется и создаётся заново — визуально «моргание».
// Проверяем именно по видимым элементам: у папок прогресс приходит на исходный
// PDF, а в списке лежит имя папки, поэтому такие случаи не блокируем и они, как
// и раньше, обновляются перерисовкой.
function hasActiveProcessing(deviceId) {
  const byFile = fileProgressByDevice.get(deviceId);
  if (!byFile || !byFile.size) return false;
  const panel = document.getElementById('filesPanel');
  if (!panel || (panel.dataset.deviceId || '') !== (deviceId || '')) return false;
  const shown = new Set();
  panel.querySelectorAll('.file-item').forEach((item) => {
    try {
      shown.add(decodeURIComponent(item.getAttribute('data-file-name') || ''));
    } catch {
      // некорректный атрибут — пропускаем
    }
  });
  for (const [name, entry] of byFile.entries()) {
    if (entry && !entry.done && entry.progress < 100 && shown.has(name)) return true;
  }
  return false;
}

function setFileProgress(deviceId, fileName, progress) {
  if (!deviceId || !fileName) return null;
  const numeric = Number(progress);
  let byFile = fileProgressByDevice.get(deviceId);
  if (!byFile) {
    byFile = new Map();
    fileProgressByDevice.set(deviceId, byFile);
  }

  const prev = byFile.get(fileName);

  // Мусорное значение (undefined, NaN, не строка) не должно обнулять полосу —
  // иначе одно битое событие откатывало бы уже показанный прогресс на 0%.
  if (!Number.isFinite(numeric)) return prev || null;

  const value = Math.max(0, Math.min(100, numeric));

let next = value;
    if (prev && !prev.done && value < prev.progress) {
      // Внутри одного запуска прогресс не откатывается назад. Раньше здесь
      // был отдельный случай «нового запуска» (0-5 при прогрессе > 5),
      // но файл проходит несколько стадий подряд (метаданные -> оптимизация
      // -> конвертация), и каждая начинает с 0, из-за чего полоса прыгала
      // назад и цикл 0->100% повторялся по кругу.
      next = prev.progress;
    } else if (prev && prev.done && value > 0 && value < 100) {
      // Файл уже дошёл до 100%, пришло запоздалое событие прошлой стадии —
      // готовый файл обратно в обработку не отправляем. Сброс на 0 при этом
      // остаётся легальным: это уже новый запуск.
      return prev;
    }

  const entry = { progress: next, done: next >= 100, ts: Date.now() };
  byFile.set(fileName, entry);
  return entry;
}

function getFileProgress(deviceId, fileName) {
  return fileProgressByDevice.get(deviceId)?.get(fileName) || null;
}

function clearFileProgress(deviceId, fileName) {
  if (!deviceId) return;
  const byFile = fileProgressByDevice.get(deviceId);
  if (!byFile) return;
  if (fileName) byFile.delete(fileName);
  else byFile.clear();
  if (!byFile.size) fileProgressByDevice.delete(deviceId);
}

function ensureProgressBar(fileEl) {
  let progressBar = fileEl.querySelector('.optimization-progress');
  if (progressBar) return progressBar;

  // Геометрию задаём инлайном, а не только через CSS.
  // Статика отдаётся service worker по стратегии stale-while-revalidate:
  // при первом обращении браузер получает СТАРЫЙ app.css из кэша, и полоса,
  // оформленная только таблицей стилей, оказывалась обычным flex-потом
  // внутри карточки с фиксированной высотой и overflow:hidden — то есть
  // то появлялась, то исчезала. Инлайн не зависит от версии кэша.
  const currentPos = window.getComputedStyle?.(fileEl)?.position;
  if (!currentPos || currentPos === 'static') {
    fileEl.style.position = 'relative';
  }

  progressBar = document.createElement('div');
  progressBar.className = 'optimization-progress';
  progressBar.style.cssText = [
    'position:absolute',
    'left:0',
    'right:0',
    'bottom:0',
    'height:4px',
    'background:rgba(0,0,0,0.12)',
    'border-radius:0 0 var(--radius-sm,6px) var(--radius-sm,6px)',
    'overflow:hidden',
    'pointer-events:none'
  ].join(';');

  const progressFill = document.createElement('div');
  progressFill.className = 'optimization-progress-fill';
  progressFill.style.cssText = [
    'height:100%',
    'width:0%',
    'background:linear-gradient(90deg, #4CAF50, #8BC34A)',
    'transition:width 0.3s ease'
  ].join(';');

  progressBar.appendChild(progressFill);
  fileEl.appendChild(progressBar);
  return progressBar;
}

function applyProgressToElement(fileEl, entry, { animate = true } = {}) {
  const progressBar = ensureProgressBar(fileEl);
  const fill = progressBar.querySelector('.optimization-progress-fill');
  if (fill) {
    // При восстановлении после перерисовки анимация не нужна: bar только что
    // появился с нулевой шириной, и проигрывание transition выглядит как моргание.
    if (!animate) {
      const prevTransition = fill.style.transition;
      fill.style.transition = 'none';
      fill.style.width = `${entry.progress}%`;
      // Возвращаем transition после того, как браузер применит новую ширину
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => { fill.style.transition = prevTransition; });
      } else {
        fill.style.transition = prevTransition;
      }
    } else {
      fill.style.width = `${entry.progress}%`;
    }
  }
// Полосу не гасим на 100%: раньше здесь ставилась прозрачность 0.35,
    // и на переходах вид/готово бар резко бледнел, а при перерисовке панели
    // вообще пересоздавался с нулевой шириной — отсюда «мигание».
    // Готовый файл просто не рисует полосу: запись прогресса очищается
    // по file/ready.
    progressBar.style.opacity = '1';
}

// Восстанавливает полосы прогресса после перерисовки панели файлов
function reapplyFileProgress(panelEl, deviceId) {
    if (!panelEl) return;
    // Ранний выход по пустому хранилищу убран: у папок прогресс приходит
    // не из сокета, а из data-progress, и хранилище в этом случае пустое.
    const byFile = fileProgressByDevice.get(deviceId);
    panelEl.querySelectorAll('.file-item').forEach((item) => {
    if ((item.getAttribute('data-device-id') || '') !== (deviceId || '')) return;
    let safeName = '';
    try {
      safeName = decodeURIComponent(item.getAttribute('data-file-name') || '');
    } catch {
      return;
    }
const entry = byFile?.get(safeName);
      if (entry) {
        applyProgressToElement(item, entry, { animate: false });
        return;
      }
      // События сокета может не быть: для папок прогресс пишется в статусе
      // исходного PDF, а в списке лежит имя папки. Тогда берём значение из
      // data-progress, который проставлен при рендере, — иначе подпись
      // показывала «Обработка N%», а полоса бы не появилась вовсе.
      // Проверяем наличие атрибута явно: у готового файла его нет, а
      // Number(null) === 0 и молча посадил бы прогресс 0.
      const raw = item.getAttribute('data-progress');
      if (raw === null) return;
      const attr = Number(raw);
      if (!Number.isFinite(attr)) return;
const seeded = setFileProgress(deviceId, safeName, attr);
      if (seeded) applyProgressToElement(item, seeded, { animate: false });
    });
  }

function updateFileProgress(deviceId, fileName, progress) {
  if (!fileName) return;
  const entry = setFileProgress(deviceId, fileName, progress);
  if (!entry) return;

  const panel = document.getElementById('filesPanel');
  if (!panel) return;

  // Точное совпадение по устройству и безопасному имени файла
  const fileEl = Array.from(panel.querySelectorAll('.file-item')).find((item) => {
    if ((item.getAttribute('data-device-id') || '') !== (deviceId || '')) return false;
    try {
      return decodeURIComponent(item.getAttribute('data-file-name') || '') === fileName;
    } catch {
      return false;
    }
  });
  if (!fileEl) return;

  applyProgressToElement(fileEl, entry);

  // Подпись «Обработка N%» раньше обновлялась только при перерисовке панели,
  // поэтому между перерисовками застывала на значении первого рендера.
  const statusTextEl = fileEl.querySelector('.file-item-status-text');
  if (statusTextEl) {
    const icon = statusTextEl.querySelector('svg');
    const text = describeProcessing(entry.progress).text;
    statusTextEl.textContent = '';
    if (icon) statusTextEl.appendChild(icon);
    statusTextEl.appendChild(document.createTextNode(` ${text}`));
  }
}

// setupUploadUI перенесена в upload-ui.js
function setupUploadUI(card, deviceId, filesPanelEl) {
  return setupUploadUIModule(card, deviceId, filesPanelEl, renderFilesPane, socket);
}

function clampVolumePercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return Math.max(0, Math.min(100, Math.round(clamped / VOLUME_STEP) * VOLUME_STEP));
}

function storeVolumeState(deviceId, state = {}) {
  if (!deviceId) return;
  const prev = volumeStateByDevice.get(deviceId) || { level: 50, muted: false, updatedAt: null };
  const levelCandidate = typeof state.level === 'number' ? clampVolumePercent(state.level) : null;
  const nextLevel = levelCandidate !== null ? levelCandidate : prev.level;
  const nextMuted = typeof state.muted === 'boolean' ? state.muted : prev.muted;
  volumeStateByDevice.set(deviceId, {
    level: nextLevel,
    muted: nextMuted,
    updatedAt: state.updated_at || prev.updatedAt || null
  });
  if (deviceId === currentDeviceId) {
    updateVolumePanel(deviceId);
  }
}

function handleVolumeBatch(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object') return;
  Object.entries(snapshot).forEach(([deviceId, state]) => {
    storeVolumeState(deviceId, state || {});
  });
}

function handleVolumeUpdate(payload = {}) {
  const deviceId = payload.device_id || payload.deviceId;
  if (!deviceId) return;
  storeVolumeState(deviceId, payload);
}

function sendVolumeCommand(deviceId, params = {}) {
  if (!deviceId) return;
  const payload = {
    device_id: deviceId,
    ...params
  };
  const hasLevelChange = typeof payload.level === 'number' && !Number.isNaN(payload.level);
  const hasDeltaChange = typeof payload.delta === 'number' && !Number.isNaN(payload.delta);
  if (typeof payload.muted === 'undefined' && (hasLevelChange || hasDeltaChange)) {
    payload.muted = false;
  }
  socket.emit('control/volume', payload);

  // Оптимистично обновляем локальное состояние, чтобы UI сразу реагировал
  const current = volumeStateByDevice.get(deviceId) || {};
  const nextLevel = hasLevelChange
    ? clampVolumePercent(payload.level)
    : hasDeltaChange && typeof current.level === 'number'
      ? clampVolumePercent(current.level + payload.delta)
      : current.level;
  const nextMuted = typeof payload.muted === 'boolean' ? payload.muted : current.muted;
  if (typeof nextLevel === 'number' || typeof nextMuted === 'boolean') {
    storeVolumeState(deviceId, {
      level: typeof nextLevel === 'number' ? nextLevel : current.level,
      muted: typeof nextMuted === 'boolean' ? nextMuted : current.muted
    });
  }
}

function updateVolumePanel(deviceId = currentDeviceId) {
  const slider = document.getElementById('adminVolumeSlider');
  const valueEl = document.getElementById('adminVolumeValue');
  const statusEl = document.getElementById('adminVolumeStatus');
  const muteBtn = document.getElementById('adminVolumeMute');
  const panel = document.getElementById('adminVolumePanel');
  if (!panel) return;
  
  const hasDevice = Boolean(deviceId);
  const state = deviceId ? volumeStateByDevice.get(deviceId) : null;
  const isReady = deviceId ? readyDevices.has(deviceId) : false;
  const disabled = !state;
  const isOffline = hasDevice && !isReady;
  
  if (slider) {
    slider.disabled = disabled;
    if (state && typeof state.level === 'number') {
      slider.value = clampVolumePercent(state.level) ?? slider.value;
    }
  }
  if (muteBtn) muteBtn.disabled = disabled;
  
  // Обновляем иконку кнопки mute
  if (muteBtn) {
    const iconEl = muteBtn.querySelector('.volume-btn-icon');
    let iconHtml;
    let actionLabel;
    let iconColor = 'currentColor';
    
    if (!state) {
      iconHtml = getVolumeUnknownIcon(20, iconColor);
      actionLabel = hasDevice ? 'Нет данных' : 'Выберите устройство';
    } else {
      const isMuted = state.muted;
      // Определяем цвет иконки: красный для muted, зеленый для unmuted
      iconColor = isMuted ? 'var(--danger)' : 'var(--success)';
      iconHtml = isMuted ? getVolumeMutedIcon(20, iconColor) : getVolumeOnIcon(20, iconColor);
      actionLabel = isMuted ? 'Включить звук' : 'Заглушить звук';
    }
    
    if (iconEl) {
      iconEl.innerHTML = iconHtml;
    } else {
      muteBtn.innerHTML = `<span class="volume-btn-icon" aria-hidden="true">${iconHtml}</span>`;
    }
    muteBtn.setAttribute('aria-label', actionLabel);
    muteBtn.setAttribute('title', actionLabel);
  }
  
  if (!state) {
    if (valueEl) valueEl.textContent = '--%';
    if (statusEl) {
      statusEl.textContent = hasDevice
        ? 'Нет данных'
        : 'Выберите устройство';
    }
    return;
  }
  
  const level = clampVolumePercent(state.level) ?? 0;
  if (valueEl) valueEl.textContent = `${level}%`;
  if (statusEl) {
    let statusText = state.muted ? 'Звук выключен' : 'Звук включен';
    statusEl.textContent = statusText;
  }
}

async function ensureVolumeState(deviceId) {
  if (!deviceId) return;
  if (!volumeStateByDevice.has(deviceId)) {
    await fetchVolumeState(deviceId);
  } else {
    updateVolumePanel(deviceId);
  }
}

async function fetchVolumeState(deviceId) {
  if (!deviceId) return;
  try {
    const res = await adminFetch(`/api/devices/${encodeURIComponent(deviceId)}/volume`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    storeVolumeState(deviceId, data);
  } catch (err) {
    console.warn('[Admin] Не удалось получить громкость устройства', deviceId, err.message);
  }
}

function setupVolumePanel(deviceId) {
  const slider = document.getElementById('adminVolumeSlider');
  const muteBtn = document.getElementById('adminVolumeMute');
  const valueEl = document.getElementById('adminVolumeValue');
  const statusEl = document.getElementById('adminVolumeStatus');
  if (!slider || !muteBtn || !statusEl || !valueEl) return;
  
  slider.addEventListener('input', () => {
    valueEl.textContent = `${slider.value}%`;
  });
  slider.addEventListener('change', () => {
    if (slider.disabled) return;
    sendVolumeCommand(deviceId, { level: Number(slider.value) });
  });
  muteBtn.addEventListener('click', () => {
    if (muteBtn.disabled) return;
    const state = volumeStateByDevice.get(deviceId);
    sendVolumeCommand(deviceId, { muted: !(state && state.muted) });
  });
  
  updateVolumePanel(deviceId);
  ensureVolumeState(deviceId);
}

// ------ Периодическая проверка статусов файлов в обработке ------
// Полная перерисовка панели при каждом тике удаляла прогресс-бар и создавала
// его заново — визуально это выглядело как мигание. Сам прогресс приходит по
// сокету (file/progress) и рисуется точечно, поэтому перерисовываем панель
// только когда меняется НАБОР статусов (файл появился/перешёл в обработку или
// завершил её), а не при обычном изменении процентов.
const processingSignatureByDevice = new Map();

setInterval(async () => {
  if (!currentDeviceId) return;

  try {
    const res = await adminFetch(`/api/devices/${encodeURIComponent(currentDeviceId)}/files-with-status`);
    const filesData = await res.json();

    const signature = filesData
      .filter(f => f.status === 'processing' || f.status === 'checking')
      .map(f => `${f.safeName}:${f.status}`)
      .sort()
      .join('|');

    const prevSignature = processingSignatureByDevice.get(currentDeviceId) || '';
    if (signature === prevSignature) {
      return;
    }
    processingSignatureByDevice.set(currentDeviceId, signature);

    const panel = document.getElementById('filesPanel');
    if (panel) {
      const updatedPage = await refreshFilesPanel(currentDeviceId, panel);
      if (updatedPage !== undefined) {
        filePageByDevice.set(currentDeviceId, updatedPage);
        filePage = updatedPage;
      }
    }
  } catch (e) {
    // Игнорируем ошибки (например если устройство удалено)
  }
}, 3000); // Проверяем каждые 3 секунды
