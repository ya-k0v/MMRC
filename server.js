// Загружаем переменные окружения из .env файла
import 'dotenv/config';

import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Импорты из модулей
import { 
  ROOT, PUBLIC, MAX_FILE_SIZE, ALLOWED_EXT, PORT, HOST
} from './src/config/constants.js';
import { createSocketServer } from './src/config/socket-config.js';
import { 
  closeDatabase, 
  getDatabase, 
  getDriverType,
  getAllDeviceVolumeStates, 
  saveDeviceVolumeState,
  startWalCheckpointInterval,
  stopWalCheckpointInterval,
  performWalCheckpoint,
  startReconnectWatcher,
  stopReconnectWatcher,
  isReconnecting
} from './src/database/database.js';
import { APP_VERSION, APP_BRANCH, DOCKER_TAG, DOCKER_IMAGES, APPS } from './src/config/constants.js';
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
import { generateHlsVod, getHlsPublicPath } from './src/video/hls-generator.js';
import { updateFileHlsMetadata } from './src/database/files-metadata.js';
import { videoOptimizeQueue, queuesReady } from './src/queue/queue.js';
import { createBullBoard } from '@bull-board/api';
import { BullAdapter } from '@bull-board/api/bullAdapter';
import { ExpressAdapter } from '@bull-board/express';
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
import { createAnalyticsRouter } from './src/routes/analytics.js';
import { createFoldersRouter } from './src/routes/folders.js';
import { createAuthRouter } from './src/routes/auth.js';
import { createDeduplicationRouter } from './src/routes/deduplication.js';
import { createHeroRouter } from './src/hero/index.js';
import { createAdRouter } from './src/ad/index.js';
import { createVolumeRouter } from './src/routes/volume.js';
import fileResolverRouter from './src/routes/file-resolver.js';
import { createNotificationsRouter } from './src/routes/notifications.js';
import multer from 'multer';
import { createUploadMiddleware, validateUploadSize } from './src/middleware/multer-config.js';
import { requireAuth, requireAdmin, requireManager, requireHeroAdmin, requireSpeaker, requireCsrfToken } from './src/middleware/auth.js';
import bcrypt from 'bcrypt';
import { globalLimiter, apiSpeedLimiter, adminLimiter } from './src/middleware/rate-limit.js';
import { setupExpressMiddleware, setupStaticFiles } from './src/middleware/express-config.js';
import { setupSocketHandlers } from './src/socket/index.js';
import { setupNotificationsHandler } from './src/socket/notifications-handler.js';
import { notifyCriticalError } from './src/utils/notifications.js';
import { initSystemMonitor, stopSystemMonitor } from './src/utils/system-monitor.js';
import logger, { httpLoggerMiddleware } from './src/utils/logger.js';
import { cleanupResolutionCache, getResolutionCacheSize } from './src/video/resolution-cache.js';
import { circuitBreakers } from './src/utils/circuit-breaker.js';
import { getDataRoot, getDevicesPath, getStreamsOutputDir, getConvertedCache, getLogsDir, getTempDir } from './src/config/settings-manager.js';
import { validatePath } from './src/utils/path-validator.js';
import { getMetrics } from './src/utils/metrics.js';
import { timerRegistry } from './src/utils/timer-registry.js';
import { createUpdateManager } from './src/utils/update-manager.js';
import { createDockerUpdateManager } from './src/utils/docker-update-manager.js';
import { createAdminRouter } from './src/routes/admin.js';
import { createModulesRouter } from './src/routes/modules.js';
import { initEnabledModules, getEnabledModules } from './src/modules/index.js';
import { createStorage } from './src/storage/factory.js';

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

const storage = createStorage(dataRoot);
logger.info(`[Config] 📦 Storage backend: ${storage.constructor.name} (root: ${storage.root})`);

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
// Use system-wide data directory if set AND exists, otherwise use project-local data/
// In Docker: MMRC_DATA_DIR=/var/lib/mmrc-data (created by Dockerfile)
// Local dev: falls back to ./data/ automatically
let DATA_DIR = path.join(ROOT, 'data');
if (process.env.MMRC_DATA_DIR && fs.existsSync(process.env.MMRC_DATA_DIR)) {
  try {
    fs.accessSync(process.env.MMRC_DATA_DIR, fs.constants.W_OK);
    DATA_DIR = process.env.MMRC_DATA_DIR;
  } catch (err) {
    logger.warn('[Server] MMRC_DATA_DIR not writable, using local', { dir: process.env.MMRC_DATA_DIR });
  }
}
const DB_PATH = path.join(DATA_DIR, 'db', 'main.db');
logger.info('[Server] Database path', { dbPath: DB_PATH, dataDir: DATA_DIR });
const isPostgres = process.env.DB_TYPE === 'postgres';
try {
  await runMigrations(isPostgres ? undefined : DB_PATH);
} catch (err) {
  logger.error('[Server] Database migration failed, aborting startup', { error: err?.message || String(err) });
  throw err;
}

const WAL_CHECKPOINT_INTERVAL_MS = parseInt(process.env.WAL_CHECKPOINT_INTERVAL_MS || '60000', 10);
if (!isPostgres) {
  startWalCheckpointInterval(WAL_CHECKPOINT_INTERVAL_MS);
  logger.info('[Server] WAL checkpoint interval started', {
    intervalMs: WAL_CHECKPOINT_INTERVAL_MS,
    intervalMinutes: WAL_CHECKPOINT_INTERVAL_MS / 60000,
    thresholdMB: process.env.WAL_CHECKPOINT_THRESHOLD_MB || '100'
  });
  if (process.env.REDIS_URL || process.env.MMRC_HA_MODE) {
    logger.error('[Server] 🚫 SQLite + Redis/HA is NOT SUPPORTED.');
    logger.error('[Server]    SQLite is unsafe with multiple processes — data corruption will occur.');
    logger.error('[Server]    Set DB_TYPE=postgres in .env and use PostgreSQL for HA deployments.');
    logger.error('[Server]    Server will exit. Fix .env and restart.');
    process.exit(1);
  }
}

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

async function startupDatabase() {
  if (!isPostgres) {
    const DB_PATH = path.join(ROOT, 'config', 'main.db');
    try {
      await runMigrations(DB_PATH);
    } catch (err) {
      logger.error('[Server] Database migration failed, aborting startup', { error: err?.message || String(err) });
      throw err;
    }

    startWalCheckpointInterval(WAL_CHECKPOINT_INTERVAL_MS);
    logger.info('[Server] WAL checkpoint interval started', {
      intervalMs: WAL_CHECKPOINT_INTERVAL_MS,
      intervalMinutes: WAL_CHECKPOINT_INTERVAL_MS / 60000,
      thresholdMB: process.env.WAL_CHECKPOINT_THRESHOLD_MB || '100'
    });
  }

  devices = await loadDevicesFromDB();
  fileNamesMap = await loadFileNamesFromDB();

  const enabledModules = await initEnabledModules();
  if (enabledModules.length > 0) {
    logger.info('[Server] Enabled modules:', { modules: enabledModules.join(', ') });
  }
  return enabledModules;
}
const enabledModules = await startupDatabase();

startReconnectWatcher(30000);

const streamManager = initStreamManager({
  outputRoot: getStreamsOutputDir(),
  publicBasePath: '/streams'
});

{
  const persistedVolumeState = await getAllDeviceVolumeStates();
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
      saveDeviceVolumeState(deviceId, { volumeLevel: 50, isMuted: false }).catch(err => {
        logger.warn('[Volume] Initial volume state save failed', { deviceId, error: err.message });
      });
    }
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
    saveDeviceVolumeState(deviceId, { volumeLevel: 50, isMuted: false }).catch(err => {
      logger.warn('[Volume] Initial state save failed', { deviceId, error: err.message });
    });
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
  }).catch(err => {
    logger.warn('[Volume] State persist failed', { deviceId, error: err.message });
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
  requireAdmin,
  requireSpeaker,
  storage,
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
  storage,
  fileNamesMap,
  saveFileNamesMap: saveFileNamesToDB,
  upload,
  autoConvertFileWrapper,
  autoOptimizeVideoWrapper,
  checkVideoParameters,
  getFileStatus,
  requireAdmin,
  requireManager
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
  requireAuth,
  storage  // Передаем storage backend
});

const foldersRouter = createFoldersRouter({
  devices,
  requireAuth,
  storage
});

const deduplicationRouter = createDeduplicationRouter({
  devices,
  io,
  fileNamesMap,
  saveFileNamesMap: saveFileNamesToDB,
  updateDeviceFilesFromDB
});

const heroRouter = enabledModules.includes('hero') ? createHeroRouter({ requireHeroAdmin }) : null;
const adRouter = enabledModules.includes('ad') ? createAdRouter({ requireAdAdmin: requireAdmin }) : null;
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
if (heroRouter) {
  app.use('/api/hero', heroRouter);
}
if (adRouter) {
  app.use('/api/ad', adRouter);
}
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

// Analytics dashboard router
const analyticsRouter = createAnalyticsRouter();
app.use('/api/analytics', requireAuth, requireAdmin, analyticsRouter);

// Internal metrics endpoint (no auth — used by other replicas via Docker network)
app.get('/internal/metrics', (req, res) => {
  try {
    res.json(getMetrics());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin API (установка APK, настройки, обслуживание БД и др.)
const adminRouter = createAdminRouter({
  io,
  devices,
  fileNamesMap,
  storage,
  getDriverType,
  getEnabledModules,
  performWalCheckpoint,
  saveDevicesToDB,
  updateDeviceFilesFromDB
});
app.use('/api/admin', adminLimiter, adminRouter);

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
const SERVICE_LOG_LEVELS = ['combined', 'error', 'warn', 'info', 'debug'];
const SERVICE_LOG_MODULES = ['auth', 'device', 'file', 'socket', 'security', 'api', 'stream', 'system', 'db'];
const ADMIN_DB_IMPORT_DIR = path.join(ROOT, '.tmp', 'db-import');
const UPDATE_CHECK_ENABLED = process.env.UPDATE_CHECK_ENABLED !== '0';
const UPDATE_CHECK_INTERVAL_MS = Math.max(60 * 1000, Number.parseInt(process.env.UPDATE_CHECK_INTERVAL_MS || '900000', 10) || 900000);
const UPDATE_CHECK_INITIAL_DELAY_MS = Math.max(5000, Number.parseInt(process.env.UPDATE_CHECK_INITIAL_DELAY_MS || '20000', 10) || 20000);

const MMRC_DOCKER = process.env.MMRC_DOCKER === '1';

const updateManager = MMRC_DOCKER
  ? createDockerUpdateManager({
      branch: process.env.DOCKER_IMAGE_TAG || DOCKER_TAG,
      image: process.env.DOCKER_IMAGE ? `${process.env.DOCKER_IMAGE}:${process.env.DOCKER_IMAGE_TAG || DOCKER_TAG}` : undefined,
      composeDir: process.env.MMRC_COMPOSE_DIR
    })
  : createUpdateManager({
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
      const fileName = path.basename(safeFilePath);
      const isAllowed = SERVICE_LOG_LEVELS.some(l =>
        l === 'combined'
          ? /^combined-\d{4}-\d{2}-\d{2}\.log$/.test(fileName)
          : new RegExp(`^${l}-\\d{4}-\\d{2}-\\d{2}\\.log$`).test(fileName)
      );
      if (isAllowed) return safeFilePath;
    } catch { }
  }

  throw new Error('Invalid service log path');
}

function resolveLatestServiceLogFilePath(level = 'combined') {
  const pattern = level === 'combined'
    ? /^combined-\d{4}-\d{2}-\d{2}\.log$/
    : new RegExp(`^${level}-\\d{4}-\\d{2}-\\d{2}\\.log$`);

  for (const dirPath of getServiceLogsCandidateDirs()) {
    try {
      const safeDirPath = validatePath(dirPath, dirPath);
      if (!fs.existsSync(safeDirPath)) continue;

      const files = fs.readdirSync(safeDirPath).filter((name) => pattern.test(name)).sort();
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
    const level = SERVICE_LOG_LEVELS.includes(req.query.level) ? req.query.level : 'combined';
    const moduleFilter = typeof req.query.module === 'string' ? req.query.module.trim() : '';

    const logFilePath = resolveLatestServiceLogFilePath(level);
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
      const snapshot = readAndFilter(readLastLinesFromFile, logFilePath, requestedLines);
      return res.json({
        ok: true, lines: snapshot.lines, nextOffset: snapshot.size,
        fileName, reset: true, truncated: snapshot.truncated,
        source: level, availableLevels: SERVICE_LOG_LEVELS, availableModules: SERVICE_LOG_MODULES
      });
    }

    const chunkProbe = readAndFilter(readLinesFromOffset, logFilePath, requestedOffset);
    const fileChanged = Boolean(requestedFileName) && requestedFileName !== fileName;
    const offsetOutOfRange = requestedOffset > chunkProbe.size;

    if (fileChanged || offsetOutOfRange) {
      const snapshot = readAndFilter(readLastLinesFromFile, logFilePath, requestedLines);
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

// Импорт базы данных (замена текущей БД). Принимает FormData с полем `file` (.db).
// Безопасность: требует CSRF токен (X-CSRF-Token), подтверждение пароля, проверку версии схемы
app.post('/api/admin/import-database', requireAuth, requireAdmin, requireCsrfToken, validateUploadSize, async (req, res) => {
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
        devices = await loadDevicesFromDB();
        fileNamesMap = await loadFileNamesFromDB();
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
            devices = await loadDevicesFromDB();
            fileNamesMap = await loadFileNamesFromDB();
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

// Модули (только admin)
const modulesRouter = createModulesRouter();
app.use('/api/admin/modules', requireAuth, requireAdmin, modulesRouter);

// ========================================
// VERSION ENDPOINT
// ========================================
app.get('/api/version', (req, res) => {
  res.json({
    version: APP_VERSION,
    branch: APP_BRANCH,
    dockerTag: DOCKER_TAG,
    dockerImages: DOCKER_IMAGES,
    apps: APPS
  });
});

// ========================================
// HEALTH CHECK ENDPOINT
// ========================================
app.get('/health', async (req, res) => {
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
    disk: {},
    circuitBreakers: {}
  };

  // Проверка БД
  try {
    const db = getDatabase();
    await db.get('SELECT 1');
    health.database = 'connected';
  } catch (e) {
    health.database = 'disconnected';
    health.status = 'degraded';
  }

  // Проверка диска
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const healthDataDir = getDataRoot();
    const { stdout } = await execFileAsync('df', ['-m', healthDataDir], { timeout: 5000 });
    const lines = stdout.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      if (parts.length >= 4) {
        health.disk = {
          path: healthDataDir,
          totalMB: parseInt(parts[1], 10) || 0,
          usedMB: parseInt(parts[2], 10) || 0,
          availableMB: parseInt(parts[3], 10) || 0
        };
      }
    }
  } catch {
    health.disk = { path: getDataRoot(), error: 'unable to check' };
  }

  // Состояние circuit breakers
  for (const [name, breaker] of Object.entries(circuitBreakers)) {
    const state = breaker.getState();
    health.circuitBreakers[name] = {
      state: state,
      failureCount: breaker.failureCount
    };
  }

  res.json(health);
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
  if (queuesReady && videoOptimizeQueue) {
    // Быстрая оценка приоритета по размеру файла
    let priority = 5;
    try {
      const device = devices[deviceId];
      if (device) {
        const deviceFolder = path.join(getDevicesPath(), device.folder);
        const filePath = path.join(deviceFolder, fileName);
        const stats = fs.statSync(filePath);
        const sizeMB = stats.size / (1024 * 1024);
        if (sizeMB < 50) priority = 1;
        else if (sizeMB > 500) priority = 10;
      }
    } catch {}
    const job = await videoOptimizeQueue.add(
      { deviceId, fileName },
      { priority }
    );
    return { success: true, status: 'queued', jobId: job.id };
  }
  const result = await autoOptimizeVideo(deviceId, fileName, devices, io, fileNamesMap, (map) => saveFileNamesToDB(map), storage);
  if (result && result.success && fileName) {
    scheduleHlsGeneration(deviceId, fileName);
  }
  return result;
}

async function triggerHlsGeneration(deviceId, fileName) {
  try {
    const { getFileMetadata } = await import('./src/database/files-metadata.js');
    const metadata = await getFileMetadata(deviceId, fileName);
    if (!metadata || !metadata.md5_hash) {
      logger.warn('[HLS] No metadata/md5 for file, skipping HLS gen', { deviceId, fileName });
      return;
    }
    const filePath = metadata.file_path;
    if (!filePath || !fs.existsSync(filePath)) {
      logger.warn('[HLS] File not found on disk, skipping HLS gen', { deviceId, fileName, filePath });
      return;
    }

    const result = await generateHlsVod(filePath, metadata.md5_hash, {
      video_codec: metadata.video_codec,
      video_width: metadata.video_width,
      video_height: metadata.video_height,
      audio_bitrate: metadata.audio_bitrate,
      audio_codec: metadata.audio_codec
    });

    if (result.success && result.manifestPath) {
      await updateFileHlsMetadata(deviceId, fileName, {
        hlsStatus: 'ready',
        hlsManifestPath: result.manifestPath,
        hlsRenditions: result.renditions
      });
      logger.info('[HLS] Metadata updated for file', { deviceId, fileName, manifestPath: result.manifestPath });
    } else if (!result.success && result.reason !== 'already_in_progress') {
      await updateFileHlsMetadata(deviceId, fileName, { hlsStatus: 'error', hlsManifestPath: null, hlsRenditions: null });
    }
  } catch (err) {
    logger.error('[HLS] Failed to generate HLS', { deviceId, fileName, error: err.message });
    try {
      await updateFileHlsMetadata(deviceId, fileName, { hlsStatus: 'error', hlsManifestPath: null, hlsRenditions: null });
    } catch {}
  }
}

if (queuesReady && videoOptimizeQueue) {
  videoOptimizeQueue.process(3, async (job) => {
    const { deviceId, fileName } = job.data;
    logger.info(`[Queue] Processing optimize job ${job.id} (priority ${job.opts.priority}): ${deviceId}/${fileName}`);
    const result = await autoOptimizeVideo(deviceId, fileName, devices, io, fileNamesMap, (map) => saveFileNamesToDB(map), storage);

    if (result && result.success && fileName) {
      scheduleHlsGeneration(deviceId, fileName);
    }
    return result;
  });
}

let hlsGenerationTimers = new Map();

function scheduleHlsGeneration(deviceId, fileName) {
  const key = `${deviceId}_${fileName}`;
  if (hlsGenerationTimers.has(key)) return;
  const timer = setTimeout(async () => {
    hlsGenerationTimers.delete(key);
    await triggerHlsGeneration(deviceId, fileName);
    if (io) {
      try {
        const { getFileMetadata } = await import('./src/database/files-metadata.js');
        const meta = await getFileMetadata(deviceId, fileName);
        if (meta && meta.hls_status === 'ready') {
          io.to(`device:${deviceId}`).emit('file/hls-ready', {
            device_id: deviceId,
            file: fileName,
            hls_manifest_path: meta.hls_manifest_path,
            hls_renditions: meta.hls_renditions ? JSON.parse(meta.hls_renditions) : null
          });
        }
      } catch {}
    }
  }, 5000);
  hlsGenerationTimers.set(key, timer);
}

// Bull Board (UI для мониторинга очередей)
let bullBoardRouter = null;
if (queuesReady) {
  try {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');
    createBullBoard({
      queues: [new BullAdapter(videoOptimizeQueue)],
      serverAdapter,
    });
    bullBoardRouter = serverAdapter.getRouter();
  } catch (err) {
    logger.warn('[BullBoard] Failed to initialize', { error: err.message });
  }
}

// Bull Board route (if initialized)
if (bullBoardRouter) {
  app.use('/admin/queues', requireAuth, requireAdmin, bullBoardRouter);
}

async function autoConvertFileWrapper(deviceId, fileName, devicesParam, fileNamesMapParam, saveFileNamesMapFnParam, ioParam) {
  const devicesToUse = devicesParam || devices;
  const fileNamesMapToUse = fileNamesMapParam || fileNamesMap;
  const saveFileNamesMapFnToUse = saveFileNamesMapFnParam || ((map) => saveFileNamesToDB(map));
  const ioToUse = ioParam || io;
  
  return await autoConvertFile(deviceId, fileName, devicesToUse, fileNamesMapToUse, saveFileNamesMapFnToUse, ioToUse, storage);
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
  deviceVolumeState,
  storage
});

// Настраиваем Socket.IO обработчики для уведомлений
setupNotificationsHandler(io);

// Запускаем системный мониторинг (проверка диска, БД, процессов и т.д.)
initSystemMonitor(streamManager, devices);

async function hydrateDevicesFromDatabase() {
  try {
    const repairResult = await repairImportedFilePaths({ devicesPath: getDevicesPath() });
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
  await saveDevicesToDB(devices);

  // КРИТИЧНО: Автоматическая очистка несуществующих файлов из БД при старте
  // По умолчанию ОТКЛЮЧЕНО - установите AUTO_CLEANUP_MISSING_FILES=true только после миграции путей!
  if (process.env.AUTO_CLEANUP_MISSING_FILES === 'true') {
    logger.warn('[Server] Auto-cleanup is ENABLED - this may delete DB records if paths are incorrect!');
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

// ========================================
// EXPRESS ERROR HANDLER
// ========================================
// КРИТИЧНО: Возвращаем JSON вместо HTML по умолчанию
app.use((err, req, res, next) => {
  logger.error('[Express] Unhandled error', {
    error: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip
  });
  res.status(err.status || err.statusCode || 500).json({
    error: err.message || 'Внутренняя ошибка сервера'
  });
});

// Запуск сервера
server.listen(PORT, HOST, () => {
  logger.info(`Server started on ${HOST}:${PORT} (accessible only through Nginx)`, { 
    host: HOST, 
    port: PORT, 
    env: process.env.NODE_ENV || 'development' 
  });

  // Переносим тяжелую синхронную подготовку после открытия порта,
  // чтобы nginx мог увидеть upstream сразу после рестарта.
  setImmediate(async () => {
    try {
      await hydrateDevicesFromDatabase();
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

  const forceExit = setTimeout(() => {
    logger.warn('⚠️ Force exit after shutdown timeout');
    process.exit(exitCode);
  }, 15000);

  try {
    // 1. Останавливаем прием новых запросов
    await Promise.race([
      new Promise(resolve => server.close(resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP server close timeout')), 5000))
    ]);
    logger.info('✅ HTTP server closed');

    // 2. Закрываем WebSocket соединения
    if (io) {
      await Promise.race([
        new Promise(resolve => io.close(resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Socket.IO close timeout')), 5000))
      ]);
      logger.info('✅ WebSocket connections closed');
    }

    // 3. Останавливаем системный мониторинг
    stopSystemMonitor();
    logger.info('✅ System monitor stopped');

    // 4. Очищаем все таймеры через реестр
    timerRegistry.clearAll('graceful_shutdown');
    logger.info('✅ All timers cleared');

    stopReconnectWatcher();
    logger.info('✅ Reconnect watcher stopped');

    // Останавливаем WAL checkpoint
    stopWalCheckpointInterval();
    logger.info('� WAL checkpoint interval stopped');

    // 4. Останавливаем StreamManager
    if (streamManager && typeof streamManager.stop === 'function') {
      streamManager.stop();
      logger.info('✅ StreamManager stopped');
    }

    // 4b. Закрываем очереди Bull
    if (queuesReady) {
      await Promise.allSettled([
        videoOptimizeQueue?.close().catch(() => {}),
      ]);
      logger.info('✅ Bull queues closed');
    }

    // 5. Закрываем базу данных
    await closeDatabase();
    logger.info('✅ Database closed');

    clearTimeout(forceExit);
    logger.info('✅ Graceful shutdown completed');
    process.exit(exitCode);
  } catch (e) {
    logger.error('❌ Error during shutdown:', e);
    clearTimeout(forceExit);
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

timerRegistry.setInterval(async () => {
  if (globalThis.__mmrc_reload_devices && !isReconnecting()) {
    logger.info('[Server] Reloading devices cache after PostgreSQL reconnect...');
    try {
      devices = await loadDevicesFromDB();
      fileNamesMap = await loadFileNamesFromDB();
      Object.keys(devices).forEach((deviceId) => {
        updateDeviceFilesFromDB(deviceId, devices, fileNamesMap);
      });
      io.emit('devices/updated');
      logger.info('[Server] Devices cache reloaded successfully');
    } catch (e) {
      logger.error('[Server] Failed to reload devices cache:', e.message);
    } finally {
      globalThis.__mmrc_reload_devices = false;
    }
  }
}, 10000, 'Devices cache reload check');

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


