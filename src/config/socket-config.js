/**
 * Конфигурация Socket.IO
 * @module config/socket-config
 */

import { Server } from 'socket.io';
import logger from '../utils/logger.js';

/**
 * Создает и настраивает Socket.IO сервер
 * @param {http.Server} httpServer - HTTP сервер
 * @returns {Server} Настроенный Socket.IO сервер
 */
export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type']
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingInterval: 25000,
    pingTimeout: 60000,
    maxHttpBufferSize: 10 * 1024 * 1024 // 10MB запас для событий
  });

  // Обработка ошибок подключения
  io.engine.on('connection_error', (err) => {
    logger.warn(
      `[Socket.IO] connection_error code=${err.code} message=${err.message} transport=${err.context?.transport || 'n/a'}`,
      { code: err.code, message: err.message, transport: err.context?.transport || 'n/a' }
    );
  });

  return io;
}

