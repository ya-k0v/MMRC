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
import { createHeroRouter, initHeroDb } from './src/hero/index.js';
import { createVolumeRouter } from './src/routes/volume.js';
import fileResolverRouter from './src/routes/file-resolver.js';
import { createNotificationsRouter } from './src/routes/notifications.js';
import multer from 'multer';
import { createUploadMiddleware } from './src/middleware/multer-config.js';
import { requireAuth, requireAdmin, requireManager, requireHeroAdmin, requireSpeaker } from './src/middleware/auth.js';

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
import { createAdminRouter, createAdminEndpoints } from './src/routes/admin.js';
import { createModulesRouter } from './src/routes/modules.js';
import { initEnabledModules, getEnabledModules } from './src/modules/index.js';
import { createStorage } from './src/storage/factory.js';
import { createVolumeService } from './src/services/volume.js';

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

const volumeService = createVolumeService({ devices, io, saveDeviceVolumeState });

const {
  getVolumeState,
  persistVolumeState,
  applyVolumeCommand,
  deviceVolumeState
} = volumeService;

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
    volumeService.initDeviceVolume(deviceId);
  },
  onDeviceDeleted: (deviceId) => {
    volumeService.removeDeviceVolume(deviceId);
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

if (enabledModules.includes('hero')) {
  initHeroDb();
}
const heroRouter = enabledModules.includes('hero') ? createHeroRouter({ requireHeroAdmin }) : null;
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

// Inline admin endpoints moved to src/routes/admin.js
const adminEndpoints = createAdminEndpoints({
  updateManager,
  scheduleServiceRestart,
  scheduleRestartAfterDbImport,
  scheduleRestartAfterUpdateApply,
  DB_PATH,
  devices,
  fileNamesMap,
  io,
  manualRestartDelayMs: MANUAL_RESTART_DELAY_MS
});
app.use('/api/admin', adminLimiter, adminEndpoints);

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
  return await autoOptimizeVideo(deviceId, fileName, devices, io, fileNamesMap, (map) => saveFileNamesToDB(map), storage);
}

if (queuesReady && videoOptimizeQueue) {
  videoOptimizeQueue.process(3, async (job) => {
    const { deviceId, fileName } = job.data;
    logger.info(`[Queue] Processing optimize job ${job.id} (priority ${job.opts.priority}): ${deviceId}/${fileName}`);
    return autoOptimizeVideo(deviceId, fileName, devices, io, fileNamesMap, (map) => saveFileNamesToDB(map), storage);
  });
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


