import express from 'express';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import { hasDeviceAccess } from '../middleware/device-access.js';

/**
 * Роутер для управления громкостью устройств
 * @param {Object} deps
 * @param {Object} deps.devices - карта устройств
 * @param {Function} deps.getVolumeState - функция получения состояния громкости
 * @param {Function} deps.applyVolumeCommand - функция применения команд громкости
 * @param {Array<Function>} deps.requireSpeaker - middleware аутентификации (speaker/admin)
 * @returns {express.Router}
 */
export function createVolumeRouter(deps) {
  const {
    devices,
    getVolumeState,
    applyVolumeCommand,
    requireSpeaker
  } = deps;
  
  const router = express.Router();
  
  router.get('/:id/volume', requireSpeaker, (req, res) => {
    const deviceId = sanitizeDeviceId(req.params.id);
    if (!deviceId) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }

    if (!hasDeviceAccess(req.user.userId, deviceId, req.user.role)) {
      return res.status(403).json({ error: 'Доступ к устройству запрещен' });
    }

    if (!devices[deviceId]) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    const state = getVolumeState(deviceId);
    return res.json({
      device_id: deviceId,
      level: state.level,
      muted: state.muted,
      updated_at: state.updatedAt || null
    });
  });
  
  router.post('/:id/volume', requireSpeaker, (req, res) => {
    const deviceId = sanitizeDeviceId(req.params.id);
    if (!deviceId) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }

    if (!hasDeviceAccess(req.user.userId, deviceId, req.user.role)) {
      return res.status(403).json({ error: 'Доступ к устройству запрещен' });
    }

    if (!devices[deviceId]) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    const { level, delta, muted } = req.body || {};
    if (
      typeof level === 'undefined' &&
      typeof delta === 'undefined' &&
      typeof muted === 'undefined'
    ) {
      return res.status(400).json({ error: 'Требуется level, delta или muted' });
    }
    
    try {
      const result = applyVolumeCommand(
        deviceId,
        {
          level: typeof level === 'undefined' ? undefined : Number(level),
          delta: typeof delta === 'undefined' ? undefined : Number(delta),
          muted: typeof muted === 'undefined' ? undefined : Boolean(muted)
        },
        { source: 'api' }
      );
      
      return res.json({
        device_id: deviceId,
        level: result.level,
        muted: result.muted,
        updated_at: result.updatedAt
      });
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Не удалось обновить громкость' });
    }
  });
  
  return router;
}

