/**
 * Конфигурация Multer для загрузки файлов
 * @module middleware/multer-config
 */

import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MAX_FILE_SIZE, ALLOWED_EXT } from '../config/constants.js';
import { getDevicesPath } from '../config/settings-manager.js';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import { fixEncoding } from '../utils/encoding.js';
import { makeSafeFilename } from '../utils/transliterate.js';
import logger from '../utils/logger.js';

/**
 * Создает настроенный Multer middleware для загрузки файлов
 * @param {Object} devices - Объект devices
 * @returns {multer} Настроенный multer instance
 */
export function createUploadMiddleware(devices) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      console.error('[MULTER] ===== DESTINATION CALLED =====');
      console.error('[MULTER] Original filename:', file.originalname);
      console.error('[MULTER] MIME type:', file.mimetype);
      console.error('[MULTER] Field name:', file.fieldname);
      
      const id = sanitizeDeviceId(req.params.id);
      console.error('[MULTER] Device ID:', id);
      
      if (!id) {
        console.error('[MULTER] ❌ Invalid device ID');
        return cb(new Error('invalid device id'));
      }
      
      const d = devices[id];
      if (!d) {
        console.error('[MULTER] ❌ Device not found:', id);
        return cb(new Error('device not found'));
      }
      
      // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
      // Это важно, так как contentRoot может измениться через настройки
      const folder = getDevicesPath();  // Динамический путь из настроек
      console.error('[MULTER] Destination folder:', folder);
      
      if (!fs.existsSync(folder)) {
        console.error('[MULTER] Creating folder:', folder);
        fs.mkdirSync(folder, { recursive: true });
      }
      
      console.error('[MULTER] ✅ Destination set:', folder);
      logger.error(`[Multer] 📂 Upload destination: ${folder} (shared storage)`, { folder, deviceId: id, filename: file.originalname });
      cb(null, folder);
    },
    
    filename: (req, file, cb) => {
      console.error('[MULTER] ===== FILENAME CALLED =====');
      console.error('[MULTER] Original filename:', file.originalname);
      
      // Запрещаем загрузку файлов с зарезервированными именами
      if (file.originalname.toLowerCase() === 'default.mp4') {
        console.error('[MULTER] ❌ Reserved filename rejected');
        return cb(new Error('reserved filename'));
      }
      
      const id = sanitizeDeviceId(req.params.id);
      if (!id || !devices[id]) {
        console.error('[MULTER] ❌ Device not found:', id);
        return cb(new Error('device not found'));
      }
      
      let originalName = file.originalname;
      
      // Исправляем кодировку имени файла
      try {
        if (Buffer.isBuffer(originalName)) {
          originalName = originalName.toString('utf-8');
        } else if (typeof originalName === 'string') {
          const fixed = fixEncoding(originalName);
          if (fixed !== originalName) originalName = fixed;
        }
      } catch (e) {
        logger.warn(`[Multer] ⚠️ Ошибка исправления кодировки`, { error: e.message, fileName: originalName, stack: e.stack });
      }
      
      const base = path.basename(originalName);
      console.error('[MULTER] Base filename:', base);
      
      // Сохраняем маппинг оригинального имени
      req.originalFileNames = req.originalFileNames || new Map();
      
      // Создаем безопасное имя файла через транслитерацию
      const safe = makeSafeFilename(base);
      console.error('[MULTER] Safe filename:', safe);
      
      // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
      const devicesPath = getDevicesPath();
      const dest = path.join(devicesPath, safe);
      
      let finalSafeName = safe;
      
      // Если файл с таким именем существует - добавляем случайный суффикс
      if (fs.existsSync(dest)) {
        const ext = path.extname(safe);
        const name = path.basename(safe, ext);
        const suffix = '_' + crypto.randomBytes(3).toString('hex');
        finalSafeName = `${name}${suffix}${ext}`;
        console.error('[MULTER] ⚠️ File exists, using suffix:', finalSafeName);
        logger.error(`[Multer] ⚠️ Файл существует, добавлен суффикс: ${safe} → ${finalSafeName}`, { safe, finalSafeName, deviceId: id });
      }
      
      req.originalFileNames.set(finalSafeName, base);
      console.error('[MULTER] ✅ Final safe name:', finalSafeName);
      console.error('[MULTER] Full path will be:', path.join(devicesPath, finalSafeName));
      logger.error(`[Multer] 📝 "${base}" → "${finalSafeName}"`, { originalName: base, safeName: finalSafeName, deviceId: id });
      cb(null, finalSafeName);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_EXT.test(file.originalname)) {
        return cb(new Error('unsupported type'));
      }
      cb(null, true);
    }
  });

  return upload;
}

/**
 * Middleware для проверки размера файла ДО начала загрузки
 * Проверяет Content-Length заголовок чтобы предотвратить DoS
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Express next
 */
export function validateUploadSize(req, res, next) {
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  
  if (contentLength > MAX_FILE_SIZE) {
    logger.warn('[Multer] Upload rejected: file too large', {
      contentLength,
      maxSize: MAX_FILE_SIZE,
      ip: req.ip
    });
    return res.status(413).json({ 
      error: 'File too large', 
      maxSize: MAX_FILE_SIZE,
      requestedSize: contentLength,
      maxSizeMB: Math.round(MAX_FILE_SIZE / 1024 / 1024),
      requestedSizeMB: Math.round(contentLength / 1024 / 1024)
    });
  }
  
  next();
}

