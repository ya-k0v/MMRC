/**
 * Регрессия массового обновления APK.
 *
 * Симптом: «Готово: 0 обновлено, 1 ошибок», плеер на приставке закрыт.
 * Причина — install шёл вне очереди adb.js: параллельный опрос питания
 * (power-watch делает `connect → dumpsys → disconnect` на тот же target) рвал
 * сессию установки, а перезапуск приложения выполнялся только после успешного
 * install. Плюс stderr `adb install` глушился (`stdio: 'ignore'`), поэтому
 * реальная причина не попадала в лог.
 *
 * Здесь проверяем: повторы install, причину из stderr, гарантированный
 * перезапуск плеера и закрытие сессии даже при постоянной ошибке.
 */
import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const events = [];
let installFailures = 0;
let installStderr = '';
let connectFails = false;

jest.unstable_mockModule('node:child_process', () => ({
  execFile: (file, args, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    const command = `${file} ${args.join(' ')}`;
    events.push(command);
    setTimeout(() => {
      if (file === 'bash') {
        callback(null, '/usr/bin/adb\n', '');
        return;
      }
      if (args[0] === 'connect') {
        if (connectFails) {
          callback(null, `failed to connect to ${args[1]}: No route to host\n`, '');
          return;
        }
        callback(null, `connected to ${args[1]}\n`, '');
        return;
      }
      if (args.includes('install')) {
        if (installFailures > 0) {
          installFailures -= 1;
          callback(new Error('Command failed: adb install'), '', installStderr || 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]');
          return;
        }
        callback(null, 'Performing Streamed Install\nSuccess\n', '');
        return;
      }
      callback(null, 'ok\n', '');
    }, 1);
  }
}));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmrc-apk-'));
process.env.MMRC_APK_UPLOAD_DIR = tmpDir;
const apkPath = path.join(tmpDir, 'app-release.apk');
fs.writeFileSync(apkPath, 'fake apk');

const { installAndSetupApk } = await import('../../src/utils/apk-installer.js');

const callArgs = {
  ip: '10.172.1.94',
  deviceId: 'ATV001',
  deviceName: 'ATV001',
  apkPath,
  serverUrl: 'http://10.172.0.30:3000',
  port: 5555
};

beforeEach(() => {
  events.length = 0;
  installFailures = 0;
  installStderr = '';
  connectFails = false;
});

const countInstall = () => events.filter(command => command.includes(' install ')).length;
const countLaunch = () => events.filter(command => command.includes('monkey')).length;
const lastIndex = (needle) => events.reduce((acc, command, index) => (command.includes(needle) ? index : acc), -1);

test('успешная установка: install, настройка и перезапуск плеера', async () => {
  await installAndSetupApk(callArgs);

  expect(countInstall()).toBe(1);
  const installIdx = lastIndex(' install ');
  const broadcastIdx = lastIndex('am broadcast');
  expect(broadcastIdx).toBeGreaterThan(installIdx);
  // финальный перезапуск идёт после настройки, а сессия закрывается
  expect(countLaunch()).toBeGreaterThanOrEqual(2);
  expect(lastIndex('monkey')).toBeGreaterThan(broadcastIdx);
  expect(events.some(command => command.includes('disconnect'))).toBe(true);
}, 30000);

test('повторяет install при сбое и в итоге ставит APK', async () => {
  installFailures = 2;
  installStderr = 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]';

  await installAndSetupApk(callArgs);

  expect(countInstall()).toBe(3);
}, 30000);

test('при постоянной ошибке бросает причину из stderr, но перезапускает плеер и отключается', async () => {
  installFailures = 99;
  installStderr = 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]';

  await expect(installAndSetupApk(callArgs)).rejects.toThrow(/INSTALL_FAILED_INSUFFICIENT_STORAGE/);

  expect(countInstall()).toBe(3);
  expect(countLaunch()).toBeGreaterThanOrEqual(1);
  expect(events.some(command => command.includes('disconnect'))).toBe(true);
}, 30000);

test('ошибка подключения не приводит к установке', async () => {
  connectFails = true;

  await expect(installAndSetupApk(callArgs)).rejects.toThrow(/adb не удалось подключиться/);
  expect(countInstall()).toBe(0);
}, 30000);
