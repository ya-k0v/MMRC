/**
 * Структурированное логирование с Winston
 * @module utils/logger
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Директория для логов
const LOG_DIR = path.join(__dirname, '../../logs');

// Форматирование логов
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

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

// Транспорт: файлы с ротацией (error)
const errorFileTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  level: 'error',
  maxSize: '20m',
  maxFiles: '30d', // Хранить 30 дней
  format: logFormat
});

// Транспорт: файлы с ротацией (combined - все уровни)
const combinedFileTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'combined-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d', // Хранить 14 дней
  format: logFormat
});

// Транспорт: консоль (только в development)
const consoleTransport = new winston.transports.Console({
  format: consoleFormat,
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug'
});

// Создаем основной logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'videocontrol' },
  transports: [
    errorFileTransport,
    combinedFileTransport,
    consoleTransport
  ],
  exceptionHandlers: [
    new DailyRotateFile({
      filename: path.join(LOG_DIR, 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d'
    })
  ],
  rejectionHandlers: [
    new DailyRotateFile({
      filename: path.join(LOG_DIR, 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d'
    })
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

    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
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

