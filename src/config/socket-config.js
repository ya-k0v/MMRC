/**
 * Конфигурация Socket.IO
 * @module config/socket-config
 */

import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('socket');

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
    maxHttpBufferSize: 10 * 1024 * 1024
  });

  io.engine.on('connection_error', (err) => {
    logger.warn(
      `[Socket.IO] connection_error code=${err.code} message=${err.message} transport=${err.context?.transport || 'n/a'}`,
      { code: err.code, message: err.message, transport: err.context?.transport || 'n/a' }
    );
  });

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const pub = new Redis(redisUrl);
      const sub = new Redis(redisUrl);
      io.adapter(createAdapter(pub, sub));
      logger.info('[Socket.IO] Redis adapter enabled');
    } catch (err) {
      logger.warn('[Socket.IO] Redis adapter failed to initialize, falling back to in-process', { error: err.message });
    }
  }

  return io;
}

