import { getDatabase } from '../database/database.js';
import logger from './logger.js';
import { withRetrySync, isRetryableDatabaseError } from './retry.js';

export const AuditAction = {
  LOGIN: 'auth.login',
  LOGOUT: 'auth.logout',
  LOGIN_FAILED: 'auth.login_failed',
  TOKEN_REFRESH: 'auth.token_refresh',
  TOKEN_EXPIRED: 'auth.token_expired',
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',
  USER_DISABLE: 'user.disable',
  USER_ENABLE: 'user.enable',
  PASSWORD_RESET: 'user.password_reset',
  DEVICE_CREATE: 'device.create',
  DEVICE_UPDATE: 'device.update',
  DEVICE_DELETE: 'device.delete',
  DEVICE_CONNECT: 'device.connect',
  DEVICE_DISCONNECT: 'device.disconnect',
  FILE_UPLOAD: 'file.upload',
  FILE_DELETE: 'file.delete',
  FILE_DOWNLOAD: 'file.download',
  FILE_CONVERT: 'file.convert',
  CONTENT_PLAY: 'content.play',
  CONTENT_PAUSE: 'content.pause',
  CONTENT_STOP: 'content.stop',
  CONTENT_SEEK: 'content.seek',
  ACCESS_DENIED: 'security.access_denied',
  RATE_LIMIT_EXCEEDED: 'security.rate_limit',
  SUSPICIOUS_ACTIVITY: 'security.suspicious',
  PATH_TRAVERSAL_ATTEMPT: 'security.path_traversal'
};

export async function auditLog({
  userId = null, action, resource = null, details = {},
  ipAddress = null, userAgent = null, status = 'success'
}) {
  try {
    const db = getDatabase();
    await db.run(
      `INSERT INTO audit_log (user_id, action, resource, details, ip_address, user_agent, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, action, resource, JSON.stringify(details), ipAddress, userAgent, status]
    );

    logger.info('Audit log entry', { userId, action, resource, details, ipAddress, status, category: 'audit' });
  } catch (error) {
    logger.error('Failed to write audit log to database after retries', {
      error: error.message, stack: error.stack, action, userId, resource, category: 'audit'
    });
  }
}

export function createAuditMiddleware(action, getResource = null) {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = function(data) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const resource = getResource ? getResource(req) : null;
        auditLog({
          userId: req.user?.id || null, action, resource,
          details: { method: req.method, url: req.originalUrl, params: req.params, query: req.query, statusCode: res.statusCode },
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

export async function getUserAuditHistory(userId, limit = 100) {
  const db = getDatabase();
  return db.query(
    'SELECT * FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, limit]
  );
}

export async function getResourceAuditHistory(resource, limit = 100) {
  const db = getDatabase();
  return db.query(
    'SELECT * FROM audit_log WHERE resource = ? ORDER BY created_at DESC LIMIT ?',
    [resource, limit]
  );
}

export async function getSecurityEvents(hours = 24, limit = 100) {
  const safeHours = Math.max(0, Math.min(Number.parseInt(hours, 10) || 24, 720));
  const db = getDatabase();
  const cutoffDate = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  return db.query(
    `SELECT * FROM audit_log WHERE action LIKE 'security.%' AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
    [cutoffDate, limit]
  );
}

export async function getFailedLogins(hours = 1) {
  const safeHours = Math.max(0, Math.min(Number.parseInt(hours, 10) || 1, 168));
  const db = getDatabase();
  const cutoffDate = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  return db.query(
    `SELECT ip_address, COUNT(*) as attempts, MAX(created_at) as last_attempt
     FROM audit_log WHERE action = 'auth.login_failed' AND created_at >= ?
     GROUP BY ip_address HAVING attempts >= 3 ORDER BY attempts DESC`,
    [cutoffDate]
  );
}

export default auditLog;
