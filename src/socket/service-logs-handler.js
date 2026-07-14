import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../utils/logger.js';
import {
  resolveLatestServiceLogFilePath,
  readLastLinesFromFile,
  SERVICE_LOG_LEVELS
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
  const { requireAuth, getLogsDir } = deps;

  const nsp = io.of('/service-logs');

  nsp.use((socket, next) => {
    try {
      const auth = socket.request;
      requireAuth(auth, {}, () => {});
      if (!auth.user) {
        return next(new Error('Unauthorized'));
      }
      socket.user = auth.user;
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

        if (lastOffset === 0) {
          const snapshot = readLastLinesFromFile(logFilePath, 100, getLogsDir);
          lastOffset = snapshot.size;
          let lines = snapshot.lines;
          if (currentModule) {
            lines = filterByModule(lines, currentModule);
          }
          if (lines.length) {
            socket.emit('logs/chunk', { lines, fileName, offset: lastOffset });
          }
          return;
        }

        const fd = fs.openSync(logFilePath, 'r');
        try {
          const stats = fs.fstatSync(fd);
          if (stats.size <= lastOffset) return;

          const bytesToRead = stats.size - lastOffset;
          const buffer = Buffer.alloc(bytesToRead);
          fs.readSync(fd, buffer, 0, bytesToRead, lastOffset);
          lastOffset = stats.size;

          const newLines = buffer.toString('utf8')
            .split(/\r?\n/)
            .map(l => l.trimEnd())
            .filter(l => l.length > 0);

          if (currentModule) {
            const filtered = filterByModule(newLines, currentModule);
            if (filtered.length) {
              socket.emit('logs/chunk', { lines: filtered, fileName, offset: lastOffset });
            }
          } else if (newLines.length) {
            socket.emit('logs/chunk', { lines: newLines, fileName, offset: lastOffset });
          }
        } finally {
          fs.closeSync(fd);
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

      lastOffset = 0;
      lastFileName = '';
      sendNewLines();

      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(sendNewLines, POLL_INTERVAL_MS);

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
