/**
 * Централизованный реестр таймаутов и интервалов
 * Гарантирует очистку всех таймеров при shutdown или ошибках
 * @module utils/timer-registry
 */

import logger from './logger.js';

class TimerRegistry {
  constructor() {
    this.timers = new Map(); // Map<id, {type: 'timeout'|'interval', timer: NodeJS.Timeout, description: string}>
    this.nextId = 1;
    this.isShuttingDown = false;
  }

  /**
   * Регистрирует таймаут
   * @param {Function} callback - Функция для выполнения
   * @param {number} delay - Задержка в миллисекундах
   * @param {string} description - Описание таймера (для логирования)
   * @returns {NodeJS.Timeout} Таймаут
   */
  setTimeout(callback, delay, description = 'unnamed') {
    if (this.isShuttingDown) {
      logger.warn('[TimerRegistry] Ignoring setTimeout during shutdown', { description });
      return null;
    }

    const id = this.nextId++;
    // КРИТИЧНО: Используем глобальный setTimeout, а не this.setTimeout
    const timer = globalThis.setTimeout(() => {
      this.timers.delete(id);
      try {
        callback();
      } catch (err) {
        logger.error('[TimerRegistry] Error in timeout callback', {
          description,
          error: err.message,
          stack: err.stack
        });
      }
    }, delay);

    this.timers.set(id, {
      type: 'timeout',
      timer,
      description,
      createdAt: Date.now()
    });

    logger.debug('[TimerRegistry] Timeout registered', { id, description, delay });
    return timer;
  }

  /**
   * Регистрирует интервал
   * @param {Function} callback - Функция для выполнения
   * @param {number} delay - Интервал в миллисекундах
   * @param {string} description - Описание интервала (для логирования)
   * @returns {NodeJS.Timeout} Интервал
   */
  setInterval(callback, delay, description = 'unnamed') {
    if (this.isShuttingDown) {
      logger.warn('[TimerRegistry] Ignoring setInterval during shutdown', { description });
      return null;
    }

    const id = this.nextId++;
    // КРИТИЧНО: Используем глобальный setInterval, а не this.setInterval
    const timer = globalThis.setInterval(() => {
      try {
        callback();
      } catch (err) {
        logger.error('[TimerRegistry] Error in interval callback', {
          description,
          error: err.message,
          stack: err.stack
        });
      }
    }, delay);

    this.timers.set(id, {
      type: 'interval',
      timer,
      description,
      createdAt: Date.now()
    });

    logger.debug('[TimerRegistry] Interval registered', { id, description, delay });
    return timer;
  }

  /**
   * Отменяет таймаут или интервал
   * @param {NodeJS.Timeout} timer - Таймер для отмены
   * @returns {boolean} Успешно ли отменен
   */
  clear(timer) {
    if (!timer) return false;

    for (const [id, entry] of this.timers.entries()) {
      if (entry.timer === timer) {
        if (entry.type === 'timeout') {
          globalThis.clearTimeout(timer);
        } else {
          globalThis.clearInterval(timer);
        }
        this.timers.delete(id);
        logger.debug('[TimerRegistry] Timer cleared', { id, description: entry.description });
        return true;
      }
    }

    // Если не найден в реестре, все равно пытаемся очистить
    globalThis.clearTimeout(timer);
    globalThis.clearInterval(timer);
    return false;
  }

  /**
   * Очищает все таймеры
   * @param {string} reason - Причина очистки
   */
  clearAll(reason = 'shutdown') {
    logger.info('[TimerRegistry] Clearing all timers', {
      count: this.timers.size,
      reason
    });

    const timers = Array.from(this.timers.values());
    for (const entry of timers) {
      try {
        if (entry.type === 'timeout') {
          globalThis.clearTimeout(entry.timer);
        } else {
          globalThis.clearInterval(entry.timer);
        }
        logger.debug('[TimerRegistry] Timer cleared', {
          description: entry.description,
          type: entry.type,
          age: Date.now() - entry.createdAt
        });
      } catch (err) {
        logger.error('[TimerRegistry] Error clearing timer', {
          description: entry.description,
          error: err.message
        });
      }
    }

    this.timers.clear();
    this.isShuttingDown = true;
  }

  /**
   * Получить статистику таймеров
   * @returns {Object} Статистика
   */
  getStats() {
    const stats = {
      total: this.timers.size,
      timeouts: 0,
      intervals: 0,
      descriptions: {}
    };

    for (const entry of this.timers.values()) {
      if (entry.type === 'timeout') {
        stats.timeouts++;
      } else {
        stats.intervals++;
      }

      const desc = entry.description;
      stats.descriptions[desc] = (stats.descriptions[desc] || 0) + 1;
    }

    return stats;
  }

  /**
   * Получить список активных таймеров
   * @returns {Array} Список таймеров
   */
  getActiveTimers() {
    return Array.from(this.timers.values()).map(entry => ({
      type: entry.type,
      description: entry.description,
      age: Date.now() - entry.createdAt
    }));
  }
}

// Singleton
export const timerRegistry = new TimerRegistry();

// ВАЖНО: Не экспортируем обертки для глобальных функций, чтобы избежать циклической рекурсии
// Используйте timerRegistry.setTimeout/setInterval напрямую

