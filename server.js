// Загружаем переменные окружения из .env файла
import 'dotenv/config';

import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'node:crypto';

// Импорты из модулей
import { 
  ROOT, PUBLIC, MAX_FILE_SIZE, ALLOWED_EXT, PORT, HOST
} from './src/config/constants.js';
import { createSocketServer } from './src/config/socket-config.js';
import { 
  closeDatabase, 
  getDatabase, 
  getAllDeviceVolumeStates, 
  saveDeviceVolumeState,
  startWalCheckpointInterval,
  stopWalCheckpointInterval,
  performWalCheckpoint
} from './src/database/database.js';
import { runMigrations } from './src/database/migrate.js';
import { 
  loadDevicesFromDB, 
  saveDevicesToDB, 
  loadFileNamesFromDB, 
  saveFileNamesToDB
} from './src/storage/devices-storage-sqlite.js';
import { cleanupMissingFiles, repairImportedFilePaths } from './src/database/files-metadata.js';
import { getFileStatus } from './src/video/file-status.js';
import { checkVideoParameters } from './src/video/ffmpeg-wrapper.js';
import { autoOptimizeVideo } from './src/video/optimizer.js';
import { 
  findFileFolder, getPageSlideCount, autoConvertFile 
} from './src/converters/document-converter.js';
import { initStreamManager } from './src/streams/stream-manager.js';
import { createDevicesRouter } from './src/routes/devices.js';
import { createPlaceholderRouter } from './src/routes/placeholder.js';
import { createFilesRouter, updateDeviceFilesFromDB } from './src/routes/files.js';
import { createVideoInfoRouter } from './src/routes/video-info.js';
import { createConversionRouter } from './src/routes/conversion.js';
import { createSystemInfoRouter } from './src/routes/system-info.js';
import { createFoldersRouter } from './src/routes/folders.js';
import { createAuthRouter } from './src/routes/auth.js';
import { createDeduplicationRouter } from './src/routes/deduplication.js';
import { createHeroRouter } from './src/hero/index.js';
import { createVolumeRouter } from './src/routes/volume.js';
import fileResolverRouter from './src/routes/file-resolver.js';
import { createNotificationsRouter } from './src/routes/notifications.js';
import multer from 'multer';
import { createUploadMiddleware, validateUploadSize } from './src/middleware/multer-config.js';
import { requireAuth, requireAdmin, requireHeroAdmin, requireSpeaker } from './src/middleware/auth.js';
import { globalLimiter, apiSpeedLimiter } from './src/middleware/rate-limit.js';
import { setupExpressMiddleware, setupStaticFiles } from './src/middleware/express-config.js';
import { setupSocketHandlers } from './src/socket/index.js';
import { setupNotificationsHandler } from './src/socket/notifications-handler.js';
import { notifyCriticalError } from './src/utils/notifications.js';
import { initSystemMonitor, stopSystemMonitor } from './src/utils/system-monitor.js';
import logger, { httpLoggerMiddleware } from './src/utils/logger.js';
import { cleanupResolutionCache, getResolutionCacheSize } from './src/video/resolution-cache.js';
import { circuitBreakers } from './src/utils/circuit-breaker.js';
import { getSettings, updateContentRootPath, getDataRoot, getDevicesPath, getStreamsOutputDir, getConvertedCache, getLogsDir, getTempDir } from './src/config/settings-manager.js';
import { validatePath } from './src/utils/path-validator.js';
import { getMetrics } from './src/utils/metrics.js';
import { timerRegistry } from './src/utils/timer-registry.js';
import { createUpdateManager } from './src/utils/update-manager.js';
import adminRouter from './src/routes/admin.js';

const app = express();
const server = http.createServer(app);
const io = createSocketServer(server);

// КРИТИЧНО: Создаем папки данных используя пути из настроек БД
// Все пути теперь вычисляются динамически из contentRoot в config/app-settings.json
// contentRoot - это корневая директория данных (например: /mnt/videocontrol-data/)
// Поддиректории создаются автоматически: content/, streams/, converted/, logs/, temp/
const dataRoot = getDataRoot();
const devicesDir = getDevicesPath();
const streamsDir = getStreamsOutputDir();
const convertedDir = getConvertedCache();
const logsDir = getLogsDir();
const tempDir = getTempDir();

if (!fs.existsSync(dataRoot)) fs.mkdirSync(dataRoot, { recursive: true });
if (!fs.existsSync(devicesDir)) fs.mkdirSync(devicesDir, { recursive: true });
if (!fs.existsSync(streamsDir)) fs.mkdirSync(streamsDir, { recursive: true });
if (!fs.existsSync(convertedDir)) fs.mkdirSync(convertedDir, { recursive: true });
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// Логируем используемые директории данных
logger.info(`[Config] 📁 Data root (contentRoot): ${dataRoot}`);
logger.info(`[Config] 📁 Devices (content): ${devicesDir}`);
logger.info(`[Config] 📁 Streams: ${streamsDir}`);
logger.info(`[Config] 📁 Converted: ${convertedDir}`);
logger.info(`[Config] 📁 Logs: ${logsDir}`);
logger.info(`[Config] 📁 Temp: ${tempDir}`);

// ========================================
// EXPRESS MIDDLEWARE
// ========================================
// (Модули: src/middleware/express-config.js, src/middleware/multer-config.js)

setupExpressMiddleware(app);
setupStaticFiles(app);

// HTTP Request Logging (Winston)
app.use(httpLoggerMiddleware);

// Rate limiting для всех API запросов
app.use('/api/', globalLimiter);
app.use('/api/', apiSpeedLimiter);

// ========================================
// DATABASE INITIALIZATION
// ========================================
const DB_PATH = path.join(ROOT, 'config', 'main.db');
try {
  // Run migrations / ensure schema before continuing startup
  runMigrations(DB_PATH);
} catch (err) {
  logger.error('[Server] Database migration failed, aborting startup', { error: err?.message || String(err) });
  throw err;
}

// Запускаем периодический WAL checkpoint для стабильности БД
// Проверяет размер WAL файла каждую минуту и выполняет checkpoint если > 100MB
const WAL_CHECKPOINT_INTERVAL_MS = parseInt(process.env.WAL_CHECKPOINT_INTERVAL_MS || '60000', 10); // 60 секунд по умолчанию
startWalCheckpointInterval(WAL_CHECKPOINT_INTERVAL_MS);
logger.info('[Server] WAL checkpoint interval started', {
  intervalMs: WAL_CHECKPOINT_INTERVAL_MS,
  intervalMinutes: WAL_CHECKPOINT_INTERVAL_MS / 60000,
  thresholdMB: process.env.WAL_CHECKPOINT_THRESHOLD_MB || '100'
});

// КРИТИЧНО: Завершаем инициализацию настроек с миграцией путей после инициализации БД
import('./src/config/settings-manager.js').then(module => {
  module.initializeSettings().catch(err => {
    logger.warn('[Server] Failed to complete settings initialization', { error: err.message, stack: err.stack });
  });
});

// Инициализация данных
let devices = {};
let fileNamesMap = {};
const deviceVolumeState = {};

// Загружаем данные из SQLite БД
devices = loadDevicesFromDB();
fileNamesMap = loadFileNamesFromDB();

const streamManager = initStreamManager({
  outputRoot: getStreamsOutputDir(), // Используем функцию из settings-manager
  publicBasePath: '/streams'
});
// КРИТИЧНО: НЕ запускаем FFmpeg для всех стримов при старте
// FFmpeg будет запускаться только когда стрим действительно используется (lazy loading)
// Это экономит ресурсы сервера, так как не все стримы используются одновременно
// const streamingEntries = getAllStreamingMetadata();
// syncStreamJobs(streamingEntries);

// Загружаем состояние громкости устройств
const persistedVolumeState = getAllDeviceVolumeStates();
for (const [deviceId, state] of Object.entries(persistedVolumeState)) {
  deviceVolumeState[deviceId] = {
    level: typeof state.level === 'number' ? state.level : 50,
    muted: Boolean(state.muted),
    updatedAt: state.updatedAt || null
  };
}

for (const deviceId of Object.keys(devices)) {
  if (!deviceVolumeState[deviceId]) {
    const now = new Date().toISOString();
    deviceVolumeState[deviceId] = { level: 50, muted: false, updatedAt: now };
    saveDeviceVolumeState(deviceId, { volumeLevel: 50, isMuted: false });
  }
}

const VOLUME_MIN = 0;
const VOLUME_MAX = 100;
const VOLUME_STEP = 5;

function normalizeVolumeLevel(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  const clamped = Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, Math.round(value)));
  const stepped = Math.round(clamped / VOLUME_STEP) * VOLUME_STEP;
  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, stepped));
}

function ensureVolumeState(deviceId) {
  if (!deviceVolumeState[deviceId]) {
    const now = new Date().toISOString();
    deviceVolumeState[deviceId] = { level: 50, muted: false, updatedAt: now };
    saveDeviceVolumeState(deviceId, { volumeLevel: 50, isMuted: false });
  }
  return deviceVolumeState[deviceId];
}

function getVolumeState(deviceId) {
  const current = ensureVolumeState(deviceId);
  return { ...current };
}

function persistVolumeState(deviceId, nextState = {}, options = {}) {
  const current = ensureVolumeState(deviceId);
  const normalizedLevel =
    typeof nextState.level === 'number'
      ? normalizeVolumeLevel(nextState.level)
      : current.level;
  const normalizedMuted =
    typeof nextState.muted === 'boolean' ? nextState.muted : current.muted;
  
  if (
    normalizedLevel === current.level &&
    normalizedMuted === current.muted &&
    !options.force
  ) {
    return current;
  }
  
  const updatedAt = new Date().toISOString();
  deviceVolumeState[deviceId] = {
    level: normalizedLevel,
    muted: normalizedMuted,
    updatedAt
  };
  
  saveDeviceVolumeState(deviceId, {
    volumeLevel: normalizedLevel,
    isMuted: normalizedMuted
  });
  
  if (options.broadcast !== false) {
    io.emit('devices/volume/state', {
      device_id: deviceId,
      level: normalizedLevel,
      muted: normalizedMuted,
      updated_at: updatedAt,
      source: options.source || 'server'
    });
  }
  
  return deviceVolumeState[deviceId];
}

function emitVolumeCommand(deviceId, state, reason = 'control') {
  io.to(`device:${deviceId}`).emit('player/volume', {
    level: state.level,
    muted: state.muted,
    reason
  });
}

function applyVolumeCommand(deviceId, params = {}, meta = {}) {
  if (!devices[deviceId]) {
    throw new Error('device not found');
  }
  
  const current = ensureVolumeState(deviceId);
  let nextLevel = current.level;
  
  if (typeof params.level === 'number' && !Number.isNaN(params.level)) {
    const normalized = normalizeVolumeLevel(params.level);
    if (normalized === null) {
      throw new Error('invalid volume level');
    }
    nextLevel = normalized;
  } else if (typeof params.delta === 'number' && !Number.isNaN(params.delta)) {
    const normalized = normalizeVolumeLevel(current.level + params.delta);
    if (normalized !== null) {
      nextLevel = normalized;
    }
  }
  
  const nextMuted =
    typeof params.muted === 'boolean' ? params.muted : current.muted;
  
  const updated = persistVolumeState(
    deviceId,
    { level: nextLevel, muted: nextMuted },
    { source: meta.source, broadcast: meta.broadcast }
  );
  
  if (!meta.skipEmit) {
    emitVolumeCommand(deviceId, updated, meta.reason || meta.source || 'control');
  }
  
  return updated;
}

// ========================================
// UPLOAD MIDDLEWARE
// ========================================
// Создаем upload middleware после инициализации devices
const upload = createUploadMiddleware(devices);

// ========================================
// API ROUTES (Модульные роутеры)
// ========================================

// File resolver (БЕЗ защиты - для плееров)
app.use('/api/files', fileResolverRouter);

// Auth router (БЕЗ защиты - для login)
const authRouter = createAuthRouter(io);
app.use('/api/auth', authRouter);

// Подключаем роутеры с зависимостями
const devicesRouter = createDevicesRouter({ 
  devices, 
  io, 
  saveDevicesJson: saveDevicesToDB, 
  fileNamesMap, 
  saveFileNamesMap: saveFileNamesToDB,
  requireAdmin,  // Передаем для защиты POST/DELETE
  requireSpeaker,
  onDeviceCreated: (deviceId) => {
    const state = ensureVolumeState(deviceId);
    io.emit('devices/volume/state', {
      device_id: deviceId,
      level: state.level,
      muted: state.muted,
      updated_at: state.updatedAt,
      source: 'server'
    });
  },
  onDeviceDeleted: (deviceId) => {
    delete deviceVolumeState[deviceId];
  }
});

const placeholderRouter = createPlaceholderRouter({ 
  devices, 
  io,
  fileNamesMap
});

const filesRouter = createFilesRouter({
  devices,
  io,
  fileNamesMap,
  saveFileNamesMap: saveFileNamesToDB,
  upload,
  autoConvertFileWrapper,
  autoOptimizeVideoWrapper,
  checkVideoParameters,
  getFileStatus,
  requireAdmin
});

const videoInfoRouter = createVideoInfoRouter({
  devices,
  getFileStatus,
  checkVideoParameters,
  autoOptimizeVideoWrapper,
  io,
  requireAdmin
});

const conversionRouter = createConversionRouter({
  devices,
  getPageSlideCount,
  findFileFolder,
  autoConvertFileWrapper,
  requireAuth  // Передаем middleware
});

const foldersRouter = createFoldersRouter({
  devices,
  requireAuth  // Передаем middleware
});

const deduplicationRouter = createDeduplicationRouter({
  devices,
  io,
  fileNamesMap,
  saveFileNamesMap: saveFileNamesToDB,
  updateDeviceFilesFromDB
});

const heroRouter = createHeroRouter({ requireHeroAdmin });
const volumeRouter = createVolumeRouter({
  devices,
  getVolumeState,
  applyVolumeCommand,
  requireSpeaker
});

const notificationsRouter = createNotificationsRouter();

// Роутеры с избирательной защитой (применяют requireAuth внутри себя)
app.use('/api/devices', conversionRouter);  
app.use('/api/devices', foldersRouter);
app.use('/api/devices', deduplicationRouter);  // Дедупликация (check-duplicate, copy-from-duplicate)
app.use('/api/devices', volumeRouter);
app.use('/api/hero', heroRouter);
app.use('/api/notifications', notificationsRouter);  // Роутер уведомлений

// ВАЖНО: devicesRouter, placeholderRouter, filesRouter, videoInfoRouter
// используются устройствами (плеерами) БЕЗ JWT токенов!
// Только POST/DELETE операции внутри них защищены requireAdmin
app.use('/api/devices', devicesRouter);  // GET открыт для устройств
app.use('/api/devices', placeholderRouter);  // GET открыт для устройств
app.use('/api/devices', filesRouter);  // GET открыт для устройств
app.use('/api/devices', videoInfoRouter);  // GET открыт для устройств

// System info router
const systemInfoRouter = createSystemInfoRouter();
app.use('/api/system', requireAuth, systemInfoRouter);

// ========================================
// FAVICON HANDLING
// ========================================
// Обработка favicon.ico - возвращаем favicon-32.png или 204 No Content
app.get('/favicon.ico', (req, res) => {
  const faviconPath = path.join(PUBLIC, 'favicon-32.png');
  if (fs.existsSync(faviconPath)) {
    res.setHeader('Content-Type', 'image/png');
    res.sendFile(faviconPath);
  } else {
    // Если файла нет - возвращаем 204 No Content (браузер не будет показывать ошибку)
    res.status(204).end();
  }
});

// ========================================
// ADMIN ENDPOINTS
// ========================================
const AUTO_RESTART_AFTER_DB_IMPORT = process.env.AUTO_RESTART_AFTER_DB_IMPORT !== '0';
const DB_IMPORT_RESTART_DELAY_MS = Math.max(300, Number(process.env.DB_IMPORT_RESTART_DELAY_MS || 800));
const MANUAL_RESTART_DELAY_MS = Math.max(500, Number(process.env.MANUAL_RESTART_DELAY_MS || 1200));
const SERVICE_LOGS_MAX_LINES = Math.max(50, Number(process.env.SERVICE_LOGS_MAX_LINES || 2000));
const SERVICE_LOGS_DEFAULT_LINES = Math.max(20, Number(process.env.SERVICE_LOGS_DEFAULT_LINES || 200));
const SERVICE_LOGS_MAX_CHUNK_BYTES = Math.max(64 * 1024, Number(process.env.SERVICE_LOGS_MAX_CHUNK_BYTES || 512 * 1024));
const ADMIN_SERVICE_LOGS_FALLBACK_DIR = path.join(ROOT, '.tmp', 'logs');
const ADMIN_DB_IMPORT_DIR = path.join(ROOT, '.tmp', 'db-import');
const UPDATE_CHECK_ENABLED = process.env.UPDATE_CHECK_ENABLED !== '0';
const UPDATE_CHECK_INTERVAL_MS = Math.max(60 * 1000, Number.parseInt(process.env.UPDATE_CHECK_INTERVAL_MS || '900000', 10) || 900000);
const UPDATE_CHECK_INITIAL_DELAY_MS = Math.max(5000, Number.parseInt(process.env.UPDATE_CHECK_INITIAL_DELAY_MS || '20000', 10) || 20000);

const updateManager = createUpdateManager({
  repoRoot: ROOT,
  syncScriptPath: path.join(ROOT, 'scripts', 'post-pull-sync.sh')
});

let isServiceRestartScheduled = false;

function scheduleServiceRestart(reason = 'admin_restart', delayMs = DB_IMPORT_RESTART_DELAY_MS) {
  if (isServiceRestartScheduled) {
    return true;
  }

  isServiceRestartScheduled = true;
  logger.warn('[Admin] Service restart scheduled', { reason, delayMs });

  setTimeout(() => {
    gracefulShutdown(reason, 1).catch((err) => {
      logger.error('[Admin] Graceful service restart failed', { reason, error: err?.message || String(err) });
      process.exit(1);
    });
  }, delayMs);

  return true;
}

function scheduleRestartAfterDbImport() {
  if (!AUTO_RESTART_AFTER_DB_IMPORT) {
    logger.info('[Admin] Auto restart after DB import is disabled');
    return false;
  }

  return scheduleServiceRestart('db_import_restart', DB_IMPORT_RESTART_DELAY_MS);
}

function scheduleRestartAfterUpdateApply() {
  return scheduleServiceRestart('admin_update_apply', MANUAL_RESTART_DELAY_MS);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getServiceLogsCandidateDirs() {
  const seenDirs = new Set();
  const candidates = [getLogsDir(), ADMIN_SERVICE_LOGS_FALLBACK_DIR];

  return candidates
    .map((dirPath) => path.resolve(String(dirPath || '')))
    .filter((dirPath) => {
      if (!dirPath || seenDirs.has(dirPath)) {
        return false;
      }
      seenDirs.add(dirPath);
      return true;
    });
}

function validateServiceLogFilePath(filePath) {
  const resolvedFilePath = path.resolve(String(filePath || ''));

  for (const baseDir of getServiceLogsCandidateDirs()) {
    try {
      const safeFilePath = validatePath(resolvedFilePath, baseDir);
      const isAllowedLogFileName = /^combined-\d{4}-\d{2}-\d{2}\.log$/.test(path.basename(safeFilePath));
      if (isAllowedLogFileName) {
        return safeFilePath;
      }
    } catch {
      // Try next candidate dir.
    }
  }

  throw new Error('Invalid service log path');
}

function resolveLatestServiceLogFilePath() {
  for (const dirPath of getServiceLogsCandidateDirs()) {
    try {
      const safeDirPath = validatePath(dirPath, dirPath);
      if (!fs.existsSync(safeDirPath)) continue;

      const files = fs.readdirSync(safeDirPath)
        .filter((name) => /^combined-\d{4}-\d{2}-\d{2}\.log$/.test(name))
        .sort();

      if (!files.length) continue;
      return path.join(safeDirPath, files[files.length - 1]);
    } catch (error) {
      logger.warn('[Admin] Failed to inspect logs directory', {
        dirPath: path.resolve(dirPath),
        error: error?.message || String(error)
      });
    }
  }

  return null;
}

function readLastLinesFromFile(filePath, lineLimit) {
  const safeLimit = clampInt(parsePositiveInt(lineLimit, SERVICE_LOGS_DEFAULT_LINES), 1, SERVICE_LOGS_MAX_LINES);
  const safeFilePath = validateServiceLogFilePath(filePath);
  const fd = fs.openSync(safeFilePath, 'r');

  try {
    const stats = fs.fstatSync(fd);
    if (!stats.size) {
      return { lines: [], size: 0, truncated: false };
    }

    const chunkSize = 64 * 1024;
    let position = stats.size;
    let content = '';
    let linesFound = 0;

    while (position > 0 && linesFound <= safeLimit) {
      const bytesToRead = Math.min(chunkSize, position);
      position -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, position);
      content = buffer.toString('utf8') + content;
      linesFound = content.split(/\r?\n/).length - 1;
    }

    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-safeLimit);

    return {
      lines,
      size: stats.size,
      truncated: false
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readLinesFromOffset(filePath, offset) {
  const safeOffset = Math.max(0, parsePositiveInt(offset, 0));
  const safeFilePath = validateServiceLogFilePath(filePath);
  const fd = fs.openSync(safeFilePath, 'r');

  try {
    const stats = fs.fstatSync(fd);
    if (safeOffset >= stats.size) {
      return { lines: [], size: stats.size, truncated: false, reset: false };
    }

    let startOffset = safeOffset;
    let truncated = false;
    const unreadBytes = stats.size - startOffset;

    if (unreadBytes > SERVICE_LOGS_MAX_CHUNK_BYTES) {
      startOffset = stats.size - SERVICE_LOGS_MAX_CHUNK_BYTES;
      truncated = true;
    }

    const bytesToRead = stats.size - startOffset;
    if (bytesToRead <= 0) {
      return { lines: [], size: stats.size, truncated, reset: false };
    }

    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, startOffset);

    const lines = buffer
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    return {
      lines,
      size: stats.size,
      truncated,
      reset: false
    };
  } finally {
    fs.closeSync(fd);
  }
}

app.post('/api/admin/restart-service', requireAuth, requireAdmin, (req, res) => {
  const restartScheduled = scheduleServiceRestart('admin_manual_restart', MANUAL_RESTART_DELAY_MS);
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

app.get('/api/admin/update/status', requireAuth, requireAdmin, async (req, res) => {
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

app.post('/api/admin/update/check', requireAuth, requireAdmin, async (req, res) => {
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

app.post('/api/admin/update/dismiss', requireAuth, requireAdmin, (req, res) => {
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

app.post('/api/admin/update/apply', requireAuth, requireAdmin, async (req, res) => {
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

app.get('/api/admin/service-logs', requireAuth, requireAdmin, (req, res) => {
  try {
    const requestedLines = clampInt(
      parsePositiveInt(req.query.lines, SERVICE_LOGS_DEFAULT_LINES),
      1,
      SERVICE_LOGS_MAX_LINES
    );
    const requestedOffset = parsePositiveInt(req.query.offset, -1);
    const requestedFileName = typeof req.query.fileName === 'string' ? req.query.fileName : '';

    const logFilePath = resolveLatestServiceLogFilePath();
    if (!logFilePath) {
      return res.json({
        ok: true,
        lines: [],
        nextOffset: 0,
        fileName: null,
        reset: true,
        truncated: false,
        source: 'combined'
      });
    }

    const fileName = path.basename(logFilePath);

    // Первый запрос (без offset) - отдаем хвост последних N строк
    if (requestedOffset < 0) {
      const snapshot = readLastLinesFromFile(logFilePath, requestedLines);
      return res.json({
        ok: true,
        lines: snapshot.lines,
        nextOffset: snapshot.size,
        fileName,
        reset: true,
        truncated: snapshot.truncated,
        source: 'combined'
      });
    }

    const chunkProbe = readLinesFromOffset(logFilePath, requestedOffset);
    const fileChanged = Boolean(requestedFileName) && requestedFileName !== fileName;
    const offsetOutOfRange = requestedOffset > chunkProbe.size;

    if (fileChanged || offsetOutOfRange) {
      const snapshot = readLastLinesFromFile(logFilePath, requestedLines);
      return res.json({
        ok: true,
        lines: snapshot.lines,
        nextOffset: snapshot.size,
        fileName,
        reset: true,
        truncated: snapshot.truncated,
        source: 'combined'
      });
    }

    const chunk = chunkProbe;
    return res.json({
      ok: true,
      lines: chunk.lines,
      nextOffset: chunk.size,
      fileName,
      reset: chunk.reset,
      truncated: chunk.truncated,
      source: 'combined'
    });
  } catch (error) {
    logger.error('[Admin] Failed to read service logs', { error: error?.message || String(error) });
    return res.status(500).json({
      ok: false,
      error: 'Не удалось получить логи сервиса'
    });
  }
});

// Экспорт базы данных (только для админов)
app.get('/api/admin/export-database', requireAuth, requireAdmin, (req, res) => {
  try {
    const dbFilePath = path.join(ROOT, 'config', 'main.db');
    
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

// Импорт базы данных (замена текущей БД). Принимает FormData с полем `file` (.db).
app.post('/api/admin/import-database', requireAuth, requireAdmin, validateUploadSize, (req, res) => {
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
      try {
        const fd = fs.openSync(uploadedPath, 'r');
        const headerBuffer = Buffer.alloc(16);
        try {
          fs.readSync(fd, headerBuffer, 0, 16, 0);
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
          closeDatabase();
        } catch (e) {
          logger.warn('[Admin] closeDatabase warning', { error: e.message });
        }

        // Важно: удаляем -wal/-shm перед подменой файла базы
        removeWalShmFiles();

        // Копируем загруженный файл на место основной БД
        fs.copyFileSync(uploadedPath, DB_PATH);
        logger.info('[Admin] Database file replaced', { dbPath: DB_PATH });

        // Применяем миграции на новой базе
        runMigrations(DB_PATH);

        // КРИТИЧНО: После импорта БД из другого окружения пути к файлам
        // могут указывать на старый contentRoot. Пробуем восстановить их автоматически.
        const repairResult = repairImportedFilePaths({ devicesPath: getDevicesPath() });
        logger.info('[Admin] Imported DB paths repair completed', {
          checked: repairResult.checked,
          repaired: repairResult.repaired,
          unresolved: repairResult.unresolved,
          skipped: repairResult.skipped,
          errors: repairResult.errors
        });

        // Перезагрузим in-memory данные (devices, fileNamesMap)
        devices = loadDevicesFromDB();
        fileNamesMap = loadFileNamesFromDB();
        Object.keys(devices).forEach((deviceId) => {
          updateDeviceFilesFromDB(deviceId, devices, fileNamesMap);
        });
        saveDevicesToDB(devices);
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
            runMigrations(DB_PATH);
            devices = loadDevicesFromDB();
            fileNamesMap = loadFileNamesFromDB();
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

// Настройки администратора
app.get('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const settings = getSettings();
    res.json(settings);
  } catch (error) {
    logger.error('[Admin] Failed to load settings:', error);
    res.status(500).json({ error: 'Не удалось загрузить настройки' });
  }
});

app.post('/api/admin/settings/content-root', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { path: newPath } = req.body || {};
    if (!newPath) {
      return res.status(400).json({ error: 'Укажите путь' });
    }

    // КРИТИЧНО: updateContentRootPath теперь async и мигрирует пути в БД
    logger.info('[Admin] Updating content root path', { newPath });
    const normalizedPath = await updateContentRootPath(newPath);

    // Ждем небольшую задержку для завершения всех операций миграции в БД
    await new Promise(resolve => setTimeout(resolve, 100));

    // Пересканируем устройства, чтобы обновить список файлов после миграции
    logger.info('[Admin] Rescanning devices after path migration', { deviceCount: Object.keys(devices).length });
    Object.keys(devices).forEach((deviceId) => {
      updateDeviceFilesFromDB(deviceId, devices, fileNamesMap);
    });
    saveDevicesToDB(devices);
    io.emit('devices/updated');
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

// ========================================
// DATABASE CLEANUP ENDPOINTS
// ========================================

// GET /api/admin/database/check-files - Проверить файлы из БД на наличие на диске
app.get('/api/admin/database/check-files', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { cleanupMissingFiles } = await import('./src/database/files-metadata.js');
    
    // КРИТИЧНО: Проверяем только файлы из БД на наличие на диске
    // НЕ сканируем файлы на диске - это может показать папки с фото и другие файлы, которых нет в БД
    const result = await cleanupMissingFiles({ deviceId: null, dryRun: true });
    
    res.json({
      checked: result.checked,
      missingOnDisk: result.missing,
      missingInDB: 0, // Больше не проверяем файлы на диске
      errors: result.errors
    });
  } catch (error) {
    logger.error('[Admin] Failed to check files:', error);
    res.status(500).json({ error: error.message || 'Не удалось проверить файлы' });
  }
});

// POST /api/admin/database/wal-checkpoint - Выполнить WAL checkpoint вручную
app.post('/api/admin/database/wal-checkpoint', requireAuth, requireAdmin, (req, res) => {
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

// POST /api/admin/database/cleanup-missing-files - Удалить записи о несуществующих файлах из БД
app.post('/api/admin/database/cleanup-missing-files', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    const { cleanupMissingFiles } = await import('./src/database/files-metadata.js');
    
    logger.info('[Admin] Starting database cleanup', { deviceId: deviceId || 'all' });
    
    // КРИТИЧНО: Удаляем только записи из БД для файлов, которых нет на диске
    // НЕ сканируем и НЕ удаляем файлы с диска - это может удалить папки с фото и другие файлы
    const dbResult = await cleanupMissingFiles({ deviceId: deviceId || null, dryRun: false });
    
    logger.info('[Admin] Database cleanup completed', {
      checked: dbResult.checked,
      missing: dbResult.missing,
      deleted: dbResult.deleted,
      errors: dbResult.errors
    });
    
    // Обновляем список файлов для устройств после очистки
    if (dbResult.deleted > 0) {
      const deviceIds = deviceId ? [deviceId] : Object.keys(devices);
      deviceIds.forEach((id) => {
        if (devices[id]) {
          updateDeviceFilesFromDB(id, devices, fileNamesMap);
        }
      });
      saveDevicesToDB(devices);
      io.emit('devices/updated');
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

// POST /api/admin/database/cleanup-orphaned-files - Удалить осиротевшие файлы из /content/
app.post('/api/admin/database/cleanup-orphaned-files', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { dryRun = false, excludeExtensions = [] } = req.body || {};
    const { cleanupOrphanedFiles } = await import('./src/database/cleanup-orphaned-files.js');
    
    logger.info('[Admin] Starting orphaned files cleanup', { dryRun, excludeExtensions });
    
    // Удаляем файлы в /content/ корне, которые не имеют записей в БД
    const result = await cleanupOrphanedFiles({ dryRun, excludeExtensions });
    
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

// ========================================
// HEALTH CHECK ENDPOINT
// ========================================
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: Date.now(),
    uptime: Math.floor(process.uptime()),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
    },
    database: 'unknown',
    circuitBreakers: {}
  };

  // Проверка БД
  try {
    const db = getDatabase();
    // Простой запрос для проверки соединения
    db.prepare('SELECT 1').get();
    health.database = 'connected';
  } catch (e) {
    health.database = 'disconnected';
    health.status = 'degraded';
  }

  // Состояние circuit breakers
  for (const [name, breaker] of Object.entries(circuitBreakers)) {
    const state = breaker.getState();
    health.circuitBreakers[name] = {
      state: state.state,
      failureCount: state.failureCount
    };
    if (state.state === 'OPEN') {
      health.status = 'degraded';
    }
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// ========================================
// METRICS ENDPOINT
// ========================================

app.get('/api/metrics', requireAuth, requireAdmin, (req, res) => {
  try {
    const metrics = getMetrics();
    res.json(metrics);
  } catch (e) {
    logger.error('[Metrics] Error getting metrics:', e);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// Duplicates list (admin only)
app.use('/api/duplicates', requireAuth, deduplicationRouter);

// ========================================
// ВСЕ API ROUTES ПЕРЕНЕСЕНЫ В МОДУЛИ src/routes/
// ========================================
// - devices.js: CRUD операций с устройствами
// - placeholder.js: Управление заглушками
// - files.js: Upload, copy, rename, delete, list файлов
// - video-info.js: Статус, информация и оптимизация видео
// - conversion.js: PDF/PPTX конвертация

// ========================================
// DOCUMENT CONVERSION (PDF/PPTX)
// ========================================
// (Модуль: src/converters/document-converter.js)

// ========================================
// VIDEO OPTIMIZATION для Android TV
// ========================================
// (Модули: src/video/optimizer.js, src/video/ffmpeg-wrapper.js, src/video/file-status.js)

// Оберточные функции для совместимости с существующим кодом
async function autoOptimizeVideoWrapper(deviceId, fileName) {
  return await autoOptimizeVideo(deviceId, fileName, devices, io, fileNamesMap, (map) => saveFileNamesToDB(map));
}

async function autoConvertFileWrapper(deviceId, fileName, devicesParam, fileNamesMapParam, saveFileNamesMapFnParam, ioParam) {
  // Используем переданные параметры или глобальные значения
  const devicesToUse = devicesParam || devices;
  const fileNamesMapToUse = fileNamesMapParam || fileNamesMap;
  const saveFileNamesMapFnToUse = saveFileNamesMapFnParam || ((map) => saveFileNamesToDB(map));
  const ioToUse = ioParam || io;
  
  return await autoConvertFile(deviceId, fileName, devicesToUse, fileNamesMapToUse, saveFileNamesMapFnToUse, ioToUse);
}

// ========================================
// SOCKET.IO CONNECTION HANDLING
// ========================================

// Все Socket.IO handlers перенесены в модули src/socket/

// Настраиваем Socket.IO обработчики
setupSocketHandlers(io, { 
  devices, 
  getPageSlideCount,
  getVolumeState,
  persistVolumeState,
  applyVolumeCommand,
  deviceVolumeState
});

// Настраиваем Socket.IO обработчики для уведомлений
setupNotificationsHandler(io);

// Запускаем системный мониторинг (проверка диска, БД, процессов и т.д.)
initSystemMonitor(streamManager, devices);

function hydrateDevicesFromDatabase() {
  try {
    const repairResult = repairImportedFilePaths({ devicesPath: getDevicesPath() });
    if (repairResult.repaired > 0 || repairResult.unresolved > 0) {
      logger.info('[Server] Startup metadata path repair result', {
        checked: repairResult.checked,
        repaired: repairResult.repaired,
        unresolved: repairResult.unresolved,
        skipped: repairResult.skipped,
        errors: repairResult.errors
      });
    }
  } catch (error) {
    logger.warn('[Server] Startup metadata path repair failed', {
      error: error.message
    });
  }

  // КРИТИЧНО: Используем updateDeviceFilesFromDB для правильной загрузки файлов и стримов
  // Эта функция правильно обрабатывает стримы из БД и создает device.streams
  for (const deviceId in devices) {
    updateDeviceFilesFromDB(deviceId, devices, fileNamesMap);

    logger.info('Device files loaded (DB + folders)', {
      deviceId,
      totalFiles: devices[deviceId].files?.length || 0,
      totalStreams: Object.keys(devices[deviceId].streams || {}).length
    });

    // КРИТИЧНО: Валидация состояния устройства - проверяем, существует ли файл из current
    const device = devices[deviceId];
    if (device.current && device.current.file && device.current.type !== 'idle') {
      const deviceFiles = device.files || [];
      const deviceStreams = device.streams || {};
      const currentFile = device.current.file;
      const playlistFile = device.current.playlistFile;

      // Проверяем основной файл (включая стримы и папки)
      let fileExists = deviceFiles.includes(currentFile);

      // Для стримов также проверяем streams объект
      if (!fileExists && device.current.type === 'streaming') {
        fileExists = !!deviceStreams[currentFile];
      }

      // Для папок может быть .zip расширение
      if (!fileExists) {
        const withoutZip = currentFile.replace(/\.zip$/i, '');
        fileExists = deviceFiles.includes(withoutZip);
      }

      // Проверяем файл плейлиста, если есть
      const playlistFileExists = !playlistFile ||
                                deviceFiles.includes(playlistFile) ||
                                deviceFiles.includes(playlistFile.replace(/\.zip$/i, ''));

      if (!fileExists || !playlistFileExists) {
        logger.warn('[Server] Файл из состояния устройства не найден, сбрасываем состояние', {
          deviceId,
          currentFile,
          playlistFile,
          currentType: device.current.type,
          fileExists,
          playlistFileExists,
          availableFiles: deviceFiles.slice(0, 5),
          availableStreams: Object.keys(deviceStreams).slice(0, 5)
        });

        // Сбрасываем состояние на idle
        device.current = { type: 'idle', file: null, state: 'idle' };
      }
    }
  }

  // Сохраняем обновленное состояние в БД
  saveDevicesToDB(devices);

  // КРИТИЧНО: Автоматическая очистка несуществующих файлов из БД при старте
  // Проверяем только если установлена переменная окружения AUTO_CLEANUP_MISSING_FILES=true
  if (process.env.AUTO_CLEANUP_MISSING_FILES === 'true') {
    logger.info('[Server] Auto-cleanup enabled, checking for missing files...');
    cleanupMissingFiles({ deviceId: null, dryRun: false })
      .then(result => {
        logger.info('[Server] Auto-cleanup completed', {
          checked: result.checked,
          missing: result.missing,
          deleted: result.deleted,
          errors: result.errors
        });
      })
      .catch(error => {
        logger.error('[Server] Auto-cleanup failed', {
          error: error.message,
          stack: error.stack
        });
      });
  } else {
    logger.info('[Server] Auto-cleanup disabled (set AUTO_CLEANUP_MISSING_FILES=true to enable)');
  }
}

// Запуск сервера
server.listen(PORT, HOST, () => {
  logger.info(`Server started on ${HOST}:${PORT} (accessible only through Nginx)`, { 
    host: HOST, 
    port: PORT, 
    env: process.env.NODE_ENV || 'development' 
  });

  // Переносим тяжелую синхронную подготовку после открытия порта,
  // чтобы nginx мог увидеть upstream сразу после рестарта.
  setImmediate(() => {
    try {
      hydrateDevicesFromDatabase();
    } catch (error) {
      logger.error('[Server] Deferred bootstrap failed', {
        error: error.message,
        stack: error.stack
      });
    }
  });
});

// ========================================
// PERIODIC CLEANUP TASKS
// ========================================

// Очистка кэша разрешений видео (каждые 30 минут)
// Удаляет записи для несуществующих файлов
const cleanupInterval = timerRegistry.setInterval(() => {
  const removed = cleanupResolutionCache();
  if (removed > 0) {
    logger.info('Resolution cache cleanup completed', { 
      removedEntries: removed, 
      cacheSize: getResolutionCacheSize() 
    });
  }
}, 30 * 60 * 1000, 'Resolution cache cleanup'); // 30 минут

if (UPDATE_CHECK_ENABLED) {
  timerRegistry.setTimeout(() => {
    updateManager.checkAndNotify({
      force: false,
      fetchRemote: true,
      source: 'startup'
    }).catch((error) => {
      logger.warn('[UpdateManager] Initial update check failed', {
        error: error?.message || String(error)
      });
    });
  }, UPDATE_CHECK_INITIAL_DELAY_MS, 'Update checker initial run');

  timerRegistry.setInterval(() => {
    updateManager.checkAndNotify({
      force: false,
      fetchRemote: true,
      source: 'periodic'
    }).catch((error) => {
      logger.warn('[UpdateManager] Periodic update check failed', {
        error: error?.message || String(error)
      });
    });
  }, UPDATE_CHECK_INTERVAL_MS, 'Update checker periodic run');

  logger.info('[UpdateManager] Periodic update checks enabled', {
    intervalMs: UPDATE_CHECK_INTERVAL_MS,
    initialDelayMs: UPDATE_CHECK_INITIAL_DELAY_MS,
    branch: updateManager.getRuntimeState().branch
  });
} else {
  logger.info('[UpdateManager] Periodic update checks disabled by UPDATE_CHECK_ENABLED=0');
}

// ========================================
// GRACEFUL SHUTDOWN
// ========================================

let isShuttingDown = false;

async function gracefulShutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logger.info(`🛑 Received ${signal}, starting graceful shutdown...`);
  
  try {
    // 1. Останавливаем прием новых запросов
    server.close(() => {
      logger.info('✅ HTTP server closed');
    });
    
    // 2. Закрываем WebSocket соединения
    if (io) {
      io.close(() => {
        logger.info('✅ WebSocket connections closed');
      });
    }
    
    // 3. Останавливаем системный мониторинг
    stopSystemMonitor();
    logger.info('✅ System monitor stopped');
    
    // 4. Очищаем все таймеры через реестр
    timerRegistry.clearAll('graceful_shutdown');
    logger.info('✅ All timers cleared');
    
    // Останавливаем WAL checkpoint
    stopWalCheckpointInterval();
    logger.info('✅ WAL checkpoint interval stopped');
    
    // 4. Останавливаем StreamManager
    if (streamManager && typeof streamManager.stop === 'function') {
      streamManager.stop();
      logger.info('✅ StreamManager stopped');
    }
    
    // 5. Закрываем базу данных
    closeDatabase();
    
    // 6. Ждем завершения активных запросов (макс 10 сек)
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    logger.info('✅ Graceful shutdown completed');
    process.exit(exitCode);
  } catch (e) {
    logger.error('❌ Error during shutdown:', e);
    process.exit(exitCode === 0 ? 1 : exitCode);
  }
}

// Обработка сигналов завершения
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Обработка необработанных ошибок
// КРИТИЧНО: Разделяем ошибки на критичные и некритичные
let criticalErrorCount = 0;
const MAX_CRITICAL_ERRORS = 5; // Максимум критических ошибок перед shutdown
const CRITICAL_ERROR_RESET_TIME = 60000; // Сброс счетчика через 1 минуту

// Сбрасываем счетчик критических ошибок периодически
timerRegistry.setInterval(() => {
  if (criticalErrorCount > 0) {
    criticalErrorCount = Math.max(0, criticalErrorCount - 1);
  }
}, CRITICAL_ERROR_RESET_TIME, 'Critical error counter reset');

process.on('uncaughtException', (err) => {
  logger.error('💥 Uncaught Exception:', {
    message: err.message,
    stack: err.stack,
    name: err.name
  });
  
  // Определяем, является ли ошибка критичной
  const isCritical = 
    err.message?.includes('database') ||
    err.message?.includes('ENOMEM') ||
    err.message?.includes('out of memory') ||
    err.message?.includes('SQLITE') ||
    err.name === 'DatabaseError' ||
    err.code === 'ENOMEM';
  
  // Отправляем уведомление админу
  notifyCriticalError({
    type: 'uncaught_exception',
    severity: isCritical ? 'critical' : 'warning',
    error: {
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 10).join('\n'), // Первые 10 строк стека
      name: err.name,
      code: err.code
    },
    isCritical,
    recommendation: isCritical 
      ? 'Критическая ошибка обнаружена. Сервис может быть нестабилен. Проверьте логи и рассмотрите перезапуск.'
      : 'Проверьте логи сервера для деталей. Сервис продолжает работу.'
  });
  
  // Для критических ошибок увеличиваем счетчик
  if (isCritical) {
    criticalErrorCount++;
    
    // Если слишком много критических ошибок - выполняем graceful shutdown
    if (criticalErrorCount >= MAX_CRITICAL_ERRORS) {
      logger.error('💥 Too many critical errors, initiating graceful shutdown', {
        count: criticalErrorCount
      });
      notifyCriticalError({
        type: 'too_many_critical_errors',
        error: {
          message: `Обнаружено ${criticalErrorCount} критических ошибок подряд`,
          recommendation: 'Выполняется graceful shutdown для предотвращения дальнейших проблем'
        },
        recommendation: 'Сервис будет перезапущен. Проверьте логи для выявления причины.'
      });
      
      // Даем время на отправку уведомления
      setTimeout(() => {
        gracefulShutdown('too_many_critical_errors').catch(() => {
          process.exit(1);
        });
      }, 2000);
      return;
    }
  }
  
  // Для некритичных ошибок продолжаем работу
  // НЕ завершаем процесс - сервис должен продолжать работать
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 Unhandled Rejection', {
    reason: reason instanceof Error ? {
      message: reason.message,
      stack: reason.stack
    } : reason,
    promise: promise?.toString?.() || String(promise)
  });
  
  // Определяем, является ли ошибка критичной
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  const isCritical = 
    errorMessage?.includes('database') ||
    errorMessage?.includes('ENOMEM') ||
    errorMessage?.includes('out of memory') ||
    errorMessage?.includes('SQLITE');
  
  // Отправляем уведомление админу
  notifyCriticalError({
    type: 'unhandled_rejection',
    severity: isCritical ? 'critical' : 'warning',
    error: reason instanceof Error ? {
      message: reason.message,
      stack: reason.stack?.split('\n').slice(0, 10).join('\n'),
      name: reason.name,
      code: reason.code
    } : { reason: String(reason) },
    isCritical,
    recommendation: isCritical
      ? 'Критическая ошибка в промисах обнаружена. Проверьте логи.'
      : 'Проверьте логи сервера для деталей. Сервис продолжает работу.'
  });
  
  // Для критических ошибок увеличиваем счетчик
  if (isCritical) {
    criticalErrorCount++;
    
    // Если слишком много критических ошибок - выполняем graceful shutdown
    if (criticalErrorCount >= MAX_CRITICAL_ERRORS) {
      logger.error('💥 Too many critical errors from rejections, initiating graceful shutdown', {
        count: criticalErrorCount
      });
      notifyCriticalError({
        type: 'too_many_critical_errors',
        error: {
          message: `Обнаружено ${criticalErrorCount} критических ошибок в промисах подряд`,
          recommendation: 'Выполняется graceful shutdown для предотвращения дальнейших проблем'
        },
        recommendation: 'Сервис будет перезапущен. Проверьте логи для выявления причины.'
      });
      
      setTimeout(() => {
        gracefulShutdown('too_many_critical_errors').catch(() => {
          process.exit(1);
        });
      }, 2000);
      return;
    }
  }
  
  // НЕ завершаем процесс - сервис должен продолжать работать
  // В production больше не завершаем процесс автоматически
});

// Admin API (установка APK и др.)
app.use('/api/admin', adminRouter);
