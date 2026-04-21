import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAdmin } from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { installAndSetupApk } from '../utils/apk-installer.js';
import { getSettings } from '../config/settings-manager.js';
import { validatePath } from '../utils/path-validator.js';

// Для поддержки __dirname в ES-модулях
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const APK_UPLOAD_DIR = path.resolve(process.env.MMRC_APK_UPLOAD_DIR || '/tmp/mmrc-apk-upload');

if (!fs.existsSync(APK_UPLOAD_DIR)) {
  fs.mkdirSync(APK_UPLOAD_DIR, { recursive: true, mode: 0o700 });
}

const router = express.Router();

async function doFetch(url, options) {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch(url, options);
  }

  try {
    const { default: nodeFetch } = await import('node-fetch');
    return nodeFetch(url, options);
  } catch (error) {
    throw new Error(
      `HTTP client недоступен: globalThis.fetch отсутствует, а node-fetch не установлен (${error?.message || 'unknown error'})`
    );
  }
}

// Хранилище для временного сохранения APK
const upload = multer({ dest: APK_UPLOAD_DIR, limits: { fileSize: 200 * 1024 * 1024 } });

function resolveUploadedApkPath(file) {
  if (!file || typeof file.filename !== 'string') {
    return null;
  }

  const safeFileName = file.filename.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(safeFileName)) {
    throw new Error('Некорректное имя загруженного APK файла');
  }

  return validatePath(path.join(APK_UPLOAD_DIR, safeFileName), APK_UPLOAD_DIR);
}

function getInternalApiBaseUrl() {
  const configured = String(process.env.ADMIN_INTERNAL_API_URL || '').trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }

  const port = String(process.env.PORT || '3000').trim() || '3000';
  return `http://127.0.0.1:${port}`;
}

function parseApiErrorMessage(rawBody, fallback = 'Неизвестная ошибка API') {
  if (!rawBody) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // Body may be plain text.
  }

  return String(rawBody).trim() || fallback;
}

async function createDeviceViaApi({ deviceId, deviceName, incomingAuthHeader }) {
  const apiBaseUrl = getInternalApiBaseUrl();
  const apiUrl = `${apiBaseUrl}/api/devices`;
  const requestBody = JSON.stringify({ device_id: deviceId, name: deviceName });
  const requestHeaders = {
    'Content-Type': 'application/json'
  };

  if (incomingAuthHeader) {
    requestHeaders.Authorization = incomingAuthHeader;
  }

  let resp = await doFetch(apiUrl, {
    method: 'POST',
    headers: requestHeaders,
    body: requestBody
  });

  if ((resp.status === 401 || resp.status === 403) && !incomingAuthHeader) {
    const accessToken = await getAdminAccessToken(apiBaseUrl);
    resp = await doFetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: requestBody
    });
  }

  if (resp.ok) {
    return { deviceAdded: true, deviceAlreadyExists: false };
  }

  const responseText = await resp.text();
  const apiError = parseApiErrorMessage(responseText, `Ошибка API (${resp.status})`);

  if (resp.status === 409) {
    const normalized = apiError.toLowerCase();
    const alreadyExistsById =
      normalized.includes('устройство уже существует') ||
      normalized.includes('device already exists');

    if (alreadyExistsById) {
      return { deviceAdded: false, deviceAlreadyExists: true };
    }
  }

  const error = new Error(apiError);
  error.status = resp.status;
  error.apiUrl = apiUrl;
  throw error;
}

// Fallback для случаев, когда route вызван без Bearer токена.
async function getAdminAccessToken(apiBaseUrl) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const loginUrl = `${apiBaseUrl.replace(/\/$/, '')}/api/auth/login`;

  const resp = await doFetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  if (!resp.ok) {
    throw new Error('Не удалось получить admin accessToken: ' + (await resp.text()));
  }

  const data = await resp.json();
  return data.accessToken;
}

function getApkCandidates() {
  const dirsToScan = [
    PROJECT_ROOT,
    path.join(PROJECT_ROOT, 'clients/android-mediaplayer'),
    path.join(PROJECT_ROOT, 'clients/android-mediaplayer/app/build/outputs/apk/release'),
    path.join(PROJECT_ROOT, 'clients/android-mediaplayer/app/build/outputs/apk/debug')
  ];

  const explicitFiles = [
    path.join(PROJECT_ROOT, 'clients/android-mediaplayer/app-release.apk'),
    path.join(PROJECT_ROOT, 'clients/android-mediaplayer/app/build/outputs/apk/release/app-release.apk'),
    path.join(PROJECT_ROOT, 'clients/android-mediaplayer/app/build/outputs/apk/debug/app-debug.apk')
  ];

  const collected = [...explicitFiles.filter((filePath) => fs.existsSync(filePath))];

  for (const dirPath of dirsToScan) {
    try {
      if (!fs.existsSync(dirPath)) continue;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.toLowerCase().endsWith('.apk')) continue;
        collected.push(path.join(dirPath, entry.name));
      }
    } catch (error) {
      logger.debug('[Admin] Failed to scan APK directory', { dirPath, error: error.message });
    }
  }

  return Array.from(new Set(collected.map((value) => path.resolve(value))));
}

function resolveDefaultApkPath() {
  const candidates = getApkCandidates()
    .map((filePath) => {
      try {
        const stats = fs.statSync(filePath);
        return {
          filePath,
          mtimeMs: Number(stats.mtimeMs) || 0
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates.length ? candidates[0].filePath : null;
}

function parseRequestedDeviceIds(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((value) => String(value || '').trim())
      .filter(Boolean);
  }

  if (typeof rawValue !== 'string') {
    return [];
  }

  const normalized = rawValue.trim();
  if (!normalized) {
    return [];
  }

  if (normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) {
        return parsed
          .map((value) => String(value || '').trim())
          .filter(Boolean);
      }
    } catch {
      // Fallback to comma-separated parsing.
    }
  }

  return normalized
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isAndroidDeviceCandidate(device) {
  const deviceType = String(device?.deviceType || device?.device_type || '').toLowerCase();
  const platform = String(device?.platform || '').toLowerCase();

  return (
    deviceType.includes('android') ||
    deviceType.includes('native_mediaplayer') ||
    platform.includes('android')
  );
}

async function listDevicesViaApi({ incomingAuthHeader }) {
  const apiBaseUrl = getInternalApiBaseUrl();
  const apiUrl = `${apiBaseUrl}/api/devices`;
  const headers = {};

  if (incomingAuthHeader) {
    headers.Authorization = incomingAuthHeader;
  }

  let resp = await doFetch(apiUrl, {
    method: 'GET',
    headers
  });

  if ((resp.status === 401 || resp.status === 403) && !incomingAuthHeader) {
    const accessToken = await getAdminAccessToken(apiBaseUrl);
    resp = await doFetch(apiUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
  }

  if (!resp.ok) {
    const responseText = await resp.text();
    const apiError = parseApiErrorMessage(responseText, `Ошибка API (${resp.status})`);
    const error = new Error(apiError);
    error.status = resp.status;
    error.apiUrl = apiUrl;
    throw error;
  }

  const payload = await resp.json();
  return Array.isArray(payload) ? payload : [];
}

// POST /api/admin/install-apk
router.post('/install-apk', requireAdmin, upload.single('apk'), async (req, res) => {
  const ip = req.body.ip;
  const deviceId = req.body.deviceId;
  const deviceName = req.body.deviceName;

  // Получаем serverUrl из настроек
  const settings = getSettings();
  // Можно хранить serverUrl в app-settings.json или .env, либо задать явно здесь:
  // Например, если сервер работает на 80 порту и доступен по IP сервера:
  const serverUrl = settings.serverUrl || process.env.SERVER_URL || `http://${req.headers.host || '127.0.0.1:3000'}`;

  let uploadedApkPath = null;
  if (req.file) {
    try {
      uploadedApkPath = resolveUploadedApkPath(req.file);
    } catch (error) {
      logger.warn('Некорректный путь загруженного APK', { error: error.message });
      return res.status(400).json({ ok: false, error: 'Некорректный путь загруженного APK файла' });
    }
  }

  // Если файл не загружен через multipart, ищем APK в стандартных путях и build output.
  let apkPath = uploadedApkPath || resolveDefaultApkPath();

  if (!ip || !deviceId || !deviceName) {
    return res.status(400).json({ ok: false, error: 'IP, ID и имя устройства обязательны' });
  }

  if (!apkPath) {
    return res.status(400).json({
      ok: false,
      error: 'APK файл не найден. Загрузите APK вручную или соберите Android клиент (app-release.apk).'
    });
  }

  let installCompleted = false;
  try {
    // Вся логика установки и настройки APK вынесена в отдельную функцию
    await installAndSetupApk({ ip, deviceId, deviceName, apkPath, serverUrl });
    installCompleted = true;

    // После успешной настройки устройство должно быть создано так же, как при ручном добавлении через Devices.
    const incomingAuthHeader = req.get('authorization');
    const { deviceAdded, deviceAlreadyExists } = await createDeviceViaApi({
      deviceId,
      deviceName,
      incomingAuthHeader
    });

    // 6. Возвращаем успешный ответ
    // Обновляем панели
    const { default: getIO } = await import('../socket/index.js');
    const io = getIO && typeof getIO === 'function' ? getIO() : (global.io || null);
    if (io && io.emit) {
      io.emit('devices/updated');
    }
    return res.json({ ok: true, deviceAdded, deviceAlreadyExists });
  } catch (e) {
    logger.error('Ошибка при установке APK', { error: e?.message, stack: e?.stack });
    if (installCompleted) {
      const statusCode = e?.status === 409 ? 409 : 500;
      return res.status(statusCode).json({
        ok: false,
        error: `APK установлен, но устройство создать не удалось: ${e?.message || 'неизвестная ошибка'}`
      });
    }

    return res.status(500).json({ ok: false, error: e?.message || 'Ошибка при установке APK на устройство' });
  } finally {
    // Удаляем временный файл, если он был загружен
    if (uploadedApkPath && fs.existsSync(uploadedApkPath)) {
      try {
        fs.unlinkSync(uploadedApkPath);
      } catch {
        // Ignore cleanup errors for temporary uploads.
      }
    }
  }
});

// POST /api/admin/install-apk-bound
// Массовое обновление APK на Android-устройствах с привязанным IP.
router.post('/install-apk-bound', requireAdmin, upload.single('apk'), async (req, res) => {
  const settings = getSettings();
  const serverUrl = settings.serverUrl || process.env.SERVER_URL || `http://${req.headers.host || '127.0.0.1:3000'}`;

  let uploadedApkPath = null;
  if (req.file) {
    try {
      uploadedApkPath = resolveUploadedApkPath(req.file);
    } catch (error) {
      logger.warn('Некорректный путь загруженного APK для массового обновления', { error: error.message });
      return res.status(400).json({ ok: false, error: 'Некорректный путь загруженного APK файла' });
    }
  }

  const apkPath = uploadedApkPath || resolveDefaultApkPath();
  if (!apkPath) {
    return res.status(400).json({
      ok: false,
      error: 'APK файл не найден. Загрузите APK вручную или соберите Android клиент (app-release.apk).'
    });
  }

  const incomingAuthHeader = req.get('authorization');
  const requestedDeviceIds = parseRequestedDeviceIds(req.body?.deviceIds);
  const requestedDeviceIdsSet = new Set(requestedDeviceIds);

  try {
    const devices = await listDevicesViaApi({ incomingAuthHeader });
    let targets = devices
      .filter((device) => isAndroidDeviceCandidate(device))
      .filter((device) => typeof device?.ipAddress === 'string' && device.ipAddress.trim());

    if (requestedDeviceIdsSet.size > 0) {
      targets = targets.filter((device) => requestedDeviceIdsSet.has(device.device_id));
    }

    if (!targets.length) {
      return res.status(400).json({
        ok: false,
        error: 'Не найдено Android-устройств с привязанным IP адресом для обновления.'
      });
    }

    const results = [];
    let updated = 0;

    for (const target of targets) {
      const deviceId = String(target.device_id || '').trim();
      const deviceName = String(target.name || deviceId).trim() || deviceId;
      const ip = String(target.ipAddress || '').trim();

      if (!deviceId || !ip) {
        results.push({
          deviceId,
          deviceName,
          ip,
          ok: false,
          error: 'Некорректные данные устройства (deviceId/ip)'
        });
        continue;
      }

      try {
        await installAndSetupApk({ ip, deviceId, deviceName, apkPath, serverUrl });
        updated += 1;
        results.push({ deviceId, deviceName, ip, ok: true });
      } catch (error) {
        logger.error('Ошибка массового обновления APK', {
          deviceId,
          ip,
          error: error?.message,
          stack: error?.stack
        });
        results.push({
          deviceId,
          deviceName,
          ip,
          ok: false,
          error: error?.message || 'Ошибка установки APK'
        });
      }
    }

    const total = results.length;
    const failed = total - updated;

    if (updated > 0) {
      const { default: getIO } = await import('../socket/index.js');
      const io = getIO && typeof getIO === 'function' ? getIO() : (global.io || null);
      if (io && io.emit) {
        io.emit('devices/updated');
      }
    }

    const statusCode = failed > 0 ? 207 : 200;
    return res.status(statusCode).json({
      ok: failed === 0,
      total,
      updated,
      failed,
      results
    });
  } catch (error) {
    logger.error('Ошибка при подготовке массового обновления APK', {
      error: error?.message,
      stack: error?.stack
    });
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Ошибка при массовом обновлении APK'
    });
  } finally {
    if (uploadedApkPath && fs.existsSync(uploadedApkPath)) {
      try {
        fs.unlinkSync(uploadedApkPath);
      } catch {
        // Ignore cleanup errors for temporary uploads.
      }
    }
  }
});

export default router;