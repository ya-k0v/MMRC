/**
 * API Routes для работы с папками изображений
 * @module routes/folders
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { DEVICES } from '../config/constants.js';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import { getFolderImages, getFolderImagesCount } from '../converters/folder-converter.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Настройка роутера для папок
 * @param {Object} deps - Зависимости
 * @returns {express.Router} Настроенный роутер
 */
export function createFoldersRouter(deps) {
  const { devices, requireAuth } = deps;
  
  // GET /api/devices/:id/folder/:folderName/images - Получить список изображений (публичный - для плеера)
  router.get('/:id/folder/:folderName/images', async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    const folderName = req.params.folderName;
    
    if (!id || !devices[id]) {
      return res.status(404).json({ error: 'device not found' });
    }
    
    if (!folderName) {
      return res.status(400).json({ error: 'folder name required' });
    }
    
    try {
      const images = await getFolderImages(id, folderName);
      res.json({ images, count: images.length });
    } catch (error) {
      logger.error('[folders] Error getting folder images', { error: error.message, stack: error.stack, deviceId: id, folderName });
      res.status(500).json({ error: 'failed to get folder images' });
    }
  });
  
  // GET /api/devices/:id/folder/:folderName/count - Получить количество (требует auth)
  router.get('/:id/folder/:folderName/count', requireAuth, async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    const folderName = req.params.folderName;
    
    if (!id || !devices[id]) {
      return res.status(404).json({ error: 'device not found' });
    }
    
    if (!folderName) {
      return res.status(400).json({ error: 'folder name required' });
    }
    
    try {
      const count = await getFolderImagesCount(id, folderName);
      res.json({ count });
    } catch (error) {
      logger.error('[folders] Error getting folder count', { error: error.message, stack: error.stack, deviceId: id, folderName });
      res.status(500).json({ error: 'failed to get folder count' });
    }
  });
  
  // GET /api/devices/:id/folder/:folderName/image/:index - Получить изображение (публичный - для <img>)
  router.get('/:id/folder/:folderName/image/:index', async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    const folderName = req.params.folderName;
    const index = parseInt(req.params.index, 10);
    
    if (!id || !devices[id]) {
      return res.status(404).json({ error: 'device not found' });
    }
    
    if (!folderName || isNaN(index) || index < 1) {
      return res.status(400).json({ error: 'invalid parameters' });
    }
    
    try {
      const images = await getFolderImages(id, folderName);
      
      if (index > images.length) {
        return res.status(404).json({ error: 'image not found' });
      }
      
      const imageName = images[index - 1]; // Convert to 0-based
      const imagePath = path.join(DEVICES, id, folderName, imageName);
      
      if (!fs.existsSync(imagePath)) {
        return res.status(404).json({ error: 'image file not found' });
      }
      
      // Отправляем изображение
      res.sendFile(imagePath, (err) => {
        if (err) {
          logger.error('[folders] Error sending image', { error: err.message, stack: err.stack, deviceId: id, folderName, index, imagePath });
          if (!res.headersSent) {
            res.status(500).json({ error: 'failed to send image' });
          }
        }
      });
    } catch (error) {
      logger.error('[folders] Error getting folder image', { error: error.message, stack: error.stack, deviceId: id, folderName, index });
      res.status(500).json({ error: 'failed to get folder image' });
    }
  });
  
  return router;
}

export default createFoldersRouter;

