/**
 * Middleware для проверки доступа к устройствам
 * @module middleware/device-access
 */

import { getDatabase } from '../database/database.js';
import { auditLog, AuditAction } from '../utils/audit-logger.js';
import logger from '../utils/logger.js';

/**
 * Middleware: Проверяет доступ пользователя к устройству
 * Admin имеет доступ ко всем устройствам
 * Speaker - только к назначенным устройствам
 * Hero Admin - не имеет доступа к устройствам (своя панель)
 */
export function checkDeviceAccess(req, res, next) {
  // Если пользователь не аутентифицирован, requireAuth уже вернул ошибку
  if (!req.user) {
    return res.status(401).json({ error: 'Не аутентифицирован' });
  }

  // Hero Admin не имеет доступа к устройствам
  if (req.user.role === 'hero_admin') {
    auditLog({
      userId: req.user.userId,
      action: AuditAction.ACCESS_DENIED,
      resource: `device:${req.params.id || req.params.device_id || 'unknown'}`,
      details: {
        username: req.user.username,
        role: req.user.role,
        reason: 'hero_admin_no_device_access',
        path: req.path,
        method: req.method
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      status: 'failure'
    }).catch(err => {
      logger.error('Failed to log access denied', { error: err.message });
    });

    return res.status(403).json({ 
      error: 'Доступ к устройствам недоступен для Hero Admin',
      reason: 'hero_admin_has_separate_panel'
    });
  }

  // Admin имеет доступ ко всем устройствам
  if (req.user.role === 'admin') {
    return next();
  }

  // Для speaker проверяем назначенные устройства
  const deviceId = req.params.id || req.params.device_id || req.body.device_id;
  
  if (!deviceId) {
    // Если device_id не указан, пропускаем (например, для GET /api/devices)
    return next();
  }

  const db = getDatabase();
  
  try {
    // Проверяем, есть ли у пользователя доступ к этому устройству
    const hasAccess = db.prepare(`
      SELECT 1 FROM user_devices
      WHERE user_id = ? AND device_id = ?
    `).get(req.user.userId, deviceId);

    if (!hasAccess) {
      // Логируем попытку доступа
      auditLog({
        userId: req.user.userId,
        action: AuditAction.ACCESS_DENIED,
        resource: `device:${deviceId}`,
        details: {
          username: req.user.username,
          role: req.user.role,
          deviceId,
          path: req.path,
          method: req.method
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        status: 'failure'
      }).catch(err => {
        logger.error('Failed to log access denied', { error: err.message });
      });

      logger.warn('Device access denied', {
        userId: req.user.userId,
        username: req.user.username,
        role: req.user.role,
        deviceId,
        path: req.path
      });

      return res.status(403).json({ 
        error: 'Доступ к устройству запрещен',
        deviceId 
      });
    }

    // Доступ разрешен
    next();
  } catch (err) {
    logger.error('Device access check error', {
      error: err.message,
      stack: err.stack,
      userId: req.user.userId,
      deviceId
    });
    return res.status(500).json({ error: 'Ошибка проверки доступа' });
  }
}

/**
 * Получить список доступных устройств для пользователя
 * @param {number} userId - ID пользователя
 * @returns {string[]} Массив device_id
 */
export function getUserDevices(userId) {
  const db = getDatabase();
  
  try {
    const devices = db.prepare(`
      SELECT device_id
      FROM user_devices
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(userId);

    return devices.map(d => d.device_id);
  } catch (err) {
    logger.error('Get user devices error', {
      error: err.message,
      stack: err.stack,
      userId
    });
    return [];
  }
}

/**
 * Проверить, имеет ли пользователь доступ к устройству
 * @param {number} userId - ID пользователя
 * @param {string} deviceId - ID устройства
 * @param {string} userRole - Роль пользователя
 * @returns {boolean}
 */
export function hasDeviceAccess(userId, deviceId, userRole) {
  // Hero Admin не имеет доступа к устройствам
  if (userRole === 'hero_admin') {
    return false;
  }

  // Admin имеет доступ ко всем устройствам
  if (userRole === 'admin') {
    return true;
  }

  const db = getDatabase();
  
  try {
    const hasAccess = db.prepare(`
      SELECT 1 FROM user_devices
      WHERE user_id = ? AND device_id = ?
    `).get(userId, deviceId);

    return !!hasAccess;
  } catch (err) {
    logger.error('Has device access check error', {
      error: err.message,
      userId,
      deviceId
    });
    return false;
  }
}

