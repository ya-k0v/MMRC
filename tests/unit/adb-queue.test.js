/**
 * Регрессия: параллельные adb-команды на одном устройстве.
 *
 * Транспорт делает connect → shell → disconnect на target. Раньше две команды
 * на один target выполнялись одновременно, и disconnect одной рвал сессию
 * другой: POST /api/devices/power-state опрашивал состояние питания и MAC
 * параллельно, более быстрая команда успевала отключиться, пока dumpsys ещё
 * шёл — и бейдж ATV001 показывал «нет ответа» для устройства, которое на самом
 * деле управляется.
 */
import { jest } from '@jest/globals';

const events = [];
const delays = new Map();
const daemonFailures = new Map();

jest.unstable_mockModule('node:child_process', () => ({
  execFile: (file, args, callback) => {
    const command = args.join(' ');
    events.push(command);

    const remaining = daemonFailures.get(command) || 0;
    if (remaining > 0) {
      daemonFailures.set(command, remaining - 1);
      setTimeout(() => {
        callback(new Error('exit code 1'), '', '* daemon not running; starting now at tcp:5037');
      }, 1);
      return;
    }

    const isShell = args.includes('shell');
    const fail = args.some(arg => arg === 'fail');
    const delay = isShell ? (delays.get(command) ?? 10) : 1;

    setTimeout(() => {
      if (fail) {
        callback(new Error('exit code 1'), '', 'device not found');
        return;
      }
      callback(null, 'ok\n', '');
    }, delay);
  }
}));

const { adbShell } = await import('../../src/utils/adb.js');

const IP = '10.172.1.94';
const PORT = 5555;

beforeEach(() => {
  events.length = 0;
  delays.clear();
  daemonFailures.clear();
});

test('команды на одном устройстве выполняются строго по очереди', async () => {
  delays.set(`-s ${IP}:${PORT} shell dumpsys power`, 30);

  const [state, mac] = await Promise.all([
    adbShell(IP, PORT, ['dumpsys', 'power'], 2000),
    adbShell(IP, PORT, ['ip', '-o', 'link'], 2000)
  ]);

  expect(state.ok).toBe(true);
  expect(mac.ok).toBe(true);
  expect(events).toEqual([
    `connect ${IP}:${PORT}`,
    `-s ${IP}:${PORT} shell dumpsys power`,
    `disconnect ${IP}:${PORT}`,
    `connect ${IP}:${PORT}`,
    `-s ${IP}:${PORT} shell ip -o link`,
    `disconnect ${IP}:${PORT}`
  ]);
});

test('медленная команда на одном устройстве не блокирует другое', async () => {
  const done = [];

  delays.set(`-s ${IP}:${PORT} shell dumpsys power`, 60);
  const slow = adbShell(IP, PORT, ['dumpsys', 'power'], 2000)
    .then(() => done.push('slow'));

  await new Promise(resolve => setTimeout(resolve, 5));

  const fast = adbShell('10.172.1.95', PORT, ['ip', '-o', 'link'], 2000)
    .then(() => done.push('fast'));

  await Promise.all([slow, fast]);

  expect(done).toEqual(['fast', 'slow']);
});

test('упавшая команда не роняет очередь для следующих', async () => {
  const failed = await adbShell(IP, PORT, ['fail'], 2000);
  const next = await adbShell(IP, PORT, ['dumpsys', 'power'], 2000);

  expect(failed.ok).toBe(false);
  expect(failed.error).toContain('device not found');
  expect(next.ok).toBe(true);
  expect(events).toHaveLength(6);
});

test('холодный демон adb: «daemon not running» повторяется один раз', async () => {
  daemonFailures.set(`connect ${IP}:${PORT}`, 1);

  const state = await adbShell(IP, PORT, ['dumpsys', 'power'], 2000);

  expect(state.ok).toBe(true);
  expect(events).toEqual([
    `connect ${IP}:${PORT}`,
    `connect ${IP}:${PORT}`,
    `-s ${IP}:${PORT} shell dumpsys power`,
    `disconnect ${IP}:${PORT}`
  ]);
});
