/**
 * Скрипт миграции для добавления папок/PDF/PPTX в БД
 * Запуск: node src/database/migrate-static-content.js
 */

import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { initDatabase, getDatabase } from './database.js';
import { getDevicesPath } from '../config/settings-manager.js';
import { loadDevicesFromDB, loadFileNamesFromDB } from '../storage/devices-storage-sqlite.js';
import { getFolderImagesCount } from '../converters/folder-converter.js';
import { getPageSlideCount } from '../converters/document-converter.js';
import { saveFileMetadata, getFileMetadata } from './files-metadata.js';
import { ROOT } from '../config/constants.js';

async function migrateStaticContent() {
  try {
    logger.info('[Migration] Starting static content migration...');
    
    // Инициализируем БД
    const dbPath = path.join(ROOT, 'config', 'main.db');
    initDatabase(dbPath);
    const db = getDatabase();
    
    // Загружаем устройства и маппинг имен
    const devices = loadDevicesFromDB();
    const fileNamesMap = loadFileNamesFromDB();
    const devicesPath = getDevicesPath();
    
    let totalMigrated = 0;
    let totalErrors = 0;
    
    for (const deviceId in devices) {
      const device = devices[deviceId];
      const deviceFolder = path.join(devicesPath, device.folder);
      
      if (!fs.existsSync(deviceFolder)) {
        logger.warn(`[Migration] Device folder not found: ${deviceFolder}`, { deviceId });
        continue;
      }
      
      logger.info(`[Migration] Processing device: ${deviceId}`, { deviceFolder });
      
      const entries = fs.readdirSync(deviceFolder);
      
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        
        const entryPath = path.join(deviceFolder, entry);
        let stat;
        
        try {
          stat = fs.statSync(entryPath);
        } catch (e) {
          logger.warn(`[Migration] Cannot stat entry: ${entryPath}`, { error: e.message });
          continue;
        }
        
        // Проверяем, есть ли уже запись в БД
        const existing = getFileMetadata(deviceId, entry);
        if (existing) {
          // Если запись есть, проверяем, нужно ли обновить pages_count
          if (existing.content_type === 'folder' || existing.content_type === 'pdf' || existing.content_type === 'pptx') {
            if (existing.pages_count === null || existing.pages_count === undefined) {
              // Обновляем pages_count
              try {
                let pagesCount = 0;
                if (stat.isDirectory()) {
                  pagesCount = await getFolderImagesCount(deviceId, entry);
                } else {
                  const ext = path.extname(entry).toLowerCase();
                  if (ext === '.pdf' || ext === '.pptx') {
                    pagesCount = await getPageSlideCount(deviceId, entry);
                  }
                }
                
                if (pagesCount > 0) {
                  const updateStmt = db.prepare(`
                    UPDATE files_metadata
                    SET pages_count = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE device_id = ? AND safe_name = ?
                  `);
                  updateStmt.run(pagesCount, deviceId, entry);
                  logger.info(`[Migration] Updated pages_count for ${deviceId}/${entry}: ${pagesCount}`);
                  totalMigrated++;
                }
              } catch (err) {
                logger.error(`[Migration] Error updating pages_count for ${deviceId}/${entry}`, {
                  error: err.message,
                  stack: err.stack
                });
                totalErrors++;
              }
            }
          }
          continue; // Уже есть в БД
        }
        
        // Если записи нет, создаем новую
        try {
          let contentType = 'file';
          let pagesCount = 0;
          const ext = path.extname(entry).toLowerCase();
          
          if (stat.isDirectory()) {
            contentType = 'folder';
            pagesCount = await getFolderImagesCount(deviceId, entry);
          } else if (ext === '.pdf') {
            contentType = 'pdf';
            pagesCount = await getPageSlideCount(deviceId, entry);
          } else if (ext === '.pptx') {
            contentType = 'pptx';
            pagesCount = await getPageSlideCount(deviceId, entry);
          } else {
            continue; // Не статический контент
          }
          
          // Получаем оригинальное имя
          const originalName = fileNamesMap[deviceId]?.[entry] || entry;
          
          // Сохраняем в БД
          saveFileMetadata({
            deviceId,
            safeName: entry,
            originalName: contentType === 'pdf' || contentType === 'pptx' 
              ? originalName.replace(/\.(pdf|pptx)$/i, '') 
              : originalName,
            filePath: entryPath,
            fileSize: stat.isFile() ? stat.size : 0,
            md5Hash: '', // Без дедупликации для статического контента
            partialMd5: null,
            mimeType: contentType === 'pdf' ? 'application/pdf' :
                     contentType === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' :
                     null,
            videoParams: {},
            audioParams: {},
            fileMtime: stat.mtimeMs,
            contentType,
            streamUrl: null,
            streamProtocol: 'auto',
            pagesCount
          });
          
          logger.info(`[Migration] Migrated ${contentType}: ${deviceId}/${entry} (${pagesCount} pages/images)`);
          totalMigrated++;
          
        } catch (err) {
          logger.error(`[Migration] Error migrating ${deviceId}/${entry}`, {
            error: err.message,
            stack: err.stack
          });
          totalErrors++;
        }
      }
    }
    
    logger.info(`[Migration] ✅ Migration completed: ${totalMigrated} items migrated, ${totalErrors} errors`);
    
  } catch (error) {
    logger.error('[Migration] ❌ Migration failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Запускаем миграцию
migrateStaticContent()
  .then(() => {
    logger.info('[Migration] Migration script finished');
    process.exit(0);
  })
  .catch(err => {
    logger.error('[Migration] Migration script failed', {
      error: err.message,
      stack: err.stack
    });
    process.exit(1);
  });

