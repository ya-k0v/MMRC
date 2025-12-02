/**
 * Главный модуль Socket.IO обработчиков
 * @module socket/index
 */

import { getOnlineDevices } from './connection-manager.js';
import { setupDeviceHandlers, handleDisconnect } from './device-handlers.js';
import { setupControlHandlers } from './control-handlers.js';
import logger from '../utils/logger.js';

/**
 * Настраивает все Socket.IO обработчики
 * @param {Server} io - Socket.IO сервер
 * @param {Object} deps - Зависимости {devices, getPageSlideCount}
 */
export function setupSocketHandlers(io, deps) {
  const { 
    devices, 
    getPageSlideCount,
    deviceVolumeState,
    getVolumeState,
    persistVolumeState,
    applyVolumeCommand
  } = deps;
  
  io.on('connection', socket => {
    const transport = socket.conn?.transport?.name;
    logger.debug(`[Socket.IO] 🔌 connection id=${socket.id}`, { socketId: socket.id, transport });

    // Логирование transport events
    if (socket.conn) {
      socket.conn.on('upgrade', () => {
        logger.debug(`[Socket.IO] 🚀 transport upgraded for ${socket.id}`, { socketId: socket.id, newTransport: socket.conn.transport.name });
      });
      
      socket.conn.on('close', (reason) => {
        logger.warn(`[Socket.IO] 🔌 connection closed id=${socket.id}`, { socketId: socket.id, reason });
      });
    }

    // Отправляем snapshot онлайн устройств при подключении
    try {
      const snapshot = getOnlineDevices();
      socket.emit('players/onlineSnapshot', snapshot);
    } catch (e) {
      logger.error(`[Socket.IO] ❌ Ошибка отправки snapshot`, { error: e.message, stack: e.stack, socketId: socket.id });
    }

    if (deviceVolumeState) {
      try {
        const volumeSnapshot = {};
        for (const [deviceId, state] of Object.entries(deviceVolumeState)) {
          volumeSnapshot[deviceId] = {
            level: state.level,
            muted: state.muted,
            updated_at: state.updatedAt
          };
        }
        socket.emit('devices/volume/stateBatch', volumeSnapshot);
      } catch (e) {
        logger.error(`[Socket.IO] ❌ Ошибка отправки volume snapshot`, { error: e.message, stack: e.stack, socketId: socket.id });
      }
    }
    
    // Настраиваем обработчики
    setupDeviceHandlers(socket, { devices, io, getVolumeState, persistVolumeState });
    setupControlHandlers(socket, { devices, io, getPageSlideCount, applyVolumeCommand, getVolumeState });
    handleDisconnect(socket, { io });
  });
}

