/**
 * JWT Authentication Middleware
 * @module middleware/auth
 */

import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from '../database/database.js';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('auth');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');

let JWT_SECRET = process.env.JWT_SECRET;

function generateAndSaveJwtSecret() {
  const secret = crypto.randomBytes(48).toString('hex');
  process.env.JWT_SECRET = secret;

  try {
    let content;
    try {
      content = fs.readFileSync(ENV_PATH, 'utf-8');
    } catch {
      content = '';
    }

    const lineRegex = /^JWT_SECRET=.*$/m;
    const newLine = `JWT_SECRET=${secret}`;

    if (lineRegex.test(content)) {
      content = content.replace(lineRegex, newLine);
    } else {
      content = content ? content.trimEnd() + '\n\n# JWT Authentication\n' + newLine + '\n' : '# JWT Authentication\n' + newLine + '\n';
    }

    fs.writeFileSync(ENV_PATH, content, 'utf-8');
    logger.info('[Auth] ✅ JWT_SECRET auto-generated and saved to .env');
  } catch (err) {
    logger.warn('[Auth] ⚠️ Could not write JWT_SECRET to .env file. Secret will not persist across restarts.', { error: err.message });
  }

  return secret;
}

if (!JWT_SECRET) {
  logger.info('[Auth] 🔑 JWT_SECRET not set. Generating a secure random secret...');
  JWT_SECRET = generateAndSaveJwtSecret();
}

if (JWT_SECRET.length < 32) {
  logger.warn('[Auth] ⚠️ JWT_SECRET is too short (min 32 chars). Use a stronger secret.');
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
export const requireSpeaker = requireRole('admin', 'speaker', 'manager');
export const requireManager = requireRole('admin', 'manager');

const CSRF_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 час

/**
 * Генерация CSRF токена для пользователя
 */
export async function generateCsrfToken(userId) {
  const db = getDatabase();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + CSRF_TOKEN_EXPIRY_MS).toISOString();

  await db.run(
    `INSERT INTO csrf_tokens (user_id, token, expires_at) VALUES (?, ?, ?)`,
    [userId, token, expiresAt]
  );

  return token;
}

/**
 * Middleware: требует валидный CSRF токен
 * Токен передаётся в заголовке X-CSRF-Token
 * Токен одноразовый (used=1 после проверки)
 */
export async function requireCsrfToken(req, res, next) {
  const csrfToken = req.headers['x-csrf-token'];
  if (!csrfToken || typeof csrfToken !== 'string') {
    return res.status(403).json({ error: 'CSRF токен не предоставлен' });
  }

  const userId = req.user?.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Не аутентифицирован' });
  }

  try {
    const db = getDatabase();
    const record = await db.get(
      `SELECT id, user_id, token, expires_at, used FROM csrf_tokens WHERE token = ?`,
      [csrfToken]
    );

    if (!record) {
      return res.status(403).json({ error: 'Неверный CSRF токен' });
    }

    if (record.used === 1) {
      return res.status(403).json({ error: 'CSRF токен уже использован' });
    }

    if (new Date(record.expires_at) < new Date()) {
      return res.status(403).json({ error: 'CSRF токен истёк' });
    }

    if (record.user_id !== userId) {
      return res.status(403).json({ error: 'CSRF токен не принадлежит текущему пользователю' });
    }

    // Помечаем токен как использованный
    await db.run(`UPDATE csrf_tokens SET used = 1 WHERE id = ?`, [record.id]);

    next();
  } catch (err) {
    logger.error('[Auth] CSRF token validation error', { error: err.message });
    return res.status(500).json({ error: 'Ошибка проверки CSRF токена' });
  }
}

