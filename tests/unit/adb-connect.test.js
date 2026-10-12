/**
 * Регрессия: `adb connect` возвращает код 0 даже при неудаче, а текст ошибки
 * печатает в stdout. Раньше это считалось успехом, и настоящая причина
 * («No route to host») подменялась поздним «device not found» от shell.
 */
import { jest } from '@jest/globals';

const events = [];
let connectOutput = '';
let shellOutput = 'ok\n';

jest.unstable_mockModule('node:child_process', () => ({
  execFile: (file, args, callback) => {
    events.push(args.join(' '));

    setTimeout(() => {
      // adb connect всегда отдаёт код 0, а результат — текстом в stdout.
      if (args[0] === 'connect') {
        callback(null, connectOutput, '');
        return;
      }
      callback(null, shellOutput, '');
    }, 1);
  }
}));

const {
  adbShell,
  wakeKey,
  getDeviceModel
} = await import('../../src/utils/adb.js');

const IP = '10.172.1.94';
const PORT = 5555;

beforeEach(() => {
  connectOutput = `connected to ${IP}:${PORT}\n`;
  shellOutput = 'ok\n';
  events.length = 0;
});

test('недоступное устройство: connect-ошибка не маскируется под «device not found»', async () => {
  connectOutput = `failed to connect to '${IP}:${PORT}': No route to host\n`;

  const result = await adbShell(IP, PORT, ['dumpsys', 'power'], 2000);

  expect(result.ok).toBe(false);
  expect(result.error).toContain('adb connect error');
  expect(result.error).toContain('No route to host');
});

test('успешный connect по-прежнему выполняет shell-команду', async () => {
  const result = await adbShell(IP, PORT, ['dumpsys', 'power'], 2000);

  expect(result.ok).toBe(true);
  expect(result.output).toContain('ok');
});

test('wakeKey c svc-шагом выполняет svc-вызов вместо keyevent', async () => {
  const result = await wakeKey(IP, PORT, 'svc:power wake', 2000);

  expect(result.ok).toBe(true);
  expect(events).toContain(`-s ${IP}:${PORT} shell svc power wake`);
});

test('wakeKey c cmd-шагом выполняет cmd-вызов вместо keyevent', async () => {
  const result = await wakeKey(IP, PORT, 'cmd:power set-screen-state on', 2000);

  expect(result.ok).toBe(true);
  expect(events).toContain(`-s ${IP}:${PORT} shell cmd power set-screen-state on`);
});

test('wakeKey с ключом по-прежнему шлёт input keyevent', async () => {
  await wakeKey(IP, PORT, 26, 2000);

  expect(events).toContain(`-s ${IP}:${PORT} shell input keyevent 26`);
});

test('getDeviceModel читает ro.product.model и тримит вывод', async () => {
  shellOutput = 'LB3235SDG2\n';
  const result = await getDeviceModel(IP, PORT, 2000);

  expect(result).toEqual({ ok: true, model: 'LB3235SDG2' });
  expect(events).toContain(`-s ${IP}:${PORT} shell getprop ro.product.model`);
});
