/**
 * Audit Logger - запись критических операций в БД
 * @module utils/audit-logger
 */

import { getDatabase } from '../database/database.js';
import logger from './logger.js';

/**
 * Типы аудируемых действий
 */
export const AuditAction = {
  // Аутентификация
  LOGIN: 'auth.login',
  LOGOUT: 'auth.logout',
  LOGIN_FAILED: 'auth.login_failed',
  TOKEN_REFRESH: 'auth.token_refresh',
  TOKEN_EXPIRED: 'auth.token_expired',
  
  // Управление пользователями
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',
  USER_DISABLE: 'user.disable',
  USER_ENABLE: 'user.enable',
  PASSWORD_RESET: 'user.password_reset',
  
  // Управление устройствами
  DEVICE_CREATE: 'device.create',
  DEVICE_UPDATE: 'device.update',
  DEVICE_DELETE: 'device.delete',
  DEVICE_CONNECT: 'device.connect',
  DEVICE_DISCONNECT: 'device.disconnect',
  
  // Файловые операции
  FILE_UPLOAD: 'file.upload',
  FILE_DELETE: 'file.delete',
  FILE_DOWNLOAD: 'file.download',
  FILE_CONVERT: 'file.convert',
  
  // Управление контентом
  CONTENT_PLAY: 'content.play',
  CONTENT_PAUSE: 'content.pause',
  CONTENT_STOP: 'content.stop',
  CONTENT_SEEK: 'content.seek',
  
  // Безопасность
  ACCESS_DENIED: 'security.access_denied',
  RATE_LIMIT_EXCEEDED: 'security.rate_limit',
  SUSPICIOUS_ACTIVITY: 'security.suspicious',
  PATH_TRAVERSAL_ATTEMPT: 'security.path_traversal'
};

/**
 * Записать событие в audit log
 * @param {Object} params
 * @param {number|null} params.userId - ID пользователя (null для анонимных)
 * @param {string} params.action - Тип действия (из AuditAction)
 * @param {string} params.resource - Ресурс (device_id, file_name, user_id и т.д.)
 * @param {Object} params.details - Дополнительные данные (JSON)
 * @param {string} params.ipAddress - IP адрес
 * @param {string} params.userAgent - User agent
 * @param {string} params.status - Статус: 'success', 'failure', 'warning'
 */
export async function auditLog({
  userId = null,
  action,
  resource = null,
  details = {},
  ipAddress = null,
  userAgent = null,
  status = 'success'
}) {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO audit_log 
      (user_id, action, resource, details, ip_address, user_agent, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      userId,
      action,
      resource,
      JSON.stringify(details),
      ipAddress,
      userAgent,
      status
    );

    // Дублируем в winston для файловых логов
    logger.info('Audit log entry', {
      userId,
      action,
      resource,
      details,
      ipAddress,
      status,
      category: 'audit'
    });

  } catch (error) {
    // Если audit log не удался, всё равно записываем в файл
    logger.error('Failed to write audit log to database', {
      error: error.message,
      action,
      userId,
      resource,
      category: 'audit'
    });
  }
}

/**
 * Middleware для автоматического аудита HTTP запросов
 */
export function createAuditMiddleware(action, getResource = null) {
  return async (req, res, next) => {
    // Сохраняем оригинальный res.json
    const originalJson = res.json.bind(res);

    res.json = function(data) {
      // Записываем в audit после успешного ответа
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const resource = getResource ? getResource(req) : null;
        
        auditLog({
          userId: req.user?.id || null,
          action,
          resource,
          details: {
            method: req.method,
            url: req.originalUrl,
            params: req.params,
            query: req.query,
            statusCode: res.statusCode
          },
          ipAddress: req.ip || req.connection?.remoteAddress,
          userAgent: req.get('user-agent'),
          status: 'success'
        }).catch(err => {
          logger.error('Audit middleware error', { error: err.message });
        });
      }

      return originalJson(data);
    };

    next();
  };
}

/**
 * Получить историю аудита для пользователя
 * @param {number} userId
 * @param {number} limit
 */
export function getUserAuditHistory(userId, limit = 100) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM audit_log 
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  
  return stmt.all(userId, limit);
}

/**
 * Получить историю аудита для ресурса
 * @param {string} resource
 * @param {number} limit
 */
export function getResourceAuditHistory(resource, limit = 100) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM audit_log 
    WHERE resource = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  
  return stmt.all(resource, limit);
}

/**
 * Получить недавние события безопасности
 * @param {number} hours - За последние N часов
 * @param {number} limit
 */
export function getSecurityEvents(hours = 24, limit = 100) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM audit_log 
    WHERE action LIKE 'security.%'
      AND created_at >= datetime('now', '-${hours} hours')
    ORDER BY created_at DESC
    LIMIT ?
  `);
  
  return stmt.all(limit);
}

/**
 * Получить неудачные попытки логина
 * @param {number} hours - За последние N часов
 */
export function getFailedLogins(hours = 1) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT ip_address, COUNT(*) as attempts, MAX(created_at) as last_attempt
    FROM audit_log 
    WHERE action = 'auth.login_failed'
      AND created_at >= datetime('now', '-${hours} hours')
    GROUP BY ip_address
    HAVING attempts >= 3
    ORDER BY attempts DESC
  `);
  
  return stmt.all();
}

export default auditLog;

