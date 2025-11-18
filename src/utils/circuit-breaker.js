/**
 * Circuit Breaker pattern for external dependencies
 * @module utils/circuit-breaker
 */

/**
 * Circuit Breaker для защиты от каскадных сбоев
 */
export class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'CircuitBreaker';
    this.threshold = options.threshold || 5; // Количество ошибок до открытия
    this.timeout = options.timeout || 60000; // Время до попытки восстановления (мс)
    this.resetTimeout = options.resetTimeout || 30000; // Время до сброса счетчика (мс)
    
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttempt = null;
  }

  /**
   * Выполнить функцию через circuit breaker
   * @param {Function} fn - Функция для выполнения
   * @returns {Promise} Результат выполнения
   */
  async execute(fn) {
    // Проверяем состояние
    if (this.state === 'OPEN') {
      // Проверяем, можно ли попробовать восстановиться
      if (Date.now() >= this.nextAttempt) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN. Next attempt in ${Math.ceil((this.nextAttempt - Date.now()) / 1000)}s`);
      }
    }

    try {
      const result = await fn();
      
      // Успешное выполнение - сбрасываем счетчик
      if (this.state === 'HALF_OPEN') {
        this.state = 'CLOSED';
        this.failureCount = 0;
      } else if (this.failureCount > 0) {
        // Сбрасываем счетчик после успешного выполнения
        this.failureCount = 0;
      }
      
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Записать неудачу
   */
  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
    }
  }

  /**
   * Получить состояние
   * @returns {Object}
   */
  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      nextAttempt: this.nextAttempt ? new Date(this.nextAttempt) : null,
      timeUntilNextAttempt: this.nextAttempt ? Math.max(0, this.nextAttempt - Date.now()) : 0
    };
  }

  /**
   * Сбросить состояние
   */
  reset() {
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.state = 'CLOSED';
    this.nextAttempt = null;
  }
}

// Глобальные circuit breakers для разных компонентов
export const circuitBreakers = {
  database: new CircuitBreaker({ name: 'database', threshold: 5, timeout: 30000 }),
  fileSystem: new CircuitBreaker({ name: 'fileSystem', threshold: 10, timeout: 60000 }),
  externalAPI: new CircuitBreaker({ name: 'externalAPI', threshold: 5, timeout: 60000 })
};

