/**
 * File Metadata Processor - обработка и сохранение метаданных файлов
 * @module utils/file-metadata-processor
 */

import fs from 'fs';
import path from 'path';
import { calculateMD5, saveFileMetadata, findDuplicateFile, getFileMetadata } from '../database/files-metadata.js';
import { checkVideoParameters } from '../video/ffmpeg-wrapper.js';
import logger, { logFile } from '../utils/logger.js';
import { ensureTrailerForFile } from '../video/trailer-generator.js';
import { getConvertedCache } from '../config/settings-manager.js';
import { applyFaststartAsync } from '../video/mp4-faststart.js';

/**
 * Обработать загруженный файл: вычислить MD5, получить метаданные, сохранить в БД
 * @param {string} deviceId
 * @param {string} safeName
 * @param {string} originalName
 * @param {string} filePath
 * @param {string} folder - Папка устройства
 */
export async function processUploadedFile(deviceId, safeName, originalName, filePath, folder) {
  try {
    // Проверяем существование файла
    if (!fs.existsSync(filePath)) {
      logFile('warn', 'File not found for metadata processing', { deviceId, safeName, filePath });
      return;
    }
    
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const fileMtime = stats.mtimeMs;
    const ext = path.extname(safeName).toLowerCase();
    
    logFile('debug', 'Processing file metadata', { deviceId, safeName, fileSize });
    
    // КРИТИЧНО: НОВЫЙ ПОРЯДОК ОПЕРАЦИЙ
    // 1. Сначала обрабатываем MP4 файлы (faststart) - это может изменить файл
    // 2. Потом вычисляем MD5 обработанного файла
    // 3. Затем проверяем дедупликацию по MD5 обработанного файла
    // Это гарантирует что все файлы обработаны перед дедупликацией
    
    let deduplicationApplied = false;
    let duplicate = null;
    
    // ШАГ 1: Обрабатываем MP4 файлы ДО вычисления MD5 и дедупликации
    if (ext === '.mp4' || ext === '.m4v' || ext === '.m4a') {
      logFile('info', '🚀 Обработка MP4 файла перед дедупликацией', {
        deviceId,
        safeName,
        filePath
      });
      
      // Синхронно обрабатываем файл (ждем завершения)
      // Это важно, чтобы MD5 вычислялся для обработанного файла
      // КРИТИЧНО: Всегда обрабатываем при загрузке (checkFirst: false)
      // Потому что файлы с большим moov могут все равно не перематываться
      // из-за fragmented структуры или неполных индексов
      try {
        const { applyFaststart } = await import('../video/mp4-faststart.js');
        const processed = await applyFaststart(filePath, { checkFirst: false });
        
        if (processed) {
          logFile('info', '✅ MP4 файл обработан перед дедупликацией', {
            deviceId,
            safeName
          });
          // Обновляем размер файла после обработки
          const newStats = fs.statSync(filePath);
          fileSize = newStats.size;
        } else {
          logFile('warn', '⚠️ MP4 файл не был обработан (возможна ошибка)', {
            deviceId,
            safeName
          });
        }
      } catch (error) {
        logFile('error', 'Ошибка обработки MP4 перед дедупликацией', {
          deviceId,
          safeName,
          error: error.message
        });
        // Продолжаем даже при ошибке обработки
      }
    }
    
    // ШАГ 2: Вычисляем MD5 обработанного файла
    const isBigFile = fileSize > 100 * 1024 * 1024;
    
    // Для больших файлов вычисляем оба MD5: partial (10MB) и full
    const partialMd5 = isBigFile ? await calculateMD5(filePath, true) : null;
    const md5Hash = await calculateMD5(filePath, false);
    
    logFile('debug', 'MD5 calculated (after processing)', { 
      deviceId, 
      safeName, 
      md5: md5Hash.substring(0, 12),
      partialMd5: partialMd5 ? partialMd5.substring(0, 12) : null,
      isBigFile
    });
    
    // ШАГ 3: Проверяем дедупликацию по MD5 обработанного файла
    // Дедупликация применяется ТОЛЬКО для видео файлов
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi'];
    const isVideoFile = videoExtensions.includes(ext);
    
    if (isVideoFile) {
      // Проверяем есть ли дубликат на других устройствах (используем partial для больших файлов)
      const searchMd5 = partialMd5 || md5Hash;
      duplicate = findDuplicateFile(searchMd5, fileSize, deviceId, !!partialMd5);
      
      if (duplicate && fs.existsSync(duplicate.file_path)) {
        // Дубликат найден! Удаляем обработанный новый файл, используем существующий
        logFile('info', '⚡ Duplicate detected - using existing file (instant deduplication)', {
          deviceId,
          safeName,
          duplicateDevice: duplicate.device_id,
          duplicateFile: duplicate.safe_name,
          sharedPath: duplicate.file_path,
          md5: md5Hash.substring(0, 12),
          savedSpaceMB: (fileSize / 1024 / 1024).toFixed(2)
        });
        
        try {
          // Удаляем обработанный новый файл (не нужен, используем существующий)
          fs.unlinkSync(filePath);
          
          // Заменяем filePath на путь к существующему файлу (shared storage)
          filePath = duplicate.file_path;
          
          deduplicationApplied = true;
          
          logFile('info', '✅ Instant deduplication applied (0 bytes copied, saved disk space!)', {
            deviceId,
            safeName,
            referencesTo: duplicate.file_path,
            copiedMetadataFrom: `${duplicate.device_id}:${duplicate.safe_name}`
          });
        } catch (e) {
          logFile('error', 'Failed to deduplicate file', {
            error: e.message,
            deviceId,
            safeName
          });
          deduplicationApplied = false;
        }
      } else if (duplicate) {
        logFile('warn', 'Duplicate found but source file missing', {
          deviceId,
          safeName,
          duplicateDevice: duplicate.device_id,
          missingFile: duplicate.file_path
        });
      }
    } else {
      logFile('debug', 'Skipping deduplication for non-video file', {
        deviceId,
        safeName,
        extension: ext,
        fileType: 'presentation/image/other'
      });
    }
    
    let videoParams = {};
    let audioParams = {};
    let mimeType = null;
    
    // Если применена дедупликация - копируем метаданные из источника
    if (deduplicationApplied && duplicate) {
      const sourceMetadata = getFileMetadata(duplicate.device_id, duplicate.safe_name);
      if (sourceMetadata) {
        videoParams = {
          width: sourceMetadata.video_width,
          height: sourceMetadata.video_height,
          duration: sourceMetadata.video_duration,
          codec: sourceMetadata.video_codec,
          bitrate: sourceMetadata.video_bitrate
        };
        audioParams = {
          codec: sourceMetadata.audio_codec,
          bitrate: sourceMetadata.audio_bitrate,
          channels: sourceMetadata.audio_channels
        };
        mimeType = sourceMetadata.mime_type;
        
        logFile('info', '✅ Metadata copied from duplicate (no FFmpeg needed!)', {
          deviceId,
          safeName,
          resolution: `${videoParams.width}x${videoParams.height}`
        });
      }
    }
    // Иначе получаем метаданные через FFmpeg (только для новых файлов)
    else if (['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi'].includes(ext)) {
      try {
        const params = await checkVideoParameters(filePath);
        if (params) {
          videoParams = {
            width: params.width,
            height: params.height,
            duration: params.duration,
            codec: params.codec,
            profile: params.profile,  // НОВОЕ: Сохраняем profile!
            bitrate: params.bitrate
          };
          audioParams = {
            codec: params.audioCodec,
            bitrate: params.audioBitrate,
            channels: params.audioChannels
          };
          mimeType = `video/${ext.substring(1)}`;
          
          logFile('debug', 'Video metadata extracted via FFmpeg', { 
            deviceId, 
            safeName, 
            resolution: `${videoParams.width}x${videoParams.height}` 
          });
        }
      } catch (e) {
        logFile('warn', 'Failed to extract video metadata', { 
          deviceId, 
          safeName, 
          error: e.message 
        });
      }
    } else if (['.mp3', '.wav', '.m4a'].includes(ext)) {
      mimeType = `audio/${ext.substring(1)}`;
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      mimeType = `image/${ext.substring(1).replace('jpg', 'jpeg')}`;
    } else if (ext === '.pdf') {
      mimeType = 'application/pdf';
    } else if (ext === '.pptx') {
      mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    }
    
    // Сохраняем метаданные в БД
    try {
      // КРИТИЧНО: Логируем перед сохранением на уровне warn для видимости в production
      logger.warn('[FileMetadata] 💾 Saving file metadata to database', {
        deviceId,
        safeName,
        originalName,
        filePath,
        fileSize,
        hasMd5: !!md5Hash
      });
      
      saveFileMetadata({
        deviceId,
        safeName,
        originalName,
        filePath,
        fileSize,
        md5Hash,
        partialMd5,
        mimeType,
        videoParams,
        audioParams,
        fileMtime
      });
      
      logger.warn('[FileMetadata] ✅ File metadata saved successfully', { 
        deviceId, 
        safeName,
        originalName,
        filePath,
        fileSize,
        md5: md5Hash ? md5Hash.substring(0, 12) : null,
        deduplicated: deduplicationApplied,
        resolution: videoParams.width ? `${videoParams.width}x${videoParams.height}` : null,
        mimeType
      });
      
      logFile('info', '✅ File metadata saved to database', { 
        deviceId, 
        safeName,
        originalName,
        filePath,
        fileSize,
        md5: md5Hash ? md5Hash.substring(0, 12) : null,
        deduplicated: deduplicationApplied,
        resolution: videoParams.width ? `${videoParams.width}x${videoParams.height}` : null,
        mimeType
      });
    } catch (saveError) {
      logger.error('[FileMetadata] ❌ Failed to save file metadata', {
        deviceId,
        safeName,
        originalName,
        filePath,
        error: saveError.message,
        stack: saveError.stack
      });
      logFile('error', '❌ Failed to save file metadata', {
        deviceId,
        safeName,
        originalName,
        filePath,
        error: saveError.message,
        stack: saveError.stack
      });
      throw saveError; // Пробрасываем ошибку дальше для обработки в processUploadedFilesAsync
    }
    
    // КРИТИЧНО: Faststart обработка уже выполнена ДО дедупликации (см. выше в коде)
    // Для дедуплицированных файлов проверяем нужна ли обработка существующего файла в фоне
    if (deduplicationApplied && (ext === '.mp4' || ext === '.m4v' || ext === '.m4a') && filePath && fs.existsSync(filePath)) {
      // Дедуплицированный файл - проверяем нужна ли обработка существующего файла
      logFile('debug', 'Проверка faststart для дедуплицированного файла (фоновая)', {
        deviceId,
        safeName,
        filePath
      });
      
      // Запускаем в фоне, не блокируем ответ
      applyFaststartAsync(filePath).then((success) => {
        if (success) {
          logFile('info', '✅ Дедуплицированный файл обработан', {
            deviceId,
            safeName
          });
        }
      }).catch((error) => {
        logFile('warn', 'Ошибка обработки дедуплицированного файла', {
          deviceId,
          safeName,
          error: error.message
        });
      });
    }
    
    // Фоновая генерация трейлера для видео (не блокирует ответ)
    if (['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi'].includes(ext) && md5Hash && filePath) {
      ensureTrailerForFile(md5Hash, filePath, { seconds: 10 }).catch(() => {});
    }
    
    // Возвращаем информацию о дедупликации
    return {
      deduplicated: deduplicationApplied,
      sourceDevice: duplicate ? duplicate.device_id : null,
      sourceFile: duplicate ? duplicate.safe_name : null,
      md5Hash
    };
    
  } catch (error) {
    logger.error('Error processing file metadata', { 
      error: error.message, 
      stack: error.stack,
      deviceId, 
      safeName 
    });
    
    return {
      deduplicated: false,
      error: error.message
    };
  }
}

/**
 * Обработать массив загруженных файлов асинхронно
 * @param {string} deviceId
 * @param {Array} files - Массив { filename, originalname, path? } от multer
 * @param {string} devicesPath - Корневой путь к хранилищу файлов (getDevicesPath())
 * @param {Object} fileNamesMap - Маппинг имен
 */
export async function processUploadedFilesAsync(deviceId, files, devicesPath, fileNamesMap) {
  // КРИТИЧНО: Логируем начало обработки на уровне error чтобы точно было видно
  console.error('[FileMetadata] ========== processUploadedFilesAsync CALLED ==========');
  console.error('[FileMetadata] Device ID:', deviceId);
  console.error('[FileMetadata] Files count:', files.length);
  console.error('[FileMetadata] Devices path:', devicesPath);
  
  logger.error('[FileMetadata] 📦 Starting batch metadata processing', {
    deviceId,
    filesCount: files.length,
    devicesPath,
    files: files.map(f => ({ filename: f.filename, path: f.path }))
  });
  
  const promises = files.map(file => {
    const safeName = file.filename;
    const originalName = fileNamesMap[deviceId]?.[safeName] || file.originalname || safeName;
    
    // КРИТИЧНО: Multer уже сохраняет файлы и устанавливает file.path с полным путем
    // Используем file.path если он есть, иначе строим путь из devicesPath
    let filePath;
    if (file.path && fs.existsSync(file.path)) {
      filePath = file.path;
      logFile('debug', 'Using file.path from multer', { deviceId, safeName, filePath });
    } else {
      // Fallback: строим путь вручную
      filePath = path.join(devicesPath, safeName);
      logger.warn('[FileMetadata] ⚠️ Building file path manually (file.path not available)', {
        deviceId,
        safeName,
        filePath,
        hasFilePath: !!file.path,
        filePathFromMulter: file.path
      });
      logFile('debug', 'Building file path manually', { deviceId, safeName, filePath });
    }
    
    // Проверяем существование файла перед обработкой
    if (!fs.existsSync(filePath)) {
      logger.error('[FileMetadata] ❌ File not found for metadata processing', { 
        deviceId, 
        safeName, 
        filePath,
        hasFilePath: !!file.path,
        filePathFromMulter: file.path
      });
      logFile('error', 'File not found for metadata processing', { 
        deviceId, 
        safeName, 
        filePath,
        hasFilePath: !!file.path,
        filePathFromMulter: file.path
      });
      return Promise.resolve({
        deduplicated: false,
        error: `File not found: ${filePath}`
      });
    }
    
    return processUploadedFile(deviceId, safeName, originalName, filePath, devicesPath);
  });
  
  // Обрабатываем все файлы параллельно
  const results = await Promise.allSettled(promises);
  
  // Собираем статистику дедупликации и ошибок
  let deduplicatedCount = 0;
  let errorCount = 0;
  const errors = [];
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const file = files[i];
    
    if (result.status === 'fulfilled') {
      if (result.value?.deduplicated) {
        deduplicatedCount++;
      }
      if (result.value?.error) {
        errorCount++;
        errors.push({
          filename: file.filename,
          error: result.value.error
        });
        logFile('error', 'File metadata processing error', {
          deviceId,
          filename: file.filename,
          error: result.value.error
        });
      }
    } else {
      errorCount++;
      errors.push({
        filename: file.filename,
        error: result.reason?.message || String(result.reason)
      });
      logFile('error', 'File metadata processing failed', {
        deviceId,
        filename: file.filename,
        error: result.reason?.message || String(result.reason),
        stack: result.reason?.stack
      });
    }
  }
  
  // КРИТИЧНО: Логируем результат на уровне warn для видимости в production
  logger.warn('[FileMetadata] ✅ Batch file metadata processing completed', { 
    deviceId, 
    filesCount: files.length,
    deduplicatedCount,
    newFilesCount: files.length - deduplicatedCount,
    errorCount,
    errors: errors.length > 0 ? errors : undefined
  });
  
  logFile('info', 'Batch file metadata processing completed', { 
    deviceId, 
    filesCount: files.length,
    deduplicatedCount,
    newFilesCount: files.length - deduplicatedCount,
    errorCount,
    errors: errors.length > 0 ? errors : undefined
  });
  
  if (deduplicatedCount > 0) {
    logger.warn(`[FileMetadata] 🎯 Deduplication saved ${deduplicatedCount} file upload(s)`, {
      deviceId,
      deduplicatedCount,
      totalFiles: files.length
    });
    logFile('info', `🎯 Deduplication saved ${deduplicatedCount} file upload(s)`, {
      deviceId,
      deduplicatedCount,
      totalFiles: files.length
    });
  }
  
  if (errorCount > 0) {
    logger.error('[FileMetadata] ❌ Some files failed metadata processing', {
      deviceId,
      errorCount,
      totalFiles: files.length,
      errors
    });
  }
}

