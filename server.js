import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';

// Импорты из модулей
import { 
  ROOT, PUBLIC, DEVICES, CONVERTED_CACHE, MAX_FILE_SIZE, ALLOWED_EXT, PORT, HOST 
} from './src/config/constants.js';
import { createSocketServer } from './src/config/socket-config.js';
import { initDatabase } from './src/database/database.js';
import { 
  loadDevicesFromDB, 
  saveDevicesToDB, 
  loadFileNamesFromDB, 
  saveFileNamesToDB
} from './src/storage/devices-storage-sqlite.js';
import { getFileStatus } from './src/video/file-status.js';
import { checkVideoParameters } from './src/video/ffmpeg-wrapper.js';
import { autoOptimizeVideo } from './src/video/optimizer.js';
import { 
  findFileFolder, getPageSlideCount, autoConvertFile 
} from './src/converters/document-converter.js';
import { createDevicesRouter } from './src/routes/devices.js';
import { createPlaceholderRouter } from './src/routes/placeholder.js';
import { createFilesRouter, updateDeviceFilesFromDB } from './src/routes/files.js';
import { createVideoInfoRouter } from './src/routes/video-info.js';
import { createConversionRouter } from './src/routes/conversion.js';
import { createSystemInfoRouter } from './src/routes/system-info.js';
import { createFoldersRouter } from './src/routes/folders.js';
import { createAuthRouter } from './src/routes/auth.js';
import { createDeduplicationRouter } from './src/routes/deduplication.js';
import fileResolverRouter from './src/routes/file-resolver.js';
import { createUploadMiddleware } from './src/middleware/multer-config.js';
import { requireAuth, requireAdmin } from './src/middleware/auth.js';
import { globalLimiter, apiSpeedLimiter } from './src/middleware/rate-limit.js';
import { setupExpressMiddleware, setupStaticFiles } from './src/middleware/express-config.js';
import { setupSocketHandlers } from './src/socket/index.js';
import logger, { httpLoggerMiddleware } from './src/utils/logger.js';
import { cleanupResolutionCache, getResolutionCacheSize } from './src/video/resolution-cache.js';
import { getDatabase } from './src/database/database.js';
import { circuitBreakers } from './src/utils/circuit-breaker.js';

const app = express();
const server = http.createServer(app);
const io = createSocketServer(server);

// Создаем папки если не существуют
if (!fs.existsSync(CONVERTED_CACHE)) fs.mkdirSync(CONVERTED_CACHE, { recursive: true });
if (!fs.existsSync(DEVICES)) fs.mkdirSync(DEVICES, { recursive: true });

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

// Инициализация данных
let devices = {};
let fileNamesMap = {};

// Загружаем данные из SQLite БД
devices = loadDevicesFromDB();
fileNamesMap = loadFileNamesFromDB();

// НОВОЕ: Гибридная загрузка - файлы из БД + сканирование папок (PPTX/изображения)
const { getDeviceFilesMetadata } = await import('./src/database/files-metadata.js');

for (const deviceId in devices) {
  // 1. Загружаем файлы из БД (обычные файлы)
  const filesMetadata = getDeviceFilesMetadata(deviceId);
  let files = filesMetadata.map(f => f.safe_name);
  let fileNames = filesMetadata.map(f => f.original_name);
  
  // 2. Сканируем папку устройства для PDF/PPTX/image папок (они не в БД)
  const deviceFolder = path.join(DEVICES, devices[deviceId].folder);
  if (fs.existsSync(deviceFolder)) {
    const folderEntries = fs.readdirSync(deviceFolder);
    for (const entry of folderEntries) {
      const entryPath = path.join(deviceFolder, entry);
      const stat = fs.statSync(entryPath);
      
      if (stat.isDirectory()) {
        // Это папка - добавляем (PPTX/PDF или изображения)
        files.push(entry);
        fileNames.push(fileNamesMap[deviceId]?.[entry] || entry);
      }
    }
  }
  
  devices[deviceId].files = files;
  devices[deviceId].fileNames = fileNames;
  
  logger.info('Device files loaded (DB + folders)', { 
    deviceId, 
    dbFiles: filesMetadata.length,
    folders: files.length - filesMetadata.length,
    total: files.length
  });
}

// Сохраняем обновленное состояние в БД
saveDevicesToDB(devices);

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
  requireAdmin  // Передаем для защиты POST/DELETE
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
  getFileStatus
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

// Роутеры с избирательной защитой (применяют requireAuth внутри себя)
app.use('/api/devices', conversionRouter);  
app.use('/api/devices', foldersRouter);
app.use('/api/devices', deduplicationRouter);  // Дедупликация (check-duplicate, copy-from-duplicate)

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
import { getMetrics } from './src/utils/metrics.js';

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
setupSocketHandlers(io, { devices, getPageSlideCount });

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
    httpServer.close(() => {
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
    
    // 4. Закрываем базу данных
    closeDatabase();
    
    // 5. Ждем завершения активных запросов (макс 10 сек)
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
