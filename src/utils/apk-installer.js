// src/utils/apk-installer.js
// Утилита для установки и настройки Android APK на устройстве через adb

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validatePath } from './path-validator.js';

const execFileAsync = promisify(execFile);
const APK_UPLOAD_DIR = path.resolve(process.env.MMRC_APK_UPLOAD_DIR || '/tmp/mmrc-apk-upload');
const PROJECT_ROOT = path.resolve(process.cwd());

async function commandExists(command) {
  try {
    await execFileAsync('bash', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function normalizeDeviceId(deviceId) {
  const value = String(deviceId || '').trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error('Некорректный deviceId');
  }
  return value;
}

function normalizeHost(ip) {
  const value = String(ip || '').trim();
  if (net.isIP(value) !== 4) {
    throw new Error('IP должен быть валидным IPv4 адресом');
  }
  if (value === '0.0.0.0' || value === '255.255.255.255') {
    throw new Error('IP адрес недопустим');
  }
  return value;
}

function resolveAndValidateApkPath(apkPath) {
  const inputPath = String(apkPath || '').trim();
  if (!inputPath || inputPath.includes('\0')) {
    throw new Error('Некорректный путь к APK');
  }

  const resolved = path.resolve(inputPath);
  if (!resolved.toLowerCase().endsWith('.apk')) {
    throw new Error('Некорректный тип файла APK');
  }

  const allowedRoots = [PROJECT_ROOT, APK_UPLOAD_DIR];
  const isAllowed = allowedRoots.some((baseDir) => {
    try {
      validatePath(resolved, baseDir);
      return true;
    } catch {
      return false;
    }
  });

  if (!isAllowed) {
    throw new Error('Путь к APK находится вне разрешенных директорий');
  }

  return resolved;
}

async function runAdb(args, options = {}) {
  return execFileAsync('adb', args, { ...options, encoding: 'utf-8' });
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeServerUrlForXml(serverUrl) {
  const rawValue = String(serverUrl || '').trim();
  if (!rawValue) {
    throw new Error('serverUrl обязателен');
  }

  const withScheme = /^https?:\/\//i.test(rawValue) ? rawValue : `http://${rawValue}`;
  let parsed;

  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error('Некорректный serverUrl');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Допустим только http/https serverUrl');
  }

  const host = parsed.host;
  if (!host || host.length > 255) {
    throw new Error('Некорректный host в serverUrl');
  }

  return host;
}

// Установка и настройка APK на Android-устройстве
export async function installAndSetupApk({ ip, deviceId, deviceName, apkPath, serverUrl }) {
  const host = normalizeHost(ip);
  const safeDeviceId = normalizeDeviceId(deviceId);
  const safeApkPath = resolveAndValidateApkPath(apkPath);

  if (!host || !safeDeviceId) {
    throw new Error('IP и deviceId обязательны');
  }

  if (!await commandExists('adb')) {
    throw new Error('adb не установлен в системе. Установите пакет android-tools/adb и повторите попытку.');
  }

  try {
    const apkStats = await fs.promises.stat(safeApkPath);
    if (!apkStats.isFile()) {
      throw new Error('APK путь должен указывать на файл');
    }
  } catch {
    throw new Error('APK файл не найден');
  }

  const adbTarget = `${host}:5555`;

  // Проверяем adb connect
  const out = await runAdb(['connect', adbTarget], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (!out.includes('connected') && !out.includes('already connected')) {
    throw new Error(`adb не удалось подключиться к ${adbTarget}: ${out}`);
  }

  // Установка APK
  await runAdb(['connect', adbTarget], { stdio: 'ignore' });
  await runAdb(['-s', adbTarget, 'install', '-r', safeApkPath], { stdio: 'ignore' });

  // Запуск приложения для создания папок
  await runAdb(['-s', adbTarget, 'shell', 'monkey', '-p', 'com.videocontrol.mediaplayer', '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 7000));

  // Остановка приложения
  await runAdb(['-s', adbTarget, 'shell', 'am', 'force-stop', 'com.videocontrol.mediaplayer'], { stdio: 'ignore' });

  // Формируем XML-файл настроек
  const urlForXml = normalizeServerUrlForXml(serverUrl);
  const xmlSettings = `<?xml version="1.0" encoding="utf-8"?>\n<map>\n    <string name="server_url">${escapeXml(urlForXml)}</string>\n    <string name="device_id">${escapeXml(safeDeviceId)}</string>\n    <boolean name="show_status" value="false" />\n</map>`;

  // Копируем XML на устройство и в shared_prefs
  const tmpDevicePath = '/data/local/tmp/VCMediaPlayerSettings.xml';
  const prefsPath = `/data/data/com.videocontrol.mediaplayer/shared_prefs/VCMediaPlayerSettings.xml`;

  // Передаем XML напрямую через stdin в файл на устройстве, не создавая временный файл на сервере.
  await runAdb(['-s', adbTarget, 'shell', 'sh', '-c', `cat > ${tmpDevicePath}`], {
    input: xmlSettings,
    stdio: ['pipe', 'ignore', 'pipe']
  });
  await runAdb(['-s', adbTarget, 'shell', 'run-as', 'com.videocontrol.mediaplayer', 'cp', tmpDevicePath, prefsPath], { stdio: 'inherit' });
  await runAdb(['-s', adbTarget, 'shell', 'rm', '-f', tmpDevicePath], { stdio: 'ignore' });

  // Снова запускаем приложение с новыми настройками
  await runAdb(['-s', adbTarget, 'shell', 'monkey', '-p', 'com.videocontrol.mediaplayer', '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'ignore' });
}
