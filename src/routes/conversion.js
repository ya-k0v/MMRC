/**
 * API Routes для конвертации PDF/PPTX документов
 * @module routes/conversion
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import mime from 'mime';
import { getDevicesPath } from '../config/settings-manager.js';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import { hasDeviceAccess } from '../middleware/device-access.js';
import logger from '../utils/logger.js';
import { getFolderImagesCount } from '../converters/folder-converter.js';

const router = express.Router();

/**
 * Настройка роутера для конвертации документов
 * @param {Object} deps - Зависимости
 * @returns {express.Router} Настроенный роутер
 */
export function createConversionRouter(deps) {
  const { devices, getPageSlideCount, findFileFolder, autoConvertFileWrapper, requireAuth } = deps;
  
  // GET /api/devices/:id/slides-count - Получить количество слайдов/страниц (требует auth)
  router.get('/:id/slides-count', requireAuth, async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }

    if (!hasDeviceAccess(req.user.userId, id, req.user.role)) {
      return res.status(403).json({ error: 'Доступ к устройству запрещен' });
    }
    
    const fileName = req.query.file;
    
    if (!fileName) {
      return res.status(400).json({ error: 'Требуется параметр file' });
    }
    
    const device = devices[id];
    if (!device) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    // Сначала пробуем взять количество кадров из текущего состояния устройства
    const normalizedFile = fileName.replace(/\.zip$/i, '');
    if (device.current && (device.current.file === fileName || device.current.file === normalizedFile || device.current.playlistFile === fileName)) {
      const count = device.current.folderImageCount || device.current.totalSlides;
      if (typeof count === 'number' && count > 0) {
        return res.json({ count });
      }
    }
    
    // Затем пробуем взять из массива файлов (метаданные)
    if (Array.isArray(device.fileMetadata) && device.fileMetadata.length) {
      const meta = device.fileMetadata.find(m =>
        m.safeName === fileName ||
        m.safeName === normalizedFile ||
        m.originalName === fileName ||
        m.originalName === normalizedFile
      );
      if (meta && typeof meta.folderImageCount === 'number' && meta.folderImageCount > 0) {
        return res.json({ count: meta.folderImageCount });
      }
    }
    
    try {
      const ext = path.extname(fileName).toLowerCase();
      let count = 0;
      if (!ext || ext === '.zip') {
        // Папка с изображениями
        const folderName = fileName.replace(/\.zip$/i, '');
        count = await getFolderImagesCount(id, folderName);
      } else if (ext === '.pdf' || ext === '.pptx') {
        // КРИТИЧНО: Пробуем получить количество слайдов по исходному имени файла
        count = await getPageSlideCount(id, fileName);
        
        // Если не получилось (файл уже конвертирован и удален), пробуем по имени папки
        if (count === 0) {
          const folderName = fileName.replace(/\.(pdf|pptx)$/i, '');
          count = await getFolderImagesCount(id, folderName);
        }
      } else {
        // Для других типов файлов пробуем getPageSlideCount
        count = await getPageSlideCount(id, fileName);
        
        // Если не получилось, пробуем как папку (возможно, файл уже конвертирован)
        if (count === 0) {
          count = await getFolderImagesCount(id, fileName);
        }
      }
      res.json({ count });
    } catch (error) {
      logger.error(`[slides-count] ❌ Ошибка`, { error: error.message, stack: error.stack, deviceId: id, fileName });
      res.status(500).json({ error: 'Не удалось получить количество слайдов' });
    }
  });
  
  // GET /api/devices/:id/converted/:file/:type/:num - Получить изображение (публичный - для <img>)
  router.get('/:id/converted/:file/:type/:num', async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }
    
    const fileName = decodeURIComponent(req.params.file);
    const type = req.params.type;
    const num = parseInt(req.params.num);
    
    if (!devices[id]) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    if (isNaN(num) || num < 1) {
      return res.status(400).json({ error: 'Неверный номер страницы' });
    }
    
    // КРИТИЧНО: Используем devices[id].folder для получения правильного пути
    // Это важно, так как folder может отличаться от deviceId (хотя обычно совпадает)
    const deviceFolder = devices[id]?.folder || id;
    let convertedDir = findFileFolder(deviceFolder, fileName);
    
    if (!convertedDir) {
      // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
      const devicesPath = getDevicesPath();
      const filePath = path.join(devicesPath, deviceFolder, fileName);
      if (fs.existsSync(filePath)) {
        const count = await autoConvertFileWrapper(id, fileName);
        if (count === 0) {
          return res.status(500).json({ error: 'Конвертация не удалась или выполняется' });
        }
        convertedDir = findFileFolder(deviceFolder, fileName);
      }
      if (!convertedDir) {
        return res.status(404).json({ error: 'Файл не найден' });
      }
    }
    
    try {
      const pngFiles = fs.readdirSync(convertedDir)
        .filter(f => f.toLowerCase().endsWith('.png'))
        .sort();
      
      if (num > pngFiles.length) {
        return res.status(404).json({ error: 'Страница не найдена' });
      }
      
      const imagePath = path.join(convertedDir, pngFiles[num - 1]);
      const mimeType = mime.getType(imagePath) || 'application/octet-stream';
      
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      
      const stream = fs.createReadStream(imagePath);
      
      // КРИТИЧНО: Обрабатываем закрытие соединения клиентом
      let isAborted = false;
      const cleanup = () => {
        isAborted = true;
        if (stream && !stream.destroyed) {
          stream.destroy();
        }
      };
      
      req.on('close', cleanup);
      req.on('aborted', cleanup);
      res.on('close', cleanup);
      
      stream.on('error', (err) => {
        if (!isAborted) {
          logger.error('[Conversion] Stream error', { 
            error: err.message, 
            imagePath 
          });
          if (!res.headersSent) {
            res.status(500).end();
          } else {
            res.end();
          }
        }
        cleanup();
      });
      
      stream.pipe(res);
      
    } catch (error) {
      logger.error(`[converted] ❌ Ошибка`, { error: error.message, stack: error.stack, deviceId: id, fileName, type, num });
      res.status(500).json({ error: 'Не удалось отдать конвертированный файл' });
    }
  });
  
  return router;
}

