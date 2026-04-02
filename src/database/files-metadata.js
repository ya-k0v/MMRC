/**
 * Files Metadata - работа с метаданными файлов в БД
 * @module database/files-metadata
 */

import crypto from 'crypto';
import fs from 'fs';
import { getDatabase } from './database.js';
import logger, { logFile } from '../utils/logger.js';
import { withRetrySync, isRetryableDatabaseError } from '../utils/retry.js';
import { STATIC_CONTENT_TYPES } from '../config/file-types.js';

/**
 * Вычислить MD5 хэш файла (полный или частичный)
 * @param {string} filePath - Путь к файлу
 * @param {boolean} partial - Если true, хэшируем только первые 10MB (для больших файлов)
 * @returns {Promise<string>} - MD5 хэш
 */
export async function calculateMD5(filePath, partial = false) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    
    // Определяем сколько байт читать
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const isBigFile = fileSize > 100 * 1024 * 1024; // >100MB
    const maxBytes = (partial && isBigFile) ? (10 * 1024 * 1024) : fileSize; // 10MB или весь файл
    
    const stream = fs.createReadStream(filePath, { 
      start: 0, 
      end: maxBytes - 1 
    });
    
    let bytesRead = 0;
    
    stream.on('data', data => {
      hash.update(data);
      bytesRead += data.length;
    });
    
    stream.on('end', () => {
      const md5 = hash.digest('hex');
      resolve(md5);
    });
    
    stream.on('error', reject);
  });
}

/**
 * Сохранить метаданные файла в БД
 * @param {Object} params
 * @param {string} params.deviceId - ID устройства
 * @param {string} params.safeName - Безопасное имя файла
 * @param {string} params.originalName - Оригинальное имя файла
 * @param {string} params.filePath - Полный путь к файлу
 * @param {number} params.fileSize - Размер файла
 * @param {string} params.md5Hash - MD5 хэш (полный)
 * @param {string} params.partialMd5 - MD5 первых 10MB (для быстрой проверки дубликатов)
 * @param {string} params.mimeType - MIME тип
 * @param {Object} params.videoParams - Параметры видео (width, height, duration, codec, bitrate)
 * @param {Object} params.audioParams - Параметры аудио (codec, bitrate, channels)
 */
export function saveFileMetadata({
  deviceId,
  safeName,
  originalName,
  filePath,
  fileSize,
  md5Hash,
  partialMd5 = null,
  mimeType = null,
  videoParams = {},
  audioParams = {},
  fileMtime,
  contentType = 'file',
  streamUrl = null,
  streamProtocol = 'auto',
  pagesCount = null  // Количество слайдов/страниц/изображений для папок/PDF/PPTX
}) {
  try {
    const db = getDatabase();
    
    // КРИТИЧНО: Используем retry для критических операций записи
    const result = withRetrySync(() => {
      // КРИТИЧНО: Для статического контента (папки/PDF/PPTX) md5_hash может быть пустой строкой
      // Используем пустую строку вместо NULL для совместимости с NOT NULL constraint
      const finalMd5Hash = md5Hash || '';
      
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO files_metadata (
          device_id, safe_name, original_name, file_path, file_size, md5_hash, partial_md5, mime_type,
          video_width, video_height, video_duration, video_codec, video_profile, video_bitrate,
          audio_codec, audio_bitrate, audio_channels, file_mtime, content_type, stream_url,
          stream_protocol, pages_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      const result = stmt.run(
        deviceId,
        safeName,
        originalName,
        filePath,
        fileSize,
        finalMd5Hash,
        partialMd5,
        mimeType,
        videoParams.width || null,
        videoParams.height || null,
        videoParams.duration || null,
        videoParams.codec || null,
        videoParams.profile || null,  // НОВОЕ: Сохраняем profile
        videoParams.bitrate || null,
        audioParams.codec || null,
        audioParams.bitrate || null,
        audioParams.channels || null,
        fileMtime,
        contentType,
        streamUrl,
        streamProtocol,
        pagesCount
      );
      
      // Проверяем, что запись действительно в БД
      const checkStmt = db.prepare('SELECT * FROM files_metadata WHERE device_id = ? AND safe_name = ?');
      const checkResult = checkStmt.get(deviceId, safeName);
      
      // Логируем успешное сохранение с деталями
      const logLevel = STATIC_CONTENT_TYPES.has(contentType) ? 'info' : 'debug';
      logger[logLevel]('File metadata saved to database', { 
        deviceId, 
        safeName,
        originalName,
        filePath,
        fileSize,
        md5Hash: finalMd5Hash ? finalMd5Hash.substring(0, 12) : null,
        mimeType,
        contentType,
        pagesCount,
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
        verified: !!checkResult,
        fileExists: filePath ? fs.existsSync(filePath) : false
      });
      
      logFile('info', '✅ File metadata saved to database', { 
        deviceId, 
        safeName,
        originalName,
        filePath,
        fileSize,
        md5Hash: finalMd5Hash ? finalMd5Hash.substring(0, 12) : null,
        mimeType,
        contentType,
        pagesCount,
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid
      });
      
      return result;
    }, {
      maxRetries: 3,
      delay: 100,
      shouldRetry: isRetryableDatabaseError,
      onRetry: (error, attempt, maxRetries) => {
        logger.warn('Retrying saveFileMetadata', {
          deviceId,
          safeName,
          attempt,
          maxRetries,
          error: error.message,
          errorCode: error.code
        });
      }
    });
    
  } catch (error) {
    logger.error('Failed to save file metadata after retries', { 
      error: error.message,
      stack: error.stack,
      deviceId, 
      safeName 
    });
    // КРИТИЧНО: Отправляем уведомление о критической ошибке БД
    import('../utils/notifications.js').then(({ notifyDbError }) => {
      notifyDbError({
        operation: 'saveFileMetadata',
        deviceId,
        safeName,
        error: error.message
      });
    }).catch(() => {
      // Игнорируем ошибки уведомлений
    });
  }
}

/**
 * Получить метаданные файла из БД
 * @param {string} deviceId
 * @param {string} safeName
 * @returns {Object|null}
 */
export function getFileMetadata(deviceId, safeName) {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM files_metadata 
      WHERE device_id = ? AND safe_name = ?
    `);
    
    return stmt.get(deviceId, safeName);
  } catch (error) {
    logger.error('Failed to get file metadata', { error: error.message, deviceId, safeName });
    return null;
  }
}

/**
 * Получить метаданные файла по safe_name без привязки к устройству
 * Берём самую свежую запись (по file_mtime/created_at)
 * @param {string} safeName
 * @returns {Object|null}
 */
export function getAnyFileMetadataBySafeName(safeName) {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT *
      FROM files_metadata
      WHERE safe_name = ?
      ORDER BY file_mtime DESC, created_at DESC
      LIMIT 1
    `);
    return stmt.get(safeName);
  } catch (error) {
    logger.error('Failed to get file metadata by safe name', { error: error.message, safeName });
    return null;
  }
}

/**
 * Получить все метаданные для устройства
 * @param {string} deviceId
 * @returns {Array}
 */
export function getDeviceFilesMetadata(deviceId) {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM files_metadata 
      WHERE device_id = ?
      ORDER BY created_at DESC
    `);
    
    return stmt.all(deviceId);
  } catch (error) {
    logger.error('Failed to get device files metadata', { error: error.message, deviceId });
    return [];
  }
}

export function getAllStreamingMetadata() {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM files_metadata
      WHERE content_type = 'streaming'
    `);
    return stmt.all();
  } catch (error) {
    logger.error('Failed to get streaming metadata', { error: error.message });
    return [];
  }
}

/**
 * Найти файл с таким же MD5 на другом устройстве (дедупликация)
 * Дедупликация применяется ТОЛЬКО для видео файлов
 * @param {string} md5Hash - MD5 хэш (может быть partial или full)
 * @param {number} fileSize
 * @param {string} excludeDeviceId - Исключить это устройство из поиска
 * @param {boolean} isPartial - Является ли MD5 частичным (первые 10MB)
 * @returns {Object|null} - { device_id, safe_name, file_path }
 */
export function findDuplicateFile(md5Hash, fileSize, excludeDeviceId = null, isPartial = false) {
  try {
    const db = getDatabase();
    
    // Для больших файлов используем partial_md5, для маленьких - md5_hash
    const isBigFile = fileSize > 100 * 1024 * 1024;
    const md5Column = (isPartial || isBigFile) ? 'partial_md5' : 'md5_hash';
    
    // Дедупликация применяется ТОЛЬКО для видео файлов
    // Фильтруем по расширению файла и MIME типу
    let query = `
      SELECT device_id, safe_name, file_path, original_name, md5_hash, partial_md5
      FROM files_metadata 
      WHERE ${md5Column} = ? AND file_size = ?
        AND (
          LOWER(safe_name) LIKE '%.mp4' OR
          LOWER(safe_name) LIKE '%.webm' OR
          LOWER(safe_name) LIKE '%.ogg' OR
          LOWER(safe_name) LIKE '%.mkv' OR
          LOWER(safe_name) LIKE '%.mov' OR
          LOWER(safe_name) LIKE '%.avi' OR
          mime_type LIKE 'video/%'
        )
    `;
    
    const params = [md5Hash, fileSize];
    
    if (excludeDeviceId) {
      query += ` AND device_id != ?`;
      params.push(excludeDeviceId);
    }
    
    query += ` LIMIT 1`;
    
    const stmt = db.prepare(query);
    const result = stmt.get(...params);
    
    if (result) {
      logger.info('Duplicate found', { 
        md5: md5Hash.substring(0, 12), 
        isPartial,
        sourceDevice: result.device_id,
        sourceFile: result.safe_name
      });
    }
    
    return result;
    
  } catch (error) {
    logger.error('Failed to find duplicate file', { error: error.message, md5Hash: md5Hash.substring(0, 12) });
    return null;
  }
}

/**
 * Удалить метаданные файла
 * @param {string} deviceId
 * @param {string} safeName
 */
export function deleteFileMetadata(deviceId, safeName) {
  try {
    const db = getDatabase();
    
    // КРИТИЧНО: Используем retry для критических операций удаления
    withRetrySync(() => {
      const stmt = db.prepare(`
        DELETE FROM files_metadata 
        WHERE device_id = ? AND safe_name = ?
      `);
      
      stmt.run(deviceId, safeName);
    }, {
      maxRetries: 3,
      delay: 100,
      shouldRetry: isRetryableDatabaseError,
      onRetry: (error, attempt, maxRetries) => {
        logger.warn('Retrying deleteFileMetadata', {
          deviceId,
          safeName,
          attempt,
          maxRetries,
          error: error.message
        });
      }
    });
    
    logFile('debug', 'File metadata deleted', { deviceId, safeName });
    
  } catch (error) {
    logger.error('Failed to delete file metadata after retries', { 
      error: error.message,
      stack: error.stack,
      deviceId, 
      safeName 
    });
  }
}

/**
 * Удалить все метаданные устройства
 * @param {string} deviceId
 */
export function deleteDeviceFilesMetadata(deviceId) {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      DELETE FROM files_metadata 
      WHERE device_id = ?
    `);
    
    const result = stmt.run(deviceId);
    logFile('info', 'Device files metadata deleted', { deviceId, deletedCount: result.changes });
    
    return result.changes;
  } catch (error) {
    logger.error('Failed to delete device files metadata', { error: error.message, deviceId });
    return 0;
  }
}

/**
 * Получить статистику хранилища
 * @returns {Array} - Статистика по устройствам
 */
export function getStorageStats() {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM device_storage_stats
    `);
    
    return stmt.all();
  } catch (error) {
    logger.error('Failed to get storage stats', { error: error.message });
    return [];
  }
}

/**
 * Получить список дубликатов файлов
 * @returns {Array} - Список файлов с дубликатами
 */
export function getDuplicateFiles() {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM file_duplicates
    `);
    
    return stmt.all();
  } catch (error) {
    logger.error('Failed to get duplicate files', { error: error.message });
    return [];
  }
}

/**
 * Проверить нужно ли обновить метаданные файла
 * (файл изменился с момента последнего сохранения)
 * @param {string} deviceId
 * @param {string} safeName
 * @param {number} currentMtime - Текущий mtime файла
 * @returns {boolean}
 */
export function needsMetadataUpdate(deviceId, safeName, currentMtime) {
  const metadata = getFileMetadata(deviceId, safeName);
  if (!metadata) return true; // Нет метаданных - нужно создать
  
  return metadata.file_mtime !== currentMtime; // Файл изменился
}

/**
 * Подсчитать количество ссылок на физический файл
 * @param {string} filePath - Путь к физическому файлу
 * @returns {number} Количество устройств использующих этот файл
 */
export function countFileReferences(filePath) {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM files_metadata 
      WHERE file_path = ?
    `);
    
    const result = stmt.get(filePath);
    const count = result?.count || 0;
    
    logFile('debug', 'File references counted', { filePath, count });
    return count;
  } catch (error) {
    logger.error('Failed to count file references', { error: error.message, filePath });
    return 0;
  }
}

/**
 * Обновить отображаемое имя файла (original_name)
 * Физический файл (safe_name) НЕ меняется
 * @param {string} deviceId
 * @param {string} safeName - Физическое имя файла (не меняется)
 * @param {string} newOriginalName - Новое отображаемое имя
 * @returns {boolean} - true если обновлено успешно
 */
export function updateFileOriginalName(deviceId, safeName, newOriginalName) {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE files_metadata
      SET original_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE device_id = ? AND safe_name = ?
    `);
    
    const result = stmt.run(newOriginalName, deviceId, safeName);
    
    if (result.changes > 0) {
      logFile('info', 'File original_name updated', { deviceId, safeName, newOriginalName });
      return true;
    } else {
      logger.warn('No file found to update original_name', { deviceId, safeName });
      return false;
    }
  } catch (error) {
    logger.error('Failed to update file original_name', { error: error.message, deviceId, safeName, newOriginalName });
    throw error;
  }
}

/**
 * Обновить пути файлов при смене content root
 * @param {string} oldRoot - Старый корневой путь (например: /vid/videocontrol/public/content)
 * @param {string} newRoot - Новый корневой путь (например: /mnt/vc-content)
 * @returns {number} - Количество обновленных записей
 */
export function migrateFilePaths(oldRoot, newRoot) {
  try {
    const db = getDatabase();
    
    // Нормализуем пути (убираем trailing slashes для корректного сравнения)
    const normalizedOldRoot = oldRoot.replace(/\/+$/, '');
    const normalizedNewRoot = newRoot.replace(/\/+$/, '');
    
    if (normalizedOldRoot === normalizedNewRoot) {
      logFile('info', 'File paths migration skipped (same root)', { oldRoot: normalizedOldRoot, newRoot: normalizedNewRoot });
      return 0;
    }
    
    // Логируем количество путей которые будут мигрированы
    const checkStmt = db.prepare(`
      SELECT COUNT(*) as count FROM files_metadata
      WHERE file_path LIKE ? || '/%' OR file_path = ?
    `);
    const checkResult = checkStmt.get(normalizedOldRoot, normalizedOldRoot);
    const pathsToMigrate = checkResult?.count || 0;
    
    logFile('info', 'Starting file paths migration', {
      oldRoot: normalizedOldRoot,
      newRoot: normalizedNewRoot,
      pathsToMigrate
    });
    
    if (pathsToMigrate === 0) {
      logFile('info', 'No file paths found to migrate', {
        oldRoot: normalizedOldRoot,
        newRoot: normalizedNewRoot
      });
      return 0;
    }
    
    // Заменяем старый путь на новый в начале file_path
    // Формат: /old/root/file.mp4 -> /new/root/file.mp4
    // SUBSTR(file_path, oldRootLength + 2) вернет "/file.mp4" (включая слэш после старого корня)
    const stmt = db.prepare(`
      UPDATE files_metadata
      SET file_path = ? || SUBSTR(file_path, ?),
          updated_at = CURRENT_TIMESTAMP
      WHERE file_path LIKE ? || '/%' OR file_path = ?
    `);
    
    // Вычисляем позицию начала остатка пути (после старого корня + слэш)
    // Например: "/vid/videocontrol/public/content/video.mp4"
    // oldRoot = "/vid/videocontrol/public/content" (32 символа)
    // SUBSTR начиная с позиции 33 вернет "/video.mp4"
    const oldRootLength = normalizedOldRoot.length;
    const substrStart = oldRootLength + 1; // +1 для слэша после старого корня
    
    const result = stmt.run(
      normalizedNewRoot,
      substrStart,
      normalizedOldRoot,
      normalizedOldRoot // Для случая когда путь равен старому корню (не должно быть, но на всякий случай)
    );
    
    if (result.changes > 0) {
      logFile('info', '✅ File paths migrated in database', {
        oldRoot: normalizedOldRoot,
        newRoot: normalizedNewRoot,
        updated: result.changes
      });
    } else {
      logFile('debug', 'No file paths to migrate', {
        oldRoot: normalizedOldRoot,
        newRoot: normalizedNewRoot
      });
    }
    
    return result.changes;
  } catch (error) {
    logger.error('Failed to migrate file paths', {
      error: error.message,
      oldRoot,
      newRoot,
      stack: error.stack
    });
    throw error;
  }
}

export function createStreamingEntry({ deviceId, safeName, originalName, streamUrl, protocol = 'auto' }) {
  if (!deviceId || !safeName || !streamUrl) {
    throw new Error('Invalid streaming params');
  }
  const md5Hash = crypto.createHash('md5').update(`${deviceId}:${streamUrl}`).digest('hex');
  const normalizedProtocol = protocol || 'auto';
  let mimeType = 'video/mp2t';
  if (normalizedProtocol === 'dash') {
    mimeType = 'application/dash+xml';
  } else if (normalizedProtocol === 'hls') {
    mimeType = 'application/x-mpegURL';
  }
  
  saveFileMetadata({
    deviceId,
    safeName,
    originalName: originalName || safeName,
    filePath: streamUrl,
    fileSize: 0,
    md5Hash,
    partialMd5: null,
    mimeType,
    videoParams: {},
    audioParams: {},
    fileMtime: Date.now(),
    contentType: 'streaming',
    streamUrl,
    streamProtocol: normalizedProtocol
  });
}

/**
 * Обновить стрим (URL, протокол, название)
 * @param {string} deviceId
 * @param {string} safeName - Физическое имя файла (не меняется)
 * @param {string} newOriginalName - Новое отображаемое имя
 * @param {string} newStreamUrl - Новый URL стрима
 * @param {string} newProtocol - Новый протокол
 * @returns {boolean} - true если обновлено успешно
 */
export function updateStreamMetadata(deviceId, safeName, newOriginalName, newStreamUrl, newProtocol = 'auto') {
  try {
    const db = getDatabase();
    
    // Проверяем существование записи
    const existing = getFileMetadata(deviceId, safeName);
    if (!existing || existing.content_type !== 'streaming') {
      logger.warn('No streaming entry found to update', { deviceId, safeName });
      return false;
    }
    
    // Вычисляем новый MD5 хэш для нового URL
    const md5Hash = crypto.createHash('md5').update(`${deviceId}:${newStreamUrl}`).digest('hex');
    const normalizedProtocol = newProtocol || 'auto';
    
    // Определяем MIME тип на основе протокола
    let mimeType = 'video/mp2t';
    if (normalizedProtocol === 'dash') {
      mimeType = 'application/dash+xml';
    } else if (normalizedProtocol === 'hls') {
      mimeType = 'application/x-mpegURL';
    }
    
    // КРИТИЧНО: Используем retry для критических операций обновления
    return withRetrySync(() => {
      const stmt = db.prepare(`
        UPDATE files_metadata
        SET original_name = ?,
            stream_url = ?,
            stream_protocol = ?,
            file_path = ?,
            mime_type = ?,
          md5_hash = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE device_id = ? AND safe_name = ?
    `);
    
      const result = stmt.run(
        newOriginalName,
        newStreamUrl,
        normalizedProtocol,
        newStreamUrl, // file_path для стримов тоже содержит URL
        mimeType,
        md5Hash,
        deviceId,
        safeName
      );
      
      if (result.changes > 0) {
        logFile('info', 'Stream metadata updated', { deviceId, safeName, newOriginalName, newStreamUrl, newProtocol: normalizedProtocol });
        return true;
      } else {
        logger.warn('No stream found to update', { deviceId, safeName });
        return false;
      }
    }, {
      maxRetries: 3,
      delay: 100,
      shouldRetry: isRetryableDatabaseError,
      onRetry: (error, attempt, maxRetries) => {
        logger.warn('Retrying updateStreamMetadata', {
          deviceId,
          safeName,
          attempt,
          maxRetries,
          error: error.message
        });
      }
    });
  } catch (error) {
    logger.error('Failed to update stream metadata after retries', { 
      error: error.message,
      stack: error.stack,
      deviceId, 
      safeName, 
      newOriginalName, 
      newStreamUrl, 
      newProtocol 
    });
    return false;
  }
}

export function deleteStreamingEntry(deviceId, safeName) {
  deleteFileMetadata(deviceId, safeName);
}

/**
 * Получить уникальные пути из базы данных для проверки миграции
 * @returns {Array<string>} - Массив уникальных путей
 */
export function getAllFilePaths() {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT DISTINCT file_path FROM files_metadata
      ORDER BY file_path
    `);
    
    const rows = stmt.all();
    return rows.map(row => row.file_path);
  } catch (error) {
    logger.error('Failed to get all file paths', { error: error.message, stack: error.stack });
    return [];
  }
}

/**
 * Проверка контента в базе данных и фактически на диске
 * Удаляет записи из БД, если файлы не существуют на диске
 * @param {Object} options - Опции проверки
 * @param {string} options.deviceId - Проверить только для конкретного устройства (опционально)
 * @param {boolean} options.dryRun - Если true, только логирует, не удаляет (по умолчанию false)
 * @returns {Promise<Object>} - Статистика проверки: { checked, missing, deleted, errors }
 */
export async function cleanupMissingFiles({ deviceId = null, dryRun = false } = {}) {
  try {
    const db = getDatabase();
    
    // Получаем все записи из БД (или для конкретного устройства)
    let query = `
      SELECT device_id, safe_name, file_path, content_type, original_name
      FROM files_metadata
      WHERE content_type != 'streaming'
    `;
    const params = [];
    
    if (deviceId) {
      query += ` AND device_id = ?`;
      params.push(deviceId);
    }
    
    const stmt = db.prepare(query);
    const allRecords = stmt.all(...params);
    
    logger.info('[Cleanup] Starting file existence check', {
      deviceId: deviceId || 'all',
      totalRecords: allRecords.length,
      dryRun
    });
    
    let checked = 0;
    let missing = 0;
    let deleted = 0;
    const errors = [];
    const missingFiles = [];
    
    // Проверяем каждый файл
    for (const record of allRecords) {
      checked++;
      
      try {
        // Пропускаем записи без file_path
        if (!record.file_path) {
          logger.warn('[Cleanup] Record missing file_path', {
            deviceId: record.device_id,
            safeName: record.safe_name
          });
          continue;
        }
        
        // Проверяем существование файла на диске
        const exists = fs.existsSync(record.file_path);
        
        if (!exists) {
          missing++;
          missingFiles.push({
            deviceId: record.device_id,
            safeName: record.safe_name,
            originalName: record.original_name,
            filePath: record.file_path,
            contentType: record.content_type
          });
          
          logger.warn('[Cleanup] File not found on disk', {
            deviceId: record.device_id,
            safeName: record.safe_name,
            originalName: record.original_name,
            filePath: record.file_path,
            contentType: record.content_type
          });
          
          // Удаляем запись из БД, если не dryRun
          if (!dryRun) {
            try {
              deleteFileMetadata(record.device_id, record.safe_name);
              deleted++;
              
              logger.info('[Cleanup] Deleted metadata for missing file', {
                deviceId: record.device_id,
                safeName: record.safe_name,
                filePath: record.file_path
              });
            } catch (deleteError) {
              errors.push({
                deviceId: record.device_id,
                safeName: record.safe_name,
                error: deleteError.message
              });
              logger.error('[Cleanup] Failed to delete metadata', {
                deviceId: record.device_id,
                safeName: record.safe_name,
                error: deleteError.message
              });
            }
          }
        }
      } catch (checkError) {
        errors.push({
          deviceId: record.device_id,
          safeName: record.safe_name,
          error: checkError.message
        });
        logger.error('[Cleanup] Error checking file', {
          deviceId: record.device_id,
          safeName: record.safe_name,
          filePath: record.file_path,
          error: checkError.message
        });
      }
    }
    
    const result = {
      checked,
      missing,
      deleted: dryRun ? 0 : deleted,
      errors: errors.length,
      missingFiles: dryRun ? missingFiles : [],
      dryRun
    };
    
    logger.info('[Cleanup] File existence check completed', result);
    
    return result;
  } catch (error) {
    logger.error('[Cleanup] Failed to cleanup missing files', {
      error: error.message,
      stack: error.stack,
      deviceId
    });
    throw error;
  }
}

