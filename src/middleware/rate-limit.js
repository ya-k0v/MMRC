/**
 * Rate Limiting - защита от DDoS и brute-force
 * @module middleware/rate-limit
 */

import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';

/**
 * Проверка локального IP адреса
 * Rate limiting НЕ применяется к локальной сети
 */
function isLocalIP(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  
  // Локальные адреса (192.168.x.x, 10.x.x.x, 172.16-31.x.x, 127.0.0.1, ::1)
  return (
    ip === '127.0.0.1' || 
    ip === '::1' || 
    ip === '::ffff:127.0.0.1' ||
    ip.startsWith('192.168.') || 
    ip.startsWith('10.') ||
    ip.startsWith('172.16.') ||
    ip.startsWith('172.17.') ||
    ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') ||
    ip.startsWith('172.20.') ||
    ip.startsWith('172.21.') ||
    ip.startsWith('172.22.') ||
    ip.startsWith('172.23.') ||
    ip.startsWith('172.24.') ||
    ip.startsWith('172.25.') ||
    ip.startsWith('172.26.') ||
    ip.startsWith('172.27.') ||
    ip.startsWith('172.28.') ||
    ip.startsWith('172.29.') ||
    ip.startsWith('172.30.') ||
    ip.startsWith('172.31.')
  );
}

/**
 * Глобальный rate limiter для всех API запросов
 * Применяется только к внешним IP (не локальная сеть)
 */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 1000, // 1000 запросов с одного IP
  message: { error: 'Too many requests from this IP, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  skip: isLocalIP, // ⚡ Не ограничиваем локальную сеть
  // КРИТИЧНО: Отключаем проверку trust proxy, так как мы используем кастомный skip
  validate: {
    trustProxy: false
  }
});

/**
 * Строгий limiter для upload
 * Применяется только к внешним IP
 */
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // 50 upload за 15 минут
  message: { error: 'Too many uploads, please try again later' },
  skipSuccessfulRequests: true,
  skip: isLocalIP, // ⚡ Не ограничиваем локальную сеть
  validate: {
    trustProxy: false
  }
});

/**
 * Auth limiter - защита от brute force
 * Применяется только к внешним IP
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // 5 попыток входа за 15 минут
  message: { error: 'Too many login attempts, please try again later' },
  skipSuccessfulRequests: true, // Успешные логины не считаем
  skipFailedRequests: false,
  skip: isLocalIP, // ⚡ Не ограничиваем локальную сеть
  validate: {
    trustProxy: false
  }
});

/**
 * Speed limiter для API (замедляет после N запросов)
 * Применяется только к внешним IP
 */
export const apiSpeedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 100, // После 100 запросов начинаем замедлять
  delayMs: () => 500, // Фиксированная задержка 500ms
  maxDelayMs: 20000, // Максимум 20 секунд задержки
  validate: { delayMs: false }, // Отключаем warning
  skip: isLocalIP // ⚡ Не ограничиваем локальную сеть
});

/**
 * Limiter для операций удаления
 * Применяется только к внешним IP
 */
export const deleteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 минут
  max: 20, // Максимум 20 удалений за 5 минут
  message: { error: 'Too many delete operations' },
  skip: isLocalIP, // ⚡ Не ограничиваем локальную сеть
  validate: {
    trustProxy: false
  }
});

/**
 * Limiter для создания ресурсов
 * Применяется только к внешним IP
 */
export const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // 30 созданий за 15 минут
  message: { error: 'Too many create operations' },
  skip: isLocalIP, // ⚡ Не ограничиваем локальную сеть
  validate: {
    trustProxy: false
  }
});

