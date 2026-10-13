/**
 * Ступени профиля через ADB: числа — `input keyevent N`, строки с префиксом —
 * системный бинарь, а `shell:` — команда целиком одним аргументом (редиректы и
 * кавычки, которые обычное разбиение по пробелам ломало).
 */
import { jest } from '@jest/globals';

const calls = [];

jest.unstable_mockModule('node:child_process', () => ({
  execFile: (file, args, callback) => {
    calls.push({ file, args });
    callback(null, 'ok', '');
  }
}));

const { wakeKey } = await import('../../src/utils/adb.js');

afterEach(() => { calls.length = 0; });

/** Последняя shell-команда (без connect/disconnect). */
function shellArgs() {
  const shell = calls.filter(c => c.args[2] === 'shell');
  return shell[shell.length - 1].args;
}

test('числовой шаг — input keyevent', async () => {
  await wakeKey('1.2.3.4', '5555', 26, 1000);
  expect(shellArgs().slice(3)).toEqual(['input', 'keyevent', '26']);
});

test('префиксные шаги разбиваются по пробелам', async () => {
  await wakeKey('1.2.3.4', '5555', 'setprop:persist.sys.standbymode.enable 1', 1000);
  expect(shellArgs().slice(3)).toEqual(['setprop', 'persist.sys.standbymode.enable', '1']);
});

test('shell: уходит одним аргументом с сохранением кавычек и редиректа', async () => {
  const step = "shell:su 0 sh -c 'echo mmrc_keepalive > /sys/power/wake_lock'";
  await wakeKey('1.2.3.4', '5555', step, 1000);
  expect(shellArgs().slice(3)).toEqual(["su 0 sh -c 'echo mmrc_keepalive > /sys/power/wake_lock'"]);
});