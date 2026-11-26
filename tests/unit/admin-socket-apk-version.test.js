/**
 * @jest-environment jsdom
 *
 * Смена версии APK приходит с сервера: админка должна подхватить событие
 * и пересчитать список устройств без перезапуска страницы.
 */
import { jest } from '@jest/globals';

const { setupSocketListeners } = await import('../../public/js/admin/socket-listeners.js');

function fakeSocket() {
  const handlers = new Map();
  return {
    on: (event, fn) => { handlers.set(event, fn); },
    emitServer: (event, payload) => handlers.get(event)?.(payload),
    has: (event) => handlers.has(event)
  };
}

test('socket-listeners передаёт событие apk-version/selected в колбэк', () => {
  const socket = fakeSocket();
  const onApkVersionSelected = jest.fn();

  setupSocketListeners(socket, { onApkVersionSelected });

  expect(socket.has('apk-version/selected')).toBe(true);
  socket.emitServer('apk-version/selected', { version: '3.4.2', selectedVersion: '3.4.2' });
  expect(onApkVersionSelected).toHaveBeenCalledWith({ version: '3.4.2', selectedVersion: '3.4.2' });
});

test('отсутствие колбэка не ломает обработчик события', () => {
  const socket = fakeSocket();

  setupSocketListeners(socket, {});
  expect(() => socket.emitServer('apk-version/selected', { version: '3.4.2' })).not.toThrow();
});
