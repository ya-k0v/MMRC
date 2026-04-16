/**
 * Модальные окна для admin панели
 * @module admin/modal
 */

import { 
  getAndroidIcon, 
  getUsersIcon, 
  getKeyIcon, 
  getLockIcon, 
  getUnlockIcon, 
  getTrashIcon, 
  getSuccessIcon, 
  getSettingsIcon, 
  getDownloadIcon, 
  getUpDownloadIcon,
  getCloseIcon 
} from '../shared/svg-icons.js';
import { escapeHtml } from '../shared/utils.js';

const escapeJsStringForAttr = (value) => escapeHtml(JSON.stringify(value ?? ''));
const modalHistoryStack = [];
let activeModalEscHandler = null;
const SERVICE_LOGS_POLL_INTERVAL_MS = 1200;
const SERVICE_LOGS_TYPING_CHUNK = 84;
const SERVICE_LOGS_TYPING_DELAY_MS = 10;
const SERVICE_LOGS_FAST_APPEND_THRESHOLD = 3200;
const SERVICE_LOGS_MAX_TYPING_QUEUE = 24000;
const SERVICE_LOGS_MAX_CHARS = 350000;
let serviceLogsViewerState = null;

function bindModalOverlayHandlers(overlay) {
  if (!overlay) return;

  // Закрываем только при "точном" клике по фону:
  // pointerdown и pointerup должны произойти на overlay.
  let pointerDownOnOverlay = false;
  overlay.onclick = null;
  overlay.onpointerdown = (e) => {
    pointerDownOnOverlay = e.target === overlay;
  };
  overlay.onpointerup = (e) => {
    const shouldClose = pointerDownOnOverlay && e.target === overlay;
    pointerDownOnOverlay = false;
    if (shouldClose) {
      closeModal();
    }
  };
  overlay.onpointercancel = () => {
    pointerDownOnOverlay = false;
  };
}

function bindModalEscHandler() {
  if (activeModalEscHandler) {
    document.removeEventListener('keydown', activeModalEscHandler);
  }

  activeModalEscHandler = (e) => {
    if (e.key !== 'Escape') return;

    if (modalHistoryStack.length > 0) {
      goBackModal();
      return;
    }

    closeModal();
  };

  document.addEventListener('keydown', activeModalEscHandler);
}

export function goBackModal() {
  stopServiceLogsViewer();

  const overlay = document.getElementById('modalOverlay');
  const modalContent = document.getElementById('modalContent');
  if (!overlay || !modalContent) return;

  const previousState = modalHistoryStack.pop();
  if (!previousState) return;

  while (modalContent.firstChild) {
    modalContent.removeChild(modalContent.firstChild);
  }

  modalContent.style.maxWidth = previousState.maxWidth || '600px';
  previousState.nodes.forEach((node) => {
    modalContent.appendChild(node);
  });

  overlay.style.display = 'flex';
  bindModalOverlayHandlers(overlay);
  bindModalEscHandler();
}

async function reportModalNotification(payload = {}) {
  try {
    if (typeof window.adminFetch !== 'function') return;

    await window.adminFetch('/api/notifications/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: payload.type || 'admin_modal_event',
        severity: payload.severity || 'warning',
        title: payload.title || 'Ошибка в модальном окне',
        message: payload.message || '',
        details: payload.details || {},
        key: payload.key || null,
        source: 'admin-modal'
      })
    });
  } catch (error) {
    console.error('[Modal] Failed to report notification:', error);
  }
}

function stopServiceLogsViewer() {
  const state = serviceLogsViewerState;
  if (!state) return;

  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }

  if (state.typeTimer) {
    clearTimeout(state.typeTimer);
  }

  serviceLogsViewerState = null;
}

function getServiceLogsElements() {
  return {
    outputEl: document.getElementById('serviceLogsOutput'),
    statusEl: document.getElementById('serviceLogsStatus'),
    linesSelectEl: document.getElementById('serviceLogsLinesSelect'),
    autoscrollEl: document.getElementById('serviceLogsAutoscroll')
  };
}

function clampServiceLogsLines(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return 200;
  return Math.max(20, Math.min(2000, parsed));
}

function setServiceLogsStatus(text, color = 'var(--text-secondary)') {
  const { statusEl } = getServiceLogsElements();
  if (!statusEl) return;
  statusEl.textContent = text || '';
  statusEl.style.color = color;
}

function trimServiceLogsOutput(outputEl) {
  if (!outputEl || outputEl.textContent.length <= SERVICE_LOGS_MAX_CHARS) return;

  const tailText = outputEl.textContent.slice(-(SERVICE_LOGS_MAX_CHARS + 4096));
  const firstLineBreak = tailText.indexOf('\n');
  outputEl.textContent = firstLineBreak >= 0 ? tailText.slice(firstLineBreak + 1) : tailText;
}

function flushServiceLogsTypewriterQueue(state, outputEl) {
  if (!outputEl) return;

  if (state.typeTimer) {
    clearTimeout(state.typeTimer);
    state.typeTimer = null;
  }

  state.isTyping = false;

  if (state.textQueue) {
    outputEl.textContent += state.textQueue;
    state.textQueue = '';
    trimServiceLogsOutput(outputEl);

    if (state.autoScroll) {
      outputEl.scrollTop = outputEl.scrollHeight;
    }
  }
}

function runServiceLogsTypewriter() {
  const state = serviceLogsViewerState;
  if (!state || state.isTyping) return;

  const { outputEl } = getServiceLogsElements();
  if (!outputEl) {
    stopServiceLogsViewer();
    return;
  }

  state.isTyping = true;

  const step = () => {
    const activeState = serviceLogsViewerState;
    if (!activeState || activeState !== state) return;

    const { outputEl: liveOutput } = getServiceLogsElements();
    if (!liveOutput) {
      stopServiceLogsViewer();
      return;
    }

    if (!activeState.textQueue.length) {
      activeState.isTyping = false;
      activeState.typeTimer = null;
      return;
    }

    const chunkSize = Math.min(SERVICE_LOGS_TYPING_CHUNK, activeState.textQueue.length);
    const chunk = activeState.textQueue.slice(0, chunkSize);
    activeState.textQueue = activeState.textQueue.slice(chunk.length);
    liveOutput.textContent += chunk;
    trimServiceLogsOutput(liveOutput);

    if (activeState.autoScroll) {
      liveOutput.scrollTop = liveOutput.scrollHeight;
    }

    activeState.typeTimer = window.setTimeout(step, SERVICE_LOGS_TYPING_DELAY_MS);
  };

  step();
}

function enqueueServiceLogsText(text, options = {}) {
  if (!text || !serviceLogsViewerState) return;

  const state = serviceLogsViewerState;
  const { outputEl } = getServiceLogsElements();
  if (!outputEl) return;

  const forceImmediate = Boolean(options.forceImmediate);
  const hasPendingOverflow = (state.textQueue.length + text.length) > SERVICE_LOGS_MAX_TYPING_QUEUE;
  const shouldAppendImmediately = forceImmediate || text.length >= SERVICE_LOGS_FAST_APPEND_THRESHOLD || hasPendingOverflow;

  if (shouldAppendImmediately) {
    flushServiceLogsTypewriterQueue(state, outputEl);
    outputEl.textContent += text;
    trimServiceLogsOutput(outputEl);

    if (state.autoScroll) {
      outputEl.scrollTop = outputEl.scrollHeight;
    }
    return;
  }

  state.textQueue += text;
  runServiceLogsTypewriter();
}

async function fetchServiceLogsChunk(adminFetch, { reset = false } = {}) {
  const state = serviceLogsViewerState;
  if (!state || state.isFetching) return;

  const { outputEl, linesSelectEl } = getServiceLogsElements();
  if (!outputEl) {
    stopServiceLogsViewer();
    return;
  }

  const linesLimit = clampServiceLogsLines(linesSelectEl?.value || state.linesLimit || 200);
  state.linesLimit = linesLimit;
  state.isFetching = true;

  try {
    const params = new URLSearchParams();
    params.set('lines', String(linesLimit));

    if (!reset && Number.isFinite(state.offset) && state.offset >= 0) {
      params.set('offset', String(state.offset));
    }

    if (!reset && state.fileName) {
      params.set('fileName', state.fileName);
    }

    const response = await adminFetch(`/api/admin/service-logs?${params.toString()}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Ошибка загрузки логов' }));
      throw new Error(error.error || 'Ошибка загрузки логов');
    }

    const result = await response.json().catch(() => ({ ok: true, lines: [], nextOffset: 0 }));
    if (!serviceLogsViewerState || serviceLogsViewerState !== state) return;

    if (result.reset || reset) {
      if (state.typeTimer) {
        clearTimeout(state.typeTimer);
        state.typeTimer = null;
      }

      state.isTyping = false;
      outputEl.textContent = '';
      state.textQueue = '';
    }

    const nextOffset = Number.parseInt(String(result.nextOffset ?? ''), 10);
    if (Number.isFinite(nextOffset) && nextOffset >= 0) {
      state.offset = nextOffset;
    }

    state.fileName = typeof result.fileName === 'string' ? result.fileName : '';

    const lines = Array.isArray(result.lines) ? result.lines : [];
    if (lines.length) {
      const chunkText = `${lines.join('\n')}\n`;
      const useTypewriter = !result.truncated && lines.length <= 120 && chunkText.length <= 5000 && state.linesLimit <= 300;
      enqueueServiceLogsText(chunkText, { forceImmediate: !useTypewriter });
    } else if ((result.reset || reset) && !outputEl.textContent.trim()) {
      outputEl.textContent = 'Логи пока пусты.\n';
    }

    if (result.truncated) {
      setServiceLogsStatus('Показана только последняя часть логов (ограничение объема).', 'var(--warning)');
    } else {
      const sourceText = state.fileName ? `Файл: ${state.fileName}` : 'Логи сервиса';
      setServiceLogsStatus(`${sourceText} • строк: ${linesLimit}`, 'var(--text-secondary)');
    }
  } catch (error) {
    if (serviceLogsViewerState === state) {
      setServiceLogsStatus(`Ошибка: ${error.message || 'не удалось загрузить логи'}`, 'var(--danger)');
    }
  } finally {
    if (serviceLogsViewerState === state) {
      state.isFetching = false;
    }
  }
}

function openServiceLogsModal(adminFetch) {
  stopServiceLogsViewer();

  const content = `
    <div style="display:flex; flex-direction:column; gap:var(--space-sm);">
      <div style="display:flex; align-items:center; gap:var(--space-sm); flex-wrap:wrap;">
        <label class="meta" for="serviceLogsLinesSelect" style="display:flex; align-items:center; gap:6px;">
          Строк:
          <select id="serviceLogsLinesSelect" class="input" style="min-width:92px; padding:6px 8px;">
            <option value="100" selected>100</option>
            <option value="200">200</option>
            <option value="500">500</option>
            <option value="1000">1000</option>
            <option value="2000">2000</option>
          </select>
        </label>

        <label class="meta" style="display:flex; align-items:center; gap:6px;">
          <input id="serviceLogsAutoscroll" type="checkbox" checked />
          Автопрокрутка
        </label>

        <button id="serviceLogsRefreshBtn" class="secondary" type="button" style="min-width:auto;">Обновить</button>
        <button id="serviceLogsClearBtn" class="secondary" type="button" style="min-width:auto;">Очистить</button>
      </div>

      <div id="serviceLogsStatus" class="meta" style="min-height:1.2em; color:var(--text-secondary);"></div>

      <pre id="serviceLogsOutput" style="margin:0; padding:12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--panel); color:var(--text-primary); font-family:'Fira Code', Consolas, 'Courier New', monospace; font-size:0.84rem; line-height:1.35; white-space:pre-wrap; word-break:break-word; height:min(72vh, 760px); overflow:auto;"></pre>
    </div>
  `;

  showModal(`${getSettingsIcon(18)} Логи сервиса`, content, { maxWidth: 'min(96vw, 1400px)' });

  setTimeout(() => {
    const linesSelectEl = document.getElementById('serviceLogsLinesSelect');
    const autoscrollEl = document.getElementById('serviceLogsAutoscroll');
    const refreshBtn = document.getElementById('serviceLogsRefreshBtn');
    const clearBtn = document.getElementById('serviceLogsClearBtn');
    const outputEl = document.getElementById('serviceLogsOutput');

    if (!outputEl || !linesSelectEl || !autoscrollEl || !refreshBtn || !clearBtn) return;

    serviceLogsViewerState = {
      pollTimer: null,
      typeTimer: null,
      isTyping: false,
      isFetching: false,
      textQueue: '',
      autoScroll: true,
      linesLimit: clampServiceLogsLines(linesSelectEl.value),
      offset: -1,
      fileName: ''
    };

    autoscrollEl.onchange = () => {
      if (!serviceLogsViewerState) return;
      serviceLogsViewerState.autoScroll = autoscrollEl.checked;
      if (serviceLogsViewerState.autoScroll) {
        outputEl.scrollTop = outputEl.scrollHeight;
      }
    };

    linesSelectEl.onchange = async () => {
      if (!serviceLogsViewerState) return;
      serviceLogsViewerState.linesLimit = clampServiceLogsLines(linesSelectEl.value);
      serviceLogsViewerState.offset = -1;
      await fetchServiceLogsChunk(adminFetch, { reset: true });
    };

    refreshBtn.onclick = async () => {
      if (!serviceLogsViewerState) return;
      serviceLogsViewerState.offset = -1;
      await fetchServiceLogsChunk(adminFetch, { reset: true });
    };

    clearBtn.onclick = () => {
      outputEl.textContent = '';
      if (serviceLogsViewerState) {
        if (serviceLogsViewerState.typeTimer) {
          clearTimeout(serviceLogsViewerState.typeTimer);
          serviceLogsViewerState.typeTimer = null;
        }
        serviceLogsViewerState.isTyping = false;
        serviceLogsViewerState.textQueue = '';
      }
      setServiceLogsStatus('Окно логов очищено.', 'var(--text-secondary)');
    };

    fetchServiceLogsChunk(adminFetch, { reset: true });

    serviceLogsViewerState.pollTimer = window.setInterval(() => {
      const overlay = document.getElementById('modalOverlay');
      const outputStillVisible = document.getElementById('serviceLogsOutput');
      if (!overlay || overlay.style.display !== 'flex' || !outputStillVisible) {
        stopServiceLogsViewer();
        return;
      }

      fetchServiceLogsChunk(adminFetch);
    }, SERVICE_LOGS_POLL_INTERVAL_MS);
  }, 0);
}

export function showModal(title, content, options = {}) {
  const overlay = document.getElementById('modalOverlay');
  const modalContent = document.getElementById('modalContent');
  
  if (!overlay || !modalContent) return;

  const isNestedModal = overlay.style.display === 'flex' && modalContent.childNodes.length > 0;
  if (!isNestedModal) {
    modalHistoryStack.length = 0;
  } else if (options.pushHistory !== false) {
    modalHistoryStack.push({
      nodes: Array.from(modalContent.childNodes),
      maxWidth: modalContent.style.maxWidth || '600px'
    });
  }

  const requestedMaxWidth = typeof options.maxWidth === 'string' && options.maxWidth.trim()
    ? options.maxWidth.trim()
    : '600px';
  modalContent.style.maxWidth = requestedMaxWidth;
  
  // Очищаем содержимое модального окна безопасным способом
  while (modalContent.firstChild) {
    modalContent.removeChild(modalContent.firstChild);
  }
  
  const header = document.createElement('div');
  header.className = 'header';
  header.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';

  const headerLeft = document.createElement('div');
  headerLeft.style.cssText = 'display:flex; align-items:center; gap:8px; min-width:0; flex:1;';

  if (modalHistoryStack.length > 0 && options.showBack !== false) {
    const backBtn = document.createElement('button');
    backBtn.className = 'secondary';
    backBtn.onclick = goBackModal;
    backBtn.style.cssText = 'min-width:auto; padding:8px 10px; display:flex; align-items:center; justify-content:center;';
    backBtn.textContent = '← Назад';
    headerLeft.appendChild(backBtn);
  }
  
  const titleEl = document.createElement('div');
  titleEl.className = 'title';
  titleEl.style.cssText = 'font-weight:600; font-size:1.1rem; color:var(--text-primary); display:flex; align-items:center; gap:8px;';
  
  // Проверяем, есть ли в заголовке SVG иконка
  const svgMatch = title.match(/<svg[^>]*>[\s\S]*?<\/svg>/i);
  const emojiMatch = title.match(/^[🔔⚙️📱👥🔑✅❌🗑️🔒🔓]/);
  
  if (svgMatch) {
    // Если есть SVG иконка, используем её
    titleEl.insertAdjacentHTML('beforeend', svgMatch[0]);
    // Убираем SVG из заголовка для получения чистого текста
    let cleanTitle = title.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '').trim();
    const titleText = document.createTextNode(cleanTitle);
    titleEl.appendChild(titleText);
  } else if (emojiMatch) {
    // Если есть эмодзи, оставляем его как есть (он будет отображаться как текст)
    const titleText = document.createTextNode(title);
    titleEl.appendChild(titleText);
  } else {
    // Если иконки нет, добавляем иконку настроек по умолчанию
    titleEl.insertAdjacentHTML('beforeend', getSettingsIcon(18));
    const titleText = document.createTextNode(title);
    titleEl.appendChild(titleText);
  }
  
  headerLeft.appendChild(titleEl);
  header.appendChild(headerLeft);

  const headerRight = document.createElement('div');
  headerRight.style.cssText = 'display:flex; align-items:center; gap:8px; flex-shrink:0;';

  if (typeof options.onViewServiceLogs === 'function') {
    const logsBtn = document.createElement('button');
    logsBtn.className = 'secondary';
    logsBtn.type = 'button';
    logsBtn.title = 'Просмотр логов сервиса';
    logsBtn.style.cssText = 'min-width:auto; padding:8px 10px; display:flex; align-items:center; justify-content:center;';
    logsBtn.textContent = 'Логи';
    logsBtn.onclick = async () => {
      if (logsBtn.disabled) return;
      try {
        await options.onViewServiceLogs(logsBtn);
      } catch (error) {
        console.error('[Modal] View service logs action failed:', error);
      }
    };
    headerRight.appendChild(logsBtn);
  }

  if (typeof options.onRestartService === 'function') {
    const restartBtn = document.createElement('button');
    restartBtn.className = 'secondary';
    restartBtn.type = 'button';
    restartBtn.title = 'Перезапустить сервис';
    restartBtn.style.cssText = 'min-width:auto; padding:8px 10px; display:flex; align-items:center; justify-content:center; font-weight:700;';
    restartBtn.textContent = '↻';
    restartBtn.onclick = async () => {
      if (restartBtn.disabled) return;
      try {
        await options.onRestartService(restartBtn);
      } catch (error) {
        console.error('[Modal] Restart service action failed:', error);
      }
    };
    headerRight.appendChild(restartBtn);
  }
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'secondary';
  closeBtn.onclick = closeModal;
  closeBtn.style.cssText = 'min-width:auto; padding:8px; display:flex; align-items:center; justify-content:center;';
  // getCloseIcon возвращает безопасную SVG иконку из константы
  closeBtn.insertAdjacentHTML('beforeend', getCloseIcon(18));

  headerRight.appendChild(closeBtn);
  header.appendChild(headerRight);
  modalContent.appendChild(header);
  
  const contentDiv = document.createElement('div');
  contentDiv.style.cssText = 'margin-top:var(--space-md);';
  
  // Используем временный контейнер для безопасного парсинга HTML
  // Примечание: вызывающий код должен экранировать пользовательские данные через escapeHtml
  if (content && typeof content === 'string') {
    // Создаем временный контейнер вне DOM для парсинга
    const tempContainer = document.createElement('div');
    // Используем insertAdjacentHTML вместо innerHTML для лучшей безопасности
    // Это все еще требует, чтобы вызывающий код экранировал пользовательские данные
    tempContainer.insertAdjacentHTML('beforeend', content);
    // Перемещаем узлы из временного контейнера
    while (tempContainer.firstChild) {
      contentDiv.appendChild(tempContainer.firstChild);
    }
  } else {
    // Если content не строка, используем textContent
    contentDiv.textContent = content || '';
  }
  
  modalContent.appendChild(contentDiv);
  
  overlay.style.display = 'flex';

  bindModalOverlayHandlers(overlay);
  bindModalEscHandler();
}

export function closeModal() {
  stopServiceLogsViewer();

  const overlay = document.getElementById('modalOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }

  modalHistoryStack.length = 0;
  if (activeModalEscHandler) {
    document.removeEventListener('keydown', activeModalEscHandler);
    activeModalEscHandler = null;
  }
}

// Глобальные функции для onclick
window.closeModal = closeModal;
window.goBackModal = goBackModal;
window.showUsersModal = showUsersModal;

export function showDevicesModal(adminFetch, loadDevices, renderTVList, openDevice, renderFilesPane) {
  const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

  const content = `
    <div style="display:flex; flex-direction:column; gap:var(--space-md);">
      <div>
        <label style="display:block; margin-bottom:4px; font-weight:500;">ID устройства</label>
        <input id="modalDeviceId" class="input" placeholder="TV001" required />
        <div class="meta" style="margin-top:6px; color:var(--text-secondary); font-size:0.8rem;">Только буквы, цифры, _ и - (без пробелов)</div>
      </div>
      
      <div>
        <label style="display:block; margin-bottom:4px; font-weight:500;">Имя устройства</label>
        <input id="modalDeviceName" class="input" placeholder="001 Комната на первом этаже" />
      </div>
      
      <div id="modalError" style="color:var(--danger); font-size:0.875rem; display:none;"></div>
      
      <button id="modalCreateDevice" class="primary" style="width:100%;">Создать устройство</button>
    </div>
  `;
  
  showModal(`${getAndroidIcon(18)} Новое устройство`, content);
  
  // Обработчики
  setTimeout(() => {
    const deviceIdInput = document.getElementById('modalDeviceId');
    const deviceNameInput = document.getElementById('modalDeviceName');
    const createBtn = document.getElementById('modalCreateDevice');
    const errorEl = document.getElementById('modalError');
    
    if (!deviceIdInput || !createBtn) return;
    
    const doCreate = async () => {
      const device_id = deviceIdInput.value.trim();
      const name = deviceNameInput.value.trim();
      
      if (!device_id) {
        errorEl.textContent = 'Введите ID устройства';
        errorEl.style.display = 'block';
        return;
      }

      if (!DEVICE_ID_PATTERN.test(device_id)) {
        errorEl.textContent = 'ID устройства может содержать только буквы, цифры, _ и - (без пробелов)';
        errorEl.style.display = 'block';
        return;
      }
      
      createBtn.disabled = true;
      createBtn.textContent = 'Создание...';
      errorEl.style.display = 'none';
      
      try {
        const res = await adminFetch('/api/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id, name })
        });
        
        if (res.ok) {
          closeModal();
          await loadDevices();
          renderTVList();
          openDevice(device_id);
          renderFilesPane(device_id);
        } else {
          const error = await res.json();
          errorEl.textContent = error.error || 'Ошибка создания';
          errorEl.style.display = 'block';
          createBtn.disabled = false;
          createBtn.textContent = 'Создать устройство';
        }
      } catch (err) {
        errorEl.textContent = 'Ошибка подключения';
        errorEl.style.display = 'block';
        createBtn.disabled = false;
        createBtn.textContent = 'Создать устройство';
      }
    };
    
    createBtn.onclick = doCreate;
    deviceIdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
    deviceNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
    deviceIdInput.focus();
  }, 100);
}

export async function showUsersModal(adminFetch) {
  // Сохраняем adminFetch в window для использования в inline onclick
  window.adminFetch = adminFetch;
  
  // Состояние для поиска и пагинации
  window.usersModalState = {
    allUsers: [],
    filteredUsers: [],
    currentPage: 1,
    itemsPerPage: 5,
    searchQuery: '',
    authTab: 'local',
    selectedUserId: null,
    allDevicesById: {}
  };
  
  const content = `
    <style>
      #usersModalLayout {
        display: grid;
        grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
        gap: var(--space-md);
      }

      #usersModalLayout .users-modal-panel {
        padding: var(--space-md);
        background: var(--panel-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }

      #usersModalLayout .modal-user-row {
        cursor: pointer;
        border: 1px solid transparent;
        transition: background-color 0.15s ease, border-color 0.15s ease;
      }

      #usersModalLayout .modal-user-row:hover {
        background: var(--panel-2);
      }

      #usersModalLayout .modal-user-row.selected {
        border-color: var(--brand);
        background: var(--panel-2);
      }

      #usersModalLayout .users-tab-btn.active {
        background: var(--brand);
        border-color: var(--brand);
        color: var(--panel);
      }

      @media (max-width: 960px) {
        #usersModalLayout {
          grid-template-columns: 1fr;
        }
      }
    </style>

    <div id="usersModalLayout">
      <div style="display:flex; flex-direction:column; gap:var(--space-md);">
        <div class="users-modal-panel">
          <div style="margin-bottom:var(--space-md); font-weight:600;">Создать пользователя</div>
          <div style="display:flex; flex-direction:column; gap:var(--space-sm);">
            <input id="modalUsername" class="input" placeholder="Логин" />
            <input id="modalFullName" class="input" placeholder="ФИО" />
            <input id="modalPassword" class="input" type="password" placeholder="Пароль (мин. 8 символов)" />
            <select id="modalRole" class="input">
              <option value="speaker">Speaker (управление контентом)</option>
              <option value="admin">Admin (полный доступ)</option>
              <option value="hero_admin">Hero Admin (управление карточками героев)</option>
            </select>
            <div id="modalUserError" style="color:var(--danger); font-size:0.875rem; display:none;"></div>
            <button id="modalCreateUser" class="primary">Создать пользователя</button>
          </div>
        </div>

        <div class="users-modal-panel">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:var(--space-sm); margin-bottom:var(--space-sm);">
            <div style="font-weight:600;">Устройства пользователя</div>
            <div class="meta" id="modalSelectedUserDevicesCount" style="color:var(--text-secondary);"></div>
          </div>
          <div id="modalSelectedUserDevicesPanel" style="display:flex; flex-direction:column; gap:var(--space-xs); min-height:140px; max-height:280px; overflow-y:auto;">
            <div class="meta" style="color:var(--text-secondary);">Выберите пользователя в списке справа, чтобы увидеть доступные ему устройства.</div>
          </div>
        </div>
      </div>

      <div class="users-modal-panel" style="display:flex; flex-direction:column; min-height:520px;">
        <div style="margin-bottom:var(--space-md); font-weight:600;">Список пользователей</div>

        <div style="display:flex; gap:var(--space-xs); margin-bottom:var(--space-sm);">
          <button id="modalUsersTabLocal" class="secondary users-tab-btn active" data-users-auth-tab="local" style="flex:1;">LOCAL</button>
          <button id="modalUsersTabLdap" class="secondary users-tab-btn" data-users-auth-tab="ldap" style="flex:1;">LDAP</button>
        </div>

        <div style="margin-bottom:var(--space-sm);">
          <input 
            id="modalUsersSearch" 
            class="input" 
            type="text" 
            placeholder="Поиск по логину или ФИО..." 
            style="width:100%;"
          />
        </div>

        <div id="modalUsersList" style="display:flex; flex-direction:column; gap:var(--space-sm); min-height:280px;">
          <div class="meta" style="text-align:center; padding:var(--space-lg);">Загрузка...</div>
        </div>

        <div id="modalUsersPagination" style="display:flex; justify-content:space-between; align-items:center; margin-top:auto; padding-top:var(--space-md); border-top:1px solid var(--border);">
          <div class="meta" id="modalUsersPaginationInfo" style="color:var(--text-secondary);"></div>
          <div style="display:flex; gap:var(--space-xs); align-items:center;">
            <button 
              id="modalUsersPrevPage" 
              class="secondary" 
              style="min-width:auto; padding:6px 12px;"
              disabled
            >
              ← Назад
            </button>
            <span class="meta" id="modalUsersPageInfo" style="padding:0 var(--space-sm);"></span>
            <button 
              id="modalUsersNextPage" 
              class="secondary" 
              style="min-width:auto; padding:6px 12px;"
              disabled
            >
              Вперед →
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  showModal(`${getUsersIcon(18)} Управление пользователями`, content, { maxWidth: '1200px' });
  
  // Загружаем список пользователей
  setTimeout(() => {
    loadModalUsersList(adminFetch);
    setupUsersModalHandlers(adminFetch);
  }, 100);
  
  // Обработчик создания
  setTimeout(() => {
    const usernameInput = document.getElementById('modalUsername');
    const fullNameInput = document.getElementById('modalFullName');
    const passwordInput = document.getElementById('modalPassword');
    const roleSelect = document.getElementById('modalRole');
    const createBtn = document.getElementById('modalCreateUser');
    const errorEl = document.getElementById('modalUserError');
    
    if (!createBtn) return;
    
    const doCreate = async () => {
      const username = usernameInput.value.trim();
      const full_name = fullNameInput.value.trim();
      const password = passwordInput.value;
      const role = roleSelect.value;
      
      if (!username || !full_name || !password) {
        errorEl.textContent = 'Заполните все поля';
        errorEl.style.display = 'block';
        return;
      }

      if (password.length < 8) {
        errorEl.textContent = 'Пароль минимум 8 символов';
        errorEl.style.display = 'block';
        return;
      }
      
      createBtn.disabled = true;
      createBtn.textContent = 'Создание...';
      errorEl.style.display = 'none';
      
      try {
        const res = await adminFetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, full_name, password, role })
        });
        
        if (res.ok) {
          usernameInput.value = '';
          fullNameInput.value = '';
          passwordInput.value = '';
          roleSelect.value = 'speaker';
          await loadModalUsersList(adminFetch);
        } else {
          const error = await res.json();
          errorEl.textContent = error.error || 'Ошибка создания';
          errorEl.style.display = 'block';
        }
      } catch (err) {
        errorEl.textContent = 'Ошибка подключения';
        errorEl.style.display = 'block';
      } finally {
        createBtn.disabled = false;
        createBtn.textContent = 'Создать пользователя';
      }
    };
    
    createBtn.onclick = doCreate;
    usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
    fullNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
    passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
    usernameInput.focus();
  }, 100);
}

async function loadModalUsersList(adminFetch) {
  const container = document.getElementById('modalUsersList');
  if (!container) return;
  
  // Инициализируем состояние, если его еще нет
  if (!window.usersModalState) {
    window.usersModalState = {
      allUsers: [],
      filteredUsers: [],
      currentPage: 1,
      itemsPerPage: 5,
      searchQuery: '',
      authTab: 'local',
      selectedUserId: null,
      allDevicesById: {}
    };
  }
  
  try {
    const [usersRes, devicesRes] = await Promise.all([
      adminFetch('/api/auth/users'),
      adminFetch('/api/devices')
    ]);
    const users = await usersRes.json();
    const devices = await devicesRes.json();

    window.usersModalState.allDevicesById = Array.isArray(devices)
      ? devices.reduce((acc, d) => {
        if (d && d.device_id) {
          acc[d.device_id] = d;
        }
        return acc;
      }, {})
      : {};
    
    // Загружаем количество устройств для каждого пользователя
    const usersWithDeviceCount = await Promise.all(users.map(async (u) => {
      try {
        const devicesRes = await adminFetch(`/api/auth/users/${u.id}/devices`);
        const deviceIds = await devicesRes.json();
        const normalizedDeviceIds = Array.isArray(deviceIds) ? deviceIds : [];
        return {
          ...u,
          deviceIds: normalizedDeviceIds,
          deviceCount: normalizedDeviceIds.length
        };
      } catch (err) {
        return { ...u, deviceIds: [], deviceCount: 0 };
      }
    }));
    
    // Сохраняем всех пользователей в состояние
    window.usersModalState.allUsers = usersWithDeviceCount;

    if (window.usersModalState.selectedUserId !== null) {
      const stillExists = usersWithDeviceCount.some((u) => Number(u.id) === Number(window.usersModalState.selectedUserId));
      if (!stillExists) {
        window.usersModalState.selectedUserId = null;
      }
    }
    
    // Применяем фильтрацию и пагинацию
    filterAndRenderUsers(adminFetch);
    
  } catch (err) {
    container.innerHTML = '<div class="meta" style="color:var(--danger); text-align:center;">Ошибка загрузки</div>';
  }
}

function setupUsersModalHandlers(adminFetch) {
  const searchInput = document.getElementById('modalUsersSearch');
  const prevBtn = document.getElementById('modalUsersPrevPage');
  const nextBtn = document.getElementById('modalUsersNextPage');
  const tabButtons = Array.from(document.querySelectorAll('[data-users-auth-tab]'));
  
  if (!searchInput || !prevBtn || !nextBtn) return;

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextTab = btn.getAttribute('data-users-auth-tab') === 'ldap' ? 'ldap' : 'local';
      if (window.usersModalState.authTab === nextTab) return;
      window.usersModalState.authTab = nextTab;
      window.usersModalState.currentPage = 1;
      filterAndRenderUsers(adminFetch);
    });
  });
  
  // Обработчик поиска с debounce
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      window.usersModalState.searchQuery = e.target.value.trim().toLowerCase();
      window.usersModalState.currentPage = 1; // Сбрасываем на первую страницу при поиске
      filterAndRenderUsers(adminFetch);
    }, 300);
  });
  
  // Обработчики пагинации
  prevBtn.onclick = () => {
    if (window.usersModalState.currentPage > 1) {
      window.usersModalState.currentPage--;
      filterAndRenderUsers(adminFetch);
    }
  };
  
  nextBtn.onclick = () => {
    const totalPages = Math.ceil(window.usersModalState.filteredUsers.length / window.usersModalState.itemsPerPage);
    if (window.usersModalState.currentPage < totalPages) {
      window.usersModalState.currentPage++;
      filterAndRenderUsers(adminFetch);
    }
  };
}

function filterAndRenderUsers(adminFetch) {
  const state = window.usersModalState;
  const container = document.getElementById('modalUsersList');
  const paginationInfo = document.getElementById('modalUsersPaginationInfo');
  const pageInfo = document.getElementById('modalUsersPageInfo');
  const prevBtn = document.getElementById('modalUsersPrevPage');
  const nextBtn = document.getElementById('modalUsersNextPage');
  const localTabBtn = document.getElementById('modalUsersTabLocal');
  const ldapTabBtn = document.getElementById('modalUsersTabLdap');
  
  if (!container) return;

  const localCount = state.allUsers.filter((u) => String(u.auth_source || 'local').toLowerCase() !== 'ldap').length;
  const ldapCount = state.allUsers.filter((u) => String(u.auth_source || 'local').toLowerCase() === 'ldap').length;

  if (localTabBtn) {
    localTabBtn.textContent = `LOCAL (${localCount})`;
    localTabBtn.classList.toggle('active', state.authTab !== 'ldap');
  }
  if (ldapTabBtn) {
    ldapTabBtn.textContent = `LDAP (${ldapCount})`;
    ldapTabBtn.classList.toggle('active', state.authTab === 'ldap');
  }
  
  // Фильтрация пользователей
  state.filteredUsers = state.allUsers.filter((u) => {
    const authSource = String(u.auth_source || 'local').toLowerCase();
    const matchesTab = state.authTab === 'ldap' ? authSource === 'ldap' : authSource !== 'ldap';
    if (!matchesTab) return false;

    if (!state.searchQuery) return true;
    return (
      u.username.toLowerCase().includes(state.searchQuery) ||
      (u.full_name && u.full_name.toLowerCase().includes(state.searchQuery))
    );
  });

  const hasSelectedInCurrentFilter = state.filteredUsers.some((u) => Number(u.id) === Number(state.selectedUserId));
  if (!hasSelectedInCurrentFilter) {
    state.selectedUserId = null;
  }
  
  // Вычисляем пагинацию
  const totalPages = Math.ceil(state.filteredUsers.length / state.itemsPerPage);
  if (totalPages === 0) {
    state.currentPage = 1;
  } else if (state.currentPage > totalPages) {
    state.currentPage = totalPages;
  }
  const startIndex = (state.currentPage - 1) * state.itemsPerPage;
  const endIndex = startIndex + state.itemsPerPage;
  const pageUsers = state.filteredUsers.slice(startIndex, endIndex);
  
  // Обновляем информацию о пагинации
  if (paginationInfo) {
    const total = state.filteredUsers.length;
    const showing = total > 0 ? `${startIndex + 1}-${Math.min(endIndex, total)}` : '0';
    paginationInfo.textContent = total > 0 
      ? `Показано ${showing} из ${total}` 
      : state.searchQuery ? 'Ничего не найдено' : 'Нет пользователей';
  }
  
  if (pageInfo) {
    pageInfo.textContent = totalPages > 0 ? `Страница ${state.currentPage} из ${totalPages}` : '';
  }
  
  // Обновляем кнопки пагинации
  if (prevBtn) {
    prevBtn.disabled = state.currentPage <= 1;
  }
  if (nextBtn) {
    nextBtn.disabled = state.currentPage >= totalPages || totalPages === 0;
  }
  
  // Рендерим пользователей текущей страницы
  if (pageUsers.length === 0) {
    container.innerHTML = state.searchQuery 
      ? '<div class="meta" style="text-align:center; padding:var(--space-lg);">Ничего не найдено</div>'
      : '<div class="meta" style="text-align:center; padding:var(--space-lg);">Нет пользователей</div>';
    renderSelectedUserDevicesPanel();
    return;
  }
  
  container.innerHTML = pageUsers.map(u => {
    const safeUsername = escapeHtml(u.username || '');
    const safeFullName = escapeHtml(u.full_name || '');
    const authSource = String(u.auth_source || 'local').toLowerCase();
    const deviceCountLabel = Number.isFinite(Number(u.deviceCount)) ? Number(u.deviceCount) : 0;
    const safeUserId = Number.isFinite(Number(u.id)) ? Number(u.id) : 0;
    const usernameArg = escapeJsStringForAttr(u.username || '');
    const roleArg = escapeJsStringForAttr(u.role || '');
    const isLdapUser = authSource === 'ldap';
    const isSelected = Number(state.selectedUserId) === safeUserId;
    return `
      <div class="item modal-user-row ${isSelected ? 'selected' : ''}" style="display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm);" onclick="selectUserInUsersModal(${safeUserId})">
        <div style="flex:1; min-width:0;">
          <div style="display:flex; align-items:center; gap:var(--space-xs); flex-wrap:wrap;">
            <strong>${safeUsername}</strong>
            ${isLdapUser ? '<span style="background:var(--warning); color:var(--panel); padding:2px 6px; border-radius:4px; font-size:0.7rem;">LDAP</span>' : '<span style="background:var(--panel-2); color:var(--text-secondary); padding:2px 6px; border-radius:4px; font-size:0.7rem;">LOCAL</span>'}
            ${u.role === 'admin' ? '<span style="background:var(--brand); color:var(--panel); padding:2px 6px; border-radius:4px; font-size:0.7rem;">ADMIN</span>' : ''}
            ${u.role === 'speaker' ? '<span style="background:var(--success); color:var(--panel); padding:2px 6px; border-radius:4px; font-size:0.7rem;">SPEAKER</span>' : ''}
            ${u.role === 'hero_admin' ? '<span style="background:var(--warning); color:var(--panel); padding:2px 6px; border-radius:4px; font-size:0.7rem;">HERO ADMIN</span>' : ''}
            ${!u.is_active ? '<span style="background:var(--danger); color:var(--panel); padding:2px 6px; border-radius:4px; font-size:0.7rem;">OFF</span>' : ''}
          </div>
          <div class="meta">${safeFullName}</div>
          ${u.role === 'speaker' ? `<div class="meta" style="font-size:0.75rem; color:var(--text-secondary);">Устройств: ${deviceCountLabel}</div>` : ''}
        </div>
        <div style="display:flex; gap:4px; flex-shrink:0;">
          ${u.role === 'speaker' ? `<button class="secondary" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center;" onclick="event.stopPropagation(); showUserDevicesModalInModal(${safeUserId}, ${usernameArg}, ${roleArg})" title="Управление устройствами">${getSettingsIcon(16)}</button>` : ''}
          ${u.role === 'admin' || u.role === 'hero_admin' ? `<button class="secondary" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center;" onclick="event.stopPropagation(); showUserDevicesModalInModal(${safeUserId}, ${usernameArg}, ${roleArg})" title="Информация об устройствах">${getSettingsIcon(16)}</button>` : ''}
          ${isLdapUser
            ? `<button class="secondary" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center; opacity:0.6;" disabled title="Пароль LDAP меняется в AD">${getKeyIcon(16)}</button>`
            : `<button class="secondary" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center;" onclick="event.stopPropagation(); resetUserPasswordInModal(${safeUserId}, ${usernameArg})" title="Сбросить пароль">${getKeyIcon(16)}</button>`}
          ${u.is_active 
            ? `<button class="secondary" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center;" onclick="event.stopPropagation(); toggleUserInModal(${safeUserId}, false)" title="Отключить">${getLockIcon(16)}</button>`
            : `<button class="secondary" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center;" onclick="event.stopPropagation(); toggleUserInModal(${safeUserId}, true)" title="Включить">${getUnlockIcon(16)}</button>`
          }
          ${u.id !== 1 ? `<button class="danger meta-lg" style="min-width:auto; padding:6px 10px; display:flex; align-items:center; justify-content:center;" onclick="event.stopPropagation(); deleteUserInModal(${safeUserId}, ${usernameArg})" title="Удалить">${getTrashIcon(16)}</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  renderSelectedUserDevicesPanel();

  if (!window.selectUserInUsersModal) {
    window.selectUserInUsersModal = (userId) => {
      if (!window.usersModalState) return;
      window.usersModalState.selectedUserId = Number(userId);
      filterAndRenderUsers(window.adminFetch);
    };
  }
    
  // Регистрируем глобальные функции для onclick (если еще не зарегистрированы)
  if (!window.toggleUserInModal) {
    window.toggleUserInModal = async (userId, activate) => {
      try {
        const res = await window.adminFetch(`/api/auth/users/${userId}/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: activate })
        });
        
        if (res.ok) {
          // Сразу обновляем список пользователей
          await loadModalUsersList(window.adminFetch);
        } else {
          const error = await res.json().catch(() => ({ error: 'Ошибка' }));
          await reportModalNotification({
            type: 'user_toggle_error',
            title: 'Ошибка изменения статуса пользователя',
            message: error.error || 'Ошибка при изменении статуса пользователя',
            details: { userId, activate }
          });
        }
      } catch (err) {
        await reportModalNotification({
          type: 'user_toggle_error',
          title: 'Ошибка изменения статуса пользователя',
          message: err.message || 'Неизвестная ошибка',
          details: { userId, activate }
        });
      }
    };
  }
  
  if (!window.deleteUserInModal) {
    window.deleteUserInModal = async (userId, username) => {
      if (!confirm(`Удалить "${username}"?`)) return;
      
      try {
        const res = await window.adminFetch(`/api/auth/users/${userId}`, {
          method: 'DELETE'
        });
        
        if (res.ok) {
          // Сразу обновляем список пользователей
          await loadModalUsersList(window.adminFetch);
        } else {
          const error = await res.json().catch(() => ({ error: 'Ошибка' }));
          await reportModalNotification({
            type: 'user_delete_error',
            title: 'Ошибка удаления пользователя',
            message: error.error || 'Ошибка при удалении пользователя',
            details: { userId, username }
          });
        }
      } catch (err) {
        await reportModalNotification({
          type: 'user_delete_error',
          title: 'Ошибка удаления пользователя',
          message: err.message || 'Неизвестная ошибка',
          details: { userId, username }
        });
      }
    };
  }
  
  if (!window.resetUserPasswordInModal) {
    window.resetUserPasswordInModal = async (userId, username) => {
      const safeUsername = escapeHtml(username || '');
      const passwordResetContent = `
        <div style="display:flex; flex-direction:column; gap:var(--space-md);">
          <div style="color:var(--text-secondary);">
            Сброс пароля для пользователя: <strong>${safeUsername}</strong>
          </div>
          <input id="newPassword1" class="input" type="password" placeholder="Новый пароль (мин. 8 символов)" />
          <input id="newPassword2" class="input" type="password" placeholder="Повторите новый пароль" />
          <div id="passwordResetError" style="color:var(--danger); font-size:0.875rem; display:none;"></div>
          <div style="display:flex; gap:var(--space-sm);">
            <button id="resetPasswordBtn" class="primary" style="flex:1;">Сбросить пароль</button>
            <button onclick="closeModal()" class="secondary" style="flex:1;">Отмена</button>
          </div>
        </div>
      `;
      
      showModal(`${getKeyIcon(18)} Сброс пароля`, passwordResetContent);
      
      setTimeout(() => {
        const password1Input = document.getElementById('newPassword1');
        const password2Input = document.getElementById('newPassword2');
        const resetBtn = document.getElementById('resetPasswordBtn');
        const errorEl = document.getElementById('passwordResetError');
        
        if (!resetBtn) return;
        
        const doReset = async () => {
          const newPassword = password1Input.value;
          const confirmPassword = password2Input.value;
          
          if (!newPassword || newPassword.length < 8) {
            errorEl.textContent = 'Пароль должен быть не менее 8 символов';
            errorEl.style.display = 'block';
            return;
          }
          
          if (newPassword !== confirmPassword) {
            errorEl.textContent = 'Пароли не совпадают';
            errorEl.style.display = 'block';
            return;
          }
          
          resetBtn.disabled = true;
          resetBtn.textContent = 'Сброс...';
          errorEl.style.display = 'none';
          
          try {
            const res = await adminFetch(`/api/auth/users/${userId}/reset-password`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ new_password: newPassword })
            });
            
            if (res.ok) {
              closeModal();
              showModal(`${getSuccessIcon(18)} Успешно`, `
                <div style="text-align:center; padding:var(--space-lg);">
                  Пароль для <strong>${safeUsername}</strong> успешно изменен
                </div>
                <button onclick="closeModal(); setTimeout(() => window.showUsersModal && window.showUsersModal(window.adminFetch), 100)" class="primary" style="width:100%;">OK</button>
              `);
            } else {
              const error = await res.json();
              errorEl.textContent = error.error || 'Ошибка сброса пароля';
              errorEl.style.display = 'block';
            }
          } catch (err) {
            errorEl.textContent = 'Ошибка подключения';
            errorEl.style.display = 'block';
          } finally {
            resetBtn.disabled = false;
            resetBtn.textContent = 'Сбросить пароль';
          }
        };
        
        resetBtn.onclick = doReset;
        password1Input.addEventListener('keydown', (e) => { if (e.key === 'Enter') password2Input.focus(); });
        password2Input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doReset(); });
        password1Input.focus();
      }, 100);
    };
  }
}

function renderSelectedUserDevicesPanel() {
  const panel = document.getElementById('modalSelectedUserDevicesPanel');
  const countEl = document.getElementById('modalSelectedUserDevicesCount');
  const state = window.usersModalState;
  if (!panel || !state) return;

  const selectedUser = state.allUsers.find((u) => Number(u.id) === Number(state.selectedUserId));

  if (!selectedUser) {
    if (countEl) countEl.textContent = '';
    panel.innerHTML = '<div class="meta" style="color:var(--text-secondary);">Выберите пользователя в списке справа, чтобы увидеть доступные ему устройства.</div>';
    return;
  }

  const safeUsername = escapeHtml(selectedUser.username || '');
  const safeRole = escapeHtml(selectedUser.role || '');
  const usernameArg = escapeJsStringForAttr(selectedUser.username || '');
  const roleArg = escapeJsStringForAttr(selectedUser.role || '');
  const safeUserId = Number.isFinite(Number(selectedUser.id)) ? Number(selectedUser.id) : 0;

  if (selectedUser.role === 'admin') {
    if (countEl) countEl.textContent = 'Все устройства';
    panel.innerHTML = `
      <div style="font-weight:600; margin-bottom:4px;">${safeUsername}</div>
      <div class="meta" style="color:var(--text-secondary);">Роль <strong>ADMIN</strong> имеет доступ ко всем устройствам автоматически.</div>
    `;
    return;
  }

  if (selectedUser.role === 'hero_admin') {
    if (countEl) countEl.textContent = 'Без устройств';
    panel.innerHTML = `
      <div style="font-weight:600; margin-bottom:4px;">${safeUsername}</div>
      <div class="meta" style="color:var(--text-secondary);">Роль <strong>HERO ADMIN</strong> работает в своей панели и не использует назначения устройств.</div>
    `;
    return;
  }

  const deviceIds = Array.isArray(selectedUser.deviceIds) ? selectedUser.deviceIds : [];
  if (countEl) countEl.textContent = `${deviceIds.length} шт.`;

  if (deviceIds.length === 0) {
    panel.innerHTML = `
      <div style="font-weight:600; margin-bottom:4px;">${safeUsername}</div>
      <div class="meta" style="color:var(--text-secondary); margin-bottom:var(--space-sm);">Роль: ${safeRole}</div>
      <div class="meta" style="color:var(--text-secondary);">Назначенных устройств нет.</div>
      <button class="secondary" style="margin-top:var(--space-sm);" onclick="showUserDevicesModalInModal(${safeUserId}, ${usernameArg}, ${roleArg})">Назначить устройства</button>
    `;
    return;
  }

  const devicesHtml = deviceIds.map((deviceId) => {
    const item = state.allDevicesById?.[deviceId];
    const safeDeviceName = escapeHtml(item?.device_name || deviceId || 'Без названия');
    const safeDeviceId = escapeHtml(deviceId || '');
    return `
      <div style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--panel);">
        <div style="font-weight:600; font-size:0.9rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${safeDeviceName}</div>
        <div class="meta" style="font-size:0.75rem; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${safeDeviceId}</div>
      </div>
    `;
  }).join('');

  panel.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:var(--space-sm); margin-bottom:var(--space-xs);">
      <div style="font-weight:600; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${safeUsername}</div>
      <button class="secondary meta" style="min-width:auto; padding:6px 10px;" onclick="showUserDevicesModalInModal(${safeUserId}, ${usernameArg}, ${roleArg})">Изменить</button>
    </div>
    <div class="meta" style="color:var(--text-secondary); margin-bottom:var(--space-xs);">Роль: ${safeRole}</div>
    <div style="display:grid; gap:var(--space-xs);">${devicesHtml}</div>
  `;
}

// Глобальная функция для открытия модального окна назначения устройств
window.showUserDevicesModalInModal = async function(userId, username, userRole) {
  if (!window.adminFetch) return;
  const safeUsername = escapeHtml(username || '');
  
  // Если admin, показываем сообщение что ему доступны все устройства
  if (userRole === 'admin') {
    showModal(`${getSettingsIcon(18)} Управление устройствами`, `
      <div style="text-align:center; padding:var(--space-lg);">
        <div class="meta" style="margin-bottom:var(--space-md);">
          Пользователь <strong>${safeUsername}</strong> имеет роль <strong>ADMIN</strong>
        </div>
        <div class="meta" style="color:var(--text-secondary);">
          Администраторам доступны все устройства автоматически
        </div>
        <button onclick="closeModal()" class="primary" style="width:100%; margin-top:var(--space-md);">OK</button>
      </div>
    `);
    return;
  }
  
  // Если hero_admin, показываем сообщение что у него своя панель
  if (userRole === 'hero_admin') {
    showModal(`${getSettingsIcon(18)} Управление устройствами`, `
      <div style="text-align:center; padding:var(--space-lg);">
        <div class="meta" style="margin-bottom:var(--space-md);">
          Пользователь <strong>${safeUsername}</strong> имеет роль <strong>HERO ADMIN</strong>
        </div>
        <div class="meta" style="color:var(--text-secondary);">
          Hero Admin имеет свою панель управления и не имеет доступа к устройствам
        </div>
        <button onclick="closeModal()" class="primary" style="width:100%; margin-top:var(--space-md);">OK</button>
      </div>
    `);
    return;
  }
  
  // Состояние для модального окна устройств
  window.userDevicesModalState = {
    allDevices: [],
    filteredDevices: [],
    userDeviceIds: [],
    currentPage: 1,
    itemsPerPage: 9,  // 3 колонки × 3 ряда = 9 устройств на страницу
    searchQuery: ''
  };
  
  const content = `
    <div style="display:flex; flex-direction:column; gap:var(--space-lg);">
      <div style="padding:var(--space-md); background:var(--panel-2); border-radius:var(--radius-sm);">
        <div style="margin-bottom:var(--space-sm);">
          <div class="meta" style="color:var(--text-secondary);">Пользователь:</div>
          <div style="font-weight:600; margin-top:4px;">${safeUsername}</div>
        </div>
      </div>
      
      <div>
        <div style="margin-bottom:var(--space-md); font-weight:600;">Доступные устройства</div>
        
        <!-- Поле поиска -->
        <div style="margin-bottom:var(--space-sm);">
          <input 
            id="modalDevicesSearch" 
            class="input" 
            type="text" 
            placeholder="Поиск устройств..." 
            style="width:100%;"
          />
        </div>
        
        <!-- Кнопки выбора -->
        <div style="display:flex; gap:var(--space-xs); margin-bottom:var(--space-sm);">
          <button id="modalDevicesSelectAll" class="secondary meta" style="flex:1;">Выбрать все</button>
          <button id="modalDevicesDeselectAll" class="secondary meta" style="flex:1;">Снять все</button>
        </div>
        
        <!-- Список устройств -->
        <div id="modalDevicesList" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:var(--space-sm); min-height:200px; max-height:400px; overflow-y:auto; padding:var(--space-xs);">
          <div class="meta" style="text-align:center; padding:var(--space-lg); grid-column:1/-1;">Загрузка...</div>
        </div>
        
        <!-- Информация о выборе -->
        <div id="modalDevicesSelectedInfo" class="meta" style="margin-top:var(--space-sm); color:var(--text-secondary);"></div>
        
        <!-- Пагинация -->
        <div id="modalDevicesPagination" style="display:flex; justify-content:space-between; align-items:center; margin-top:var(--space-md); padding-top:var(--space-md); border-top:1px solid var(--border);">
          <div class="meta" id="modalDevicesPaginationInfo" style="color:var(--text-secondary);"></div>
          <div style="display:flex; gap:var(--space-xs); align-items:center;">
            <button 
              id="modalDevicesPrevPage" 
              class="secondary" 
              style="min-width:auto; padding:6px 12px;"
              disabled
            >
              ← Назад
            </button>
            <span class="meta" id="modalDevicesPageInfo" style="padding:0 var(--space-sm);"></span>
            <button 
              id="modalDevicesNextPage" 
              class="secondary" 
              style="min-width:auto; padding:6px 12px;"
              disabled
            >
              Вперед →
            </button>
          </div>
        </div>
        
        <!-- Кнопки действий -->
        <div style="display:flex; gap:var(--space-sm); margin-top:var(--space-md);">
          <button id="modalDevicesSaveBtn" class="primary" style="flex:1;">Сохранить</button>
          <button onclick="closeModal()" class="secondary" style="flex:1;">Отмена</button>
        </div>
      </div>
    </div>
  `;
  
  showModal(`${getSettingsIcon(18)} Назначение устройств`, content);
  
  // Загружаем данные
  setTimeout(() => {
    loadUserDevicesModalData(window.adminFetch, userId);
    setupUserDevicesModalHandlers(window.adminFetch, userId, username);
  }, 100);
};

async function loadUserDevicesModalData(adminFetch, userId) {
  try {
    // Загружаем все устройства
    const devicesRes = await adminFetch('/api/devices');
    const allDevices = await devicesRes.json();
    
    // Загружаем назначенные устройства пользователя
    const userDevicesRes = await adminFetch(`/api/auth/users/${userId}/devices`);
    const userDeviceIds = await userDevicesRes.json();
    
    window.userDevicesModalState.allDevices = allDevices;
    window.userDevicesModalState.userDeviceIds = Array.isArray(userDeviceIds) ? userDeviceIds : [];
    
    // Применяем фильтрацию и рендеринг
    filterAndRenderDevices();
  } catch (err) {
    const container = document.getElementById('modalDevicesList');
    if (container) {
      container.innerHTML = '<div class="meta" style="color:var(--danger); text-align:center;">Ошибка загрузки</div>';
    }
  }
}

function setupUserDevicesModalHandlers(adminFetch, userId, username) {
  const searchInput = document.getElementById('modalDevicesSearch');
  const selectAllBtn = document.getElementById('modalDevicesSelectAll');
  const deselectAllBtn = document.getElementById('modalDevicesDeselectAll');
  const saveBtn = document.getElementById('modalDevicesSaveBtn');
  const prevBtn = document.getElementById('modalDevicesPrevPage');
  const nextBtn = document.getElementById('modalDevicesNextPage');
  
  if (!searchInput || !selectAllBtn || !deselectAllBtn || !saveBtn) return;
  const safeUsername = escapeHtml(username || '');
  
  // Обработчик поиска
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      window.userDevicesModalState.searchQuery = e.target.value.trim().toLowerCase();
      window.userDevicesModalState.currentPage = 1;
      filterAndRenderDevices();
    }, 300);
  });
  
  // Выбрать все
  selectAllBtn.onclick = () => {
    const state = window.userDevicesModalState;
    const filteredIds = state.filteredDevices.map(d => d.device_id);
    state.userDeviceIds = [...new Set([...state.userDeviceIds, ...filteredIds])];
    filterAndRenderDevices();
  };
  
  // Снять все
  deselectAllBtn.onclick = () => {
    const state = window.userDevicesModalState;
    const filteredIds = state.filteredDevices.map(d => d.device_id);
    state.userDeviceIds = state.userDeviceIds.filter(id => !filteredIds.includes(id));
    filterAndRenderDevices();
  };
  
  // Сохранение
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Сохранение...';
    
    try {
      const res = await adminFetch(`/api/auth/users/${userId}/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: window.userDevicesModalState.userDeviceIds })
      });
      
      if (res.ok) {
        closeModal();
        showModal(`${getSuccessIcon(18)} Успешно`, `
          <div style="text-align:center; padding:var(--space-lg);">
            Устройства для <strong>${safeUsername}</strong> успешно обновлены
          </div>
          <button onclick="closeModal(); setTimeout(() => window.showUsersModal && window.showUsersModal(window.adminFetch), 100)" class="primary" style="width:100%;">OK</button>
        `);
      } else {
        const error = await res.json();
        await reportModalNotification({
          type: 'user_devices_save_error',
          title: 'Ошибка сохранения устройств пользователя',
          message: error.error || 'Ошибка сохранения',
          details: { userId }
        });
        saveBtn.disabled = false;
        saveBtn.textContent = 'Сохранить';
      }
    } catch (err) {
      await reportModalNotification({
        type: 'user_devices_save_error',
        title: 'Ошибка сохранения устройств пользователя',
        message: err.message || 'Неизвестная ошибка',
        details: { userId }
      });
      saveBtn.disabled = false;
      saveBtn.textContent = 'Сохранить';
    }
  };
  
  // Пагинация
  if (prevBtn) {
    prevBtn.onclick = () => {
      if (window.userDevicesModalState.currentPage > 1) {
        window.userDevicesModalState.currentPage--;
        filterAndRenderDevices();
      }
    };
  }
  
  if (nextBtn) {
    nextBtn.onclick = () => {
      const totalPages = Math.ceil(window.userDevicesModalState.filteredDevices.length / window.userDevicesModalState.itemsPerPage);
      if (window.userDevicesModalState.currentPage < totalPages) {
        window.userDevicesModalState.currentPage++;
        filterAndRenderDevices();
      }
    };
  }
}

function filterAndRenderDevices() {
  const state = window.userDevicesModalState;
  const container = document.getElementById('modalDevicesList');
  const paginationInfo = document.getElementById('modalDevicesPaginationInfo');
  const pageInfo = document.getElementById('modalDevicesPageInfo');
  const selectedInfo = document.getElementById('modalDevicesSelectedInfo');
  const prevBtn = document.getElementById('modalDevicesPrevPage');
  const nextBtn = document.getElementById('modalDevicesNextPage');
  
  if (!container) return;
  
  // Фильтрация устройств
  if (state.searchQuery) {
    state.filteredDevices = state.allDevices.filter(d => 
      d.device_id.toLowerCase().includes(state.searchQuery) ||
      (d.name && d.name.toLowerCase().includes(state.searchQuery))
    );
  } else {
    state.filteredDevices = [...state.allDevices];
  }
  
  // Вычисляем пагинацию
  const totalPages = Math.ceil(state.filteredDevices.length / state.itemsPerPage);
  const startIndex = (state.currentPage - 1) * state.itemsPerPage;
  const endIndex = startIndex + state.itemsPerPage;
  const pageDevices = state.filteredDevices.slice(startIndex, endIndex);
  
  // Обновляем информацию
  if (paginationInfo) {
    const total = state.filteredDevices.length;
    const showing = total > 0 ? `${startIndex + 1}-${Math.min(endIndex, total)}` : '0';
    paginationInfo.textContent = total > 0 ? `Показано ${showing} из ${total}` : 'Нет устройств';
  }
  
  if (pageInfo) {
    pageInfo.textContent = totalPages > 0 ? `Страница ${state.currentPage} из ${totalPages}` : '';
  }
  
  if (selectedInfo) {
    const selectedCount = state.userDeviceIds.length;
    selectedInfo.textContent = `Выбрано: ${selectedCount} из ${state.allDevices.length}`;
  }
  
  // Обновляем кнопки пагинации
  if (prevBtn) {
    prevBtn.disabled = state.currentPage <= 1;
  }
  if (nextBtn) {
    nextBtn.disabled = state.currentPage >= totalPages || totalPages === 0;
  }
  
  // Рендерим устройства
  if (pageDevices.length === 0) {
    container.innerHTML = state.searchQuery 
      ? '<div class="meta" style="text-align:center; padding:var(--space-lg); grid-column:1/-1;">Ничего не найдено</div>'
      : '<div class="meta" style="text-align:center; padding:var(--space-lg); grid-column:1/-1;">Нет устройств</div>';
    return;
  }
  
  container.innerHTML = pageDevices.map(d => {
    const isSelected = state.userDeviceIds.includes(d.device_id);
    const deviceName = d.name || d.device_id;
    const safeDeviceName = escapeHtml(deviceName || '');
    const safeDeviceId = escapeHtml(d.device_id || '');
    const deviceIdArg = escapeJsStringForAttr(d.device_id || '');
    return `
      <label style="display:flex; flex-direction:column; gap:var(--space-xs); padding:var(--space-sm); border:1px solid var(--border); border-radius:var(--radius-sm); cursor:pointer; transition:all 0.2s; ${isSelected ? 'background:var(--panel-2); border-color:var(--brand);' : 'background:var(--panel);'}" onmouseover="this.style.background='var(--panel-hover)'; this.style.borderColor='var(--border-hover)'" onmouseout="this.style.background=${isSelected ? "'var(--panel-2)'" : "'var(--panel)'"}; this.style.borderColor=${isSelected ? "'var(--brand)'" : "'var(--border)'"}">
        <div style="display:flex; align-items:center; gap:var(--space-xs);">
          <input 
            type="checkbox" 
            ${isSelected ? 'checked' : ''} 
            onchange="toggleDeviceSelection(${deviceIdArg})"
            style="cursor:pointer; flex-shrink:0;"
          />
          <div style="flex:1; min-width:0; font-weight:500; font-size:var(--font-size-sm);">${safeDeviceName}</div>
        </div>
        <div class="meta" style="font-size:0.7rem; padding-left:calc(var(--space-xs) + 16px); color:var(--muted);">${safeDeviceId}</div>
      </label>
    `;
  }).join('');
}

// Глобальная функция для переключения выбора устройства
window.toggleDeviceSelection = function(deviceId) {
  const state = window.userDevicesModalState;
  const index = state.userDeviceIds.indexOf(deviceId);
  if (index > -1) {
    state.userDeviceIds.splice(index, 1);
  } else {
    state.userDeviceIds.push(deviceId);
  }
  filterAndRenderDevices();
};

export function showSettingsModal() {
  // Импортируем системный монитор динамически
  Promise.all([
    import('./system-monitor.js'),
    import('./auth.js')
  ]).then(([{ getSystemMonitorHTML, initSystemMonitor }, { adminFetch }]) => {
    const restartServiceFromSettings = async (buttonEl) => {
      if (!confirm('Перезапустить сервис сейчас?')) return;

      const initialText = buttonEl.textContent;
      buttonEl.disabled = true;
      buttonEl.textContent = '...';

      try {
        const response = await adminFetch('/api/admin/restart-service', {
          method: 'POST'
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Ошибка перезапуска сервиса' }));
          throw new Error(error.error || 'Ошибка перезапуска сервиса');
        }

        const result = await response.json().catch(() => ({ ok: true }));
        const message = result.message || 'Перезапуск сервиса запущен. Подождите несколько секунд.';

        showModal(`${getSuccessIcon(18)} Перезапуск`, `
          <div style="text-align:center; padding:var(--space-lg);">
            ${escapeHtml(message)}
          </div>
          <button onclick="closeModal()" class="primary" style="width:100%; margin-top:var(--space-md);">OK</button>
        `);
      } catch (err) {
        await reportModalNotification({
          type: 'service_restart_error',
          title: 'Ошибка перезапуска сервиса',
          message: err.message || 'Неизвестная ошибка'
        });
      } finally {
        buttonEl.disabled = false;
        buttonEl.textContent = initialText;
      }
    };

    const content = `
      <div id="settingsModalSystemMonitor" style="margin-bottom:var(--space-md);">
        ${getSystemMonitorHTML()}
      </div>
      <div id="settingsModalContainer" style="display:flex; flex-direction:column; gap:var(--space-lg);">
        <div class="meta" style="text-align:center;">Загрузка настроек...</div>
      </div>
    `;
    
    showModal(`${getSettingsIcon(18)} Настройки`, content, {
      onRestartService: restartServiceFromSettings,
      onViewServiceLogs: () => openServiceLogsModal(adminFetch)
    });
    
    // Инициализируем системный монитор в модальном окне после того как DOM обновлен
    setTimeout(() => {
      const monitorContainer = document.getElementById('settingsModalSystemMonitor');
      if (monitorContainer && adminFetch) {
        initSystemMonitor(adminFetch, monitorContainer);
      }
    }, 0);
    
    // Загружаем настройки
    loadSettingsContent(adminFetch);
  }).catch(() => {
    // Fallback если импорт не удался
    import('./auth.js').then(({ adminFetch }) => {
      const restartServiceFromSettings = async (buttonEl) => {
        if (!confirm('Перезапустить сервис сейчас?')) return;

        const initialText = buttonEl.textContent;
        buttonEl.disabled = true;
        buttonEl.textContent = '...';

        try {
          const response = await adminFetch('/api/admin/restart-service', {
            method: 'POST'
          });

          if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Ошибка перезапуска сервиса' }));
            throw new Error(error.error || 'Ошибка перезапуска сервиса');
          }

          const result = await response.json().catch(() => ({ ok: true }));
          const message = result.message || 'Перезапуск сервиса запущен. Подождите несколько секунд.';

          showModal(`${getSuccessIcon(18)} Перезапуск`, `
            <div style="text-align:center; padding:var(--space-lg);">
              ${escapeHtml(message)}
            </div>
            <button onclick="closeModal()" class="primary" style="width:100%; margin-top:var(--space-md);">OK</button>
          `);
        } catch (err) {
          await reportModalNotification({
            type: 'service_restart_error',
            title: 'Ошибка перезапуска сервиса',
            message: err.message || 'Неизвестная ошибка'
          });
        } finally {
          buttonEl.disabled = false;
          buttonEl.textContent = initialText;
        }
      };

      const content = `
        <div id="settingsModalContainer" style="display:flex; flex-direction:column; gap:var(--space-lg);">
          <div class="meta" style="text-align:center;">Загрузка настроек...</div>
        </div>
      `;
      showModal(`${getSettingsIcon(18)} Настройки`, content, {
        onRestartService: restartServiceFromSettings,
        onViewServiceLogs: () => openServiceLogsModal(adminFetch)
      });
      loadSettingsContent(adminFetch);
    });
  });
}

async function loadSettingsContent(adminFetch) {
  const container = document.getElementById('settingsModalContainer');
  if (!container) return;
  
  let settingsData = null;
  
  try {
    const response = await adminFetch('/api/admin/settings');
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Ошибка загрузки настроек' }));
      throw new Error(error.error || 'Ошибка загрузки настроек');
    }
    settingsData = await response.json();
  } catch (err) {
    const safeError = escapeHtml(err.message || 'Ошибка загрузки настроек');
    container.innerHTML = `<div class="meta" style="color:var(--danger); text-align:center;">${safeError}</div>`;
    return;
  }
  
  // Очищаем контейнер перед добавлением нового содержимого
  container.innerHTML = '';
  
  const currentContentRoot = settingsData?.runtime?.contentRoot || settingsData?.contentRoot || '';
  // По умолчанию используется локальная папка проекта (data/ внутри проекта)
  // Админ может изменить на любой абсолютный путь через настройки
  // defaults.contentRoot всегда содержит значение по умолчанию, вычисляемое сервером
  const defaultContentRoot = settingsData?.defaults?.contentRoot || '';
  
  // Используем DOM методы вместо innerHTML для безопасности
  const mainDiv = document.createElement('div');
  mainDiv.style.cssText = 'padding:var(--space-md); background:var(--panel-2); border-radius:var(--radius-sm); display:flex; flex-direction:column; gap:0;';
  
  // Хранилище контента
  const storageSection = document.createElement('div');
  storageSection.style.cssText = 'padding-bottom:var(--space-md);';
  
  const storageTitle = document.createElement('div');
  storageTitle.style.cssText = 'font-weight:600; font-size:1.1rem; color:var(--text-primary); margin-bottom:var(--space-sm);';
  storageTitle.textContent = 'Хранилище контента';
  
  const storageContent = document.createElement('div');
  storageContent.style.cssText = 'display:flex; align-items:center; gap:var(--space-md);';
  
  const storageInputContainer = document.createElement('div');
  storageInputContainer.style.cssText = 'flex:1; display:flex; flex-direction:column; gap:var(--space-xs);';
  
  const contentRootInput = document.createElement('input');
  contentRootInput.id = 'contentRootInput';
  contentRootInput.className = 'input';
  contentRootInput.spellcheck = false;
  
  if (defaultContentRoot) {
    const defaultInfo = document.createElement('div');
    defaultInfo.className = 'meta';
    defaultInfo.style.cssText = 'font-size:0.85rem; color:var(--text-secondary);';
    const defaultText = document.createTextNode('По умолчанию: ');
    const codeEl = document.createElement('code');
    codeEl.style.fontFamily = 'monospace';
    codeEl.textContent = defaultContentRoot;
    defaultInfo.appendChild(defaultText);
    defaultInfo.appendChild(codeEl);
    storageInputContainer.appendChild(defaultInfo);
  }
  
  const contentRootStatus = document.createElement('div');
  contentRootStatus.id = 'contentRootStatus';
  contentRootStatus.className = 'meta';
  contentRootStatus.style.cssText = 'min-height:1.2em; font-size:0.85rem;';
  
  storageInputContainer.appendChild(contentRootInput);
  storageInputContainer.appendChild(contentRootStatus);
  
  const contentRootSaveBtn = document.createElement('button');
  contentRootSaveBtn.id = 'contentRootSaveBtn';
  contentRootSaveBtn.className = 'primary';
  contentRootSaveBtn.style.cssText = 'flex-shrink:0;';
  contentRootSaveBtn.textContent = 'Сохранить';
  
  storageContent.appendChild(storageInputContainer);
  storageContent.appendChild(contentRootSaveBtn);
  storageSection.appendChild(storageTitle);
  storageSection.appendChild(storageContent);

  // (LDAP/AD UI removed — configuration moved to server .env)
  
  // Разделитель
  const divider1 = document.createElement('div');
  divider1.style.cssText = 'border-top:1px solid var(--border-color, rgba(255,255,255,0.1)); margin:0;';
  
  // База данных
  const dbSection = document.createElement('div');
  dbSection.style.cssText = 'padding:var(--space-md) 0;';
  
  const dbTitle = document.createElement('div');
  dbTitle.style.cssText = 'font-weight:600; font-size:1.1rem; color:var(--text-primary); margin-bottom:var(--space-sm);';
  dbTitle.textContent = 'База данных';
  
  const dbContent = document.createElement('div');
  dbContent.style.cssText = 'display:flex; align-items:center; gap:var(--space-md);';
  
  const dbDescription = document.createElement('div');
  dbDescription.className = 'meta';
  dbDescription.style.cssText = 'flex:1; color:var(--text-secondary); line-height:1.4;';
  dbDescription.textContent = 'Экспортируйте базу данных для резервного копирования или миграции.';
  
  const exportDatabaseBtn = document.createElement('button');
  exportDatabaseBtn.id = 'exportDatabaseBtn';
  exportDatabaseBtn.className = 'primary';
  exportDatabaseBtn.style.cssText = 'flex-shrink:0;';
  exportDatabaseBtn.innerHTML = `${getDownloadIcon(16)} Экспорт`;

  // Кнопка импорта базы данных (скрытый input + кнопка)
  const importDatabaseBtn = document.createElement('button');
  importDatabaseBtn.id = 'importDatabaseBtn';
  importDatabaseBtn.className = 'secondary';
  importDatabaseBtn.style.cssText = 'flex-shrink:0; margin-left:8px;';
  importDatabaseBtn.innerHTML = `${getUpDownloadIcon(16)} Импорт`;

  const importFileInput = document.createElement('input');
  importFileInput.type = 'file';
  importFileInput.accept = '.db';
  importFileInput.style.display = 'none';
  
  dbContent.appendChild(dbDescription);
  dbContent.appendChild(exportDatabaseBtn);
  dbContent.appendChild(importDatabaseBtn);
  dbSection.appendChild(importFileInput);
  dbSection.appendChild(dbTitle);
  dbSection.appendChild(dbContent);
  
  // Разделитель 2
  const divider2 = document.createElement('div');
  divider2.style.cssText = 'border-top:1px solid var(--border-color, rgba(255,255,255,0.1)); margin:0;';
  
  // Контейнер для обеих секций очистки (рядом друг с другом)
  const cleanupContainer = document.createElement('div');
  cleanupContainer.style.cssText = 'display:flex; gap:var(--space-lg); padding-top:var(--space-md);';
  
  // Очистка базы данных
  const cleanupSection = document.createElement('div');
  cleanupSection.style.cssText = 'flex:1; min-width:0;';
  
  const cleanupTitle = document.createElement('div');
  cleanupTitle.style.cssText = 'font-weight:600; font-size:1.1rem; color:var(--text-primary); margin-bottom:var(--space-sm);';
  cleanupTitle.textContent = 'Очистка базы данных';
  
  const cleanupContent = document.createElement('div');
  cleanupContent.style.cssText = 'display:flex; align-items:center; gap:var(--space-md);';
  
  const cleanupLeft = document.createElement('div');
  cleanupLeft.style.cssText = 'flex:1; display:flex; flex-direction:column; gap:var(--space-xs);';
  
  const cleanupDescription = document.createElement('div');
  cleanupDescription.className = 'meta';
  cleanupDescription.style.cssText = 'color:var(--text-secondary); line-height:1.4;';
  cleanupDescription.textContent = 'Проверьте файлы из базы данных на наличие на диске. Удалите записи о несуществующих файлах.';
  
  const cleanupStatus = document.createElement('div');
  cleanupStatus.id = 'cleanupStatus';
  cleanupStatus.className = 'meta';
  cleanupStatus.style.cssText = 'min-height:1.2em; font-size:0.85rem;';
  
  cleanupLeft.appendChild(cleanupDescription);
  cleanupLeft.appendChild(cleanupStatus);
  
  const cleanupButtons = document.createElement('div');
  cleanupButtons.style.cssText = 'flex-shrink:0; display:flex; gap:var(--space-xs);';
  
  const checkFilesBtn = document.createElement('button');
  checkFilesBtn.id = 'checkFilesBtn';
  checkFilesBtn.className = 'secondary';
  checkFilesBtn.style.cssText = 'width:36px; height:36px; padding:0; display:flex; align-items:center; justify-content:center;';
  checkFilesBtn.title = 'Проверить файлы';
  checkFilesBtn.textContent = '🔍';
  
  const cleanupFilesBtn = document.createElement('button');
  cleanupFilesBtn.id = 'cleanupFilesBtn';
  cleanupFilesBtn.className = 'danger meta-lg';
  cleanupFilesBtn.style.cssText = 'width:36px; height:36px; padding:0; display:flex; align-items:center; justify-content:center;';
  cleanupFilesBtn.disabled = true;
  cleanupFilesBtn.title = 'Очистить';
  cleanupFilesBtn.textContent = '🗑️';
  
  cleanupButtons.appendChild(checkFilesBtn);
  cleanupButtons.appendChild(cleanupFilesBtn);
  cleanupContent.appendChild(cleanupLeft);
  cleanupContent.appendChild(cleanupButtons);
  cleanupSection.appendChild(cleanupTitle);
  cleanupSection.appendChild(cleanupContent);
  
  // Очистка осиротевших файлов
  const orphanedSection = document.createElement('div');
  orphanedSection.style.cssText = 'flex:1; min-width:0;';
  
  const orphanedTitle = document.createElement('div');
  orphanedTitle.style.cssText = 'font-weight:600; font-size:1.1rem; color:var(--text-primary); margin-bottom:var(--space-sm);';
  orphanedTitle.textContent = 'Очистка осиротевших файлов';
  
  const orphanedContent = document.createElement('div');
  orphanedContent.style.cssText = 'display:flex; align-items:center; gap:var(--space-md);';
  
  const orphanedLeft = document.createElement('div');
  orphanedLeft.style.cssText = 'flex:1; display:flex; flex-direction:column; gap:var(--space-xs);';
  
  const orphanedDescription = document.createElement('div');
  orphanedDescription.className = 'meta';
  orphanedDescription.style.cssText = 'color:var(--text-secondary); line-height:1.4;';
  orphanedDescription.textContent = 'Найдите и удалите файлы в корне /content/, которые не имеют записей в базе данных.';
  
  const orphanedStatus = document.createElement('div');
  orphanedStatus.id = 'orphanedStatus';
  orphanedStatus.className = 'meta';
  orphanedStatus.style.cssText = 'min-height:1.2em; font-size:0.85rem;';
  
  orphanedLeft.appendChild(orphanedDescription);
  orphanedLeft.appendChild(orphanedStatus);
  
  const orphanedButtons = document.createElement('div');
  orphanedButtons.style.cssText = 'flex-shrink:0; display:flex; gap:var(--space-xs);';
  
  const checkOrphanedBtn = document.createElement('button');
  checkOrphanedBtn.id = 'checkOrphanedBtn';
  checkOrphanedBtn.className = 'secondary';
  checkOrphanedBtn.style.cssText = 'width:36px; height:36px; padding:0; display:flex; align-items:center; justify-content:center;';
  checkOrphanedBtn.title = 'Проверить осиротевшие файлы';
  checkOrphanedBtn.textContent = '🔍';
  
  const cleanupOrphanedBtn = document.createElement('button');
  cleanupOrphanedBtn.id = 'cleanupOrphanedBtn';
  cleanupOrphanedBtn.className = 'danger meta-lg';
  cleanupOrphanedBtn.style.cssText = 'width:36px; height:36px; padding:0; display:flex; align-items:center; justify-content:center;';
  cleanupOrphanedBtn.disabled = true;
  cleanupOrphanedBtn.title = 'Удалить осиротевшие файлы';
  cleanupOrphanedBtn.textContent = '🗑️';
  
  orphanedButtons.appendChild(checkOrphanedBtn);
  orphanedButtons.appendChild(cleanupOrphanedBtn);
  orphanedContent.appendChild(orphanedLeft);
  orphanedContent.appendChild(orphanedButtons);
  orphanedSection.appendChild(orphanedTitle);
  orphanedSection.appendChild(orphanedContent);
  
  // Добавляем обе секции очистки в контейнер
  cleanupContainer.appendChild(cleanupSection);
  cleanupContainer.appendChild(orphanedSection);
  

  // --- Секция установки APK с автозаполнением ---
  const apkSection = document.createElement('div');
  apkSection.style.cssText = 'padding:var(--space-md); background:var(--panel-2); border-radius:var(--radius-sm); margin-bottom:var(--space-md);';
  const apkTitle = document.createElement('div');
  apkTitle.style.cssText = 'font-weight:600; font-size:1.1rem; color:var(--text-primary); margin-bottom:var(--space-xs);';
  apkTitle.textContent = 'Установка Android-приложения (APK)';
  const apkForm = document.createElement('form');
  apkForm.style.cssText = 'display:flex; gap:var(--space-xs); align-items:center; flex-wrap:nowrap;';
  apkForm.onsubmit = e => { e.preventDefault(); };
  const apkIpInput = document.createElement('input');
  apkIpInput.type = 'text';
  apkIpInput.placeholder = 'IP устройства';
  apkIpInput.className = 'input';
  apkIpInput.style.cssText = 'width:120px; max-width:20vw;';
  apkIpInput.required = true;
  const apkIdInput = document.createElement('input');
  apkIdInput.type = 'text';
  apkIdInput.placeholder = 'ID устройства';
  apkIdInput.className = 'input';
  apkIdInput.style.cssText = 'width:100px; max-width:15vw;';
  apkIdInput.required = true;
  const apkNameInput = document.createElement('input');
  apkNameInput.type = 'text';
  apkNameInput.placeholder = 'Имя устройства';
  apkNameInput.className = 'input';
  apkNameInput.style.cssText = 'width:120px; max-width:20vw;';
  apkNameInput.required = true;
  const apkInstallBtn = document.createElement('button');
  apkInstallBtn.type = 'submit';
  apkInstallBtn.className = 'primary';
  apkInstallBtn.style.cssText = 'min-width:120px; margin-left:auto;';
  apkInstallBtn.textContent = 'Установить APK';
  const apkStatus = document.createElement('div');
  apkStatus.className = 'meta';
  apkStatus.style.cssText = 'min-height:1.2em; font-size:0.85rem; color:var(--text-secondary); margin-top:2px;';
  apkForm.appendChild(apkIpInput);
  apkForm.appendChild(apkIdInput);
  apkForm.appendChild(apkNameInput);
  apkForm.appendChild(apkInstallBtn);
  apkSection.appendChild(apkTitle);
  apkSection.appendChild(apkForm);
  apkSection.appendChild(apkStatus);

  apkForm.onsubmit = async (e) => {
    e.preventDefault();
    apkInstallBtn.disabled = true;
    apkStatus.textContent = 'Установка...';
    apkStatus.style.color = 'var(--text-secondary)';
    const ip = apkIpInput.value.trim();
    const deviceId = apkIdInput.value.trim();
    const deviceName = apkNameInput.value.trim();
    if (!ip || !deviceId || !deviceName) {
      apkStatus.textContent = 'Заполните все поля';
      apkStatus.style.color = 'var(--danger)';
      apkInstallBtn.disabled = false;
      return;
    }
    try {
      const resp = await adminFetch('/api/admin/install-apk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, deviceId, deviceName })
      });
      const result = await resp.json();
      if (result.ok) {
        apkStatus.textContent = 'APK установлен и устройство настроено!';
        apkStatus.style.color = 'var(--success, #4caf50)';
      } else {
        apkStatus.textContent = 'Ошибка: ' + (result.error || 'Неизвестная ошибка');
        apkStatus.style.color = 'var(--danger)';
      }
    } catch (err) {
      apkStatus.textContent = 'Ошибка соединения с сервером';
      apkStatus.style.color = 'var(--danger)';
    }
    apkInstallBtn.disabled = false;
  };

  mainDiv.appendChild(apkSection);
  mainDiv.appendChild(storageSection);
  mainDiv.appendChild(divider1);
  mainDiv.appendChild(dbSection);
  mainDiv.appendChild(divider2);
  mainDiv.appendChild(cleanupContainer);
  container.appendChild(mainDiv);
  
  // Используем уже созданные элементы напрямую
  const inputEl = contentRootInput;
  const saveBtn = contentRootSaveBtn;
  const statusEl = contentRootStatus;
  const exportBtn = exportDatabaseBtn;
  const importBtn = importDatabaseBtn;
  const importFileEl = importFileInput;
  const cleanupStatusEl = cleanupStatus;
  const orphanedStatusEl = orphanedStatus;
  
  if (!inputEl || !saveBtn || !statusEl || !exportBtn || !importBtn || !importFileEl || !checkFilesBtn || !cleanupFilesBtn || !cleanupStatusEl || !checkOrphanedBtn || !cleanupOrphanedBtn || !orphanedStatusEl) return;
  
  let lastSavedValue = currentContentRoot;
  inputEl.value = currentContentRoot;
  
  const toggleSaveState = () => {
    const same = inputEl.value.trim() === lastSavedValue;
    saveBtn.disabled = same;
    if (!same) {
      statusEl.textContent = '';
      statusEl.style.color = 'var(--text-secondary)';
    }
  };
  
  toggleSaveState();
  inputEl.addEventListener('input', toggleSaveState);
  
  saveBtn.onclick = async () => {
    const newPath = inputEl.value.trim();
    if (!newPath) {
      statusEl.textContent = 'Укажите абсолютный путь';
      statusEl.style.color = 'var(--danger)';
      return;
    }
    
    saveBtn.disabled = true;
    saveBtn.textContent = 'Сохранение...';
    statusEl.textContent = 'Проверяем путь...';
    statusEl.style.color = 'var(--text-secondary)';
    
    try {
      const response = await adminFetch('/api/admin/settings/content-root', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath })
      });
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Не удалось сохранить' }));
        throw new Error(error.error || 'Не удалось сохранить');
      }
      
      const data = await response.json();
      lastSavedValue = data.contentRoot || newPath;
      inputEl.value = lastSavedValue;
      statusEl.textContent = 'Путь сохранён. Контент будет загружаться и читаться из новой папки.';
      statusEl.style.color = 'var(--success)';
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.style.color = 'var(--danger)';
    } finally {
      saveBtn.textContent = 'Сохранить путь';
      toggleSaveState();
    }
  };

  exportBtn.onclick = async () => {
      exportBtn.disabled = true;
      exportBtn.textContent = 'Экспорт...';
      
      try {
        const response = await adminFetch('/api/admin/export-database');
        
        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Ошибка экспорта' }));
          throw new Error(error.error || 'Ошибка экспорта');
        }
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.style.display = 'none';
        link.href = url;
        link.download = `main_${new Date().toISOString().split('T')[0]}.db`;
        document.body.appendChild(link);
        link.click();
        
        setTimeout(() => {
          document.body.removeChild(link);
          window.URL.revokeObjectURL(url);
        }, 100);
        
        exportBtn.disabled = false;
        exportBtn.innerHTML = `${getDownloadIcon(16)} Экспортировано`;
        setTimeout(() => {
          exportBtn.innerHTML = `${getDownloadIcon(16)} Экспорт`;
        }, 2000);
      } catch (err) {
        await reportModalNotification({
          type: 'database_export_error',
          title: 'Ошибка экспорта базы данных',
          message: err.message || 'Неизвестная ошибка'
        });
        exportBtn.disabled = false;
        exportBtn.innerHTML = `${getDownloadIcon(16)} Экспорт`;
      }
    };

    // Импорт базы данных
    importBtn.onclick = async () => {
      if (!confirm('Импорт базы данных перезапишет текущую базу. Продолжить?')) return;
      // Открываем диалог выбора файла
      importFileEl.value = null;
      importFileEl.click();
    };

    importFileEl.onchange = async () => {
      const file = importFileEl.files && importFileEl.files[0];
      if (!file) return;

      importBtn.disabled = true;
      importBtn.textContent = 'Импорт...';

      try {
        const form = new FormData();
        form.append('file', file);

        // Используем adminFetch — он может добавлять CSRF/авторизацию
        const resp = await adminFetch('/api/admin/import-database', {
          method: 'POST',
          body: form
        });

        if (!resp.ok) {
          const error = await resp.json().catch(() => ({ error: 'Ошибка импорта' }));
          throw new Error(error.error || 'Ошибка импорта');
        }

        const result = await resp.json().catch(() => ({ ok: true }));

        if (result.ok || resp.ok) {
          const restartScheduled = !!result.restartScheduled;
          const statusText = restartScheduled
            ? 'Импорт базы данных завершён успешно. Сервис перезапускается, подождите 3-10 секунд.'
            : 'Импорт базы данных завершён успешно.';

          showModal(`${getSuccessIcon(18)} Успешно`, `
            <div style="text-align:center; padding:var(--space-lg);">
              ${statusText}
            </div>
            <button onclick="closeModal()" class="primary" style="width:100%; margin-top:var(--space-md);">OK</button>
          `);
        } else {
          await reportModalNotification({
            type: 'database_import_error',
            title: 'Ошибка импорта базы данных',
            message: result.error || 'Ошибка импорта'
          });
        }
      } catch (err) {
        await reportModalNotification({
          type: 'database_import_error',
          title: 'Ошибка импорта базы данных',
          message: err.message || 'Неизвестная ошибка'
        });
      } finally {
        importBtn.disabled = false;
        importBtn.innerHTML = `${getUpDownloadIcon(16)} Импорт`;
      }
    };

  // Обработчики для очистки БД
  let lastCheckResult = null;

  checkFilesBtn.onclick = async () => {
    checkFilesBtn.disabled = true;
    checkFilesBtn.innerHTML = '⏳';
    cleanupStatusEl.textContent = '';
    cleanupStatusEl.style.color = 'var(--text-secondary)';
    cleanupFilesBtn.disabled = true;

    try {
      const response = await adminFetch('/api/admin/database/check-files');

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Ошибка проверки' }));
        throw new Error(error.error || 'Ошибка проверки');
      }

      const result = await response.json();
      lastCheckResult = result;

      let statusText = `Проверено: ${result.checked} файлов. `;
      if (result.missingOnDisk > 0) {
        statusText += `Отсутствует на диске (в БД есть): ${result.missingOnDisk}.`;
      }
      
      // Активируем кнопку, если есть что удалять
      if (result.missingOnDisk > 0) {
        cleanupFilesBtn.disabled = false;
      }
      
      if (result.missingOnDisk === 0) {
        statusText = '✅ Все файлы на месте. Проблем не обнаружено.';
        cleanupStatusEl.style.color = 'var(--success)';
      } else if (result.missingOnDisk > 0) {
        cleanupStatusEl.style.color = 'var(--warning)';
      } else {
        cleanupStatusEl.style.color = 'var(--text-secondary)';
      }

      cleanupStatusEl.textContent = statusText;
    } catch (err) {
      cleanupStatusEl.textContent = `Ошибка: ${err.message}`;
      cleanupStatusEl.style.color = 'var(--danger)';
    } finally {
      checkFilesBtn.disabled = false;
      checkFilesBtn.innerHTML = '🔍';
    }
  };

  cleanupFilesBtn.onclick = async () => {
    if (!lastCheckResult || lastCheckResult.missingOnDisk === 0) {
      await reportModalNotification({
        type: 'cleanup_prerequisite_missing',
        severity: 'info',
        title: 'Требуется предварительная проверка',
        message: 'Сначала выполните проверку файлов'
      });
      return;
    }

    const confirmMessage = `Удалить ${lastCheckResult.missingOnDisk} записей из БД (файлов нет на диске)?`;

    if (!confirm(confirmMessage)) {
      return;
    }

    cleanupFilesBtn.disabled = true;
    cleanupFilesBtn.innerHTML = '⏳';
    cleanupStatusEl.textContent = 'Удаление...';
    cleanupStatusEl.style.color = 'var(--text-secondary)';

    try {
      const response = await adminFetch('/api/admin/database/cleanup-missing-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: null }) // null = все устройства
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Ошибка очистки' }));
        throw new Error(error.error || 'Ошибка очистки');
      }

      const result = await response.json();
      
      let resultText = '';
      if (result.deletedFromDB > 0) {
        resultText = `✅ Удалено ${result.deletedFromDB} записей из базы данных.`;
      } else {
        resultText = '✅ Очистка завершена.';
      }
      
      cleanupStatusEl.textContent = resultText;
      cleanupStatusEl.style.color = 'var(--success, #22c55e)';
      cleanupFilesBtn.disabled = true;
      cleanupFilesBtn.innerHTML = '🗑️';
      lastCheckResult = null;

      // Обновляем данные после очистки
      setTimeout(() => {
        cleanupStatusEl.textContent = '';
      }, 5000);
    } catch (err) {
      cleanupStatusEl.textContent = `Ошибка: ${err.message}`;
      cleanupStatusEl.style.color = 'var(--danger)';
      cleanupFilesBtn.disabled = false;
    } finally {
      cleanupFilesBtn.innerHTML = '🗑️';
    }
  };

  // Обработчики для очистки осиротевших файлов
  let lastOrphanedResult = null;

  checkOrphanedBtn.onclick = async () => {
    checkOrphanedBtn.disabled = true;
    checkOrphanedBtn.innerHTML = '⏳';
    orphanedStatusEl.textContent = '';
    orphanedStatusEl.style.color = 'var(--text-secondary)';
    cleanupOrphanedBtn.disabled = true;

    try {
      const response = await adminFetch('/api/admin/database/cleanup-orphaned-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true })
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Ошибка проверки' }));
        throw new Error(error.error || 'Ошибка проверки');
      }

      const result = await response.json();
      lastOrphanedResult = result;

      let statusText = `Проверено: ${result.checked} файлов. `;
      if (result.orphaned > 0) {
        statusText += `Найдено осиротевших файлов: ${result.orphaned} (${result.totalSizeMB} МБ).`;
      }
      
      // Активируем кнопку, если есть что удалять
      if (result.orphaned > 0) {
        cleanupOrphanedBtn.disabled = false;
      }
      
      if (result.orphaned === 0) {
        statusText = '✅ Осиротевших файлов не найдено.';
        orphanedStatusEl.style.color = 'var(--success)';
      } else if (result.orphaned > 0) {
        orphanedStatusEl.style.color = 'var(--warning)';
      } else {
        orphanedStatusEl.style.color = 'var(--text-secondary)';
      }

      orphanedStatusEl.textContent = statusText;
    } catch (err) {
      orphanedStatusEl.textContent = `Ошибка: ${err.message}`;
      orphanedStatusEl.style.color = 'var(--danger)';
    } finally {
      checkOrphanedBtn.disabled = false;
      checkOrphanedBtn.innerHTML = '🔍';
    }
  };

  cleanupOrphanedBtn.onclick = async () => {
    if (!lastOrphanedResult || lastOrphanedResult.orphaned === 0) {
      await reportModalNotification({
        type: 'orphan_cleanup_prerequisite_missing',
        severity: 'info',
        title: 'Требуется предварительная проверка',
        message: 'Сначала выполните проверку осиротевших файлов'
      });
      return;
    }

    const confirmMessage = `Удалить ${lastOrphanedResult.orphaned} осиротевших файлов (${lastOrphanedResult.totalSizeMB} МБ)?\n\nЭто действие нельзя отменить!`;

    if (!confirm(confirmMessage)) {
      return;
    }

    cleanupOrphanedBtn.disabled = true;
    cleanupOrphanedBtn.innerHTML = '⏳';
    orphanedStatusEl.textContent = 'Удаление...';
    orphanedStatusEl.style.color = 'var(--text-secondary)';

    try {
      const response = await adminFetch('/api/admin/database/cleanup-orphaned-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false })
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Ошибка очистки' }));
        throw new Error(error.error || 'Ошибка очистки');
      }

      const result = await response.json();
      
      let resultText = '';
      if (result.deleted > 0) {
        resultText = `✅ Удалено ${result.deleted} осиротевших файлов (${result.totalSizeMB} МБ освобождено).`;
        if (result.errors && result.errors.length > 0) {
          resultText += ` Ошибок: ${result.errors.length}.`;
        }
      } else {
        resultText = '✅ Очистка завершена.';
      }

      orphanedStatusEl.textContent = resultText;
      orphanedStatusEl.style.color = 'var(--success)';
      cleanupOrphanedBtn.disabled = false;
      cleanupOrphanedBtn.innerHTML = '🗑️';
      lastOrphanedResult = null;

      // Обновляем данные после очистки
      setTimeout(() => {
        orphanedStatusEl.textContent = '';
      }, 5000);
    } catch (err) {
      orphanedStatusEl.textContent = `Ошибка: ${err.message}`;
      orphanedStatusEl.style.color = 'var(--danger)';
      cleanupOrphanedBtn.disabled = false;
      cleanupOrphanedBtn.innerHTML = '🗑️';
    }
  };
}

