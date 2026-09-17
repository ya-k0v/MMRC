import { execFile } from 'node:child_process';
import { ANDROID_PACKAGE_NAME, ANDROID_MAIN_ACTIVITY, DEFAULT_ADB_PORT } from '../config/android.js';

/**
 * Запуск Android-приложения на устройстве по IP через adb
 * @param {string} ip - IP адрес устройства
 * @param {string} [packageName] - package name приложения (по умолчанию из конфига)
 * @param {string} [activity] - activity для запуска (по умолчанию из конфига)
 * @param {string|number} [port] - adb-порт устройства
 * @param {number} [timeoutMs] - таймаут операций adb в мс
 * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
 */
export function launchAndroidApp(ip, packageName = ANDROID_PACKAGE_NAME, activity = ANDROID_MAIN_ACTIVITY, port = DEFAULT_ADB_PORT, timeoutMs = 15000) {
  const target = `${ip}:${port}`;

  const runAdb = (args) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`adb timeout: ${args.join(' ')}`)), timeoutMs);
    execFile('adb', args, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout || '');
    });
  });

  return (async () => {
    try {
      await runAdb(['connect', target]);
    } catch (e) {
      return { ok: false, error: `adb connect error: ${e.message}` };
    }

    try {
      const output = await runAdb(['-s', target, 'shell', 'am', 'start', '-n', `${packageName}/${activity}`]);
      return { ok: true, output };
    } catch (e) {
      return { ok: false, error: `adb shell error: ${e.message}` };
    } finally {
      try {
        await runAdb(['disconnect', target]);
      } catch (_) {
        // не критично
      }
    }
  })();
}