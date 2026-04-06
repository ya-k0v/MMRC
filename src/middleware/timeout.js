/**
 * Timeout middleware for HTTP requests
 * @module middleware/timeout
 */

/**
 * Middleware для установки таймаута на HTTP запросы
 * @param {number} timeoutMs - Таймаут в миллисекундах (по умолчанию 30000)
 * @returns {Function} Express middleware
 */
export function requestTimeout(timeoutMs = 30000) {
  return (req, res, next) => {
    // Устанавливаем таймаут
    req.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        res.status(408).json({
          error: 'Request timeout',
          message: `Request exceeded ${timeoutMs}ms timeout`
        });
      }
    });

    // Устанавливаем таймаут для ответа
    res.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        res.status(408).json({
          error: 'Response timeout',
          message: `Response exceeded ${timeoutMs}ms timeout`
        });
      }
    });

    next();
  };
}

/**
 * Middleware для установки таймаута на длительные операции (upload, conversion)
 * @param {number} timeoutMs - Таймаут в миллисекундах (по умолчанию 300000 = 5 минут)
 * @returns {Function} Express middleware
 */
export function longOperationTimeout(timeoutMs = 300000) {
  return requestTimeout(timeoutMs);
}

