/**
 * Управление Socket.IO соединениями
 * @module socket/connection-manager
 */
import logger from '../utils/logger.js';
import { timerRegistry } from '../utils/timer-registry.js';

// Глобальные хранилища соединений
const activeConnections = new Map(); // Map<socketId, deviceId>
const deviceSockets = new Map();     // Map<deviceId, Set<socketId>>

const CONNECTION_INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 минут
const CONNECTION_CLEANUP_INTERVAL = 2 * 60 * 1000;   // 2 минуты
let cleanupIntervalId = null;

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

/**
 * Получить статистику соединений
 * @returns {Object}
 */
export function getConnectionStats() {
  return {
    totalConnections: activeConnections.size,
    trackedDevices: deviceSockets.size,
    devices: Array.from(deviceSockets.entries()).map(([deviceId, sockets]) => ({
      deviceId,
      connectionCount: sockets.size
    }))
  };
}

/**
 * Очистить неактивные соединения
 * @param {Server} io - Socket.IO сервер
 * @returns {number} Количество очищенных соединений
 */
export function cleanupInactiveConnections(io) {
  if (!io?.sockets?.sockets) {
    return 0;
  }

  const now = Date.now();
  let cleaned = 0;

  for (const [socketId, deviceId] of activeConnections.entries()) {
    const socket = io.sockets.sockets.get(socketId);
    const lastPing = socket?.data?.lastPing;
    const isConnected = socket?.connected;

    const inactiveByPing =
      typeof lastPing === 'number' &&
      now - lastPing > CONNECTION_INACTIVITY_TIMEOUT;

    if (!socket || !isConnected || inactiveByPing) {
      activeConnections.delete(socketId);

      const socketsSet = deviceSockets.get(deviceId);
      if (socketsSet) {
        socketsSet.delete(socketId);
        if (socketsSet.size === 0) {
          deviceSockets.delete(deviceId);
          io.emit?.('player/offline', { device_id: deviceId });
        }
      }

      if (socket && socket.connected) {
        socket.disconnect(true);
      }

      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.warn('[ConnectionManager] Cleaned inactive connections', {
      cleaned,
      totalConnections: activeConnections.size
    });
  }

  return cleaned;
}

/**
 * Запускает периодическую очистку неактивных Socket.IO соединений
 * @param {Server} io - Socket.IO сервер
 */
export function startConnectionCleanup(io) {
  if (cleanupIntervalId) {
    return;
  }

  cleanupIntervalId = timerRegistry.setInterval(
    () => cleanupInactiveConnections(io),
    CONNECTION_CLEANUP_INTERVAL,
    'socket_connection_cleanup'
  );

  logger.info('[ConnectionManager] Connection cleanup job started', {
    intervalMs: CONNECTION_CLEANUP_INTERVAL,
    inactivityTimeoutMs: CONNECTION_INACTIVITY_TIMEOUT
  });
}

/**
 * Останавливает периодическую очистку соединений
 */
export function stopConnectionCleanup() {
  if (cleanupIntervalId) {
    timerRegistry.clear(cleanupIntervalId);
    cleanupIntervalId = null;
    logger.info('[ConnectionManager] Connection cleanup job stopped');
  }
}

