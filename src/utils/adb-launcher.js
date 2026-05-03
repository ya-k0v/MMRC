import { exec } from 'node:child_process';

/**
 * Запуск Android-приложения на устройстве по IP через adb
 * @param {string} ip - IP адрес устройства
 * @param {string} packageName - package name приложения
 * @param {string} activity - activity для запуска
 * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
 */
export function launchAndroidApp(ip, packageName, activity) {
  return new Promise((resolve) => {
    // Подключение к устройству
    exec(`adb connect ${ip}:5555`, (err, stdout, stderr) => {
      if (err) {
        return resolve({ ok: false, error: `adb connect error: ${stderr || err.message}` });
      }
      // Запуск приложения
      exec(`adb -s ${ip}:5555 shell am start -n ${packageName}/${activity}`, (err2, stdout2, stderr2) => {
        if (err2) {
          return resolve({ ok: false, error: `adb shell error: ${stderr2 || err2.message}` });
        }
        resolve({ ok: true, output: stdout2 });
      });
    });
  });
}
