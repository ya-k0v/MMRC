import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAdmin } from '../middleware/auth.js';
import { longOperationTimeout } from '../middleware/timeout.js';
import { validate, schemas } from '../middleware/validate.js';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('api');
import { installAndSetupApk } from '../utils/apk-installer.js';
import { getSettings, updateContentRootPath } from '../config/settings-manager.js';
import { validatePath } from '../utils/path-validator.js';
import { getDatabase } from '../database/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const APK_UPLOAD_DIR = path.resolve(
  process.env.MMRC_APK_UPLOAD_DIR || 
  path.join(PROJECT_ROOT, 'data', 'apk-uploads')
);

if (!fs.existsSync(APK_UPLOAD_DIR)) {
  fs.mkdirSync(APK_UPLOAD_DIR, { recursive: true, mode: 0o700 });
}

async function validateApkFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.apk') {
    throw new Error('Файл должен иметь расширение .apk');
  }

  const { fileTypeFromFile } = await import('file-type');
  const fileType = await fileTypeFromFile(filePath);
  
  if (!fileType) {
    throw new Error('Не удалось определить тип файла');
  }
  
  const allowedMimes = [
    'application/vnd.android.package-archive',
    'application/zip',
    'application/x-zip-compressed'
  ];
  
  if (!allowedMimes.includes(fileType.mime)) {
    throw new Error(`Недопустимый тип файла: ${fileType.mime}. Ожидается APK.`);
  }

  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries().map(e => e.entryName);
  
  if (!entries.some(e => e === 'AndroidManifest.xml')) {
    throw new Error('Неверная структура APK: отсутствует AndroidManifest.xml');
  }
  
  return true;
}

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

  const serverUrl = String(process.env.SERVER_URL || '').trim();
  if (serverUrl) {
    return serverUrl.replace(/\/$/, '');
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

export function createAdminRouter(deps = {}) {
  const {
    io = null,
    devices = {},
    fileNamesMap = {},
    storage = null,
    getDriverType = () => 'sqlite',
    getEnabledModules = async () => [],
    performWalCheckpoint = () => ({}),
    saveDevicesToDB = async () => {},
    updateDeviceFilesFromDB = () => {},
    scheduleServiceRestart = () => false
  } = deps;

  const router = express.Router();

  // POST /api/admin/install-apk
  router.post('/install-apk', longOperationTimeout(), requireAdmin, upload.single('apk'), async (req, res) => {
    const ip = req.body.ip;
    const deviceId = req.body.deviceId;
    const deviceName = req.body.deviceName;

    const settings = getSettings();
    const serverUrl = settings.serverUrl || process.env.SERVER_URL || `http://${req.headers.host || '127.0.0.1:3000'}`;

    let uploadedApkPath = null;
    if (req.file) {
      try {
        uploadedApkPath = resolveUploadedApkPath(req.file);
        await validateApkFile(uploadedApkPath);
      } catch (error) {
        logger.warn('APK validation failed', { error: error.message, filename: req.file?.originalname });
        if (uploadedApkPath && fs.existsSync(uploadedApkPath)) {
          try { fs.unlinkSync(uploadedApkPath); } catch {}
        }
        return res.status(400).json({ ok: false, error: `Невалидный APK файл: ${error.message}` });
      }
    }

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

    if (!uploadedApkPath && apkPath) {
      try {
        await validateApkFile(apkPath);
      } catch (error) {
        logger.warn('Default APK validation failed', { error: error.message, apkPath });
        return res.status(400).json({ ok: false, error: `Невалидный APK файл: ${error.message}` });
      }
    }

    let installCompleted = false;
    try {
      await installAndSetupApk({ ip, deviceId, deviceName, apkPath, serverUrl });
      installCompleted = true;

      const incomingAuthHeader = req.get('authorization');
      const { deviceAdded, deviceAlreadyExists } = await createDeviceViaApi({
        deviceId,
        deviceName,
        incomingAuthHeader
      });

      const { default: getIO } = await import('../socket/index.js');
      const socketIO = getIO && typeof getIO === 'function' ? getIO() : (io || global.io || null);
      if (socketIO && socketIO.emit) {
        socketIO.emit('devices/updated');
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
      if (uploadedApkPath && fs.existsSync(uploadedApkPath)) {
        try {
          fs.unlinkSync(uploadedApkPath);
        } catch {
        }
      }
    }
  });

  // POST /api/admin/install-apk-bound
  router.post('/install-apk-bound', longOperationTimeout(), requireAdmin, upload.single('apk'), async (req, res) => {
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
        const socketIO = getIO && typeof getIO === 'function' ? getIO() : (io || global.io || null);
        if (socketIO && socketIO.emit) {
          socketIO.emit('devices/updated');
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
        }
      }
    }
  });

  // GET /api/admin/export-database
  router.get('/export-database', requireAdmin, (req, res) => {
    if (process.env.DB_TYPE === 'postgres') {
      return res.status(400).json({ error: 'Export is not available in PostgreSQL mode. Use pg_dump instead.' });
    }
    try {
      const dbFilePath = path.join(PROJECT_ROOT, 'config', 'main.db');
      
      if (!fs.existsSync(dbFilePath)) {
        return res.status(404).json({ error: 'Database file not found' });
      }
      
      const stats = fs.statSync(dbFilePath);
      const filename = `main_${new Date().toISOString().split('T')[0]}.db`;
      
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(dbFilePath);
      fileStream.pipe(res);
      
      logger.info(`[Admin] Database exported by user: ${req.user?.username || 'unknown'}`);
    } catch (error) {
      logger.error('[Admin] Error exporting database:', error);
      res.status(500).json({ error: 'Failed to export database' });
    }
  });

  // GET /api/admin/settings
  router.get('/settings', requireAdmin, async (req, res) => {
    try {
      const settings = getSettings();
      const availableModules = (await import('../modules/index.js')).getAvailableModules();
      const enabled = await getEnabledModules();
      const enabledSet = new Set(enabled);
      settings.modules = availableModules.map(m => ({
        ...m,
        enabled: enabledSet.has(m.id)
      }));
      settings.dbType = getDriverType();
      res.json(settings);
    } catch (error) {
      logger.error('[Admin] Failed to load settings:', error);
      res.status(500).json({ error: 'Не удалось загрузить настройки' });
    }
  });

  // POST /api/admin/settings/content-root
  router.post('/settings/content-root', requireAdmin, validate(schemas.contentRoot), async (req, res) => {
    try {
      const { path: newPath } = req.body || {};
      if (!newPath) {
        return res.status(400).json({ error: 'Укажите путь' });
      }

      logger.info('[Admin] Updating content root path', { newPath });
      const normalizedPath = await updateContentRootPath(newPath);

      await new Promise(resolve => setTimeout(resolve, 100));

      logger.info('[Admin] Rescanning devices after path migration', { deviceCount: Object.keys(devices).length });
      Object.keys(devices).forEach((deviceId) => {
        updateDeviceFilesFromDB(deviceId, devices, fileNamesMap);
      });
      await saveDevicesToDB(devices);
      if (io && io.emit) {
        io.emit('devices/updated');
      }
      logger.info('[Admin] Content root path updated successfully', { newPath: normalizedPath });

      res.json({
        ok: true,
        contentRoot: normalizedPath
      });
    } catch (error) {
      logger.error('[Admin] Failed to update content root:', error);
      res.status(400).json({ error: error.message || 'Не удалось обновить путь' });
    }
  });

  // GET /api/admin/database/check-files
  router.get('/database/check-files', requireAdmin, async (req, res) => {
    try {
      const { cleanupMissingFiles } = await import('../database/files-metadata.js');
      
      const result = await cleanupMissingFiles({ deviceId: null, dryRun: true });
      
      res.json({
        checked: result.checked,
        missingOnDisk: result.missing,
        missingInDB: 0,
        errors: result.errors
      });
    } catch (error) {
      logger.error('[Admin] Failed to check files:', error);
      res.status(500).json({ error: error.message || 'Не удалось проверить файлы' });
    }
  });

  // POST /api/admin/database/wal-checkpoint
  router.post('/database/wal-checkpoint', requireAdmin, validate(schemas.walCheckpoint), (req, res) => {
    try {
      const { force } = req.body || {};
      
      logger.info('[Admin] Manual WAL checkpoint requested', { 
        forced: Boolean(force),
        userId: req.user.userId,
        username: req.user.username 
      });
      
      const result = performWalCheckpoint(Boolean(force));
      
      if (result.success) {
        res.json({
          success: true,
          message: result.message,
          walSizeMB: result.walSize,
          oldSizeMB: result.oldSize,
          reducedMB: result.reduced
        });
      } else {
        res.status(500).json({
          success: false,
          error: result.message || 'WAL checkpoint failed'
        });
      }
    } catch (error) {
      logger.error('[Admin] Failed to perform WAL checkpoint:', error);
      res.status(500).json({ error: error.message || 'Не удалось выполнить WAL checkpoint' });
    }
  });

  // POST /api/admin/database/cleanup-missing-files
  router.post('/database/cleanup-missing-files', requireAdmin, validate(schemas.cleanupMissing), async (req, res) => {
    try {
      const { deviceId } = req.body || {};
      const { cleanupMissingFiles } = await import('../database/files-metadata.js');
      
      logger.info('[Admin] Starting database cleanup', { deviceId: deviceId || 'all' });
      
      const dbResult = await cleanupMissingFiles({ deviceId: deviceId || null, dryRun: false });
      
      logger.info('[Admin] Database cleanup completed', {
        checked: dbResult.checked,
        missing: dbResult.missing,
        deleted: dbResult.deleted,
        errors: dbResult.errors
      });
      
      if (dbResult.deleted > 0) {
        const deviceIds = deviceId ? [deviceId] : Object.keys(devices);
        deviceIds.forEach((id) => {
          if (devices[id]) {
            updateDeviceFilesFromDB(id, devices, fileNamesMap);
          }
        });
        await saveDevicesToDB(devices);
        if (io && io.emit) {
          io.emit('devices/updated');
        }
      }
      
      res.json({
        checked: dbResult.checked,
        missingOnDisk: dbResult.missing,
        deletedFromDB: dbResult.deleted,
        errors: dbResult.errors
      });
    } catch (error) {
      logger.error('[Admin] Failed to cleanup files:', error);
      res.status(500).json({ error: error.message || 'Не удалось очистить файлы' });
    }
  });

  // POST /api/admin/database/cleanup-orphaned-files
  router.post('/database/cleanup-orphaned-files', requireAdmin, validate(schemas.cleanupOrphaned), async (req, res) => {
    try {
      const { dryRun = false, excludeExtensions = [] } = req.body || {};
      const { cleanupOrphanedFiles } = await import('../database/cleanup-orphaned-files.js');
      
      logger.info('[Admin] Starting orphaned files cleanup', { dryRun, excludeExtensions });
      
      const result = await cleanupOrphanedFiles({ dryRun, excludeExtensions }, storage);
      
      logger.info('[Admin] Orphaned files cleanup completed', result);
      
      res.json({
        checked: result.checked,
        orphaned: result.orphaned,
        deleted: result.deleted,
        errors: result.errors,
        totalSizeMB: result.totalSizeMB,
        dryRun
      });
    } catch (error) {
      logger.error('[Admin] Failed to cleanup orphaned files:', error);
      res.status(500).json({ error: error.message || 'Не удалось очистить осиротевшие файлы' });
    }
  });

  // GET /api/admin/apk-version — latest version from GitHub releases
  router.get('/apk-version', requireAdmin, async (req, res) => {
    try {
      // Читаем установленную версию
      const installedVersionFile = path.resolve(PROJECT_ROOT, 'clients', 'android-mediaplayer', 'version.txt');
      let installedVersion = '';
      try {
        installedVersion = fs.readFileSync(installedVersionFile, 'utf-8').trim();
      } catch {}

      const response = await fetch('https://api.github.com/repos/ya-k0v/MMRC-android-player/releases/latest', {
        headers: { 'Accept': 'application/vnd.github.v3+json' }
      });

      if (!response.ok) {
        return res.json({ available: false, error: `GitHub API ${response.status}` });
      }

      const release = await response.json();
      const tag = release.tag_name || '';
      const version = tag.replace(/^v/, '');
      const apkAsset = (release.assets || []).find(a => a.name?.endsWith('.apk'));
      const downloadUrl = apkAsset?.browser_download_url || null;
      const publishedAt = release.published_at || null;

      res.json({
        available: true,
        version,
        tag,
        downloadUrl,
        publishedAt,
        installedVersion,
        updateAvailable: installedVersion !== version,
        releaseNotes: release.body || ''
      });
    } catch (error) {
      logger.error('[Admin] Failed to fetch APK version:', error);
      res.json({ available: false, error: error.message });
    }
  });

  // POST /api/admin/apk-update — download new APK version into container
  router.post('/apk-update', requireAdmin, async (req, res) => {
    try {
      const response = await fetch('https://api.github.com/repos/ya-k0v/MMRC-android-player/releases/latest', {
        headers: { 'Accept': 'application/vnd.github.v3+json' }
      });

      if (!response.ok) {
        return res.status(500).json({ ok: false, error: `GitHub API ${response.status}` });
      }

      const release = await response.json();
      const apkAsset = (release.assets || []).find(a => a.name?.endsWith('.apk'));

      if (!apkAsset?.browser_download_url) {
        return res.status(404).json({ ok: false, error: 'APK not found in release' });
      }

      const apkDir = path.resolve(PROJECT_ROOT, 'clients', 'android-mediaplayer');
      if (!fs.existsSync(apkDir)) {
        fs.mkdirSync(apkDir, { recursive: true });
      }

      const apkPath = path.join(apkDir, 'app-release.apk');
      const apkResponse = await fetch(apkAsset.browser_download_url);

      if (!apkResponse.ok) {
        return res.status(500).json({ ok: false, error: `Download failed: ${apkResponse.status}` });
      }

      const buffer = Buffer.from(await apkResponse.arrayBuffer());
      fs.writeFileSync(apkPath, buffer);

      // Сохраняем установленную версию
      const versionFile = path.join(apkDir, 'version.txt');
      fs.writeFileSync(versionFile, release.tag_name || '');

      logger.info('[Admin] APK updated', { version: release.tag_name, size: buffer.length });

      res.json({
        ok: true,
        version: release.tag_name,
        size: buffer.length,
        path: apkPath
      });
    } catch (error) {
      logger.error('[Admin] APK update failed:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // GET /api/admin/network — сетевые интерфейсы
  router.get('/network', requireAdmin, async (req, res) => {
    try {
      const os = await import('node:os');
      const interfaces = os.networkInterfaces();
      const result = Object.entries(interfaces).map(([name, addrs]) => ({
        name,
        addresses: (addrs || []).map(a => ({
          family: a.family,
          address: a.address,
          netmask: a.netmask,
          mac: a.mac === '00:00:00:00:00:00' ? null : a.mac,
          internal: a.internal,
          cidr: a.cidr
        })).filter(a => !a.internal && (a.family === 'IPv4' || a.family === 'IPv6'))
      })).filter(iface => iface.addresses.length > 0);
      res.json(result);
    } catch (error) {
      logger.error('[Admin] Failed to get network info:', error);
      res.status(500).json({ error: 'Не удалось получить информацию о сети' });
    }
  });

  // GET /api/admin/sessions — активные сессии пользователей
  router.get('/sessions', requireAdmin, async (req, res) => {
    try {
      const db = getDatabase();
      const sessions = await db.all(`
        SELECT rt.id, rt.user_id, u.username, u.full_name, u.role,
               rt.ip_address, rt.user_agent, rt.expires_at, rt.last_used, rt.created_at
        FROM refresh_tokens rt
        JOIN users u ON rt.user_id = u.id
        ORDER BY rt.last_used DESC
      `);
      res.json(sessions);
    } catch (error) {
      logger.error('[Admin] Failed to get sessions:', error);
      res.status(500).json({ error: 'Не удалось загрузить сессии' });
    }
  });

  // DELETE /api/admin/sessions/:id — отозвать сессию
  router.delete('/sessions/:id', requireAdmin, async (req, res) => {
    try {
      const db = getDatabase();
      const result = await db.run('DELETE FROM refresh_tokens WHERE id = ?', [req.params.id]);
      if (result.changes === 0) {
        return res.status(404).json({ error: 'Сессия не найдена' });
      }
      logger.info('[Admin] Session revoked', { sessionId: req.params.id, byUser: req.user?.username });
      res.json({ ok: true });
    } catch (error) {
      logger.error('[Admin] Failed to delete session:', error);
      res.status(500).json({ error: 'Не удалось удалить сессию' });
    }
  });

  // GET /api/admin/health/services — проверка сервисов
  router.get('/health/services', requireAdmin, async (req, res) => {
    try {
      const { execSync } = await import('node:child_process');
      const os = await import('node:os');
      const checks = {};

      const runCheck = (name, cmd) => {
        try {
          const out = execSync(cmd, { timeout: 5000, encoding: 'utf-8' }).toString().trim();
          checks[name] = { status: 'ok', version: out.split('\n')[0] };
        } catch {
          checks[name] = { status: 'error', version: null };
        }
      };

      runCheck('ffmpeg', 'ffmpeg -version 2>&1 | head -1');
      runCheck('ffprobe', 'ffprobe -version 2>&1 | head -1');
      runCheck('git', 'git --version 2>&1');
      runCheck('openssl', 'openssl version 2>&1');

      checks.node = { status: 'ok', version: process.version };
      checks.platform = { status: 'ok', os: os.platform(), arch: os.arch() };
      checks.processUptime = Math.floor(process.uptime());
      checks.systemUptime = Math.floor(os.uptime());
      checks.docker = process.env.MMRC_DOCKER === '1' ? { status: 'ok' } : { status: 'disabled' };

      res.json(checks);
    } catch (error) {
      logger.error('[Admin] Failed to check services:', error);
      res.status(500).json({ error: 'Не удалось проверить сервисы' });
    }
  });

  // GET /api/admin/docker — информация о Docker
  router.get('/docker', requireAdmin, async (req, res) => {
    try {
      const { APP_VERSION, APP_BRANCH, DOCKER_TAG, DOCKER_IMAGES } = await import('../config/constants.js');
      res.json({
        enabled: process.env.MMRC_DOCKER === '1',
        composeDir: process.env.MMRC_COMPOSE_DIR || null,
        mainImage: process.env.DOCKER_IMAGE || null,
        mainTag: process.env.DOCKER_IMAGE_TAG || DOCKER_TAG || null,
        converterImage: process.env.CONVERTER_IMAGE || null,
        ffmpegImage: process.env.FFMPEG_IMAGE || null,
        streamerImage: process.env.STREAMER_IMAGE || null,
        streamerEnabled: process.env.MMRC_STREAMER_ENABLED === 'true',
        version: APP_VERSION,
        branch: APP_BRANCH,
        images: DOCKER_IMAGES || {}
      });
    } catch (error) {
      logger.error('[Admin] Failed to get docker info:', error);
      res.status(500).json({ error: 'Не удалось загрузить информацию о Docker' });
    }
  });

  // GET /api/admin/settings/extended — все данные для страницы настроек одним запросом
  router.get('/settings/extended', requireAdmin, async (req, res) => {
    try {
      const os = await import('node:os');
      const { exec } = await import('node:child_process');
      const db = getDatabase();
      const { APP_VERSION, APP_BRANCH, DOCKER_TAG, DOCKER_IMAGES } = await import('../config/constants.js');

      // Parallel: settings + sessions + service checks
      const [settings, sessions] = await Promise.all([
        Promise.resolve(getSettings()).then(async s => {
          const mod = await import('../modules/index.js');
          const availableModules = mod.getAvailableModules();
          const enabled = await mod.getEnabledModules();
          const enabledSet = new Set(enabled);
          s.modules = availableModules.map(m => ({ ...m, enabled: enabledSet.has(m.id) }));
          const { getDriverType } = await import('../database/database.js');
          s.dbType = getDriverType();
          return s;
        }),
        db.all(`SELECT rt.id, rt.user_id, u.username, u.full_name, u.role, rt.ip_address, rt.user_agent, rt.expires_at, rt.last_used, rt.created_at FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id ORDER BY rt.last_used DESC`)
      ]);

      // Network
      const interfaces = os.networkInterfaces();
      const network = Object.entries(interfaces).map(([name, addrs]) => ({
        name,
        addresses: (addrs || []).map(a => ({
          family: a.family, address: a.address, netmask: a.netmask,
          mac: a.mac === '00:00:00:00:00:00' ? null : a.mac,
          internal: a.internal, cidr: a.cidr
        })).filter(a => !a.internal && (a.family === 'IPv4' || a.family === 'IPv6'))
      })).filter(iface => iface.addresses.length > 0);

      // Docker
      const docker = {
        enabled: process.env.MMRC_DOCKER === '1',
        composeDir: process.env.MMRC_COMPOSE_DIR || null,
        mainImage: process.env.DOCKER_IMAGE || null,
        mainTag: process.env.DOCKER_IMAGE_TAG || DOCKER_TAG || null,
        converterImage: process.env.CONVERTER_IMAGE || null,
        ffmpegImage: process.env.FFMPEG_IMAGE || null,
        streamerImage: process.env.STREAMER_IMAGE || null,
        streamerEnabled: process.env.MMRC_STREAMER_ENABLED === 'true',
        version: APP_VERSION,
        branch: APP_BRANCH,
        images: DOCKER_IMAGES || {}
      };

      // Service checks (parallel with individual timeouts)
      const runCheck = (cmd) => new Promise(resolve => {
        exec(cmd, { timeout: 5000 }, (err, stdout) => {
          if (err) return resolve({ status: 'error', version: null });
          const v = String(stdout).trim().split('\n')[0];
          resolve({ status: 'ok', version: v });
        });
      });
      const [ffmpegRes, ffprobeRes, gitRes, opensslRes] = await Promise.all([
        runCheck('ffmpeg -version 2>&1 | head -1'),
        runCheck('ffprobe -version 2>&1 | head -1'),
        runCheck('git --version 2>&1'),
        runCheck('openssl version 2>&1')
      ]);
      const services = {
        ffmpeg: ffmpegRes, ffprobe: ffprobeRes, git: gitRes, openssl: opensslRes,
        node: { status: 'ok', version: process.version },
        platform: { os: os.platform(), arch: os.arch() },
        processUptime: Math.floor(process.uptime()),
        systemUptime: Math.floor(os.uptime()),
        docker: process.env.MMRC_DOCKER === '1' ? { status: 'ok' } : { status: 'disabled' }
      };

      res.json({ settings, network, docker, services, sessions });
    } catch (error) {
      logger.error('[Admin] Failed to get extended settings:', error);
      res.status(500).json({ error: 'Не удалось загрузить расширенные настройки' });
    }
  });

  return router;
}

export default createAdminRouter({});
