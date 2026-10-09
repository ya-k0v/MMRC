/**
 * Регрессия: `adb connect` возвращает код 0 даже при неудаче, а текст ошибки
 * печатает в stdout. Раньше это считалось успехом, и настоящая причина
 * («No route to host») подменялась поздним «device not found» от shell.
 */
import { jest } from '@jest/globals';

const events = [];
let connectOutput = '';

jest.unstable_mockModule('node:child_process', () => ({
  execFile: (file, args, callback) => {
    events.push(args.join(' '));

    setTimeout(() => {
      // adb connect всегда отдаёт код 0, а результат — текстом в stdout.
      if (args[0] === 'connect') {
        callback(null, connectOutput, '');
        return;
      }
      callback(null, 'ok\n', '');
    }, 1);
  }
}));

const { adbShell } = await import('../../src/utils/adb.js');

const IP = '10.172.1.94';
const PORT = 5555;

beforeEach(() => {
  connectOutput = `connected to ${IP}:${PORT}\n`;
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
