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
      const id = sanitizeDeviceId(req.params.id);
      if (!id) return cb(new Error('invalid device id'));
      
      const d = devices[id];
      if (!d) return cb(new Error('device not found'));
      
      // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
      // Это важно, так как contentRoot может измениться через настройки
      const folder = getDevicesPath();  // Динамический путь из настроек
      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
      }
      
      logger.info(`[Multer] 📂 Upload destination: ${folder} (shared storage)`, { folder });
      cb(null, folder);
    },
    
    filename: (req, file, cb) => {
      // Запрещаем загрузку файлов с зарезервированными именами
      if (file.originalname.toLowerCase() === 'default.mp4') {
        return cb(new Error('reserved filename'));
      }
      
      const id = sanitizeDeviceId(req.params.id);
      if (!id || !devices[id]) {
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
      
      // Сохраняем маппинг оригинального имени
      req.originalFileNames = req.originalFileNames || new Map();
      
      // Создаем безопасное имя файла через транслитерацию
      const safe = makeSafeFilename(base);
      
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
        logger.info(`[Multer] ⚠️ Файл существует, добавлен суффикс: ${safe} → ${finalSafeName}`, { safe, finalSafeName, deviceId: id });
      }
      
      req.originalFileNames.set(finalSafeName, base);
      logger.debug(`[Multer] 📝 "${base}" → "${finalSafeName}"`, { originalName: base, safeName: finalSafeName, deviceId: id });
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

