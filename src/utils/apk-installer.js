// src/utils/apk-installer.js
// Утилита для установки и настройки Android APK на устройстве через adb

import fs from 'fs';
import net from 'net';
import { execFileSync, spawnSync } from 'child_process';

function commandExists(command) {
  const probe = spawnSync('bash', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
  return probe.status === 0;
}

async function ensureTcpPortOpen(host, port, timeoutMs = 2000) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const socket = new net.Socket();

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish());
    socket.once('timeout', () => finish(new Error(`Порт ${port} на ${host} не отвечает (таймаут ${timeoutMs}мс)`)));
    socket.once('error', (error) => finish(new Error(`Не удалось подключиться к ${host}:${port}: ${error.message}`)));
    socket.connect(port, host);
  });
}

function runAdb(args, options = {}) {
  return execFileSync('adb', args, options);
}

// Установка и настройка APK на Android-устройстве
export async function installAndSetupApk({ ip, deviceId, deviceName, apkPath, serverUrl }) {
  const host = String(ip || '').trim();
  const safeDeviceId = String(deviceId || '').trim();

  if (!host || !safeDeviceId) {
    throw new Error('IP и deviceId обязательны');
  }

  if (!commandExists('adb')) {
    throw new Error('adb не установлен в системе. Установите пакет android-tools/adb и повторите попытку.');
  }

  if (!apkPath || !fs.existsSync(apkPath)) {
    throw new Error('APK файл не найден');
  }

  const adbTarget = `${host}:5555`;

  // Проверка доступности устройства по TCP без зависимости от nc.
  await ensureTcpPortOpen(host, 5555, 2000);

  // Проверяем adb connect
  const out = runAdb(['connect', adbTarget], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!out.includes('connected') && !out.includes('already connected')) {
    throw new Error(`adb не удалось подключиться к ${adbTarget}: ${out}`);
  }

  // Установка APK
  runAdb(['connect', adbTarget], { stdio: 'ignore' });
  runAdb(['-s', adbTarget, 'install', '-r', apkPath], { stdio: 'ignore' });

  // Запуск приложения для создания папок
  runAdb(['-s', adbTarget, 'shell', 'monkey', '-p', 'com.videocontrol.mediaplayer', '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 7000));

  // Остановка приложения
  runAdb(['-s', adbTarget, 'shell', 'am', 'force-stop', 'com.videocontrol.mediaplayer'], { stdio: 'ignore' });

  // Формируем XML-файл настроек
  const safeServerUrl = String(serverUrl || '').trim();
  const urlForXml = safeServerUrl.replace(/^https?:\/\//, '');
  const xmlSettings = `<?xml version="1.0" encoding="utf-8"?>\n<map>\n    <string name="server_url">${urlForXml}</string>\n    <string name="device_id">${safeDeviceId}</string>\n    <boolean name="show_status" value="false" />\n</map>`;
  const tmpXmlPath = `/tmp/VCMediaPlayerSettings_${safeDeviceId}.xml`;
  fs.writeFileSync(tmpXmlPath, xmlSettings);

  // Копируем XML на устройство и в shared_prefs
  const tmpDevicePath = `/data/local/tmp/VCMediaPlayerSettings_${safeDeviceId}.xml`;
  const prefsPath = `/data/data/com.videocontrol.mediaplayer/shared_prefs/VCMediaPlayerSettings.xml`;

  try {
    runAdb(['-s', adbTarget, 'push', tmpXmlPath, tmpDevicePath], { stdio: 'inherit' });
    runAdb(['-s', adbTarget, 'shell', 'run-as', 'com.videocontrol.mediaplayer', 'cp', tmpDevicePath, prefsPath], { stdio: 'inherit' });
  } finally {
    if (fs.existsSync(tmpXmlPath)) {
      try {
        fs.unlinkSync(tmpXmlPath);
      } catch {
        // Ignore cleanup errors for temporary host file.
      }
    }
  }

  // Снова запускаем приложение с новыми настройками
  runAdb(['-s', adbTarget, 'shell', 'monkey', '-p', 'com.videocontrol.mediaplayer', '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'ignore' });
}
