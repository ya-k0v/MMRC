/**
 * Очистка осиротевших файлов в /content/ корне
 * Файлы, которые не имеют записей в БД, но физически существуют на диске
 */

import { getDatabase } from './database.js';
import { getDevicesPath } from '../config/settings-manager.js';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

/**
 * Найти и удалить осиротевшие файлы в корне /content/
 * @param {Object} options - Опции очистки
 * @param {boolean} options.dryRun - Если true, только логирует, не удаляет (по умолчанию false)
 * @param {Array<string>} options.excludeExtensions - Расширения файлов, которые не нужно удалять (по умолчанию [])
 * @returns {Promise<Object>} - Статистика очистки: { checked, orphaned, deleted, errors, totalSizeMB }
 */
export async function cleanupOrphanedFiles({ dryRun = false, excludeExtensions = [] } = {}) {
  try {
    const db = getDatabase();
    const devicesPath = getDevicesPath();
    
    logger.info('[CleanupOrphaned] Starting orphaned files cleanup', {
      devicesPath,
      dryRun,
      excludeExtensions
    });
    
    // 1. Получаем все пути файлов из БД
    const allFilePaths = db.prepare(`
      SELECT DISTINCT file_path 
      FROM files_metadata 
      WHERE file_path IS NOT NULL AND file_path != ''
    `).all();
    
    const dbFilePaths = new Set(
      allFilePaths.map(row => path.resolve(row.file_path))
    );
    
    logger.info('[CleanupOrphaned] Files in database', {
      totalPaths: dbFilePaths.size
    });
    
    // 2. Сканируем файлы в корне /content/
    const orphanedFiles = [];
    let checked = 0;
    let totalSize = 0;
    
    if (!fs.existsSync(devicesPath)) {
      logger.warn('[CleanupOrphaned] Content directory does not exist', { devicesPath });
      return {
        checked: 0,
        orphaned: 0,
        deleted: 0,
        errors: [],
        totalSizeMB: 0
      };
    }
    
    // Сканируем только корневую директорию /content/, не рекурсивно
    const rootFiles = fs.readdirSync(devicesPath);
    
    for (const fileName of rootFiles) {
      const filePath = path.join(devicesPath, fileName);
      
      try {
        const stat = fs.statSync(filePath);
        
        // Пропускаем директории (папки устройств)
        if (stat.isDirectory()) {
          continue;
        }
        
        // КРИТИЧНО: Временные файлы оптимизации всегда считаются осиротевшими
        // Они не должны быть в БД и должны удаляться
        if (fileName.startsWith('.optimizing_')) {
          orphanedFiles.push({
            fileName,
            filePath,
            size: stat.size,
            mtime: stat.mtimeMs,
            isTemporary: true
          });
          totalSize += stat.size;
          continue;
        }
        
        // Пропускаем другие скрытые файлы (кроме .optimizing_)
        if (fileName.startsWith('.')) {
          continue;
        }
        
        // Пропускаем файлы с исключенными расширениями
        const ext = path.extname(fileName).toLowerCase();
        if (excludeExtensions.includes(ext)) {
          continue;
        }
        
        checked++;
        
        // Проверяем, есть ли этот файл в БД
        const normalizedPath = path.resolve(filePath);
        if (!dbFilePaths.has(normalizedPath)) {
          // Файл не найден в БД - это осиротевший файл
          orphanedFiles.push({
            fileName,
            filePath,
            size: stat.size,
            mtime: stat.mtimeMs,
            isTemporary: false
          });
          totalSize += stat.size;
        }
      } catch (err) {
        logger.warn('[CleanupOrphaned] Error checking file', {
          fileName,
          error: err.message
        });
      }
    }
    
    // Разделяем на временные и обычные осиротевшие файлы
    const temporaryFiles = orphanedFiles.filter(f => f.isTemporary);
    const regularOrphaned = orphanedFiles.filter(f => !f.isTemporary);
    
    logger.info('[CleanupOrphaned] Orphaned files found', {
      checked,
      orphaned: orphanedFiles.length,
      temporary: temporaryFiles.length,
      regular: regularOrphaned.length,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2)
    });
    
    // 3. Удаляем осиротевшие файлы
    let deleted = 0;
    const errors = [];
    
    for (const file of orphanedFiles) {
      try {
        if (!dryRun) {
          fs.unlinkSync(file.filePath);
          deleted++;
          
          logger.info('[CleanupOrphaned] Deleted orphaned file', {
            fileName: file.fileName,
            filePath: file.filePath,
            sizeMB: (file.size / 1024 / 1024).toFixed(2)
          });
        } else {
          logger.info('[CleanupOrphaned] Would delete orphaned file (dry run)', {
            fileName: file.fileName,
            filePath: file.filePath,
            sizeMB: (file.size / 1024 / 1024).toFixed(2)
          });
        }
      } catch (err) {
        errors.push({
          fileName: file.fileName,
          filePath: file.filePath,
          error: err.message
        });
        
        logger.error('[CleanupOrphaned] Failed to delete orphaned file', {
          fileName: file.fileName,
          filePath: file.filePath,
          error: err.message
        });
      }
    }
    
    const result = {
      checked,
      orphaned: orphanedFiles.length,
      deleted: dryRun ? 0 : deleted,
      errors,
      totalSizeMB: parseFloat((totalSize / 1024 / 1024).toFixed(2))
    };
    
    logger.info('[CleanupOrphaned] Cleanup completed', result);
    
    return result;
    
  } catch (error) {
    logger.error('[CleanupOrphaned] Cleanup failed', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

