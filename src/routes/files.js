/**
 * API Routes для управления файлами устройств
 * @module routes/files
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DEVICES, ALLOWED_EXT } from '../config/constants.js';
import { sanitizeDeviceId, isSystemFile } from '../utils/sanitize.js';
import { extractZipToFolder, getFolderImagesCount } from '../converters/folder-converter.js';
import { makeSafeFolderName } from '../utils/transliterate.js';
import { scanDeviceFiles } from '../utils/file-scanner.js';
import { uploadLimiter, deleteLimiter } from '../middleware/rate-limit.js';
import { auditLog, AuditAction } from '../utils/audit-logger.js';
import logger, { logFile, logSecurity } from '../utils/logger.js';
import { getCachedResolution, clearResolutionCache } from '../video/resolution-cache.js';
import { processUploadedFilesAsync } from '../utils/file-metadata-processor.js';
import { getFileMetadata, deleteFileMetadata, getDeviceFilesMetadata, saveFileMetadata, countFileReferences, updateFileOriginalName } from '../database/files-metadata.js';

const router = express.Router();

/**
 * Копировать папку физически (асинхронно через streams)
 * Для PPTX/PDF/изображений которые должны оставаться в /content/{device}/
 */
async function copyFolderPhysically(sourceId, targetId, folderName, move, devices, fileNamesMap, saveFileNamesMap, io, res) {
  const sourceFolder = path.join(DEVICES, devices[sourceId].folder);
  const targetFolder = path.join(DEVICES, devices[targetId].folder);
  
  const sourcePath = path.join(sourceFolder, folderName);
  const targetPath = path.join(targetFolder, folderName);
  
  if (fs.existsSync(targetPath)) {
    return res.status(409).json({ error: 'folder already exists on target' });
  }
  
  try {
    // Асинхронное копирование папки
    logFile('info', '📁 Copying folder (async)', { sourceId, targetId, folderName });
    
    await fs.promises.cp(sourcePath, targetPath, { recursive: true });
    
    // Устанавливаем права
    await fs.promises.chmod(targetPath, 0o755);
    
    // Копируем маппинг
    if (fileNamesMap[sourceId]?.[folderName]) {
      if (!fileNamesMap[targetId]) fileNamesMap[targetId] = {};
      fileNamesMap[targetId][folderName] = fileNamesMap[sourceId][folderName];
      saveFileNamesMap(fileNamesMap);
    }
    
    // Если move - удаляем из источника
    if (move) {
      await fs.promises.rm(sourcePath, { recursive: true, force: true });
      if (fileNamesMap[sourceId]?.[folderName]) {
        delete fileNamesMap[sourceId][folderName];
        saveFileNamesMap(fileNamesMap);
      }
    }
    
    // Обновляем оба устройства
    updateDeviceFilesFromDB(targetId, devices, fileNamesMap);
    if (move) updateDeviceFilesFromDB(sourceId, devices, fileNamesMap);
    
    io.emit('devices/updated');
    
    logFile('info', `✅ Folder ${move ? 'moved' : 'copied'} successfully`, {
      sourceDevice: sourceId,
      targetDevice: targetId,
      folderName
    });
    
    res.json({ 
      ok: true, 
      action: move ? 'moved' : 'copied', 
      file: folderName, 
      from: sourceId, 
      to: targetId,
      type: 'folder'
    });
    
  } catch (e) {
    logger.error('[copy-folder] Error', { error: e.message, sourceId, targetId, folderName });
    return res.status(500).json({ error: 'folder copy failed', detail: e.message });
  }
}

/**
 * Обновить список файлов устройства из БД + папки
 * @param {string} deviceId - ID устройства
 * @param {Object} devices - Объект devices
 * @param {Object} fileNamesMap - Маппинг имен
 */
export function updateDeviceFilesFromDB(deviceId, devices, fileNamesMap) {
  const device = devices[deviceId];
  if (!device) return;
  
  // 1. Получаем файлы из БД (обычные файлы)
  const filesMetadata = getDeviceFilesMetadata(deviceId);
  
  // КРИТИЧНО: Проверяем существование файлов по путям из БД
  // После миграции путей файлы должны существовать по новым путям
  const existingMetadata = filesMetadata.filter(f => {
    if (!f.file_path) {
      logger.warn(`[updateDeviceFilesFromDB] File metadata missing file_path`, { deviceId, safeName: f.safe_name });
      return false;
    }
    
    const exists = fs.existsSync(f.file_path);
    if (!exists) {
      logger.warn(`[updateDeviceFilesFromDB] File not found at path`, {
        deviceId,
        safeName: f.safe_name,
        filePath: f.file_path
      });
    }
    return exists;
  });
  
  const missingCount = filesMetadata.length - existingMetadata.length;
  if (missingCount > 0) {
    logger.warn(`[updateDeviceFilesFromDB] ${deviceId}: ${missingCount} files from DB not found physically`, {
      deviceId,
      missingCount,
      totalInDB: filesMetadata.length,
      existing: existingMetadata.length,
      missingFiles: filesMetadata.filter(f => !existingMetadata.includes(f)).map(f => f.safe_name)
    });
  }
  
  // 2. Сканируем папку устройства для PDF/PPTX/image папок
  const deviceFolder = path.join(DEVICES, device.folder);
  const filesInFolders = new Set(); // Файлы которые находятся внутри папок
  const folders = [];
  
  if (fs.existsSync(deviceFolder)) {
    const folderEntries = fs.readdirSync(deviceFolder);
    for (const entry of folderEntries) {
      if (entry.startsWith('.')) continue; // Пропускаем скрытые
      
      const entryPath = path.join(deviceFolder, entry);
      try {
        const stat = fs.statSync(entryPath);
        
        if (stat.isDirectory()) {
          // Это папка - добавляем её
          folders.push(entry);
          
          // КРИТИЧНО: Сканируем файлы внутри папки
          // Чтобы исключить их из списка БД (избежать дубликатов)
          try {
            const filesInThisFolder = fs.readdirSync(entryPath);
            filesInThisFolder.forEach(f => filesInFolders.add(f));
          } catch (e) {
            // Игнорируем ошибки чтения папки
          }
        }
      } catch (e) {
        // Игнорируем ошибки доступа к файлам
      }
    }
  }
  
  // 3. Фильтруем файлы из БД: исключаем те что находятся в папках устройства
  // Используем existingMetadata (только существующие файлы) вместо filesMetadata
  const filteredMetadata = existingMetadata.filter(f => !filesInFolders.has(f.safe_name));
  
  const nameMap = fileNamesMap[deviceId] || {};
  let files = filteredMetadata.map(f => f.safe_name);
  let fileNames = filteredMetadata.map(f => f.original_name || nameMap[f.safe_name] || f.safe_name);
  
  // 4. Добавляем папки
  folders.forEach(folder => {
    files.push(folder);
    fileNames.push(nameMap[folder] || folder);
  });
  
  device.files = files;
  device.fileNames = fileNames;
  
  logger.info(`[updateDeviceFilesFromDB] ${deviceId}: БД=${filteredMetadata.length} (существует=${existingMetadata.length}, отсутствует=${missingCount}), Папки=${folders.length}, Всего=${files.length}`);
  if (folders.length > 0) {
    logger.info(`[updateDeviceFilesFromDB] Папки: ${folders.join(', ')}`);
  }
  if (existingMetadata.length !== filteredMetadata.length) {
    logger.info(`[updateDeviceFilesFromDB] Скрыто ${existingMetadata.length - filteredMetadata.length} файлов (в папках)`);
  }
  if (missingCount > 0) {
    logger.warn(`[updateDeviceFilesFromDB] Отсутствующие файлы из БД (возможно миграция путей выполнена, но файлы не перемещены): ${filesMetadata.filter(f => !existingMetadata.includes(f)).map(f => f.safe_name).join(', ')}`);
  }
}

/**
 * Настройка роутера для файлов
 * @param {Object} deps - Зависимости
 * @returns {express.Router} Настроенный роутер
 */
export function createFilesRouter(deps) {
  const { 
    devices, 
    io, 
    fileNamesMap, 
    saveFileNamesMap, 
    upload,
    autoConvertFileWrapper,
    autoOptimizeVideoWrapper,
    checkVideoParameters,
    getFileStatus
  } = deps;
  
  // POST /api/devices/:id/upload - Загрузка файлов
  router.post('/:id/upload', uploadLimiter, async (req, res, next) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'invalid device id' });
    }
    
    if (!devices[id]) {
      return res.status(404).json({ error: 'device not found' });
    }
    
    upload.array('files', 50)(req, res, async (err) => {
      if (err) {
        // ИСПРАВЛЕНО: Специфичная обработка ошибок загрузки
        if (err.code === 'ENOSPC') {
          logger.error('[Upload] No space left on device', { error: err.message });
          return res.status(507).json({ error: 'No space left on device' });
        } else if (err.code === 'LIMIT_FILE_SIZE') {
          logger.warn('[Upload] File size limit exceeded', { error: err.message });
          return res.status(413).json({ error: 'File size limit exceeded' });
        } else if (err.message === 'unsupported type') {
          return res.status(415).json({ error: 'Unsupported file type' });
        }
        
        logger.error('[Upload] Upload error', { error: err.message, code: err.code });
        return res.status(400).json({ error: err.message });
      }
      
      const uploaded = (req.files || []).map(f => f.filename);
      const folderName = req.body.folderName; // Имя папки если загружается через выбор папки
      
      // ИСПРАВЛЕНО: Перемещаем PDF/PPTX/ZIP в /content/{device}/
      // Только видео/аудио/одиночные изображения остаются в /content/ для дедупликации
      
      // Проверяем есть ли PDF/PPTX/ZIP среди загруженных файлов
      const documentsToMove = req.files ? req.files.filter(file => {
        const ext = path.extname(file.filename).toLowerCase();
        return ext === '.pdf' || ext === '.pptx' || ext === '.zip';
      }) : [];
      
      // Перемещаем документы в папку устройства (НЕ в подпапку!)
      if (documentsToMove.length > 0) {
        const deviceFolder = path.join(DEVICES, devices[id].folder);
        if (!fs.existsSync(deviceFolder)) {
          fs.mkdirSync(deviceFolder, { recursive: true });
        }
        
        for (const file of documentsToMove) {
          try {
            const sourcePath = path.join(DEVICES, file.filename);  // Из /content/
            const targetPath = path.join(deviceFolder, file.filename);  // В /content/{device}/{file}
            
            fs.renameSync(sourcePath, targetPath);
            fs.chmodSync(targetPath, 0o644);
            logger.info(`[upload] 📄 Файл перемещен: ${file.filename} -> ${devices[id].folder}/`);
          } catch (e) {
            logger.warn(`[upload] ⚠️ Ошибка перемещения ${file.filename}`, { error: e.message, stack: e.stack });
          }
        }
        
        // КРИТИЧНО: Автоконвертация PDF/PPTX (autoConvertFile сама создаст папку)
        for (const file of documentsToMove) {
          const ext = path.extname(file.filename).toLowerCase();
          if (ext === '.pdf' || ext === '.pptx') {
            logger.info(`[upload] 🔄 Запуск конвертации: ${file.filename}`);
            autoConvertFileWrapper(id, file.filename).catch(err => {
              logger.error(`[upload] ❌ Ошибка конвертации ${file.filename}`, { error: err.message, stack: err.stack });
            });
          }
        }
      }
      
      // Если это загрузка папки - создаем в /content/{device}/ (для изображений)
      if (folderName && req.files && req.files.length > 0) {
        logger.info(`[upload] 📁 Обнаружена загрузка папки: ${folderName}`);
        
        // Создаем безопасное имя папки через транслитерацию
        const safeFolderName = makeSafeFolderName(folderName);
        const deviceFolder = path.join(DEVICES, devices[id].folder);
        const targetFolder = path.join(deviceFolder, safeFolderName);
        
        logger.info(`[upload] 📝 Имя папки: "${folderName}" → "${safeFolderName}"`);
        
        if (!fs.existsSync(targetFolder)) {
          fs.mkdirSync(targetFolder, { recursive: true });
          fs.chmodSync(targetFolder, 0o755);
        }
        
        // Перемещаем файлы из /content/ в /content/{device}/{folder}/
        let movedCount = 0;
        let errorCount = 0;
        
        for (const file of req.files) {
          try {
            const sourcePath = path.join(DEVICES, file.filename);  // Из /content/
            
            // Получаем оригинальное имя файла из originalname
            // originalname может содержать путь "folder/subfolder/file.jpg"
            let targetFileName = file.originalname;
            if (targetFileName.includes('/')) {
              // Убираем путь папки, оставляем только имя файла
              const parts = targetFileName.split('/');
              targetFileName = parts[parts.length - 1];
            }
            
            const targetPath = path.join(targetFolder, targetFileName);
            
            // КРИТИЧНО: Если файл уже существует в целевой папке - удаляем старый
            if (fs.existsSync(targetPath)) {
              logFile('info', `🔄 Файл уже существует, заменяем: ${targetFileName}`, { fileName: targetFileName, deviceId: id });
              fs.unlinkSync(targetPath);
            }
            
            // КРИТИЧНО: Проверяем существует ли исходный файл для перемещения
            // Может не существовать если файл с таким именем уже был в shared storage
            if (!fs.existsSync(sourcePath)) {
              logFile('info', `⚠️ Исходный файл не найден: ${file.filename}`, { fileName: file.filename, deviceId: id });
              
              // Возможно файл с таким именем уже существует в shared storage (/content/)
              // Для папок нужно СКОПИРОВАТЬ его, а не переместить
              const sharedFile = path.join(DEVICES, targetFileName);
              if (fs.existsSync(sharedFile)) {
                logFile('info', `🔄 Файл найден в shared storage, копируем: ${targetFileName}`, { fileName: targetFileName, deviceId: id });
                
                // Копируем из shared storage в папку
                fs.copyFileSync(sharedFile, targetPath);
                fs.chmodSync(targetPath, 0o644);
                logFile('info', `✅ Скопирован из shared: ${targetFileName} -> ${safeFolderName}/${targetFileName}`, { fileName: targetFileName, folderName: safeFolderName, deviceId: id });
                movedCount++;
                continue;
              }
              
              // Файл не найден нигде - ошибка
              logFile('warn', `❌ Файл не найден ни в uploads, ни в shared: ${targetFileName}`, { fileName: targetFileName, deviceId: id });
              errorCount++;
              continue;
            }
            
            // Перемещаем файл
            fs.renameSync(sourcePath, targetPath);
            fs.chmodSync(targetPath, 0o644);
            logFile('info', `✅ Перемещен: ${file.filename} -> ${safeFolderName}/${targetFileName}`, { fileName: file.filename, folderName: safeFolderName, deviceId: id });
            movedCount++;
          } catch (e) {
            errorCount++;
            logger.error('[upload] ❌ Ошибка перемещения файла в папку', { 
              error: e.message, 
              fileName: file.filename,
              originalName: file.originalname,
              deviceId: id,
              folderName: safeFolderName,
              stack: e.stack
            });
            
            // КРИТИЧНО: Если не удалось переместить - НЕ оставляем файл в корне!
            // Удаляем его чтобы не было "потерянных" файлов
            try {
              const sourcePath = path.join(DEVICES, file.filename);
              if (fs.existsSync(sourcePath)) {
                fs.unlinkSync(sourcePath);
                logFile('info', `🗑️ Удален файл который не удалось переместить: ${file.filename}`, { fileName: file.filename, deviceId: id });
              }
            } catch (cleanupErr) {
              logger.error('[upload] Failed to cleanup unmoved file', { 
                error: cleanupErr.message,
                fileName: file.filename,
                stack: cleanupErr.stack
              });
            }
          }
        }
        
        logFile('info', `📁 Папка создана: ${safeFolderName} (${movedCount}/${req.files.length} файлов перемещено${errorCount > 0 ? `, ${errorCount} ошибок` : ''})`, { folderName: safeFolderName, movedCount, totalFiles: req.files.length, errorCount, deviceId: id });
        
        if (errorCount > 0) {
          logger.warn('[upload] Some files failed to move to folder', { 
            deviceId: id,
            folderName: safeFolderName,
            totalFiles: req.files.length,
            movedFiles: movedCount,
            errorCount
          });
        }
        
        // КРИТИЧНО: Frontend передает ПОЛНЫЙ список файлов которые должны быть в папке
        // (включая те что Multer НЕ получил, потому что они уже существуют в shared)
        let allExpectedFiles = [];
        if (req.body.expectedFiles) {
          try {
            allExpectedFiles = JSON.parse(req.body.expectedFiles);
            logFile('info', `📋 Frontend передал список ожидаемых файлов: ${allExpectedFiles.length}`, { deviceId: id, folderName: safeFolderName, expectedFilesCount: allExpectedFiles.length });
          } catch (e) {
            logger.warn('[upload] ⚠️ Не удалось распарсить expectedFiles', { error: e.message, deviceId: id, stack: e.stack });
          }
        }
        
        // Если frontend НЕ передал список (старая версия) - используем req.files
        if (allExpectedFiles.length === 0) {
          logFile('info', '⚠️ Frontend не передал expectedFiles, используем req.files', { deviceId: id, folderName: safeFolderName });
          allExpectedFiles = req.files.map(f => {
            let fileName = f.originalname;
            if (fileName.includes('/')) {
              fileName = fileName.split('/').pop();
            }
            return fileName;
          });
        }
        
        // Проверяем какие файлы реально есть в папке
        const filesInFolder = fs.readdirSync(targetFolder);
        const missingFiles = allExpectedFiles.filter(f => !filesInFolder.includes(f));
        
        logFile('info', `🔍 Проверка папки: ожидалось ${allExpectedFiles.length}, найдено ${filesInFolder.length}, не хватает ${missingFiles.length}`, { deviceId: id, folderName: safeFolderName, expected: allExpectedFiles.length, found: filesInFolder.length, missing: missingFiles.length });
        
        // Копируем недостающие файлы из shared storage
        let copiedFromShared = 0;
        for (const missingFile of missingFiles) {
          const sharedPath = path.join(DEVICES, missingFile);
          if (fs.existsSync(sharedPath)) {
            const targetPath = path.join(targetFolder, missingFile);
            try {
              fs.copyFileSync(sharedPath, targetPath);
              fs.chmodSync(targetPath, 0o644);
              logFile('info', `✅ Скопирован из shared: ${missingFile}`, { fileName: missingFile, deviceId: id, folderName: safeFolderName });
              copiedFromShared++;
            } catch (e) {
              logger.error('[upload] Failed to copy from shared', { 
                error: e.message,
                fileName: missingFile,
                deviceId: id,
                folderName: safeFolderName,
                stack: e.stack
              });
            }
          } else {
            logFile('warn', `⚠️ Файл не найден в shared storage: ${missingFile}`, { fileName: missingFile, deviceId: id, folderName: safeFolderName });
          }
        }
        
        const finalCount = fs.readdirSync(targetFolder).length;
        logFile('info', `📁 Папка готова: ${safeFolderName} (${finalCount} файлов${copiedFromShared > 0 ? `, ${copiedFromShared} скопировано из shared` : ''})`, { deviceId: id, folderName: safeFolderName, finalCount, copiedFromShared });
        
        // Сохраняем маппинг оригинального имени папки
        if (!fileNamesMap[id]) fileNamesMap[id] = {};
        fileNamesMap[id][safeFolderName] = folderName; // Оригинальное имя для отображения
        saveFileNamesMap(fileNamesMap);
        
        // КРИТИЧНО: Обновляем список файлов после создания папки
        updateDeviceFilesFromDB(id, devices, fileNamesMap);
        io.emit('devices/updated');
      } else {
        // КРИТИЧНО: Устанавливаем права 644 на загруженные файлы (кроме PDF/PPTX/ZIP - они уже перемещены)
        for (const file of (req.files || [])) {
          const ext = path.extname(file.filename).toLowerCase();
          // Пропускаем PDF/PPTX/ZIP - для них права уже установлены при перемещении
          if (ext === '.pdf' || ext === '.pptx' || ext === '.zip') continue;
          
          try {
            const filePath = path.join(DEVICES, file.filename);  // В /content/
            fs.chmodSync(filePath, 0o644);
            logFile('info', `✅ Права 644 установлены: ${file.filename}`, { fileName: file.filename, deviceId: id });
          } catch (e) {
            logger.warn(`[upload] ⚠️ Не удалось установить права на ${file.filename}`, { error: e.message, fileName: file.filename, deviceId: id, stack: e.stack });
          }
        }
      }
      
      if (req.originalFileNames && req.originalFileNames.size > 0) {
        if (!fileNamesMap[id]) fileNamesMap[id] = {};
        for (const [safeName, originalName] of req.originalFileNames) {
          fileNamesMap[id][safeName] = originalName;
        }
        saveFileNamesMap(fileNamesMap);
      }
      
      // Маппинг папки уже сохранен выше при создании папки
      
      // Обрабатываем файлы ТОЛЬКО если это не прямая загрузка папки
      if (!folderName) {
        for (const fileName of uploaded) {
          const ext = path.extname(fileName).toLowerCase();
          if (ext === '.pdf' || ext === '.pptx') {
            autoConvertFileWrapper(id, fileName).catch(() => {});
          }
        // Автоматическая обработка ZIP архивов с изображениями
        else if (ext === '.zip') {
          extractZipToFolder(id, fileName).then(result => {
            if (result.success) {
              logFile('info', `📦 ZIP распакован: ${fileName} -> ${result.folderName}/ (${result.imagesCount} изображений)`, { fileName, deviceId: id, folderName: result.folderName, imagesCount: result.imagesCount });
              
              // Сохраняем маппинг оригинального имени папки
              if (result.originalFolderName && result.folderName !== result.originalFolderName) {
                if (!fileNamesMap[id]) fileNamesMap[id] = {};
                fileNamesMap[id][result.folderName] = result.originalFolderName;
                saveFileNamesMap(fileNamesMap);
                logFile('info', `📝 Маппинг папки: "${result.folderName}" → "${result.originalFolderName}"`, { deviceId: id, folderName: result.folderName, originalFolderName: result.originalFolderName });
              }
              
              // Обновляем список файлов после распаковки
              updateDeviceFilesFromDB(id, devices, fileNamesMap);
              io.emit('devices/updated');
            } else {
              logger.error(`[upload] ❌ Ошибка распаковки ZIP ${fileName}`, { fileName, deviceId: id, error: result.error });
            }
          }).catch(err => {
            logger.error(`[upload] ❌ Ошибка обработки ZIP ${fileName}`, { fileName, deviceId: id, error: err.message, stack: err.stack });
          });
        }
          // УДАЛЕНО: Автоматическая оптимизация переносится ПОСЛЕ сохранения метаданных
        }
      }
      
      // Audit log
      if (uploaded.length > 0) {
        await auditLog({
          userId: req.user?.id || null,
          action: AuditAction.FILE_UPLOAD,
          resource: `device:${id}`,
          details: { 
            deviceId: id, 
            filesCount: uploaded.length,
            files: uploaded,
            folderName: folderName || null,
            uploadedBy: req.user?.username || 'anonymous'
          },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          status: 'success'
        });
        logFile('info', 'Files uploaded', { 
          deviceId: id, 
          filesCount: uploaded.length, 
          folderName: folderName || null,
          uploadedBy: req.user?.username || 'anonymous'
        });
        
        // ИСПРАВЛЕНО: Обрабатываем метаданные и ЖДЕМ завершения перед обновлением списка
        // Обрабатываем только обычные файлы (не папки, не PDF/PPTX/ZIP)
        if (!folderName) {
          // Фильтруем файлы: только видео/аудио/изображения (не PDF/PPTX/ZIP)
          const filesToProcess = (req.files || []).filter(file => {
            const ext = path.extname(file.filename).toLowerCase();
            return ext !== '.pdf' && ext !== '.pptx' && ext !== '.zip';
          });
          
          if (filesToProcess.length > 0) {
            try {
              await processUploadedFilesAsync(id, filesToProcess, DEVICES, fileNamesMap);
              logFile('debug', 'File metadata processed successfully', { deviceId: id, filesCount: filesToProcess.length });
            } catch (err) {
              logger.error('Metadata processing failed', { 
                error: err.message, 
                deviceId: id 
              });
            }
          }
          
          // НОВОЕ: Автоматическая оптимизация ПОСЛЕ сохранения метаданных
          // Теперь оптимизатор может прочитать profile из БД!
          for (const fileName of uploaded) {
            const ext = path.extname(fileName).toLowerCase();
            if (['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi'].includes(ext)) {
              autoOptimizeVideoWrapper(id, fileName).then(result => {
                if (result.success) {
                  logFile('info', 'Video processed', { 
                    deviceId: id, 
                    fileName, 
                    optimized: result.optimized 
                  });
                }
              }).catch(err => {
                logger.error('Video optimization failed', { 
                  error: err.message, 
                  deviceId: id, 
                  fileName 
                });
              });
            }
          }
        }
      }
      
      // НОВОЕ: Обновляем список файлов из БД (ПОСЛЕ обработки метаданных)
      updateDeviceFilesFromDB(id, devices, fileNamesMap);
      
      const updatedFiles = devices[id].files || [];
      io.emit('devices/updated');
      
      res.json({ ok: true, files: updatedFiles, uploaded });
    });
  });
  
  // POST /api/devices/:targetId/copy-file - Копирование/перемещение файла между устройствами
  // НОВОЕ: Мгновенное копирование через БД для файлов, физическое для папок
  router.post('/:targetId/copy-file', async (req, res) => {
    const targetId = sanitizeDeviceId(req.params.targetId);
    const { sourceDeviceId, fileName, move } = req.body;
    const sourceId = sanitizeDeviceId(sourceDeviceId);
    
    if (!targetId || !sourceId) {
      return res.status(400).json({ error: 'invalid device ids' });
    }
    
    if (!devices[targetId] || !devices[sourceId]) {
      return res.status(404).json({ error: 'device not found' });
    }
    
    if (!fileName) {
      return res.status(400).json({ error: 'fileName required' });
    }
    
    try {
      // Проверяем это файл или папка
    const sourceFolder = path.join(DEVICES, devices[sourceId].folder);
      const sourcePath = path.join(sourceFolder, fileName);
      
      // Если это папка (PPTX/PDF/изображения) - используем физическое копирование
      if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
        return await copyFolderPhysically(sourceId, targetId, fileName, move, devices, fileNamesMap, saveFileNamesMap, io, res);
    } 
      
      // 1. Получаем метаданные файла из источника (обычный файл)
      const sourceMetadata = getFileMetadata(sourceId, fileName);
      
      if (!sourceMetadata) {
        return res.status(404).json({ error: 'source file not found in database' });
    }
    
      logFile('info', '📋 Copying file metadata', {
        sourceDevice: sourceId,
        targetDevice: targetId,
        fileName,
        filePath: sourceMetadata.file_path,
        md5: sourceMetadata.md5_hash?.substring(0, 12)
      });
      
      // 2. Проверяем не существует ли уже на целевом устройстве
      let targetSafeName = fileName;
      const existingOnTarget = getFileMetadata(targetId, fileName);
      
      if (existingOnTarget) {
        // Если файл существует - генерируем уникальное имя (как в Multer)
        const ext = path.extname(fileName);
        const name = path.basename(fileName, ext);
        const suffix = '_' + crypto.randomBytes(3).toString('hex');
        targetSafeName = `${name}${suffix}${ext}`;
        
        logFile('info', '⚠️ File exists on target, using unique name', {
          original: fileName,
          unique: targetSafeName
        });
        }
        
      // 3. ⚡ МГНОВЕННОЕ КОПИРОВАНИЕ: просто INSERT метаданных с тем же file_path!
      // КРИТИЧНО: Определяем правильное original_name - приоритет у original_name из БД (обновляется при переименовании)
      // Если в БД нет или оно не актуально - проверяем fileNamesMap
      let targetOriginalName = fileName;
      if (sourceMetadata.original_name) {
        // Используем из метаданных БД (самый надежный источник, обновляется при переименовании)
        targetOriginalName = sourceMetadata.original_name;
      } else if (fileNamesMap[sourceId] && fileNamesMap[sourceId][fileName]) {
        // Fallback: используем из fileNamesMap если в БД нет
        targetOriginalName = fileNamesMap[sourceId][fileName];
      }
      
      saveFileMetadata({
        deviceId: targetId,
        safeName: targetSafeName,
        originalName: targetOriginalName,
        filePath: sourceMetadata.file_path,  // ✅ ТОТ ЖЕ физический файл!
        fileSize: sourceMetadata.file_size,
        md5Hash: sourceMetadata.md5_hash,
        partialMd5: sourceMetadata.partial_md5,
        mimeType: sourceMetadata.mime_type,
        videoParams: {
          width: sourceMetadata.video_width,
          height: sourceMetadata.video_height,
          duration: sourceMetadata.video_duration,
          codec: sourceMetadata.video_codec,
          bitrate: sourceMetadata.video_bitrate
        },
        audioParams: {
          codec: sourceMetadata.audio_codec,
          bitrate: sourceMetadata.audio_bitrate,
          channels: sourceMetadata.audio_channels
        },
        fileMtime: sourceMetadata.file_mtime
      });
      
      // 4. КРИТИЧНО: Обновляем fileNamesMap для нового устройства, чтобы отображение работало правильно
      if (!fileNamesMap[targetId]) fileNamesMap[targetId] = {};
      fileNamesMap[targetId][targetSafeName] = targetOriginalName;
      saveFileNamesMap(fileNamesMap);
      
      // 5. Если move - удаляем из источника (только из БД!)
      if (move) {
        deleteFileMetadata(sourceId, fileName);
        
        if (fileNamesMap[sourceId] && fileNamesMap[sourceId][fileName]) {
          delete fileNamesMap[sourceId][fileName];
          if (Object.keys(fileNamesMap[sourceId]).length === 0) {
            delete fileNamesMap[sourceId];
          }
          saveFileNamesMap(fileNamesMap);
        }
        
        logFile('info', '🔄 File moved (metadata only)', {
          from: sourceId,
          to: targetId,
          fileName
        });
      }
      
      // 6. Обновляем devices.files из БД
      updateDeviceFilesFromDB(targetId, devices, fileNamesMap);
      if (move) {
        updateDeviceFilesFromDB(sourceId, devices, fileNamesMap);
      }
      
      io.emit('devices/updated');
      
      logFile('info', `✅ File ${move ? 'moved' : 'copied'} instantly via DB`, {
        sourceDevice: sourceId,
        targetDevice: targetId,
        fileName,
        sharedFilePath: sourceMetadata.file_path,
        timeTaken: '<1ms'
      });
      
      res.json({ 
        ok: true, 
        action: move ? 'moved' : 'copied', 
        file: fileName, 
        from: sourceId, 
        to: targetId,
        instant: true  // Мгновенное копирование!
      });
      
    } catch (e) {
      logger.error('[copy-file] Error', { 
        error: e.message, 
        sourceId, 
        targetId, 
        fileName 
      });
      return res.status(500).json({ error: 'copy/move failed', detail: e.message });
    }
  });
  
  // POST /api/devices/:id/files/:name/rename - Переименование файла или папки
  router.post('/:id/files/:name/rename', express.json(), (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'invalid device id' });
    }
    
    const oldName = req.params.name;
    const { newName } = req.body;
    
    if (!newName) {
      return res.status(400).json({ error: 'newName required' });
    }
    
    const d = devices[id];
    if (!d) {
      return res.status(404).json({ error: 'device not found' });
    }
    
    const deviceFolder = path.join(DEVICES, d.folder);
    
    // НОВОЕ: Проверяем, это медиафайл с metadata в БД?
    const metadata = getFileMetadata(id, oldName);
    if (metadata) {
      // Медиафайл - обновляем только original_name в БД, физический файл НЕ трогаем
      logFile('info', `📝 Обновление originalName в БД: ${oldName} -> ${newName}`, { deviceId: id, oldName, newName });
      updateFileOriginalName(id, oldName, newName);
      
      // КРИТИЧНО: Также обновляем fileNamesMap чтобы при копировании использовалось правильное имя
      if (!fileNamesMap[id]) fileNamesMap[id] = {};
      fileNamesMap[id][oldName] = newName; // safe_name -> original_name (переименованное)
      saveFileNamesMap(fileNamesMap);
      
      logFile('info', `📝 Обновлен fileNamesMap: ${oldName} -> ${newName}`, { deviceId: id, oldName, newName });
      
      // КРИТИЧНО: Если переименованный файл был текущим воспроизводимым - обновляем состояние
      if (devices[id] && devices[id].current && devices[id].current.file === oldName) {
        logger.info(`[RENAME file] Обновляем состояние устройства ${id}, т.к. переименован текущий файл ${oldName} -> ${newName}`);
        devices[id].current.file = newName;
        // Отправляем обновленное состояние на устройство
        io.to(`device:${id}`).emit('player/state', devices[id].current);
      }
      
      // Обновляем список файлов из БД
      updateDeviceFilesFromDB(id, devices, fileNamesMap);
      io.emit('devices/updated');
      return res.json({ success: true, oldName, newName, message: 'File renamed successfully (display name only)' });
    }
    
    // Старая логика для PDF/PPTX/папок - физическое переименование
    let oldPath = path.join(deviceFolder, oldName);
    let isFolder = false;
    let actualOldName = oldName;
    
    // Проверяем, может это PDF/PPTX файл с папкой
    const folderNamePdf = oldName.replace(/\.(pdf|pptx)$/i, '');
    const possiblePdfFolder = path.join(deviceFolder, folderNamePdf);
    
    if (fs.existsSync(possiblePdfFolder) && fs.statSync(possiblePdfFolder).isDirectory()) {
      // Это PDF/PPTX с папкой - переименовываем папку
      oldPath = possiblePdfFolder;
      isFolder = true;
      actualOldName = folderNamePdf;
      logFile('info', `📁 Переименование папки PDF/PPTX: ${folderNamePdf}`, { deviceId: id, oldName, folderNamePdf });
    } 
    // Проверяем, может это папка с изображениями (без расширения)
    else if (!oldName.includes('.')) {
      const folderPath = path.join(deviceFolder, oldName);
      if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
        oldPath = folderPath;
        isFolder = true;
        actualOldName = oldName;
        logFile('info', `📁 Переименование папки с изображениями: ${oldName}`, { deviceId: id, oldName });
      }
    }
    
    if (!fs.existsSync(oldPath)) {
      logFile('error', `❌ Не найден: ${oldPath}`, { deviceId: id, oldName, oldPath });
      return res.status(404).json({ error: 'file not found', path: oldPath });
    }
    
    // Определяем новый путь
    let newPath;
    if (isFolder) {
      // Для папок используем новое имя без расширения
      const newFolderName = newName.replace(/\.(pdf|pptx)$/i, '');
      newPath = path.join(deviceFolder, newFolderName);
    } else {
      newPath = path.join(deviceFolder, newName);
    }
    
    if (fs.existsSync(newPath) && oldPath !== newPath) {
      return res.status(409).json({ error: 'file with this name already exists' });
    }
    
    try {
      logFile('info', `🔄 ${oldPath} -> ${newPath}`, { deviceId: id, oldName, newName, oldPath, newPath });
      fs.renameSync(oldPath, newPath);
      
      // Обновляем маппинг имен
      if (!fileNamesMap[id]) fileNamesMap[id] = {};
      
      // Удаляем старое имя из маппинга
      if (fileNamesMap[id][actualOldName]) {
        delete fileNamesMap[id][actualOldName];
      }
      // Для PDF/PPTX также удаляем маппинг файла
      if (isFolder && oldName.match(/\.(pdf|pptx)$/i)) {
        if (fileNamesMap[id][oldName]) {
          delete fileNamesMap[id][oldName];
        }
      }
      
      // Добавляем новое имя в маппинг
      const finalName = isFolder ? path.basename(newPath) : newName;
      fileNamesMap[id][finalName] = newName;
      
      // Для PDF/PPTX папки также добавляем маппинг для файла с расширением
      if (isFolder) {
        const pdfExt = oldName.match(/\.(pdf|pptx)$/i);
        if (pdfExt) {
          const newFileWithExt = newName;
          fileNamesMap[id][newFileWithExt] = newName;
        }
      }
      
      saveFileNamesMap(fileNamesMap);
      
      // КРИТИЧНО: НЕ пересканируем всё устройство!
      // scanDeviceFiles вернёт ТОЛЬКО файлы на диске (PDF/PPTX/папки)
      // и ПОТЕРЯЕТ медиафайлы из БД!
      
      // Вместо этого обновляем только конкретные записи в d.files и d.fileNames
      // КРИТИЧНО: Если переименованный файл был текущим воспроизводимым - обновляем состояние
      if (devices[id] && devices[id].current && 
          (devices[id].current.file === oldName || devices[id].current.file === actualOldName)) {
        logger.info(`[RENAME file] Обновляем состояние устройства ${id}, т.к. переименован текущий файл ${actualOldName} -> ${finalName}`);
        devices[id].current.file = finalName;
        // Отправляем обновленное состояние на устройство
        io.to(`device:${id}`).emit('player/state', devices[id].current);
      }
      
      // Обновляем список файлов из БД + файловой системы (это перезагрузит весь список)
      updateDeviceFilesFromDB(id, devices, fileNamesMap);
      io.emit('devices/updated');
      res.json({ success: true, oldName: actualOldName, newName: finalName });
    } catch (e) {
      logger.error('[rename] Ошибка', { error: e.message, stack: e.stack, deviceId: id, oldName, newName, oldPath, newPath });
      res.status(500).json({ error: 'rename failed', details: e.message });
    }
  });
  
  // DELETE /api/devices/:id/files/:name - Удаление файла или папки
  router.delete('/:id/files/:name', deleteLimiter, async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'invalid device id' });
    }
    
    const name = req.params.name;
    const d = devices[id];
    
    if (!d) {
      return res.status(404).json({ error: 'device not found' });
    }
    
    const deviceFolder = path.join(DEVICES, d.folder);
    
    // ЗАЩИТА: Простая проверка path traversal
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) {
      // Логируем подозрительную активность
      await auditLog({
        userId: req.user?.id || null,
        action: AuditAction.PATH_TRAVERSAL_ATTEMPT,
        resource: `device:${id}`,
        details: { attemptedPath: name, deviceId: id },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        status: 'failure'
      });
      logSecurity('warn', 'Path traversal attempt detected on file delete', { 
        deviceId: id, 
        attemptedPath: name, 
        ip: req.ip 
      });
      return res.status(400).json({ error: 'invalid file path' });
    }
    
    const folderName = name.replace(/\.(pdf|pptx)$/i, '');
    const possibleFolder = path.join(deviceFolder, folderName);
    
    let deletedFileName = name;
    let isFolder = false;
    
    // Проверяем PDF/PPTX папку
    if (fs.existsSync(possibleFolder) && fs.statSync(possibleFolder).isDirectory()) {
      try {
        fs.rmSync(possibleFolder, { recursive: true, force: true });
        deletedFileName = folderName;
        isFolder = true;
        logFile('info', `Удалена папка PDF/PPTX: ${folderName}`, { deviceId: id, fileName: name, folderName });
      } catch (e) {
        logger.error(`[DELETE file] Ошибка удаления папки ${folderName}`, { error: e.message, stack: e.stack, deviceId: id, fileName: name, folderName });
        return res.status(500).json({ error: 'failed to delete folder' });
      }
    } 
    // Проверяем папку с изображениями (без расширения)
    else if (!name.includes('.')) {
      const imageFolderPath = path.join(deviceFolder, name);
      if (fs.existsSync(imageFolderPath) && fs.statSync(imageFolderPath).isDirectory()) {
        try {
          fs.rmSync(imageFolderPath, { recursive: true, force: true });
          deletedFileName = name;
          isFolder = true;
          logFile('info', `Удалена папка с изображениями: ${name}`, { deviceId: id, fileName: name });
        } catch (e) {
          logger.error(`[DELETE file] Ошибка удаления папки ${name}`, { error: e.message, stack: e.stack, deviceId: id, fileName: name });
          return res.status(500).json({ error: 'failed to delete image folder' });
        }
      }
    } else {
      // НОВОЕ: Обычный файл - умное удаление с подсчетом ссылок
      
      // 1. Получаем метаданные из БД
      const metadata = getFileMetadata(id, name);
      
      if (!metadata) {
        logFile('warn', 'File not found in DB', { deviceId: id, fileName: name });
        return res.status(404).json({ error: 'file not found' });
      }
      
      const physicalPath = metadata.file_path;
      
      // 2. Удаляем запись из БД
      deleteFileMetadata(id, name);
      
      // 3. Подсчитываем сколько еще устройств используют этот файл
      const refCount = countFileReferences(physicalPath);
      
      logFile('info', 'File reference removed', {
        deviceId: id,
        fileName: name,
        physicalPath,
        remainingReferences: refCount
      });
      
      // 4. Если никто не использует - удаляем физический файл
      if (refCount === 0) {
        try {
          if (fs.existsSync(physicalPath)) {
            fs.unlinkSync(physicalPath);
            logFile('info', '🗑️ Physical file deleted (no references)', {
              filePath: physicalPath,
              sizeMB: (metadata.file_size / 1024 / 1024).toFixed(2)
            });
          }
        } catch (e) {
          logger.error('Failed to delete physical file', {
            error: e.message,
            filePath: physicalPath
          });
        }
      } else {
        logFile('info', '✅ Physical file kept (still used)', {
          filePath: physicalPath,
          usedByDevices: refCount
        });
      }
      
      // Очищаем кэш разрешения
      clearResolutionCache(physicalPath);
    }
    
    // Удаляем из маппинга
    if (fileNamesMap[id]) {
      if (fileNamesMap[id][name]) delete fileNamesMap[id][name];
      if (fileNamesMap[id][deletedFileName] && deletedFileName !== name) {
        delete fileNamesMap[id][deletedFileName];
      }
      if (Object.keys(fileNamesMap[id]).length === 0) delete fileNamesMap[id];
      saveFileNamesMap(fileNamesMap);
    }
    
    // КРИТИЧНО: Если удаляемый файл был текущим воспроизводимым - сбрасываем состояние
    if (devices[id] && devices[id].current && devices[id].current.file === deletedFileName) {
      logger.info(`[DELETE file] Сбрасываем состояние устройства ${id}, т.к. удален текущий файл ${deletedFileName}`);
      devices[id].current = { type: 'idle', file: null, state: 'idle' };
      // Отправляем команду остановки на устройство
      io.to(`device:${id}`).emit('player/stop');
    }
    
    // НОВОЕ: Обновляем список файлов из БД (а не из файловой системы)
    updateDeviceFilesFromDB(id, devices, fileNamesMap);
    io.emit('devices/updated');
    
    // Audit log
    await auditLog({
      userId: req.user?.id || null,
      action: AuditAction.FILE_DELETE,
      resource: `device:${id}`,
      details: { 
        deviceId: id, 
        fileName: deletedFileName, 
        isFolder, 
        deletedBy: req.user?.username || 'anonymous' 
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      status: 'success'
    });
    logFile('info', 'File deleted', { 
      deviceId: id, 
      fileName: deletedFileName, 
      isFolder, 
      deletedBy: req.user?.username || 'anonymous' 
    });
    
    res.json({ ok: true });
  });
  
  // GET /api/devices/:id/files - Получить список файлов устройства
  router.get('/:id/files', (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'invalid device id' });
    }
    
    const d = devices[id];
    if (!d) {
      return res.status(404).json({ error: 'not found' });
    }
    
    const files = d.files || [];
    const fileNames = d.fileNames || files;
    const deviceFolderPath = path.join(DEVICES, d.folder || id);
    
    const response = files.map((safeName, index) => ({
      safeName,
      originalName: fileNames[index] || safeName
    }));
    
    res.json(response);
  });
  
  // GET /api/devices/:id/files-with-status - Получить список файлов со статусами
  router.get('/:id/files-with-status', async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'invalid device id' });
    }
    
    const d = devices[id];
    if (!d) {
      return res.status(404).json({ error: 'not found' });
    }
    
    const files = d.files || [];
    const fileNames = d.fileNames || files;
    
    const filesData = [];
    
    for (let i = 0; i < files.length; i++) {
      const safeName = files[i];
      
      const fileStatus = getFileStatus(id, safeName) || { status: 'ready', progress: 100, canPlay: true };
      
      let resolution = null;
      let isPlaceholder = false;
      let durationSeconds = null;
      let folderImageCount = null;
      
      // Получаем метаданные из БД (разрешение + флаг заглушки + originalName)
      const ext = path.extname(safeName).toLowerCase();
      const metadata = getFileMetadata(id, safeName);
      
      // КРИТИЧНО: originalName берем из metadata (если есть), иначе из fileNames в памяти
      let originalName;
      if (metadata && metadata.original_name) {
        originalName = metadata.original_name;
      } else {
        originalName = fileNames[i] || safeName;
      }
      
      if (metadata) {
        // Флаг заглушки
        isPlaceholder = !!metadata.is_placeholder;
        
        if (metadata.video_duration) {
          durationSeconds = Math.round(metadata.video_duration);
        }
        
        // Разрешение для видео файлов
        if (['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi'].includes(ext)) {
          if (metadata.video_width && metadata.video_height) {
            resolution = {
              width: metadata.video_width,
              height: metadata.video_height
            };
          }
        }
      }

      // Дополнительный ffprobe fallback для старых файлов
      if (['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi'].includes(ext)) {
        const filePath = (metadata && metadata.file_path) || path.join(deviceFolderPath, safeName);
        if (
          (fileStatus.status !== 'processing' && fileStatus.status !== 'checking') &&
          ((!resolution || !resolution.width || !resolution.height) || !durationSeconds)
        ) {
          try {
            const params = await getCachedResolution(filePath, checkVideoParameters);
            if (params) {
              if ((!resolution || !resolution.width || !resolution.height) && params.width && params.height) {
                resolution = { width: params.width, height: params.height };
              }
              if (!durationSeconds && params.duration) {
                durationSeconds = Number(params.duration);
              }
            }
          } catch (e) {
            // ignore ffprobe errors
          }
        }
      }
      
      // Если это папка (без расширения или .zip) — считаем количество изображений
      if (!ext || ext === '' || ext === '.zip') {
        const folderName = safeName.replace(/\.zip$/i, '');
        try {
          folderImageCount = await getFolderImagesCount(id, folderName);
        } catch (error) {
          folderImageCount = null;
        }
      }
      
      filesData.push({
        safeName,
        originalName,
        status: fileStatus.status || 'ready',
        progress: fileStatus.progress || 100,
        canPlay: fileStatus.canPlay !== false,
        error: fileStatus.error || null,
        resolution,
        isPlaceholder,  // НОВОЕ: Флаг заглушки
        durationSeconds,
        folderImageCount
      });
    }
    
    res.json(filesData);
  });
  
  return router;
}

