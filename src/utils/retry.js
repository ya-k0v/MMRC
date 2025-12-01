/**
 * Retry utility for database and external operations
 * @module utils/retry
 */

/**
 * Выполнить функцию с повторными попытками при ошибке
 * @param {Function} fn - Функция для выполнения
 * @param {Object} options - Опции retry
 * @param {number} options.maxRetries - Максимальное количество попыток (по умолчанию 3)
 * @param {number} options.delay - Задержка между попытками в мс (по умолчанию 1000)
 * @param {Function} options.shouldRetry - Функция для определения, нужно ли повторять (по умолчанию всегда true)
 * @param {Function} options.onRetry - Callback при повторной попытке
 * @returns {Promise} Результат выполнения функции
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    delay = 1000,
    shouldRetry = () => true,
    onRetry = null
  } = options;

  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Проверяем, нужно ли повторять
      if (!shouldRetry(error, attempt)) {
        throw error;
      }
      
      // Если это последняя попытка, выбрасываем ошибку
      if (attempt === maxRetries - 1) {
        throw error;
      }
      
      // Вызываем callback при повторной попытке
      if (onRetry) {
        onRetry(error, attempt + 1, maxRetries);
      }
      
      // Ждем перед следующей попыткой (exponential backoff)
      const waitTime = delay * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  
  throw lastError;
}

/**
 * Синхронная версия retry для синхронных операций (например, БД)
 * @param {Function} fn - Синхронная функция для выполнения
 * @param {Object} options - Опции retry
 * @returns {*} Результат выполнения функции
 */
export function withRetrySync(fn, options = {}) {
  const {
    maxRetries = 3,
    delay = 1000,
    shouldRetry = () => true,
    onRetry = null
  } = options;

  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      
      if (!shouldRetry(error, attempt)) {
        throw error;
      }
      
      if (attempt === maxRetries - 1) {
        throw error;
      }
      
      if (onRetry) {
        onRetry(error, attempt + 1, maxRetries);
      }
      
      // Для синхронных операций используем busy wait (не идеально, но работает)
      const start = Date.now();
      const waitTime = delay * Math.pow(2, attempt);
      while (Date.now() - start < waitTime) {
        // Busy wait
      }
    }
  }
  
  throw lastError;
}

/**
 * Проверка, является ли ошибка ошибкой БД, которую стоит повторять
 * @param {Error} error - Ошибка
 * @returns {boolean}
 */
export function isRetryableDatabaseError(error) {
  if (!error) return false;
  
  const errorMessage = error.message?.toLowerCase() || '';
  const errorCode = error.code?.toLowerCase() || '';
  
  // SQLite ошибки, которые можно повторить
  const retryableErrors = [
    'database is locked',
    'database locked',
    'busy',
    'sqlite_busy',
    'sqlite_locked',
    'timeout',
    'connection',
    'network',
    'temporary'
  ];
  
  return retryableErrors.some(retryable => 
    errorMessage.includes(retryable) || errorCode.includes(retryable)
  );
}

