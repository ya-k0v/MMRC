/**
 * Модальное окно уведомлений
 * @module admin/notifications-modal
 */

import { showModal } from './modal.js';
import { adminFetch } from './auth.js';

let socket = null;
let currentNotifications = [];
let subscribedSocket = null;
let socketListenersBound = false;
let socketNotificationHandler = null;
let socketAcknowledgedHandler = null;
let socketRemovedHandler = null;

const NOTIFICATIONS_MODAL_LIST_ID = 'notificationsModalList';
const NOTIFICATIONS_MODAL_FOOTER_ID = 'notificationsModalFooter';

function getNotificationSortTime(notification) {
  return new Date(notification.updatedAt || notification.timestamp || 0).getTime();
}

function sortNotifications(items = []) {
  return [...items].sort((a, b) => getNotificationSortTime(b) - getNotificationSortTime(a));
}

function removeNotificationFromState(id) {
  const targetId = String(id || '');
  if (!targetId) return;
  currentNotifications = currentNotifications.filter((item) => item.id !== targetId);
}

function upsertNotificationInState(notification) {
  if (!notification || !notification.id) return;

  if (notification.acknowledged) {
    removeNotificationFromState(notification.id);
    return;
  }

  const index = currentNotifications.findIndex((item) => item.id === notification.id);
  if (index >= 0) {
    currentNotifications[index] = {
      ...currentNotifications[index],
      ...notification
    };
  } else {
    currentNotifications.push(notification);
  }

  currentNotifications = sortNotifications(currentNotifications);
}

function isNotificationsModalOpen() {
  const overlay = document.getElementById('modalOverlay');
  const list = document.getElementById(NOTIFICATIONS_MODAL_LIST_ID);
  return Boolean(overlay && overlay.style.display === 'flex' && list);
}

function setElementHtml(target, html) {
  if (!target) return;

  while (target.firstChild) {
    target.removeChild(target.firstChild);
  }

  const tempContainer = document.createElement('div');
  tempContainer.insertAdjacentHTML('beforeend', html);
  while (tempContainer.firstChild) {
    target.appendChild(tempContainer.firstChild);
  }
}

function buildNotificationsListHtml() {
  if (!currentNotifications.length) {
    return '<div style="text-align:center; padding:40px; color:var(--text-secondary);">Нет активных уведомлений</div>';
  }

  return currentNotifications.map(renderNotification).join('');
}

function buildNotificationsModalContent() {
  const notificationsHtml = buildNotificationsListHtml();
  const footerDisplay = currentNotifications.length > 0 ? 'flex' : 'none';

  return `
    <div id="${NOTIFICATIONS_MODAL_LIST_ID}" style="display:flex; flex-direction:column; gap:var(--space-md); max-height:70vh; overflow-y:auto;">
      ${notificationsHtml}
    </div>
    <div id="${NOTIFICATIONS_MODAL_FOOTER_ID}" style="margin-top:var(--space-md); padding-top:var(--space-md); border-top:1px solid var(--border); display:${footerDisplay}; gap:var(--space-sm); justify-content:flex-end;">
      <button id="notificationsClearAll" class="secondary" style="min-width:auto;">Очистить все</button>
    </div>
  `;
}

function renderNotificationsModalContent() {
  const listEl = document.getElementById(NOTIFICATIONS_MODAL_LIST_ID);
  if (!listEl) return;

  setElementHtml(listEl, buildNotificationsListHtml());

  const footerEl = document.getElementById(NOTIFICATIONS_MODAL_FOOTER_ID);
  if (footerEl) {
    footerEl.style.display = currentNotifications.length > 0 ? 'flex' : 'none';
  }

  setupNotificationHandlers();
}

function detachRealtimeSocketListeners() {
  if (!subscribedSocket || !socketListenersBound) {
    return;
  }

  if (socketNotificationHandler) {
    subscribedSocket.off('notification', socketNotificationHandler);
  }
  if (socketAcknowledgedHandler) {
    subscribedSocket.off('notification:acknowledged', socketAcknowledgedHandler);
  }
  if (socketRemovedHandler) {
    subscribedSocket.off('notification:removed', socketRemovedHandler);
  }

  socketListenersBound = false;
}

function attachRealtimeSocketListeners() {
  if (!socket || typeof socket.on !== 'function' || typeof socket.off !== 'function') {
    return;
  }

  if (subscribedSocket && subscribedSocket !== socket) {
    detachRealtimeSocketListeners();
  }

  if (socketListenersBound && subscribedSocket === socket) {
    return;
  }

  socketNotificationHandler = ({ notification, action } = {}) => {
    if (!notification) return;

    if (action === 'removed' || action === 'acknowledged') {
      removeNotificationFromState(notification.id);
    } else {
      upsertNotificationInState(notification);
    }

    if (isNotificationsModalOpen()) {
      renderNotificationsModalContent();
    }
  };

  socketAcknowledgedHandler = ({ id } = {}) => {
    if (!id) return;
    removeNotificationFromState(id);
    if (isNotificationsModalOpen()) {
      renderNotificationsModalContent();
    }
  };

  socketRemovedHandler = ({ id } = {}) => {
    if (!id) return;
    removeNotificationFromState(id);
    if (isNotificationsModalOpen()) {
      renderNotificationsModalContent();
    }
  };

  socket.on('notification', socketNotificationHandler);
  socket.on('notification:acknowledged', socketAcknowledgedHandler);
  socket.on('notification:removed', socketRemovedHandler);

  subscribedSocket = socket;
  socketListenersBound = true;
}

function getActionButtonStyle(variant = 'secondary') {
  if (variant === 'danger') {
    return 'background:#b91c1c; border:1px solid #991b1b; color:#fff;';
  }
  if (variant === 'primary') {
    return 'background:var(--accent, #2563eb); border:1px solid var(--accent, #2563eb); color:#fff;';
  }
  return 'background:var(--bg-secondary); border:1px solid var(--border); color:var(--text);';
}

async function reportModalError(title, error, details = {}) {
  const message = error?.message || String(error || 'Неизвестная ошибка');
  try {
    await adminFetch('/api/notifications/report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'admin_notifications_ui_error',
        severity: 'warning',
        title,
        message,
        source: 'admin-ui',
        details
      })
    });
  } catch (reportErr) {
    console.error('[Notifications Modal] Failed to report UI error:', reportErr);
  }
}

/**
 * Показывает модальное окно с уведомлениями
 * @param {Socket} socketIO - Socket.IO instance (опционально, берется из window.socket если не передан)
 */
export async function showNotificationsModal(socketIO = null) {
  if (socketIO) {
    socket = socketIO;
  } else if (window.socket) {
    socket = window.socket;
  }

  attachRealtimeSocketListeners();
  
  // Загружаем уведомления
  await loadNotifications();

  showModal('🔔 Уведомления', buildNotificationsModalContent());
  
  // Обработчики
  setTimeout(() => {
    setupNotificationHandlers();
  }, 100);
}

/**
 * Загружает уведомления с сервера
 */
async function loadNotifications() {
  try {
    const response = await adminFetch('/api/notifications');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    currentNotifications = sortNotifications(data.notifications || []);
  } catch (error) {
    console.error('[Notifications Modal] Error loading notifications:', error);
    currentNotifications = [];
  }
}

/**
 * Рендерит одно уведомление
 * @param {Object} notification - Уведомление
 * @returns {string} HTML
 */
function renderNotification(notification) {
  const severityColor = getSeverityColor(notification.severity);
  const severityIcon = getSeverityIcon(notification.severity);
  const timeAgo = formatTimeAgo(new Date(notification.timestamp));
  const actions = Array.isArray(notification.actions) ? notification.actions : [];
  
  const detailsHtml = notification.details && Object.keys(notification.details).length > 0
    ? `
      <details style="margin-top:8px;">
        <summary style="cursor:pointer; color:var(--text-secondary); font-size:0.875rem;">
          Подробности
        </summary>
        <div style="margin-top:8px; padding:8px; background:var(--bg-secondary); border-radius:4px; font-size:0.875rem; color:var(--text-secondary);">
          ${renderDetails(notification.details)}
        </div>
      </details>
    `
    : '';

  const actionsHtml = actions.length > 0
    ? `
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;">
        ${actions.map((action) => `
          <button
            class="notification-action-btn"
            data-notification-id="${notification.id}"
            data-action-id="${escapeHtml(action.id)}"
            style="
              min-width:auto;
              padding:6px 10px;
              font-size:0.75rem;
              border-radius:6px;
              ${getActionButtonStyle(action.variant)}
            "
            title="${escapeHtml(action.label)}"
          >
            ${escapeHtml(action.label)}
          </button>
        `).join('')}
      </div>
    `
    : '';
  
  return `
    <div class="notification-item" data-notification-id="${notification.id}" style="
      padding:var(--space-md);
      border:1px solid var(--border);
      border-left:4px solid ${severityColor};
      border-radius:8px;
      background:var(--card-bg);
    ">
      <div style="display:flex; gap:var(--space-sm); align-items:start;">
        <div style="flex:1; min-width:0;">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
            <span style="font-size:18px;">${severityIcon}</span>
            <div style="font-weight:bold; color:var(--text);">${escapeHtml(notification.title)}</div>
          </div>
          <div style="color:var(--text-secondary); font-size:0.875rem; margin-bottom:8px; line-height:1.5;">
            ${escapeHtml(notification.message)}
          </div>
          ${detailsHtml}
          ${actionsHtml}
          <div style="font-size:0.75rem; color:var(--muted); margin-top:8px;">
            ${timeAgo}
          </div>
        </div>
        <div style="display:flex; gap:4px; flex-shrink:0;">
          <button 
            class="notification-ack-btn" 
            data-notification-id="${notification.id}"
            style="
              min-width:auto; 
              padding:6px 10px; 
              font-size:0.75rem;
              background:var(--bg-secondary);
              border:1px solid var(--border);
            "
            title="Отметить как прочитанное"
          >
            ✓
          </button>
          <button 
            class="notification-remove-btn" 
            data-notification-id="${notification.id}"
            style="
              min-width:auto; 
              padding:6px 10px; 
              font-size:0.75rem;
              background:var(--bg-secondary);
              border:1px solid var(--border);
            "
            title="Удалить"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Рендерит детали уведомления
 * @param {Object} details - Детали
 * @returns {string} HTML
 */
function renderDetails(details) {
  const items = [];
  
  if (details.deviceId) {
    items.push(`<strong>Устройство:</strong> ${escapeHtml(details.deviceId)}`);
  }
  
  if (details.error) {
    const errorMsg = typeof details.error === 'string' 
      ? details.error 
      : details.error.message || JSON.stringify(details.error);
    items.push(`<strong>Ошибка:</strong> ${escapeHtml(errorMsg)}`);
  }
  
  if (details.recommendation) {
    items.push(`<strong>Рекомендация:</strong> ${escapeHtml(details.recommendation)}`);
  }
  
  if (details.action) {
    items.push(`<strong>Действие:</strong> ${escapeHtml(details.action)}`);
  }
  
  // Остальные поля
  Object.entries(details).forEach(([key, value]) => {
    if (!['deviceId', 'error', 'recommendation', 'action'].includes(key)) {
      const displayValue = typeof value === 'object' 
        ? JSON.stringify(value, null, 2) 
        : String(value);
      items.push(`<strong>${escapeHtml(key)}:</strong> ${escapeHtml(displayValue)}`);
    }
  });
  
  return items.map(item => `<div style="margin-bottom:4px;">${item}</div>`).join('');
}

/**
 * Настраивает обработчики событий
 */
function setupNotificationHandlers() {
  // Кнопки "Отметить как прочитанное"
  document.querySelectorAll('.notification-ack-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-notification-id');
      await acknowledgeNotification(id);
    };
  });
  
  // Кнопки "Удалить"
  document.querySelectorAll('.notification-remove-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-notification-id');
      await removeNotification(id);
    };
  });

  // Кнопки действий (например, отмена задачи)
  document.querySelectorAll('.notification-action-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const notificationId = btn.getAttribute('data-notification-id');
      const actionId = btn.getAttribute('data-action-id');
      await executeNotificationAction(notificationId, actionId, btn);
    };
  });
  
  // Кнопка "Очистить все"
  const clearAllBtn = document.getElementById('notificationsClearAll');
  if (clearAllBtn) {
    clearAllBtn.onclick = async () => {
      if (confirm('Отметить все уведомления как прочитанные?')) {
        await clearAllNotifications();
      }
    };
  }
}

/**
 * Отмечает уведомление как прочитанное
 * @param {string} id - ID уведомления
 */
async function acknowledgeNotification(id) {
  try {
    const response = await adminFetch(`/api/notifications/${id}/acknowledge`, {
      method: 'POST'
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    removeNotificationFromState(id);
    renderNotificationsModalContent();
    
    // Отправляем через Socket.IO (если доступен)
    if (socket) {
      socket.emit('notifications:acknowledge', { id });
    }
  } catch (error) {
    console.error('[Notifications Modal] Error acknowledging notification:', error);
    await reportModalError('Ошибка подтверждения уведомления', error, { notificationId: id });
  }
}

/**
 * Удаляет уведомление
 * @param {string} id - ID уведомления
 */
async function removeNotification(id) {
  try {
    const response = await adminFetch(`/api/notifications/${id}`, {
      method: 'DELETE'
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    removeNotificationFromState(id);
    renderNotificationsModalContent();
    
    // Отправляем через Socket.IO (если доступен)
    if (socket) {
      socket.emit('notifications:remove', { id });
    }
  } catch (error) {
    console.error('[Notifications Modal] Error removing notification:', error);
    await reportModalError('Ошибка удаления уведомления', error, { notificationId: id });
  }
}

function getNotificationAction(notificationId, actionId) {
  const notification = currentNotifications.find((item) => item.id === notificationId);
  if (!notification || !Array.isArray(notification.actions)) {
    return null;
  }
  return notification.actions.find((action) => action.id === actionId) || null;
}

async function executeNotificationAction(notificationId, actionId, buttonEl) {
  const action = getNotificationAction(notificationId, actionId);
  if (!action) {
    await reportModalError('Действие уведомления не найдено', new Error('Notification action not found'), {
      notificationId,
      actionId
    });
    return;
  }

  const method = String(action.method || 'POST').toUpperCase();
  const bodyAllowed = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  if (action.confirm && !window.confirm(action.confirm)) {
    return;
  }

  const requestInit = {
    method,
    headers: {
      'Content-Type': 'application/json'
    }
  };
  if (bodyAllowed && action.body && typeof action.body === 'object') {
    requestInit.body = JSON.stringify(action.body);
  }

  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.style.opacity = '0.7';
  }

  try {
    const response = await adminFetch(action.url, requestInit);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false || payload?.success === false) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }

    await showNotificationsModal(socket);
  } catch (error) {
    console.error('[Notifications Modal] Error executing notification action:', error);
    await reportModalError('Ошибка выполнения действия уведомления', error, {
      notificationId,
      actionId,
      method,
      url: action.url
    });
  } finally {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.style.opacity = '1';
    }
  }
}

/**
 * Отмечает все уведомления как прочитанные
 */
async function clearAllNotifications() {
  try {
    const ids = currentNotifications.map(n => n.id);
    
    // Отмечаем все параллельно
    const responses = await Promise.all(
      ids.map(id => 
        adminFetch(`/api/notifications/${id}/acknowledge`, {
          method: 'POST'
        })
      )
    );

    const failedResponse = responses.find((response) => !response.ok);
    if (failedResponse) {
      throw new Error(`HTTP ${failedResponse.status}`);
    }
    
    // Отправляем через Socket.IO
    if (socket) {
      ids.forEach(id => {
        socket.emit('notifications:acknowledge', { id });
      });
    }
    
    currentNotifications = [];
    renderNotificationsModalContent();
  } catch (error) {
    console.error('[Notifications Modal] Error clearing all notifications:', error);
    await reportModalError('Ошибка очистки уведомлений', error);
  }
}

/**
 * Получает цвет для уровня важности
 * @param {string} severity - Уровень важности
 * @returns {string} Цвет
 */
function getSeverityColor(severity) {
  switch (severity) {
    case 'critical': return '#ef4444';
    case 'warning': return '#f59e0b';
    case 'info': return '#3b82f6';
    default: return '#6b7280';
  }
}

/**
 * Получает иконку для уровня важности
 * @param {string} severity - Уровень важности
 * @returns {string} Иконка
 */
function getSeverityIcon(severity) {
  switch (severity) {
    case 'critical': return '🚨';
    case 'warning': return '⚠️';
    case 'info': return 'ℹ️';
    default: return '📢';
  }
}

/**
 * Форматирует время относительно текущего момента
 * @param {Date} date - Дата
 * @returns {string} Отформатированное время
 */
function formatTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  
  if (diffSec < 60) {
    return 'только что';
  } else if (diffMin < 60) {
    return `${diffMin} мин. назад`;
  } else if (diffHour < 24) {
    return `${diffHour} ч. назад`;
  } else if (diffDay < 7) {
    return `${diffDay} дн. назад`;
  } else {
    return date.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
}

/**
 * Экранирует HTML
 * @param {string} text - Текст
 * @returns {string} Экранированный текст
 */
function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// Добавляем стили для анимации
if (!document.getElementById('notifications-modal-styles')) {
  const style = document.createElement('style');
  style.id = 'notifications-modal-styles';
  style.textContent = `
    @keyframes fadeOut {
      from {
        opacity: 1;
        transform: scale(1);
      }
      to {
        opacity: 0;
        transform: scale(0.95);
      }
    }
  `;
  document.head.appendChild(style);
}

