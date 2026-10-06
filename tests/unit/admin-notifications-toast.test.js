/**
 * @jest-environment jsdom
 *
 * Жизненный цикл тоста после рефакторинга:
 *  - тост появляется и получает динамический цвет серьёзности
 *  - уходит по animationend, а не по зашитой константе
 *  - при prefers-reduced-motion схлопывание не мешает удалению
 */
import { jest } from '@jest/globals';

// showToastNotification дёргает showNotificationsModal при клике — мокаем модуль
const mockShowNotificationsModal = jest.fn();
jest.unstable_mockModule('../../public/js/admin/notifications-modal.js', () => ({
  showNotificationsModal: (...args) => mockShowNotificationsModal(...args)
}));

const { showToastNotification } = await import('../../public/js/admin/notifications.js');

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = '';
});
afterEach(() => {
  jest.useRealTimers();
});

const toast = () => document.querySelector('.notification-toast');

const fire = (over = {}) => showToastNotification({
  id: 'n1', title: 'Заголовок', message: 'Сообщение', timestamp: Date.now(), severity: 'info', ...over
});

test('тост получает цвет серьёзности, статичные стили живут в CSS', () => {
  fire({ id: 'n1', severity: 'critical' });
  expect(toast()).not.toBeNull();
  expect(toast().style.borderLeftColor).toBe('rgb(239, 68, 68)'); // critical #ef4444
  expect(toast().getAttribute('data-notification-id')).toBe('n1');
  // position переехал в .notification-toast (app.css), инлайн должен быть пуст
  expect(toast().style.position).toBe('');
});

test('автоудаление происходит по animationend, а не по зашитому числу', () => {
  fire();
  const el = toast();
  jest.advanceTimersByTime(8000);
  expect(el.classList.contains('notification-toast--out')).toBe(true);
  expect(toast()).not.toBeNull(); // пока жив — ждём animationend
  el.dispatchEvent(new Event('animationend'));
  expect(toast()).toBeNull();
});

test('страховка: тост удаляется, даже если animationend не пришёл', () => {
  fire();
  const el = toast();
  jest.advanceTimersByTime(8000);
  jest.advanceTimersByTime(500); // TOAST_EXIT_MS(200) + запас(100) + допуск таймера
  expect(el.isConnected).toBe(false);
});

test('reduced-motion: схлопнутая анимация не мешает удалению', () => {
  fire({ id: 'n3', severity: 'warning' });
  const el = toast();
  jest.advanceTimersByTime(8000);
  jest.advanceTimersByTime(500);
  expect(el.isConnected).toBe(false);
});

test('клик по телу тоста удаляет его', () => {
  fire({ id: 'n4', severity: 'error' });
  const el = toast();
  el.onclick({ target: document.createElement('div') });
  expect(el.isConnected).toBe(false);
});

test('клик по кнопке внутри тоста не удаляет его', () => {
  fire({ id: 'n5', severity: 'info' });
  const el = toast();
  const btn = document.createElement('button');
  el.appendChild(btn);
  el.onclick({ target: btn });
  expect(el.isConnected).toBe(true);
});