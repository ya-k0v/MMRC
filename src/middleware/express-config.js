/**
 * Конфигурация Express middleware
 * @module middleware/express-config
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import mime from 'mime';
import { PUBLIC, ROOT } from '../config/constants.js';
import { getDevicesPath, getStreamsOutputDir } from '../config/settings-manager.js';
import { requestTimeout } from './timeout.js';
import logger from '../utils/logger.js';
import { getStreamManager } from '../streams/stream-manager.js';
import { getFileMetadata } from '../database/files-metadata.js';

/**
 * Санитизирует фрагмент пути (идентично stream-manager.js)
 * @param {string} value - Значение для санитизации
 * @returns {string} Безопасное имя
 */
function sanitizePathFragment(value = '') {
  return String(value)
    .replace(/[^a-zA-Z0-9\-_.]/g, '_')
    .substring(0, 200);
}

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
  // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
  const devicesPath = getDevicesPath();
  app.use('/content', express.static(devicesPath, {
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
    // КРИТИЧНО: Обработка всех ошибок для предотвращения 502 от nginx
    try {
      // КРИТИЧНО: Логируем все запросы к /streams для диагностики
      logger.info('[Express] Stream request', {
        method: req.method,
        url: req.originalUrl,
        path: req.path,
        ip: req.ip,
        userAgent: req.get('user-agent')
      });
      
    // КРИТИЧНО: req.originalUrl содержит полный путь с префиксом '/streams' и может содержать query string
    // Например: '/streams/001TV/SimaTV/index.m3u8?_t=123' -> '/001TV/SimaTV/index.m3u8'
    // req.path уже не содержит query string, поэтому используем его для извлечения пути
    // req.path будет '/streams/ya001/2x2/index.m3u8' даже если originalUrl содержит '?_t=...'
    let relativePath = req.path.startsWith('/streams')
      ? req.path.substring('/streams'.length)
      : req.path;
    // Убираем ведущий слэш, если есть, для правильного path.join
    if (relativePath.startsWith('/')) {
      relativePath = relativePath.substring(1);
    }
    // КРИТИЧНО: Декодируем URL-encoded части пути перед использованием в path.join
    // Это необходимо, так как в URL части пути могут быть закодированы (например, %2F -> /)
    // Но мы не декодируем весь путь целиком, а декодируем каждую часть отдельно
    // для безопасности (предотвращение path traversal)
    let decodedParts;
    try {
      decodedParts = relativePath.split('/').map(part => decodeURIComponent(part));
    } catch (err) {
      logger.warn('[Express] Failed to decode stream path', { relativePath, error: err.message });
      return res.status(400).send('Invalid path encoding');
    }
    
    // КРИТИЧНО: Применяем sanitizePathFragment к частям пути, как в stream-manager.js
    // Это гарантирует, что путь совпадает с тем, что создает FFmpeg
    // КРИТИЧНО: Убрали deviceId из пути - стримы теперь идентифицируются только по safeName
    // Путь должен быть: safeName/index.m3u8 или safeName/segment_00001.ts
    let filePath;
    if (decodedParts.length >= 1) {
      const safeName = decodedParts[0];
      const sanitizedFile = sanitizePathFragment(safeName);
      const restOfPath = decodedParts.slice(1).join('/'); // index.m3u8 или segment_00001.ts
      
      // КРИТИЧНО: Формируем путь так же, как в stream-manager.js._getPaths()
      // КРИТИЧНО: Убрали deviceId из пути - стримы теперь идентифицируются только по safeName
      // Используем getStreamsOutputDir() из настроек (contentRoot/streams)
      filePath = path.join(getStreamsOutputDir(), sanitizedFile, restOfPath);
      
      logger.debug('[Express] Stream file path constructed', {
        originalRelativePath: relativePath,
        safeName,
        sanitizedFile,
        restOfPath,
        filePath,
        streamsOutputDir: getStreamsOutputDir()
      });
    } else {
      // Fallback для некорректных путей
      filePath = path.join(getStreamsOutputDir(), relativePath);
      logger.warn('[Express] Invalid stream path format, using fallback', {
        relativePath,
        decodedParts,
        filePath
      });
    }
    
    // КРИТИЧНО: Возможна гонка между запуском FFmpeg и первым запросом плейлиста/сегмента.
    // Вместо немедленного 404 подождем немного появления файла, но только если FFmpeg запущен.
    // Увеличено до 15 секунд, так как ensureStreamRunning может занимать до 10-12 секунд
    const maxWaitMs = 15000; // максимум 15 секунд
    const checkIntervalMs = 100;
    const waitStart = Date.now();
    
    // КРИТИЧНО: Проверяем статус job через streamManager перед ожиданием
    // Если job не существует или остановлен - сразу возвращаем 404
    // КРИТИЧНО: Путь теперь: safeName/index.m3u8 (без deviceId)
    let shouldWait = false;
    if (decodedParts && decodedParts.length >= 1) {
      try {
        const safeName = decodedParts[0];
        const streamManager = getStreamManager();
        
        if (streamManager) {
          // КРИТИЧНО: Используем публичный метод для проверки статуса по safeName
          const jobStatus = streamManager.getJobStatusBySafeName(safeName);
          
          if (jobStatus && (jobStatus.status === 'starting' || jobStatus.status === 'running')) {
            shouldWait = true;
            logger.debug('[Express] Stream job is active, waiting for file', {
              safeName,
              status: jobStatus.status
            });
          } else if (!jobStatus) {
            // КРИТИЧНО: Job не существует - НЕ запускаем автоматически (lazy loading отключен)
            // Стрим должен быть запущен явно через control/play, а не автоматически при запросе плейлиста
            // Это предотвращает нежелательный запуск FFmpeg при простом просмотре списка стримов
            logger.debug('[Express] Stream job not found, not starting automatically (lazy loading disabled)', {
              safeName,
              message: 'Stream must be started explicitly via control/play'
            });
            // Не ждем и не запускаем - просто возвращаем 404
          } else {
            // Job существует, но в другом статусе - не ждем
            logger.debug('[Express] Stream job not active, not waiting', {
              safeName,
              status: jobStatus?.status || 'not_found'
            });
          }
        }
      } catch (err) {
        // Ошибка при проверке статуса - продолжаем с ожиданием (fallback)
        logger.debug('[Express] Error checking stream status, will wait', { error: err.message });
        shouldWait = true;
      }
    } else {
      // Не можем определить safeName - ждем (fallback)
      shouldWait = true;
    }
    
    // Ждем только если job активен
    if (shouldWait) {
      let waitedTime = 0;
      let checkCount = 0;
      const maxChecks = 30; // Максимум 30 попыток (15 секунд при интервале 500мс)
      const improvedCheckInterval = 500; // Улучшенный интервал проверки: 500мс вместо 100мс
      
      while (!fs.existsSync(filePath) && waitedTime < maxWaitMs && checkCount < maxChecks) {
        await new Promise(resolve => setTimeout(resolve, improvedCheckInterval));
        waitedTime = Date.now() - waitStart;
        checkCount++;
        
        // КРИТИЧНО: Проверяем не только существование, но и размер файла (минимум 100 байт)
        if (fs.existsSync(filePath)) {
          try {
            const stats = fs.statSync(filePath);
            if (stats.size >= 100) {
              // Файл существует и имеет достаточный размер
              logger.debug('[Express] Playlist file found with valid size', {
                filePath,
                size: stats.size,
                waitedTime
              });
              break;
            } else {
              logger.debug('[Express] Playlist file exists but too small, continuing wait', {
                filePath,
                size: stats.size,
                waitedTime
              });
            }
          } catch (statErr) {
            // Ошибка проверки размера - продолжаем ожидание
            logger.debug('[Express] Error checking file size, continuing wait', {
              error: statErr.message
            });
          }
        }
        
        // КРИТИЧНО: Периодически проверяем статус job, чтобы убедиться, что он все еще запускается
        if (waitedTime > 5000 && decodedParts && decodedParts.length >= 1) {
          try {
            const safeName = decodedParts[0];
            const streamManager = getStreamManager();
            if (streamManager) {
              const jobStatus = streamManager.getJobStatusBySafeName(safeName);
              // Если job остановился или не существует - прекращаем ожидание
              if (!jobStatus || (jobStatus.status !== 'starting' && jobStatus.status !== 'running')) {
                logger.warn('[Express] Stream job stopped or not found during wait, stopping wait', {
                  safeName,
                  status: jobStatus?.status || 'not_found',
                  waitedTime,
                  checkCount
                });
                break;
              }
            }
          } catch (err) {
            // Игнорируем ошибки проверки статуса
          }
        }
      }
      
      if (checkCount >= maxChecks) {
        logger.warn('[Express] Max check attempts reached while waiting for playlist', {
          filePath,
          waitedTime,
          checkCount
        });
      }
    }
    
    // Повторная проверка после ожидания
    if (!fs.existsSync(filePath)) {
      // КРИТИЧНО: Дополнительная диагностика - проверяем, существует ли папка устройства
      let diagnosticInfo = {
        reqPath: req.path,
        originalUrl: req.originalUrl,
        relativePath,
        filePath,
        existsRoot: fs.existsSync(getStreamsOutputDir()),
        waitedMs: Date.now() - waitStart,
        decodedParts,
        shouldWait
      };
      
      if (decodedParts && decodedParts.length >= 1) {
        // КРИТИЧНО: Применяем sanitizePathFragment для совпадения с путями из stream-manager.js
        const safeName = decodedParts[0];
        const sanitizedFile = sanitizePathFragment(safeName);
        const streamFolder = path.join(getStreamsOutputDir(), sanitizedFile);
        diagnosticInfo.streamFolderExists = fs.existsSync(streamFolder);
        
        if (fs.existsSync(streamFolder)) {
          try {
            diagnosticInfo.streamFolderContents = fs.readdirSync(streamFolder);
          } catch (e) {
            diagnosticInfo.streamFolderReadError = e.message;
          }
        }
        
        // КРИТИЧНО: Добавляем информацию о статусе job
        try {
          const streamManager = getStreamManager();
          if (streamManager) {
            const jobStatus = streamManager.getJobStatusBySafeName(safeName);
            if (jobStatus) {
              diagnosticInfo.streamStatus = jobStatus.status || 'not_found';
              diagnosticInfo.streamRestarts = jobStatus.restarts;
              diagnosticInfo.streamLastError = jobStatus.lastError;
            } else {
              diagnosticInfo.streamStatus = 'not_found';
            }
          }
        } catch (e) {
          diagnosticInfo.streamStatusCheckError = e.message;
        }
      }
      
      logger.warn('[Express] Stream file not found (after wait)', diagnosticInfo);
      return res.status(404).send('File not found');
    }
    
    const stats = fs.statSync(filePath);
    
    // КРИТИЧНО: Проверяем, что файл не пустой
    if (stats.size === 0) {
      logger.warn('[Express] Stream file is empty', {
        filePath,
        size: stats.size,
        url: req.originalUrl
      });
      
      // Для пустого плейлиста возвращаем 503 (Service Unavailable), а не 404
      // Это указывает, что сервис временно недоступен (FFmpeg еще не создал плейлист)
      if (/\.m3u8$/i.test(filePath)) {
        return res.status(503).setHeader('Retry-After', '5').send('Playlist not ready yet');
      } else {
        return res.status(404).send('File not found');
      }
    }
    
    // Для HLS плейлистов (.m3u8)
    if (/\.m3u8$/i.test(filePath)) {
      // КРИТИЧНО: Обновляем время последнего доступа при каждом запросе плейлиста
      // Это позволяет отслеживать активность стрима для автоматической остановки FFmpeg
      // КРИТИЧНО: Путь теперь safeName/index.m3u8 (без deviceId)
      if (decodedParts && decodedParts.length >= 1) {
        const safeName = decodedParts[0];
        const streamManager = getStreamManager();
        if (streamManager) {
          streamManager.updateLastAccessBySafeName(safeName);
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
      // КРИТИЧНО: Путь теперь safeName/segment_00001.ts (без deviceId)
      if (decodedParts && decodedParts.length >= 1) {
        const safeName = decodedParts[0];
        const streamManager = getStreamManager();
        if (streamManager) {
          streamManager.updateLastAccessBySafeName(safeName);
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
      
      // КРИТИЧНО: Обрабатываем Range requests для всех сегментов, но по-разному
      const range = req.headers.range;
      
      if (range) {
        // КРИТИЧНО: Для активных сегментов используем текущий размер файла
        // Размер может изменяться во время передачи, поэтому используем chunked transfer
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
        
        // Валидация диапазона
        if (start < 0 || end >= stats.size || start > end) {
          res.status(416).setHeader('Content-Range', `bytes */${stats.size}`).end();
          return;
        }
        
        if (isActiveSegment) {
          // КРИТИЧНО: Для активных сегментов используем chunked transfer
          // Не устанавливаем Content-Length, так как размер может изменяться
          res.status(206); // Partial Content
          res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
          res.setHeader('Content-Type', 'video/mp2t');
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('X-Accel-Buffering', 'no');
          // КРИТИЧНО: НЕ устанавливаем Content-Length для активных сегментов
          // Используем Transfer-Encoding: chunked (по умолчанию в Node.js)
          
          const stream = fs.createReadStream(filePath, { start, end });
          stream.on('error', (err) => {
            if (!res.headersSent) {
              res.status(500).end();
            } else {
              res.end();
            }
          });
          stream.pipe(res);
        } else {
          // Для старых сегментов (которые уже полностью записаны) используем обычную обработку
          const chunksize = (end - start) + 1;
          
          res.status(206); // Partial Content
          res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
          res.setHeader('Content-Length', chunksize);
          
          const stream = fs.createReadStream(filePath, { start, end });
          stream.on('error', (err) => {
            if (!res.headersSent) {
              res.status(500).end();
            } else {
              res.end();
            }
          });
          stream.pipe(res);
        }
      } else {
        // Полный файл - используем chunked transfer (без Content-Length)
        // Это критично для активных сегментов, которые пишутся FFmpeg в реальном времени
        const stream = fs.createReadStream(filePath);
        stream.on('error', (err) => {
          if (!res.headersSent) {
            res.status(500).end();
          } else {
            res.end();
          }
        });
        stream.pipe(res);
      }
      return;
    }
    
    // Для других файлов используем стандартный static
    next();
    } catch (error) {
      // КРИТИЧНО: Обработка всех ошибок для предотвращения 502 от nginx
      logger.error('[Express] Error in /streams middleware', {
        error: error.message,
        stack: error.stack,
        url: req.originalUrl,
        method: req.method,
        ip: req.ip
      });
      
      // Если заголовки еще не отправлены - отправляем ошибку
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to process stream request'
        });
      } else {
        // Если заголовки уже отправлены - просто закрываем соединение
        res.end();
      }
    }
  });
}

