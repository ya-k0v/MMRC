/**
 * Authentication routes
 * @module routes/auth
 */

import express from 'express';
import bcrypt from 'bcrypt';
import { body, validationResult } from 'express-validator';
import { getDatabase } from '../database/database.js';
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

    const { username, password } = req.body;
    const db = getDatabase();

    try {
      // Находим пользователя
      const user = db.prepare(`
        SELECT id, username, full_name, password_hash, role, is_active 
        FROM users 
        WHERE username = ?
      `).get(username);

      if (!user) {
        // Логируем неудачную попытку логина
        await auditLog({
          userId: null,
          action: AuditAction.LOGIN_FAILED,
          resource: username,
          details: { reason: 'user_not_found' },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          status: 'failure'
        });
        logSecurity('warn', 'Failed login attempt: user not found', { username, ip: req.ip });
        return res.status(401).json({ error: 'Неверный логин или пароль' });
      }

      if (!user.is_active) {
        // Логируем попытку входа в отключенный аккаунт
        await auditLog({
          userId: user.id,
          action: AuditAction.LOGIN_FAILED,
          resource: username,
          details: { reason: 'account_disabled' },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          status: 'failure'
        });
        logSecurity('warn', 'Failed login attempt: account disabled', { username, userId: user.id, ip: req.ip });
        return res.status(403).json({ error: 'Аккаунт отключен' });
      }

      // Проверяем пароль
      const passwordMatch = await bcrypt.compare(password, user.password_hash);
      
      if (!passwordMatch) {
        // Логируем неудачную попытку с неверным паролем
        await auditLog({
          userId: user.id,
          action: AuditAction.LOGIN_FAILED,
          resource: username,
          details: { reason: 'invalid_password' },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          status: 'failure'
        });
        logSecurity('warn', 'Failed login attempt: invalid password', { username, userId: user.id, ip: req.ip });
        return res.status(401).json({ error: 'Неверный логин или пароль' });
      }

      // Генерируем токены
      const accessToken = generateAccessToken(user.id, user.username, user.role);
      const refreshToken = generateRefreshToken(user.id);

      // Сохраняем refresh token в БД
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 дней

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

      // Обновляем last_login
      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

      // Логируем успешный вход
      await auditLog({
        userId: user.id,
        action: AuditAction.LOGIN,
        resource: username,
        details: { role: user.role },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        status: 'success'
      });
      logAuth('info', 'User logged in successfully', { username, userId: user.id, role: user.role, ip: req.ip });

      res.json({
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          username: user.username,
          full_name: user.full_name,
          role: user.role
        }
      });
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
      userId: req.user.id,
      action: AuditAction.LOGOUT,
      resource: req.user.username,
      details: { role: req.user.role },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      status: 'success'
    });
    logAuth('info', 'User logged out', { username: req.user.username, userId: req.user.id, ip: req.ip });

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    logger.error('Logout error', { error: err.message, stack: err.stack, userId: req.user.id });
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
      SELECT id, username, full_name, role, created_at, last_login
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
  body('role').isIn(['admin', 'speaker']),
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
        INSERT INTO users (username, full_name, password_hash, role)
        VALUES (?, ?, ?, ?)
      `).run(username, full_name, passwordHash, role);

      const newUserId = result.lastInsertRowid;

      // Логируем создание
      await auditLog({
        userId: req.user.id,
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
      SELECT id, username, full_name, role, is_active, created_at, last_login
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
      db.prepare(`
        INSERT INTO audit_log (user_id, action, resource_type, resource_id)
        VALUES (?, ?, ?, ?)
      `).run(
        req.user.userId,
        is_active ? 'ENABLE_USER' : 'DISABLE_USER',
        'user',
        userId
      );

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
    if (userId === req.user.id) {
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
      userId: req.user.id,
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
      const userToUpdate = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
      
      if (!userToUpdate) {
        return res.status(404).json({ error: 'Пользователь не найден' });
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
        userId: req.user.id,
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
        resetById: req.user.id
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

export function createAuthRouter() {
  return router;
}

