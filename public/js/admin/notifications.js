/**
 * Компонент уведомлений для админ-панели
 * @module admin/notifications
 */

import { adminFetch } from './auth.js';
import { showNotificationsModal } from './notifications-modal.js';

let unreadCount = 0;
let notificationsBell = null;
let socket = null;
let updateInterval = null;

/**
 * Инициализирует компонент уведомлений
 * @param {Socket} socketIO - Socket.IO instance
 */
export function initNotifications(socketIO) {
  socket = socketIO;
  
  // Создаем элемент колокольчика
  createBellElement();
  
  // Подписываемся на уведомления через Socket.IO
  subscribeToNotifications();
  
  // Загружаем начальное количество
  loadUnreadCount();
  
  // Обновляем каждые 30 секунд (fallback)
  updateInterval = setInterval(loadUnreadCount, 30000);
}

/**
 * Создает элемент колокольчика в toolbar
 */
function createBellElement() {
  const settingsBtn = document.getElementById('settingsBtn');
  if (!settingsBtn) {
    // Если кнопка настроек еще не загружена, ждем
    setTimeout(createBellElement, 100);
    return;
  }
  
  // Проверяем, не создан ли уже колокольчик
  if (document.getElementById('notificationsBell')) {
    return;
  }
  
  // Создаем колокольчик перед кнопкой настроек
  notificationsBell = document.createElement('button');
  notificationsBell.id = 'notificationsBell';
  notificationsBell.className = 'meta-lg';
  notificationsBell.setAttribute('aria-label', 'Уведомления');
  notificationsBell.style.cssText = `
    padding: 8px 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--text, inherit);
    transition: opacity 0.2s;
  `;
  
  notificationsBell.onmouseenter = () => {
    notificationsBell.style.opacity = '0.7';
  };
  notificationsBell.onmouseleave = () => {
    notificationsBell.style.opacity = '1';
  };
  
  notificationsBell.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
    </svg>
  `;
  
  // Бейдж с количеством
  const badge = document.createElement('span');
  badge.id = 'notificationsBadge';
  badge.style.cssText = `
    position: absolute;
    top: 4px;
    right: 4px;
    background: var(--error);
    color: var(--panel);
    border-radius: 10px;
    padding: 2px 6px;
    font-size: 11px;
    font-weight: bold;
    min-width: 18px;
    text-align: center;
    display: none;
    line-height: 1.2;
    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
  `;
  notificationsBell.appendChild(badge);
  
  // Клик открывает модальное окно
  notificationsBell.onclick = () => {
    showNotificationsModal(socket);
  };
  
  // Вставляем перед кнопкой настроек
  settingsBtn.parentNode.insertBefore(notificationsBell, settingsBtn);
}

/**
 * Подписывается на уведомления через Socket.IO
 */
function subscribeToNotifications() {
  if (!socket) return;
  
  // Подписываемся на уведомления (только для админов)
  socket.emit('notifications:subscribe', { 
    userRole: window.user?.role 
  });
  
  // Получаем начальные уведомления
  socket.on('notifications:initial', ({ notifications, unreadCount: count }) => {
    unreadCount = count;
    updateBadge();
  });
  
  // Новое уведомление
  socket.on('notification', ({ notification, unreadCount: count }) => {
    unreadCount = count;
    updateBadge();
    
    // Показываем всплывающее уведомление
    showToastNotification(notification);
  });
  
  // Уведомление прочитано
  socket.on('notification:acknowledged', ({ unreadCount: count }) => {
    unreadCount = count;
    updateBadge();
  });
  
  // Уведомление удалено
  socket.on('notification:removed', ({ unreadCount: count }) => {
    unreadCount = count;
    updateBadge();
  });
}

/**
 * Загружает количество непрочитанных уведомлений
 */
async function loadUnreadCount() {
  try {
    const response = await adminFetch('/api/notifications/unread-count');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    unreadCount = data.count || 0;
    updateBadge();
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
  
  if (unreadCount > 0) {
    badge.textContent = unreadCount > 99 ? '99+' : unreadCount.toString();
    badge.style.display = 'block';
    
    // Добавляем анимацию пульсации для критических уведомлений
    badge.style.animation = 'pulse 2s infinite';
  } else {
    badge.style.display = 'none';
    badge.style.animation = 'none';
  }
}

/**
 * Показывает всплывающее уведомление
 * @param {Object} notification - Уведомление
 */
function showToastNotification(notification) {
  // Создаем элемент уведомления
  const toast = document.createElement('div');
  toast.className = 'notification-toast';
  toast.setAttribute('data-notification-id', notification.id);
  
  const severityColor = getSeverityColor(notification.severity);
  
  toast.style.cssText = `
    position: fixed;
    top: 80px;
    right: 20px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-left: 4px solid ${severityColor};
    padding: 16px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 10000;
    max-width: 400px;
    min-width: 300px;
    animation: slideInRight 0.3s ease-out;
    cursor: pointer;
  `;
  
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
  
  // Клик на уведомление открывает модальное окно
  toast.onclick = (e) => {
    if (!e.target.closest('button')) {
      showNotificationsModal(socket);
      toast.remove();
    }
  };
  
  document.body.appendChild(toast);
  
  // Автоматически скрываем через 8 секунд
  setTimeout(() => {
    toast.style.animation = 'slideOutRight 0.3s ease-in';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.remove();
      }
    }, 300);
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

// Добавляем стили для анимации
if (!document.getElementById('notifications-styles')) {
  const style = document.createElement('style');
  style.id = 'notifications-styles';
  style.textContent = `
    @keyframes slideInRight {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
    
    @keyframes slideOutRight {
      from {
        transform: translateX(0);
        opacity: 1;
      }
      to {
        transform: translateX(100%);
        opacity: 0;
      }
    }
    
    @keyframes pulse {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.7;
      }
    }
  `;
  document.head.appendChild(style);
}

