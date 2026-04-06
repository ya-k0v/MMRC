/**
 * Утилиты для валидации и фильтрации данных
 * @module utils/sanitize
 */

/**
 * Валидация и очистка ID устройства
 * @param {any} id - ID устройства
 * @returns {string|null} Валидный ID или null
 */
export function sanitizeDeviceId(id) {
  if (!id) return null;
  if (typeof id !== 'string') return null;
  const match = id.match(/^[A-Za-z0-9_-]+$/);
  return match ? id : null;
}

/**
 * Проверка является ли файл системным/временным (не показывать пользователям)
 * @param {string} fileName - Имя файла
 * @returns {boolean} true если файл системный
 */
export function isSystemFile(fileName) {
  // Исключаем:
  // - default.* (заглушки)
  // - .optimizing_* (временные файлы оптимизации)
  // - .tmp_default_* (временные файлы при смене заглушки)
  // - .original_* (оригинальные файлы до оптимизации)
  // - любые файлы начинающиеся с точки
  return (
    /^default\.(mp4|webm|ogg|mkv|mov|avi|mp3|wav|m4a|png|jpg|jpeg|gif|webp|pdf|pptx)$/i.test(fileName) ||
    /^\.optimizing_/i.test(fileName) ||
    /^\.tmp_default_/i.test(fileName) ||
    /^\.original_/i.test(fileName) ||
    fileName.startsWith('.')
  );
}

