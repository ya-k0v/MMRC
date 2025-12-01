/**
 * Deduplication Routes - дедупликация файлов по MD5
 * @module routes/deduplication
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { DEVICES } from '../config/constants.js';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import { findDuplicateFile, saveFileMetadata, getFileMetadata } from '../database/files-metadata.js';
import { getDatabase } from '../database/database.js';
import { auditLog, AuditAction } from '../utils/audit-logger.js';
import logger, { logFile } from '../utils/logger.js';

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
   */
  router.post('/:id/check-duplicate', async (req, res) => {
    const targetDeviceId = sanitizeDeviceId(req.params.id);
    const { md5, size, filename } = req.body;
    
    if (!targetDeviceId || !md5 || !size) {
      return res.status(400).json({ error: 'device_id, md5, and size required' });
    }
    
    if (!devices[targetDeviceId]) {
      return res.status(404).json({ error: 'device not found' });
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
    const duplicate = findDuplicateFile(md5, size, targetDeviceId, isBigFile);
    
    if (duplicate) {
      logFile('info', '✅ Duplicate found!', {
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
      logFile('info', '❌ No duplicate found - will upload', {
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
   */
  router.post('/:id/copy-from-duplicate', async (req, res) => {
    const targetDeviceId = sanitizeDeviceId(req.params.id);
    const { sourceDevice, sourceFile, targetFilename, originalName, md5, size } = req.body;
    
    if (!targetDeviceId || !sourceDevice || !sourceFile || !targetFilename) {
      return res.status(400).json({ error: 'missing required parameters' });
    }
    
    const targetDevice = devices[targetDeviceId];
    const srcDevice = devices[sourceDevice];
    
    if (!targetDevice || !srcDevice) {
      return res.status(404).json({ error: 'device not found' });
    }
    
    try {
      // Копируем метаданные из исходного файла (БЕЗ физического копирования!)
      const sourceMetadata = getFileMetadata(sourceDevice, sourceFile);
      
      if (!sourceMetadata) {
        return res.status(404).json({ error: 'source metadata not found' });
      }
      
      // НОВОЕ: Проверяем существование физического файла
      if (!fs.existsSync(sourceMetadata.file_path)) {
        logFile('error', 'Physical file missing for metadata', {
          sourceDevice,
          sourceFile,
          expectedPath: sourceMetadata.file_path
        });
        return res.status(404).json({ error: 'source file not found' });
      }
      
      const stats = fs.statSync(sourceMetadata.file_path);
      
      logFile('info', '⚡ Instant copy via deduplication (DB only)', {
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
      saveFileMetadata({
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
        fileMtime: stats.mtimeMs
      });
      
      logFile('info', '✅ Instant copy completed (0 bytes transferred)', {
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
      res.status(500).json({ error: 'failed to copy file' });
    }
  });
  
  /**
   * GET /api/duplicates/list
   * Получить список всех дубликатов в системе
   */
  router.get('/list', async (req, res) => {
    try {
      const db = getDatabase();
      const duplicates = db.prepare(`SELECT * FROM file_duplicates`).all();
      
      res.json(duplicates);
    } catch (error) {
      logger.error('Failed to get duplicates list', { error: error.message });
      res.status(500).json({ error: 'failed to get duplicates' });
    }
  });
  
  return router;
}
