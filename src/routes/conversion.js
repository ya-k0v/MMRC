/**
 * API Routes для конвертации PDF/PPTX документов
 * @module routes/conversion
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import mime from 'mime';
import { DEVICES } from '../config/constants.js';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import logger from '../utils/logger.js';

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
      return res.status(400).json({ error: 'invalid device id' });
    }
    
    const fileName = req.query.file;
    const type = req.query.type;
    
    if (!fileName) {
      return res.status(400).json({ error: 'file query parameter required' });
    }
    
    if (!devices[id]) {
      return res.status(404).json({ error: 'device not found' });
    }
    
    try {
      const count = await getPageSlideCount(id, fileName);
      res.json({ count });
    } catch (error) {
      logger.error(`[slides-count] ❌ Ошибка`, { error: error.message, stack: error.stack, deviceId: id, fileName });
      res.status(500).json({ error: 'failed to get slide count' });
    }
  });
  
  // GET /api/devices/:id/converted/:file/:type/:num - Получить изображение (публичный - для <img>)
  router.get('/:id/converted/:file/:type/:num', async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'invalid device id' });
    }
    
    const fileName = decodeURIComponent(req.params.file);
    const type = req.params.type;
    const num = parseInt(req.params.num);
    
    if (!devices[id]) {
      return res.status(404).json({ error: 'device not found' });
    }
    
    if (isNaN(num) || num < 1) {
      return res.status(400).json({ error: 'invalid page number' });
    }
    
    let convertedDir = findFileFolder(id, fileName);
    
    if (!convertedDir) {
      const filePath = path.join(DEVICES, id, fileName);
      if (fs.existsSync(filePath)) {
        const count = await autoConvertFileWrapper(id, fileName);
        if (count === 0) {
          return res.status(500).json({ error: 'Conversion failed or in progress' });
        }
        convertedDir = findFileFolder(id, fileName);
      }
      if (!convertedDir) {
        return res.status(404).json({ error: 'file not found' });
      }
    }
    
    try {
      const pngFiles = fs.readdirSync(convertedDir)
        .filter(f => f.toLowerCase().endsWith('.png'))
        .sort();
      
      if (num > pngFiles.length) {
        return res.status(404).json({ error: 'page not found' });
      }
      
      const imagePath = path.join(convertedDir, pngFiles[num - 1]);
      const mimeType = mime.getType(imagePath) || 'application/octet-stream';
      
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      
      const stream = fs.createReadStream(imagePath);
      stream.pipe(res);
      
    } catch (error) {
      logger.error(`[converted] ❌ Ошибка`, { error: error.message, stack: error.stack, deviceId: id, fileName, type, num });
      res.status(500).json({ error: 'failed to serve converted file' });
    }
  });
  
  return router;
}

