import { Router } from 'express';
import { heroQueries } from '../database/queries.js';
import { HERO_DB_PATH, LEGACY_HERO_DB_PATH } from '../database/hero-db.js';
import path from 'path';
import fs from 'fs';

function validateMediaSize(base64String, limitBytes = 10 * 1024 * 1024) {
  if (!base64String || typeof base64String !== 'string') return;
  try {
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
    console.warn('[Hero Router] validateMediaSize warning:', err.message);
  }
}

export function createHeroRouter({ requireHeroAdmin }) {
  const router = Router();

  router.get('/', (_req, res) => {
    try {
      res.json(heroQueries.getAll());
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/search', (req, res) => {
    try {
      const query = req.query.q || '';
      res.json(heroQueries.search(query));
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
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
        return res.status(404).json({ error: 'Database file not found' });
      }

      if (resolved.legacy) {
        console.warn('[Hero Router] Using legacy heroes.db path for export. Consider restarting the server to finish migration.');
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
      fileStream.pipe(res);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/:id', (req, res) => {
    try {
      const hero = heroQueries.getById(req.params.id);
      if (!hero) {
        return res.status(404).json({ error: 'Hero not found' });
      }
      res.json(hero);
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/', requireHeroAdmin, (req, res) => {
    try {
      // Валидируем размер только если фото передано (не null/undefined)
      if (req.body.photo_base64 !== undefined && req.body.photo_base64 !== null) {
      validateMediaSize(req.body.photo_base64, 10 * 1024 * 1024);
      }
      const id = heroQueries.create(req.body);

      if (Array.isArray(req.body.media)) {
        req.body.media.forEach((item) => {
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
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/:id', requireHeroAdmin, (req, res) => {
    try {
      // Валидируем размер только если фото передано (не null/undefined)
      if (req.body.photo_base64 !== undefined && req.body.photo_base64 !== null) {
      validateMediaSize(req.body.photo_base64, 10 * 1024 * 1024);
      }
      heroQueries.update(req.params.id, req.body);

      if (Array.isArray(req.body.media)) {
        heroQueries.deleteMediaByHero(req.params.id);
        req.body.media.forEach((item) => {
          const limit = (item.type === 'video' ? 200 : 10) * 1024 * 1024;
          validateMediaSize(item.media_base64, limit);
          heroQueries.addMedia(req.params.id, {
            type: item.type || 'photo',
            media_base64: item.media_base64,
            caption: item.caption || '',
            order_index: item.order_index || 0
          });
        });
      }

      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.delete('/:id', requireHeroAdmin, (req, res) => {
    try {
      heroQueries.delete(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/:id/media', requireHeroAdmin, (req, res) => {
    try {
      validateMediaSize(req.body.media_base64);
      const mediaId = heroQueries.addMedia(req.params.id, req.body);
      res.json({ id: mediaId, success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.delete('/media/:mediaId', requireHeroAdmin, (req, res) => {
    try {
      heroQueries.deleteMedia(req.params.mediaId);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  return router;
}


