import { Router } from 'express';
import multer from 'multer';
import { heroQueries } from '../database/queries.js';
import { HERO_DB_PATH, LEGACY_HERO_DB_PATH, reloadHeroDb } from '../database/hero-db.js';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createModuleLogger } from '../../utils/logger.js';
const logger = createModuleLogger('hero');
import { createLimiter, deleteLimiter } from '../../middleware/rate-limit.js';
import { validatePath } from '../../utils/path-validator.js';
import { getHeroDb } from '../database/hero-db.js';

const HERO_DB_UPLOAD_DIR = path.resolve('/tmp');

const heroDbImportUpload = multer({
  dest: HERO_DB_UPLOAD_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }
});

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function validateImportedHeroDbSchema(probeDb) {
  const tables = new Set(
    probeDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('heroes', 'hero_media')")
      .all()
      .map((row) => String(row.name || ''))
  );

  if (!tables.has('heroes') || !tables.has('hero_media')) {
    throw new Error('В импортируемой базе отсутствуют обязательные таблицы heroes/hero_media');
  }

  const heroesColumns = new Set(
    probeDb.prepare('PRAGMA table_info(heroes)').all().map((row) => String(row.name || ''))
  );
  const requiredHeroesColumns = ['id', 'full_name', 'birth_year', 'death_year', 'rank', 'photo_base64', 'biography'];
  const missingHeroesColumns = requiredHeroesColumns.filter((col) => !heroesColumns.has(col));
  if (missingHeroesColumns.length > 0) {
    throw new Error(`В таблице heroes отсутствуют обязательные колонки: ${missingHeroesColumns.join(', ')}`);
  }

  const mediaColumns = new Set(
    probeDb.prepare('PRAGMA table_info(hero_media)').all().map((row) => String(row.name || ''))
  );
  if (!mediaColumns.has('hero_id')) {
    throw new Error('В таблице hero_media отсутствует обязательная колонка hero_id');
  }

  const hasModernMediaSchema = ['type', 'media_base64', 'caption', 'order_index'].every((col) => mediaColumns.has(col));
  const hasLegacyMediaSchema = ['media_type', 'url'].every((col) => mediaColumns.has(col));
  if (!hasModernMediaSchema && !hasLegacyMediaSchema) {
    throw new Error('Таблица hero_media имеет неподдерживаемую структуру');
  }
}

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
  if (!isUpdate || hasOwn(data, 'full_name')) {
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
  if (hasOwn(data, 'rank') && data.rank !== null) {
    if (typeof data.rank !== 'string') {
      throw new Error('rank must be a string or null');
    }
    if (data.rank.length > 100) {
      throw new Error('rank is too long (max 100 characters)');
    }
  }
  
  // Валидация birth_year и death_year
  if (hasOwn(data, 'birth_year') && data.birth_year !== null) {
    if (typeof data.birth_year !== 'string' && typeof data.birth_year !== 'number') {
      throw new Error('birth_year must be a string, number, or null');
    }
    if (typeof data.birth_year === 'string' && data.birth_year.length > 50) {
      throw new Error('birth_year is too long (max 50 characters)');
    }
  }
  
  if (hasOwn(data, 'death_year') && data.death_year !== null) {
    if (typeof data.death_year !== 'string' && typeof data.death_year !== 'number') {
      throw new Error('death_year must be a string, number, or null');
    }
    if (typeof data.death_year === 'string' && data.death_year.length > 50) {
      throw new Error('death_year is too long (max 50 characters)');
    }
  }
  
  // Валидация biography
  if (hasOwn(data, 'biography') && data.biography !== null) {
    if (typeof data.biography !== 'string') {
      throw new Error('biography must be a string or null');
    }
    // Биография может быть длинной, но ограничим разумным размером (1MB)
    if (data.biography.length > 1024 * 1024) {
      throw new Error('biography is too long (max 1MB)');
    }
  }
  
  // Валидация media массива
  if (hasOwn(data, 'media') && data.media !== undefined) {
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

  router.get('/', async (req, res) => {
    try {
      const filter = req.query.filter;
      if (filter && !['all', 'live', 'dead'].includes(filter)) {
        return res.status(400).json({ error: 'Invalid filter value. Must be "all", "live", or "dead"' });
      }
      res.json(await heroQueries.getAll(filter === 'all' ? undefined : filter || undefined));
    } catch (error) {
      logger.error('[Hero Router] Error in GET /', {
        filter: req.query.filter,
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  });

  router.get('/search', async (req, res) => {
    try {
      const query = req.query.q || '';
      if (typeof query !== 'string' || query.length > 200) {
        return res.status(400).json({ error: 'Invalid search query (max 200 characters)' });
      }
      res.json(await heroQueries.search(query));
    } catch (error) {
      logger.error('[Hero Router] Error in GET /search', {
        query: req.query.q,
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  });

  // Экспорт базы данных героев (для бэкапа)
  router.get('/export-database', requireHeroAdmin, async (req, res) => {
    let tmpPath = null;
    try {
      const heroes = await heroQueries.getAll();
      const dateStr = new Date().toISOString().split('T')[0];
      const filename = `heroes_backup_${dateStr}.db`;
      
      tmpPath = path.join(HERO_DB_UPLOAD_DIR, `hero_export_${crypto.randomBytes(8).toString('hex')}.db`);
      const Database = (await import('better-sqlite3')).default;
      const tmpDb = new Database(tmpPath);
      tmpDb.exec('PRAGMA foreign_keys = ON;');
      tmpDb.exec(`
        CREATE TABLE heroes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          full_name TEXT NOT NULL,
          birth_year TEXT,
          death_year TEXT,
          rank TEXT,
          photo_base64 TEXT,
          biography TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE hero_media (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hero_id INTEGER NOT NULL,
          type TEXT CHECK(type IN ('photo','video')),
          media_base64 TEXT NOT NULL,
          caption TEXT,
          order_index INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (hero_id) REFERENCES heroes(id) ON DELETE CASCADE
        );
      `);

      const insertHero = tmpDb.prepare(
        'INSERT INTO heroes (id, full_name, birth_year, death_year, rank, photo_base64, biography, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      const insertMedia = tmpDb.prepare(
        'INSERT INTO hero_media (hero_id, type, media_base64, caption, order_index, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );

      const txn = tmpDb.transaction(() => {
        for (const hero of heroes) {
          insertHero.run(hero.id, hero.full_name, hero.birth_year, hero.death_year, hero.rank, hero.photo_base64, hero.biography, hero.created_at, hero.updated_at);
          if (Array.isArray(hero.media)) {
            for (const m of hero.media) {
              insertMedia.run(m.hero_id || hero.id, m.type, m.media_base64, m.caption, m.order_index, m.created_at);
            }
          }
        }
      });
      txn();
      tmpDb.close();

      const stats = fs.statSync(tmpPath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', stats.size);

      const fileStream = fs.createReadStream(tmpPath);
      let isAborted = false;
      const cleanup = () => { isAborted = true; if (fileStream && !fileStream.destroyed) fileStream.destroy(); };
      req.on('close', cleanup);
      req.on('aborted', cleanup);
      res.on('close', cleanup);
      fileStream.on('error', () => { if (!isAborted && !res.headersSent) res.status(500).end(); cleanup(); });
      fileStream.pipe(res);
    } catch (error) {
      logger.error('[Hero Router] Error in GET /export-database', { error: error.message, stack: error.stack });
      if (!res.headersSent) res.status(500).json({ error: 'Ошибка экспорта базы героев' });
    } finally {
      if (tmpPath && fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
  });

  // Импорт базы героев: читает SQLite файл и импортирует данные в основную БД
  router.post('/import-database', requireHeroAdmin, heroDbImportUpload.single('file'), async (req, res) => {
    let uploadedPath = null;

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Файл не загружен' });
      }

      const uploadedName = String(req.file.filename || '');
      if (!/^[A-Za-z0-9._-]+$/.test(uploadedName)) {
        return res.status(400).json({ error: 'Некорректное имя файла' });
      }
      uploadedPath = validatePath(path.join(HERO_DB_UPLOAD_DIR, uploadedName), HERO_DB_UPLOAD_DIR);

      const ext = path.extname(req.file.originalname || '').toLowerCase();
      if (ext !== '.db') {
        return res.status(400).json({ error: 'Поддерживаются только файлы .db' });
      }

      const Database = (await import('better-sqlite3')).default;
      const probeDb = new Database(uploadedPath, { readonly: true, fileMustExist: true });
      let importedHeroes;
      try {
        validateImportedHeroDbSchema(probeDb);
        importedHeroes = probeDb.prepare('SELECT * FROM heroes ORDER BY id').all();
        const heroMediaMap = {};
        for (const hero of importedHeroes) {
          heroMediaMap[hero.id] = probeDb.prepare('SELECT * FROM hero_media WHERE hero_id = ? ORDER BY id').all(hero.id);
        }

        const db = await getHeroDb();
        await db.transaction(async (tx) => {
          const d = tx || db;
          await d.run('DELETE FROM hero_media');
          await d.run('DELETE FROM heroes');

          for (const hero of importedHeroes) {
            await d.run(
              'INSERT INTO heroes (id, full_name, birth_year, death_year, rank, photo_base64, biography, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [hero.id, hero.full_name, hero.birth_year, hero.death_year, hero.rank, hero.photo_base64, hero.biography, hero.created_at || new Date().toISOString(), hero.updated_at || new Date().toISOString()]
            );
            const media = heroMediaMap[hero.id] || [];
            for (const m of media) {
              await d.run(
                'INSERT INTO hero_media (hero_id, type, media_base64, caption, order_index, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [hero.id, m.type || 'photo', m.media_base64 || m.url || '', m.caption || m.title || '', m.order_index || 0, m.created_at || new Date().toISOString()]
              );
            }
          }
        });

        probeDb.close();
      } finally {
        try { probeDb.close(); } catch { /* already closed */ }
      }

      return res.json({
        ok: true,
        message: `База героев импортирована. Записей: ${importedHeroes.length}`,
        totalHeroes: importedHeroes.length
      });
    } catch (error) {
      logger.error('[Hero Router] Error in POST /import-database', { error: error.message, stack: error.stack });
      return res.status(500).json({ error: 'Ошибка импорта базы героев' });
    } finally {
      if (uploadedPath && fs.existsSync(uploadedPath)) {
        try { fs.unlinkSync(uploadedPath); } catch { /* ignore */ }
      }
    }
  });

  // CSV шаблон для импорта
  router.get('/export-template', requireHeroAdmin, async (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="heroes-template.csv"');
    res.send('\uFEFFfull_name;birth_year;death_year;rank;biography\n');
  });

  // Экспорт всех героев в CSV
  router.get('/export-csv', requireHeroAdmin, async (_req, res) => {
    try {
      const heroes = await heroQueries.getAll();
      const esc = (v) => {
        if (v == null) return '';
        const s = String(v);
        if (s.includes(';') || s.includes('"') || s.includes('\n')) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      };
      const rows = ['full_name;birth_year;death_year;rank;biography'];
      for (const h of heroes) {
        rows.push([esc(h.full_name), esc(h.birth_year), esc(h.death_year), esc(h.rank), esc(h.biography)].join(';'));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="heroes-export.csv"');
      res.send('\uFEFF' + rows.join('\n'));
    } catch (error) {
      logger.error('[Hero Router] Error in GET /export-csv', { error: error.message });
      res.status(500).json({ error: 'Ошибка экспорта CSV' });
    }
  });

  // Импорт героев из CSV
  router.post('/import', requireHeroAdmin, heroDbImportUpload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
      const content = fs.readFileSync(req.file.path, 'utf8');

      // Удаляем BOM если есть
      const clean = content.replace(/^\uFEFF/, '');
      const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      if (lines.length < 2) return res.json({ added: 0, updated: 0, errors: 0, errorMessages: [] });

      // Парсим заголовок
      const header = parseCsvLine(lines[0]);
      const colIndex = {};
      header.forEach((name, i) => { colIndex[name.toLowerCase().trim()] = i; });

      const fullNameIdx = colIndex['full_name'];
      if (fullNameIdx === undefined) {
        return res.status(400).json({ error: 'CSV должен содержать колонку "full_name"' });
      }

      let added = 0, updated = 0, errors = 0;
      const errorMessages = [];

      for (let i = 1; i < lines.length; i++) {
        try {
          const cols = parseCsvLine(lines[i]);
          const fullName = (cols[fullNameIdx] || '').trim();
          if (!fullName) { errors++; continue; }

          const birthYear = colIndex['birth_year'] !== undefined ? (cols[colIndex['birth_year']] || '').trim() || null : null;
          const deathYear = colIndex['death_year'] !== undefined ? (cols[colIndex['death_year']] || '').trim() || null : null;
          const rank = colIndex['rank'] !== undefined ? (cols[colIndex['rank']] || '').trim() || null : null;
          const biography = colIndex['biography'] !== undefined ? (cols[colIndex['biography']] || '').trim() || null : null;

          await heroQueries.create({
            full_name: fullName,
            birth_year: birthYear,
            death_year: deathYear,
            rank,
            biography
          });
          added++;
        } catch (err) {
          errors++;
          errorMessages.push(`Строка ${i + 1}: ${err.message}`);
        }
      }

      res.json({ added, updated, errors, errorMessages });
    } catch (error) {
      logger.error('[Hero Router] Error in POST /import', { error: error.message });
      res.status(500).json({ error: 'Ошибка импорта CSV' });
    } finally {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const id = validateId(req.params.id, 'hero id');
      const hero = await heroQueries.getById(id);
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

  router.post('/', requireHeroAdmin, createLimiter, async (req, res) => {
    try {
      validateHeroData(req.body, false);
      
      if (req.body.photo_base64 !== undefined && req.body.photo_base64 !== null) {
        validateMediaSize(req.body.photo_base64, 10 * 1024 * 1024);
      }
      
      const media = Array.isArray(req.body.media) ? req.body.media : [];
      for (const item of media) {
        if (!item.type || !item.media_base64) {
          throw new Error('Media items must have type and media_base64');
        }
        if (!['photo', 'video'].includes(item.type)) {
          throw new Error('Media type must be "photo" or "video"');
        }
        const limit = (item.type === 'video' ? 200 : 10) * 1024 * 1024;
        validateMediaSize(item.media_base64, limit);
      }

      const id = await heroQueries.createWithMedia(req.body, (item) => {
        if (!item.type || !item.media_base64) {
          throw new Error('Media items must have type and media_base64');
        }
        if (!['photo', 'video'].includes(item.type)) {
          throw new Error('Media type must be "photo" or "video"');
        }
        const limit = (item.type === 'video' ? 200 : 10) * 1024 * 1024;
        validateMediaSize(item.media_base64, limit);
      });

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

  router.put('/:id', requireHeroAdmin, async (req, res) => {
    try {
      const id = validateId(req.params.id, 'hero id');
      
      validateHeroData(req.body, true);
      
      if (req.body.photo_base64 !== undefined && req.body.photo_base64 !== null) {
        validateMediaSize(req.body.photo_base64, 10 * 1024 * 1024);
      }
      
      await heroQueries.updateWithMedia(id, req.body, (item) => {
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

  router.delete('/:id', requireHeroAdmin, deleteLimiter, async (req, res) => {
    try {
      const id = validateId(req.params.id, 'hero id');
      await heroQueries.delete(id);
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

  router.post('/:id/media', requireHeroAdmin, async (req, res) => {
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
      
      const mediaId = await heroQueries.addMedia(id, req.body);
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

  router.delete('/media/:mediaId', requireHeroAdmin, deleteLimiter, async (req, res) => {
    try {
      const mediaId = validateId(req.params.mediaId, 'media id');
      await heroQueries.deleteMedia(mediaId);
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

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ';') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}


