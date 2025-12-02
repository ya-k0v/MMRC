/**
 * File Resolver - резолвинг путей файлов для единого хранилища
 * @module routes/file-resolver
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { getFileMetadata } from '../database/files-metadata.js';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import logger from '../utils/logger.js';
import { spawn } from 'child_process';

const router = express.Router();

/**
 * GET /api/files/resolve/:deviceId/:fileName
 * Резолвит виртуальный путь в физический и отдает файл
 */
router.get('/resolve/:deviceId/:fileName(*)', (req, res) => {
  const deviceId = sanitizeDeviceId(req.params.deviceId);
  const fileName = req.params.fileName;
  
  if (!deviceId || !fileName) {
    return res.status(400).send('Invalid parameters');
  }
  
  // Ищем файл в БД
  const metadata = getFileMetadata(deviceId, fileName);
  
  if (!metadata) {
    logger.warn('[Resolver] File not found in DB', { deviceId, fileName });
    return res.status(404).send('File not found');
  }
  
  // Проверяем существование физического файла
  if (!fs.existsSync(metadata.file_path)) {
    logger.error('[Resolver] Physical file missing', { 
      deviceId, 
      fileName, 
      expectedPath: metadata.file_path 
    });
    return res.status(404).send('Physical file not found');
  }
  
  // Отдаем файл с поддержкой Range requests (для seek в видео)
  const options = {
    root: '/',  // Абсолютный путь
    headers: {
      'Content-Type': metadata.mime_type || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'public, max-age=3600',
      'X-File-Hash': metadata.md5_hash?.substring(0, 12) || 'unknown'
    }
  };
  
  logger.debug('[Resolver] Serving file', { 
    deviceId, 
    requestedName: fileName,
    physicalPath: metadata.file_path,
    size: metadata.file_size
  });
  
  // Логируем Range запрос (если есть)
  if (req.headers.range) {
    // Парсим Range заголовок для детальной диагностики
    const rangeMatch = req.headers.range.match(/bytes=(\d+)-(\d*)/);
    const requestedStart = rangeMatch ? parseInt(rangeMatch[1]) : 0;
    const requestedEnd = rangeMatch && rangeMatch[2] ? parseInt(rangeMatch[2]) : metadata.file_size - 1;
    
    logger.info('[Resolver] Range request details', {
      deviceId,
      fileName,
      range: req.headers.range,
      requestedStart,
      requestedEnd,
      requestedSize: requestedEnd - requestedStart + 1,
      fileSize: metadata.file_size,
      isOutOfRange: requestedStart >= metadata.file_size || requestedEnd >= metadata.file_size
    });
  }
  
  // Отправляем файл (Express автоматически обрабатывает Range requests)
  res.sendFile(metadata.file_path, options, (err) => {
    if (err) {
      // ИСПРАВЛЕНО: Правильно обрабатываем ошибку Range Not Satisfiable
      if (err.message === 'Range Not Satisfiable') {
        logger.warn('[Resolver] Range not satisfiable', { 
          deviceId, 
          fileName,
          range: req.headers.range,
          fileSize: metadata.file_size
        });
        if (!res.headersSent) {
          res.status(416).set('Content-Range', `bytes */${metadata.file_size}`).send('Range Not Satisfiable');
        }
      } else {
        logger.error('[Resolver] Error sending file', { 
          error: err.message, 
          deviceId, 
          fileName,
          statusCode: err.statusCode || err.status
        });
        if (!res.headersSent) {
          res.status(err.statusCode || err.status || 500).send('Error sending file');
        }
      }
    }
  });
});

/**
 * GET /api/files/trailer/:deviceId/:fileName
 * Отдаёт готовый трейлер (10s) если он сгенерирован
 */
router.get('/trailer/:deviceId/:fileName(*)', (req, res) => {
  const deviceId = sanitizeDeviceId(req.params.deviceId);
  const fileName = req.params.fileName;
  
  if (!deviceId || !fileName) {
    return res.status(400).send('Invalid parameters');
  }
  
  const metadata = getFileMetadata(deviceId, fileName);
  if (!metadata) {
    return res.status(404).send('Not found');
  }
  
  // Трейлер доступен по md5
  const md5 = metadata.md5_hash;
  if (!md5) return res.status(404).send('Not found');
  
  // Ленивая загрузка модуля, чтобы избежать циклов
  import('../video/trailer-generator.js').then(mod => {
    const { getTrailerPath, ensureTrailerForFile } = mod;
    const trailerPath = getTrailerPath(md5);
    
    if (fs.existsSync(trailerPath)) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Accel-Buffering', 'no');
      return res.sendFile(trailerPath, (err) => {
        if (err && !res.headersSent) res.status(500).end('send trailer failed');
      });
    }
    
    // Если нет — запустить генерацию в фоне и сообщить что пока нет
    ensureTrailerForFile(md5, metadata.file_path, { seconds: 10 }).catch(()=>{});
    return res.status(404).send('trailer not ready');
  }).catch(() => res.status(500).send('internal error'));
});

/**
 * GET /api/files/preview/:deviceId/:fileName?start=0&seconds=10
 * Отдаёт превью-вырезку видео (по умолчанию первые 10 секунд) без полной загрузки файла
 * КРИТИЧНО: Для обычных файлов отдаем напрямую (без ffmpeg), для стримов используем ffmpeg
 */
router.get('/preview/:deviceId/:fileName(*)', (req, res) => {
  const deviceId = sanitizeDeviceId(req.params.deviceId);
  const fileName = req.params.fileName;
  
  if (!deviceId || !fileName) {
    return res.status(400).send('Invalid parameters');
  }
  
  const metadata = getFileMetadata(deviceId, fileName);
  if (!metadata) {
    return res.status(404).send('File not found');
  }
  
  // Поддерживаем только видео форматы
  const mime = metadata.mime_type || '';
  if (!mime.startsWith('video/')) {
    return res.status(415).send('Preview supported only for video');
  }
  
  // КРИТИЧНО: Проверяем, это стрим или обычный файл
  const isStream = metadata.content_type === 'streaming';
  
  // Параметры клипа
  const startSec = Math.max(0, parseInt(req.query.start || '0', 10) || 0);
  let seconds = Math.max(1, parseInt(req.query.seconds || '5', 10) || 5);
  seconds = Math.min(seconds, 30); // safety cap 30s
  
  // Для обычных файлов отдаем напрямую через Range requests (без ffmpeg)
  if (!isStream) {
    // Проверяем существование физического файла
    if (!fs.existsSync(metadata.file_path)) {
      return res.status(404).send('Physical file not found');
    }
    
    // Отдаем файл напрямую с поддержкой Range requests
    const options = {
      root: '/',  // Абсолютный путь
      headers: {
        'Content-Type': mime || 'video/mp4',
        'Accept-Ranges': 'bytes',
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'public, max-age=3600'
      }
    };
    
    // Express автоматически обрабатывает Range requests
    res.sendFile(metadata.file_path, options, (err) => {
      if (err) {
        if (err.message === 'Range Not Satisfiable') {
          logger.warn('[Preview] Range not satisfiable', { 
            deviceId, 
            fileName,
            range: req.headers.range,
            fileSize: metadata.file_size
          });
          if (!res.headersSent) {
            res.status(416).set('Content-Range', `bytes */${metadata.file_size}`).send('Range Not Satisfiable');
          }
        } else {
          logger.error('[Preview] Error sending file', { 
            error: err.message, 
            deviceId, 
            fileName,
            statusCode: err.statusCode || err.status
          });
          if (!res.headersSent) {
            res.status(err.statusCode || err.status || 500).send('Error sending file');
          }
        }
      }
    });
    return;
  }
  
  // Для стримов используем ffmpeg
  const streamUrl = metadata.stream_url;
  if (!streamUrl) {
    return res.status(400).send('Stream URL not found');
  }
  
  // Заголовки для стриминга
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  
  // Для максимальной совместимости (Android/WebView/Video.js) перекодируем 10с в H.264/AAC
  // Низкая нагрузка из-за короткой длительности; даёт гарантированный mp4
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(startSec),
    '-t', String(seconds),
    '-i', streamUrl,  // КРИТИЧНО: Используем stream_url для стримов
    '-analyzeduration', '0',
    '-probesize', '500000',
    '-vf', 'scale=trunc(min(iw\\,1920)/2)*2:trunc(min(ih\\,1080)/2)*2', // ограничение до 1080p, чётные размеры
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-b:v', '1800k',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart+frag_keyframe+empty_moov',
    '-f', 'mp4',
    'pipe:1'
  ];
  
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  
  ff.stdout.pipe(res);
  
  ff.stderr.on('data', (d) => {
    // Можно логировать при необходимости
  });
  
  ff.on('error', (err) => {
    logger.error('[Preview] ffmpeg spawn error', { error: err.message, streamUrl });
    if (!res.headersSent) res.status(500).end('Preview generation failed');
    try { ff.kill('SIGKILL'); } catch {}
  });
  
  ff.on('close', (code) => {
    if (code !== 0) {
      logger.warn('[Preview] ffmpeg exited with code', { code, streamUrl });
      if (!res.headersSent) res.status(500).end('Preview generation failed');
    }
  });
});

export default router;

