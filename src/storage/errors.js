/**
 * Классификация ошибок хранилища для HTTP-ответов.
 *
 * Раньше любая ошибка S3 (включая NoSuchKey) превращалась в 500
 * «Error streaming file». Клиент не понимал, файла нет, нет прав или
 * хранилище временно недоступно, и не мог решить, повторять ли запрос.
 */

const NOT_FOUND_CODES = new Set(['NoSuchKey', 'NotFound', 'ENOENT']);
const FORBIDDEN_CODES = new Set(['AccessDenied', 'Forbidden', 'EACCES', 'EPERM']);
const UNAVAILABLE_CODES = new Set([
  'AbortError',
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'RequestAbortedError',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_FAIL'
]);

/**
 * @param {any} error
 * @returns {number} HTTP-статус: 404, 403, 503 или 500
 */
export function getStorageErrorStatus(error) {
  if (!error) return 500;

  const name = String(error.name || '');
  const code = String(error.Code || error.code || name || '');
  const httpStatus = Number(error.$metadata?.httpStatusCode || error.statusCode || error.status || 0);

  if (NOT_FOUND_CODES.has(name) || NOT_FOUND_CODES.has(code) || httpStatus === 404) {
    return 404;
  }

  if (FORBIDDEN_CODES.has(name) || FORBIDDEN_CODES.has(code) || httpStatus === 403) {
    return 403;
  }

  if (
    UNAVAILABLE_CODES.has(name) ||
    UNAVAILABLE_CODES.has(code) ||
    httpStatus === 408 ||
    httpStatus === 429 ||
    httpStatus >= 500
  ) {
    return 503;
  }

  return 500;
}

/**
 * Обрыв соединения клиентом — это не ошибка хранилища и не повод писать 500.
 */
export function isClientDisconnectError(error) {
  if (!error) return false;
  const code = String(error.code || error.name || '').toUpperCase();
  const message = String(error.message || '').toLowerCase();
  const statusCode = Number(error.statusCode || error.status || 0);
  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ECONNABORTED' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    statusCode === 499 ||
    message.includes('request aborted') ||
    message.includes('aborted') ||
    message.includes('premature close') ||
    message.includes('socket hang up') ||
    message.includes('write epipe')
  );
}

/**
 * Краткое описание ошибки без утечки внутренних деталей клиенту.
 * @param {number} status
 */
export function storageErrorBody(status) {
  if (status === 404) return { error: 'Файл не найден в хранилище' };
  if (status === 403) return { error: 'Доступ к файлу в хранилище запрещён' };
  if (status === 503) return { error: 'Хранилище временно недоступно, повторите попытку' };
  return { error: 'Ошибка чтения файла из хранилища' };
}
