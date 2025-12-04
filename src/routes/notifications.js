/**
 * API для управления уведомлениями
 * @module routes/notifications
 */

import express from 'express';
import { notificationsManager } from '../utils/notifications.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import logger from '../utils/logger.js';

export function createNotificationsRouter() {
  const router = express.Router();

  // Получить все активные уведомления
  router.get('/', requireAuth, (req, res) => {
    try {
      const notifications = notificationsManager.getActive();
      res.json({ notifications, count: notifications.length });
    } catch (error) {
      logger.error('[Notifications API] Error getting notifications:', {
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: error.message });
    }
  });

  // Получить все уведомления (включая прочитанные)
  router.get('/all', requireAuth, (req, res) => {
    try {
      const notifications = notificationsManager.getAll();
      res.json({ notifications, count: notifications.length });
    } catch (error) {
      logger.error('[Notifications API] Error getting all notifications:', {
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: error.message });
    }
  });

  // ВАЖНО: Тестовый endpoint ДО динамических роутов (:id)
  // Тестовый endpoint для отправки тестового уведомления (только для админов)
  // requireAdmin возвращает массив [requireAuth, checkRole], поэтому используем spread
  router.post('/test', ...requireAdmin, (req, res) => {
    try {
      const { type = 'info', severity = 'info', title, message } = req.body;
      
      const testNotification = notificationsManager.add(
        `test_${type}`,
        severity || 'info',
        title || '🧪 Тестовое уведомление',
        message || 'Это тестовое уведомление для проверки системы. Вы можете удалить его.',
        {
          test: true,
          timestamp: new Date().toISOString(),
          user: req.user?.username || 'unknown'
        }
      );
      
      logger.info('[Notifications API] Test notification created', {
        notificationId: testNotification,
        user: req.user?.username
      });
      
      res.json({ 
        success: true, 
        notificationId: testNotification,
        message: 'Тестовое уведомление отправлено'
      });
    } catch (error) {
      logger.error('[Notifications API] Error creating test notification:', {
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: error.message });
    }
  });

  // Отметить уведомление как прочитанное
  router.post('/:id/acknowledge', requireAuth, (req, res) => {
    try {
      const { id } = req.params;
      const acknowledged = notificationsManager.acknowledge(id);
      if (acknowledged) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Уведомление не найдено' });
      }
    } catch (error) {
      logger.error('[Notifications API] Error acknowledging notification:', {
        error: error.message,
        stack: error.stack,
        id: req.params.id
      });
      res.status(500).json({ error: error.message });
    }
  });

  // Удалить уведомление
  router.delete('/:id', requireAuth, (req, res) => {
    try {
      const { id } = req.params;
      const deleted = notificationsManager.remove(id);
      if (deleted) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Уведомление не найдено' });
      }
    } catch (error) {
      logger.error('[Notifications API] Error deleting notification:', {
        error: error.message,
        stack: error.stack,
        id: req.params.id
      });
      res.status(500).json({ error: error.message });
    }
  });

  // Получить количество непрочитанных (для колокольчика)
  router.get('/unread-count', requireAuth, (req, res) => {
    try {
      const count = notificationsManager.getUnreadCount();
      res.json({ count });
    } catch (error) {
      logger.error('[Notifications API] Error getting unread count:', {
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

