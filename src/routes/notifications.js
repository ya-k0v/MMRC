/**
 * API для управления уведомлениями
 * @module routes/notifications
 */

import express from 'express';
import { notificationsManager } from '../utils/notifications.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('api');

export function createNotificationsRouter() {
  const router = express.Router();

  function sanitizeSeverity(rawSeverity) {
    const severity = String(rawSeverity || 'info').toLowerCase();
    if (['critical', 'warning', 'info'].includes(severity)) {
      return severity;
    }
    return 'info';
  }

  function sanitizeString(value, maxLen = 300) {
    return String(value || '').trim().slice(0, maxLen);
  }

  /** Параметры страницы: злонамеренные значения не должны ломать ответ. */
  function parsePagination(query) {
    const rawPage = Math.floor(Number(query?.page));
    const rawSize = Math.floor(Number(query?.pageSize));
    return {
      page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
      pageSize: Number.isFinite(rawSize) && rawSize > 0 ? Math.min(rawSize, 100) : 20
    };
  }

  function sendPage(res, result) {
    res.json({
      notifications: result.items,
      count: result.items.length,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages
    });
  }

  // Получить страницу активных уведомлений
  router.get('/', requireAuth, (req, res) => {
    try {
      const { page, pageSize } = parsePagination(req.query);
      sendPage(res, notificationsManager.getPage({ page, pageSize }));
    } catch (error) {
      logger.error('[Notifications API] Error getting notifications:', {
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: error.message });
    }
  });

  // Получить страницу всех уведомлений (включая прочитанные)
  router.get('/all', requireAuth, (req, res) => {
    try {
      const { page, pageSize } = parsePagination(req.query);
      sendPage(res, notificationsManager.getPage({ page, pageSize, includeAcknowledged: true }));
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
        title || 'Тестовое уведомление',
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

  // Добавить или обновить уведомление из UI/джоб
  router.post('/report', requireAuth, (req, res) => {
    try {
      const payload = req.body || {};
      const notificationType = sanitizeString(payload.type || 'ui_event', 80) || 'ui_event';
      const severity = sanitizeSeverity(payload.severity);
      const title = sanitizeString(payload.title || 'Уведомление', 160) || 'Уведомление';
      const message = sanitizeString(payload.message || '', 1000);
      const key = sanitizeString(payload.key || '', 180) || null;
      const source = sanitizeString(payload.source || 'admin-ui', 80) || 'admin-ui';
      const details = payload.details && typeof payload.details === 'object' && !Array.isArray(payload.details)
        ? payload.details
        : {};
      const actions = Array.isArray(payload.actions) ? payload.actions : [];

      const id = notificationsManager.upsert({
        type: notificationType,
        severity,
        title,
        message,
        key,
        source,
        details: {
          ...details,
          reportedBy: req.user?.username || 'unknown',
          reportedAt: new Date().toISOString()
        },
        actions
      });

      const notification = notificationsManager.getById(id);
      res.json({ ok: true, id, notification });
    } catch (error) {
      logger.error('[Notifications API] Error reporting notification:', {
        error: error.message,
        stack: error.stack,
        user: req.user?.username
      });
      res.status(500).json({ error: error.message });
    }
  });

  // Закрыть все уведомления одним запросом (без N POST и 429 от лимитера)
  router.post('/acknowledge-all', requireAuth, (req, res) => {
    try {
      const acknowledged = notificationsManager.acknowledgeAll();
      res.json({ success: true, acknowledged });
    } catch (error) {
      logger.error('[Notifications API] Error acknowledging all notifications:', {
        error: error.message,
        stack: error.stack,
        user: req.user?.username
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

