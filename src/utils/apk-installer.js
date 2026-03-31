// src/utils/apk-installer.js
// Утилита для установки и настройки Android APK на устройстве через adb

import fs from 'fs';
import path from 'path';

// Установка и настройка APK на Android-устройстве
export async function installAndSetupApk({ ip, deviceId, deviceName, apkPath, serverUrl }) {
  const { execSync } = await import('child_process');
  // Проверка доступности IP и порта 5555
  execSync(`nc -z -w 2 ${ip} 5555`);
  // Проверяем adb connect
  const connectCmd = `adb connect ${ip}:5555`;
  const out = execSync(connectCmd, { encoding: 'utf-8', stdio: 'pipe' });
  if (!out.includes('connected') && !out.includes('already connected')) {
    throw new Error(`adb не удалось подключиться к ${ip}:5555: ${out}`);
  }
  // Установка APK
  execSync(connectCmd, { stdio: 'ignore' });
  execSync(`adb -s ${ip}:5555 install -r ${apkPath}`, { stdio: 'ignore' });
  // Запуск приложения для создания папок
  execSync(`adb -s ${ip}:5555 shell monkey -p com.videocontrol.mediaplayer -c android.intent.category.LAUNCHER 1`, { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 7000));
  // Остановка приложения
  execSync(`adb -s ${ip}:5555 shell am force-stop com.videocontrol.mediaplayer`, { stdio: 'ignore' });
  // Формируем XML-файл настроек
  const urlForXml = serverUrl.replace(/^https?:\/\//, '');
  const xmlSettings = `<?xml version="1.0" encoding="utf-8"?>\n<map>\n    <string name="server_url">${urlForXml}</string>\n    <string name="device_id">${deviceId}</string>\n    <boolean name="show_status" value="false" />\n</map>`;
  const tmpXmlPath = `/tmp/VCMediaPlayerSettings_${deviceId}.xml`;
  fs.writeFileSync(tmpXmlPath, xmlSettings);
  // Копируем XML на устройство и в shared_prefs
  const tmpDevicePath = `/data/local/tmp/VCMediaPlayerSettings_${deviceId}.xml`;
  const prefsPath = `/data/data/com.videocontrol.mediaplayer/shared_prefs/VCMediaPlayerSettings.xml`;
  execSync(`adb -s ${ip}:5555 push ${tmpXmlPath} ${tmpDevicePath}`, { stdio: 'inherit' });
  execSync(`adb -s ${ip}:5555 shell run-as com.videocontrol.mediaplayer cp ${tmpDevicePath} ${prefsPath}`, { stdio: 'inherit' });
  // Снова запускаем приложение с новыми настройками
  execSync(`adb -s ${ip}:5555 shell monkey -p com.videocontrol.mediaplayer -c android.intent.category.LAUNCHER 1`, { stdio: 'ignore' });
}
