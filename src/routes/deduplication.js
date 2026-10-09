/**
 * Deduplication Routes - дедупликация файлов по MD5
 * @module routes/deduplication
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import { requireManager } from '../middleware/auth.js';
import { findDuplicateFile, saveFileMetadata, getFileMetadata } from '../database/files-metadata.js';
import { getDatabase } from '../database/database.js';
import { auditLog, AuditAction } from '../utils/audit-logger.js';
import { createModuleLogger, logFile } from '../utils/logger.js';
const logger = createModuleLogger('file');
import { VIDEO_EXTENSIONS } from '../config/file-types.js';
import { getCurrentStorage } from '../storage/current.js';
import { isLocalStorage, toStorageKey } from '../storage/sync.js';

const router = express.Router();

/**
 * Настройка роутера дедупликации
 * @param {Object} deps - Зависимости
 */
export function createDeduplicationRouter(deps) {
  const { devices, io, fileNamesMap, saveFileNamesMap, updateDeviceFilesFromDB } = deps;
  
  /**
   * POST /api/devices/:id/check-duplicate
   * Проверить есть ли файл с таким MD5/размером на других устройствах
   * Дедупликация применяется ТОЛЬКО для видео файлов
   */
  router.post('/:id/check-duplicate', requireManager, async (req, res) => {
    const targetDeviceId = sanitizeDeviceId(req.params.id);
    const { md5, size, filename } = req.body;
    
    if (!targetDeviceId || !md5 || !size) {
      return res.status(400).json({ error: 'Требуются device_id, md5 и size' });
    }
    
    if (!devices[targetDeviceId]) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    // Определяем тип файла по расширению
    const ext = path.extname(filename || '').toLowerCase().slice(1); // удаляем точку
    const isVideoFile = VIDEO_EXTENSIONS.includes(ext);
    
    // Дедупликация применяется ТОЛЬКО для видео файлов
    if (!isVideoFile) {
      logFile('info', 'Skipping deduplication check for non-video file', {
        targetDevice: targetDeviceId,
        filename,
        extension: ext,
        fileType: 'presentation/image/other'
      });
      
      return res.json({ duplicate: false });
    }
    
    const isBigFile = size > 100 * 1024 * 1024;
    
    logFile('info', 'Checking for duplicate', {
      targetDevice: targetDeviceId,
      filename,
      md5: md5.substring(0, 12),
      sizeMB: (size / 1024 / 1024).toFixed(2),
      isBigFile,
      searchType: isBigFile ? 'partial_md5' : 'full_md5'
    });
    
    // Ищем дубликат на других устройствах (partial MD5 для больших файлов)
    const duplicate = await findDuplicateFile(md5, size, targetDeviceId, isBigFile);
    
    if (duplicate) {
      logFile('info', 'Duplicate found!', {
        targetDevice: targetDeviceId,
        filename,
        sourceDevice: duplicate.device_id,
        sourceFile: duplicate.safe_name,
        md5: md5.substring(0, 12),
        sizeMB: (size / 1024 / 1024).toFixed(2)
      });
      
      res.json({
        duplicate: true,
        sourceDevice: duplicate.device_id,
        sourceFile: duplicate.safe_name,
        sourcePath: duplicate.file_path
      });
    } else {
      logFile('info', 'No duplicate found - will upload', {
        targetDevice: targetDeviceId,
        filename,
        md5: md5.substring(0, 12)
      });
      
      res.json({ duplicate: false });
    }
  });
  
  /**
   * POST /api/devices/:id/copy-from-duplicate
   * Мгновенное копирование файла через дедупликацию (только запись в БД)
   * Дедупликация применяется ТОЛЬКО для видео файлов
   */
  router.post('/:id/copy-from-duplicate', requireManager, async (req, res) => {
    const targetDeviceId = sanitizeDeviceId(req.params.id);
    const { sourceDevice, sourceFile, targetFilename, originalName, md5, size } = req.body;
    
    if (!targetDeviceId || !sourceDevice || !sourceFile || !targetFilename) {
      return res.status(400).json({ error: 'Отсутствуют обязательные параметры' });
    }
    
    // Проверяем тип файла - дедупликация только для видео
    const ext = path.extname(targetFilename || '').toLowerCase().slice(1); // удаляем точку
    const isVideoFile = VIDEO_EXTENSIONS.includes(ext);
    
    if (!isVideoFile) {
      logFile('warn', 'Attempt to copy non-video file via deduplication - rejected', {
        targetDevice: targetDeviceId,
        targetFilename,
        extension: ext
      });
      return res.status(400).json({ error: 'Дедупликация разрешена только для видеофайлов' });
    }
    
    const targetDevice = devices[targetDeviceId];
    const srcDevice = devices[sourceDevice];
    
    if (!targetDevice || !srcDevice) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    try {
      // Копируем метаданные из исходного файла (БЕЗ физического копирования!)
      const sourceMetadata = await getFileMetadata(sourceDevice, sourceFile);
      
      if (!sourceMetadata) {
        return res.status(404).json({ error: 'Метаданные исходного файла не найдены' });
      }
      
      // Проверяем существование файла с учётом S3. Раньше проверка шла только
      // по диску, поэтому мгновенное копирование было недоступно для любого
      // закоммиченного файла: возвращался 404 «Исходный файл не найден».
      const storage = getCurrentStorage();
      let sourceAvailable = fs.existsSync(sourceMetadata.file_path);

      if (!sourceAvailable && storage && !isLocalStorage(storage)) {
        try {
          sourceAvailable = await storage.exists(toStorageKey(sourceMetadata.file_path));
        } catch {
          sourceAvailable = false;
        }
      }

      if (!sourceAvailable) {
        logFile('error', 'Source file missing in disk or storage', {
          sourceDevice,
          sourceFile,
          expectedPath: sourceMetadata.file_path
        });
        return res.status(404).json({ error: 'Исходный файл не найден' });
      }

      // mtime берём из хранилища: локальной копии может не быть вообще,
      // и fs.statSync бросил бы исключение (500) вместо успешной операции
      let mtimeMs = Date.now();
      const localStat = fs.existsSync(sourceMetadata.file_path)
        ? fs.statSync(sourceMetadata.file_path)
        : null;
      if (localStat) {
        mtimeMs = localStat.mtimeMs;
      } else if (storage && !isLocalStorage(storage)) {
        const storageStat = await storage.stat(toStorageKey(sourceMetadata.file_path)).catch(() => null);
        if (storageStat?.lastModified) {
          mtimeMs = new Date(storageStat.lastModified).getTime();
        }
      }
      
      logFile('info', 'Instant copy via deduplication (DB only)', {
        sourceDevice,
        sourceFile,
        targetDevice: targetDeviceId,
        targetFile: targetFilename,
        sharedPath: sourceMetadata.file_path,
        md5: sourceMetadata.md5_hash?.substring(0, 12),
        partialMd5: sourceMetadata.partial_md5?.substring(0, 12),
        sizeMB: (sourceMetadata.file_size / 1024 / 1024).toFixed(2)
      });
      
      // МГНОВЕННОЕ КОПИРОВАНИЕ: создаем только запись в БД с reference на тот же физический файл
      await saveFileMetadata({
        deviceId: targetDeviceId,
        safeName: targetFilename,
        originalName: originalName || targetFilename,
        filePath: sourceMetadata.file_path,  // ТОТ ЖЕ путь к файлу!
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
        fileMtime: mtimeMs,
        uploadedBy: sourceMetadata.uploaded_by || null
      });
      
      logFile('info', 'Instant copy completed (0 bytes transferred)', {
        targetDevice: targetDeviceId,
        targetFile: targetFilename,
        md5: sourceMetadata.md5_hash?.substring(0, 12),
        savedTrafficMB: (sourceMetadata.file_size / 1024 / 1024).toFixed(2)
      });
      
      // Сохраняем маппинг оригинального имени
      if (originalName && originalName !== targetFilename) {
        if (!fileNamesMap[targetDeviceId]) fileNamesMap[targetDeviceId] = {};
        fileNamesMap[targetDeviceId][targetFilename] = originalName;
        saveFileNamesMap(fileNamesMap);
      }
      
      // Обновляем список файлов устройства из БД + папки
      updateDeviceFilesFromDB(targetDeviceId, devices, fileNamesMap);
      io.emit('devices/updated');
      
      // Audit log
      await auditLog({
        userId: req.user?.id || null,
        action: AuditAction.FILE_UPLOAD,
        resource: `device:${targetDeviceId}`,
        details: {
          deviceId: targetDeviceId,
          fileName: targetFilename,
          deduplication: true,
          copiedFrom: `${sourceDevice}:${sourceFile}`,
          md5: md5?.substring(0, 12),
          savedTraffic: size,
          uploadedBy: req.user?.username || 'anonymous'
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        status: 'success'
      });
      
      res.json({
        ok: true,
        deduplicated: true,
        copiedFrom: sourceDevice,
        savedTrafficMB: (size / 1024 / 1024).toFixed(2)
      });
      
    } catch (error) {
      logger.error('Deduplication copy failed', {
        error: error.message,
        sourceDevice,
        sourceFile,
        targetDevice: targetDeviceId
      });
      res.status(500).json({ error: 'Не удалось скопировать файл' });
    }
  });
  
  /**
   * GET /api/duplicates/list
   * Получить список всех дубликатов в системе
   */
  router.get('/list', async (req, res) => {
    try {
      const db = getDatabase();
      const duplicates = await db.query(`SELECT * FROM file_duplicates`);
      
      res.json(duplicates);
    } catch (error) {
      logger.error('Failed to get duplicates list', { error: error.message });
      res.status(500).json({ error: 'Не удалось получить дубликаты' });
    }
  });
  
  return router;
}
