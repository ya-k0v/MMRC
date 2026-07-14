import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requireAuth, requireAdmin, requireCsrfToken } from '../middleware/auth.js';
import { longOperationTimeout } from '../middleware/timeout.js';
import { validate, schemas } from '../middleware/validate.js';
import { validateUploadSize } from '../middleware/multer-config.js';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('api');
import { installAndSetupApk } from '../utils/apk-installer.js';
import { getSettings, updateContentRootPath, getDevicesPath, getLogsDir } from '../config/settings-manager.js';
import { validatePath } from '../utils/path-validator.js';
import {
  closeDatabase,
  getDatabase,
  performWalCheckpoint,
  startWalCheckpointInterval,
  stopWalCheckpointInterval
} from '../database/database.js';
import { runMigrations } from '../database/migrate.js';
import { loadDevicesFromDB, loadFileNamesFromDB, saveDevicesToDB } from '../storage/devices-storage-sqlite.js';
import { updateDeviceFilesFromDB } from './files.js';
import { repairImportedFilePaths } from '../database/files-metadata.js';
import bcrypt from 'bcrypt';
import {
  resolveLatestServiceLogFilePath,
  readLastLinesFromFile,
  readLinesFromOffset,
  SERVICE_LOG_LEVELS,
  SERVICE_LOGS_DEFAULT_LINES,
  SERVICE_LOGS_MAX_LINES,
  parsePositiveInt,
  clampInt
} from '../services/service-logs.js';
import { ROOT, MAX_FILE_SIZE } from '../config/constants.js';

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
    const port = req.body.port;

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
      await installAndSetupApk({ ip, deviceId, deviceName, apkPath, serverUrl, port });
      installCompleted = true;

      const incomingAuthHeader = req.get('authorization');
      const { deviceAdded, deviceAlreadyExists } = await createDeviceViaApi({
        deviceId,
        deviceName,
        incomingAuthHeader
      });

      // Сохраняем ADB порт и IP для удалённых операций
      try {
        const { getDatabase } = await import('../database/database.js');
        const db = getDatabase();
        await db.run('UPDATE devices SET adb_port = ?, ip_address = ? WHERE device_id = ?', [port || '5555', ip, deviceId]);
      } catch (e) {
        logger.warn('[APK] Failed to save adb_port', { error: e.message });
      }

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
      const deviceAdbPort = target.adbPort || '5555';
      await installAndSetupApk({ ip, deviceId, deviceName, apkPath, serverUrl, port: deviceAdbPort });
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
        installedVersion = fs.readFileSync(installedVersionFile, 'utf-8').trim().replace(/^v/, '');
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
      const sessions = await db.query(`
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
      // First get the session to know which user it belongs to
      const session = await db.get('SELECT id, user_id FROM refresh_tokens WHERE id = ?', [req.params.id]);
      if (!session) {
        return res.status(404).json({ error: 'Сессия не найдена' });
      }
      // Delete the refresh token
      await db.run('DELETE FROM refresh_tokens WHERE id = ?', [req.params.id]);
      // Set token_valid_from to invalidate all existing access tokens for this user instantly
      await db.run('UPDATE users SET token_valid_from = CURRENT_TIMESTAMP WHERE id = ?', [session.user_id]);
      logger.info('[Admin] Session revoked', { sessionId: req.params.id, userId: session.user_id, byUser: req.user?.username });
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
        db.query(`SELECT rt.id, rt.user_id, u.username, u.full_name, u.role, rt.ip_address, rt.user_agent, rt.expires_at, rt.last_used, rt.created_at FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id ORDER BY rt.last_used DESC`)
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

// ========================================
// Inline admin endpoints (moved from server.js)
// ========================================

const SERVICE_LOG_MODULES = ['auth', 'device', 'file', 'socket', 'security', 'api', 'stream', 'system', 'db'];
const ADMIN_DB_IMPORT_DIR = path.join(ROOT, '.tmp', 'db-import');
const WAL_CHECKPOINT_INTERVAL_MS = parseInt(process.env.WAL_CHECKPOINT_INTERVAL_MS || '60000', 10);

export function createAdminEndpoints({
  updateManager,
  scheduleServiceRestart,
  scheduleRestartAfterDbImport,
  scheduleRestartAfterUpdateApply,
  DB_PATH,
  devices,
  fileNamesMap,
  io,
  manualRestartDelayMs = 1200
}) {
  const router = express.Router();

  // POST /restart-service
  router.post('/restart-service', requireAuth, requireAdmin, (req, res) => {
    const restartScheduled = scheduleServiceRestart('admin_manual_restart', manualRestartDelayMs);
    logger.warn('[Admin] Manual service restart requested', {
      user: req.user?.username || 'unknown',
      restartScheduled
    });

    return res.json({
      ok: true,
      restartScheduled,
      message: 'Перезапуск сервиса запущен. Подождите 3-10 секунд и обновите страницу.'
    });
  });

  // GET /update/status
  router.get('/update/status', requireAuth, requireAdmin, async (req, res) => {
    try {
      const fetchRemoteRaw = String(req.query.fetchRemote || req.query.fetch || '').toLowerCase();
      const fetchRemote = fetchRemoteRaw === '1' || fetchRemoteRaw === 'true' || fetchRemoteRaw === 'yes';

      const status = await updateManager.getStatus({ fetchRemote });
      const runtimeState = updateManager.getRuntimeState();

      return res.json({
        ok: true,
        status,
        runtime: {
          updating: Boolean(runtimeState.updating),
          lastCheckedAt: runtimeState.lastCheckedAt || null,
          lastUpdateStartedAt: runtimeState.lastUpdateStartedAt || null,
          lastUpdateFinishedAt: runtimeState.lastUpdateFinishedAt || null,
          lastUpdateError: runtimeState.lastUpdateError || null,
          dismissedRemoteSha: runtimeState.dismissedRemoteSha || null
        }
      });
    } catch (error) {
      logger.error('[Admin] Failed to get update status', {
        error: error?.message || String(error)
      });
      return res.status(500).json({
        ok: false,
        error: error?.message || 'Не удалось получить статус обновлений'
      });
    }
  });

  // POST /update/check
  router.post('/update/check', requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await updateManager.checkAndNotify({
        force: true,
        fetchRemote: true,
        source: 'admin_manual'
      });

      return res.json({
        ok: true,
        ...result
      });
    } catch (error) {
      logger.error('[Admin] Failed to check updates manually', {
        user: req.user?.username || 'unknown',
        error: error?.message || String(error)
      });
      return res.status(500).json({
        ok: false,
        error: error?.message || 'Проверка обновлений завершилась ошибкой'
      });
    }
  });

  // POST /update/dismiss
  router.post('/update/dismiss', requireAuth, requireAdmin, (req, res) => {
    try {
      const remoteSha = typeof req.body?.remoteSha === 'string' ? req.body.remoteSha : '';
      const dismissResult = updateManager.dismiss(remoteSha);

      logger.info('[Admin] Update notification dismissed', {
        user: req.user?.username || 'unknown',
        remoteSha: dismissResult.dismissedRemoteSha || null
      });

      return res.json({
        ok: true,
        ...dismissResult
      });
    } catch (error) {
      logger.error('[Admin] Failed to dismiss update notification', {
        error: error?.message || String(error)
      });
      return res.status(500).json({
        ok: false,
        error: error?.message || 'Не удалось отложить уведомление об обновлении'
      });
    }
  });

  // POST /update/apply
  router.post('/update/apply', requireAuth, requireAdmin, async (req, res) => {
    try {
      const requestedBy = req.user?.username || 'unknown';

      const applyResult = await updateManager.startApplyUpdate({
        requestedBy,
        scheduleRestart: () => {
          const restartScheduled = scheduleRestartAfterUpdateApply();
          logger.warn('[Admin] Restart scheduled after update apply', {
            requestedBy,
            restartScheduled
          });
          return restartScheduled;
        }
      });

      if (!applyResult.ok) {
        const statusCode = applyResult.status === 'in_progress' ? 409 : 500;
        return res.status(statusCode).json({
          ok: false,
          status: applyResult.status,
          error: applyResult.error || 'Не удалось запустить обновление'
        });
      }

      return res.status(202).json({
        ok: true,
        status: applyResult.status,
        message: applyResult.message
      });
    } catch (error) {
      logger.error('[Admin] Failed to schedule update apply', {
        user: req.user?.username || 'unknown',
        error: error?.message || String(error)
      });
      return res.status(500).json({
        ok: false,
        error: error?.message || 'Не удалось запустить обновление'
      });
    }
  });

  // GET /service-logs
  router.get('/service-logs', requireAuth, requireAdmin, (req, res) => {
    try {
      const requestedLines = clampInt(
        parsePositiveInt(req.query.lines, SERVICE_LOGS_DEFAULT_LINES),
        1,
        SERVICE_LOGS_MAX_LINES
      );
      const requestedOffset = parsePositiveInt(req.query.offset, -1);
      const requestedFileName = typeof req.query.fileName === 'string' ? req.query.fileName : '';
      const level = SERVICE_LOG_LEVELS.includes(req.query.level) ? req.query.level : 'combined';
      const moduleFilter = typeof req.query.module === 'string' ? req.query.module.trim() : '';

      const logFilePath = resolveLatestServiceLogFilePath(level, getLogsDir);
      if (!logFilePath) {
        return res.json({
          ok: true, lines: [], nextOffset: 0, fileName: null, reset: true, truncated: false,
          source: level, availableLevels: SERVICE_LOG_LEVELS, availableModules: SERVICE_LOG_MODULES
        });
      }

      const fileName = path.basename(logFilePath);

      function readAndFilter(readFn, ...args) {
        const snapshot = readFn(...args);
        let lines = snapshot.lines;
        if (moduleFilter) {
          lines = lines.filter(line => {
            try {
              const parsed = JSON.parse(line);
              return parsed.module === moduleFilter;
            } catch { return true; }
          });
        }
        return { ...snapshot, lines };
      }

      if (requestedOffset < 0) {
        const snapshot = readAndFilter(readLastLinesFromFile, logFilePath, requestedLines, getLogsDir);
        return res.json({
          ok: true, lines: snapshot.lines, nextOffset: snapshot.size,
          fileName, reset: true, truncated: snapshot.truncated,
          source: level, availableLevels: SERVICE_LOG_LEVELS, availableModules: SERVICE_LOG_MODULES
        });
      }

      const chunkProbe = readAndFilter(readLinesFromOffset, logFilePath, requestedOffset, getLogsDir);
      const fileChanged = Boolean(requestedFileName) && requestedFileName !== fileName;
      const offsetOutOfRange = requestedOffset > chunkProbe.size;

      if (fileChanged || offsetOutOfRange) {
        const snapshot = readAndFilter(readLastLinesFromFile, logFilePath, requestedLines, getLogsDir);
        return res.json({
          ok: true, lines: snapshot.lines, nextOffset: snapshot.size,
          fileName, reset: true, truncated: snapshot.truncated,
          source: level, availableLevels: SERVICE_LOG_LEVELS, availableModules: SERVICE_LOG_MODULES
        });
      }

      const chunk = chunkProbe;
      return res.json({
        ok: true, lines: chunk.lines, nextOffset: chunk.size,
        fileName, reset: chunk.reset, truncated: chunk.truncated,
        source: level, availableLevels: SERVICE_LOG_LEVELS, availableModules: SERVICE_LOG_MODULES
      });
    } catch (error) {
      logger.error('[Admin] Failed to read service logs', { error: error?.message || String(error) });
      return res.status(500).json({ ok: false, error: 'Не удалось получить логи сервиса' });
    }
  });

  // POST /import-database
  router.post('/import-database', requireAuth, requireAdmin, requireCsrfToken, validateUploadSize, async (req, res) => {
    if (process.env.DB_TYPE === 'postgres') {
      return res.status(400).json({ error: 'Import is not available in PostgreSQL mode. Use pg_restore instead.' });
    }
    try {
      const tempUploadDir = ADMIN_DB_IMPORT_DIR;
      if (!fs.existsSync(tempUploadDir)) fs.mkdirSync(tempUploadDir, { recursive: true });

      const storage = multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, tempUploadDir),
        filename: (_req, _file, cb) => cb(null, `import_${Date.now()}_${randomBytes(4).toString('hex')}.dbupload`)
      });

      const uploadSingle = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } }).single('file');

      uploadSingle(req, res, async (err) => {
        if (err) {
          logger.warn('[Admin] Import DB upload failed', { error: err.message });
          return res.status(400).json({ error: err.message || 'Upload failed' });
        }

        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });

        let uploadedPath;
        try {
            const uploadedName = String(file.filename || '');
            if (!/^[A-Za-z0-9._-]+$/.test(uploadedName)) {
              throw new Error('Invalid uploaded filename');
            }
            uploadedPath = validatePath(path.join(tempUploadDir, uploadedName), tempUploadDir);
        } catch (pathError) {
          return res.status(400).json({ error: 'Invalid uploaded file path' });
        }

        const ext = path.extname(file.originalname || '').toLowerCase();
        if (ext !== '.db') {
          try { fs.unlinkSync(uploadedPath); } catch (_) {}
          return res.status(400).json({ error: 'Unsupported file type. Expected .db' });
        }

        // Быстрая проверка сигнатуры SQLite файла
        let importDbSize = 0;
        try {
          const fd = fs.openSync(uploadedPath, 'r');
          const headerBuffer = Buffer.alloc(16);
          try {
            fs.readSync(fd, headerBuffer, 0, 16, 0);
            const stats = fs.fstatSync(fd);
            importDbSize = stats.size;
          } finally {
            fs.closeSync(fd);
          }

          const signature = headerBuffer.toString('utf8');
          if (signature !== 'SQLite format 3\u0000') {
            try { fs.unlinkSync(uploadedPath); } catch (_) {}
            return res.status(400).json({ error: 'Invalid SQLite database file' });
          }
        } catch (signatureError) {
          try { fs.unlinkSync(uploadedPath); } catch (_) {}
          return res.status(400).json({ error: signatureError.message || 'Failed to validate file' });
        }

        // Проверка версии схемы SQLite (PRAGMA user_version / schema_version)
        let uploadedSchemaVersion = null;
        let uploadedTableCount = 0;
        let uploadedMigrationIds = [];
        try {
          const { default: betterSqlite3 } = await import('better-sqlite3');
          const tmpDb = new betterSqlite3(uploadedPath, { readonly: true, fileMustExist: true });

          const schemaVersion = tmpDb.pragma('schema_version', { simple: true });
          const userVersion = tmpDb.pragma('user_version', { simple: true });
          uploadedSchemaVersion = { schemaVersion: Number(schemaVersion) || 0, userVersion: Number(userVersion) || 0 };

          const tables = tmpDb.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
          ).all();
          uploadedTableCount = tables.length;

          if (tmpDb.tableExists('schema_migrations')) {
            uploadedMigrationIds = tmpDb.prepare(
              'SELECT id FROM schema_migrations ORDER BY executed_at'
            ).all().map(r => r.id);
          }

          tmpDb.close();
        } catch (schemaErr) {
          try { fs.unlinkSync(uploadedPath); } catch (_) {}
          return res.status(400).json({ error: `Failed to read SQLite schema: ${schemaErr.message}` });
        }

        // Проверка: импортируемая БД не должна быть старше текущей (по миграциям)
        try {
          const { default: betterSqlite3 } = await import('better-sqlite3');
          if (fs.existsSync(DB_PATH)) {
            const currentDb = new betterSqlite3(DB_PATH, { readonly: true, fileMustExist: true });
            let currentMigrationIds = [];
            if (currentDb.tableExists('schema_migrations')) {
              currentMigrationIds = currentDb.prepare(
                'SELECT id FROM schema_migrations ORDER BY executed_at'
              ).all().map(r => r.id);
            }
            currentDb.close();

            // Проверяем что каждая миграция текущей БД присутствует в импортируемой
            const missingMigrations = currentMigrationIds.filter(id => !uploadedMigrationIds.includes(id));
            if (missingMigrations.length > 0) {
              try { fs.unlinkSync(uploadedPath); } catch (_) {}
              return res.status(400).json({
                error: 'Импортируемая БД содержит устаревшую схему. Отсутствуют миграции: ' + missingMigrations.join(', ')
              });
            }
          }
        } catch (schemaCheckErr) {
          // Если не можем прочитать текущую БД, пропускаем проверку (возможно первый запуск)
          logger.warn('[Admin] Could not compare schema versions', { error: schemaCheckErr.message });
        }

        // Подтверждение паролем
        const confirmPassword = String(req.body?.confirmPassword || '');
        if (!confirmPassword) {
          try { fs.unlinkSync(uploadedPath); } catch (_) {}
          return res.status(400).json({ error: 'Требуется подтверждение пароля (confirmPassword)' });
        }

        try {
          const db = getDatabase();
          const userRecord = await db.get(
            'SELECT password_hash FROM users WHERE id = ?',
            [req.user.userId]
          );

          if (!userRecord) {
            try { fs.unlinkSync(uploadedPath); } catch (_) {}
            return res.status(403).json({ error: 'Пользователь не найден' });
          }

          const passwordValid = await bcrypt.compare(confirmPassword, userRecord.password_hash);
          if (!passwordValid) {
            try { fs.unlinkSync(uploadedPath); } catch (_) {}
            return res.status(403).json({ error: 'Неверный пароль. Импорт отменён.' });
          }
        } catch (pwErr) {
          try { fs.unlinkSync(uploadedPath); } catch (_) {}
          return res.status(500).json({ error: 'Ошибка проверки пароля' });
        }

        const isDryRun = req.query.dryRun === 'true' || req.query.dry_run === 'true';

        if (isDryRun) {
          try { fs.unlinkSync(uploadedPath); } catch (_) {}
          return res.json({
            ok: true,
            dryRun: true,
            preview: {
              fileName: file.originalname,
              fileSize: importDbSize,
              schemaVersion: uploadedSchemaVersion,
              tableCount: uploadedTableCount,
              migrations: uploadedMigrationIds
            },
            message: 'Dry-run: файл прошёл все проверки, импорт не выполнялся.'
          });
        }

        const backupPath = `${DB_PATH}.bak.${Date.now()}`;
        const walPath = `${DB_PATH}-wal`;
        const shmPath = `${DB_PATH}-shm`;
        let checkpointStopped = false;
        let backupCreated = false;

        const removeWalShmFiles = () => {
          [walPath, shmPath].forEach((p) => {
            try {
              if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch (cleanupError) {
              logger.warn('[Admin] Failed to remove SQLite sidecar file', {
                file: p,
                error: cleanupError.message
              });
            }
          });
        };

        try {
          // Создаём резервную копию текущей БД если она существует
          if (fs.existsSync(DB_PATH)) {
            fs.copyFileSync(DB_PATH, backupPath);
            backupCreated = true;
            logger.info('[Admin] Database backup created', { backupPath });
          }

          // Остановим периодический checkpoint и попробуем корректно завершить БД
          try {
            stopWalCheckpointInterval();
            checkpointStopped = true;
          } catch (e) {
            logger.warn('[Admin] Failed to stop WAL checkpoint interval', { error: e.message });
          }

          try {
            performWalCheckpoint(true);
          } catch (e) {
            logger.warn('[Admin] WAL checkpoint warning', { error: e.message });
          }

          try {
            await closeDatabase();
          } catch (e) {
            logger.warn('[Admin] closeDatabase warning', { error: e.message });
          }

          // Важно: удаляем -wal/-shm перед подменой файла базы
          removeWalShmFiles();

          // Копируем загруженный файл на место основной БД
          fs.copyFileSync(uploadedPath, DB_PATH);
          logger.info('[Admin] Database file replaced', { dbPath: DB_PATH });

          // Применяем миграции на новой базе
          await runMigrations(DB_PATH);

          // КРИТИЧНО: После импорта БД из другого окружения пути к файлам
          // могут указывать на старый contentRoot. Пробуем восстановить их автоматически.
          const repairResult = await repairImportedFilePaths({ devicesPath: getDevicesPath() });
          logger.info('[Admin] Imported DB paths repair completed', {
            checked: repairResult.checked,
            repaired: repairResult.repaired,
            unresolved: repairResult.unresolved,
            skipped: repairResult.skipped,
            errors: repairResult.errors
          });

          // Перезагрузим in-memory данные (devices, fileNamesMap)
          Object.assign(devices, await loadDevicesFromDB());
          Object.assign(fileNamesMap, await loadFileNamesFromDB());
          Object.keys(devices).forEach((deviceId) => {
            updateDeviceFilesFromDB(deviceId, devices, fileNamesMap);
          });
          await saveDevicesToDB(devices);
          io.emit('devices/updated');

          const restartScheduled = scheduleRestartAfterDbImport();

          res.json({
            ok: true,
            restartScheduled,
            message: restartScheduled
              ? 'Импорт завершён. Сервис будет автоматически перезапущен.'
              : 'Импорт завершён.'
          });
          logger.info('[Admin] Database import completed', {
            user: req.user?.username || 'unknown',
            restartScheduled
          });
        } catch (error) {
          logger.error('[Admin] Database import failed', { error: error?.message || String(error) });
          // Попытка восстановления из бэкапа
          try {
            if (backupCreated && fs.existsSync(backupPath)) {
              removeWalShmFiles();
              fs.copyFileSync(backupPath, DB_PATH);
              await runMigrations(DB_PATH);
              Object.assign(devices, await loadDevicesFromDB());
              Object.assign(fileNamesMap, await loadFileNamesFromDB());
              io.emit('devices/updated');
              logger.info('[Admin] Database restored from backup after import error and state reloaded', { backupPath });
            }
          } catch (restoreErr) {
            logger.error('[Admin] Failed to restore database from backup', { error: restoreErr.message });
          }

          return res.status(500).json({ error: error.message || 'Import failed' });
        } finally {
          if (checkpointStopped) {
            try {
              startWalCheckpointInterval(WAL_CHECKPOINT_INTERVAL_MS);
            } catch (restartErr) {
              logger.warn('[Admin] Failed to restart WAL checkpoint interval', { error: restartErr.message });
            }
          }

          // Удалим временный файл
          try { if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch (_) {}
        }
      });
    } catch (outerErr) {
      logger.error('[Admin] Unexpected error in import-database route', { error: outerErr.message });
      return res.status(500).json({ error: outerErr.message || 'Unexpected error' });
    }
  });

  return router;
}

export default createAdminRouter({});
