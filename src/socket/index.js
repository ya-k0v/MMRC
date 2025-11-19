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
  const { devices, getPageSlideCount } = deps;
  
  io.on('connection', socket => {
    const transport = socket.conn?.transport?.name;
    logger.info(`[Socket.IO] 🔌 connection id=${socket.id}`, { socketId: socket.id, transport });

    // Логирование transport events
    if (socket.conn) {
      socket.conn.on('upgrade', () => {
        logger.info(`[Socket.IO] 🚀 transport upgraded for ${socket.id}`, { socketId: socket.id, newTransport: socket.conn.transport.name });
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
    
    // Настраиваем обработчики
    setupDeviceHandlers(socket, { devices, io });
    setupControlHandlers(socket, { devices, io, getPageSlideCount });
    handleDisconnect(socket, { io });
  });
}

