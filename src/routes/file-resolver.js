/**
 * File Resolver - резолвинг путей файлов для единого хранилища
 * @module routes/file-resolver
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getAnyFileMetadataBySafeName, getFileMetadata } from '../database/files-metadata.js';
import { getDevicesPath } from '../config/settings-manager.js';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import { validatePath } from '../utils/path-validator.js';
import { getDataRoot } from '../config/settings-manager.js';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('resolver');
import { spawnFfmpeg } from '../utils/docker-ffmpeg.js';
import { getCurrentStorage } from '../storage/current.js';

const router = express.Router();

function normalizeFileNameParam(paramValue) {
  if (Array.isArray(paramValue)) {
    return paramValue.join('/');
  }
  return typeof paramValue === 'string' ? paramValue : '';
}

function isExpectedClientDisconnectError(err) {
  if (!err) return false;

  const message = String(err.message || '').toLowerCase();
  const code = String(err.code || '').toUpperCase();
  const statusCode = Number(err.statusCode || err.status || 0);

  return (
    code === 'ECONNABORTED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    statusCode === 499 ||
    message.includes('request aborted') ||
    message.includes('aborted') ||
    message.includes('write epipe') ||
    message.includes('socket hang up') ||
    message.includes('premature close')
  );
}

/**
 * GET /api/files/resolve/:deviceId/:fileName
 * Резолвит виртуальный путь в физический и отдает файл
 */
// Отправка файла через res.sendFile (локальный диск)
function sendFileFromDisk(res, req, metadata, context = {}) {
  const { file_path, file_size, mime_type, safe_name, md5_hash } = metadata;
  const options = {
    root: '/',
    dotfiles: 'allow',
    headers: {
      'Content-Type': mime_type || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'public, max-age=3600',
      'X-File-Hash': md5_hash?.substring(0, 12) || 'unknown'
    }
  };

  logger.debug('[Resolver] Serving from disk', {
    ...context,
    requestedName: safe_name || context.fileName,
    physicalPath: file_path,
    size: file_size
  });

  let isAborted = false;
  const cleanup = () => { isAborted = true; };
  req.on('close', cleanup);
  req.on('aborted', cleanup);

  res.sendFile(file_path, options, (err) => {
    req.removeListener('close', cleanup);
    req.removeListener('aborted', cleanup);

    if (isAborted) return;

    if (err) {
      if (err.message === 'Range Not Satisfiable') {
        logger.warn('[Resolver] Range not satisfiable', { ...context, range: req.headers.range, fileSize: file_size });
        if (!res.headersSent) {
          res.status(416).set('Content-Range', `bytes */${file_size || 0}`).send('Range Not Satisfiable');
        }
      } else if (isExpectedClientDisconnectError(err)) {
        logger.debug('[Resolver] Client disconnected during file send', {
          ...context, error: err.message, code: err.code, statusCode: err.statusCode || err.status
        });
      } else {
        logger.error('[Resolver] Error sending file', { error: err.message, ...context, statusCode: err.statusCode || err.status });
        if (!res.headersSent) {
          res.status(err.statusCode || err.status || 500).send('Error sending file');
        }
      }
    }
  });
}

// Отправка файла через storage (S3 и др.)
async function sendFileFromStorage(res, req, metadata, context = {}, storage) {
  const { file_path, file_size, mime_type, safe_name, md5_hash } = metadata;
  const dataRoot = getDataRoot();

  const storageKey = path.relative(dataRoot, file_path);
  if (storageKey.startsWith('..')) {
    logger.error('[Resolver] Storage key traversal detected', { ...context, file_path, storageKey });
    return res.status(403).send('Forbidden');
  }

  const totalSize = file_size || 0;
  let start = 0;
  let end = totalSize - 1;
  let statusCode = 200;

  if (req.headers.range) {
    const parts = req.headers.range.replace(/bytes=/, '').split('-');
    start = parseInt(parts[0], 10) || 0;
    end = parts[1] ? parseInt(parts[1], 10) : (totalSize - 1);

    if (start >= totalSize) {
      logger.warn('[Resolver] Range not satisfiable (storage)', { ...context, range: req.headers.range, fileSize: totalSize });
      return res.status(416).set('Content-Range', `bytes */${totalSize}`).end();
    }
    statusCode = 206;

    logger.info('[Resolver] Range request (storage)', {
      ...context, range: req.headers.range, start, end,
      requestedSize: end - start + 1, fileSize: totalSize
    });
  }

  res.status(statusCode);
  res.set({
    'Content-Type': mime_type || 'application/octet-stream',
    'Content-Range': `bytes ${start}-${end}/${totalSize}`,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'X-Accel-Buffering': 'no',
    'Cache-Control': 'public, max-age=3600',
    'X-File-Hash': md5_hash?.substring(0, 12) || 'unknown'
  });

  try {
    const stream = await storage.createReadStream(storageKey, { start, end });
    stream.pipe(res);
    stream.on('error', (streamErr) => {
      logger.error('[Resolver] Storage stream error', { error: streamErr.message, ...context });
      if (!res.headersSent) res.status(500).end();
    });
    stream.on('end', () => {
      logger.debug('[Resolver] Storage stream complete', { ...context, bytes: end - start + 1 });
    });
  } catch (err) {
    logger.error('[Resolver] Storage stream failed', { error: err.message, ...context });
    if (!res.headersSent) res.status(500).send('Error streaming file');
  }
}

// Вспомогательная проверка: файл доступен локально?
function isFileLocallyAvailable(filePath) {
  const storage = getCurrentStorage();
  if (storage) return true;  // storage backend не требует локального файла
  return filePath && fs.existsSync(filePath);
}

// Универсальная отправка файла с поддержкой локального диска и S3
async function sendFileWithRange(res, req, metadata, context = {}) {
  try {
    metadata.file_path = validatePath(metadata.file_path, getDataRoot());
  } catch {
    logger.error('[Resolver] Path validation failed', { ...context, path: metadata.file_path });
    if (!res.headersSent) {
      return res.status(403).send('Forbidden');
    }
    return;
  }

  const storage = getCurrentStorage();

  // Если файла нет локально, но есть storage backend — шлём через storage
  if (!fs.existsSync(metadata.file_path) && storage) {
    logger.debug('[Resolver] File not on disk, using storage', { ...context, path: metadata.file_path });
    return sendFileFromStorage(res, req, metadata, context, storage);
  }

  // Иначе шлём с диска через res.sendFile
  sendFileFromDisk(res, req, metadata, context);
}

// Новый эндпоинт для совместимости: поиск файла без привязки к устройству
router.get('/resolve-all/*fileName', async (req, res) => {
  const rawFileName = req.params.fileName || '';
  if (rawFileName.includes('..') || rawFileName.includes('~') || path.isAbsolute(rawFileName)) {
    logger.warn('[Resolver] Path traversal attempt detected in resolve-all', { fileName: rawFileName });
    return res.status(400).send('Invalid path');
  }
  const fileName = normalizeFileNameParam(req.params.fileName);
  if (!fileName) return res.status(400).send('Invalid parameters');

  let metadata = await getAnyFileMetadataBySafeName(fileName);

  if (!metadata || !metadata.file_path || !isFileLocallyAvailable(metadata.file_path)) {
    if (getCurrentStorage()) {
      // Если есть storage — DB источник истины, отсутствие файла на диске не ошибка
      if (!metadata || !metadata.file_path) {
        logger.warn('[Resolver] File not found in DB (resolve-all)', { fileName });
        return res.status(404).send('File not found');
      }
    } else {
      // Нет storage — файл должен быть на диске, пробуем fallback
      const devicesPath = getDevicesPath();
      const fallbackPaths = [path.join(devicesPath, fileName)];
      try {
        const entries = fs.readdirSync(devicesPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            fallbackPaths.push(path.join(devicesPath, entry.name, fileName));
          }
        }
      } catch {
        // ignore readdir errors
      }
      let foundPath = null;
      for (const p of fallbackPaths) {
        if (fs.existsSync(p)) {
          foundPath = p;
          break;
        }
      }
      if (foundPath) {
        const stat = fs.statSync(foundPath);
        metadata = {
          device_id: 'shared',
          safe_name: fileName,
          file_path: foundPath,
          file_size: stat.size,
          mime_type: null,
          md5_hash: null
        };
        logger.info('[Resolver] Resolve-all fallback found file', { fileName, path: foundPath });
      } else {
        logger.warn('[Resolver] File not found in DB or filesystem (resolve-all)', { fileName });
        return res.status(404).send('File not found');
      }
    }
  }

  return sendFileWithRange(res, req, metadata, { deviceId: metadata.device_id || 'shared', fileName });
});

// Старый эндпоинт с fallback на resolve-all
router.get('/resolve/:deviceId/*fileName', async (req, res) => {
  const deviceId = sanitizeDeviceId(req.params.deviceId);
  const fileName = normalizeFileNameParam(req.params.fileName);
  
  if (!deviceId || !fileName) {
    return res.status(400).send('Invalid parameters');
  }
  
  let metadata = await getFileMetadata(deviceId, fileName);

  const needsLocalFile = !getCurrentStorage(); // без storage требуем локальный файл

  if (!metadata || !metadata.file_path || (needsLocalFile && !fs.existsSync(metadata.file_path))) {
    if (!needsLocalFile) {
      if (!metadata || !metadata.file_path) {
        // Сначала глобальный поиск по safeName (для All Files с originDeviceId)
        metadata = await getAnyFileMetadataBySafeName(fileName);
        if (!metadata || !metadata.file_path) {
          logger.warn('[Resolver] File not found in DB (storage mode)', { deviceId, fileName });
          return res.status(404).send('File not found');
        }
        logger.info('[Resolver] Found via getAnyFileMetadataBySafeName', { deviceId, fileName, actualDevice: metadata.device_id });
      }
    } else {
      logger.warn('[Resolver] Fallback to resolve-all', { deviceId, fileName });
      metadata = await getAnyFileMetadataBySafeName(fileName);
      if (!metadata || !metadata.file_path || !fs.existsSync(metadata.file_path)) {
        const devicesPath = getDevicesPath();
        logger.debug('[Resolver] Filesystem fallback', { devicesPath, deviceId, fileName });
        const candidatePaths = [
          path.join(devicesPath, deviceId, fileName),
          path.join(devicesPath, fileName)
        ];
        try {
          const entries = fs.readdirSync(devicesPath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && entry.name !== deviceId) {
              candidatePaths.push(path.join(devicesPath, entry.name, fileName));
            }
          }
        } catch {
          // ignore readdir errors
        }
        let foundPath = null;
        for (const p of candidatePaths) {
          logger.debug('[Resolver] Checking candidate', { candidate: p, exists: fs.existsSync(p) });
          if (fs.existsSync(p)) {
            foundPath = p;
            break;
          }
        }
        if (foundPath) {
          logger.info('[Resolver] Fallback found file', { fileName, path: foundPath });
          const stat = fs.statSync(foundPath);
          metadata = {
            device_id: 'shared',
            safe_name: fileName,
            file_path: foundPath,
            file_size: stat.size,
            mime_type: null,
            md5_hash: null
          };
        } else {
          logger.warn('[Resolver] File not found in DB or filesystem', { deviceId, fileName, devicesPath });
          return res.status(404).send('File not found');
        }
      }
    }
  }
  
  return sendFileWithRange(res, req, metadata, { deviceId, fileName });
});

/**
 * GET /api/files/trailer/:deviceId/:fileName
 * Отдаёт готовый трейлер (10s) если он сгенерирован
 */
router.get('/trailer/:deviceId/*fileName', async (req, res) => {
  const deviceId = sanitizeDeviceId(req.params.deviceId);
  const fileName = normalizeFileNameParam(req.params.fileName);
  
  if (!deviceId || !fileName) {
    return res.status(400).send('Invalid parameters');
  }
  
  let metadata = await getFileMetadata(deviceId, fileName);
  if (!metadata) {
    logger.warn('[Resolver] Trailer fallback to resolve-all', { deviceId, fileName });
    metadata = await getAnyFileMetadataBySafeName(fileName);
  }
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
router.get('/preview/:deviceId/*fileName', async (req, res) => {
  const deviceId = sanitizeDeviceId(req.params.deviceId);
  const fileName = normalizeFileNameParam(req.params.fileName);
  
  if (!deviceId || !fileName) {
    return res.status(400).send('Invalid parameters');
  }
  
  let metadata = await getFileMetadata(deviceId, fileName);
  if (!metadata) {
    logger.warn('[Resolver] Preview fallback to resolve-all', { deviceId, fileName });
    metadata = await getAnyFileMetadataBySafeName(fileName);
  }
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
    try {
      metadata.file_path = validatePath(metadata.file_path, getDataRoot());
    } catch {
      logger.error('[Preview] Path validation failed', { deviceId, fileName, path: metadata.file_path });
      return res.status(403).send('Forbidden');
    }

    const storage = getCurrentStorage();
    const fileOnDisk = fs.existsSync(metadata.file_path);

    if (!fileOnDisk && !storage) {
      return res.status(404).send('Physical file not found');
    }

    if (fileOnDisk) {
      // Отдаем файл напрямую с поддержкой Range requests
      const options = {
        root: '/',
        dotfiles: 'allow',
        headers: {
          'Content-Type': mime || 'video/mp4',
          'Accept-Ranges': 'bytes',
          'X-Accel-Buffering': 'no',
          'Cache-Control': 'public, max-age=3600'
        }
      };

      let isAborted = false;
      const cleanup = () => { isAborted = true; };
      req.on('close', cleanup);
      req.on('aborted', cleanup);

      res.sendFile(metadata.file_path, options, (err) => {
        req.removeListener('close', cleanup);
        req.removeListener('aborted', cleanup);
        if (isAborted) return;
        if (err) {
          if (err.message === 'Range Not Satisfiable') {
            logger.warn('[Preview] Range not satisfiable', { deviceId, fileName, range: req.headers.range, fileSize: metadata.file_size });
            if (!res.headersSent) res.status(416).set('Content-Range', `bytes */${metadata.file_size}`).send('Range Not Satisfiable');
          } else if (isExpectedClientDisconnectError(err)) {
            logger.debug('[Preview] Client disconnected', { deviceId, fileName, error: err.message });
          } else {
            logger.error('[Preview] Error sending file', { error: err.message, deviceId, fileName });
            if (!res.headersSent) res.status(err.statusCode || err.status || 500).send('Error sending file');
          }
        }
      });
      return;
    }

    // Файл не на диске, но есть storage — шлём через storage
    const dataRoot = getDataRoot();
    const storageKey = path.relative(dataRoot, metadata.file_path);
    if (storageKey.startsWith('..')) {
      return res.status(403).send('Forbidden');
    }

    const totalSize = metadata.file_size || 0;
    let start = 0;
    let end = totalSize - 1;
    let statusCode = 200;

    if (req.headers.range) {
      const parts = req.headers.range.replace(/bytes=/, '').split('-');
      start = parseInt(parts[0], 10) || 0;
      end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      if (start >= totalSize) {
        return res.status(416).set('Content-Range', `bytes */${totalSize}`).end();
      }
      statusCode = 206;
    }

    res.status(statusCode);
    res.set({
      'Content-Type': mime || 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'public, max-age=3600'
    });

    try {
      const stream = await storage.createReadStream(storageKey, { start, end });
      stream.pipe(res);
      stream.on('error', (streamErr) => {
        logger.error('[Preview] Storage stream error', { error: streamErr.message, deviceId, fileName });
        if (!res.headersSent) res.status(500).end();
      });
    } catch (err) {
      logger.error('[Preview] Storage stream failed', { error: err.message, deviceId, fileName });
      if (!res.headersSent) res.status(500).send('Error streaming file');
    }
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
  
  const ff = spawnFfmpeg(args, { stdio: ['ignore', 'pipe', 'pipe'] });
  
  // КРИТИЧНО: Обрабатываем закрытие соединения клиентом
  let isAborted = false;
  const cleanup = () => {
    isAborted = true;
    // Убиваем процесс FFmpeg при отмене запроса
    try {
      if (ff && !ff.killed) {
        ff.kill('SIGKILL');
      }
    } catch (killErr) {
      // Игнорируем ошибки при убийстве процесса
    }
  };
  
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
  
  // Обрабатываем ошибки потока
  ff.stdout.on('error', (err) => {
    if (!isAborted) {
      logger.error('[Preview] FFmpeg stdout error', { error: err.message, streamUrl });
      if (!res.headersSent) {
        res.status(500).end('Preview generation failed');
      }
    }
    cleanup();
  });
  
  ff.stdout.pipe(res);
  
  ff.stderr.on('data', (d) => {
    // Можно логировать при необходимости
  });
  
  ff.on('error', (err) => {
    if (!isAborted) {
      logger.error('[Preview] ffmpeg spawn error', { error: err.message, streamUrl });
      if (!res.headersSent) res.status(500).end('Preview generation failed');
    }
    cleanup();
  });
  
  ff.on('close', (code) => {
    req.removeListener('close', cleanup);
    req.removeListener('aborted', cleanup);
    res.removeListener('close', cleanup);
    
    if (!isAborted && code !== 0) {
      logger.warn('[Preview] ffmpeg exited with code', { code, streamUrl });
      if (!res.headersSent) res.status(500).end('Preview generation failed');
    }
  });
});

export default router;

