/**
 * @jest-environment jsdom
 *
 * Раздел уведомлений: постраничная загрузка и массовое закрытие.
 * Проверяем главное: очистка — один запрос, а не N POST (причина 429).
 */
import { jest } from '@jest/globals';

const adminFetch = jest.fn();
jest.unstable_mockModule('../../public/js/admin/auth.js', () => ({
  adminFetch: (...args) => adminFetch(...args)
}));

const makeNotification = (id) => ({
  id,
  type: 'test',
  severity: 'info',
  title: `Уведомление ${id}`,
  message: '',
  timestamp: new Date().toISOString(),
  acknowledged: false,
  actions: []
});

const response = (data, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => data
});

let mountNotificationsSection;
let container;
let notifications;

beforeEach(async () => {
  jest.resetModules();
  adminFetch.mockReset();
  notifications = Array.from({ length: 12 }, (_, index) => makeNotification(`n${index + 1}`));

  adminFetch.mockImplementation(async (url, init = {}) => {
    if (init.method === 'POST') {
      return response({ success: true, acknowledged: notifications.length });
    }

    const params = new URL(url, 'http://localhost').searchParams;
    const page = Number(params.get('page')) || 1;
    const pageSize = Number(params.get('pageSize')) || 10;
    const start = (page - 1) * pageSize;
    return response({
      notifications: notifications.slice(start, start + pageSize),
      count: Math.min(pageSize, Math.max(0, notifications.length - start)),
      total: notifications.length,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(notifications.length / pageSize))
    });
  });

  ({ mountNotificationsSection } = await import('../../public/js/admin/notifications-modal.js'));
  document.body.innerHTML = '<div id="section"></div>';
  container = document.getElementById('section');
});

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

test('загружает одну страницу и показывает переключатель страниц', async () => {
  mountNotificationsSection(container, null);
  await flush();

  expect(adminFetch.mock.calls[0][0]).toContain('page=1');
  expect(adminFetch.mock.calls[0][0]).toContain('pageSize=10');
  expect(container.querySelectorAll('.notification-item')).toHaveLength(10);
  expect(document.getElementById('notificationsPrevPage').disabled).toBe(true);
  expect(document.getElementById('notificationsNextPage').disabled).toBe(false);
  expect(document.querySelector('.notification-pagination__label').textContent).toContain('1 / 2');

  document.getElementById('notificationsNextPage').click();
  await flush();

  expect(adminFetch.mock.calls[1][0]).toContain('page=2');
  expect(container.querySelectorAll('.notification-item')).toHaveLength(2);
  expect(document.getElementById('notificationsPrevPage').disabled).toBe(false);
  expect(document.getElementById('notificationsNextPage').disabled).toBe(true);
});

test('очистка делает один POST и не уходит в 429', async () => {
  window.confirm = jest.fn(() => true);
  mountNotificationsSection(container, null);
  await flush();

  document.getElementById('notificationsClearAll').click();
  await flush();

  const posts = adminFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0][0]).toBe('/api/notifications/acknowledge-all');
  expect(adminFetch.mock.calls.some(([url]) => /\/api\/notifications\/n\d+\/acknowledge/.test(url))).toBe(false);
  expect(adminFetch).toHaveBeenCalledTimes(2); // GET + POST; клиент не дёргает сервер лишний раз
});

test('429 при очистке не порождает новое уведомление-отчёт', async () => {
  window.confirm = jest.fn(() => true);
  adminFetch.mockImplementation(async (url, init = {}) => {
    if (init.method === 'POST') return response({ error: 'Too many requests' }, false, 429);
    if (init.method === 'POST' && url.includes('/report')) {
      throw new Error('report endpoint must not be called');
    }
    return response({
      notifications: [makeNotification('n1')], total: 1, page: 1, pageSize: 10, totalPages: 1
    });
  });

  mountNotificationsSection(container, null);
  await flush();
  document.getElementById('notificationsClearAll').click();
  await flush();

  expect(adminFetch.mock.calls.some(([url]) => url.includes('/report'))).toBe(false);
});

test('закрытие конкретного уведомления делает один acknowledge', async () => {
  adminFetch.mockImplementation(async (url, init = {}) => {
    if (init.method === 'POST') return response({ success: true });
    return response({
      notifications: [makeNotification('n1')], total: 1, page: 1, pageSize: 10, totalPages: 1
    });
  });

  mountNotificationsSection(container, null);
  await flush();
  container.querySelector('.notification-ack-btn').click();
  await flush();

  const posts = adminFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0][0]).toBe('/api/notifications/n1/acknowledge');
});
