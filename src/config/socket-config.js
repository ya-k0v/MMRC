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
  const rawOrigins = String(process.env.MMRC_CORS_ORIGINS || '').trim();
  const corsOrigins = rawOrigins
    ? rawOrigins.split(',').map((o) => o.trim()).filter(Boolean)
    : ['*'];

  if (rawOrigins) {
    logger.info(`[Socket.IO] CORS origins restricted to: ${corsOrigins.join(', ')}`);
  } else {
    logger.warn('[Socket.IO] MMRC_CORS_ORIGINS not set, CORS allows all origins. Set it to restrict access.');
  }

  const io = new Server(httpServer, {
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization']
    },
    transports: ['websocket', 'polling'],
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

