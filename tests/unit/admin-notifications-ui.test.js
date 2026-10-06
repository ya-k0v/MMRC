/**
 * @jest-environment jsdom
 */
import { jest } from '@jest/globals';

const mockAdminFetch = jest.fn();

jest.unstable_mockModule('../../public/js/admin/auth.js', () => ({
  adminFetch: (...args) => mockAdminFetch(...args),
  logout: jest.fn()
}));

jest.unstable_mockModule('../../public/js/admin/notifications-modal.js', () => ({
  mountNotificationsSection: jest.fn()
}));

const { createSidebar } = await import('../../public/js/admin/sidebar.js');
const { initNotifications } = await import('../../public/js/admin/notifications.js');

const USER = { username: 'admin', full_name: 'Ломаев Яков Викторович', role: 'admin' };

function fakeSocket() {
  const handlers = {};
  return {
    on: (event, fn) => { handlers[event] = fn; },
    emit: jest.fn(),
    __handlers: handlers
  };
}

function sidebarItem() {
  return document.querySelector('#adminSidebar .sidebar-item[data-section="notifications"]');
}

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '';
  mockAdminFetch.mockResolvedValue({ ok: true, json: async () => ({ count: 0 }) });
});

describe('пункт «Уведомления» в левом баре', () => {
  it('строится в сайдбаре с подписью, иконкой и местом под счётчик', async () => {
    const sidebar = createSidebar({ adminFetch: mockAdminFetch, user: USER, onNavigate: jest.fn() });
    await sidebar.init();

    const item = sidebarItem();
    expect(item).not.toBeNull();
    expect(item.querySelector('.sidebar-item-label').textContent).toBe('Уведомления');
    expect(item.querySelector('.sidebar-item-icon svg')).not.toBeNull();
    expect(item.querySelector('#notificationsBadge')).not.toBeNull();
  });

  it('переходит в раздел, а не открывает модальное окно', async () => {
    const sidebar = createSidebar({ adminFetch: mockAdminFetch, user: USER, onNavigate: jest.fn() });
    await sidebar.init();

    // От модальных окон отказались: пункт уведомлений стал обычным
    // разделом навигации, как «Устройства» или «Пользователи».
    sidebarItem().onclick({ preventDefault: () => {} });

    expect(sidebar.getActiveSection()).toBe('notifications');
    expect(document.querySelector('#adminSidebar .sidebar-item[data-section="notifications"]').classList.contains('active')).toBe(true);
  });

  it('клик по всплывающему уведомлению открывает раздел', async () => {
    const sidebar = createSidebar({ adminFetch: mockAdminFetch, user: USER, onNavigate: jest.fn() });
    await sidebar.init();

    const socket = fakeSocket();
    initNotifications(socket);

    // Прилетает событие — появляется toast
    socket.__handlers['notification']({
      notification: {
        id: 'n1',
        title: 'Ошибка',
        message: 'Что-то пошло не так',
        severity: 'error',
        createdAt: '2026-10-06T00:00:00.000Z'
      },
      unreadCount: 1
    });

    const toast = document.querySelector('.notification-toast');
    expect(toast).not.toBeNull();

    // Клик по toast ведёт в тот же раздел, что и пункт сайдбара
    toast.onclick({ target: toast.querySelector('div') });

    expect(sidebar.getActiveSection()).toBe('notifications');

    // Сбрасываем счётчик: unreadCount живёт в модуле и утекает в следующие тесты
    socket.__handlers['notification:acknowledged']({ unreadCount: 0 });
  });

  it('mmrc:navigate игнорирует несуществующий раздел', async () => {
    const sidebar = createSidebar({ adminFetch: mockAdminFetch, user: USER, onNavigate: jest.fn() });
    await sidebar.init();

    document.dispatchEvent(new CustomEvent('mmrc:navigate', { detail: { section: 'nope' } }));

    expect(sidebar.getActiveSection()).toBe('devices');
  });

  it('показывает счётчик и очищает его, когда непрочитанных нет', async () => {
    const sidebar = createSidebar({ adminFetch: mockAdminFetch, user: USER, onNavigate: jest.fn() });
    await sidebar.init();

    const socket = fakeSocket();
    initNotifications(socket);

    const badge = sidebarItem().querySelector('#notificationsBadge');
    expect(badge.textContent).toBe('');
    expect(sidebarItem().classList.contains('has-badge')).toBe(false);

    socket.__handlers['notification']({ notification: { id: 1 }, action: 'created', unreadCount: 7 });
    expect(badge.textContent).toBe('7');
    expect(sidebarItem().classList.contains('has-badge')).toBe(true);

    socket.__handlers['notification:acknowledged']({ unreadCount: 0 });
    expect(sidebarItem().classList.contains('has-badge')).toBe(false);
  });

  it('ограничивает счётчик значением 99+', async () => {
    const sidebar = createSidebar({ adminFetch: mockAdminFetch, user: USER, onNavigate: jest.fn() });
    await sidebar.init();

    const socket = fakeSocket();
    initNotifications(socket);

    socket.__handlers['notifications:initial']({ notifications: [], unreadCount: 250 });
    expect(sidebarItem().querySelector('#notificationsBadge').textContent).toBe('99+');
  });

  it('подхватывает счётчик, если уведомления инициализировались раньше сайдбара', async () => {
    // Реальный порядок в приложении: initNotifications вызывается до того,
    // как сайдбар смонтирован, поэтому поиск пункта должен повторяться.
    const socket = fakeSocket();
    mockAdminFetch.mockResolvedValue({ ok: true, json: async () => ({ count: 4 }) });
    initNotifications(socket);

    expect(sidebarItem()).toBeNull();

    const sidebar = createSidebar({ adminFetch: mockAdminFetch, user: USER, onNavigate: jest.fn() });
    await sidebar.init();

    const badge = sidebarItem().querySelector('#notificationsBadge');
    expect(badge).not.toBeNull();
    expect(sidebarItem().classList.contains('has-badge')).toBe(true);
  });

  it('не считает уведомления разделом при перерисовке сайдбара', async () => {
    const sidebar = createSidebar({ adminFetch: mockAdminFetch, user: USER, onNavigate: jest.fn() });
    await sidebar.init();

    const socket = fakeSocket();
    initNotifications(socket);
    socket.__handlers['notification']({ notification: { id: 1 }, action: 'created', unreadCount: 3 });

    // render() пересобирает innerHTML — счётчик обязан восстановиться.
    await sidebar.init();

    expect(sidebar.getActiveSection()).toBe('devices');
    expect(sidebarItem().classList.contains('has-badge')).toBe(true);
  });
});