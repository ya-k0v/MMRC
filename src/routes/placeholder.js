/**
 * API Routes для управления заглушками (placeholder)
 * @module routes/placeholder
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { DEVICES, ALLOWED_EXT } from '../config/constants.js';
import { sanitizeDeviceId, isSystemFile } from '../utils/sanitize.js';
import { scanDeviceFiles } from '../utils/file-scanner.js';
import { getDatabase } from '../database/database.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Настройка роутера для заглушек
 * @param {Object} deps - Зависимости {devices, io}
 * @returns {express.Router} Настроенный роутер
 */
export function createPlaceholderRouter(deps) {
  const { devices, io, fileNamesMap } = deps;
  
  // GET /api/devices/:id/placeholder - Получить текущую заглушку устройства
  // НОВОЕ: Используем БД вместо поиска файла default.*
  router.get('/:id/placeholder', (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'invalid device id' });
    }
    
    const d = devices[id];
    if (!d) {
      return res.status(404).json({ error: 'device not found' });
    }
    
    try {
      // Ищем файл с флагом is_placeholder в БД
      const db = getDatabase();
      const placeholder = db.prepare(`
        SELECT safe_name, file_path, mime_type FROM files_metadata 
        WHERE device_id = ? AND is_placeholder = 1
        LIMIT 1
      `).get(id);
      
      if (placeholder && fs.existsSync(placeholder.file_path)) {
        logger.info('[placeholder] ✅ Placeholder found in DB', { 
          deviceId: id, 
          fileName: placeholder.safe_name,
          mimeType: placeholder.mime_type
        });
        return res.json({ 
          placeholder: placeholder.safe_name,
          mimeType: placeholder.mime_type
        });
      }
      
      logger.info('[placeholder] ℹ️ No placeholder set', { deviceId: id });
      res.json({ placeholder: null });
      
    } catch (error) {
      logger.error('[placeholder] Error getting placeholder', { 
        error: error.message, 
        deviceId: id 
      });
    res.json({ placeholder: null });
    }
  });
  
  // POST /api/devices/:id/make-default - Установить файл как заглушку
  // НОВОЕ: Мгновенная установка через БД (без копирования!)
  router.post('/:id/make-default', (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'invalid device id' });
    }
    
    const { file } = req.body || {};
    const d = devices[id];
    
    if (!d) {
      return res.status(404).json({ error: 'device not found' });
    }
    
    if (!file || typeof file !== 'string') {
      return res.status(400).json({ error: 'file required' });
    }
    
    const ext = (path.extname(file) || '').toLowerCase();
    
    if (!ALLOWED_EXT.test(ext)) {
      return res.status(400).json({ error: 'unsupported type' });
    }
    
    if (ext === '.pdf' || ext === '.pptx') {
      return res.status(400).json({ error: 'pdf_pptx_not_allowed_as_placeholder' });
    }

    try {
      const db = getDatabase();
      
      // 1. Снимаем флаг заглушки со всех файлов этого устройства
      db.prepare(`
        UPDATE files_metadata 
        SET is_placeholder = 0 
        WHERE device_id = ?
      `).run(id);
      
      // 2. Устанавливаем флаг заглушки на выбранный файл
      const result = db.prepare(`
        UPDATE files_metadata 
        SET is_placeholder = 1 
        WHERE device_id = ? AND safe_name = ?
      `).run(id, file);
      
      if (result.changes === 0) {
        return res.status(404).json({ error: 'file not found in database' });
      }
      
      logger.info('[make-default] ✅ Placeholder set instantly via DB', { 
        deviceId: id, 
        fileName: file 
      });

    io.emit('devices/updated');
    io.to(`device:${id}`).emit('player/stop', { reason: 'placeholder_refresh' });
    
      // Возвращаем успешный ответ
      res.json({ ok: true, placeholder: file, instant: true });
    
      // Асинхронно отправляем события клиентам
      setTimeout(() => {
        io.to(`device:${id}`).emit('placeholder/refresh');
        io.emit('preview/refresh', { device_id: id });
        logger.info('[make-default] 📡 Placeholder refresh events sent', { deviceId: id });
      }, 100); // Минимальная задержка для синхронизации
        
      } catch (e) {
      logger.error('[make-default] Error setting placeholder', { 
        error: e.message, 
        deviceId: id, 
        file 
      });
      return res.status(500).json({ error: 'failed to set placeholder', detail: e.message });
    }
  });
  
  return router;
}

