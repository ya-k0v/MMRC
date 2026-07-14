import fs from 'node:fs';
import path from 'node:path';
import logger from '../utils/logger.js';
import { validatePath } from '../utils/path-validator.js';

const SERVICE_LOGS_MAX_LINES = Math.max(50, Number(process.env.SERVICE_LOGS_MAX_LINES || 2000));
const SERVICE_LOGS_DEFAULT_LINES = Math.max(20, Number(process.env.SERVICE_LOGS_DEFAULT_LINES || 200));
const SERVICE_LOGS_MAX_CHUNK_BYTES = Math.max(64 * 1024, Number(process.env.SERVICE_LOGS_MAX_CHUNK_BYTES || 512 * 1024));
const ADMIN_SERVICE_LOGS_FALLBACK_DIR = path.join(process.cwd(), '.tmp', 'logs');
const SERVICE_LOG_LEVELS = ['combined', 'error', 'warn', 'info', 'debug'];

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function getServiceLogsCandidateDirs(getLogsDir) {
  const seenDirs = new Set();
  const candidates = [getLogsDir(), ADMIN_SERVICE_LOGS_FALLBACK_DIR];

  return candidates
    .map((dirPath) => path.resolve(String(dirPath || '')))
    .filter((dirPath) => {
      if (!dirPath || seenDirs.has(dirPath)) {
        return false;
      }
      seenDirs.add(dirPath);
      return true;
    });
}

export function validateServiceLogFilePath(filePath, getLogsDir) {
  const resolvedFilePath = path.resolve(String(filePath || ''));

  for (const baseDir of getServiceLogsCandidateDirs(getLogsDir)) {
    try {
      const safeFilePath = validatePath(resolvedFilePath, baseDir);
      const fileName = path.basename(safeFilePath);
      const isAllowed = SERVICE_LOG_LEVELS.some(l =>
        l === 'combined'
          ? /^combined-\d{4}-\d{2}-\d{2}\.log$/.test(fileName)
          : new RegExp(`^${l}-\\d{4}-\\d{2}-\\d{2}\\.log$`).test(fileName)
      );
      if (isAllowed) return safeFilePath;
    } catch { }
  }

  throw new Error('Invalid service log path');
}

export function resolveLatestServiceLogFilePath(level = 'combined', getLogsDir) {
  const pattern = level === 'combined'
    ? /^combined-\d{4}-\d{2}-\d{2}\.log$/
    : new RegExp(`^${level}-\\d{4}-\\d{2}-\\d{2}\\.log$`);

  for (const dirPath of getServiceLogsCandidateDirs(getLogsDir)) {
    try {
      const safeDirPath = validatePath(dirPath, dirPath);
      if (!fs.existsSync(safeDirPath)) continue;

      const files = fs.readdirSync(safeDirPath).filter((name) => pattern.test(name)).sort();
      if (!files.length) continue;
      return path.join(safeDirPath, files[files.length - 1]);
    } catch (error) {
      logger.warn('[Admin] Failed to inspect logs directory', {
        dirPath: path.resolve(dirPath),
        error: error?.message || String(error)
      });
    }
  }

  return null;
}

export function readLastLinesFromFile(filePath, lineLimit, getLogsDir) {
  const safeLimit = clampInt(parsePositiveInt(lineLimit, SERVICE_LOGS_DEFAULT_LINES), 1, SERVICE_LOGS_MAX_LINES);
  const safeFilePath = validateServiceLogFilePath(filePath, getLogsDir);
  const fd = fs.openSync(safeFilePath, 'r');

  try {
    const stats = fs.fstatSync(fd);
    if (!stats.size) {
      return { lines: [], size: 0, truncated: false };
    }

    const chunkSize = 64 * 1024;
    let position = stats.size;
    let content = '';
    let linesFound = 0;

    while (position > 0 && linesFound <= safeLimit) {
      const bytesToRead = Math.min(chunkSize, position);
      position -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, position);
      content = buffer.toString('utf8') + content;
      linesFound = content.split(/\r?\n/).length - 1;
    }

    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-safeLimit);

    return {
      lines,
      size: stats.size,
      truncated: false
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function readLinesFromOffset(filePath, offset, getLogsDir) {
  const safeOffset = Math.max(0, parsePositiveInt(offset, 0));
  const safeFilePath = validateServiceLogFilePath(filePath, getLogsDir);
  const fd = fs.openSync(safeFilePath, 'r');

  try {
    const stats = fs.fstatSync(fd);
    if (safeOffset >= stats.size) {
      return { lines: [], size: stats.size, truncated: false, reset: false };
    }

    let startOffset = safeOffset;
    let truncated = false;
    const unreadBytes = stats.size - startOffset;

    if (unreadBytes > SERVICE_LOGS_MAX_CHUNK_BYTES) {
      startOffset = stats.size - SERVICE_LOGS_MAX_CHUNK_BYTES;
      truncated = true;
    }

    const bytesToRead = stats.size - startOffset;
    if (bytesToRead <= 0) {
      return { lines: [], size: stats.size, truncated, reset: false };
    }

    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, startOffset);

    const lines = buffer
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    return {
      lines,
      size: stats.size,
      truncated,
      reset: false
    };
  } finally {
    fs.closeSync(fd);
  }
}

export { SERVICE_LOG_LEVELS, SERVICE_LOGS_DEFAULT_LINES, SERVICE_LOGS_MAX_LINES };
