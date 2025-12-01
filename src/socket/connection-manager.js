/**
 * Управление Socket.IO соединениями
 * @module socket/connection-manager
 */

// Глобальные хранилища соединений
const activeConnections = new Map(); // Map<socketId, deviceId>
const deviceSockets = new Map();     // Map<deviceId, Set<socketId>>

/**
 * Получить Map активных соединений
 * @returns {Map} activeConnections
 */
export function getActiveConnections() {
  return activeConnections;
}

/**
 * Получить Map соединений устройств
 * @returns {Map} deviceSockets
 */
export function getDeviceSockets() {
  return deviceSockets;
}

/**
 * Проверить онлайн ли устройство
 * @param {string} device_id - ID устройства
 * @returns {boolean} true если устройство онлайн
 */
export function updateDeviceStatus(device_id) {
  const sockets = deviceSockets.get(device_id);
  return sockets && sockets.size > 0;
}

/**
 * Получить список онлайн устройств
 * @returns {string[]} Массив ID онлайн устройств
 */
export function getOnlineDevices() {
  const onlineSet = new Set();
  for (const device_id of deviceSockets.keys()) {
    if (deviceSockets.get(device_id) && deviceSockets.get(device_id).size > 0) {
      onlineSet.add(device_id);
    }
  }
  return Array.from(onlineSet);
}

