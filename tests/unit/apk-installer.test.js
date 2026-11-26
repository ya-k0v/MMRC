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
let packageCheckFails = false;
let installedPackage = false;

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
      if (args.includes('list') && args.includes('packages')) {
        if (packageCheckFails) {
          callback(new Error('Command failed: adb shell pm list packages'), '', 'device offline');
          return;
        }
        callback(null, installedPackage ? 'package:com.videocontrol.mediaplayer\n' : '', '');
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
  packageCheckFails = false;
  installedPackage = false;
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

test('первичная установка: стоп, install -r, настройки broadcast и перезапуск', async () => {
  await installAndSetupApk({ ...callArgs, sendConfig: true });

  const stopIdx = events.findIndex((command) => command.includes('am force-stop'));
  const installIdx = events.findIndex(command => command.includes(' install -r '));
  const broadcastIdx = events.findIndex(command => command.includes('am broadcast'));

  expect(stopIdx).toBeGreaterThanOrEqual(0);
  expect(installIdx).toBeGreaterThan(stopIdx);
  expect(broadcastIdx).toBeGreaterThan(installIdx);
  expect(events.some(command => command.includes(' uninstall '))).toBe(false);
}, 30000);

test('кнопка «Установить» передаёт настройки, даже если плеер уже стоит', async () => {
  installedPackage = true;

  await installAndSetupApk({ ...callArgs, sendConfig: true });

  expect(events.some(command => command.includes(' install -r -d '))).toBe(true);
  expect(events.some(command => command.includes('am broadcast'))).toBe(true);
  expect(events.some(command => command.includes('--es server_url'))).toBe(true);
  expect(events.some(command => command.includes(' uninstall '))).toBe(false);
}, 30000);

test('обновление установленного плеера сохраняет настройки: -r -d, без uninstall и broadcast', async () => {
  installedPackage = true;

  await installAndSetupApk({ ...callArgs, sendConfig: false });

  expect(countInstall()).toBe(1);
  expect(events.some(command => command.includes(' install -r -d '))).toBe(true);
  expect(events.some(command => command.includes(' uninstall '))).toBe(false);
  expect(events.some(command => command.includes('am broadcast'))).toBe(false);
  // Один гарантированный запуск после обновления — данные приложения не сброшены.
  expect(countLaunch()).toBe(1);
  expect(events.some(command => command.includes('disconnect'))).toBe(true);
}, 30000);

test('при обновлении неизвестное состояние пакета не приводит к broadcast', async () => {
  packageCheckFails = true;

  await installAndSetupApk({ ...callArgs, sendConfig: false });

  expect(events.some(command => command.includes(' install -r -d '))).toBe(true);
  expect(events.some(command => command.includes('am broadcast'))).toBe(false);
  expect(events.some(command => command.includes(' uninstall '))).toBe(false);
  expect(countLaunch()).toBe(1);
}, 30000);

test('массовое обновление не шлёт broadcast даже если пакет не найден', async () => {
  // Это тот путь, который использует кнопка «Обновить плеер везде»: устройство
  // уже зарегистрировано, поэтому настройки на приставке трогать нельзя.
  await installAndSetupApk({ ...callArgs, sendConfig: false });

  // Пакет не найден — это чистая установка, поэтому -d не нужен; главное,
  // что режим обновления всё равно не отправляет broadcast с настройками.
  expect(events.some(command => / install -r(?: -d)? /.test(command))).toBe(true);
  expect(events.some(command => command.includes('am broadcast'))).toBe(false);
  expect(events.some(command => command.includes(' uninstall '))).toBe(false);
  expect(countLaunch()).toBe(1);
}, 30000);

test('обновление с сохранением настроек работает и при понижении версии', async () => {
  installedPackage = true;
  installFailures = 1;
  installStderr = 'Failure [INSTALL_FAILED_VERSION_DOWNGRADE]';

  // -d разрешает даунгрейд, поэтому сервер не снимает флаг сохранения данных
  // и не прибегает к uninstall даже после первой неудачной попытки.
  await installAndSetupApk({ ...callArgs, sendConfig: false });

  expect(countInstall()).toBe(2);
  expect(events.every(command => !command.includes(' install ') || command.includes(' -r -d '))).toBe(true);
  expect(events.some(command => command.includes(' uninstall '))).toBe(false);
  expect(events.some(command => command.includes('am broadcast'))).toBe(false);
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
