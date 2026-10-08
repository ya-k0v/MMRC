/**
 * Хранилище уведомлений.
 *
 * Redis — когда он доступен (REDIS_URL задан и отвечает), иначе прозрачный
 * fallback в память: всё, что не умеет Redis, работает как раньше.
 *
 * Ключи в Redis:
 *  - mmrc:notifications          HASH id → JSON уведомления
 *  - mmrc:notifications:order    ZSET score=timestamp(ms), member=id
 *
 * Хэш хранит тела, упорядоченный набор — порядок по времени и быстрый кап.
 * Уведомления переживают рестарт и доступны всем инстансам.
 *
 * @module utils/notification-store
 */

import { Redis } from 'ioredis';

const HASH_KEY = 'mmrc:notifications';
const ORDER_KEY = 'mmrc:notifications:order';

/** Небольшая задержка подключения: если Redis лежит, не держим старт подолгу. */
const CONNECT_TIMEOUT_MS = 3000;

export class MemoryNotificationStore {
  constructor() {
    this.kind = 'memory';
  }

  /** Память — рабочее множество уже в самом менеджере, персистить нечего. */
  async init() {
    return [];
  }

  async list() {
    return [];
  }

  async persistNotification() {}

  async removeById() {}

  async destroy() {}
}

export class RedisNotificationStore {
  constructor(client, logger = null) {
    this.kind = 'redis';
    this.client = client;
    this.logger = logger;
  }

  async init() {
    return this.list();
  }

  /** Восстановить все сохранённые уведомления в порядке времени. */
  async list() {
    const ids = await this.client.zrange(ORDER_KEY, 0, -1);
    if (!ids || !ids.length) return [];

    const rows = await this.client.hmget(HASH_KEY, ids);
    return rows
      .map((raw, index) => {
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw);
          return parsed && parsed.id ? parsed : null;
        } catch (error) {
          this.logger?.warn('[Notifications] Lost Redis record (invalid JSON)', {
            id: ids[index],
            error: error.message
          });
          return null;
        }
      })
      .filter(Boolean);
  }

  /** Сохранить (или перезаписать) уведомление. */
  async persistNotification(notification) {
    const fallbackTimestamp = Date.parse(notification.timestamp) || Date.now();
    await this.client.hset(HASH_KEY, notification.id, JSON.stringify(notification));
    await this.client.zadd(ORDER_KEY, fallbackTimestamp, notification.id);
  }

  async removeById(id) {
    await this.client.hdel(HASH_KEY, id);
    await this.client.zrem(ORDER_KEY, id);
  }

  async destroy() {
    try {
      await this.client.quit();
    } catch {
      // невалидное состояние соединения — просто забываем клиент
    }
  }
}

/**
 * Собирает хранилище: Redis, если он сконфигурирован и отвечает, иначе память.
 *
 * Redis используется опционально, как и Socket.IO-адаптер: без REDIS_URL или
 * при недоступном сервере уведомления не теряют функциональности, просто
 * остаются в памяти процесса.
 *
 * @param {{ logger?: object }} [deps]
 * @returns {Promise<MemoryNotificationStore|RedisNotificationStore>}
 */
export async function buildNotificationStore({ logger } = {}) {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return new MemoryNotificationStore();
  }

  let client;
  try {
    client = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      enableOfflineQueue: false,
      connectTimeout: CONNECT_TIMEOUT_MS
    });
    await client.connect();
    await client.ping();
  } catch (error) {
    logger?.warn('[Notifications] Redis недоступен, уведомления остаются в памяти', {
      error: error.message
    });
    if (client) {
      try {
        await client.quit();
      } catch {
        // клиент уже в сломанном состоянии
      }
    }
    return new MemoryNotificationStore();
  }

  logger?.info('[Notifications] Хранилище уведомлений — Redis');
  return new RedisNotificationStore(client, logger);
}