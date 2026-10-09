// src/utils/apk-installer.js
// Утилита для установки и настройки Android APK на устройстве через adb

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validatePath } from './path-validator.js';
import { createModuleLogger } from './logger.js';
import { enqueueAdbCommand, runAdb } from './adb.js';
import {
  ANDROID_PACKAGE_NAME,
  ANDROID_CONFIG_RECEIVER,
  ANDROID_CONFIGURE_ACTION,
  DEFAULT_ADB_PORT
} from '../config/android.js';
const logger = createModuleLogger('device');

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

const INSTALL_ATTEMPTS = 3;
const INSTALL_TIMEOUT_MS = 120_000;
const SHELL_TIMEOUT_MS = 15_000;
const SETTLE_MS = 5_000;
const RETRY_DELAY_MS = 1_000;

const ADB_CONNECT_FAILURE = /failed to connect|unable to connect|cannot connect|connection refused|no route to host/i;
const ADB_DEVICE_LOST = /device .*not found|device offline|no such device|connection.*(lost|closed)|closed/i;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Подключиться к устройству и убедиться, что connect реально удался. */
async function connectAdb(adbTarget) {
  const out = String(await runAdb(['connect', adbTarget], SHELL_TIMEOUT_MS) || '');
  if (ADB_CONNECT_FAILURE.test(out)) {
    throw new Error(`adb не удалось подключиться к ${adbTarget}: ${out.trim() || 'нет ответа'}`);
  }
  if (!/connected/i.test(out)) {
    throw new Error(`adb не удалось подключиться к ${adbTarget}: ${out.trim() || 'нет ответа'}`);
  }
  return out;
}

/**
 * Выполнить adb-команду, переподключаясь при обрыве сессии.
 *
 * Сразу после `install` сессия adb на этих приставках часто рвётся («device not
 * found»), поэтому следующие шаги (force-stop/broadcast/перезапуск) падали и
 * плеер оставался закрытым. Переподключаемся и повторяем шаг.
 */
async function runAdbResilient(adbTarget, args, { timeoutMs = SHELL_TIMEOUT_MS, attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await runAdb(args, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !ADB_DEVICE_LOST.test(String(error?.message || ''))) break;
      logger.warn('[APK] adb-сессия оборвалась, переподключение', {
        adbTarget,
        args,
        attempt,
        error: error.message
      });
      try {
        await connectAdb(adbTarget);
      } catch (reconnectError) {
        logger.warn('[APK] Переподключение не удалось', { adbTarget, error: reconnectError.message });
      }
      await delay(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

/**
 * Одна попытка установки. `runAdb` при ненулевом коде возвращает stderr в текст
 * ошибки, поэтому причина (`INSTALL_FAILED_...`) больше не теряется.
 */
async function installApk(adbTarget, apkPath) {
  const out = String(await runAdbResilient(
    adbTarget,
    ['-s', adbTarget, 'install', '-r', apkPath],
    { timeoutMs: INSTALL_TIMEOUT_MS, attempts: 1 }
  ) || '');
  if (!/Success/i.test(out)) {
    throw new Error(`adb install не подтвердил успех: ${out.trim() || 'пустой ответ'}`);
  }
  return out;
}

function launchPlayer(adbTarget, timeoutMs = SHELL_TIMEOUT_MS) {
  return runAdbResilient(
    adbTarget,
    ['-s', adbTarget, 'shell', 'monkey', '-p', ANDROID_PACKAGE_NAME, '-c', 'android.intent.category.LAUNCHER', '1'],
    { timeoutMs }
  );
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

  return parsed.host;
}

// Установка и настройка APK на Android-устройстве
export async function installAndSetupApk({ ip, deviceId, deviceName, apkPath, serverUrl, port }) {
  const host = normalizeHost(ip);
  const safeDeviceId = normalizeDeviceId(deviceId);
  const safeApkPath = resolveAndValidateApkPath(apkPath);
  const adbPort = String(port || '5555').trim() || '5555';

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

  const urlForBroadcast = normalizeServerUrlForXml(serverUrl);
  const adbTarget = `${host}:${adbPort}`;

  // Вся установка идёт эксклюзивно для target, в той же очереди, что и
  // adbShell (power-watch, опрос статуса). Иначе параллельный
  // `connect → dumpsys → disconnect` опроса рвёт установку на середине: adb
  // печатает «Performing Streamed Install» и сессия умирает, а плеер остаётся
  // закрытым, потому что перезапуск шёл после брошенного install.
  return enqueueAdbCommand(adbTarget, async () => {
    await connectAdb(adbTarget);

    let installError = null;
    let installed = false;

    for (let attempt = 1; attempt <= INSTALL_ATTEMPTS && !installed; attempt++) {
      try {
        await installApk(adbTarget, safeApkPath);
        installed = true;
      } catch (error) {
        installError = error;
        logger.warn('[APK] Установка не удалась, повтор', {
          adbTarget,
          attempt,
          error: error.message
        });
        try {
          await connectAdb(adbTarget);
        } catch (reconnectError) {
          logger.warn('[APK] Переподключение не удалось', { adbTarget, error: reconnectError.message });
        }
        if (attempt < INSTALL_ATTEMPTS) await delay(RETRY_DELAY_MS);
      }
    }

    try {
      if (!installed) {
        throw installError || new Error('Не удалось установить APK');
      }

      // Запуск приложения, чтобы оно создало рабочие папки
      await launchPlayer(adbTarget);
      await delay(SETTLE_MS);

      // Остановка перед отправкой настроек
      await runAdbResilient(adbTarget, ['-s', adbTarget, 'shell', 'am', 'force-stop', ANDROID_PACKAGE_NAME]);
      await delay(RETRY_DELAY_MS);

      logger.info('[APK] Sending config via broadcast', { serverUrl: urlForBroadcast, deviceId: safeDeviceId });

      // Отправка настроек через broadcast (ConfigReceiver) — явный вызов компонента
      try {
        const broadcastResult = await runAdbResilient(adbTarget, ['-s', adbTarget, 'shell', 'am', 'broadcast',
          '-n', ANDROID_CONFIG_RECEIVER,
          '-a', ANDROID_CONFIGURE_ACTION,
          '--es', 'server_url', urlForBroadcast,
          '--es', 'device_id', safeDeviceId,
          '--ez', 'show_status', 'false'
        ]);
        logger.info('[APK] Broadcast result:', { result: broadcastResult });
      } catch (broadcastErr) {
        logger.warn('[APK] Broadcast failed, app may need manual configuration', { error: broadcastErr.message });
      }
    } finally {
      // Гарантированный перезапуск плеера: раньше при сбое ADB приложение
      // оставалось закрытым до ручного вмешательства.
      try {
        await launchPlayer(adbTarget);
      } catch (launchErr) {
        logger.warn('[APK] Не удалось перезапустить плеер', { adbTarget, error: launchErr.message });
      }

      try {
        await runAdb(['disconnect', adbTarget], SHELL_TIMEOUT_MS);
      } catch (disconnectErr) {
        logger.debug('[APK] adb disconnect failed (ignored)', { error: disconnectErr.message });
      }
    }
  });
}
