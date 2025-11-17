/**
 * Кэш разрешений видео файлов
 * Избегаем повторных вызовов FFmpeg для получения resolution
 * @module video/resolution-cache
 */

import fs from 'fs';
import path from 'path';

// In-memory кэш: { filePath: { width, height, duration, mtime } }
const resolutionCache = new Map();

/**
 * Получить разрешение из кэша или вызвать FFmpeg
 * @param {string} filePath - Путь к видео файлу
 * @param {Function} checkVideoParameters - Функция для получения параметров через FFmpeg
 * @returns {Object|null} - { width, height } или null
 */
export async function getCachedResolution(filePath, checkVideoParameters) {
  try {
    // Проверяем существование файла
    if (!fs.existsSync(filePath)) {
      return null;
    }

    // Получаем mtime (время модификации файла)
    const stats = fs.statSync(filePath);
    const mtime = stats.mtimeMs;

    // Проверяем кэш
    const cached = resolutionCache.get(filePath);
    if (cached && cached.mtime === mtime) {
      // Файл не изменился - возвращаем из кэша
      return { width: cached.width, height: cached.height, duration: cached.duration ?? null };
    }

    // Файл изменился или еще не в кэше - вызываем FFmpeg
    const params = await checkVideoParameters(filePath);
    if (params && params.width && params.height) {
      // Сохраняем в кэш
      resolutionCache.set(filePath, {
        width: params.width,
        height: params.height,
        duration: params.duration ?? null,
        mtime: mtime
      });
      return { width: params.width, height: params.height, duration: params.duration ?? null };
    }

    return null;
  } catch (e) {
    // В случае ошибки просто возвращаем null
    return null;
  }
}

/**
 * Очистить кэш для конкретного файла
 * @param {string} filePath
 */
export function clearResolutionCache(filePath) {
  resolutionCache.delete(filePath);
}

/**
 * Очистить весь кэш
 */
export function clearAllResolutionCache() {
  resolutionCache.clear();
}

/**
 * Получить размер кэша
 */
export function getResolutionCacheSize() {
  return resolutionCache.size;
}

/**
 * Очистить кэш для несуществующих файлов (периодическая очистка)
 */
export function cleanupResolutionCache() {
  let removed = 0;
  for (const [filePath, data] of resolutionCache.entries()) {
    if (!fs.existsSync(filePath)) {
      resolutionCache.delete(filePath);
      removed++;
    }
  }
  return removed;
}

