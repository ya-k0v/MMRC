/**
 * JWT Authentication Middleware
 * @module middleware/auth
 */

import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import logger from '../utils/logger.js';

// Генерируем JWT_SECRET при запуске если не задан в env
let JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  // КРИТИЧНО: В production JWT_SECRET обязателен
  if (process.env.NODE_ENV === 'production') {
    logger.error('[Auth] ❌ JWT_SECRET is required in production!');
    logger.error('[Auth] Set JWT_SECRET in .env file and restart the server.');
    logger.error('[Auth] You can generate a secure secret with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
    process.exit(1);
  }
  // В development генерируем случайный ключ
  JWT_SECRET = crypto.randomBytes(64).toString('hex');
  logger.warn('[Auth] ⚠️ JWT_SECRET not set in env, generated random secret. Tokens will be invalidated on server restart!');
  logger.warn('[Auth] 💡 Set JWT_SECRET in .env file for production persistence.');
}

const JWT_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '12h';  // 12 часов для работы 24/7
const REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';  // 30 дней

/**
 * Генерация Access Token
 */
export function generateAccessToken(userId, username, role) {
  return jwt.sign(
    { userId, username, role, type: 'access' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Генерация Refresh Token
 */
export function generateRefreshToken(userId) {
  return jwt.sign(
    { userId, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: REFRESH_EXPIRES_IN }
  );
}

/**
 * Middleware: Требует аутентификации
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Токен не предоставлен' });
  }

  const token = authHeader.substring(7);
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.type !== 'access') {
      return res.status(401).json({ error: 'Неверный тип токена' });
    }
    
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Токен истек' });
    }
    return res.status(401).json({ error: 'Неверный токен' });
  }
}

/**
 * Middleware: Требует определенную роль
 * ИСПРАВЛЕНО: Теперь это массив middleware [requireAuth, checkRole]
 */
export function requireRole(...roles) {
  // Функция проверки роли
  const checkRole = (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Не аутентифицирован' });
    }
    
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    
    next();
  };
  
  // ИСПРАВЛЕНО: Возвращаем массив middleware [requireAuth, checkRole]
  // Это гарантирует что токен проверяется ДО проверки роли
  return [requireAuth, checkRole];
}

// Aliases для удобства
export const requireAdmin = requireRole('admin');
export const requireHeroAdmin = requireRole('admin', 'hero_admin');
export const requireSpeaker = requireRole('admin', 'speaker');

