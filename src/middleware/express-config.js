/**
 * Конфигурация Express middleware
 * @module middleware/express-config
 */

import express from 'express';
import path from 'path';
import mime from 'mime';
import { PUBLIC, ROOT, DEVICES } from '../config/constants.js';

/**
 * Настраивает базовые Express middleware
 * @param {express.Application} app - Express приложение
 */
export function setupExpressMiddleware(app) {
  // JSON парсинг (увеличенный лимит нужен для загрузки крупных base64 payload)
  app.use(express.json({ limit: '1.5gb' }));  // 1GB файл + 33% base64 overhead
  app.use(express.urlencoded({ extended: true, limit: '1.5gb' }));
  
  // Middleware для корректной кодировки JSON ответов
  app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return originalJson(data);
    };
    next();
  });
  
  // Логирование запросов
  app.use((req, res, next) => {
    try {
      console.log(new Date().toISOString(), req.method, req.url);
    } catch(e) {}
    next();
  });
}

/**
 * Настраивает статичные файлы и контент
 * @param {express.Application} app - Express приложение
 */
export function setupStaticFiles(app) {
  // Статичные файлы интерфейса
  app.use(express.static(PUBLIC));
  
  // Контент устройств с настройками кэширования
  app.use('/content', express.static(DEVICES, {
    extensions: ['.mp4', '.webm', '.ogg', '.jpg', '.jpeg', '.png', '.gif', '.pdf'],
    setHeaders: (res, filePath) => {
      const type = mime.getType(filePath) || 'application/octet-stream';
      res.setHeader('Content-Type', type);
      
      const isVideo = /\.(mp4|webm|ogg|mkv|mov|avi)$/i.test(filePath);
      if (isVideo) {
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
      }
      
      const fileName = path.basename(filePath);
      if (/^default\.(mp4|webm|ogg|mkv|mov|avi|mp3|wav|m4a|png|jpg|jpeg|gif|webp)$/i.test(fileName)) {
        // КРИТИЧНО: НЕ кэшируем default.* файлы (могут меняться через админ панель)
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Accept-Ranges', 'bytes');
      } else if (!isVideo) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
      
      // PDF файлы отображаем inline (в браузере)
      if (filePath.toLowerCase().endsWith && filePath.toLowerCase().endsWith('.pdf')) {
        try {
          res.setHeader('Content-Disposition', 'inline');
        } catch(e) {}
      }
    }
  }));
}

