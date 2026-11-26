import fs from 'node:fs';
import path from 'node:path';
import logger from '../utils/logger.js';
import { validatePath } from '../utils/path-validator.js';

function envInt(name, fallback, min) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(min, parsed) : fallback;
}

const SERVICE_LOGS_MAX_LINES = envInt('SERVICE_LOGS_MAX_LINES', 2000, 50);
const SERVICE_LOGS_DEFAULT_LINES = envInt('SERVICE_LOGS_DEFAULT_LINES', 200, 20);
const SERVICE_LOGS_MAX_CHUNK_BYTES = envInt('SERVICE_LOGS_MAX_CHUNK_BYTES', 512 * 1024, 64 * 1024);
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

/**
 * Байтовый offset после последнего полного переноса строки.
 * Хранить его как nextOffset важно: иначе следующий инкрементальный чтение
 * начнётся с середины строки (и, возможно, с середины UTF-8-символа).
 */
function findLastCompleteLineOffset(fd, size) {
  if (!size) return 0;

  const chunk = Buffer.alloc(Math.min(8192, size));
  let position = size;
  while (position > 0) {
    const bytesToRead = Math.min(chunk.length, position);
    position -= bytesToRead;
    fs.readSync(fd, chunk, 0, bytesToRead, position);
    const newlineIndex = chunk.lastIndexOf(10, bytesToRead - 1);
    if (newlineIndex >= 0) return position + newlineIndex + 1;
  }
  return 0;
}

/** Сдвинуть старт чтения к началу следующей полной строки. */
function alignToLineStart(fd, startOffset, size) {
  if (startOffset <= 0 || startOffset >= size) return startOffset;

  const previous = Buffer.alloc(1);
  fs.readSync(fd, previous, 0, 1, startOffset - 1);
  if (previous[0] === 10) return startOffset;

  const chunk = Buffer.alloc(Math.min(8192, size - startOffset));
  let position = startOffset;
  while (position < size) {
    const bytesToRead = Math.min(chunk.length, size - position);
    fs.readSync(fd, chunk, 0, bytesToRead, position);
    const newlineIndex = chunk.subarray(0, bytesToRead).indexOf(10);
    if (newlineIndex >= 0) return position + newlineIndex + 1;
    position += bytesToRead;
  }
  return size;
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

  const candidates = [];
  for (const dirPath of getServiceLogsCandidateDirs(getLogsDir)) {
    try {
      const safeDirPath = validatePath(dirPath, dirPath);
      if (!fs.existsSync(safeDirPath)) continue;

      for (const name of fs.readdirSync(safeDirPath)) {
        if (!pattern.test(name)) continue;
        const filePath = path.join(safeDirPath, name);
        let mtime = 0;
        try {
          mtime = fs.statSync(filePath).mtimeMs;
        } catch {
          // Файл мог исчезнуть между readdir и stat — просто пропускаем.
          continue;
        }
        candidates.push({ filePath, mtime });
      }
    } catch (error) {
      logger.warn('[Admin] Failed to inspect logs directory', {
        dirPath: path.resolve(dirPath),
        error: error?.message || String(error)
      });
    }
  }

  // Имя файла зависит от даты, но при смене contentRoot старый каталог
  // может остаться с «правильным» именем. Берём реально свежий файл.
  candidates.sort((a, b) => b.mtime - a.mtime || a.filePath.localeCompare(b.filePath));
  return candidates[0]?.filePath || null;
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
    const chunks = [];
    let position = stats.size;
    let newlinesFound = 0;

    // Собираем байты кусками, но декодируем уже весь буфер целиком:
    // toString() на каждой 64 КБ-порции рвал многобайтовые символы (кириллицу).
    while (position > 0 && newlinesFound <= safeLimit) {
      const bytesToRead = Math.min(chunkSize, position);
      position -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, position);
      for (const byte of buffer) {
        if (byte === 10) newlinesFound += 1;
      }
      chunks.unshift(buffer);
    }

    let content = new TextDecoder('utf-8').decode(Buffer.concat(chunks));
    // Первая строка может быть обрезана границей куска — выбрасываем её.
    if (position > 0) {
      const firstNewline = content.indexOf('\n');
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : '';
    }

    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-safeLimit);

    return {
      lines,
      size: findLastCompleteLineOffset(fd, stats.size),
      truncated: position > 0
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function readLinesFromOffset(filePath, offset, lineLimit, getLogsDir) {
  const safeOffset = Math.max(0, parsePositiveInt(offset, 0));
  const safeLimit = clampInt(parsePositiveInt(lineLimit, SERVICE_LOGS_DEFAULT_LINES), 1, SERVICE_LOGS_MAX_LINES);
  const safeFilePath = validateServiceLogFilePath(filePath, getLogsDir);
  const fd = fs.openSync(safeFilePath, 'r');

  try {
    const stats = fs.fstatSync(fd);
    const endOffset = findLastCompleteLineOffset(fd, stats.size);
    if (endOffset <= safeOffset) {
      return { lines: [], size: Math.max(safeOffset, endOffset), truncated: false, reset: false };
    }

    let startOffset = safeOffset;
    let truncated = false;
    if (endOffset - startOffset > SERVICE_LOGS_MAX_CHUNK_BYTES) {
      startOffset = endOffset - SERVICE_LOGS_MAX_CHUNK_BYTES;
      truncated = true;
    }

    startOffset = alignToLineStart(fd, startOffset, endOffset);
    const bytesToRead = endOffset - startOffset;
    if (bytesToRead <= 0) {
      return { lines: [], size: endOffset, truncated, reset: false };
    }

    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, startOffset);
    const text = buffer.toString('utf8');

    const lines = [];
    let consumed = 0;
    for (const segment of text.split(/(?<=\n)/)) {
      // Неполная последняя строка останется для следующего опроса.
      if (!segment.endsWith('\n')) continue;
      consumed += Buffer.byteLength(segment, 'utf8');
      const line = segment.replace(/\r?\n$/, '').trimEnd();
      if (line) lines.push(line);
      if (lines.length >= safeLimit) break;
    }

    return {
      lines,
      size: startOffset + consumed,
      truncated,
      reset: false
    };
  } finally {
    fs.closeSync(fd);
  }
}

export { SERVICE_LOG_LEVELS, SERVICE_LOGS_DEFAULT_LINES, SERVICE_LOGS_MAX_LINES };
