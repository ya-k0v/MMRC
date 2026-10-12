/**
 * Регрессия: по таймауту процесс adb обязан убиваться.
 *
 * Раньше таймаут только отклонял промис, а зависший `adb connect` продолжал
 * жить — за сутки таких процессов накапливалось больше сотни, пока контейнер
 * не упирался в лимит pid (`spawn adb EAGAIN`).
 */
import { jest } from '@jest/globals';

const child = {
  killed: false,
  kill: jest.fn(function kill() {
    child.killed = true;
  })
};

jest.unstable_mockModule('node:child_process', () => ({
  execFile: () => child
}));

const { runAdb } = await import('../../src/utils/adb.js');

test('по таймауту зависший adb убивается SIGKILL', async () => {
  await expect(runAdb(['connect', '192.168.0.201:5555'], 50)).rejects.toThrow('adb timeout');
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});
