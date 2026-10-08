/**
 * NotificationsManager поверх хранилища: восстановление на старте,
 * фоновая запись при каждом изменении и вытеснение сверх лимита.
 * Хранилище подменяем фейком — Redis-ветка покрыта отдельно в
 * notification-store.test.js.
 */
import { jest } from '@jest/globals';

const { NotificationsManager } = await import('../../src/utils/notifications.js');

/** Фейковое хранилище: запоминает персист/удаления, отдаёт засеянные данные. */
class FakeStore {
  constructor(seed = []) {
    this.kind = 'fake';
    this.seed = seed;
    this.persisted = [];
    this.forgotten = [];
  }

  async list() {
    return this.seed;
  }

  async persistNotification(notification) {
    this.persisted.push(notification);
  }

  async removeById(id) {
    this.forgotten.push(id);
  }
}

const makeNotify = (id, over = {}) => ({
  id,
  type: 'test',
  severity: 'info',
  title: `Title ${id}`,
  message: `Message ${id}`,
  timestamp: `2026-01-0${1}T00:00:00.000Z`,
  acknowledged: false,
  ...over
});

beforeEach(() => {
  delete process.env.REDIS_URL;
});

describe('NotificationsManager с хранилищем', () => {
  test('add персистит уведомление', async () => {
    const manager = new NotificationsManager();
    const store = new FakeStore();
    await manager.init(store);

    manager.add('test', 'info', 'Заголовок', 'Сообщение', {}, { key: 'job-1' });

    expect(store.persisted).toHaveLength(1);
    expect(store.persisted[0].key).toBe('job-1');
    expect(manager.getByKey('job-1')).not.toBeNull();
  });

  test('init восстанавливает сохранённые уведомления и пересобирает ключи', async () => {
    const manager = new NotificationsManager();
    const timestamp = new Date().toISOString();
    const store = new FakeStore([
      makeNotify('n1', { key: 'k1', timestamp, acknowledged: false }),
      makeNotify('n2', { key: 'k2', timestamp, acknowledged: true }),
      makeNotify('n3', { key: 'k3', timestamp, acknowledged: false })
    ]);
    await manager.init(store);

    expect(manager.getAll()).toHaveLength(3);
    expect(manager.getActive()).toHaveLength(2); // n2 прочитано
    expect(manager.getUnreadCount()).toBe(2);
    expect(manager.getByKey('k1').id).toBe('n1');
    expect(manager.getStorageMode()).toBe('fake');

    // upsert по восстановленному ключу перезаписывает, а не плодит дубли
    const id = manager.upsert({
      key: 'k1',
      severity: 'warning',
      title: 'Обновлённый'
    });
    expect(id).toBe('n1');
    expect(manager.getById('n1').title).toBe('Обновлённый');
  });

  test('acknowledge перезаписывает уведомление в хранилище', async () => {
    const manager = new NotificationsManager();
    const store = new FakeStore();
    await manager.init(store);

    const id = manager.add('test', 'info', 'T', 'M', {});
    store.persisted.length = 0;

    expect(manager.acknowledge(id)).toBe(true);
    expect(store.persisted).toHaveLength(1);
    expect(store.persisted[0].id).toBe(id);
    expect(store.persisted[0].acknowledged).toBe(true);
  });

  test('remove и removeByKey забывают уведомление в хранилище', async () => {
    const manager = new NotificationsManager();
    const store = new FakeStore();
    await manager.init(store);

    const id1 = manager.add('test', 'info', 'T1', 'M1', {}, { key: 'del-1' });
    const id2 = manager.add('test', 'info', 'T2', 'M2', {}, { key: 'del-2' });

    expect(manager.remove(id1)).toBe(true);
    expect(manager.removeByKey('del-2')).toBe(true);
    expect(store.forgotten).toEqual([id1, id2]);
  });

  test('вытеснение сверх лимита удаляет самое старое и из хранилища', async () => {
    const manager = new NotificationsManager();
    manager.maxNotifications = 3;
    const store = new FakeStore([
      makeNotify('s1', { timestamp: '2025-01-01T00:00:00.000Z' }),
      makeNotify('s2', { timestamp: '2025-01-02T00:00:00.000Z' }),
      makeNotify('s3', { timestamp: '2025-01-03T00:00:00.000Z' })
    ]);
    await manager.init(store);

    // Новое уведомление всегда свежее засеянных (те даты в прошлом),
    // значит вытесняется самое старое — s1.
    manager.add('test', 'info', 'T4', 'M4', {});

    expect(manager.getAll()).toHaveLength(3);
    expect(manager.getById('s1')).toBeNull();
    expect(store.forgotten).toContain('s1');
  });

  test('падение записи в хранилище не роняет менеджер', async () => {
    const manager = new NotificationsManager();
    const store = new FakeStore();
    store.persistNotification = jest.fn(async () => {
      throw new Error('redis down');
    });
    store.removeById = jest.fn(async () => {
      throw new Error('redis down');
    });
    await manager.init(store);

    const id = manager.add('test', 'info', 'T', 'M', {});
    expect(manager.getById(id)).not.toBeNull();
    expect(manager.remove(id)).toBe(true);
  });
});