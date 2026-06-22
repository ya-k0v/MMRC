import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnFfprobe } from '../../utils/docker-ffmpeg.js';
import { getDatabase, driverType } from '../../database/database.js';
import { createModuleLogger } from '../../utils/logger.js';
const logger = createModuleLogger('ad');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AD_UPLOAD_DIR = path.resolve(__dirname, '../../../data/ad-uploads');
if (!fs.existsSync(AD_UPLOAD_DIR)) {
  fs.mkdirSync(AD_UPLOAD_DIR, { recursive: true, mode: 0o700 });
}

const upload = multer({ dest: AD_UPLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

function dbExec(sql, params = []) {
  const db = getDatabase();
  return driverType === 'postgres' ? db.query(sql, params) : db.run(sql, params);
}

function dbQuery(sql, params = []) {
  const db = getDatabase();
  return db.query(sql, params);
}

function dbGet(sql, params = []) {
  const db = getDatabase();
  return db.get(sql, params);
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath
    ];
    const probe = spawnFfprobe(args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; probe.kill('SIGKILL'); resolve(0); } }, 15000);
    probe.stdout.on('data', c => stdout += c.toString());
    probe.on('error', () => { if (!settled) { settled = true; clearTimeout(t); resolve(0); } });
    probe.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (code !== 0) return resolve(0);
      try {
        const parsed = JSON.parse(stdout);
        resolve(parseFloat(parsed?.format?.duration) || 0);
      } catch { resolve(0); }
    });
  });
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

export function createAdRouter(deps = {}) {
  const { requireAdAdmin = null } = deps;
  const router = Router();
  const adminOrAuth = requireAdAdmin || ((req, res, next) => next());

  // ========= VIDEOS CRUD =========

  // GET /api/ad/videos
  router.get('/videos', adminOrAuth, async (req, res) => {
    try {
      const videos = await dbQuery(
        'SELECT id, name, file_path, type, duration, display_duration, is_default, is_active, created_at FROM ad_videos ORDER BY name'
      );
      res.json({ videos });
    } catch (err) {
      logger.error('[Ad] Failed to list videos:', err.message);
      res.status(500).json({ error: 'Не удалось загрузить список роликов' });
    }
  });

  // POST /api/ad/videos — upload
  router.post('/videos', adminOrAuth, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Файл не загружен' });
      }
      const { name, display_duration } = req.body;
      if (!name || !name.trim()) {
        if (req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Название обязательно' });
      }
      const safeName = name.trim();
      const filePath = req.file.path;
      const ext = path.extname(req.file.originalname).toLowerCase();
      const isImage = IMAGE_EXTS.has(ext);
      const type = isImage ? 'image' : 'video';

      let duration = 0;
      if (!isImage) {
        duration = await probeDuration(filePath);
      }
      const dispDuration = parseFloat(display_duration) || 0;

      const result = await dbExec(
        'INSERT INTO ad_videos (name, file_path, type, duration, display_duration) VALUES (?, ?, ?, ?, ?)',
        [safeName, filePath, type, duration, isImage ? dispDuration : 0]
      );
      const newId = result?.lastInsertRowid || result?.insertId || null;
      logger.info(`[Ad] Uploaded: ${safeName} (id=${newId}, type=${type}, dur=${duration})`);
      res.json({ ok: true, id: newId, name: safeName, type, duration });
    } catch (err) {
      logger.error('[Ad] Failed to upload:', err.message);
      res.status(500).json({ error: 'Не удалось загрузить файл' });
    }
  });

  // PUT /api/ad/videos/:id
  router.put('/videos/:id', adminOrAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { name, display_duration, is_default, is_active } = req.body;
      const existing = await dbGet('SELECT id FROM ad_videos WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: 'Ролик не найден' });

      if (is_default) {
        await dbExec('UPDATE ad_videos SET is_default = 0 WHERE is_default = 1');
      }
      const sets = [];
      const vals = [];
      if (name !== undefined) { sets.push('name = ?'); vals.push(name.trim()); }
      if (display_duration !== undefined) { sets.push('display_duration = ?'); vals.push(parseFloat(display_duration) || 0); }
      if (is_default !== undefined) { sets.push('is_default = ?'); vals.push(is_default ? 1 : 0); }
      if (is_active !== undefined) { sets.push('is_active = ?'); vals.push(is_active ? 1 : 0); }
      if (sets.length) {
        vals.push(id);
        await dbExec(`UPDATE ad_videos SET ${sets.join(', ')} WHERE id = ?`, vals);
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error('[Ad] Failed to update:', err.message);
      res.status(500).json({ error: 'Не удалось обновить' });
    }
  });

  // DELETE /api/ad/videos/:id
  router.delete('/videos/:id', adminOrAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const video = await dbGet('SELECT file_path FROM ad_videos WHERE id = ?', [id]);
      if (!video) return res.status(404).json({ error: 'Ролик не найден' });
      if (video.file_path && fs.existsSync(video.file_path)) {
        fs.unlinkSync(video.file_path);
      }
      await dbExec('DELETE FROM ad_videos WHERE id = ?', [id]);
      logger.info(`[Ad] Deleted: id=${id}`);
      res.json({ ok: true });
    } catch (err) {
      logger.error('[Ad] Failed to delete:', err.message);
      res.status(500).json({ error: 'Не удалось удалить' });
    }
  });

  // ========= DISPLAYS CRUD =========

  // GET /api/ad/displays
  router.get('/displays', adminOrAuth, async (req, res) => {
    try {
      const displays = await dbQuery(
        'SELECT id, name, location, device_id, rotation_interval, is_active, created_at FROM ad_displays ORDER BY name'
      );
      res.json({ displays });
    } catch (err) {
      logger.error('[Ad] Failed to list displays:', err.message);
      res.status(500).json({ error: 'Не удалось загрузить список дисплеев' });
    }
  });

  // POST /api/ad/displays
  router.post('/displays', adminOrAuth, async (req, res) => {
    try {
      const { name, location, device_id, rotation_interval } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Название дисплея обязательно' });
      const result = await dbExec(
        'INSERT INTO ad_displays (name, location, device_id, rotation_interval) VALUES (?, ?, ?, ?)',
        [name.trim(), location || '', device_id || null, parseInt(rotation_interval) || 30]
      );
      const newId = result?.lastInsertRowid || result?.insertId || null;
      logger.info(`[Ad] Display created: ${name.trim()} (id=${newId})`);
      res.json({ ok: true, id: newId });
    } catch (err) {
      logger.error('[Ad] Failed to create display:', err.message);
      res.status(500).json({ error: 'Не удалось создать дисплей' });
    }
  });

  // PUT /api/ad/displays/:id
  router.put('/displays/:id', adminOrAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const existing = await dbGet('SELECT id FROM ad_displays WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: 'Дисплей не найден' });

      const { name, location, device_id, rotation_interval, is_active } = req.body;
      const sets = [];
      const vals = [];
      if (name !== undefined) { sets.push('name = ?'); vals.push(name.trim()); }
      if (location !== undefined) { sets.push('location = ?'); vals.push(location); }
      if (device_id !== undefined) { sets.push('device_id = ?'); vals.push(device_id); }
      if (rotation_interval !== undefined) { sets.push('rotation_interval = ?'); vals.push(parseInt(rotation_interval) || 30); }
      if (is_active !== undefined) { sets.push('is_active = ?'); vals.push(is_active ? 1 : 0); }
      if (sets.length) {
        vals.push(id);
        await dbExec(`UPDATE ad_displays SET ${sets.join(', ')} WHERE id = ?`, vals);
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error('[Ad] Failed to update display:', err.message);
      res.status(500).json({ error: 'Не удалось обновить дисплей' });
    }
  });

  // DELETE /api/ad/displays/:id
  router.delete('/displays/:id', adminOrAuth, async (req, res) => {
    try {
      const { id } = req.params;
      await dbExec('DELETE FROM ad_displays WHERE id = ?', [id]);
      logger.info(`[Ad] Display deleted: id=${id}`);
      res.json({ ok: true });
    } catch (err) {
      logger.error('[Ad] Failed to delete display:', err.message);
      res.status(500).json({ error: 'Не удалось удалить дисплей' });
    }
  });

  // ========= SCHEDULE =========

  // GET /api/ad/displays/:id/schedule
  router.get('/displays/:id/schedule', adminOrAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const schedule = await dbQuery(
        `SELECT s.id, s.display_id, s.video_id, s.priority_time, s.weight, s.is_active,
                v.name as video_name, v.file_path, v.type, v.duration, v.display_duration, v.is_default
         FROM ad_schedules s
         JOIN ad_videos v ON v.id = s.video_id
         WHERE s.display_id = ? AND s.is_active = 1
         ORDER BY v.is_default DESC, s.weight DESC`,
        [id]
      );
      res.json({ schedule });
    } catch (err) {
      logger.error('[Ad] Failed to get schedule:', err.message);
      res.status(500).json({ error: 'Не удалось загрузить расписание' });
    }
  });

  // POST /api/ad/displays/:id/schedule — set schedule
  router.post('/displays/:id/schedule', adminOrAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { video_ids } = req.body;
      if (!Array.isArray(video_ids)) {
        return res.status(400).json({ error: 'video_ids должен быть массивом' });
      }
      await dbExec('DELETE FROM ad_schedules WHERE display_id = ?', [id]);
      for (const item of video_ids) {
        const vId = typeof item === 'object' ? item.video_id : item;
        const pTime = typeof item === 'object' ? (item.priority_time || null) : null;
        const weight = typeof item === 'object' ? (parseFloat(item.weight) || 1.0) : 1.0;
        await dbExec(
          'INSERT INTO ad_schedules (display_id, video_id, priority_time, weight) VALUES (?, ?, ?, ?)',
          [id, vId, pTime, weight]
        );
      }
      logger.info(`[Ad] Schedule updated for display id=${id}`);
      res.json({ ok: true });
    } catch (err) {
      logger.error('[Ad] Failed to update schedule:', err.message);
      res.status(500).json({ error: 'Не удалось обновить расписание' });
    }
  });

  // ========= PLAYLIST (for ad-display player) =========

  router.get('/displays/:id/playlist', async (req, res) => {
    try {
      const { id } = req.params;
      const rows = await dbQuery(
        `SELECT v.id, v.name, v.file_path, v.type, v.duration, v.display_duration, v.is_default,
                s.priority_time, s.weight
         FROM ad_schedules s
         JOIN ad_videos v ON v.id = s.video_id
         WHERE s.display_id = ? AND s.is_active = 1 AND v.is_active = 1
         ORDER BY v.is_default DESC, s.weight DESC`,
        [id]
      );
      const playlist = rows.map(r => ({
        id: r.id,
        name: r.name,
        file_path: r.file_path,
        type: r.type,
        duration: r.duration,
        display_duration: r.display_duration,
        is_default: !!r.is_default,
        priority_time: r.priority_time ? JSON.parse(r.priority_time) : null,
        weight: r.weight
      }));
      res.json({ playlist });
    } catch (err) {
      logger.error('[Ad] Failed to get playlist:', err.message);
      res.status(500).json({ error: 'Не удалось загрузить плейлист' });
    }
  });

  // ========= ANALYTICS =========

  router.post('/analytics/:displayId/report', async (req, res) => {
    try {
      const { displayId } = req.params;
      const { video_id, is_default } = req.body;
      if (!video_id) return res.status(400).json({ error: 'video_id обязателен' });
      await dbExec(
        'INSERT INTO ad_analytics (display_id, video_id, is_default) VALUES (?, ?, ?)',
        [displayId, video_id, is_default ? 1 : 0]
      );
      res.json({ ok: true });
    } catch (err) {
      logger.error('[Ad] Failed to report analytics:', err.message);
      res.status(500).json({ error: 'Ошибка записи аналитики' });
    }
  });

  router.get('/analytics/stats', adminOrAuth, async (req, res) => {
    try {
      const { from, to, display_id, video_id } = req.query;
      const conditions = [];
      const params = [];
      if (from) { conditions.push('a.played_at >= ?'); params.push(from); }
      if (to) { conditions.push('a.played_at <= ?'); params.push(to); }
      if (display_id) { conditions.push('a.display_id = ?'); params.push(display_id); }
      if (video_id) { conditions.push('a.video_id = ?'); params.push(video_id); }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

      const rows = await dbQuery(
        `SELECT a.id, a.display_id, a.video_id, a.is_default, a.played_at,
                v.name as video_name, v.type, d.name as display_name
         FROM ad_analytics a
         JOIN ad_videos v ON v.id = a.video_id
         JOIN ad_displays d ON d.id = a.display_id
         ${where}
         ORDER BY a.played_at DESC`,
        params
      );

      const summary = {
        total_plays: rows.length,
        unique_videos: new Set(rows.map(r => r.video_id)).size,
        unique_displays: new Set(rows.map(r => r.display_id)).size,
        first_date: rows.length ? rows[rows.length - 1].played_at : null,
        last_date: rows.length ? rows[0].played_at : null
      };

      const perVideoMap = {};
      const perDisplayMap = {};
      for (const r of rows) {
        const d = r.played_at ? r.played_at.substring(0, 10) : 'unknown';
        const h = r.played_at ? r.played_at.substring(11, 13) : '00';
        const vk = `${r.video_id}|${d}|${h}`;
        const dk = `${r.display_id}|${d}`;
        if (!perVideoMap[vk]) perVideoMap[vk] = { video_id: r.video_id, video_name: r.video_name, type: r.type, play_date: d, play_hour: h, plays: 0 };
        perVideoMap[vk].plays++;
        if (!perDisplayMap[dk]) perDisplayMap[dk] = { display_id: r.display_id, display_name: r.display_name, play_date: d, total_plays: 0 };
        perDisplayMap[dk].total_plays++;
      }

      res.json({
        summary,
        perVideo: Object.values(perVideoMap).sort((a, b) => b.play_date.localeCompare(a.play_date) || a.play_hour.localeCompare(b.play_hour)),
        perDisplay: Object.values(perDisplayMap).sort((a, b) => b.play_date.localeCompare(a.play_date))
      });
    } catch (err) {
      logger.error('[Ad] Failed to get analytics:', err.message);
      res.status(500).json({ error: 'Не удалось загрузить аналитику' });
    }
  });

  return router;
}

export default createAdRouter({});
