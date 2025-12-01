/**
 * Управление статусами файлов (обработка видео)
 * @module video/file-status
 */

// Глобальное хранилище статусов файлов
// Map<deviceId_fileName, {status, progress, error, canPlay}>
const fileStatuses = new Map();

/**
 * Получить Map со статусами всех файлов
 * @returns {Map} fileStatuses
 */
export function getFileStatuses() {
  return fileStatuses;
}

/**
 * Установить статус файла
 * @param {string} deviceId - ID устройства
 * @param {string} fileName - Имя файла
 * @param {Object} status - Объект статуса {status, progress, canPlay, error}
 */
export function setFileStatus(deviceId, fileName, status) {
  const key = `${deviceId}_${fileName}`;
  fileStatuses.set(key, status);
}

/**
 * Получить статус файла
 * @param {string} deviceId - ID устройства
 * @param {string} fileName - Имя файла
 * @returns {Object|undefined} Статус файла
 */
export function getFileStatus(deviceId, fileName) {
  const key = `${deviceId}_${fileName}`;
  return fileStatuses.get(key);
}

/**
 * Удалить статус файла
 * @param {string} deviceId - ID устройства
 * @param {string} fileName - Имя файла
 */
export function deleteFileStatus(deviceId, fileName) {
  const key = `${deviceId}_${fileName}`;
  fileStatuses.delete(key);
}

/**
 * Очистить все статусы
 */
export function clearFileStatuses() {
  fileStatuses.clear();
}

