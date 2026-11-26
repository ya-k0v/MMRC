/**
 * Модальное окно уведомлений
 * @module admin/notifications-modal
 */

import { adminFetch } from './auth.js';
import {
  getCheckIcon,
  getCloseIcon,
  getBellOffIcon,
  getChevronLeftIcon,
  getChevronRightIcon
} from '../shared/svg-icons.js';
import { getSeverityInfo } from '../shared/severity.js';

let socket = null;
let currentNotifications = [];
let subscribedSocket = null;
let socketListenersBound = false;
let socketNotificationHandler = null;
let socketAcknowledgedHandler = null;
let socketAcknowledgedAllHandler = null;
let socketRemovedHandler = null;
let loadGeneration = 0;

const NOTIFICATIONS_MODAL_LIST_ID = 'notificationsModalList';
const NOTIFICATIONS_MODAL_FOOTER_ID = 'notificationsModalFooter';
const NOTIFICATIONS_PAGE_SIZE = 10;

let pagination = {
  page: 1,
  pageSize: NOTIFICATIONS_PAGE_SIZE,
  total: 0,
  totalPages: 1
};

function httpError(status, message) {
  const error = new Error(message || `HTTP ${status}`);
  error.status = status;
  return error;
}

function isRateLimitError(error) {
  return Number(error?.status) === 429 || /HTTP\s+429/.test(error?.message || '');
}

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

function renderPaginationFooter() {
  const footerEl = document.getElementById(NOTIFICATIONS_MODAL_FOOTER_ID);
  if (!footerEl) return;

  footerEl.style.display = pagination.total > 0 ? 'flex' : 'none';
  setElementHtml(footerEl, `
    <div class="notification-pagination" role="group" aria-label="Страницы уведомлений">
      <button
        id="notificationsPrevPage"
        class="notification-btn-icon"
        title="Предыдущая страница"
        aria-label="Предыдущая страница"
        ${pagination.page <= 1 ? 'disabled' : ''}
      >${getChevronLeftIcon(16)}</button>
      <span class="notification-pagination__label">
        ${pagination.page} / ${pagination.totalPages} (${pagination.total})
      </span>
      <button
        id="notificationsNextPage"
        class="notification-btn-icon"
        title="Следующая страница"
        aria-label="Следующая страница"
        ${pagination.page >= pagination.totalPages ? 'disabled' : ''}
      >${getChevronRightIcon(16)}</button>
    </div>
    <button id="notificationsClearAll" class="secondary meta">
      ${getCheckIcon(14)} Очистить все
    </button>
  `);
}

function renderNotificationsModalContent() {
  const listEl = document.getElementById(NOTIFICATIONS_MODAL_LIST_ID);
  if (!listEl) return;

  setElementHtml(listEl, buildNotificationsListHtml());
  renderPaginationFooter();
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
  if (socketAcknowledgedAllHandler) {
    subscribedSocket.off('notifications:acknowledged-all', socketAcknowledgedAllHandler);
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

  // Сокет-band события меняют состав списка, а значит и границы страниц.
  // Перезагружаем текущую страницу с сервера вместо «дописания» в локальный
  // массив: иначе после закрытия элемента страница может оказаться пустой.
  const reloadVisiblePage = async () => {
    await loadNotifications();
    if (isNotificationsMounted()) {
      renderNotificationsModalContent();
    }
  };

  socketNotificationHandler = () => { reloadVisiblePage(); };
  socketAcknowledgedHandler = () => { reloadVisiblePage(); };
  socketAcknowledgedAllHandler = () => { reloadVisiblePage(); };
  socketRemovedHandler = () => { reloadVisiblePage(); };

  socket.on('notification', socketNotificationHandler);
  socket.on('notification:acknowledged', socketAcknowledgedHandler);
  socket.on('notifications:acknowledged-all', socketAcknowledgedAllHandler);
  socket.on('notification:removed', socketRemovedHandler);

  subscribedSocket = socket;
  socketListenersBound = true;
}

async function reportModalError(title, error, details = {}) {
  // 429 уже означает перегрузку API. Отчет об ошибке создал бы ещё одно
  // уведомление и ещё один запрос — петлю усиления нагрузки.
  if (isRateLimitError(error)) {
    console.warn('[Notifications Modal] Rate limited, skip error report:', error);
    return;
  }

  const message = error?.message || String(error || 'Неизвестная ошибка');
  try {
    await adminFetch('/api/notifications/report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'admin_notifications_ui_error',
        key: 'admin_notifications_ui_error',
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

  container.innerHTML = `
    <div id="${NOTIFICATIONS_MODAL_LIST_ID}" class="notification-list">
      ${listHtml}
    </div>
    <div id="${NOTIFICATIONS_MODAL_FOOTER_ID}" class="notification-footer"></div>
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
 * Загружает текущую страницу уведомлений с сервера.
 * Старые ответы игнорируются: сокеты могут вызвать несколько перезагрузок
 * подряд, и гонка ответов не должна вернуть устаревшую страницу.
 */
async function loadNotifications() {
  const generation = ++loadGeneration;
  try {
    const params = new URLSearchParams({
      page: String(pagination.page),
      pageSize: String(pagination.pageSize)
    });
    const response = await adminFetch(`/api/notifications?${params.toString()}`);
    if (!response.ok) {
      throw httpError(response.status);
    }
    const data = await response.json();
    if (generation !== loadGeneration) return;

    const items = Array.isArray(data.notifications) ? data.notifications : [];
    const total = Number.isFinite(Number(data.total)) ? Number(data.total) : items.length;
    const pageSize = Number.isFinite(Number(data.pageSize))
      ? Number(data.pageSize)
      : pagination.pageSize;
    const totalPages = Math.max(1, Number.isFinite(Number(data.totalPages))
      ? Number(data.totalPages)
      : Math.ceil(total / pageSize));
    let page = Number.isFinite(Number(data.page)) ? Number(data.page) : pagination.page;

    // Уведомление могли закрыть на другой странице — не показываем пустоту.
    if (page > totalPages) {
      pagination = { page: totalPages, pageSize, total, totalPages };
      await loadNotifications();
      return;
    }

    pagination = { page, pageSize, total, totalPages };
    currentNotifications = sortNotifications(items);
  } catch (error) {
    if (generation !== loadGeneration) return;
    console.error('[Notifications Modal] Error loading notifications:', error);
    currentNotifications = [];
    pagination = { ...pagination, total: 0, totalPages: 1, page: 1 };
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
  const reportedBy = notification.details && typeof notification.details === 'object'
    ? notification.details.reportedBy
    : null;
  const author = reportedBy ? String(reportedBy) : '';

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

  // Единый образ: у уведомления либо его собственные действия, либо
  // универсальный «ОК» (отметить прочитанным). Раньше «ОК» рисовался всегда
  // и дублировал действие «Ок»/dismiss у уведомления об обновлении.
  const okHtml = actions.length === 0
    ? `
      <button
        class="notification-action-btn secondary meta notification-ok-btn"
        data-notification-id="${notification.id}"
        title="ОК — закрыть это уведомление"
      >
        ОК
      </button>
    `
    : '';

  return `
    <div class="notification-item is-${severity.key}" data-notification-id="${notification.id}" title="${escapeHtml(message ? `${title}: ${message}` : title)}">
      <span class="notification-item__icon" aria-hidden="true">${severity.icon}</span>
      <div class="notification-item__body">
        <div class="notification-item__head">
          <span class="notification-item__title">${escapeHtml(title)}</span>
          <span class="notification-item__severity">${escapeHtml(severity.label)}</span>
          ${author ? `<span class="notification-item__author">${escapeHtml(author)}</span>` : ''}
          <span class="notification-item__time">${timeAgo}</span>
        </div>
        ${message ? `<p class="notification-item__message">${escapeHtml(message)}</p>` : ''}
        <div class="notification-item__tools">
          ${actionsHtml}
          ${okHtml}
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

  // Кнопка «ОК» — закрывает конкретное уведомление (то же, что «прочитано»)
  document.querySelectorAll('.notification-ok-btn').forEach(btn => {
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

  // Кнопки действий (например, отмена задачи). Только кнопки с data-action-id:
// класс notification-action-btn используется также для стилизации кнопки
// «ОК» (она закрывает уведомление, а не выполняет действие на сервере).
  document.querySelectorAll('.notification-action-btn[data-action-id]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const notificationId = btn.getAttribute('data-notification-id');
      const actionId = btn.getAttribute('data-action-id');
      await executeNotificationAction(notificationId, actionId, btn);
    };
  });
  
  // Пагинация: одна страница за запрос, без N-запросов на очистку.
  const prevBtn = document.getElementById('notificationsPrevPage');
  if (prevBtn) {
    prevBtn.onclick = async () => {
      if (pagination.page <= 1) return;
      pagination.page -= 1;
      await loadNotifications();
      renderNotificationsModalContent();
    };
  }

  const nextBtn = document.getElementById('notificationsNextPage');
  if (nextBtn) {
    nextBtn.onclick = async () => {
      if (pagination.page >= pagination.totalPages) return;
      pagination.page += 1;
      await loadNotifications();
      renderNotificationsModalContent();
    };
  }

  // Кнопка "Очистить все"
  const clearAllBtn = document.getElementById('notificationsClearAll');
  if (clearAllBtn) {
    clearAllBtn.onclick = async () => {
      if (confirm('Отметить все уведомления как прочитанные?')) {
        await clearAllNotifications(clearAllBtn);
      }
    };
  }
}

/**
 * Отмечает уведомление как прочитанное
 * @param {string} id - ID уведомления
 */
export async function acknowledgeNotification(id) {
  try {
    const response = await adminFetch(`/api/notifications/${id}/acknowledge`, {
      method: 'POST'
    });

    if (!response.ok) {
      throw httpError(response.status);
    }

    removeNotificationFromState(id);
    pagination.total = Math.max(0, pagination.total - 1);
    pagination.totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));
    if (pagination.page > pagination.totalPages) pagination.page = pagination.totalPages;
    renderNotificationsModalContent();

    // Не шлём notifications:acknowledge вручную: менеджер уже рассылает
    // изменение через сокет. Лишний emit вёл к двойной записи в Redis.
  } catch (error) {
    console.error('[Notifications Modal] Error acknowledging notification:', error);
    await reportModalError('Ошибка подтверждения уведомления', error, { notificationId: id });
  }
}

/** Закрыть конкретное уведомление (например, кнопкой тоста). */
export async function closeNotification(id) {
  await acknowledgeNotification(id);
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
      throw httpError(response.status);
    }

    removeNotificationFromState(id);
    pagination.total = Math.max(0, pagination.total - 1);
    pagination.totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));
    if (pagination.page > pagination.totalPages) pagination.page = pagination.totalPages;
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
 * Закрывает все уведомления одним запросом.
 * Раньше здесь был Promise.all на N запросов — главная причина 429.
 */
async function clearAllNotifications(buttonEl) {
  if (buttonEl) buttonEl.disabled = true;
  let data = {};

  try {
    const response = await adminFetch('/api/notifications/acknowledge-all', {
      method: 'POST'
    });
    data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw httpError(response.status, data?.error);
    }

    currentNotifications = [];
    pagination = { page: 1, pageSize: pagination.pageSize, total: 0, totalPages: 1 };
    renderNotificationsModalContent();

    // Сервер сам рассылает acknowledged-all; повторный emit не нужен.
  } catch (error) {
    console.error('[Notifications Modal] Error clearing all notifications:', error);
    await reportModalError('Ошибка очистки уведомлений', error, {
      acknowledged: data?.acknowledged ?? null
    });
  } finally {
    if (buttonEl) buttonEl.disabled = false;
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

