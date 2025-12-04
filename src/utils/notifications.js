/**
 * Система уведомлений для критических проблем
 * @module utils/notifications
 */

import logger from './logger.js';

class NotificationsManager {
  constructor() {
    this.notifications = new Map(); // Map<id, notification>
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
  add(type, severity, title, message, details = {}) {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const notification = {
      id,
      type,           // 'disk_full', 'service_hanging', 'db_error', 'ffmpeg_error', etc.
      severity,       // 'critical', 'warning', 'info'
      title,
      message,
      details,
      timestamp: new Date().toISOString(),
      acknowledged: false
    };

    this.notifications.set(id, notification);
    
    // Ограничиваем количество уведомлений
    if (this.notifications.size > this.maxNotifications) {
      const sorted = Array.from(this.notifications.values())
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const oldest = sorted[0];
      this.notifications.delete(oldest.id);
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
    return this.notifications.delete(id);
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

