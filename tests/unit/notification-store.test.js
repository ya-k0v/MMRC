/**
 * Хранилище уведомлений: Redis, когда он задан и отвечает; память — когда
 * REDIS_URL нет или Redis недоступен. Redis-клиент имитируем, чтобы тест не
 * зависел от реального сервера.
 */
import { jest } from '@jest/globals';

/** Глобальные флаги для поддельного Redis (читаются в конструкторе). */
let pingShouldFail = false;
const instances = [];

jest.unstable_mockModule('ioredis', () => ({
  Redis: class MockRedis {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.hash = {};
      this.zset = {};
      this.quitted = false;
      instances.push(this);
    }

    async connect() {}

    async ping() {
      if (pingShouldFail) return Promise.reject(new Error('DOWN'));
      return 'PONG';
    }

    async hset(key, field, value) {
      this.hash[key] = this.hash[key] || {};
      this.hash[key][field] = value;
      return 1;
    }

    async hmget(key, ids) {
      const hash = this.hash[key] || {};
      return ids.map((id) => (id in hash ? hash[id] : null));
    }

    async hdel(key, ...ids) {
      const hash = this.hash[key];
      if (!hash) return 0;
      let removed = 0;
      for (const id of ids) {
        if (id in hash) {
          delete hash[id];
          removed += 1;
        }
      }
      return removed;
    }

    async zadd(key, score, member) {
      this.zset[key] = this.zset[key] || [];
      this.zset[key] = this.zset[key].filter((x) => x.member !== member);
      this.zset[key].push({ member, score: Number(score) });
      this.zset[key].sort((a, b) => a.score - b.score);
      return 1;
    }

    async zrange(key, start, stop) {
      const rows = this.zset[key] || [];
      if (stop === -1) {
        return rows.slice(start).map((x) => x.member);
      }
      return rows.slice(start, stop + 1).map((x) => x.member);
    }

    async zrem(key, member) {
      const rows = this.zset[key] || [];
      const index = rows.findIndex((x) => x.member === member);
      if (index >= 0) {
        rows.splice(index, 1);
        return 1;
      }
      return 0;
    }

    async quit() {
      this.quitted = true;
      return 'OK';
    }
  }
}));

const { buildNotificationStore } = await import('../../src/utils/notification-store.js');

const notify = (id, ts) => ({
  id,
  type: 'test',
  severity: 'info',
  title: id,
  message: id,
  timestamp: ts,
  acknowledged: false
});

afterEach(() => {
  pingShouldFail = false;
  delete process.env.REDIS_URL;
  instances.length = 0;
});

describe('buildNotificationStore', () => {
  test('без REDIS_URL возвращает память', async () => {
    delete process.env.REDIS_URL;
    const store = await buildNotificationStore();
    expect(store.kind).toBe('memory');
    await expect(store.list()).resolves.toEqual([]);
  });

  test('Redis недоступен — graceful fallback в память', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    pingShouldFail = true;

    const store = await buildNotificationStore();
    expect(store.kind).toBe('memory');
    // оборвавшийся клиент закрыт, инстансов больше не держим
    expect(instances.some((i) => i.quitted)).toBe(true);
  });

  test('Redis отвечает — хранилище сохраняет и упорядочивает', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';

    const store = await buildNotificationStore();
    expect(store.kind).toBe('redis');

    await store.persistNotification(notify('a', '2026-01-01T00:00:00.000Z'));
    await store.persistNotification(notify('b', '2026-01-03T00:00:00.000Z'));
    await store.persistNotification(notify('c', '2026-01-02T00:00:00.000Z'));

    const list = await store.list();
    // порядок по времени: старые первыми
    expect(list.map((n) => n.id)).toEqual(['a', 'c', 'b']);
  });

  test('обновление по id перезаписывает тело, а не дублирует', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';

    const store = await buildNotificationStore();
    await store.persistNotification(notify('x', '2026-01-01T00:00:00.000Z'));
    await store.persistNotification({
      ...notify('x', '2026-01-01T00:00:00.000Z'),
      acknowledged: true,
      title: 'новый заголовок'
    });

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].acknowledged).toBe(true);
    expect(list[0].title).toBe('новый заголовок');
  });

  test('removeById убирает и из хэша, и из порядка', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';

    const store = await buildNotificationStore();
    await store.persistNotification(notify('a', '2026-01-01T00:00:00.000Z'));
    await store.persistNotification(notify('b', '2026-01-02T00:00:00.000Z'));

    await store.removeById('a');
    const list = await store.list();
    expect(list.map((n) => n.id)).toEqual(['b']);
  });

  test('destroy закрывает клиент', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';

    const store = await buildNotificationStore();
    const client = instances[instances.length - 1];
    await store.destroy();
    expect(client.quitted).toBe(true);
  });
});