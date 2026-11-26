import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../utils/logger.js';
import { verifyAccessToken } from '../middleware/auth.js';
import {
  resolveLatestServiceLogFilePath,
  readLastLinesFromFile,
  readLinesFromOffset,
  SERVICE_LOG_LEVELS,
  SERVICE_LOGS_MAX_LINES
} from '../services/service-logs.js';

const logger = createModuleLogger('socket');
const MAX_VIEWERS = 10;
const POLL_INTERVAL_MS = 2000;
const activeViewers = new Map();

function filterByModule(lines, module) {
  return lines.filter(line => {
    try {
      const parsed = JSON.parse(line);
      return parsed.module === module;
    } catch { return true; }
  });
}

export function setupServiceLogsHandler(io, deps) {
  const { getLogsDir } = deps;

  const nsp = io.of('/service-logs');

  // requireAuth — async Express-мидлвар и для socket.request бесполезен:
  // он проверял auth.user сразу же, до await db.get(), и всегда отклонял
  // соединение. Берём токен из handshake и проверяем JWT напрямую.
  nsp.use((socket, next) => {
    try {
      const token = socket.handshake?.auth?.token
        || socket.handshake?.auth?.accessToken
        || (socket.request?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      const user = token ? verifyAccessToken(token) : null;
      if (!user || !['admin', 'hero_admin'].includes(user.role)) {
        return next(new Error('Unauthorized'));
      }
      socket.user = user;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  nsp.on('connection', (socket) => {
    if (activeViewers.size >= MAX_VIEWERS) {
      socket.emit('error', { message: 'Too many log viewers' });
      socket.disconnect();
      return;
    }

    logger.info('[ServiceLogs] WS connected', { socketId: socket.id, user: socket.user?.username });

    let watcher = null;
    let pollTimer = null;
    let lastOffset = 0;
    let lastFileName = '';
    let currentLevel = 'combined';
    let currentModule = '';
    let currentLines = SERVICE_LOGS_MAX_LINES;

    const viewerState = { socket, level: currentLevel, module: currentModule };
    activeViewers.set(socket.id, viewerState);

    function sendNewLines() {
      try {
        const logFilePath = resolveLatestServiceLogFilePath(currentLevel, getLogsDir);
        if (!logFilePath) return;

        const fileName = path.basename(logFilePath);

        if (fileName !== lastFileName) {
          lastFileName = fileName;
          lastOffset = 0;
          socket.emit('logs/reset', { fileName });
        }

        const snapshot = lastOffset === 0
          ? readLastLinesFromFile(logFilePath, currentLines, getLogsDir)
          : readLinesFromOffset(logFilePath, lastOffset, currentLines, getLogsDir);

        // offset должен указывать на начало следующей полной строки,
        // иначе порция за порцией будут ломаться UTF-8 и переносы строк.
        lastOffset = snapshot.size;
        let lines = snapshot.lines;
        if (currentModule) {
          lines = filterByModule(lines, currentModule);
        }
        if (lines.length) {
          socket.emit('logs/chunk', { lines, fileName, offset: lastOffset });
        }
      } catch (error) {
        logger.error('[ServiceLogs] Error reading logs', { error: error.message });
      }
    }

    socket.on('logs/subscribe', (opts = {}) => {
      if (opts.level && SERVICE_LOG_LEVELS.includes(opts.level)) {
        currentLevel = opts.level;
      }
      if (typeof opts.module === 'string') {
        currentModule = opts.module;
      }
      if (Number.isFinite(Number(opts.lines)) && Number(opts.lines) > 0) {
        currentLines = Math.min(SERVICE_LOGS_MAX_LINES, Math.floor(Number(opts.lines)));
      }

      lastOffset = 0;
      lastFileName = '';
      sendNewLines();

      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(sendNewLines, POLL_INTERVAL_MS);

      // Повторная подписка не должна оставлять старый fs.watch висящим.
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      try {
        const logFilePath = resolveLatestServiceLogFilePath(currentLevel, getLogsDir);
        if (logFilePath) {
          const dir = path.dirname(logFilePath);
          watcher = fs.watch(dir, (event, filename) => {
            if (filename && filename.endsWith('.log')) {
              sendNewLines();
            }
          });
        }
      } catch {
        logger.debug('[ServiceLogs] fs.watch not available, using poll only');
      }
    });

    socket.on('logs/unsubscribe', () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (watcher) { watcher.close(); watcher = null; }
    });

    socket.on('disconnect', () => {
      if (pollTimer) clearInterval(pollTimer);
      if (watcher) watcher.close();
      activeViewers.delete(socket.id);
      logger.info('[ServiceLogs] WS disconnected', { socketId: socket.id });
    });

    socket.emit('ready');
  });
}
