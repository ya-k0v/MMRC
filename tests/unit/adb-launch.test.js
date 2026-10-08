/**
 * Регрессия: запуск плеера через `sh -c 'am force-stop ... && am start ...'`.
 *
 * adb передаёт аргументы в устройство как есть, поэтому такая команда на
 * приставке превращается в `sh -c am force-stop ... && am start ...`: `sh -c`
 * берёт строкой только `am`, тот падает с usage, и `am start` никогда не
 * выполняется — 404/500 при каждом нажатии «Запустить плеер».
 *
 * Здесь проверяем, что `launchAndroidApp` выполняет force-stop и am start
 * двумя раздельными adb-командами строго по порядку.
 */
import { jest } from '@jest/globals';

const events = [];

jest.unstable_mockModule('node:child_process', () => ({
  execFile: (file, args, callback) => {
    const command = args.join(' ');
    events.push(command);
    setTimeout(() => {
      if (command.includes('force-stop') && events.includes('fail-force-stop')) {
        callback(new Error('exit code 1'), '', 'package not found');
        return;
      }
      callback(null, 'ok\n', '');
    }, 1);
  }
}));

const { launchAndroidApp } = await import('../../src/utils/adb.js');

const IP = '10.172.1.94';
const PORT = 5555;
const PACKAGE = 'com.videocontrol.mediaplayer';
const ACTIVITY = 'com.videocontrol.mediaplayer.MainActivity';

beforeEach(() => {
  events.length = 0;
});

test('force-stop выполняется до am start, двумя отдельными командами', async () => {
  const result = await launchAndroidApp(IP, PACKAGE, ACTIVITY, PORT);

  expect(result.ok).toBe(true);
  expect(events).toEqual([
    `connect ${IP}:${PORT}`,
    `-s ${IP}:${PORT} shell am force-stop ${PACKAGE}`,
    `disconnect ${IP}:${PORT}`,
    `connect ${IP}:${PORT}`,
    `-s ${IP}:${PORT} shell am start -n ${PACKAGE}/${ACTIVITY}`,
    `disconnect ${IP}:${PORT}`
  ]);
});

test('при неудачном force-stop am start не запускается и возвращается ошибка', async () => {
  events.push('fail-force-stop');

  const result = await launchAndroidApp(IP, PACKAGE, ACTIVITY, PORT);

  expect(result.ok).toBe(false);
  expect(result.error).toContain('package not found');
  expect(events.some(command => command.includes('am start'))).toBe(false);
});