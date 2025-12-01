/**
 * Конфигурация Express middleware
 * @module middleware/express-config
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import mime from 'mime';
import { PUBLIC, ROOT, DEVICES } from '../config/constants.js';
import { getStreamsOutputDir } from '../config/settings-manager.js';
import { requestTimeout } from './timeout.js';
import logger from '../utils/logger.js';
import { getStreamManager } from '../streams/stream-manager.js';

/**
 * Настраивает базовые Express middleware
 * @param {express.Application} app - Express приложение
 */
export function setupExpressMiddleware(app) {
  // КРИТИЧНО: Настраиваем доверие к прокси (nginx)
  // Позволяет Express читать реальный IP клиента из заголовков X-Forwarded-For и X-Real-IP
  app.set('trust proxy', true);
  
  // Таймауты для всех запросов (30 секунд по умолчанию)
  app.use(requestTimeout(30000));
  
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
      logger.debug('HTTP request', { method: req.method, url: req.url, ip: req.ip });
    } catch(e) {}
    next();
  });
}

/**
 * Настраивает статичные файлы и контент
 * @param {express.Application} app - Express приложение
 */
export function setupStaticFiles(app) {
  // Статичные файлы интерфейса с правильной обработкой JS файлов
  app.use(express.static(PUBLIC, {
    setHeaders: (res, filePath) => {
      // Для JS файлов устанавливаем правильные заголовки
      // КРИТИЧНО: Отключаем compression/gzip для JS файлов чтобы избежать ERR_CONTENT_LENGTH_MISMATCH
      if (/\.js$/i.test(filePath)) {
        // Удаляем заголовки компрессии если они есть
        if (res.getHeader('Content-Encoding')) {
          res.removeHeader('Content-Encoding');
        }
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      }
      // Для CSS файлов
      if (/\.css$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
      }
    }
  }));
  
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
  
  // HLS стримы (рестрим через FFmpeg)
  // КРИТИЧНО: Используем кастомный роутер для HLS, чтобы отключить буферизацию
  // и правильно обрабатывать Range requests для сегментов, которые пишутся в реальном времени
  app.use('/streams', async (req, res, next) => {
    // КРИТИЧНО: req.originalUrl содержит полный путь с префиксом '/streams'
    // Например: '/streams/001TV/SimaTV/index.m3u8' -> '/001TV/SimaTV/index.m3u8'
    // Используем его для вычисления относительного пути и корректного парсинга deviceId/safeName
    let relativePath = req.originalUrl.startsWith('/streams')
      ? req.originalUrl.substring('/streams'.length)
      : req.path;
    // Убираем ведущий слэш, если есть, для правильного path.join
    if (relativePath.startsWith('/')) {
      relativePath = relativePath.substring(1);
    }
    const filePath = path.join(getStreamsOutputDir(), relativePath);
    
    // КРИТИЧНО: Возможна гонка между запуском FFmpeg и первым запросом плейлиста/сегмента.
    // Вместо немедленного 404 подождем немного появления файла.
    const maxWaitMs = 5000; // максимум 5 секунд
    const checkIntervalMs = 100;
    const waitStart = Date.now();
    
    while (!fs.existsSync(filePath) && (Date.now() - waitStart) < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    }
    
    // Повторная проверка после ожидания
    if (!fs.existsSync(filePath)) {
      logger.warn('[Express] Stream file not found (after wait)', {
        reqPath: req.path,
        relativePath,
        filePath,
        existsRoot: fs.existsSync(getStreamsOutputDir()),
        waitedMs: Date.now() - waitStart
      });
      return res.status(404).send('File not found');
    }
    
    const stats = fs.statSync(filePath);
    
    // Для HLS плейлистов (.m3u8)
    if (/\.m3u8$/i.test(filePath)) {
      // КРИТИЧНО: Обновляем время последнего доступа при каждом запросе плейлиста
      // Это позволяет отслеживать активность стрима для автоматической остановки FFmpeg
      const pathParts = relativePath.split('/').filter(Boolean);
      if (pathParts.length >= 2) {
        const deviceId = decodeURIComponent(pathParts[0]);
        const safeName = decodeURIComponent(pathParts[1]);
        const streamManager = getStreamManager();
        if (streamManager) {
          streamManager.updateLastAccess(deviceId, safeName);
        }
      }
      
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      // КРИТИЧНО: Усиленные заголовки для предотвращения кэширования m3u8 плейлистов
      // Это решает проблему, когда плеер воспроизводит старые сегменты после перезапуска стрима
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Accel-Buffering', 'no'); // Отключаем буферизацию в Nginx
      
      // Читаем файл и отправляем без буферизации
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      return;
    }
    
    // Для HLS сегментов (.ts)
    if (/\.ts$/i.test(filePath)) {
      // КРИТИЧНО: Обновляем время последнего доступа при каждом запросе сегмента
      // Это позволяет отслеживать активность стрима для автоматической остановки FFmpeg
      const pathParts = relativePath.split('/').filter(Boolean);
      if (pathParts.length >= 2) {
        const deviceId = decodeURIComponent(pathParts[0]);
        const safeName = decodeURIComponent(pathParts[1]);
        const streamManager = getStreamManager();
        if (streamManager) {
          streamManager.updateLastAccess(deviceId, safeName);
        }
      }
      
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); // Не кэшируем, так как файлы меняются
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Accel-Buffering', 'no'); // КРИТИЧНО: Отключаем буферизацию в Nginx
      
      // КРИТИЧНО: Для активных сегментов (которые пишутся FFmpeg в реальном времени)
      // НЕ устанавливаем Content-Length, используем Transfer-Encoding: chunked
      // Это предотвращает ERR_CONTENT_LENGTH_MISMATCH, когда файл изменяется во время передачи
      
      // КРИТИЧНО: Для активных HLS сегментов (которые пишутся FFmpeg в реальном времени)
      // НЕ обрабатываем Range requests, так как файл может изменяться во время передачи
      // Это вызывает ERR_CONTENT_LENGTH_MISMATCH для 206 Partial Content ответов
      // Вместо этого всегда отправляем полный файл через chunked transfer
      
      // Проверяем, является ли файл активным сегментом (недавно изменен)
      const stats = fs.statSync(filePath);
      const fileAge = Date.now() - stats.mtimeMs;
      const isActiveSegment = fileAge < 10000; // Файл изменялся менее 10 секунд назад
      
      // Если это активный сегмент - игнорируем Range requests и отправляем полный файл
      if (isActiveSegment && req.headers.range) {
        // Игнорируем Range request для активных сегментов
        // Отправляем полный файл через chunked transfer
        const stream = fs.createReadStream(filePath);
        stream.on('error', (err) => {
          if (!res.headersSent) {
            res.status(500).end();
          }
        });
        stream.pipe(res);
        return;
      }
      
      // Для старых сегментов (которые уже полностью записаны) обрабатываем Range requests
      const range = req.headers.range;
      if (range && !isActiveSegment) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
        const chunksize = (end - start) + 1;
        
        res.status(206); // Partial Content
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
        res.setHeader('Content-Length', chunksize);
        
        const stream = fs.createReadStream(filePath, { start, end });
        stream.on('error', (err) => {
          if (!res.headersSent) {
            res.status(500).end();
          }
        });
        stream.pipe(res);
      } else {
        // Полный файл - используем chunked transfer (без Content-Length)
        // Это критично для активных сегментов, которые пишутся FFmpeg в реальном времени
        const stream = fs.createReadStream(filePath);
        stream.on('error', (err) => {
          if (!res.headersSent) {
            res.status(500).end();
          }
        });
        stream.pipe(res);
      }
      return;
    }
    
    // Для других файлов используем стандартный static
    next();
  });
}

