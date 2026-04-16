/**
 * Система уведомлений для критических проблем
 * @module utils/notifications
 */

import logger from './logger.js';

class NotificationsManager {
  constructor() {
    this.notifications = new Map(); // Map<id, notification>
    this.notificationKeys = new Map(); // Map<key, id> для обновляемых уведомлений (job status)
    this.maxNotifications = 100;
    this.listeners = new Set();
  }

  /**
   * Добавить уведомление
   * @param {string} type - Тип уведомления ('disk_full', 'service_hanging', 'db_error', etc.)
   * @param {string} severity - Уровень важности ('critical', 'warning', 'info')
   * @param {string} title - Заголовок уведомления
   * @param {string} message - Сообщение
   * @param {Object} details - Дополнительные детали
   * @returns {string} ID уведомления
   */
  add(type, severity, title, message, details = {}, options = {}) {
    const nowIso = new Date().toISOString();
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const key = options.key ? String(options.key) : null;

    const actions = Array.isArray(options.actions)
      ? options.actions
          .map((action) => {
            if (!action || typeof action !== 'object') return null;
            const actionId = String(action.id || '').trim();
            const label = String(action.label || '').trim();
            const method = String(action.method || 'POST').toUpperCase();
            const url = String(action.url || '').trim();

            if (!actionId || !label || !url) return null;

            return {
              id: actionId,
              label,
              method,
              url,
              body: action.body && typeof action.body === 'object' ? action.body : null,
              confirm: action.confirm ? String(action.confirm) : null,
              variant: String(action.variant || 'secondary')
            };
          })
          .filter(Boolean)
      : [];

    const notification = {
      id,
      type,           // 'disk_full', 'service_hanging', 'db_error', 'ffmpeg_error', etc.
      severity,       // 'critical', 'warning', 'info'
      title,
      message,
      details,
      actions,
      key,
      source: String(options.source || 'system'),
      timestamp: nowIso,
      updatedAt: nowIso,
      acknowledged: false
    };

    this.notifications.set(id, notification);
    if (key) {
      this.notificationKeys.set(key, id);
    }
    
    // Ограничиваем количество уведомлений
    if (this.notifications.size > this.maxNotifications) {
      const sorted = Array.from(this.notifications.values())
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const oldest = sorted[0];
      if (oldest) {
        this.notifications.delete(oldest.id);
        if (oldest.key) {
          this.notificationKeys.delete(oldest.key);
        }
      }
    }

    logger.warn('[Notifications] New notification added', {
      id,
      type,
      severity,
      title,
      unreadCount: this.getUnreadCount()
    });

    // Уведомляем слушателей (Socket.IO)
    this.notifyListeners(notification);

    return id;
  }

  /**
   * Получить все активные уведомления
   * @returns {Array} Массив непрочитанных уведомлений
   */
  getActive() {
    return Array.from(this.notifications.values())
      .filter(n => !n.acknowledged)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  /**
   * Получить все уведомления (включая прочитанные)
   * @returns {Array} Массив всех уведомлений
   */
  getAll() {
    return Array.from(this.notifications.values())
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  /**
   * Получить уведомление по ID
   * @param {string} id
   * @returns {Object|null}
   */
  getById(id) {
    return this.notifications.get(id) || null;
  }

  /**
   * Получить уведомление по ключу
   * @param {string} key
   * @returns {Object|null}
   */
  getByKey(key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
      return null;
    }

    const notificationId = this.notificationKeys.get(normalizedKey);
    if (!notificationId) {
      return null;
    }

    return this.getById(notificationId);
  }

  /**
   * Обновить существующее уведомление
   * @param {string} id
   * @param {Object} patch
   * @param {string} action
   * @returns {Object|null}
   */
  update(id, patch = {}, action = 'updated') {
    const current = this.notifications.get(id);
    if (!current) return null;

    const next = {
      ...current,
      ...patch,
      details: patch.details !== undefined
        ? patch.details
        : current.details,
      actions: Array.isArray(patch.actions)
        ? patch.actions
        : current.actions,
      updatedAt: new Date().toISOString()
    };

    this.notifications.set(id, next);

    if (current.key && current.key !== next.key) {
      this.notificationKeys.delete(current.key);
    }
    if (next.key) {
      this.notificationKeys.set(next.key, id);
    }

    this.notifyListeners(next, action);
    return next;
  }

  /**
   * Создать или обновить уведомление по ключу
   * @param {Object} payload
   * @returns {string} ID уведомления
   */
  upsert(payload = {}) {
    const key = payload.key ? String(payload.key) : null;
    if (!key) {
      return this.add(
        payload.type || 'info',
        payload.severity || 'info',
        payload.title || 'Уведомление',
        payload.message || '',
        payload.details || {},
        {
          actions: payload.actions || [],
          source: payload.source || 'system'
        }
      );
    }

    const existingId = this.notificationKeys.get(key);
    if (existingId && this.notifications.has(existingId)) {
      const existing = this.notifications.get(existingId);
      this.update(existingId, {
        type: payload.type || existing.type,
        severity: payload.severity || existing.severity,
        title: payload.title || existing.title,
        message: payload.message || existing.message,
        details: payload.details !== undefined ? payload.details : existing.details,
        actions: payload.actions !== undefined ? payload.actions : existing.actions,
        source: payload.source || existing.source,
        key,
        acknowledged: false
      }, 'updated');
      return existingId;
    }

    return this.add(
      payload.type || 'info',
      payload.severity || 'info',
      payload.title || 'Уведомление',
      payload.message || '',
      payload.details || {},
      {
        key,
        actions: payload.actions || [],
        source: payload.source || 'system'
      }
    );
  }

  /**
   * Отметить уведомление как прочитанное
   * @param {string} id - ID уведомления
   * @returns {boolean} Успешно ли обновлено
   */
  acknowledge(id) {
    const notification = this.notifications.get(id);
    if (notification) {
      notification.acknowledged = true;
      this.notifyListeners(notification, 'acknowledged');
      return true;
    }
    return false;
  }

  /**
   * Удалить уведомление
   * @param {string} id - ID уведомления
   * @returns {boolean} Успешно ли удалено
   */
  remove(id) {
    const existing = this.notifications.get(id);
    if (existing?.key) {
      this.notificationKeys.delete(existing.key);
    }
    return this.notifications.delete(id);
  }

  /**
   * Удалить уведомление по ключу
   * @param {string} key
   * @returns {boolean} Успешно ли удалено
   */
  removeByKey(key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
      return false;
    }

    const notificationId = this.notificationKeys.get(normalizedKey);
    if (!notificationId) {
      return false;
    }

    this.notificationKeys.delete(normalizedKey);
    return this.notifications.delete(notificationId);
  }

  /**
   * Подписаться на уведомления (для Socket.IO)
   * @param {Function} listener - Функция-слушатель
   * @returns {Function} Функция для отписки
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Уведомить всех подписчиков
   * @param {Object} notification - Уведомление
   * @param {string} action - Действие ('new', 'acknowledged', 'removed')
   */
  notifyListeners(notification, action = 'new') {
    this.listeners.forEach(listener => {
      try {
        listener({ notification, action });
      } catch (err) {
        logger.error('[Notifications] Error notifying listener:', {
          error: err.message,
          stack: err.stack
        });
      }
    });
  }

  /**
   * Получить количество непрочитанных
   * @returns {number} Количество непрочитанных уведомлений
   */
  getUnreadCount() {
    return this.getActive().length;
  }
}

// Singleton
export const notificationsManager = new NotificationsManager();

// Вспомогательные функции для создания уведомлений

/**
 * Уведомление о переполнении диска
 */
export const notifyDiskFull = (details = {}) => {
  return notificationsManager.add(
    'disk_full',
    'critical',
    '🚨 Переполнение диска',
    'Обнаружена критическая ошибка переполнения диска. Выполнена экстренная очистка.',
    {
      ...details,
      action: 'Экстренная очистка файлов выполнена автоматически',
      recommendation: 'Проверьте использование диска и освободите место'
    }
  );
};

/**
 * Уведомление о зависании сервиса
 */
export const notifyServiceHanging = (service, details = {}) => {
  return notificationsManager.add(
    'service_hanging',
    'critical',
    '⚠️ Сервис завис',
    `Сервис ${service} не отвечает длительное время`,
    {
      service,
      ...details,
      recommendation: 'Перезапустите сервис или проверьте логи'
    }
  );
};

/**
 * Уведомление об ошибке базы данных
 */
export const notifyDbError = (details = {}) => {
  return notificationsManager.add(
    'db_error',
    'critical',
    '❌ Ошибка базы данных',
    'Обнаружена критическая ошибка базы данных',
    {
      ...details,
      recommendation: 'Проверьте состояние базы данных и логи'
    }
  );
};

/**
 * Уведомление об ошибке FFmpeg
 */
export const notifyFfmpegError = (details = {}) => {
  return notificationsManager.add(
    'ffmpeg_error',
    'warning',
    '⚠️ Ошибка FFmpeg',
    'Ошибка при обработке видео или стрима',
    {
      ...details,
      recommendation: 'Проверьте конфигурацию FFmpeg и исходный файл'
    }
  );
};

/**
 * Уведомление о критической ошибке
 */
export const notifyCriticalError = (details = {}) => {
  return notificationsManager.add(
    'critical_error',
    'critical',
    '💥 Критическая ошибка',
    'Обнаружена критическая ошибка, требующая внимания',
    {
      ...details,
      recommendation: 'Проверьте логи сервера для деталей'
    }
  );
};

/**
 * Уведомление о недоступности устройства
 */
export const notifyDeviceUnavailable = (deviceId, details = {}) => {
  return notificationsManager.add(
    'device_unavailable',
    'warning',
    '📱 Устройство недоступно',
    `Устройство ${deviceId} не отвечает`,
    {
      deviceId,
      ...details,
      recommendation: 'Проверьте подключение устройства к сети'
    }
  );
};

/**
 * Уведомление об ошибке обработки файла
 */
export const notifyFileProcessingError = (deviceId, fileName, details = {}) => {
  return notificationsManager.add(
    'file_processing_error',
    'warning',
    '📄 Ошибка обработки файла',
    `Не удалось обработать файл ${fileName}`,
    {
      deviceId,
      fileName,
      ...details,
      recommendation: 'Проверьте формат файла и попробуйте загрузить снова'
    }
  );
};

/**
 * Уведомление о высоком использовании диска
 */
export const notifyDiskUsageHigh = (usagePercent, details = {}) => {
  const severity = usagePercent >= 95 ? 'critical' : 'warning';
  const title = usagePercent >= 95 
    ? '🚨 Критически мало места на диске' 
    : '⚠️ Мало места на диске';
  const message = usagePercent >= 95
    ? `Диск заполнен на ${usagePercent.toFixed(1)}%. Требуется немедленное освобождение места.`
    : `Диск заполнен на ${usagePercent.toFixed(1)}%. Рекомендуется освободить место.`;
  
  return notificationsManager.add(
    'disk_usage_high',
    severity,
    title,
    message,
    {
      usagePercent,
      ...details,
      recommendation: 'Освободите место на диске, удалив неиспользуемые файлы'
    }
  );
};

/**
 * Уведомление о зависшем FFmpeg процессе
 */
export const notifyFfmpegProcessHung = (deviceId, safeName, details = {}) => {
  return notificationsManager.add(
    'ffmpeg_hung',
    'critical',
    '⚠️ FFmpeg процесс завис',
    `Процесс FFmpeg для стрима ${safeName} не отвечает длительное время`,
    {
      deviceId,
      safeName,
      ...details,
      recommendation: 'Перезапустите стрим или проверьте источник'
    }
  );
};

/**
 * Уведомление о недоступном источнике стрима
 */
export const notifyStreamSourceUnavailable = (deviceId, safeName, streamUrl, details = {}) => {
  return notificationsManager.add(
    'stream_source_unavailable',
    'warning',
    '📡 Источник стрима недоступен',
    `Источник стрима ${safeName} недоступен или не отвечает`,
    {
      deviceId,
      safeName,
      streamUrl,
      ...details,
      recommendation: 'Проверьте доступность источника стрима и URL'
    }
  );
};

/**
 * Уведомление о невозможности запуска стрима
 */
export const notifyStreamStartFailed = (deviceId, safeName, details = {}) => {
  return notificationsManager.add(
    'stream_start_failed',
    'critical',
    '❌ Не удалось запустить стрим',
    `Стрим ${safeName} не может быть запущен после всех попыток`,
    {
      deviceId,
      safeName,
      ...details,
      recommendation: 'Проверьте конфигурацию стрима, источник и логи'
    }
  );
};

/**
 * Уведомление о высоком использовании памяти
 */
export const notifyMemoryUsageHigh = (usagePercent, details = {}) => {
  return notificationsManager.add(
    'memory_usage_high',
    'warning',
    '💾 Высокое использование памяти',
    `Использование памяти: ${usagePercent.toFixed(1)}%`,
    {
      usagePercent,
      ...details,
      recommendation: 'Перезапустите сервис или проверьте на утечки памяти'
    }
  );
};

