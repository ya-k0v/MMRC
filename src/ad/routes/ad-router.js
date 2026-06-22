import { Router } from 'express';
import { getDatabase, driverType } from '../../database/database.js';
import { createModuleLogger } from '../../utils/logger.js';
const logger = createModuleLogger('ad');

function dbQuery(sql, params = []) {
  const db = getDatabase();
  return db.query(sql, params);
}

function dbExec(sql, params = []) {
  const db = getDatabase();
  return driverType === 'postgres' ? db.query(sql, params) : db.run(sql, params);
}

export function createAdRouter(deps = {}) {
  const { requireAdAdmin = null } = deps;
  const router = Router();
  const adminOrAuth = requireAdAdmin || ((req, res, next) => next());

  // POST /api/ad/analytics/report — log an ad impression
  router.post('/analytics/report', async (req, res) => {
    try {
      const { device_id, file_name } = req.body;
      if (!device_id || !file_name) {
        return res.status(400).json({ error: 'device_id и file_name обязательны' });
      }
      await dbExec(
        'INSERT INTO ad_analytics (device_id, file_name) VALUES (?, ?)',
        [device_id.trim(), file_name.trim()]
      );
      res.json({ ok: true });
    } catch (err) {
      logger.error('[Ad] Failed to report analytics:', err.message);
      res.status(500).json({ error: 'Ошибка записи аналитики' });
    }
  });

  // GET /api/ad/analytics/stats — get analytics with filters
  router.get('/analytics/stats', adminOrAuth, async (req, res) => {
    try {
      const { from, to, device_id } = req.query;
      const conditions = [];
      const params = [];
      if (from) { conditions.push('a.played_at >= ?'); params.push(from); }
      if (to) { conditions.push('a.played_at <= ?'); params.push(to); }
      if (device_id) { conditions.push('a.device_id = ?'); params.push(device_id); }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

      const rows = await dbQuery(
        `SELECT a.id, a.device_id, a.file_name, a.played_at
         FROM ad_analytics a
         ${where}
         ORDER BY a.played_at DESC`,
        params
      );

      const summary = {
        total_plays: rows.length,
        unique_devices: new Set(rows.map(r => r.device_id)).size,
        unique_files: new Set(rows.map(r => r.file_name)).size,
        first_date: rows.length ? rows[rows.length - 1].played_at : null,
        last_date: rows.length ? rows[0].played_at : null
      };

      const perDeviceMap = {};
      const perFileMap = {};
      for (const r of rows) {
        const d = r.played_at ? r.played_at.substring(0, 10) : 'unknown';
        const h = r.played_at ? r.played_at.substring(11, 13) : '00';
        const dk = `${r.device_id}|${d}`;
        const fk = `${r.file_name}|${d}|${h}`;
        if (!perDeviceMap[dk]) perDeviceMap[dk] = { device_id: r.device_id, play_date: d, total_plays: 0 };
        perDeviceMap[dk].total_plays++;
        if (!perFileMap[fk]) perFileMap[fk] = { file_name: r.file_name, play_date: d, play_hour: h, plays: 0 };
        perFileMap[fk].plays++;
      }

      res.json({
        summary,
        perDevice: Object.values(perDeviceMap).sort((a, b) => b.play_date.localeCompare(a.play_date)),
        perFile: Object.values(perFileMap).sort((a, b) => b.play_date.localeCompare(a.play_date) || a.play_hour.localeCompare(b.play_hour))
      });
    } catch (err) {
      logger.error('[Ad] Failed to get analytics:', err.message);
      res.status(500).json({ error: 'Не удалось загрузить аналитику' });
    }
  });

  // GET /api/ad/weights/:deviceId — get file weights for a device (без аутентификации — читает плеер)
  router.get('/weights/:deviceId', async (req, res) => {
    try {
      const { deviceId } = req.params;
      const rows = await dbQuery(
        'SELECT file_name, weight FROM ad_file_weights WHERE device_id = ? ORDER BY file_name',
        [deviceId]
      );
      const weights = {};
      for (const r of rows) weights[r.file_name] = r.weight;
      res.json({ device_id: deviceId, weights });
    } catch (err) {
      logger.error('[Ad] Failed to get weights:', err.message);
      res.status(500).json({ error: 'Ошибка загрузки весов' });
    }
  });

  // PUT /api/ad/weights/:deviceId — save file weights for a device
  router.put('/weights/:deviceId', adminOrAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const { weights } = req.body; // { file_name: weight, ... }
      if (!weights || typeof weights !== 'object') {
        return res.status(400).json({ error: 'weights object required' });
      }

      const ph = (i) => driverType === 'postgres' ? `$${i}` : '?';

      // Delete existing weights for this device
      await dbExec('DELETE FROM ad_file_weights WHERE device_id = ?', [deviceId]);

      // Insert new weights
      for (const [file_name, weight] of Object.entries(weights)) {
        const w = Math.max(1, Math.min(100, Math.round(Number(weight) || 1)));
        await dbExec(
          `INSERT INTO ad_file_weights (device_id, file_name, weight) VALUES (${ph(1)}, ${ph(2)}, ${ph(3)})`,
          [deviceId, file_name, w]
        );
      }

      res.json({ ok: true, device_id: deviceId });
    } catch (err) {
      logger.error('[Ad] Failed to save weights:', err.message);
      res.status(500).json({ error: 'Ошибка сохранения весов' });
    }
  });

  return router;
}

export default createAdRouter({});
