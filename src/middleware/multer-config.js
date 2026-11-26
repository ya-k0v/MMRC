/**
 * Конфигурация Multer для загрузки файлов
 * @module middleware/multer-config
 */

import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_FILE_SIZE, ALLOWED_EXT } from '../config/constants.js';
import { getDevicesPath } from '../config/settings-manager.js';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import { fixEncoding } from '../utils/encoding.js';
import { makeSafeFilename } from '../utils/transliterate.js';
import { createModuleLogger } from '../utils/logger.js';
import { getCurrentStorage } from '../storage/current.js';
import { findAvailableSafeName } from '../storage/unique-name.js';
const logger = createModuleLogger('file');

/**
 * Создает настроенный Multer middleware для загрузки файлов
 * @param {Object} devices - Объект devices
 * @returns {multer} Настроенный multer instance
 */
export function createUploadMiddleware(devices) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const id = sanitizeDeviceId(req.params.id);

      if (!id) {
        return cb(new Error('invalid device id'));
      }

      const d = devices[id];
      if (!d) {
        return cb(new Error('device not found'));
      }

      // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
      // Это важно, так как contentRoot может измениться через настройки
      const folder = getDevicesPath();  // Динамический путь из настроек

      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
      }

      logger.debug(`[Multer] Upload destination: ${folder}`, { folder, deviceId: id, filename: file.originalname });
      cb(null, folder);
    },

    filename: async (req, file, cb) => {
      try {
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
          logger.warn(`[Multer] Ошибка исправления кодировки`, { error: e.message, fileName: originalName, stack: e.stack });
        }

        const base = path.basename(originalName);

        // Сохраняем маппинг оригинального имени
        req.originalFileNames = req.originalFileNames || new Map();

        // Создаем безопасное имя файла через транслитерацию
        const safe = makeSafeFilename(base);

        // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
        const devicesPath = getDevicesPath();
        const storage = getCurrentStorage();

        // Учитываем не только файл, но и папку/объект S3 с тем же именем,
        // а для PDF/PPTX/ZIP — ещё и папку, которая появится после конвертации.
        const finalSafeName = await findAvailableSafeName(safe, devicesPath, storage);

        if (finalSafeName !== safe) {
          logger.debug(`[Multer] Имя занято, добавлен суффикс: ${safe} → ${finalSafeName}`, { safe, finalSafeName, deviceId: id });
        }

        req.originalFileNames.set(finalSafeName, base);
        logger.debug(`[Multer] "${base}" → "${finalSafeName}"`, { originalName: base, safeName: finalSafeName, deviceId: id });
        cb(null, finalSafeName);
      } catch (error) {
        cb(error);
      }
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

