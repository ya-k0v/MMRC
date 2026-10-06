/**
 * Компонент уведомлений для админ-панели
 * @module admin/notifications
 */

import { adminFetch } from './auth.js';

let unreadCount = 0;
let socket = null;
let updateInterval = null;

/**
 * Инициализирует компонент уведомлений
 * @param {Socket} socketIO - Socket.IO instance
 */
export function initNotifications(socketIO) {
  socket = socketIO;

  // Пункт в сайдбаре и переход в раздел уведомлений
  mountBadgeIntoSidebar();
  document.addEventListener('mmrc:sidebar-rendered', mountBadgeIntoSidebar);

  // Подписываемся на уведомления через Socket.IO
  subscribeToNotifications();

  // Загружаем начальное количество
  loadUnreadCount();

  // Обновляем каждые 30 секунд (fallback)
  updateInterval = setInterval(loadUnreadCount, 30000);
}

let attempts = 0;

/**
 * Встраивает счётчик в пункт «Уведомления» левого бара.
 *
 * Раньше колокольчик вставлялся в шапку рядом с кнопкой настроек. Но
 * навигация админки переехала в сайдбар и кнопки шапки скрываются, поэтому
 * колокольчик остался в мёртвой зоне шапки и пропал из интерфейса.
 *
 * Пункт сайдбара рендерится асинхронно (init ждёт /api/admin/modules), так
 * что ищем его с повтором, а не один раз.
 */
function mountBadgeIntoSidebar() {
  const item = document.querySelector('#adminSidebar .sidebar-item[data-section="notifications"]');
  if (!item) {
    attempts += 1;
    if (attempts < 50) {
      setTimeout(mountBadgeIntoSidebar, 100);
    } else {
      console.warn('[Notifications] Пункт «Уведомления» в сайдбаре не найден, счётчик не показан');
    }
    return;
  }
  attempts = 0;

  // render() сайдбара пересобирает разметку, поэтому бейдж создаём заново,
  // если его ещё нет в этом пункте.
  if (!item.querySelector('#notificationsBadge')) {
    const badge = document.createElement('span');
    badge.id = 'notificationsBadge';
    badge.className = 'sidebar-item-badge';
    item.appendChild(badge);
  }

  item.setAttribute('aria-label', 'Уведомления');
  updateBadge();
}

/**
 * Переходит в раздел «Уведомления».
 *
 * Раньше здесь открывалось модальное окно. От модальных окон отказались,
 * поэтому уведомления стали обычным пунктом навигации — как «Устройства»,
 * «Пользователи» или «Логи». Раздел принимает переход через событие,
 * чтобы не тянуть сюда ссылку на экземпляр сайдбара.
 */
function openNotificationsSection() {
  document.dispatchEvent(new CustomEvent('mmrc:navigate', {
    detail: { section: 'notifications' }
  }));
}

/**
 * Подписывается на уведомления через Socket.IO
 */
function subscribeToNotifications() {
  if (!socket) return;
  
  // Подписываемся на уведомления (только для админов)
  socket.emit('notifications:subscribe');
  
  // Получаем начальные уведомления
  socket.on('notifications:initial', ({ notifications, unreadCount: count }) => {
    applyCount(count);
  });
  
  // Новое уведомление
  socket.on('notification', ({ notification, action, unreadCount: count }) => {
    applyCount(count);
    
    // Для обновлений (progress/status) не дублируем всплывающие тосты
    if (!action || action === 'new') {
      showToastNotification(notification);
    }
  });
  
  // Уведомление прочитано
  socket.on('notification:acknowledged', ({ unreadCount: count }) => {
    applyCount(count);
  });
  
  // Уведомление удалено
  socket.on('notification:removed', ({ unreadCount: count }) => {
    applyCount(count);
  });
}

// Счётчик приходит двумя путями: сокетом и HTTP-опросом раз в 30 секунд.
// Ревизия растёт при каждом применении значения и нужна, чтобы опрос не
// затирал более свежие данные сокета. Сравнение по времени не годится:
// события часто приходят в пределах одной миллисекунды.
let countRevision = 0;

/**
 * Единственная точка обновления счётчика
 */
function applyCount(count) {
  unreadCount = count || 0;
  countRevision += 1;
  updateBadge();
}

/**
 * Загружает количество непрочитанных уведомлений
 */
async function loadUnreadCount() {
  // Ревизия на момент старта запроса. Если пока шёл запрос, сокет принёс
  // новое значение, ответ HTTP устарел и применять его нельзя. Без этой
  // проверки счётчик сбрасывался на 0 сразу после события сокета.
  const revisionAtStart = countRevision;
  try {
    const response = await adminFetch('/api/notifications/unread-count');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    if (countRevision !== revisionAtStart) return;
    applyCount(data.count);
  } catch (error) {
    console.error('[Notifications] Error loading unread count:', error);
  }
}

/**
 * Обновляет бейдж с количеством непрочитанных
 */
function updateBadge() {
  const badge = document.getElementById('notificationsBadge');
  if (!badge) return;

  // Видимостью управляет класс has-badge на пункте сайдбара: инлайновый
  // display перебивал бы правила для свёрнутого сайдбара.
  const item = badge.closest('.sidebar-item');
  if (item) {
    item.classList.toggle('has-badge', unreadCount > 0);
  }

  if (unreadCount > 0) {
    badge.textContent = unreadCount > 99 ? '99+' : unreadCount.toString();
  } else {
    badge.textContent = '';
  }
}

/**
 * Показывает всплывающее уведомление
 * @param {Object} notification - Уведомление
 */

// Должно совпадать с .notification-toast--out в public/css/app.css.
// Используется только как страховка; основной путь — animationend.
const TOAST_EXIT_MS = 200;

function showToastNotification(notification) {
  // Создаем элемент уведомления
  const toast = document.createElement('div');
  toast.className = 'notification-toast';
  toast.setAttribute('data-notification-id', notification.id);
  
  const severityColor = getSeverityColor(notification.severity);

  // Статичные стили — в .notification-toast (public/css/app.css).
  // Инлайн остаётся только динамический цвет серьёзности.
  toast.style.borderLeftColor = severityColor;
  
  const timeAgo = formatTimeAgo(new Date(notification.timestamp));
  
  // Используем DOM методы вместо innerHTML для безопасности
  const container = document.createElement('div');
  container.style.cssText = 'display: flex; align-items: start; gap: 12px;';
  
  const contentDiv = document.createElement('div');
  contentDiv.style.cssText = 'flex: 1; min-width: 0;';
  
  const titleDiv = document.createElement('div');
  titleDiv.style.cssText = 'font-weight: bold; margin-bottom: 4px; color: var(--text);';
  titleDiv.textContent = notification.title || '';
  
  const messageDiv = document.createElement('div');
  messageDiv.style.cssText = 'color: var(--text-secondary); font-size: 14px; margin-bottom: 8px;';
  messageDiv.textContent = notification.message || '';
  
  const timeDiv = document.createElement('div');
  timeDiv.style.cssText = 'font-size: 12px; color: var(--muted);';
  timeDiv.textContent = timeAgo;
  
  contentDiv.appendChild(titleDiv);
  contentDiv.appendChild(messageDiv);
  contentDiv.appendChild(timeDiv);
  
  const closeButton = document.createElement('button');
  closeButton.style.cssText = `
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 4px;
    color: var(--muted);
    font-size: 18px;
    line-height: 1;
  `;
  closeButton.textContent = '×';
  closeButton.onclick = () => toast.remove();
  
  container.appendChild(contentDiv);
  container.appendChild(closeButton);
  toast.appendChild(container);
  
  // Клик по уведомлению открывает раздел уведомлений
  toast.onclick = (e) => {
    if (!e.target.closest('button')) {
      openNotificationsSection();
      toast.remove();
    }
  };
  
  document.body.appendChild(toast);

  // Автоматически скрываем через 8 секунд.
  // Убираем по animationend, а не по зашитой константе: так таймер не
  // расходится с длительностью в CSS. Страховка на случай, если анимация
  // отключена и animationend не придёт.
  setTimeout(() => {
    toast.classList.add('notification-toast--out');
    const fallback = setTimeout(() => toast.remove(), TOAST_EXIT_MS + 100);
    toast.addEventListener('animationend', () => {
      clearTimeout(fallback);
      toast.remove();
    }, { once: true });
  }, 8000);
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
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Стили тостов (@keyframes slideInRight/slideOutRight и .notification-toast)
// живут в public/css/app.css, а не здесь: правило prefers-reduced-motion
// должно иметь возможность их перекрыть, а инъекция в <head> всегда идёт
// после внешних таблиц и выиграла бы у них по порядку.

export { showToastNotification };

