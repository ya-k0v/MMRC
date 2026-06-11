/**
 * Socket.IO обработчик для уведомлений
 * @module socket/notifications-handler
 */

import { notificationsManager } from '../utils/notifications.js';
import logger from '../utils/logger.js';

/**
 * Настраивает Socket.IO обработчики для уведомлений
 * @param {Server} io - Socket.IO сервер
 */
export function setupNotificationsHandler(io) {
  // Подписываемся на новые уведомления
  notificationsManager.subscribe(({ notification, action }) => {
    // Отправляем только админам
    const unreadCount = notificationsManager.getUnreadCount();
    
    io.to('admins').emit('notification', {
      notification,
      action,
      unreadCount
    });

    logger.debug('[Notifications Socket] Notification broadcasted to admins', {
      notificationId: notification.id,
      type: notification.type,
      severity: notification.severity,
      action,
      unreadCount
    });
  });

  // Обработчик подключения
  io.on('connection', (socket) => {
    // Подписка на уведомления (только для админов)
    socket.on('notifications:subscribe', ({ userRole }) => {
      if (userRole === 'admin' || userRole === 'hero_admin') {
        socket.join('admins');
        
        // Отправляем текущие активные уведомления
        const notifications = notificationsManager.getActive();
        const unreadCount = notificationsManager.getUnreadCount();
        
        socket.emit('notifications:initial', {
          notifications,
          unreadCount
        });

        logger.debug('[Notifications Socket] Admin subscribed to notifications', {
          socketId: socket.id,
          userRole,
          notificationsCount: notifications.length,
          unreadCount
        });
      }
    });

    // Отметить уведомление как прочитанное
    socket.on('notifications:acknowledge', ({ id }) => {
      const acknowledged = notificationsManager.acknowledge(id);
      if (acknowledged) {
        const unreadCount = notificationsManager.getUnreadCount();
        
        // Отправляем обновление всем админам
        io.to('admins').emit('notification:acknowledged', {
          id,
          unreadCount
        });

        logger.debug('[Notifications Socket] Notification acknowledged', {
          socketId: socket.id,
          notificationId: id,
          unreadCount
        });
      }
    });

    // Удалить уведомление
    socket.on('notifications:remove', ({ id }) => {
      const removed = notificationsManager.remove(id);
      if (removed) {
        const unreadCount = notificationsManager.getUnreadCount();
        
        // Отправляем обновление всем админам
        io.to('admins').emit('notification:removed', {
          id,
          unreadCount
        });

        logger.debug('[Notifications Socket] Notification removed', {
          socketId: socket.id,
          notificationId: id,
          unreadCount
        });
      }
    });

    // При отключении убираем из комнаты админов
    socket.on('disconnect', () => {
      socket.leave('admins');
    });
  });
}

