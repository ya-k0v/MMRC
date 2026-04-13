import { Router } from 'express';
import multer from 'multer';
import { heroQueries } from '../database/queries.js';
import { HERO_DB_PATH, LEGACY_HERO_DB_PATH } from '../database/hero-db.js';
import path from 'path';
import fs from 'fs';
import logger from '../../utils/logger.js';
import { createLimiter, deleteLimiter } from '../../middleware/rate-limit.js';

const heroDbImportUpload = multer({
  dest: '/tmp',
  limits: { fileSize: 200 * 1024 * 1024 }
});

function validateMediaSize(base64String, limitBytes = 10 * 1024 * 1024) {
  if (!base64String || typeof base64String !== 'string') return;
  
  try {
    // КРИТИЧНО: Проверяем длину строки перед декодированием для защиты от переполнения памяти
    // Base64 увеличивает размер примерно на 33%, добавляем запас для padding
    const maxBase64Length = Math.ceil(limitBytes * 4 / 3) + 1000;
    if (base64String.length > maxBase64Length) {
      throw new Error(`File too large (max ${Math.round(limitBytes / (1024 * 1024))}MB)`);
    }
    
    const base64Data = base64String.split(',')[1] || base64String;
    if (!base64Data || base64Data.length === 0) return;
    
    const sizeInBytes = Buffer.from(base64Data, 'base64').length;
    if (sizeInBytes > limitBytes) {
      throw new Error(`File too large (max ${Math.round(limitBytes / (1024 * 1024))}MB)`);
    }
  } catch (err) {
    // Если ошибка валидации размера - пробрасываем её
    if (err.message.includes('too large')) throw err;
    // Иначе игнорируем ошибки декодирования base64
    logger.warn('[Hero Router] validateMediaSize warning', { error: err.message });
  }
}

/**
 * Валидация ID параметра
 */
function validateId(id, paramName = 'id') {
  const parsedId = parseInt(id, 10);
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    throw new Error(`Invalid ${paramName}: must be a positive integer`);
  }
  return parsedId;
}

/**
 * Валидация входных данных для создания/обновления героя
 */
function validateHeroData(data, isUpdate = false) {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid request body: must be an object');
  }
  
  // Валидация full_name (обязательное поле)
  if (!isUpdate || data.hasOwnProperty('full_name')) {
    if (!data.full_name || typeof data.full_name !== 'string') {
      throw new Error('full_name is required and must be a string');
    }
    const trimmedName = data.full_name.trim();
    if (trimmedName.length === 0) {
      throw new Error('full_name cannot be empty');
    }
    if (trimmedName.length > 200) {
      throw new Error('full_name is too long (max 200 characters)');
    }
  }
  
  // Валидация rank
  if (data.hasOwnProperty('rank') && data.rank !== null) {
    if (typeof data.rank !== 'string') {
      throw new Error('rank must be a string or null');
    }
    if (data.rank.length > 100) {
      throw new Error('rank is too long (max 100 characters)');
    }
  }
  
  // Валидация birth_year и death_year
  if (data.hasOwnProperty('birth_year') && data.birth_year !== null) {
    if (typeof data.birth_year !== 'string' && typeof data.birth_year !== 'number') {
      throw new Error('birth_year must be a string, number, or null');
    }
    if (typeof data.birth_year === 'string' && data.birth_year.length > 50) {
      throw new Error('birth_year is too long (max 50 characters)');
    }
  }
  
  if (data.hasOwnProperty('death_year') && data.death_year !== null) {
    if (typeof data.death_year !== 'string' && typeof data.death_year !== 'number') {
      throw new Error('death_year must be a string, number, or null');
    }
    if (typeof data.death_year === 'string' && data.death_year.length > 50) {
      throw new Error('death_year is too long (max 50 characters)');
    }
  }
  
  // Валидация biography
  if (data.hasOwnProperty('biography') && data.biography !== null) {
    if (typeof data.biography !== 'string') {
      throw new Error('biography must be a string or null');
    }
    // Биография может быть длинной, но ограничим разумным размером (1MB)
    if (data.biography.length > 1024 * 1024) {
      throw new Error('biography is too long (max 1MB)');
    }
  }
  
  // Валидация media массива
  if (data.hasOwnProperty('media') && data.media !== undefined) {
    if (!Array.isArray(data.media)) {
      throw new Error('media must be an array');
    }
    // Ограничиваем количество медиа файлов
    if (data.media.length > 100) {
      throw new Error('Too many media files (max 100)');
    }
  }
}

export function createHeroRouter({ requireHeroAdmin }) {
  const router = Router();

  router.get('/', (_req, res) => {
    try {
      res.json(heroQueries.getAll());
    } catch (error) {
      logger.error('[Hero Router] Error in GET /', {
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  });

  router.get('/search', (req, res) => {
    try {
      const query = req.query.q || '';
      // Валидация длины запроса
      if (typeof query !== 'string' || query.length > 200) {
        return res.status(400).json({ error: 'Invalid search query (max 200 characters)' });
      }
      res.json(heroQueries.search(query));
    } catch (error) {
      logger.error('[Hero Router] Error in GET /search', {
        query: req.query.q,
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  });

  // Экспорт базы данных героев (для бэкапа) - должен быть ПЕРЕД /:id
  const resolveDbFilePath = () => {
    if (fs.existsSync(HERO_DB_PATH)) {
      return { path: HERO_DB_PATH, legacy: false };
    }
    if (fs.existsSync(LEGACY_HERO_DB_PATH)) {
      return { path: LEGACY_HERO_DB_PATH, legacy: true };
    }
    return null;
  };

  router.get('/export-database', requireHeroAdmin, (req, res) => {
    try {
      const resolved = resolveDbFilePath();
      if (!resolved) {
        return res.status(404).json({ error: 'Файл базы данных не найден' });
      }

      if (resolved.legacy) {
        logger.warn('[Hero Router] Using legacy heroes.db path for export. Consider restarting the server to finish migration.');
      }
      
      const stats = fs.statSync(resolved.path);
      const dateStr = new Date().toISOString().split('T')[0];
      const filename = `heroes_backup_${dateStr}.db`;
      
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', stats.size);
      
      if (resolved.legacy) {
        res.setHeader('X-Hero-Db-Legacy-Path', '1');
      }

      const fileStream = fs.createReadStream(resolved.path);
      
      // КРИТИЧНО: Обрабатываем закрытие соединения клиентом
      let isAborted = false;
      const cleanup = () => {
        isAborted = true;
        if (fileStream && !fileStream.destroyed) {
          fileStream.destroy();
        }
      };
      
      req.on('close', cleanup);
      req.on('aborted', cleanup);
      res.on('close', cleanup);
      
      fileStream.on('error', (err) => {
        if (!isAborted) {
          if (!res.headersSent) {
            res.status(500).end();
          } else {
            res.end();
          }
        }
        cleanup();
      });
      
      fileStream.pipe(res);
    } catch (error) {
      logger.error('[Hero Router] Error in GET /export-database', {
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: error.message });
    }
  });

  // Импорт базы героев: файл подменяется атомарно, применение после перезапуска сервиса.
  router.post('/import-database', requireHeroAdmin, heroDbImportUpload.single('file'), (req, res) => {
    const uploadedPath = req.file?.path;

    try {
      if (!uploadedPath) {
        return res.status(400).json({ error: 'Файл не загружен' });
      }

      const ext = path.extname(req.file.originalname || '').toLowerCase();
      if (ext !== '.db') {
        return res.status(400).json({ error: 'Поддерживаются только файлы .db' });
      }

      const fd = fs.openSync(uploadedPath, 'r');
      const headerBuffer = Buffer.alloc(16);
      try {
        fs.readSync(fd, headerBuffer, 0, 16, 0);
      } finally {
        fs.closeSync(fd);
      }

      if (headerBuffer.toString('utf8') !== 'SQLite format 3\u0000') {
        return res.status(400).json({ error: 'Некорректный файл SQLite' });
      }

      const targetPath = HERO_DB_PATH;
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      if (fs.existsSync(targetPath)) {
        const backupPath = `${targetPath}.bak.${Date.now()}`;
        fs.copyFileSync(targetPath, backupPath);
        logger.info('[Hero Router] Hero DB backup created before import', { backupPath });
      }

      const stagedPath = path.join(targetDir, `heroes_import_${Date.now()}.db`);
      fs.copyFileSync(uploadedPath, stagedPath);
      fs.renameSync(stagedPath, targetPath);

      [`${targetPath}-wal`, `${targetPath}-shm`].forEach((extraPath) => {
        try {
          if (fs.existsSync(extraPath)) fs.unlinkSync(extraPath);
        } catch (cleanupErr) {
          logger.warn('[Hero Router] Failed to remove sidecar file after import', {
            file: extraPath,
            error: cleanupErr.message
          });
        }
      });

      return res.json({
        ok: true,
        message: 'База героев импортирована. Перезапустите сервис для применения изменений.'
      });
    } catch (error) {
      logger.error('[Hero Router] Error in POST /import-database', {
        error: error.message,
        stack: error.stack
      });
      return res.status(500).json({ error: error.message || 'Ошибка импорта базы героев' });
    } finally {
      if (uploadedPath && fs.existsSync(uploadedPath)) {
        try {
          fs.unlinkSync(uploadedPath);
        } catch (cleanupErr) {
          logger.warn('[Hero Router] Failed to remove uploaded temp file', {
            file: uploadedPath,
            error: cleanupErr.message
          });
        }
      }
    }
  });

  router.get('/:id', (req, res) => {
    try {
      const id = validateId(req.params.id, 'hero id');
      const hero = heroQueries.getById(id);
      if (!hero) {
        return res.status(404).json({ error: 'Герой не найден' });
      }
      res.json(hero);
    } catch (error) {
      if (error.message.includes('Invalid')) {
        return res.status(400).json({ error: error.message });
      }
      logger.error('[Hero Router] Error in GET /:id', {
        id: req.params.id,
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  });

  router.post('/', requireHeroAdmin, createLimiter, (req, res) => {
    try {
      // Валидация входных данных
      validateHeroData(req.body, false);
      
      // Валидируем размер только если фото передано (не null/undefined)
      if (req.body.photo_base64 !== undefined && req.body.photo_base64 !== null) {
        validateMediaSize(req.body.photo_base64, 10 * 1024 * 1024);
      }
      
      const id = heroQueries.create(req.body);

      if (Array.isArray(req.body.media)) {
        req.body.media.forEach((item) => {
          if (!item.type || !item.media_base64) {
            throw new Error('Media items must have type and media_base64');
          }
          if (!['photo', 'video'].includes(item.type)) {
            throw new Error('Media type must be "photo" or "video"');
          }
          const limit = (item.type === 'video' ? 200 : 10) * 1024 * 1024;
          validateMediaSize(item.media_base64, limit);
          heroQueries.addMedia(id, {
            type: item.type || 'photo',
            media_base64: item.media_base64,
            caption: item.caption || '',
            order_index: item.order_index || 0
          });
        });
      }

      res.json({ id, success: true });
    } catch (error) {
      logger.error('[Hero Router] Error in POST /', {
        error: error.message,
        stack: error.stack,
        body: req.body ? { ...req.body, photo_base64: req.body.photo_base64 ? '[base64 data]' : null } : null
      });
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/:id', requireHeroAdmin, (req, res) => {
    try {
      const id = validateId(req.params.id, 'hero id');
      
      // Валидация входных данных
      validateHeroData(req.body, true);
      
      // Валидируем размер только если фото передано (не null/undefined)
      if (req.body.photo_base64 !== undefined && req.body.photo_base64 !== null) {
        validateMediaSize(req.body.photo_base64, 10 * 1024 * 1024);
      }
      
      // КРИТИЧНО: Используем транзакцию для атомарности операций обновления
      heroQueries.updateWithMedia(id, req.body, (item) => {
        if (!item.type || !item.media_base64) {
          throw new Error('Media items must have type and media_base64');
        }
        if (!['photo', 'video'].includes(item.type)) {
          throw new Error('Media type must be "photo" or "video"');
        }
        const limit = (item.type === 'video' ? 200 : 10) * 1024 * 1024;
        validateMediaSize(item.media_base64, limit);
      });

      res.json({ success: true });
    } catch (error) {
      if (error.message.includes('Invalid') || error.message.includes('not found')) {
        const statusCode = error.message.includes('not found') ? 404 : 400;
        return res.status(statusCode).json({ error: error.message });
      }
      logger.error('[Hero Router] Error in PUT /:id', {
        id: req.params.id,
        error: error.message,
        stack: error.stack,
        body: req.body ? { ...req.body, photo_base64: req.body.photo_base64 ? '[base64 data]' : null } : null
      });
      res.status(400).json({ error: error.message });
    }
  });

  router.delete('/:id', requireHeroAdmin, deleteLimiter, (req, res) => {
    try {
      const id = validateId(req.params.id, 'hero id');
      heroQueries.delete(id);
      res.json({ success: true });
    } catch (error) {
      if (error.message.includes('Invalid')) {
        return res.status(400).json({ error: error.message });
      }
      logger.error('[Hero Router] Error in DELETE /:id', {
        id: req.params.id,
        error: error.message,
        stack: error.stack
      });
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/:id/media', requireHeroAdmin, (req, res) => {
    try {
      const id = validateId(req.params.id, 'hero id');
      
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'Invalid request body' });
      }
      
      if (!req.body.media_base64 || typeof req.body.media_base64 !== 'string') {
        return res.status(400).json({ error: 'media_base64 is required and must be a string' });
      }
      
      if (!req.body.type || !['photo', 'video'].includes(req.body.type)) {
        return res.status(400).json({ error: 'type is required and must be "photo" or "video"' });
      }
      
      const limit = (req.body.type === 'video' ? 200 : 10) * 1024 * 1024;
      validateMediaSize(req.body.media_base64, limit);
      
      const mediaId = heroQueries.addMedia(id, req.body);
      res.json({ id: mediaId, success: true });
    } catch (error) {
      if (error.message.includes('Invalid')) {
        return res.status(400).json({ error: error.message });
      }
      logger.error('[Hero Router] Error in POST /:id/media', {
        id: req.params.id,
        error: error.message,
        stack: error.stack
      });
      res.status(400).json({ error: error.message });
    }
  });

  router.delete('/media/:mediaId', requireHeroAdmin, deleteLimiter, (req, res) => {
    try {
      const mediaId = validateId(req.params.mediaId, 'media id');
      heroQueries.deleteMedia(mediaId);
      res.json({ success: true });
    } catch (error) {
      if (error.message.includes('Invalid')) {
        return res.status(400).json({ error: error.message });
      }
      logger.error('[Hero Router] Error in DELETE /media/:mediaId', {
        mediaId: req.params.mediaId,
        error: error.message,
        stack: error.stack
      });
      res.status(400).json({ error: error.message });
    }
  });

  return router;
}


