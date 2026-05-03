#!/usr/bin/env node
/**
 * Скрипт для проверки соответствия файлов в базе данных и на диске
 * Находит:
 * - Файлы в БД, которых нет на диске
 * - Файлы на диске, которых нет в БД
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, getDatabase, closeDatabase } from '../../src/database/database.js';
import { getDataRoot } from '../../src/config/settings-manager.js';
import logger from '../../src/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

// Инициализация БД
const DB_PATH = path.join(ROOT, 'config', 'main.db');
initDatabase(DB_PATH);

/**
 * Рекурсивно получить все файлы из директории
 */
function getAllFiles(dirPath, fileList = []) {
  if (!fs.existsSync(dirPath)) {
    return fileList;
  }

  const files = fs.readdirSync(dirPath);
  
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    try {
      const stat = fs.statSync(filePath);
      
      if (stat.isDirectory()) {
        // Рекурсивно обходим поддиректории
        getAllFiles(filePath, fileList);
      } else if (stat.isFile()) {
        fileList.push(filePath);
      }
    } catch (error) {
      console.warn(`[WARN] Не удалось прочитать: ${filePath} - ${error.message}`);
    }
  }
  
  return fileList;
}

/**
 * Получить все файлы из БД
 */
function getFilesFromDB() {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT 
      device_id,
      safe_name,
      original_name,
      file_path,
      content_type,
      file_size,
      md5_hash
    FROM files_metadata
    WHERE content_type != 'streaming'
    ORDER BY device_id, safe_name
  `);
  
  return stmt.all();
}

/**
 * Получить все устройства и их папки
 */
function getDevices() {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT device_id, folder
    FROM devices
    ORDER BY device_id
  `);
  
  return stmt.all();
}

/**
 * Основная функция проверки
 */
async function checkFiles() {
  console.log('='.repeat(80));
  console.log('Проверка соответствия файлов в базе данных и на диске');
  console.log('='.repeat(80));
  console.log();

  const dataRoot = getDataRoot();
  const contentDir = path.join(dataRoot, 'content');
  
  console.log(`📁 Корневая папка данных: ${dataRoot}`);
  console.log(`📁 Папка контента: ${contentDir}`);
  console.log();

  // 1. Получаем файлы из БД
  console.log('📊 Загрузка файлов из базы данных...');
  const dbFiles = getFilesFromDB();
  console.log(`   Найдено записей в БД: ${dbFiles.length}`);
  console.log();

  // 2. Получаем устройства
  const devices = getDevices();
  console.log(`📱 Найдено устройств: ${devices.length}`);
  console.log();

  // 3. Сканируем файлы на диске
  console.log('🔍 Сканирование файлов на диске...');
  const diskFiles = getAllFiles(contentDir);
  console.log(`   Найдено файлов на диске: ${diskFiles.length}`);
  console.log();

  // 4. Создаем наборы для сравнения
  const dbFilePaths = new Set();
  const dbFilePathsNormalized = new Map(); // normalized -> original
  const diskFilePaths = new Set();
  
  // Нормализуем пути файлов из БД
  for (const file of dbFiles) {
    if (file.file_path) {
      const normalized = path.resolve(file.file_path);
      dbFilePaths.add(normalized);
      dbFilePathsNormalized.set(normalized, file.file_path);
    }
  }

  // Нормализуем пути файлов на диске
  for (const filePath of diskFiles) {
    const normalized = path.resolve(filePath);
    diskFilePaths.add(normalized);
  }

  // 5. Находим файлы в БД, которых нет на диске
  console.log('🔍 Проверка файлов из БД на наличие на диске...');
  const missingOnDisk = [];
  
  for (const file of dbFiles) {
    if (!file.file_path) {
      continue;
    }
    
    const normalized = path.resolve(file.file_path);
    if (!diskFilePaths.has(normalized)) {
      missingOnDisk.push({
        deviceId: file.device_id,
        safeName: file.safe_name,
        originalName: file.original_name,
        filePath: file.file_path,
        normalizedPath: normalized,
        fileSize: file.file_size,
        contentType: file.content_type
      });
    }
  }

  console.log(`   Файлов в БД, которых нет на диске: ${missingOnDisk.length}`);
  console.log();

  // 6. Находим файлы на диске, которых нет в БД
  console.log('🔍 Проверка файлов на диске на наличие в БД...');
  const missingInDB = [];
  
  for (const filePath of diskFiles) {
    const normalized = path.resolve(filePath);
    if (!dbFilePaths.has(normalized)) {
      try {
        const stat = fs.statSync(filePath);
        missingInDB.push({
          filePath: filePath,
          normalizedPath: normalized,
          fileSize: stat.size,
          mtime: stat.mtime
        });
      } catch (error) {
        console.warn(`[WARN] Не удалось получить информацию о файле: ${filePath}`);
      }
    }
  }

  console.log(`   Файлов на диске, которых нет в БД: ${missingInDB.length}`);
  console.log();

  // 7. Выводим результаты
  console.log('='.repeat(80));
  console.log('РЕЗУЛЬТАТЫ ПРОВЕРКИ');
  console.log('='.repeat(80));
  console.log();

  if (missingOnDisk.length > 0) {
    console.log(`❌ Файлы в БД, которых НЕТ на диске (${missingOnDisk.length}):`);
    console.log('-'.repeat(80));
    
    // Группируем по устройствам
    const byDevice = {};
    for (const file of missingOnDisk) {
      if (!byDevice[file.deviceId]) {
        byDevice[file.deviceId] = [];
      }
      byDevice[file.deviceId].push(file);
    }
    
    for (const [deviceId, files] of Object.entries(byDevice)) {
      console.log(`\n  📱 Устройство: ${deviceId} (${files.length} файлов)`);
      for (const file of files.slice(0, 10)) { // Показываем первые 10
        console.log(`     - ${file.originalName || file.safeName}`);
        console.log(`       Путь: ${file.filePath}`);
        console.log(`       Размер: ${(file.fileSize / 1024 / 1024).toFixed(2)} MB`);
      }
      if (files.length > 10) {
        console.log(`     ... и еще ${files.length - 10} файлов`);
      }
    }
    console.log();
  } else {
    console.log('✅ Все файлы из БД найдены на диске');
    console.log();
  }

  if (missingInDB.length > 0) {
    console.log(`⚠️  Файлы на диске, которых НЕТ в БД (${missingInDB.length}):`);
    console.log('-'.repeat(80));
    
    // Группируем по папкам устройств
    const byDeviceFolder = {};
    for (const file of missingInDB) {
      // Пытаемся определить папку устройства
      const relativePath = path.relative(contentDir, file.filePath);
      const parts = relativePath.split(path.sep);
      const deviceFolder = parts[0] || 'unknown';
      
      if (!byDeviceFolder[deviceFolder]) {
        byDeviceFolder[deviceFolder] = [];
      }
      byDeviceFolder[deviceFolder].push(file);
    }
    
    for (const [folder, files] of Object.entries(byDeviceFolder)) {
      console.log(`\n  📁 Папка: ${folder} (${files.length} файлов)`);
      for (const file of files.slice(0, 10)) { // Показываем первые 10
        const relativePath = path.relative(contentDir, file.filePath);
        console.log(`     - ${relativePath}`);
        console.log(`       Размер: ${(file.fileSize / 1024 / 1024).toFixed(2)} MB`);
      }
      if (files.length > 10) {
        console.log(`     ... и еще ${files.length - 10} файлов`);
      }
    }
    console.log();
  } else {
    console.log('✅ Все файлы на диске найдены в БД');
    console.log();
  }

  // 8. Статистика
  console.log('='.repeat(80));
  console.log('СТАТИСТИКА');
  console.log('='.repeat(80));
  console.log();
  
  const totalDBFiles = dbFiles.length;
  const totalDiskFiles = diskFiles.length;
  const matchingFiles = totalDBFiles - missingOnDisk.length;
  
  console.log(`Всего записей в БД: ${totalDBFiles}`);
  console.log(`Всего файлов на диске: ${totalDiskFiles}`);
  console.log(`Соответствующих файлов: ${matchingFiles}`);
  console.log(`Отсутствует на диске: ${missingOnDisk.length}`);
  console.log(`Отсутствует в БД: ${missingInDB.length}`);
  console.log();

  // 9. Анализ дедупликации (файлы, на которые ссылаются несколько устройств)
  console.log('🔍 Анализ дедупликации...');
  const fileReferences = new Map(); // file_path -> [devices]
  
  for (const file of dbFiles) {
    if (file.file_path && diskFilePaths.has(path.resolve(file.file_path))) {
      const normalized = path.resolve(file.file_path);
      if (!fileReferences.has(normalized)) {
        fileReferences.set(normalized, []);
      }
      fileReferences.get(normalized).push({
        deviceId: file.device_id,
        safeName: file.safe_name,
        originalName: file.original_name
      });
    }
  }
  
  const sharedFiles = [];
  for (const [filePath, devices] of fileReferences.entries()) {
    if (devices.length > 1) {
      sharedFiles.push({ filePath, devices });
    }
  }
  
  if (sharedFiles.length > 0) {
    console.log(`   Найдено файлов с дедупликацией (используются несколькими устройствами): ${sharedFiles.length}`);
  } else {
    console.log(`   Дедупликация не обнаружена (каждый файл используется одним устройством)`);
  }
  console.log();

  // 10. Попытка найти альтернативные пути для отсутствующих файлов
  if (missingOnDisk.length > 0) {
    console.log('🔍 Поиск альтернативных путей для отсутствующих файлов...');
    const alternativesFound = [];
    
    for (const missing of missingOnDisk.slice(0, 10)) { // Проверяем первые 10
      const fileName = path.basename(missing.filePath);
      
      // Ищем файлы с таким же именем на диске
      const foundOnDisk = diskFiles.filter(diskFile => {
        return path.basename(diskFile) === fileName;
      });
      
      if (foundOnDisk.length > 0) {
        alternativesFound.push({
          missing: missing,
          alternatives: foundOnDisk
        });
      }
    }
    
    if (alternativesFound.length > 0) {
      console.log(`   Найдено возможных альтернатив: ${alternativesFound.length}`);
      console.log();
      console.log('   Возможные совпадения (файл может быть в другом месте):');
      for (const alt of alternativesFound.slice(0, 5)) {
        console.log(`     ${alt.missing.originalName || alt.missing.safeName}`);
        console.log(`       Ожидался: ${alt.missing.filePath}`);
        for (const alternative of alt.alternatives) {
          console.log(`       Найден:  ${alternative}`);
        }
      }
      if (alternativesFound.length > 5) {
        console.log(`     ... и еще ${alternativesFound.length - 5} возможных совпадений`);
      }
      console.log();
    } else {
      console.log('   Альтернативные пути не найдены');
      console.log();
    }
  }

  // 11. Дополнительная информация
  if (missingOnDisk.length > 0 || missingInDB.length > 0) {
    console.log('='.repeat(80));
    console.log('РЕКОМЕНДАЦИИ');
    console.log('='.repeat(80));
    console.log();
    
    if (missingOnDisk.length > 0) {
      console.log('⚠️  Файлы в БД, которых нет на диске:');
      console.log(`   - Найдено ${missingOnDisk.length} отсутствующих файлов`);
      console.log('   - Возможно, файлы были удалены вручную или перемещены');
      console.log('   - Можно удалить записи из БД с помощью функции cleanupMissingFiles:');
      console.log('     В коде: cleanupMissingFiles({ deviceId: "device_id", dryRun: false })');
      console.log();
    }
    
    if (missingInDB.length > 0) {
      console.log('⚠️  Файлы на диске, которых нет в БД:');
      console.log(`   - Найдено ${missingInDB.length} файлов без записей в БД`);
      console.log('   - Эти файлы не отображаются в интерфейсе');
      console.log('   - Можно добавить их в БД через интерфейс (пересканировать устройство)');
      
      // Проверяем системные файлы
      const systemFiles = missingInDB.filter(f => {
        const name = path.basename(f.filePath);
        return name.startsWith('.') || name.includes('optimizing') || name.includes('tmp');
      });
      
      if (systemFiles.length > 0) {
        console.log(`   - Внимание: ${systemFiles.length} из них выглядят как системные/временные файлы`);
        console.log('     (можно безопасно удалить)');
      }
      console.log();
    }
  }

  // 12. Экспорт результатов в файл (опционально)
  const exportResults = process.env.EXPORT_RESULTS === 'true';
  if (exportResults) {
    const resultsFile = path.join(ROOT, 'logs', 'file-check-results.json');
    const results = {
      timestamp: new Date().toISOString(),
      dataRoot,
      contentDir,
      statistics: {
        totalDBFiles,
        totalDiskFiles,
        matchingFiles,
        missingOnDisk: missingOnDisk.length,
        missingInDB: missingInDB.length
      },
      missingOnDisk: missingOnDisk.map(f => ({
        deviceId: f.deviceId,
        safeName: f.safeName,
        originalName: f.originalName,
        filePath: f.filePath,
        fileSize: f.fileSize
      })),
      missingInDB: missingInDB.map(f => ({
        filePath: f.filePath,
        fileSize: f.fileSize
      })),
      sharedFiles: sharedFiles.map(f => ({
        filePath: f.filePath,
        devices: f.devices.length,
        deviceList: f.devices.map(d => d.deviceId)
      }))
    };
    
    try {
      const logsDir = path.dirname(resultsFile);
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2), 'utf-8');
      console.log(`💾 Результаты сохранены в: ${resultsFile}`);
      console.log();
    } catch (error) {
      console.warn(`⚠️  Не удалось сохранить результаты в файл: ${error.message}`);
    }
  }

  console.log('='.repeat(80));
}

// Запуск проверки
try {
  await checkFiles();
} catch (error) {
  console.error('❌ Ошибка при проверке файлов:', error);
  process.exit(1);
} finally {
  closeDatabase();
}

