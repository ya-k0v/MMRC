// src/utils/apk-installer.js
// Утилита для установки и настройки Android APK на устройстве через adb

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { validatePath } from './path-validator.js';

const APK_UPLOAD_DIR = path.resolve(process.env.MMRC_APK_UPLOAD_DIR || '/tmp/mmrc-apk-upload');
const PROJECT_ROOT = path.resolve(process.cwd());

function commandExists(command) {
  const probe = spawnSync('bash', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
  return probe.status === 0;
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

function runAdb(args, options = {}) {
  return execFileSync('adb', args, options);
}

// Установка и настройка APK на Android-устройстве
export async function installAndSetupApk({ ip, deviceId, deviceName, apkPath, serverUrl }) {
  const host = normalizeHost(ip);
  const safeDeviceId = normalizeDeviceId(deviceId);
  const safeApkPath = resolveAndValidateApkPath(apkPath);

  if (!host || !safeDeviceId) {
    throw new Error('IP и deviceId обязательны');
  }

  if (!commandExists('adb')) {
    throw new Error('adb не установлен в системе. Установите пакет android-tools/adb и повторите попытку.');
  }

  if (!fs.existsSync(safeApkPath)) {
    throw new Error('APK файл не найден');
  }

  const apkStats = fs.statSync(safeApkPath);
  if (!apkStats.isFile()) {
    throw new Error('APK путь должен указывать на файл');
  }

  const adbTarget = `${host}:5555`;

  // Проверяем adb connect
  const out = runAdb(['connect', adbTarget], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!out.includes('connected') && !out.includes('already connected')) {
    throw new Error(`adb не удалось подключиться к ${adbTarget}: ${out}`);
  }

  // Установка APK
  runAdb(['connect', adbTarget], { stdio: 'ignore' });
  runAdb(['-s', adbTarget, 'install', '-r', safeApkPath], { stdio: 'ignore' });

  // Запуск приложения для создания папок
  runAdb(['-s', adbTarget, 'shell', 'monkey', '-p', 'com.videocontrol.mediaplayer', '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 7000));

  // Остановка приложения
  runAdb(['-s', adbTarget, 'shell', 'am', 'force-stop', 'com.videocontrol.mediaplayer'], { stdio: 'ignore' });

  // Формируем XML-файл настроек
  const safeServerUrl = String(serverUrl || '').trim();
  const urlForXml = safeServerUrl.replace(/^https?:\/\//, '');
  const xmlSettings = `<?xml version="1.0" encoding="utf-8"?>\n<map>\n    <string name="server_url">${urlForXml}</string>\n    <string name="device_id">${safeDeviceId}</string>\n    <boolean name="show_status" value="false" />\n</map>`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmrc-apk-'));
  const tmpXmlPath = path.join(tmpDir, `VCMediaPlayerSettings_${safeDeviceId}_${crypto.randomUUID()}.xml`);
  fs.writeFileSync(tmpXmlPath, xmlSettings, { mode: 0o600, flag: 'wx' });

  // Копируем XML на устройство и в shared_prefs
  const tmpDevicePath = `/data/local/tmp/VCMediaPlayerSettings_${safeDeviceId}.xml`;
  const prefsPath = `/data/data/com.videocontrol.mediaplayer/shared_prefs/VCMediaPlayerSettings.xml`;

  try {
    runAdb(['-s', adbTarget, 'push', tmpXmlPath, tmpDevicePath], { stdio: 'inherit' });
    runAdb(['-s', adbTarget, 'shell', 'run-as', 'com.videocontrol.mediaplayer', 'cp', tmpDevicePath, prefsPath], { stdio: 'inherit' });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors for temporary host files.
    }
  }

  // Снова запускаем приложение с новыми настройками
  runAdb(['-s', adbTarget, 'shell', 'monkey', '-p', 'com.videocontrol.mediaplayer', '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'ignore' });
}
