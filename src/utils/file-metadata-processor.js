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
    
    // Вычисляем MD5 (в фоне, не блокируем upload response)
    const isBigFile = fileSize > 100 * 1024 * 1024;
    
    // Для больших файлов вычисляем оба MD5: partial (10MB) и full
    const partialMd5 = isBigFile ? await calculateMD5(filePath, true) : null;
    const md5Hash = await calculateMD5(filePath, false);
    
    logFile('debug', 'MD5 calculated', { 
      deviceId, 
      safeName, 
      md5: md5Hash.substring(0, 12),
      partialMd5: partialMd5 ? partialMd5.substring(0, 12) : null,
      isBigFile
    });
    
    // Определяем тип файла для проверки необходимости дедупликации
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi'];
    const isVideoFile = videoExtensions.includes(ext);
    
    // Дедупликация применяется ТОЛЬКО для видео файлов
    // Презентации и картинки не дедуплицируются
    let duplicate = null;
    let deduplicationApplied = false;
    
    if (isVideoFile) {
      // Проверяем есть ли дубликат на других устройствах (используем partial для больших файлов)
      const searchMd5 = partialMd5 || md5Hash;
      duplicate = findDuplicateFile(searchMd5, fileSize, deviceId, !!partialMd5);
      
      if (duplicate && fs.existsSync(duplicate.file_path)) {
        // Дубликат найден! НОВАЯ АРХИТЕКТУРА: удаляем загруженный файл, используем существующий
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
          // Удаляем только что загруженный файл (не нужен, используем существующий)
          fs.unlinkSync(filePath);
          
          // НОВОЕ: Заменяем filePath на путь к существующему файлу (shared storage)
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
    
    logFile('info', 'File metadata saved to database', { 
      deviceId, 
      safeName, 
      md5: md5Hash.substring(0, 12),
      deduplicated: deduplicationApplied,
      resolution: videoParams.width ? `${videoParams.width}x${videoParams.height}` : null
    });
    
    // Фоновая генерация трейлера для видео (не блокирует ответ)
    if (['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi'].includes(ext) && md5Hash && filePath) {
      ensureTrailerForFile(md5Hash, filePath, { seconds: 5 }).catch(() => {});
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
 * @param {Array} files - Массив { filename, originalname }
 * @param {string} folder - Папка устройства
 * @param {Object} fileNamesMap - Маппинг имен
 */
export async function processUploadedFilesAsync(deviceId, files, folder, fileNamesMap) {
  const promises = files.map(file => {
    const safeName = file.filename;
    const originalName = fileNamesMap[deviceId]?.[safeName] || file.originalname || safeName;
    const filePath = path.join(folder, safeName);
    
    return processUploadedFile(deviceId, safeName, originalName, filePath, folder);
  });
  
  // Обрабатываем все файлы параллельно
  const results = await Promise.allSettled(promises);
  
  // Собираем статистику дедупликации
  let deduplicatedCount = 0;
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value?.deduplicated) {
      deduplicatedCount++;
    }
  }
  
  logFile('info', 'Batch file metadata processing completed', { 
    deviceId, 
    filesCount: files.length,
    deduplicatedCount,
    newFilesCount: files.length - deduplicatedCount
  });
  
  if (deduplicatedCount > 0) {
    logFile('info', `🎯 Deduplication saved ${deduplicatedCount} file upload(s)`, {
      deviceId,
      deduplicatedCount,
      totalFiles: files.length
    });
  }
}

