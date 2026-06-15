import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'node:path';
import fs from 'node:fs';
import { getLogsDir } from '../config/settings-manager.js';
import { ROOT } from '../config/constants.js';

let LOG_DIR = null;
let FILE_LOGGING_ENABLED = true;

function sanitizeDirectoryPath(inputPath) {
  if (typeof inputPath !== 'string') return null;
  const trimmed = inputPath.trim();
  if (!trimmed || trimmed.includes('\0') || !/^[a-zA-Z0-9_./\-\s]+$/.test(trimmed)) return null;
  return path.resolve(trimmed);
}

const fallbackLogDir = path.resolve(path.join(process.cwd(), '.tmp', 'logs'));

function isAllowedLogsDir(dirPath) {
  if (!dirPath) return false;
  const normalized = path.resolve(dirPath);
  const projectRoot = path.resolve(ROOT);
  const mountRoot = path.resolve('/mnt');
  return (
    normalized === projectRoot ||
    normalized.startsWith(projectRoot + path.sep) ||
    normalized === mountRoot ||
    normalized.startsWith(mountRoot + path.sep)
  );
}

try {
  const configuredLogsDir = sanitizeDirectoryPath(getLogsDir());
  LOG_DIR = isAllowedLogsDir(configuredLogsDir) ? configuredLogsDir : fallbackLogDir;
} catch (err) {
  LOG_DIR = fallbackLogDir;
}

try {
  fs.mkdirSync(fallbackLogDir, { recursive: true });
} catch (e) { /* ignore */ }

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format((info) => {
    if (!info.module && typeof info.message === 'string') {
      const m = info.message.match(/^\[(\w+)\]/);
      if (m) info.module = m[1].toLowerCase();
    }
    return info;
  })(),
  winston.format.json()
);

const rawLogLevel = (process.env.LOG_LEVEL || 'info').toString().trim().toLowerCase();
const logLevelMap = { off: 'off', debug: 'debug', info: 'info', warning: 'warn', warn: 'warn', error: 'error' };
const normalizedLogLevel = logLevelMap[rawLogLevel] || 'info';
const isLogSilent = normalizedLogLevel === 'off';
const effectiveLogLevel = isLogSilent ? 'error' : normalizedLogLevel;

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, module, category, ...meta }) => {
    let prefix = `${timestamp} [${level}]`;
    if (module) prefix += ` [${module}]`;
    else if (category) prefix += ` [${category}]`;
    let msg = `${prefix}: ${message}`;
    const rest = { ...meta };
    delete rest.service;
    if (Object.keys(rest).length > 0) msg += ` ${JSON.stringify(rest)}`;
    return msg;
  })
);

function makeRotateFile(filename, level, maxFiles) {
  return new DailyRotateFile({
    filename: path.join(LOG_DIR, filename),
    datePattern: 'YYYY-MM-DD',
    level,
    maxSize: '20m',
    maxFiles,
    format: logFormat,
    silent: isLogSilent
  });
}

let errorFileTransport = null;
let warnFileTransport = null;
let infoFileTransport = null;
let debugFileTransport = null;
let combinedFileTransport = null;

if (LOG_DIR) {
  try {
    errorFileTransport = makeRotateFile('error-%DATE%.log', 'error', '30d');
    warnFileTransport = makeRotateFile('warn-%DATE%.log', 'warn', '14d');
    infoFileTransport = makeRotateFile('info-%DATE%.log', 'info', '14d');
    debugFileTransport = makeRotateFile('debug-%DATE%.log', 'debug', '7d');
    combinedFileTransport = makeRotateFile('combined-%DATE%.log', null, '14d');
  } catch (err) {
    FILE_LOGGING_ENABLED = false;
    try { process.stderr.write(`[Logger] Failed to initialize file transports: ${err.message}\n`); } catch (_) {}
  }
} else {
  try { process.stderr.write(`[Logger] File logging disabled; using console only\n`); } catch (_) {}
}

const consoleTransport = new winston.transports.Console({
  format: consoleFormat,
  level: effectiveLogLevel,
  silent: isLogSilent || process.env.SILENT_CONSOLE === 'true'
});

const logger = winston.createLogger({
  level: effectiveLogLevel,
  silent: isLogSilent,
  format: logFormat,
  defaultMeta: { service: 'mmrc' },
  exitOnError: false,
  transports: [
    ...(errorFileTransport ? [errorFileTransport] : []),
    ...(warnFileTransport ? [warnFileTransport] : []),
    ...(infoFileTransport ? [infoFileTransport] : []),
    ...(debugFileTransport ? [debugFileTransport] : []),
    ...(combinedFileTransport ? [combinedFileTransport] : []),
    consoleTransport
  ],
  exceptionHandlers: (FILE_LOGGING_ENABLED && LOG_DIR
    ? [makeRotateFile('exceptions-%DATE%.log', 'error', '30d')]
    : []),
  rejectionHandlers: (FILE_LOGGING_ENABLED && LOG_DIR
    ? [makeRotateFile('rejections-%DATE%.log', 'error', '30d')]
    : [])
});

function logWithModule(level, message, moduleName, meta = {}) {
  logger.log(level, message, { ...meta, module: moduleName, category: moduleName });
}

export const logAuth = (level, message, meta = {}) => logWithModule(level, message, 'auth', meta);
export const logDevice = (level, message, meta = {}) => logWithModule(level, message, 'device', meta);
export const logFile = (level, message, meta = {}) => logWithModule(level, message, 'file', meta);
export const logSocket = (level, message, meta = {}) => logWithModule(level, message, 'socket', meta);
export const logSecurity = (level, message, meta = {}) => logWithModule(level, message, 'security', meta);
export const logAPI = (level, message, meta = {}) => logWithModule(level, message, 'api', meta);

export function createModuleLogger(moduleName) {
  return ['error', 'warn', 'info', 'debug'].reduce((acc, level) => {
    acc[level] = (msg, meta = {}) => logger[level](msg, { ...meta, module: moduleName });
    return acc;
  }, { log: (level, msg, meta = {}) => logger.log(level, msg, { ...meta, module: moduleName }) });
}

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
    if (res.statusCode >= 500) level = 'error';
    else if (res.statusCode >= 400) level = 'warn';
    else if (isServiceLogsPoll) level = 'debug';
    else if (isAdminWrite) level = 'warn';

    logAPI(level, `${req.method} ${req.originalUrl || req.url}`, logData);

    import('./metrics.js').then(({ recordRequest }) => {
      recordRequest(req.method, req.originalUrl || req.url, duration, res.statusCode >= 400);
    }).catch(() => {});
  });

  next();
};

export default logger;
