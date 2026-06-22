/**
 * Rate Limiting - защита от DDoS и brute-force
 * @module middleware/rate-limit
 */

import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';

/**
 * Проверка локального IP адреса
 * Rate limiting НЕ применяется к локальной сети (для device endpoints)
 */
function isLocalIP(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  
  // Локальные адреса (192.168.x.x, 10.x.x.x, 172.16-31.x.x, 127.0.0.1, ::1)
  return (
    ip === '127.0.0.1' || 
    ip === '::1' || ip === '::ffff:127.0.0.1' ||
    ip.startsWith('192.168.') || ip.startsWith('10.') ||
    ip.startsWith('172.16.') || ip.startsWith('172.17.') || ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') || ip.startsWith('172.20.') || ip.startsWith('172.21.') ||
    ip.startsWith('172.22.') || ip.startsWith('172.23.') || ip.startsWith('172.24.') ||
    ip.startsWith('172.25.') || ip.startsWith('172.26.') || ip.startsWith('172.27.') ||
    ip.startsWith('172.28.') || ip.startsWith('172.29.') || ip.startsWith('172.30.') ||
    ip.startsWith('172.31.')
  );
}

/**
 * Проверка - всегда false (для endpoints где rate limit всегда активен)
 */
function neverSkip() {
  return false;
}

/**
 * Глобальный rate limiter для всех API запросов
 * Применяется только к внешним IP (не локальная сеть)
 */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Too many requests from this IP, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  skip: isLocalIP,
  validate: { trustProxy: false }
});

/**
 * Строгий limiter для upload - ТОЛЬКО внешние IP
 */
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: 'Too many uploads, please try again later' },
  skipSuccessfulRequests: true,
  skip: isLocalIP,
  validate: { trustProxy: false }
});

/**
 * Auth limiter - защита от brute force
 * ВАЖНО: применяется ВСЕГДА (в том числе локальной сети)
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, please try again later' },
  skipSuccessfulRequests: true,
  skipFailedRequests: false,
  skip: neverSkip, // ⚡ ОГРАНИЧИВАЕМ ВСЕГДА - защита от brute force
  validate: { trustProxy: false }
});

/**
 * Admin limiter - защита админских endpoints
 * ВАЖНО: применяется ВСЕГДА
 */
export const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many admin requests, please try again later' },
  skip: neverSkip, // ⚡ ОГРАНИЧИВАЕМ ВСЕГДА
  validate: { trustProxy: false }
});

/**
 * Speed limiter для API (замедляет после N запросов)
 * Применяется только к внешним IP
 */
export const apiSpeedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 100,
  delayMs: () => 500,
  maxDelayMs: 20000,
  validate: { delayMs: false },
  skip: isLocalIP
});

/**
 * Limiter для операций удаления - ТОЛЬКО внешние IP
 */
export const deleteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: { error: 'Too many delete operations' },
  skip: isLocalIP,
  validate: { trustProxy: false }
});

/**
 * Limiter для создания ресурсов - ТОЛЬКО внешние IP
 */
export const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many create operations' },
  skip: isLocalIP,
  validate: { trustProxy: false }
});

/**
 * Limiter для интенсивных read-операций - ТОЛЬКО внешние IP
 */
export const readLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: { error: 'Too many read operations, please try again later' },
  skip: isLocalIP,
  validate: { trustProxy: false }
});

/**
 * Setup limiter - для первичной настройки (строгий)
 * ВАЖНО: применяется ВСЕГДА
 */
export const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: 3, // макс 3 попытки в час
  message: { error: 'Too many setup attempts, please try again later' },
  skip: neverSkip,
  validate: { trustProxy: false }
});

