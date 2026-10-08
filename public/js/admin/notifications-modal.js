/**
 * Модальное окно уведомлений
 * @module admin/notifications-modal
 */

import { adminFetch } from './auth.js';
import { getCheckIcon, getCloseIcon, getBellOffIcon } from '../shared/svg-icons.js';
import { getSeverityInfo } from '../shared/severity.js';

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

/**
 * Список уведомлений сейчас отрисован в DOM — либо в разделе, либо в
 * модальном окне. Раньше проверялось конкретно наличие overlay, из-за чего
 * при переносе уведомлений в обычный раздел перерисовка по сокету просто
 * перестала бы происходить. Проверяем сам контейнер — он общий для обоих
 * случаев, а раздел при уходе удаляется из DOM вместе с этим элементом.
 */
function isNotificationsMounted() {
  return Boolean(document.getElementById(NOTIFICATIONS_MODAL_LIST_ID));
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
    return `
      <div class="notification-list__empty">
        <span class="notification-list__empty-icon">${getBellOffIcon(40)}</span>
        <div>
          <div class="notification-list__empty-title">Все уведомления прочитаны</div>
          <div class="notification-list__empty-text">Новые события появятся здесь</div>
        </div>
      </div>
    `;
  }

  return currentNotifications.map(renderNotification).join('');
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

    if (isNotificationsMounted()) {
      renderNotificationsModalContent();
    }
  };

  socketAcknowledgedHandler = ({ id } = {}) => {
    if (!id) return;
    removeNotificationFromState(id);
    if (isNotificationsMounted()) {
      renderNotificationsModalContent();
    }
  };

  socketRemovedHandler = ({ id } = {}) => {
    if (!id) return;
    removeNotificationFromState(id);
    if (isNotificationsMounted()) {
      renderNotificationsModalContent();
    }
  };

  socket.on('notification', socketNotificationHandler);
  socket.on('notification:acknowledged', socketAcknowledgedHandler);
  socket.on('notification:removed', socketRemovedHandler);

  subscribedSocket = socket;
  socketListenersBound = true;
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
 * Отрисовывает уведомления в переданный контейнер — обычный раздел админки,
 * а не модальное окно. Отдельный экспорт нужен, потому что раздел создаётся
 * и уничтожается при навигации: после ухода контейнера отсоединён от DOM,
 * и перерисовывать в него уже нельзя.
 *
 * @param {HTMLElement} container
 * @param {Socket|null} socketIO
 */
export function mountNotificationsSection(container, socketIO = null) {
  if (!container) return;

  if (socketIO) {
    socket = socketIO;
  } else if (window.socket) {
    socket = window.socket;
  }

  const listHtml = buildNotificationsListHtml();
  const footerDisplay = currentNotifications.length > 0 ? 'flex' : 'none';

  container.innerHTML = `
    <div id="${NOTIFICATIONS_MODAL_LIST_ID}" class="notification-list">
      ${listHtml}
    </div>
    <div id="${NOTIFICATIONS_MODAL_FOOTER_ID}" class="notification-footer" style="display:${footerDisplay};">
      <button id="notificationsClearAll" class="secondary meta">${getCheckIcon(14)} Очистить все</button>
    </div>
  `;

  attachRealtimeSocketListeners();
  setupNotificationHandlers();

  loadNotifications().then(() => {
    // Пока грузили, пользователь мог уйти в другой раздел — тогда контейнер
    // уже вне DOM и перерисовывать нечего.
    if (!container.isConnected) return;
    renderNotificationsModalContent();
    setupNotificationHandlers();
  });
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
  const severity = getSeverityInfo(notification.severity);
  const timeAgo = formatTimeAgo(new Date(notification.timestamp));
  const actions = Array.isArray(notification.actions) ? notification.actions : [];
  const title = String(notification.title || 'Уведомление');
  const message = String(notification.message || '');

  const actionsHtml = actions.length > 0
    ? `
      <span class="notification-item__actions">
        ${actions.map((action) => `
          <button
            class="notification-action-btn secondary meta${action.variant === 'danger' ? ' danger' : ''}"
            data-notification-id="${notification.id}"
            data-action-id="${escapeHtml(action.id)}"
            title="${escapeHtml(action.label)}"
          >
            ${escapeHtml(action.label)}
          </button>
        `).join('')}
      </span>
    `
    : '';

  return `
    <div class="notification-item is-${severity.key}" data-notification-id="${notification.id}" title="${escapeHtml(message ? `${title}: ${message}` : title)}">
      <span class="notification-item__icon" aria-hidden="true">${severity.icon}</span>
      <div class="notification-item__body">
        <div class="notification-item__head">
          <span class="notification-item__title">${escapeHtml(title)}</span>
          <span class="notification-item__severity">${escapeHtml(severity.label)}</span>
          <span class="notification-item__time">${timeAgo}</span>
        </div>
        ${message ? `<p class="notification-item__message">${escapeHtml(message)}</p>` : ''}
        <div class="notification-item__tools">
          ${actionsHtml}
          <span class="notification-item__tools-actions">
            <button
              class="notification-btn-icon notification-btn-icon--ack notification-ack-btn"
              data-notification-id="${notification.id}"
              title="Отметить как прочитанное"
              aria-label="Отметить как прочитанное"
            >
              ${getCheckIcon(16)}
            </button>
            <button
              class="notification-btn-icon notification-btn-icon--remove notification-remove-btn"
              data-notification-id="${notification.id}"
              title="Удалить"
              aria-label="Удалить"
            >
              ${getCloseIcon(16)}
            </button>
          </span>
        </div>
      </div>
    </div>
  `;
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

    // После действия перерисовываем текущий контейнер, а не открываем
    // модальное окно: от модальных окон в проекте отказались.
    await loadNotifications();
    if (isNotificationsMounted()) {
      renderNotificationsModalContent();
      setupNotificationHandlers();
    }
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

// Модалка уведомлений не использует keyframes: анимация появления
// задаётся классом .modal (см. public/css/app.css).
// Раньше здесь инъектировался @keyframes fadeOut, к которому не обращался
// ни один элемент, — он мешал правилу prefers-reduced-motion, будучи
// вставлен в <head> после внешних таблиц.

