/**
 * Модальное окно уведомлений
 * @module admin/notifications-modal
 */

import { showModal, closeModal } from './modal.js';
import { adminFetch } from './auth.js';

let socket = null;
let currentNotifications = [];

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
  
  // Загружаем уведомления
  await loadNotifications();
  
  // Формируем HTML
  const notificationsHtml = currentNotifications.length > 0
    ? currentNotifications.map(renderNotification).join('')
    : '<div style="text-align:center; padding:40px; color:var(--text-secondary);">Нет активных уведомлений</div>';
  
  const content = `
    <div style="display:flex; flex-direction:column; gap:var(--space-md); max-height:70vh; overflow-y:auto;">
      ${notificationsHtml}
    </div>
    ${currentNotifications.length > 0 ? `
      <div style="margin-top:var(--space-md); padding-top:var(--space-md); border-top:1px solid var(--border); display:flex; gap:var(--space-sm); justify-content:flex-end;">
        <button id="notificationsClearAll" class="secondary" style="min-width:auto;">Очистить все</button>
      </div>
    ` : ''}
  `;
  
  showModal('🔔 Уведомления', content);
  
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
    currentNotifications = data.notifications || [];
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
    
    // Удаляем элемент из UI
    const item = document.querySelector(`[data-notification-id="${id}"]`);
    if (item) {
      item.style.opacity = '0.5';
      item.style.pointerEvents = 'none';
      setTimeout(() => {
        item.remove();
        // Если уведомлений не осталось, перезагружаем
        const remaining = document.querySelectorAll('.notification-item');
        if (remaining.length === 0) {
          showNotificationsModal();
        }
      }, 300);
    }
    
    // Отправляем через Socket.IO (если доступен)
    if (socket) {
      socket.emit('notifications:acknowledge', { id });
    }
  } catch (error) {
    console.error('[Notifications Modal] Error acknowledging notification:', error);
    alert('Не удалось отметить уведомление');
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
    
    // Удаляем элемент из UI
    const item = document.querySelector(`[data-notification-id="${id}"]`);
    if (item) {
      item.style.animation = 'fadeOut 0.3s ease-out';
      setTimeout(() => {
        item.remove();
        // Если уведомлений не осталось, перезагружаем
        const remaining = document.querySelectorAll('.notification-item');
        if (remaining.length === 0) {
          showNotificationsModal();
        }
      }, 300);
    }
    
    // Отправляем через Socket.IO (если доступен)
    if (socket) {
      socket.emit('notifications:remove', { id });
    }
  } catch (error) {
    console.error('[Notifications Modal] Error removing notification:', error);
    alert('Не удалось удалить уведомление');
  }
}

/**
 * Отмечает все уведомления как прочитанные
 */
async function clearAllNotifications() {
  try {
    const ids = currentNotifications.map(n => n.id);
    
    // Отмечаем все параллельно
    await Promise.all(
      ids.map(id => 
        adminFetch(`/api/notifications/${id}/acknowledge`, {
          method: 'POST'
        })
      )
    );
    
    // Отправляем через Socket.IO
    if (socket) {
      ids.forEach(id => {
        socket.emit('notifications:acknowledge', { id });
      });
    }
    
    // Перезагружаем модальное окно
    showNotificationsModal();
  } catch (error) {
    console.error('[Notifications Modal] Error clearing all notifications:', error);
    alert('Не удалось очистить все уведомления');
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

