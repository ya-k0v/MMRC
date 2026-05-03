/**
 * Authentication routes
 * @module routes/auth
 */

import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { body, validationResult } from 'express-validator';
import { getDatabase } from '../database/database.js';
import { getLdapAuthSettings } from '../config/settings-manager.js';
import { authenticateAgainstLdap } from '../auth/ldap-auth.js';
import { 
  generateAccessToken, 
  generateRefreshToken, 
  requireAuth,
  requireAdmin
} from '../middleware/auth.js';
import { authLimiter, createLimiter, deleteLimiter } from '../middleware/rate-limit.js';
import { auditLog, AuditAction } from '../utils/audit-logger.js';
import logger, { logAuth, logSecurity } from '../utils/logger.js';

const router = express.Router();

function normalizeAuthSource(authSource) {
  return authSource === 'ldap' ? 'ldap' : 'local';
}

function getUserByUsername(db, username) {
  const row = db.prepare(`
    SELECT id, username, full_name, password_hash, role, is_active, auth_source, ldap_dn
    FROM users
    WHERE username = ?
  `).get(username);

  if (!row) {
    return null;
  }

  return {
    ...row,
    auth_source: normalizeAuthSource(row.auth_source)
  };
}

function normalizeGroupToken(value) {
  return String(value || '').trim().toLowerCase();
}

function extractCnFromDn(dnValue) {
  const match = String(dnValue || '').match(/(?:^|,)\s*cn=([^,]+)/i);
  return match ? String(match[1]).trim() : '';
}

function collectLdapGroupTokens(groups = []) {
  const values = Array.isArray(groups) ? groups : [];
  const tokens = new Set();

  for (const group of values) {
    const normalizedGroup = normalizeGroupToken(group);
    if (!normalizedGroup) {
      continue;
    }

    tokens.add(normalizedGroup);

    const cn = extractCnFromDn(group);
    if (cn) {
      tokens.add(normalizeGroupToken(cn));
    }
  }

  return tokens;
}

function resolveRoleFromLdapGroups(groups = [], ldapSettings = {}) {
  const roleMap = ldapSettings?.groupRoleMap && typeof ldapSettings.groupRoleMap === 'object'
    ? ldapSettings.groupRoleMap
    : {};
  const priority = Array.isArray(ldapSettings?.rolePriority) && ldapSettings.rolePriority.length
    ? ldapSettings.rolePriority
    : ['admin', 'hero_admin', 'speaker'];
  const groupTokens = collectLdapGroupTokens(groups);

  if (!groupTokens.size) {
    return null;
  }

  for (const role of priority) {
    if (!['admin', 'speaker', 'hero_admin'].includes(role)) {
      continue;
    }

    const mappedGroups = Array.isArray(roleMap[role]) ? roleMap[role] : [];
    for (const mappedGroup of mappedGroups) {
      const mappedToken = normalizeGroupToken(mappedGroup);
      if (mappedToken && groupTokens.has(mappedToken)) {
        return role;
      }
    }
  }

  return null;
}

async function logLoginFailure(req, username, reason, userId = null) {
  await auditLog({
    userId,
    action: AuditAction.LOGIN_FAILED,
    resource: username,
    details: { reason },
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    status: 'failure'
  });

  logSecurity('warn', 'Failed login attempt', {
    username,
    userId,
    reason,
    ip: req.ip
  });
}

async function createSessionAndRespond(req, res, db, user, authSource = 'local') {
  const accessToken = generateAccessToken(user.id, user.username, user.role);
  const refreshToken = generateRefreshToken(user.id);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  db.prepare(`
    INSERT INTO refresh_tokens (user_id, token, expires_at, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    user.id,
    refreshToken,
    expiresAt.toISOString(),
    req.ip,
    req.get('user-agent')
  );

  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

  await auditLog({
    userId: user.id,
    action: AuditAction.LOGIN,
    resource: user.username,
    details: {
      role: user.role,
      authSource
    },
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    status: 'success'
  });

  logAuth('info', 'User logged in successfully', {
    username: user.username,
    userId: user.id,
    role: user.role,
    authSource,
    ip: req.ip
  });

  res.json({
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      auth_source: normalizeAuthSource(user.auth_source)
    }
  });
}

/**
 * POST /api/auth/login
 * Вход в систему (с rate limiting от brute-force)
 */
router.post('/login',
  authLimiter, // Защита от brute-force
  body('username').trim().notEmpty(),
  body('password').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const db = getDatabase();

    try {
      let user = getUserByUsername(db, username);
      const ldapSettings = getLdapAuthSettings({ includeSecrets: true });
      const ldapEnabled = Boolean(ldapSettings.enabled);
      let authenticatedUser = null;
      let authSource = 'local';

      if (user && !user.is_active) {
        await logLoginFailure(req, username, 'account_disabled', user.id);
        return res.status(403).json({
          error: 'Пользователь заблокирован. Обратитесь к администратору.',
          code: 'ACCOUNT_DISABLED'
        });
      }

      // Для локальных учеток проверяем только локальный пароль, чтобы LDAP не ломал обратную совместимость.
      if (user && user.auth_source === 'local') {
        const passwordMatch = await bcrypt.compare(password, user.password_hash);

        if (!passwordMatch) {
          await logLoginFailure(req, username, 'invalid_password', user.id);
          return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        authenticatedUser = user;
        authSource = 'local';
      }

      if (!authenticatedUser) {
        if (!ldapEnabled) {
          const reason = user ? 'ldap_disabled' : 'user_not_found';
          await logLoginFailure(req, username, reason, user?.id || null);
          return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const ldapResult = await authenticateAgainstLdap(username, password, ldapSettings);

        if (!ldapResult.ok) {
          const ldapFailureReason = ldapResult.reason || 'ldap_error';
          await logLoginFailure(req, username, ldapFailureReason, user?.id || null);

          if (ldapFailureReason === 'misconfigured' || ldapFailureReason === 'ldap_error' || ldapFailureReason === 'disabled') {
            logger.warn('[Auth] LDAP unavailable, fallback to local auth only', {
              username,
              reason: ldapFailureReason
            });
          }

          return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const ldapUsername = String(ldapResult.user?.username || username).trim();
        const ldapFullName = String(ldapResult.user?.fullName || ldapUsername).trim() || ldapUsername;
        const ldapDn = String(ldapResult.user?.dn || '').trim() || null;
        const mappedRoleFromGroups = resolveRoleFromLdapGroups(ldapResult.user?.groups || [], ldapSettings);

        let ldapUser = getUserByUsername(db, ldapUsername);

        if (!ldapUser && ldapUsername !== username) {
          const aliasUser = getUserByUsername(db, username);
          if (aliasUser && aliasUser.auth_source === 'ldap') {
            ldapUser = aliasUser;
          }
        }

        if (ldapUser && ldapUser.auth_source === 'local') {
          await logLoginFailure(req, username, 'local_user_conflict', ldapUser.id);
          return res.status(403).json({ error: 'Для этого пользователя разрешен только локальный вход' });
        }

        if (!ldapUser) {
          if (!ldapSettings.autoCreateUsers) {
            await logLoginFailure(req, username, 'ldap_user_not_registered');
            return res.status(403).json({ error: 'Пользователь LDAP не зарегистрирован в системе' });
          }

          const generatedPassword = crypto.randomBytes(32).toString('hex');
          const passwordHash = await bcrypt.hash(generatedPassword, 10);
          const defaultRole = ['admin', 'speaker', 'hero_admin'].includes(ldapSettings.defaultRole)
            ? ldapSettings.defaultRole
            : 'speaker';
          const effectiveRole = mappedRoleFromGroups || defaultRole;

          const insertResult = db.prepare(`
            INSERT INTO users (username, full_name, password_hash, auth_source, ldap_dn, role, is_active)
            VALUES (?, ?, ?, 'ldap', ?, ?, 1)
          `).run(ldapUsername, ldapFullName, passwordHash, ldapDn, effectiveRole);

          ldapUser = db.prepare(`
            SELECT id, username, full_name, password_hash, role, is_active, auth_source, ldap_dn
            FROM users
            WHERE id = ?
          `).get(insertResult.lastInsertRowid);
        } else {
          if (!ldapUser.is_active) {
            await logLoginFailure(req, username, 'account_disabled', ldapUser.id);
            return res.status(403).json({
              error: 'Пользователь заблокирован. Обратитесь к администратору.',
              code: 'ACCOUNT_DISABLED'
            });
          }

          const updates = [];
          const params = [];

          if (ldapFullName && ldapFullName !== ldapUser.full_name) {
            updates.push('full_name = ?');
            params.push(ldapFullName);
          }

          if (ldapDn !== ldapUser.ldap_dn) {
            updates.push('ldap_dn = ?');
            params.push(ldapDn);
          }

          if (mappedRoleFromGroups && mappedRoleFromGroups !== ldapUser.role) {
            updates.push('role = ?');
            params.push(mappedRoleFromGroups);
          }

          if (updates.length > 0) {
            db.prepare(`
              UPDATE users
              SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(...params, ldapUser.id);
          }

          ldapUser = getUserByUsername(db, ldapUser.username);
        }

        authenticatedUser = ldapUser;
        authSource = 'ldap';
      }

      if (!authenticatedUser) {
        await logLoginFailure(req, username, 'authentication_failed');
        return res.status(401).json({ error: 'Неверный логин или пароль' });
      }

      return createSessionAndRespond(req, res, db, authenticatedUser, authSource);
    } catch (err) {
      logger.error('Login error', { error: err.message, stack: err.stack, username });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

/**
 * POST /api/auth/refresh
 * Обновление access token
 */
router.post('/refresh',
  body('refreshToken').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { refreshToken } = req.body;
    const db = getDatabase();

    try {
      // Проверяем refresh token в БД
      const tokenRecord = db.prepare(`
        SELECT rt.user_id, rt.expires_at, u.username, u.role, u.is_active
        FROM refresh_tokens rt
        JOIN users u ON rt.user_id = u.id
        WHERE rt.token = ?
      `).get(refreshToken);

      if (!tokenRecord) {
        return res.status(401).json({ error: 'Неверный токен обновления' });
      }

      if (!tokenRecord.is_active) {
        return res.status(403).json({ error: 'Аккаунт отключен' });
      }

      // Проверяем срок действия
      if (new Date(tokenRecord.expires_at) < new Date()) {
        // Удаляем истекший токен
        db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(refreshToken);
        return res.status(401).json({ error: 'Токен обновления истек' });
      }

      // Генерируем новый access token
      const accessToken = generateAccessToken(
        tokenRecord.user_id,
        tokenRecord.username,
        tokenRecord.role
      );

      // Обновляем last_used
      db.prepare(`
        UPDATE refresh_tokens 
        SET last_used = CURRENT_TIMESTAMP 
        WHERE token = ?
      `).run(refreshToken);

      res.json({
        accessToken,
        expiresIn: 900 // 15 минут в секундах
      });
    } catch (err) {
      logger.error('Refresh error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

/**
 * POST /api/auth/logout
 * Выход из системы
 */
router.post('/logout', requireAuth, async (req, res) => {
  const { refreshToken } = req.body;
  const db = getDatabase();

  try {
    if (refreshToken) {
      // Удаляем refresh token
      db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(refreshToken);
    }

    // Логируем выход
    await auditLog({
      userId: req.user.userId,
      action: AuditAction.LOGOUT,
      resource: req.user.username,
      details: { role: req.user.role },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      status: 'success'
    });
    logAuth('info', 'User logged out', { username: req.user.username, userId: req.user.userId, ip: req.ip });

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    logger.error('Logout error', { error: err.message, stack: err.stack, userId: req.user.userId });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * GET /api/auth/me
 * Получить текущего пользователя
 */
router.get('/me', requireAuth, async (req, res) => {
  const db = getDatabase();

  try {
    const user = db.prepare(`
      SELECT id, username, full_name, role, auth_source, created_at, last_login
      FROM users
      WHERE id = ?
    `).get(req.user.userId);

    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json(user);
  } catch (err) {
    logger.error('Me error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * POST /api/auth/register
 * Регистрация пользователя (только admin)
 */
router.post('/register',
  requireAuth,
  requireAdmin,
  createLimiter, // Ограничение на создание
  body('username').trim().isLength({ min: 3, max: 50 }),
  body('full_name').trim().isLength({ min: 1, max: 100 }),
  body('password').isLength({ min: 8 }),
  body('role').isIn(['admin', 'speaker', 'hero_admin']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, full_name, password, role } = req.body;
    const db = getDatabase();

    try {
      // Проверяем уникальность
      const existing = db.prepare(`
        SELECT id FROM users WHERE username = ?
      `).get(username);

      if (existing) {
        return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
      }

      // Хешируем пароль
      const passwordHash = await bcrypt.hash(password, 10);

      // Создаем пользователя
      const result = db.prepare(`
        INSERT INTO users (username, full_name, password_hash, auth_source, role)
        VALUES (?, ?, ?, 'local', ?)
      `).run(username, full_name, passwordHash, role);

      const newUserId = result.lastInsertRowid;

      // Логируем создание
      await auditLog({
        userId: req.user.userId,
        action: AuditAction.USER_CREATE,
        resource: `user:${newUserId}`,
        details: { username, full_name, role, createdBy: req.user.username },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        status: 'success'
      });
      logAuth('info', 'User created', { 
        newUserId, 
        username, 
        role, 
        createdBy: req.user.username 
      });

      res.status(201).json({
        id: newUserId,
        username,
        full_name,
        role
      });
    } catch (err) {
      logger.error('Register error', { error: err.message, stack: err.stack, username });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

/**
 * GET /api/auth/users
 * Получить список пользователей (только admin)
 */
router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  const db = getDatabase();

  try {
    const users = db.prepare(`
      SELECT id, username, full_name, role, auth_source, is_active, created_at, last_login
      FROM users
      ORDER BY created_at DESC
    `).all();

    res.json(users);
  } catch (err) {
    logger.error('Users list error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * POST /api/auth/users/:id/toggle
 * Включить/отключить пользователя (только admin)
 */
router.post('/users/:id/toggle',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const userId = parseInt(req.params.id);
    const { is_active } = req.body;
    const db = getDatabase();

    try {
      // Нельзя отключить себя
      if (userId === req.user.userId) {
        return res.status(400).json({ error: 'Нельзя отключить свой аккаунт' });
      }

      // Обновляем статус
      db.prepare(`
        UPDATE users SET is_active = ? WHERE id = ?
      `).run(is_active ? 1 : 0, userId);

      // Логируем
      await auditLog({
        userId: req.user.userId,
        action: is_active ? AuditAction.USER_ENABLE : AuditAction.USER_DISABLE,
        resource: `user:${userId}`,
        details: { 
          targetUserId: userId,
          targetUsername: db.prepare('SELECT username FROM users WHERE id = ?').get(userId)?.username || 'unknown'
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        status: 'success'
      });

      res.json({ success: true });
    } catch (err) {
      logger.error('Toggle user error', { error: err.message, stack: err.stack, userId: req.params.id });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

/**
 * DELETE /api/auth/users/:id
 * Удалить пользователя (только admin)
 */
router.delete('/users/:id', requireAuth, requireAdmin, deleteLimiter, async (req, res) => {
  const userId = parseInt(req.params.id);
  const db = getDatabase();

  try {
    // Нельзя удалить себя
    if (userId === req.user.userId) {
      return res.status(400).json({ error: 'Нельзя удалить свой аккаунт' });
    }

    // Нельзя удалить первого admin
    if (userId === 1) {
      return res.status(400).json({ error: 'Нельзя удалить администратора по умолчанию' });
    }

    // Получаем информацию о пользователе перед удалением
    const userToDelete = db.prepare('SELECT username, role FROM users WHERE id = ?').get(userId);
    
    if (!userToDelete) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Удаляем пользователя (каскадно удалятся refresh_tokens)
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    // Логируем удаление
    await auditLog({
      userId: req.user.userId,
      action: AuditAction.USER_DELETE,
      resource: `user:${userId}`,
      details: { 
        deletedUsername: userToDelete.username, 
        deletedRole: userToDelete.role,
        deletedBy: req.user.username 
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      status: 'success'
    });
    logAuth('warn', 'User deleted', { 
      deletedUserId: userId, 
      deletedUsername: userToDelete.username,
      deletedBy: req.user.username 
    });

    res.json({ success: true });
  } catch (err) {
    logger.error('Delete user error', { error: err.message, stack: err.stack, userId });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * POST /api/auth/users/:id/reset-password
 * Сброс пароля пользователя администратором (без подтверждения старого)
 */
router.post('/users/:id/reset-password',
  requireAuth,
  requireAdmin,
  body('new_password').isLength({ min: 8 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = parseInt(req.params.id);
    const { new_password } = req.body;
    const db = getDatabase();

    try {
      // Получаем информацию о пользователе
      const userToUpdate = db.prepare('SELECT id, username, role, auth_source FROM users WHERE id = ?').get(userId);
      
      if (!userToUpdate) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      if (normalizeAuthSource(userToUpdate.auth_source) === 'ldap') {
        return res.status(400).json({ error: 'Пароль LDAP пользователя изменяется в Active Directory' });
      }

      // Хешируем новый пароль
      const passwordHash = await bcrypt.hash(new_password, 10);

      // Обновляем пароль
      db.prepare(`
        UPDATE users 
        SET password_hash = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).run(passwordHash, userId);

      // Инвалидируем все refresh tokens пользователя (принудительный выход со всех устройств)
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);

      // Логируем сброс пароля
      await auditLog({
        userId: req.user.userId,
        action: AuditAction.PASSWORD_RESET,
        resource: `user:${userId}`,
        details: { 
          targetUsername: userToUpdate.username,
          targetRole: userToUpdate.role,
          resetBy: req.user.username,
          note: 'Password reset by admin (forced logout from all devices)'
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        status: 'success'
      });
      logAuth('warn', 'Password reset by admin', { 
        targetUserId: userId, 
        targetUsername: userToUpdate.username,
        resetBy: req.user.username,
        resetById: req.user.userId
      });

      res.json({ 
        success: true,
        message: 'Password updated successfully. User has been logged out from all devices.'
      });
    } catch (err) {
      logger.error('Reset password error', { error: err.message, stack: err.stack, userId });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

/**
 * GET /api/auth/users/:id/devices
 * Получить список устройств пользователя (только admin)
 */
router.get('/users/:id/devices', requireAuth, requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.id);
  const db = getDatabase();

  try {
    const devices = db.prepare(`
      SELECT device_id
      FROM user_devices
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(userId);

    res.json(devices.map(d => d.device_id));
  } catch (err) {
    logger.error('Get user devices error', { error: err.message, stack: err.stack, userId });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * POST /api/auth/users/:id/devices
 * Назначить устройства пользователю (только admin)
 */
router.post('/users/:id/devices',
  requireAuth,
  requireAdmin,
  body('deviceIds').isArray(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = parseInt(req.params.id);
    const { deviceIds } = req.body;
    const db = getDatabase();

    try {
      // Проверяем существование пользователя
      const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
      if (!user) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      // Начинаем транзакцию
      const transaction = db.transaction((userId, deviceIds) => {
        // Удаляем все существующие назначения
        db.prepare('DELETE FROM user_devices WHERE user_id = ?').run(userId);

        // Добавляем новые назначения
        const insertStmt = db.prepare(`
          INSERT INTO user_devices (user_id, device_id)
          VALUES (?, ?)
        `);

        for (const deviceId of deviceIds) {
          try {
            insertStmt.run(userId, deviceId);
          } catch (insertErr) {
            // Игнорируем ошибки дубликатов (UNIQUE constraint)
            if (!insertErr.message.includes('UNIQUE constraint')) {
              throw insertErr;
            }
          }
        }
      });

      transaction(userId, deviceIds);

      // Логируем назначение
      await auditLog({
        userId: req.user.userId,
        action: AuditAction.USER_UPDATE,
        resource: `user:${userId}`,
        details: { 
          targetUsername: user.username,
          deviceCount: deviceIds.length,
          deviceIds: deviceIds,
          updatedBy: req.user.username
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        status: 'success'
      });

      // Отправляем Socket.IO событие для обновления панели спикера в реальном времени
      if (router.io) {
        try {
          // Отправляем событие всем подключениям (панель спикера обновит список через API)
          router.io.emit('user/devices/updated', { userId });
          logger.info('User devices updated event sent', { userId, deviceCount: deviceIds.length });
        } catch (socketErr) {
          logger.error('Failed to send user devices updated event', { 
            error: socketErr.message, 
            userId 
          });
        }
      }

      res.json({ 
        success: true,
        deviceCount: deviceIds.length
      });
    } catch (err) {
      logger.error('Set user devices error', { error: err.message, stack: err.stack, userId });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

/**
 * Создает роутер аутентификации
 * @param {Server} io - Socket.IO сервер (опционально)
 * @returns {express.Router}
 */
export function createAuthRouter(io = null) {
  // Сохраняем io для использования в роутерах
  if (io) {
    router.io = io;
  }
  return router;
}

