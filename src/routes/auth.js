import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { body, validationResult } from 'express-validator';
import { getDatabase } from '../database/database.js';
import { getLdapAuthSettings } from '../config/settings-manager.js';
import { authenticateAgainstLdap } from '../auth/ldap-auth.js';
import {
  generateAccessToken, generateRefreshToken, requireAuth, requireAdmin, requireManager, generateCsrfToken, requireCsrfToken
} from '../middleware/auth.js';
import { authLimiter, createLimiter, deleteLimiter, setupLimiter, adminLimiter } from '../middleware/rate-limit.js';
import { auditLog, AuditAction } from '../utils/audit-logger.js';
import { createModuleLogger, logAuth, logSecurity } from '../utils/logger.js';
const logger = createModuleLogger('auth');

const router = express.Router();

function normalizeAuthSource(authSource) {
  return authSource === 'ldap' ? 'ldap' : 'local';
}

async function getUserByUsername(db, username) {
  const row = await db.get(
    `SELECT id, username, full_name, password_hash, role, is_active, auth_source, ldap_dn
     FROM users WHERE username = ?`,
    [username]
  );
  if (!row) return null;
  return { ...row, auth_source: normalizeAuthSource(row.auth_source) };
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
    if (!normalizedGroup) continue;
    tokens.add(normalizedGroup);
    const cn = extractCnFromDn(group);
    if (cn) tokens.add(normalizeGroupToken(cn));
  }
  return tokens;
}

function resolveRoleFromLdapGroups(groups = [], ldapSettings = {}) {
  const roleMap = ldapSettings?.groupRoleMap && typeof ldapSettings.groupRoleMap === 'object'
    ? ldapSettings.groupRoleMap : {};
  const priority = Array.isArray(ldapSettings?.rolePriority) && ldapSettings.rolePriority.length
    ? ldapSettings.rolePriority : ['admin', 'hero_admin', 'speaker'];
  const groupTokens = collectLdapGroupTokens(groups);
  if (!groupTokens.size) return null;
  for (const role of priority) {
    if (!['admin', 'manager', 'speaker', 'hero_admin'].includes(role)) continue;
    const mappedGroups = Array.isArray(roleMap[role]) ? roleMap[role] : [];
    for (const mappedGroup of mappedGroups) {
      const mappedToken = normalizeGroupToken(mappedGroup);
      if (mappedToken && groupTokens.has(mappedToken)) return role;
    }
  }
  return null;
}

async function logLoginFailure(req, username, reason, userId = null) {
  await auditLog({
    userId, action: AuditAction.LOGIN_FAILED, resource: username,
    details: { reason }, ipAddress: req.ip, userAgent: req.get('user-agent'), status: 'failure'
  });
  logSecurity('warn', 'Failed login attempt', { username, userId, reason, ip: req.ip });
}

async function createSessionAndRespond(req, res, db, user, authSource = 'local') {
  const accessToken = generateAccessToken(user.id, user.username, user.role);
  const refreshToken = generateRefreshToken(user.id);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await db.run(
    `INSERT INTO refresh_tokens (user_id, token, expires_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    [user.id, refreshToken, expiresAt.toISOString(), req.ip, req.get('user-agent')]
  );

  await db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

  await auditLog({
    userId: user.id, action: AuditAction.LOGIN, resource: user.username,
    details: { role: user.role, authSource },
    ipAddress: req.ip, userAgent: req.get('user-agent'), status: 'success'
  });

  logAuth('info', 'User logged in successfully', {
    username: user.username, userId: user.id, role: user.role, authSource, ip: req.ip
  });

  res.json({
    accessToken, refreshToken,
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, auth_source: normalizeAuthSource(user.auth_source) }
  });
}

router.post('/login',
  authLimiter,
  body('username').trim().notEmpty(),
  body('password').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const db = getDatabase();

    try {
      let user = await getUserByUsername(db, username);
      const ldapSettings = getLdapAuthSettings({ includeSecrets: true });
      const ldapEnabled = Boolean(ldapSettings.enabled);
      let authenticatedUser = null;
      let authSource = 'local';

      if (user && !user.is_active) {
        await logLoginFailure(req, username, 'account_disabled', user.id);
        return res.status(403).json({ error: 'Пользователь заблокирован. Обратитесь к администратору.', code: 'ACCOUNT_DISABLED' });
      }

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
          await logLoginFailure(req, username, user ? 'ldap_disabled' : 'user_not_found', user?.id || null);
          return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const ldapResult = await authenticateAgainstLdap(username, password, ldapSettings);
        if (!ldapResult.ok) {
          const ldapFailureReason = ldapResult.reason || 'ldap_error';
          await logLoginFailure(req, username, ldapFailureReason, user?.id || null);
          if (['misconfigured', 'ldap_error', 'disabled'].includes(ldapFailureReason)) {
            logger.warn('[Auth] LDAP unavailable, fallback to local auth only', { username, reason: ldapFailureReason });
          }
          return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const ldapUsername = String(ldapResult.user?.username || username).trim();
        const ldapFullName = String(ldapResult.user?.fullName || ldapUsername).trim() || ldapUsername;
        const ldapDn = String(ldapResult.user?.dn || '').trim() || null;
        const mappedRoleFromGroups = resolveRoleFromLdapGroups(ldapResult.user?.groups || [], ldapSettings);

        let ldapUser = await getUserByUsername(db, ldapUsername);
        if (!ldapUser && ldapUsername !== username) {
          const aliasUser = await getUserByUsername(db, username);
          if (aliasUser && aliasUser.auth_source === 'ldap') ldapUser = aliasUser;
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
            ? ldapSettings.defaultRole : 'speaker';
          const effectiveRole = mappedRoleFromGroups || defaultRole;

          const result = await db.run(
            `INSERT INTO users (username, full_name, password_hash, auth_source, ldap_dn, role, is_active)
             VALUES (?, ?, ?, 'ldap', ?, ?, TRUE)`,
            [ldapUsername, ldapFullName, passwordHash, ldapDn, effectiveRole]
          );

          ldapUser = await getUserByUsername(db, ldapUsername);
        } else {
          if (!ldapUser.is_active) {
            await logLoginFailure(req, username, 'account_disabled', ldapUser.id);
            return res.status(403).json({ error: 'Пользователь заблокирован. Обратитесь к администратору.', code: 'ACCOUNT_DISABLED' });
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
            await db.run(
              `UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [...params, ldapUser.id]
            );
          }
          ldapUser = await getUserByUsername(db, ldapUser.username);
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

async function checkAdminExists(db) {
  const admin = await db.get(`SELECT 1 FROM users WHERE role = 'admin' AND is_active IS TRUE LIMIT 1`);
  return !!admin;
}

router.get('/setup/status', async (req, res) => {
  const db = getDatabase();
  try {
    const needsSetup = !(await checkAdminExists(db));
    res.json({ needsSetup });
  } catch (err) {
    logger.error('Setup status check error', { error: err.message });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.post('/setup-first-admin',
  setupLimiter,
  body('username').trim().isLength({ min: 3, max: 50 }),
  body('full_name').trim().isLength({ min: 1, max: 100 }),
  body('password').isLength({ min: 12 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const db = getDatabase();

    try {
      if (await checkAdminExists(db)) {
        return res.status(403).json({ error: 'Администратор уже существует. Настройка не требуется.' });
      }

      const { username, full_name, password } = req.body;

      const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
      if (existing) return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });

      const passwordHash = await bcrypt.hash(password, 12);
      const result = await db.run(
        `INSERT INTO users (username, full_name, password_hash, auth_source, role, is_active)
         VALUES (?, ?, ?, 'local', 'admin', TRUE)`,
        [username, full_name, passwordHash]
      );

      const newUserId = result.lastInsertRowid;

      await auditLog({
        userId: newUserId, action: AuditAction.USER_CREATE, resource: `user:${newUserId}`,
        details: { username, full_name, role: 'admin', setup: true },
        ipAddress: req.ip, userAgent: req.get('user-agent'), status: 'success'
      });
      logAuth('info', 'First admin created via setup', { newUserId, username, ip: req.ip });

      const accessToken = generateAccessToken(newUserId, username, 'admin');
      const refreshToken = generateRefreshToken(newUserId);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      await db.run(
        `INSERT INTO refresh_tokens (user_id, token, expires_at, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?)`,
        [newUserId, refreshToken, expiresAt.toISOString(), req.ip, req.get('user-agent')]
      );

      res.status(201).json({
        accessToken, refreshToken,
        user: { id: newUserId, username, full_name, role: 'admin', auth_source: 'local' }
      });
    } catch (err) {
      logger.error('Setup first admin error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

router.post('/refresh',
  body('refreshToken').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { refreshToken } = req.body;
    const db = getDatabase();

    try {
      const tokenRecord = await db.get(
        `SELECT rt.user_id, rt.expires_at, u.username, u.role, u.is_active
         FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id
         WHERE rt.token = ?`,
        [refreshToken]
      );

      if (!tokenRecord) return res.status(401).json({ error: 'Неверный токен обновления' });
      if (!tokenRecord.is_active) return res.status(403).json({ error: 'Аккаунт отключен' });

      if (new Date(tokenRecord.expires_at) < new Date()) {
        await db.run('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken]);
        return res.status(401).json({ error: 'Токен обновления истек' });
      }

      const accessToken = generateAccessToken(tokenRecord.user_id, tokenRecord.username, tokenRecord.role);
      await db.run('UPDATE refresh_tokens SET last_used = CURRENT_TIMESTAMP WHERE token = ?', [refreshToken]);

      res.json({ accessToken, expiresIn: 900 });
    } catch (err) {
      logger.error('Refresh error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

router.post('/logout', requireAuth, async (req, res) => {
  const { refreshToken } = req.body;
  const db = getDatabase();

  try {
    if (refreshToken) {
      await db.run('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken]);
    }

    await auditLog({
      userId: req.user.userId, action: AuditAction.LOGOUT, resource: req.user.username,
      details: { role: req.user.role }, ipAddress: req.ip, userAgent: req.get('user-agent'), status: 'success'
    });
    logAuth('info', 'User logged out', { username: req.user.username, userId: req.user.userId, ip: req.ip });

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    logger.error('Logout error', { error: err.message, stack: err.stack, userId: req.user.userId });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  const db = getDatabase();

  try {
    const user = await db.get(
      `SELECT id, username, full_name, role, auth_source, created_at, last_login
       FROM users WHERE id = ?`,
      [req.user.userId]
    );

    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(user);
  } catch (err) {
    logger.error('Me error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.post('/csrf-token', requireAuth, async (req, res) => {
  try {
    const token = await generateCsrfToken(req.user.userId);
    res.json({ csrfToken: token });
  } catch (err) {
    logger.error('CSRF token generation error', { error: err.message });
    res.status(500).json({ error: 'Ошибка генерации CSRF токена' });
  }
});

router.post('/register',
  requireAuth, requireManager, createLimiter,
  body('username').trim().isLength({ min: 3, max: 50 }),
  body('full_name').trim().isLength({ min: 1, max: 100 }),
  body('password').isLength({ min: 8 }),
  body('role').isIn(['admin', 'speaker', 'manager', 'hero_admin']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, full_name, password, role } = req.body;
    const db = getDatabase();

    try {
      const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
      if (existing) return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });

      const passwordHash = await bcrypt.hash(password, 10);
      const result = await db.run(
        `INSERT INTO users (username, full_name, password_hash, auth_source, role)
         VALUES (?, ?, ?, 'local', ?)`,
        [username, full_name, passwordHash, role]
      );

      const newUserId = result.lastInsertRowid;

      await auditLog({
        userId: req.user.userId, action: AuditAction.USER_CREATE, resource: `user:${newUserId}`,
        details: { username, full_name, role, createdBy: req.user.username },
        ipAddress: req.ip, userAgent: req.get('user-agent'), status: 'success'
      });
      logAuth('info', 'User created', { newUserId, username, role, createdBy: req.user.username });

      res.status(201).json({ id: newUserId, username, full_name, role });
    } catch (err) {
      logger.error('Register error', { error: err.message, stack: err.stack, username });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

router.get('/users', requireAuth, requireManager, async (req, res) => {
  const db = getDatabase();

  try {
    const users = await db.query(
      `SELECT id, username, full_name, role, auth_source, is_active, created_at, last_login
       FROM users ORDER BY created_at DESC`
    );
    res.json(users);
  } catch (err) {
    logger.error('Users list error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.post('/users/:id/toggle', requireAuth, requireManager, async (req, res) => {
  const userId = parseInt(req.params.id);
  const { is_active } = req.body;
  const db = getDatabase();

  try {
    if (userId === req.user.userId) return res.status(400).json({ error: 'Нельзя отключить свой аккаунт' });

    await db.run('UPDATE users SET is_active = ? WHERE id = ?', [is_active ? true : false, userId]);
    // When deactivating, instantly invalidate all access tokens
    if (!is_active) {
      await db.run('UPDATE users SET token_valid_from = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
    }

    const targetUsername = (await db.get('SELECT username FROM users WHERE id = ?', [userId]))?.username || 'unknown';

    await auditLog({
      userId: req.user.userId,
      action: is_active ? AuditAction.USER_ENABLE : AuditAction.USER_DISABLE,
      resource: `user:${userId}`,
      details: { targetUserId: userId, targetUsername },
      ipAddress: req.ip, userAgent: req.get('user-agent'), status: 'success'
    });

    res.json({ success: true });
  } catch (err) {
    logger.error('Toggle user error', { error: err.message, stack: err.stack, userId: req.params.id });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.put('/users/:id/role',
  requireAuth, requireAdmin,
  body('role').isIn(['admin', 'manager', 'speaker', 'hero_admin']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = parseInt(req.params.id);
    const { role } = req.body;
    const db = getDatabase();

    try {
      if (userId === 1) return res.status(400).json({ error: 'Нельзя изменить роль администратора по умолчанию' });

      const user = await db.get('SELECT id, username, role, auth_source FROM users WHERE id = ?', [userId]);
      if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

      const oldRole = user.role;
      await db.run('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [role, userId]);

      await auditLog({
        userId: req.user.userId, action: 'user.role_change',
        resource: `user:${userId}`,
        details: { targetUsername: user.username, oldRole, newRole: role, changedBy: req.user.username },
        ipAddress: req.ip, userAgent: req.get('user-agent'), status: 'success'
      });
      logAuth('info', 'User role changed', { userId, username: user.username, oldRole, newRole: role, changedBy: req.user.username });

      res.json({ success: true });
    } catch (err) {
      logger.error('Change role error', { error: err.message, stack: err.stack, userId });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

router.delete('/users/:id', requireAuth, requireAdmin, deleteLimiter, async (req, res) => {
  const userId = parseInt(req.params.id);
  const db = getDatabase();

  try {
    if (userId === req.user.userId) return res.status(400).json({ error: 'Нельзя удалить свой аккаунт' });
    if (userId === 1) return res.status(400).json({ error: 'Нельзя удалить администратора по умолчанию' });

    const userToDelete = await db.get('SELECT username, role FROM users WHERE id = ?', [userId]);
    if (!userToDelete) return res.status(404).json({ error: 'Пользователь не найден' });

    await db.run('DELETE FROM users WHERE id = ?', [userId]);

    await auditLog({
      userId: req.user.userId, action: AuditAction.USER_DELETE, resource: `user:${userId}`,
      details: { deletedUsername: userToDelete.username, deletedRole: userToDelete.role, deletedBy: req.user.username },
      ipAddress: req.ip, userAgent: req.get('user-agent'), status: 'success'
    });
    logAuth('warn', 'User deleted', { deletedUserId: userId, deletedUsername: userToDelete.username, deletedBy: req.user.username });

    res.json({ success: true });
  } catch (err) {
    logger.error('Delete user error', { error: err.message, stack: err.stack, userId });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.post('/users/:id/reset-password',
  requireAuth, requireAdmin,
  body('new_password').isLength({ min: 8 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = parseInt(req.params.id);
    const { new_password } = req.body;
    const db = getDatabase();

    try {
      const userToUpdate = await db.get('SELECT id, username, role, auth_source FROM users WHERE id = ?', [userId]);
      if (!userToUpdate) return res.status(404).json({ error: 'Пользователь не найден' });
      if (normalizeAuthSource(userToUpdate.auth_source) === 'ldap') {
        return res.status(400).json({ error: 'Пароль LDAP пользователя изменяется в Active Directory' });
      }

      const passwordHash = await bcrypt.hash(new_password, 10);

      await db.run('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [passwordHash, userId]);
      await db.run('DELETE FROM refresh_tokens WHERE user_id = ?', [userId]);
      // Instantly invalidate all access tokens for this user
      await db.run('UPDATE users SET token_valid_from = CURRENT_TIMESTAMP WHERE id = ?', [userId]);

      await auditLog({
        userId: req.user.userId, action: AuditAction.PASSWORD_RESET, resource: `user:${userId}`,
        details: { targetUsername: userToUpdate.username, targetRole: userToUpdate.role, resetBy: req.user.username, note: 'Password reset by admin (forced logout from all devices)' },
        ipAddress: req.ip, userAgent: req.get('user-agent'), status: 'success'
      });
      logAuth('warn', 'Password reset by admin', { targetUserId: userId, targetUsername: userToUpdate.username, resetBy: req.user.username, resetById: req.user.userId });

      res.json({ success: true, message: 'Password updated successfully. User has been logged out from all devices.' });
    } catch (err) {
      logger.error('Reset password error', { error: err.message, stack: err.stack, userId });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

router.put('/users/:id',
  requireAuth, requireAdmin,
  body('full_name').optional().trim().isLength({ min: 1, max: 100 }),
  async (req, res) => {
    const userId = parseInt(req.params.id);
    const db = getDatabase();

    try {
      const user = await db.get('SELECT id, username FROM users WHERE id = ?', [userId]);
      if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

      const { full_name } = req.body;

      if (full_name !== undefined) {
        await db.run('UPDATE users SET full_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [full_name, userId]);
      }

      await auditLog({
        userId: req.user.userId, action: 'user_update', resource: `user:${userId}`,
        details: { targetUsername: user.username, updatedBy: req.user.username, changes: { full_name } },
        ipAddress: req.ip, userAgent: req.get('user-agent'), status: 'success'
      });

      res.json({ success: true, message: 'Пользователь обновлён' });
    } catch (err) {
      logger.error('Update user error', { error: err.message, stack: err.stack, userId });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

router.get('/users/:id/devices', requireAuth, requireManager, async (req, res) => {
  const userId = parseInt(req.params.id);
  const db = getDatabase();

  try {
    const devices = await db.query('SELECT device_id FROM user_devices WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    res.json(devices.map(d => d.device_id));
  } catch (err) {
    logger.error('Get user devices error', { error: err.message, stack: err.stack, userId });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.post('/users/:id/devices',
  requireAuth, requireManager,
  body('deviceIds').isArray(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = parseInt(req.params.id);
    try {
      const { deviceIds } = req.body;
      const db = getDatabase();

      const user = await db.get('SELECT id, username FROM users WHERE id = ?', [userId]);
      if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

      const existing = await db.query('SELECT device_id FROM devices');
      const validIds = new Set(existing.map(r => r.device_id));
      const invalid = deviceIds.filter(id => !validIds.has(id));
      if (invalid.length) {
        return res.status(400).json({ error: 'Устройства не найдены', invalidDeviceIds: invalid });
      }

      await db.transaction(async (tx) => {
        await tx.run('DELETE FROM user_devices WHERE user_id = ?', [userId]);
        for (const deviceId of deviceIds) {
          try {
            await tx.run('INSERT INTO user_devices (user_id, device_id) VALUES (?, ?)', [userId, deviceId]);
          } catch (insertErr) {
            if (!insertErr.message?.includes('UNIQUE') && !insertErr.message?.includes('duplicate')) throw insertErr;
          }
        }
      });

      await auditLog({
        userId: req.user.userId, action: AuditAction.USER_UPDATE, resource: `user:${userId}`,
        details: { targetUsername: user.username, deviceCount: deviceIds.length, deviceIds, updatedBy: req.user.username },
        ipAddress: req.ip, userAgent: req.get('user-agent'), status: 'success'
      });

      if (router.io) {
        router.io.emit('user/devices/updated', { userId });
      }

      res.json({ success: true, deviceCount: deviceIds.length });
    } catch (err) {
      logger.error('Set user devices error', { error: err.message, stack: err.stack, userId });
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

export function createAuthRouter(io = null) {
  if (io) router.io = io;
  return router;
}
