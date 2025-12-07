#!/usr/bin/env node
/**
 * Утилита для обработки существующих MP4 файлов с faststart
 * 
 * Использование:
 *   node dev/scripts/process-existing-mp4-faststart.js [deviceId] [--all]
 * 
 * Примеры:
 *   node dev/scripts/process-existing-mp4-faststart.js 001TV    # Обработать файлы устройства 001TV
 *   node dev/scripts/process-existing-mp4-faststart.js --all   # Обработать все файлы всех устройств
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyFaststart, needsFaststart } from '../src/video/mp4-faststart.js';
import { getDeviceFilesMetadata } from '../src/database/files-metadata.js';
import { initDatabase, getDatabase } from '../src/database/database.js';
import logger from '../src/utils/logger.js';
import { ROOT } from '../src/config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Переходим в корень проекта
process.chdir(projectRoot);

// Инициализируем БД
const DB_PATH = path.join(ROOT, 'config', 'main.db');
initDatabase(DB_PATH);
logger.info(`[Faststart Batch] База данных инициализирована: ${DB_PATH}`);

async function processDeviceFiles(deviceId) {
  logger.info(`[Faststart Batch] Обработка файлов устройства: ${deviceId}`);
  
  const deviceFiles = getDeviceFilesMetadata(deviceId);
  const mp4Files = deviceFiles.filter(f => {
    const ext = path.extname(f.safe_name).toLowerCase();
    return (ext === '.mp4' || ext === '.m4v' || ext === '.m4a') && 
           (f.mime_type?.startsWith('video/') || f.mime_type?.startsWith('audio/'));
  });

  logger.info(`[Faststart Batch] Найдено ${mp4Files.length} MP4 файлов для устройства ${deviceId}`);

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of mp4Files) {
    try {
      if (!fs.existsSync(file.file_path)) {
        logger.warn(`[Faststart Batch] Файл не найден: ${file.file_path}`);
        skipped++;
        continue;
      }

      // Проверяем нужна ли обработка
      const needs = await needsFaststart(file.file_path);
      if (!needs) {
        logger.debug(`[Faststart Batch] Файл уже оптимизирован: ${file.safe_name}`);
        skipped++;
        continue;
      }

      logger.info(`[Faststart Batch] Обработка: ${file.safe_name} (${(file.file_size / 1024 / 1024).toFixed(2)} MB)`);
      
      const success = await applyFaststart(file.file_path, { checkFirst: false });
      if (success) {
        processed++;
        logger.info(`[Faststart Batch] ✅ Обработан: ${file.safe_name}`);
      } else {
        skipped++;
        logger.warn(`[Faststart Batch] ⚠️ Пропущен: ${file.safe_name}`);
      }
    } catch (error) {
      errors++;
      logger.error(`[Faststart Batch] ❌ Ошибка обработки: ${file.safe_name}`, {
        error: error.message
      });
    }
  }

  logger.info(`[Faststart Batch] Устройство ${deviceId}: обработано ${processed}, пропущено ${skipped}, ошибок ${errors}`);
  
  return { processed, skipped, errors };
}

async function processAllDevices() {
  logger.info('[Faststart Batch] Обработка всех файлов всех устройств');
  
  // Получаем все MP4 файлы из БД
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM files_metadata 
    WHERE (mime_type LIKE 'video/%' OR mime_type LIKE 'audio/%')
    AND (safe_name LIKE '%.mp4' OR safe_name LIKE '%.m4v' OR safe_name LIKE '%.m4a')
    ORDER BY device_id, safe_name
  `);
  
  const allFiles = stmt.all();
  const mp4Files = allFiles.filter(f => {
    const ext = path.extname(f.safe_name).toLowerCase();
    return (ext === '.mp4' || ext === '.m4v' || ext === '.m4a') && 
           (f.mime_type?.startsWith('video/') || f.mime_type?.startsWith('audio/'));
  });

  // Группируем по устройствам
  const byDevice = {};
  for (const file of mp4Files) {
    if (!byDevice[file.device_id]) {
      byDevice[file.device_id] = [];
    }
    byDevice[file.device_id].push(file);
  }

  logger.info(`[Faststart Batch] Найдено ${mp4Files.length} MP4 файлов в ${Object.keys(byDevice).length} устройствах`);

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const deviceId of Object.keys(byDevice)) {
    const result = await processDeviceFiles(deviceId);
    totalProcessed += result.processed;
    totalSkipped += result.skipped;
    totalErrors += result.errors;
  }

  logger.info(`[Faststart Batch] ИТОГО: обработано ${totalProcessed}, пропущено ${totalSkipped}, ошибок ${totalErrors}`);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Использование:
  node scripts/process-existing-mp4-faststart.js [deviceId] [--all]

Примеры:
  node scripts/process-existing-mp4-faststart.js 001TV    # Обработать файлы устройства 001TV
  node scripts/process-existing-mp4-faststart.js --all    # Обработать все файлы всех устройств
    `);
    process.exit(0);
  }

  try {
    if (args[0] === '--all') {
      await processAllDevices();
    } else {
      const deviceId = args[0];
      await processDeviceFiles(deviceId);
    }
    
    logger.info('[Faststart Batch] Обработка завершена');
    process.exit(0);
  } catch (error) {
    logger.error('[Faststart Batch] Критическая ошибка', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

main();

