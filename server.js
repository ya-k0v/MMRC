import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';

// Импорты из модулей
import { 
  ROOT, PUBLIC, DEVICES, MAX_FILE_SIZE, ALLOWED_EXT, PORT, HOST, useExternalDataDiskFlag
} from './src/config/constants.js';
import { createSocketServer } from './src/config/socket-config.js';
import { initDatabase, closeDatabase, getDatabase, getAllDeviceVolumeStates, saveDeviceVolumeState } from './src/database/database.js';
import { 
  loadDevicesFromDB, 
  saveDevicesToDB, 
  loadFileNamesFromDB, 
  saveFileNamesToDB
} from './src/storage/devices-storage-sqlite.js';
import { cleanupMissingFiles } from './src/database/files-metadata.js';
import { getFileStatus } from './src/video/file-status.js';
import { checkVideoParameters } from './src/video/ffmpeg-wrapper.js';
import { autoOptimizeVideo } from './src/video/optimizer.js';
import { 
  findFileFolder, getPageSlideCount, autoConvertFile 
} from './src/converters/document-converter.js';
import { initStreamManager, syncStreamJobs } from './src/streams/stream-manager.js';
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
import { createUploadMiddleware } from './src/middleware/multer-config.js';
import { requireAuth, requireAdmin, requireHeroAdmin, requireSpeaker } from './src/middleware/auth.js';
import { globalLimiter, apiSpeedLimiter } from './src/middleware/rate-limit.js';
import { setupExpressMiddleware, setupStaticFiles } from './src/middleware/express-config.js';
import { setupSocketHandlers } from './src/socket/index.js';
import logger, { httpLoggerMiddleware } from './src/utils/logger.js';
import { cleanupResolutionCache, getResolutionCacheSize } from './src/video/resolution-cache.js';
import { circuitBreakers } from './src/utils/circuit-breaker.js';
import { getSettings, updateContentRootPath, getDataRoot, getDevicesPath, getStreamsOutputDir, getConvertedCache, getLogsDir, getTempDir } from './src/config/settings-manager.js';
import { getMetrics } from './src/utils/metrics.js';

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
initDatabase(DB_PATH);

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
      logger.warn(`[Server] Файл из состояния устройства не найден, сбрасываем состояние`, {
        deviceId,
        currentFile,
        playlistFile,
        currentType: device.current.type,
        fileExists,
        playlistFileExists,
        availableFiles: deviceFiles.slice(0, 5), // Первые 5 файлов для отладки
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
const authRouter = createAuthRouter();
app.use('/api/auth', authRouter);

// Подключаем роутеры с зависимостями
const devicesRouter = createDevicesRouter({ 
  devices, 
  io, 
  saveDevicesJson: saveDevicesToDB, 
  fileNamesMap, 
  saveFileNamesMap: saveFileNamesToDB,
  requireAdmin,  // Передаем для защиты POST/DELETE
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
  autoOptimizeVideoWrapper
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

// Роутеры с избирательной защитой (применяют requireAuth внутри себя)
app.use('/api/devices', conversionRouter);  
app.use('/api/devices', foldersRouter);
app.use('/api/devices', deduplicationRouter);  // Дедупликация (check-duplicate, copy-from-duplicate)
app.use('/api/devices', volumeRouter);
app.use('/api/hero', heroRouter);

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

async function autoConvertFileWrapper(deviceId, fileName) {
  return await autoConvertFile(deviceId, fileName, devices, fileNamesMap, (map) => saveFileNamesToDB(map), io);
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

// Запуск сервера
server.listen(PORT, HOST, () => {
  logger.info(`Server started on ${HOST}:${PORT} (accessible only through Nginx)`, { 
    host: HOST, 
    port: PORT, 
    env: process.env.NODE_ENV || 'development' 
  });
});

// ========================================
// PERIODIC CLEANUP TASKS
// ========================================

// Очистка кэша разрешений видео (каждые 30 минут)
// Удаляет записи для несуществующих файлов
const cleanupInterval = setInterval(() => {
  const removed = cleanupResolutionCache();
  if (removed > 0) {
    logger.info('Resolution cache cleanup completed', { 
      removedEntries: removed, 
      cacheSize: getResolutionCacheSize() 
    });
  }
}, 30 * 60 * 1000); // 30 минут

// ========================================
// GRACEFUL SHUTDOWN
// ========================================

let isShuttingDown = false;

async function gracefulShutdown(signal) {
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
    
    // 3. Очищаем интервалы
    clearInterval(cleanupInterval);
    logger.info('✅ Cleanup intervals stopped');
    
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
    process.exit(0);
  } catch (e) {
    logger.error('❌ Error during shutdown:', e);
    process.exit(1);
  }
}

// Обработка сигналов завершения
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Обработка необработанных ошибок
process.on('uncaughtException', (err) => {
  logger.error('💥 Uncaught Exception:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  // Не выходим при unhandledRejection, только логируем
});
