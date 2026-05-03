/**
 * Кэш разрешений видео файлов
 * Избегаем повторных вызовов FFmpeg для получения resolution
 * @module video/resolution-cache
 */

import fs from 'node:fs';
import path from 'node:path';

// In-memory кэш: { filePath: { width, height, duration, mtime, lastAccess } }
const resolutionCache = new Map();
const MAX_CACHE_SIZE = 1000; // Максимум 1000 записей в кэше

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
      // Файл не изменился - обновляем lastAccess для LRU и возвращаем из кэша
      cached.lastAccess = Date.now();
      return { width: cached.width, height: cached.height, duration: cached.duration ?? null };
    }

    // Файл изменился или еще не в кэше - вызываем FFmpeg
    const params = await checkVideoParameters(filePath);
    if (params && params.width && params.height) {
      // КРИТИЧНО: LRU - удаляем самые старые записи при переполнении
      if (resolutionCache.size >= MAX_CACHE_SIZE) {
        const entries = Array.from(resolutionCache.entries());
        entries.sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0));
        
        // Удаляем 20% самых старых записей
        const toRemove = Math.max(1, Math.ceil(MAX_CACHE_SIZE * 0.2));
        for (let i = 0; i < toRemove; i++) {
          resolutionCache.delete(entries[i][0]);
        }
      }
      
      // Сохраняем в кэш с lastAccess для LRU
      resolutionCache.set(filePath, {
        width: params.width,
        height: params.height,
        duration: params.duration ?? null,
        mtime: mtime,
        lastAccess: Date.now()
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

