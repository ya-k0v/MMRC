/**
 * Структурированное логирование с Winston
 * @module utils/logger
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import { getLogsDir } from '../config/settings-manager.js';

// Директория для логов (вычисляется динамически из настроек БД)
let LOG_DIR = null;
let FILE_LOGGING_ENABLED = true;

function sanitizeDirectoryPath(inputPath) {
  if (typeof inputPath !== 'string') {
    return null;
  }

  const trimmed = inputPath.trim();
  if (!trimmed || trimmed.includes('\0') || !/^[a-zA-Z0-9_./\-\s]+$/.test(trimmed)) {
    return null;
  }

  return path.resolve(trimmed);
}

try {
  LOG_DIR = sanitizeDirectoryPath(getLogsDir());
  if (!LOG_DIR) {
    throw new Error('Invalid logs directory path');
  }
  // Попытка создать директорию и проверить доступ на запись
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.accessSync(LOG_DIR, fs.constants.W_OK);
  } catch (err) {
    // Если не удалось создать/записать - переключаемся на fallback
    FILE_LOGGING_ENABLED = false;
    const fallback = path.join(process.cwd(), '.tmp', 'logs');
    try {
      fs.mkdirSync(fallback, { recursive: true });
      LOG_DIR = fallback;
      FILE_LOGGING_ENABLED = true;
    } catch (e) {
      // Последняя инстанция: оставляем LOG_DIR null and disable file logging
      LOG_DIR = null;
      FILE_LOGGING_ENABLED = false;
    }
    try {
      process.stderr.write(`[Logger] File logging disabled for ${getLogsDir()} - using fallback ${LOG_DIR}\n`);
    } catch (e) {
      // ignore
    }
  }
} catch (err) {
  FILE_LOGGING_ENABLED = false;
  const fallback = path.join(process.cwd(), '.tmp', 'logs');
  try {
    fs.mkdirSync(fallback, { recursive: true });
    LOG_DIR = fallback;
    FILE_LOGGING_ENABLED = true;
  } catch (e) {
    LOG_DIR = null;
  }
}

// Форматирование логов
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Нормализация уровня логирования из .env
const rawLogLevel = (process.env.LOG_LEVEL || 'info').toString().trim().toLowerCase();
const logLevelMap = {
  off: 'off',
  debug: 'debug',
  info: 'info',
  warning: 'warn',
  warn: 'warn',
  error: 'error'
};
const normalizedLogLevel = logLevelMap[rawLogLevel] || 'info';
const isLogSilent = normalizedLogLevel === 'off';
const effectiveLogLevel = isLogSilent ? 'error' : normalizedLogLevel;

// Форматирование для консоли (более читаемое)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

let errorFileTransport = null;
let combinedFileTransport = null;
if (FILE_LOGGING_ENABLED && LOG_DIR) {
  try {
    errorFileTransport = new DailyRotateFile({
      filename: path.join(LOG_DIR, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '30d', // Хранить 30 дней
      format: logFormat,
      silent: isLogSilent
    });

    combinedFileTransport = new DailyRotateFile({
      filename: path.join(LOG_DIR, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d', // Хранить 14 дней
      format: logFormat,
      silent: isLogSilent
    });
  } catch (err) {
    FILE_LOGGING_ENABLED = false;
    try { process.stderr.write(`[Logger] Failed to initialize file transports: ${err.message}\n`); } catch (_) {}
    errorFileTransport = null;
    combinedFileTransport = null;
  }
} else {
  try { process.stderr.write(`[Logger] File logging disabled; using console only\n`); } catch (_) {}
}

// Транспорт: консоль (уровень задается через LOG_LEVEL)
const consoleTransport = new winston.transports.Console({
  format: consoleFormat,
  level: effectiveLogLevel,
  // Опционально: полностью отключить консоль если нужно
  silent: isLogSilent || process.env.SILENT_CONSOLE === 'true'
});

// Создаем основной logger
const logger = winston.createLogger({
  level: effectiveLogLevel,
  silent: isLogSilent,
  format: logFormat,
  defaultMeta: { service: 'mmrc' },
  exitOnError: false,
  transports: [
    ...(errorFileTransport ? [errorFileTransport] : []),
    ...(combinedFileTransport ? [combinedFileTransport] : []),
    consoleTransport
  ],
  exceptionHandlers: [
    ...(FILE_LOGGING_ENABLED && LOG_DIR
      ? [new DailyRotateFile({
          filename: path.join(LOG_DIR, 'exceptions-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '30d'
        })]
      : [])
  ],
  rejectionHandlers: [
    ...(FILE_LOGGING_ENABLED && LOG_DIR
      ? [new DailyRotateFile({
          filename: path.join(LOG_DIR, 'rejections-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '30d'
        })]
      : [])
  ]
});

// Вспомогательные функции для логирования с контекстом
export const logAuth = (level, message, meta = {}) => {
  logger.log(level, message, { ...meta, category: 'auth' });
};

export const logDevice = (level, message, meta = {}) => {
  logger.log(level, message, { ...meta, category: 'device' });
};

export const logFile = (level, message, meta = {}) => {
  logger.log(level, message, { ...meta, category: 'file' });
};

export const logSocket = (level, message, meta = {}) => {
  logger.log(level, message, { ...meta, category: 'socket' });
};

export const logSecurity = (level, message, meta = {}) => {
  logger.log(level, message, { ...meta, category: 'security' });
};

export const logAPI = (level, message, meta = {}) => {
  logger.log(level, message, { ...meta, category: 'api' });
};

// Middleware для Express - логирование HTTP запросов
export const httpLoggerMiddleware = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip || req.connection?.remoteAddress,
      userAgent: req.get('user-agent')
    };

    if (req.user) {
      logData.userId = req.user.id;
      logData.username = req.user.username;
      logData.role = req.user.role;
    }

    const rawUrl = req.originalUrl || req.url || '';
    const urlPath = rawUrl.split('?')[0];
    const isAdminApi = urlPath.startsWith('/api/admin/');
    const isAdminWrite = isAdminApi && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const isServiceLogsPoll = urlPath === '/api/admin/service-logs';

    let level = 'info';
    if (res.statusCode >= 500) {
      level = 'error';
    } else if (res.statusCode >= 400) {
      level = 'warn';
    } else if (isServiceLogsPoll) {
      // Polling-эндпоинт viewer'а не должен засорять логи.
      level = 'debug';
    } else if (isAdminWrite) {
      // Админские изменяющие операции оставляем заметными.
      level = 'warn';
    }

    logAPI(level, `${req.method} ${req.originalUrl || req.url}`, logData);

    // Записываем метрики (асинхронно, не блокируем ответ)
    import('./metrics.js').then(({ recordRequest }) => {
      recordRequest(req.method, req.originalUrl || req.url, duration, res.statusCode >= 400);
    }).catch(() => {
      // Ignore metrics errors
    });
  });

  next();
};

export default logger;

