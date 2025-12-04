import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';
import https from 'https';
import http from 'http';
import logger from '../utils/logger.js';
import { getStreamsOutputDir } from '../config/settings-manager.js';
import { 
  notifyDiskFull, 
  notifyStreamStartFailed,
  notifyStreamSourceUnavailable 
} from '../utils/notifications.js';

const execAsync = promisify(exec);

const STREAM_KEY_SEPARATOR = '::';

// КРИТИЧНО: Максимальный размер stderr буфера для предотвращения утечек памяти
const MAX_STDERR_BUFFER_SIZE = 10 * 1024; // 10KB

// КРИТИЧНО: outputRoot теперь вычисляется динамически из настроек БД
// Используем функцию getStreamsOutputDir() вместо константы
const DEFAULT_OPTIONS = {
  outputRoot: getStreamsOutputDir(), // Вычисляется из contentRoot в настройках
  publicBasePath: '/streams',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  segmentDuration: Number(process.env.RESTREAM_SEGMENT_DURATION || 3), // 3 секунды для более частого обновления
  playlistSize: Number(process.env.RESTREAM_PLAYLIST_SIZE || 10), // Увеличено до 10 для лучшей буферизации
  hlsDeleteThreshold: Number(process.env.RESTREAM_HLS_DELETE_THRESHOLD || 5), // Буфер сегментов сверх playlistSize перед удалением
  restartDelayMs: Number(process.env.RESTREAM_RESTART_DELAY_MS || 5000),
  // Критичные настройки для стабильности
  restartMaxAttempts: Number(process.env.STREAM_RESTART_MAX_ATTEMPTS || 5),
  restartInitialDelay: Number(process.env.STREAM_RESTART_INITIAL_DELAY || 5000),
  restartMaxDelay: Number(process.env.STREAM_RESTART_MAX_DELAY || 60000),
  circuitBreakerThreshold: Number(process.env.STREAM_CIRCUIT_BREAKER_THRESHOLD || 5),
  circuitBreakerTimeout: Number(process.env.STREAM_CIRCUIT_BREAKER_TIMEOUT || 300000),
  cleanupInterval: Number(process.env.STREAM_CLEANUP_INTERVAL || 300000), // 5 минут
  maxFolderSizeMB: Number(process.env.STREAM_MAX_FOLDER_SIZE_MB || 500),
  playlistMaxAge: Number(process.env.STREAM_PLAYLIST_MAX_AGE || 30000), // 30 секунд
  sourceCheckEnabled: process.env.STREAM_SOURCE_CHECK_ENABLED !== 'false', // По умолчанию включено
  sourceCheckTimeout: Number(process.env.STREAM_SOURCE_CHECK_TIMEOUT || 3000), // Уменьшено с 5000 до 3000 для ускорения
  maxJobs: Number(process.env.STREAM_MAX_JOBS || 100), // Максимальное количество одновременных стримов
  hungProcessTimeout: Number(process.env.STREAM_HUNG_PROCESS_TIMEOUT || 60000), // 60 секунд без активности = зависший процесс
};

function sanitizePathFragment(value = '') {
  return String(value)
    .replace(/[^a-zA-Z0-9\-_.]/g, '_')
    .substring(0, 200);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Нормализует URL стрима для корректной дедупликации
 * Убирает trailing slash, сортирует query параметры
 * @param {string} url - URL стрима
 * @returns {string} - Нормализованный URL
 */
function normalizeStreamUrl(url) {
  if (!url || typeof url !== 'string') return url;
  
  try {
    const urlObj = new URL(url.trim());
    // Нормализуем: убираем trailing slash из pathname (кроме корня)
    if (urlObj.pathname.length > 1 && urlObj.pathname.endsWith('/')) {
      urlObj.pathname = urlObj.pathname.slice(0, -1);
    }
    // Сортируем параметры query string для консистентности
    if (urlObj.search) {
      const params = new URLSearchParams(urlObj.search);
      const sortedParams = new URLSearchParams();
      // Сортируем ключи параметров
      Array.from(params.keys()).sort().forEach(key => {
        sortedParams.set(key, params.get(key));
      });
      urlObj.search = sortedParams.toString();
    }
    return urlObj.toString();
  } catch (err) {
    // Если не удалось распарсить - возвращаем как есть
    logger.warn('[StreamManager] Failed to normalize URL', { url, error: err.message });
    return url.trim();
  }
}

class StreamManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.jobs = new Map(); // Map<safeName, job> - один стрим на имя, независимо от устройства
    // КРИТИЧНО: Map для отслеживания стримов по имени с информацией об устройствах
    this.nameToJobMap = new Map(); // Map<safeName, {
    //   job: Job,                    // Основной job стрима
    //   devices: Set<deviceId>,      // Устройства, использующие стрим
    //   lastAccess: Map<deviceId, timestamp>, // Время последнего доступа для каждого устройства
    //   pending: boolean             // Флаг pending операции
    // }>
    this.nameToJobMapPending = new Map(); // Map<safeName, Promise<Job>> - pending операции по имени
    // КРИТИЧНО: Кэш результатов определения кодеков для оптимизации
    this.codecCache = new Map(); // Map<streamUrl, {codecs: {videoCodec, audioCodec}, timestamp: number}>
    this.codecCacheMaxSize = 100; // Максимум 100 записей в кэше
    this.codecCacheTTL = 10 * 60 * 1000; // TTL: 10 минут
    // КРИТИЧНО: Убраны таймауты для джобов
    // Стримы работают пока есть активные запросы от плееров (через lastAccess)
    // Останавливаются только если нет запросов больше минуты
    // Это позволяет стримам работать без ограничений по времени, пока их смотрят
    this.idleTimeout = Number(process.env.STREAM_IDLE_TIMEOUT_MS || 60000); // 60 секунд - только для проверки активности
    this.previewIdleTimeout = Number(process.env.PREVIEW_STREAM_IDLE_TIMEOUT_MS || 60000); // 60 секунд - одинаково для всех
    
    // Интервалы для очистки при shutdown
    this.idleCleanupInterval = null;
    this.segmentCleanupInterval = null;
    this.circuitBreakerCheckInterval = null;
    this.healthCheckInterval = null;
    
    // КРИТИЧНО: Флаг остановки для предотвращения повторного запуска
    this.stopped = false;
    
    // Кэш статусов файлов (TTL 2 секунды)
    this.fileStatusCache = new Map(); // Map<safeName, {exists: boolean, size: number, mtime: number, timestamp: number}>
    this.fileStatusCacheTTL = 2000; // 2 секунды
    
    // КРИТИЧНО: outputRoot теперь вычисляется динамически из настроек БД
    // Обновляем его при инициализации, чтобы использовать актуальный путь
    this.options.outputRoot = getStreamsOutputDir();
    ensureDir(this.options.outputRoot);
    logger.info('[StreamManager] Initialized', {
      outputRoot: this.options.outputRoot,
      publicBasePath: this.options.publicBasePath,
      ffmpegPath: this.options.ffmpegPath,
      idleTimeout: this.idleTimeout
    });
    
    // Запускаем периодическую проверку неиспользуемых стримов
    this._startIdleCleanup();
    
    // Запускаем периодическую очистку сегментов
    this._startSegmentCleanup();
    
    // Запускаем периодическую проверку circuit breaker
    this._startCircuitBreakerCheck();
    
    // Запускаем периодический health check для активных стримов
    this._startHealthCheck();
  }
  
  /**
   * Запускает периодическую проверку неиспользуемых стримов
   * Стрим работает, пока его смотрят (плеер запрашивает сегменты)
   * Если стрим не используется (нет запросов) - останавливается через idleTimeout
   */
  _startIdleCleanup() {
    this.idleCleanupInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [safeName, nameEntry] of this.nameToJobMap.entries()) {
        if (!nameEntry.job || nameEntry.pending) continue;
        
        const job = nameEntry.job;
        
        // Проверяем зависшие процессы через heartbeat
        if (job.status === 'running' && job.process && !job.process.killed) {
          const isProcessAlive = this._checkProcessAlive(job.process);
          if (!isProcessAlive) {
            logger.warn('[StreamManager] 🔴 FFmpeg process is dead but not detected', {
              safeName,
              pid: job.process.pid
            });
            this._restartHungProcess(job);
            continue;
          }
          
          if (job.lastSegmentWrite) {
            const timeSinceLastWrite = now - job.lastSegmentWrite;
            if (timeSinceLastWrite > this.options.hungProcessTimeout) {
              logger.warn('[StreamManager] 🔴 Detected hung FFmpeg process (no heartbeat)', {
                safeName,
                timeSinceLastWriteMs: timeSinceLastWrite,
                pid: job.process.pid
              });
              this._restartHungProcess(job);
              continue;
            }
          }
        }
        
        // КРИТИЧНО: Проверяем только активность плееров через lastAccess
        // НЕ используем таймауты - стрим работает пока есть активные запросы
        // Останавливаем только если нет запросов вообще (lastAccess отсутствует или очень старый)
        let hasActiveRequests = false;
        let mostRecentAccess = 0;
        const MAX_IDLE_TIME = 60000; // 60 секунд - если нет запросов больше минуты, считаем стрим неактивным
        
        if (nameEntry.lastAccess && nameEntry.lastAccess.size > 0) {
          for (const [deviceId, lastAccess] of nameEntry.lastAccess.entries()) {
            mostRecentAccess = Math.max(mostRecentAccess, lastAccess);
            const idleTime = now - lastAccess;
            
            // Если был запрос за последнюю минуту - стрим активен
            if (idleTime <= MAX_IDLE_TIME) {
              hasActiveRequests = true;
              break; // Достаточно одного активного запроса
            }
          }
        }
        
        // КРИТИЧНО: Останавливаем стрим только если нет активных запросов больше минуты
        // Это означает, что плееры не запрашивают плейлист/сегменты
        if (!hasActiveRequests && nameEntry.devices.size > 0) {
          const timeSinceLastAccess = mostRecentAccess > 0 ? now - mostRecentAccess : Infinity;
          
          // Останавливаем только если нет запросов больше минуты
          if (timeSinceLastAccess > MAX_IDLE_TIME) {
            logger.info('[StreamManager] 🕐 Stopping stream (no active requests)', {
              safeName,
              devices: Array.from(nameEntry.devices),
              timeSinceLastAccess,
              hasLastAccess: mostRecentAccess > 0
            });
            
            // Останавливаем стрим (будет проверка количества устройств в stopStream)
            this.stopStream(Array.from(nameEntry.devices)[0], safeName, 'no_active_requests');
          }
        } else if (hasActiveRequests) {
          // Логируем для отладки активных стримов
          logger.debug('[StreamManager] Stream is active (has requests)', {
            safeName,
            mostRecentAccess: mostRecentAccess > 0 ? now - mostRecentAccess : null,
            devices: Array.from(nameEntry.devices)
          });
        }
      }
    }, 15000); // Проверяем каждые 15 секунд (увеличено для снижения нагрузки и учета буферизации)
  }

  /**
   * Запускает периодический health check для активных стримов
   * Проверяет обновление плейлистов и состояние процессов
   */
  _startHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [safeName, job] of this.jobs.entries()) {
        if (job.status !== 'running' || !job.process || job.process.killed) {
          continue;
        }
        
        const paths = job.paths;
        
        // Проверяем, что плейлист обновляется
        if (fs.existsSync(paths.playlistPath)) {
          try {
            const stats = fs.statSync(paths.playlistPath);
            const playlistAge = Date.now() - stats.mtimeMs;
            
            // Если плейлист не обновлялся более 30 секунд - проблема
            if (playlistAge > 30000) {
              logger.warn('[StreamManager] Health check: Playlist not updating', {
                safeName,
                playlistAge,
                pid: job.process.pid
              });
              
              // Проверяем процесс
              const isAlive = this._checkProcessAlive(job.process);
              if (!isAlive) {
                logger.error('[StreamManager] Health check: Process is dead', {
                  safeName,
                  pid: job.process.pid
                });
                this._restartHungProcess(job);
              }
            }
          } catch (err) {
            logger.debug('[StreamManager] Health check error', {
              safeName,
              error: err.message
            });
          }
        } else {
          // Плейлист не существует для running процесса - проблема
          logger.warn('[StreamManager] Health check: Playlist missing for running process', {
            safeName,
            pid: job.process.pid
          });
        }
      }
    }, 10000); // Проверка каждые 10 секунд
  }

  _jobKey(deviceId, safeName) {
    return `${deviceId}${STREAM_KEY_SEPARATOR}${safeName}`;
  }

  _getPaths(safeName) {
    // КРИТИЧНО: Убрали deviceId - стримы теперь идентифицируются только по safeName
    const safeFile = sanitizePathFragment(safeName);
    const folderPath = path.join(this.options.outputRoot, safeFile);
    const playlistPath = path.join(folderPath, 'index.m3u8');
    const segmentPattern = path.join(folderPath, 'segment_%05d.ts');
    const publicUrl = `${this.options.publicBasePath}/${encodeURIComponent(safeFile)}/index.m3u8`;
    return { folderPath, playlistPath, segmentPattern, publicUrl };
  }

  /**
   * Получает кэшированный статус файла плейлиста
   * @param {string} safeName - Безопасное имя стрима
   * @returns {Object} Статус файла {exists: boolean, size: number, mtime: number, timestamp: number}
   */
  _getCachedFileStatus(safeName) {
    const cached = this.fileStatusCache.get(safeName);
    if (cached && (Date.now() - cached.timestamp) < this.fileStatusCacheTTL) {
      return cached;
    }
    
    // Обновляем кэш
    const paths = this._getPaths(safeName);
    let fileStatus = {
      exists: false,
      size: 0,
      mtime: 0,
      timestamp: Date.now()
    };
    
    try {
      if (fs.existsSync(paths.playlistPath)) {
        const stats = fs.statSync(paths.playlistPath);
        fileStatus = {
          exists: true,
          size: stats.size,
          mtime: stats.mtimeMs,
          timestamp: Date.now()
        };
      }
    } catch (err) {
      // Игнорируем ошибки
    }
    
    this.fileStatusCache.set(safeName, fileStatus);
    return fileStatus;
  }

  /**
   * Быстрая валидация HLS плейлиста
   * @param {string} playlistPath - Путь к плейлисту
   * @returns {boolean} true если плейлист валиден
   */
  _validatePlaylistQuick(playlistPath) {
    try {
      if (!fs.existsSync(playlistPath)) {
        return false;
      }
      
      const stats = fs.statSync(playlistPath);
      if (stats.size < 50) { // Минимум 50 байт для валидного плейлиста
        return false;
      }
      
      const content = fs.readFileSync(playlistPath, 'utf-8');
      
      // Базовая валидация структуры HLS
      if (!content.includes('#EXTM3U')) {
        return false;
      }
      
      // Для live стримов должен быть хотя бы один сегмент
      if (content.includes('#EXT-X-ENDLIST')) {
        // VOD плейлист - должен иметь сегменты
        return content.includes('#EXTINF');
      } else {
        // Live плейлист - должен иметь сегменты или быть в процессе создания
        return content.includes('#EXTINF') || content.includes('#EXT-X-MEDIA-SEQUENCE');
      }
    } catch (err) {
      logger.debug('[StreamManager] Playlist validation error', {
        playlistPath,
        error: err.message
      });
      return false;
    }
  }

  /**
   * Определяет кодеки исходного потока через ffprobe
   * @param {string} streamUrl - URL исходного потока
   * @returns {Promise<{videoCodec: string, audioCodec: string}>}
   */
  async _detectStreamCodecs(streamUrl, streamProtocol = null) {
    // КРИТИЧНО: Проверяем кэш перед вызовом ffprobe
    const cached = this.codecCache.get(streamUrl);
    if (cached) {
      const age = Date.now() - cached.timestamp;
      if (age < this.codecCacheTTL) {
        logger.debug('[StreamManager] Using cached codec detection result', {
          streamUrl,
          age: Math.round(age / 1000),
          ...cached.codecs
        });
        return cached.codecs;
      } else {
        // Кэш устарел - удаляем
        this.codecCache.delete(streamUrl);
      }
    }
    
    // КРИТИЧНО: Для DASH стримов (.mpd) требуется больше времени на инициализацию
    // FFprobe должен прочитать манифест и выбрать представление для анализа
    const isDash = streamProtocol === 'dash' || streamUrl.toLowerCase().includes('.mpd');
    // Оптимизация: уменьшаем таймаут для всех стримов для ускорения запуска
    // Но внутри _detectStreamCodecs будет еще более короткий таймаут через Promise.race
    const timeout = isDash ? 10000 : 2000; // 10 секунд для DASH, 2 для остальных (было 15 и 5)
    // ПРИМЕЧАНИЕ: Этот таймаут может не использоваться, если вызван с Promise.race с более коротким таймаутом
    
    try {
      logger.info('[StreamManager] Detecting stream codecs', {
        streamUrl,
        streamProtocol,
        isDash,
        timeout
      });
      
      // Для DASH стримов используем специальные параметры ffprobe
      let ffprobeCmd = `ffprobe -v error -show_streams -of json`;
      if (isDash) {
        // Для DASH добавляем параметры для работы с адаптивными потоками
        ffprobeCmd += ` -select_streams v:0,a:0`; // Выбираем первое видео и аудио представление
      }
      ffprobeCmd += ` "${streamUrl}"`;
      
      const { stdout } = await execAsync(
        ffprobeCmd,
        { timeout, maxBuffer: 1024 * 1024 * 2 } // Увеличиваем буфер для DASH
      );
      
      const data = JSON.parse(stdout);
      const streams = data.streams || [];
      
      const videoStream = streams.find(s => s.codec_type === 'video');
      const audioStream = streams.find(s => s.codec_type === 'audio');
      
      const result = {
        videoCodec: videoStream?.codec_name || 'unknown',
        audioCodec: audioStream?.codec_name || 'unknown'
      };
      
      // КРИТИЧНО: Сохраняем результат в кэш
      this._updateCodecCache(streamUrl, result);
      
      logger.info('[StreamManager] Codecs detected successfully', {
        streamUrl,
        ...result
      });
      
      return result;
    } catch (error) {
      logger.warn('[StreamManager] Failed to detect codecs, will transcode', {
        streamUrl,
        streamProtocol,
        isDash,
        error: error.message,
        errorCode: error.code
      });
      // В случае ошибки возвращаем unknown, что приведет к перекодированию
      // Это не блокирует запуск FFmpeg - он просто будет перекодировать
      return { videoCodec: 'unknown', audioCodec: 'unknown' };
    }
  }

  /**
   * Обновляет кэш результатов определения кодеков
   * @param {string} streamUrl - URL стрима
   * @param {Object} codecs - Результат определения кодеков
   */
  _updateCodecCache(streamUrl, codecs) {
    // Очищаем устаревшие записи, если кэш переполнен
    if (this.codecCache.size >= this.codecCacheMaxSize) {
      const now = Date.now();
      for (const [url, entry] of this.codecCache.entries()) {
        if (now - entry.timestamp > this.codecCacheTTL) {
          this.codecCache.delete(url);
        }
      }
      
      // Если все еще переполнен - удаляем самые старые записи
      if (this.codecCache.size >= this.codecCacheMaxSize) {
        const entries = Array.from(this.codecCache.entries())
          .sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toDelete = Math.floor(this.codecCacheMaxSize * 0.2); // Удаляем 20% самых старых
        for (let i = 0; i < toDelete; i++) {
          this.codecCache.delete(entries[i][0]);
        }
      }
    }
    
    // Сохраняем новую запись
    this.codecCache.set(streamUrl, {
      codecs,
      timestamp: Date.now()
    });
  }

  /**
   * Определяет, нужно ли перекодировать кодек для совместимости с браузерами
   * @param {string} codec - Название кодека
   * @param {'video'|'audio'} type - Тип потока
   * @returns {boolean}
   */
  _needsTranscoding(codec, type) {
    if (type === 'video') {
      // Браузеры поддерживают только H.264 в HLS
      const supportedVideoCodecs = ['h264', 'libx264', 'avc'];
      return !supportedVideoCodecs.includes(codec?.toLowerCase());
    } else if (type === 'audio') {
      // Браузеры поддерживают AAC в HLS
      const supportedAudioCodecs = ['aac', 'mp4a'];
      return !supportedAudioCodecs.includes(codec?.toLowerCase());
    }
    return true; // По умолчанию перекодируем
  }

  /**
   * Экстренная очистка всех стримов при переполнении диска
   */
  _emergencyCleanupAllStreams() {
    logger.warn('[StreamManager] 🚨 Starting emergency cleanup of ALL streams due to disk full');
    
    let cleanedCount = 0;
    for (const [key, job] of this.jobs.entries()) {
      if (!job.paths || !job.paths.folderPath) continue;
      
      try {
        this._emergencyCleanupOnDiskFull(job.paths.folderPath);
        cleanedCount++;
      } catch (error) {
        logger.error('[StreamManager] Failed to emergency cleanup stream', {
          deviceId: job.deviceId,
          safeName: job.safeName,
          error: error.message
        });
      }
    }
    
    logger.warn('[StreamManager] ✅ Emergency cleanup of all streams completed', {
      cleanedCount,
      totalStreams: this.jobs.size
    });
  }

  /**
   * Экстренная очистка при переполнении диска: удаляет все файлы кроме m3u8 и последних 3 ts файлов
   * @param {string} folderPath - Путь к папке стрима
   */
  _emergencyCleanupOnDiskFull(folderPath) {
    try {
      if (!fs.existsSync(folderPath)) {
        logger.debug('[StreamManager] Folder does not exist for emergency cleanup', { folderPath });
        return;
      }

      logger.warn('[StreamManager] 🚨 EMERGENCY CLEANUP: Removing all files except m3u8 and last 3 ts files', { folderPath });

      const files = fs.readdirSync(folderPath);
      
      // Собираем все .ts файлы с информацией о времени модификации
      const tsFiles = files
        .filter(f => f.endsWith('.ts'))
        .map(f => {
          try {
            const filePath = path.join(folderPath, f);
            const stats = fs.statSync(filePath);
            return {
              name: f,
              path: filePath,
              size: stats.size,
              mtime: stats.mtimeMs
            };
          } catch (err) {
            return null;
          }
        })
        .filter(f => f !== null)
        .sort((a, b) => b.mtime - a.mtime); // Сортируем по времени (новые первыми)

      let deletedCount = 0;
      let freedBytes = 0;

      // Удаляем все .ts файлы кроме последних 3
      const toDelete = tsFiles.slice(3); // Все файлы после первых 3
      for (const file of toDelete) {
        try {
          fs.unlinkSync(file.path);
          deletedCount++;
          freedBytes += file.size;
        } catch (err) {
          logger.warn('[StreamManager] Failed to delete file during emergency cleanup', {
            file: file.path,
            error: err.message
          });
        }
      }

      // Удаляем все остальные файлы (кроме m3u8)
      for (const file of files) {
        if (file.endsWith('.ts') || file.endsWith('.m3u8')) {
          continue; // Пропускаем .ts (уже обработали) и .m3u8 (сохраняем)
        }

        const filePath = path.join(folderPath, file);
        try {
          const stats = fs.lstatSync(filePath);
          if (stats.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          } else if (stats.isSymbolicLink()) {
            fs.unlinkSync(filePath);
          } else {
            fs.unlinkSync(filePath);
          }
          deletedCount++;
          if (stats.isFile()) {
            freedBytes += stats.size;
          }
        } catch (err) {
          logger.warn('[StreamManager] Failed to delete non-ts file during emergency cleanup', {
            file: filePath,
            error: err.message
          });
        }
      }

      logger.warn('[StreamManager] ✅ Emergency cleanup completed', {
        folderPath,
        deletedCount,
        freedMB: Math.round(freedBytes / 1024 / 1024),
        remainingTsFiles: Math.min(tsFiles.length, 3)
      });
    } catch (error) {
      logger.error('[StreamManager] ❌ Failed to perform emergency cleanup', {
        folderPath,
        error: error.message,
        stack: error.stack
      });
    }
  }

  _cleanupFolder(folderPath) {
    try {
      if (fs.existsSync(folderPath)) {
        // КРИТИЧНО: Сначала удаляем ВСЕ файлы вручную, чтобы освободить их
        // Это важно, так как они могут быть заблокированы FFmpeg процессом
        try {
          const files = fs.readdirSync(folderPath);
          for (const file of files) {
            const filePath = path.join(folderPath, file);
            try {
              // Удаляем все файлы, не только .ts и .m3u8
              const stats = fs.lstatSync(filePath);
              if (stats.isDirectory()) {
                // Если это папка - удаляем рекурсивно
                fs.rmSync(filePath, { recursive: true, force: true });
              } else if (stats.isSymbolicLink()) {
                // Если это симлинк - удаляем только ссылку
                fs.unlinkSync(filePath);
              } else {
                // Обычный файл - удаляем
                fs.unlinkSync(filePath);
              }
              logger.debug('[StreamManager] Удален файл/папка', { filePath, file });
            } catch (e) {
              logger.warn('[StreamManager] Не удалось удалить файл', { filePath, error: e.message });
            }
          }
        } catch (e) {
          logger.warn('[StreamManager] Ошибка при удалении отдельных файлов', { error: e.message });
        }
        
        // КРИТИЧНО: Проверяем, является ли плейлист симлинком
        const playlistPath = path.join(folderPath, 'index.m3u8');
        if (fs.existsSync(playlistPath)) {
          try {
            const stats = fs.lstatSync(playlistPath);
            if (stats.isSymbolicLink()) {
              // Это симлинк - удаляем только симлинк, не целевой файл
              fs.unlinkSync(playlistPath);
              logger.debug('[StreamManager] Removed symlink', { playlistPath });
            } else {
              // Обычный файл - удаляем
              fs.unlinkSync(playlistPath);
              logger.debug('[StreamManager] Removed m3u8 file', { playlistPath });
            }
          } catch (e) {
            logger.warn('[StreamManager] Ошибка при удалении m3u8', { playlistPath, error: e.message });
          }
        }
        
        // КРИТИЧНО: Удаляем все файлы и папку рекурсивно
        // Для симлинков это безопасно - удалится только симлинк, не целевой файл
        try {
          fs.rmSync(folderPath, { recursive: true, force: true });
          logger.info('[StreamManager] Cleaned up stream folder', { folderPath });
          
          // Проверяем через небольшую задержку, что папка действительно удалена
          setTimeout(() => {
            if (fs.existsSync(folderPath)) {
              logger.warn('[StreamManager] Folder still exists after rmSync, retrying cleanup', { folderPath });
              // Повторная попытка удаления всех файлов и папки
              try {
                const remainingFiles = fs.readdirSync(folderPath);
                for (const file of remainingFiles) {
                  const filePath = path.join(folderPath, file);
                  try {
                    fs.unlinkSync(filePath);
                  } catch (e) {
                    logger.warn('[StreamManager] Failed to delete file on retry', { filePath, error: e.message });
                  }
                }
                fs.rmSync(folderPath, { recursive: true, force: true });
                logger.info('[StreamManager] Folder cleaned up on retry', { folderPath });
              } catch (retryErr) {
                logger.error('[StreamManager] Failed to cleanup folder on retry', { folderPath, error: retryErr.message });
              }
            }
          }, 500);
        } catch (rmErr) {
          logger.warn('[StreamManager] rmSync failed, trying alternative cleanup', { folderPath, error: rmErr.message });
          throw rmErr; // Пробрасываем ошибку для fallback логики
        }
      }
    } catch (err) {
      logger.warn('[StreamManager] Failed to cleanup folder', { folderPath, error: err.message, stack: err.stack });
      // Пробуем удалить файлы по одному, если рекурсивное удаление не сработало
      try {
        if (fs.existsSync(folderPath)) {
          const files = fs.readdirSync(folderPath);
          for (const file of files) {
            const filePath = path.join(folderPath, file);
            try {
              // Проверяем, является ли файл симлинком
              const stats = fs.lstatSync(filePath);
              if (stats.isSymbolicLink()) {
                fs.unlinkSync(filePath); // Удаляем только симлинк
              } else {
                fs.unlinkSync(filePath); // Удаляем обычный файл
              }
              logger.debug('[StreamManager] Удален файл (fallback)', { filePath });
            } catch (e) {
              logger.warn('[StreamManager] Failed to delete file', { filePath, error: e.message });
            }
          }
          // Пробуем удалить папку
          try {
            fs.rmdirSync(folderPath);
          } catch (e) {
            // Игнорируем ошибку, если папка не пуста
            logger.debug('[StreamManager] Не удалось удалить папку (возможно не пуста)', { folderPath });
          }
        }
      } catch (e) {
        logger.error('[StreamManager] Failed to cleanup folder (fallback)', { folderPath, error: e.message });
      }
    }
  }

  async _spawnJob(meta) {
    const { device_id, safe_name, stream_url, stream_protocol } = meta;
    
    logger.info('[StreamManager] _spawnJob called', {
      deviceId: device_id,
      safeName: safe_name,
      streamUrl: stream_url,
      streamProtocol: stream_protocol
    });
    
    if (!stream_url) {
      logger.error('[StreamManager] Missing stream_url, skip restream', { device_id, safe_name });
      return null;
    }

      const safeNameSanitized = sanitizePathFragment(safe_name);
      const paths = this._getPaths(safeNameSanitized);
    
    logger.info('[StreamManager] Preparing stream folder', {
      deviceId: device_id,
      safeName: safe_name,
      folderPath: paths.folderPath,
      playlistPath: paths.playlistPath,
      outputRoot: this.options.outputRoot
    });
    
    // КРИТИЧНО: Удаляем старые файлы перед запуском нового стрима
    // Это предотвращает воспроизведение старых сегментов
    logger.info('[StreamManager] Очистка старой директории стрима', {
      deviceId: device_id,
      safeName: safe_name,
      folderPath: paths.folderPath,
      existsBefore: fs.existsSync(paths.folderPath)
    });
    this._cleanupFolder(paths.folderPath);
    
    // КРИТИЧНО: Дополнительная проверка - убеждаемся что все файлы удалены
    // Ждем немного, чтобы файловая система успела обработать удаление
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Проверяем, что папка действительно пуста или не существует
    let retryCount = 0;
    const maxRetries = 5;
    while (fs.existsSync(paths.folderPath) && retryCount < maxRetries) {
      const remainingFiles = fs.readdirSync(paths.folderPath);
      if (remainingFiles.length === 0) {
        // Папка пуста, можно удалить
        try {
          fs.rmdirSync(paths.folderPath);
          logger.debug('[StreamManager] Удалена пустая папка', { folderPath: paths.folderPath });
        } catch (e) {
          // Игнорируем ошибку, если папка не пуста или заблокирована
          logger.debug('[StreamManager] Не удалось удалить папку', { folderPath: paths.folderPath, error: e.message });
        }
        break;
      }
      
      logger.warn('[StreamManager] Обнаружены оставшиеся файлы после очистки, удаляем вручную', {
        deviceId: device_id,
        safeName: safe_name,
        folderPath: paths.folderPath,
        files: remainingFiles,
        retry: retryCount + 1
      });
      
      // Удаляем оставшиеся файлы вручную
      for (const file of remainingFiles) {
        try {
          const filePath = path.join(paths.folderPath, file);
          fs.unlinkSync(filePath);
          logger.debug('[StreamManager] Удален оставшийся файл', { filePath, file });
        } catch (e) {
          logger.warn('[StreamManager] Не удалось удалить файл', { file, filePath: path.join(paths.folderPath, file), error: e.message });
        }
      }
      
      retryCount++;
      if (retryCount < maxRetries) {
        // Ждем перед следующей попыткой
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Финальная проверка
    if (fs.existsSync(paths.folderPath)) {
      const finalFiles = fs.readdirSync(paths.folderPath);
      if (finalFiles.length > 0) {
        logger.error('[StreamManager] КРИТИЧНО: Не удалось удалить все файлы перед запуском FFmpeg', {
          deviceId: device_id,
          safeName: safe_name,
          folderPath: paths.folderPath,
          remainingFiles: finalFiles
        });
      }
    }
    
    // КРИТИЧНО: Создаем папку для стрима
    try {
      ensureDir(paths.folderPath);
      logger.info('[StreamManager] Stream folder created/verified', {
        deviceId: device_id,
        safeName: safe_name,
        folderPath: paths.folderPath,
        exists: fs.existsSync(paths.folderPath),
        isEmpty: fs.existsSync(paths.folderPath) ? fs.readdirSync(paths.folderPath).length === 0 : true
      });
    } catch (err) {
      // КРИТИЧНО: Обрабатываем ошибки переполнения диска
      if (err.code === 'ENOSPC' || err.message.includes('No space left on device')) {
        logger.error('[StreamManager] 🚨 DISK FULL ERROR while creating stream folder, triggering emergency cleanup', {
          deviceId: device_id,
          safeName: safe_name,
          folderPath: paths.folderPath,
          error: err.message,
          errorCode: err.code
        });
        
        // Отправляем уведомление админу
        notifyDiskFull({
          deviceId: device_id,
          safeName: safe_name,
          folderPath: paths.folderPath,
          error: err.message,
          errorCode: err.code
        });
        
        // Экстренная очистка всех стримов для освобождения места
        this._emergencyCleanupAllStreams();
        
        // Пробуем создать папку еще раз после очистки
        try {
          ensureDir(paths.folderPath);
          logger.info('[StreamManager] Stream folder created after emergency cleanup', {
            deviceId: device_id,
            safeName: safe_name,
            folderPath: paths.folderPath
          });
        } catch (retryErr) {
          logger.error('[StreamManager] Failed to create stream folder even after emergency cleanup', {
            deviceId: device_id,
            safeName: safe_name,
            folderPath: paths.folderPath,
            error: retryErr.message,
            errorCode: retryErr.code
          });
          throw retryErr;
        }
      } else {
        logger.error('[StreamManager] Failed to create stream folder', {
          deviceId: device_id,
          safeName: safe_name,
          folderPath: paths.folderPath,
          error: err.message,
          errorCode: err.code
        });
        throw err; // Не продолжаем, если не можем создать папку
      }
    }

    // КРИТИЧНО: Для DASH стримов определение кодеков может быть проблематичным
    // FFprobe может не успеть прочитать манифест или выбрать представление
    // Пробуем определить кодеки, но с увеличенным таймаутом и fallback на перекодирование
    const isDash = stream_protocol === 'dash' || stream_url.toLowerCase().includes('.mpd');
    
    let videoCodec = 'unknown';
    let audioCodec = 'unknown';
    let needsVideoTranscode = true; // По умолчанию перекодируем
    let needsAudioTranscode = true;
    
    // Оптимизация: Определяем кодеки с коротким таймаутом для ускорения запуска
    // Если определение не успело - просто перекодируем (это fallback, и это быстрее чем ждать)
    const codecDetectionTimeout = isDash ? 3000 : 1500; // 3 сек для DASH, 1.5 сек для остальных (было 10 и 2)
    
    try {
      const codecs = await Promise.race([
        this._detectStreamCodecs(stream_url, stream_protocol),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Codec detection timeout')), codecDetectionTimeout)
        )
      ]);
      
      videoCodec = codecs.videoCodec;
      audioCodec = codecs.audioCodec;
      
      // КРИТИЧНО: Для DASH стримов проверяем, что кодеки действительно определены
      // Если unknown - перекодируем
      if (isDash && (videoCodec === 'unknown' || audioCodec === 'unknown')) {
        logger.info('[StreamManager] DASH stream codecs not detected, will transcode', {
          deviceId: device_id,
          safeName: safe_name,
          videoCodec,
          audioCodec
        });
        // Оставляем needsVideoTranscode и needsAudioTranscode = true
      } else {
        needsVideoTranscode = this._needsTranscoding(videoCodec, 'video');
        needsAudioTranscode = this._needsTranscoding(audioCodec, 'audio');
      }
    } catch (err) {
      // Определение кодеков не успело или упало - перекодируем (быстрее чем ждать)
      logger.info('[StreamManager] Codec detection timeout/failed, will transcode for faster startup', {
        deviceId: device_id,
        safeName: safe_name,
        isDash,
        error: err.message
      });
      // needsVideoTranscode и needsAudioTranscode уже = true по умолчанию - перекодируем
    }

    logger.info('[StreamManager] Stream codecs detected', {
      deviceId: device_id,
      safeName: safe_name,
      videoCodec,
      audioCodec,
      needsVideoTranscode,
      needsAudioTranscode
    });

    // КРИТИЧНО: НЕ используем 'append_list' - это заставляет FFmpeg продолжать с существующего плейлиста
    // Вместо этого используем только 'delete_segments' для автоматической очистки старых сегментов
    // Это гарантирует, что FFmpeg создаст новый плейлист с нуля при каждом запуске
    const hlsFlags = [
      'delete_segments',  // Удаляем старые сегменты автоматически
      'program_date_time', // Добавляем дату/время для каждого сегмента
      'independent_segments', // Сегменты независимы (для лучшей совместимости)
      'omit_endlist'     // КРИТИЧНО: Не добавляем #EXT-X-ENDLIST для live стримов
    ];

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-fflags', '+genpts',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2'
    ];
    
    // КРИТИЧНО: Для DASH стримов добавляем специальные параметры
    if (isDash) {
      // Для DASH стримов FFmpeg должен правильно обработать манифест
      // ВАЖНО: -http_persistent удален из FFmpeg, используем только поддерживаемые опции
      args.push(
        '-multiple_requests', '1',       // Разрешаем множественные запросы для адаптивного битрейта
        '-user_agent', 'FFmpeg/VideoControl', // Указываем User-Agent
        '-seekable', '0'                 // Отключаем seek для live стримов
        // КРИТИЧНО: -http_persistent удален, так как не поддерживается в новых версиях FFmpeg
      );
      logger.info('[StreamManager] Using DASH-specific input parameters', { 
        deviceId: device_id, 
        safeName: safe_name,
        streamUrl: stream_url,
        videoCodec,
        audioCodec,
        needsVideoTranscode,
        needsAudioTranscode
      });
    }
    
    args.push('-i', stream_url);

    // Видео: копируем если H.264, иначе перекодируем
    if (needsVideoTranscode) {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '23',
        '-g', '50',
        '-sc_threshold', '0'
      );
      logger.info('[StreamManager] Video will be transcoded to H.264', { deviceId: device_id, safeName: safe_name, fromCodec: videoCodec });
    } else {
      args.push('-c:v', 'copy');
      logger.info('[StreamManager] Video will be copied (already H.264)', { deviceId: device_id, safeName: safe_name });
    }

    // Аудио: копируем если AAC, иначе перекодируем
    if (needsAudioTranscode) {
      args.push(
        '-c:a', 'aac',
        '-b:a', '128k'
      );
      logger.info('[StreamManager] Audio will be transcoded to AAC', { deviceId: device_id, safeName: safe_name, fromCodec: audioCodec });
    } else {
      args.push('-c:a', 'copy');
      logger.info('[StreamManager] Audio will be copied (already AAC)', { deviceId: device_id, safeName: safe_name });
    }

    args.push(
      '-f', 'hls',
      '-hls_time', String(this.options.segmentDuration),
      '-hls_list_size', String(this.options.playlistSize),
      '-hls_delete_threshold', String(this.options.hlsDeleteThreshold), // Буфер сегментов сверх playlistSize перед удалением
      '-hls_flags', hlsFlags.join('+'),
      '-hls_segment_filename', paths.segmentPattern,
      '-hls_playlist_type', 'event', // КРИТИЧНО: Указываем тип плейлиста как EVENT для live стримов
      '-hls_allow_cache', '0', // КРИТИЧНО: Отключаем кеширование для live стримов
      '-hls_start_number_source', 'epoch', // КРИТИЧНО: Используем epoch для уникальной нумерации при каждом запуске
      '-hls_segment_type', 'mpegts', // Явно указываем тип сегментов
      '-hls_base_url', '', // Пустой base URL для относительных путей
      paths.playlistPath
    );

    // КРИТИЧНО: Логируем полную команду FFmpeg для отладки
    logger.info('[StreamManager] Starting FFmpeg with args', {
      deviceId: device_id,
      safeName: safe_name,
      streamUrl: stream_url,
      isDash,
      ffmpegPath: this.options.ffmpegPath,
      args: args.join(' ')
    });
    
    const child = spawn(this.options.ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    
    // КРИТИЧНО: Собираем stderr для логирования ошибок FFmpeg
    let stderrBuffer = '';
    
    const job = {
      deviceId: device_id,
      safeName: safeNameSanitized,
      process: child,
      sourceUrl: stream_url,
      protocol: stream_protocol || 'auto',
      paths,
      status: 'starting',
      restarts: 0,
      stopping: false,
      lastError: null,
      lastErrorType: null, // Тип последней ошибки (network, codec, source_ended, unknown)
      startedAt: Date.now(),
      lastPlaylistUpdate: null, // Время последнего обновления плейлиста
      lastSegmentWrite: null, // КРИТИЧНО: Время последней записи сегмента (heartbeat для детекции зависаний)
      circuitBreakerState: 'closed', // КРИТИЧНО: Состояние circuit breaker: 'closed' | 'open' | 'halfOpen'
      circuitBreakerOpenTime: null, // Время открытия circuit breaker
      consecutiveFailures: 0, // Количество последовательных неудач
      emergencyCleanupTriggered: false // Флаг экстренной очистки при переполнении диска
    };

      // КРИТИЧНО: Обрабатываем stderr для отслеживания статуса и сбора ошибок
      // Периодически очищаем буфер для предотвращения утечек памяти
      let stderrLastCleanup = Date.now();
      const stderrCleanupInterval = 60000; // Очищаем каждую минуту
      
      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderrBuffer += chunk;
        
        // КРИТИЧНО: Отслеживаем ошибки переполнения диска (ENOSPC)
        const chunkLower = chunk.toLowerCase();
        const isDiskFullError = chunkLower.includes('no space left on device') || 
                               chunkLower.includes('enospc') ||
                               chunkLower.includes('disk full') ||
                               chunkLower.includes('недостаточно места') ||
                               chunkLower.includes('недостаточно места на диске');
        
        if (isDiskFullError && !job.emergencyCleanupTriggered) {
          job.emergencyCleanupTriggered = true;
          logger.error('[StreamManager] 🚨 DISK FULL ERROR detected in FFmpeg stderr, triggering emergency cleanup', {
            deviceId: device_id,
            safeName: safe_name,
            chunk: chunk.substring(0, 500)
          });
          
          // Отправляем уведомление админу
          notifyDiskFull({
            deviceId: device_id,
            safeName: safe_name,
            streamUrl: stream_url,
            error: 'Переполнение диска обнаружено в stderr FFmpeg',
            chunk: chunk.substring(0, 500)
          });
          
          // Экстренная очистка всех стримов для освобождения места
          this._emergencyCleanupAllStreams();
          
          // Экстренная очистка текущего стрима
          if (job.paths && job.paths.folderPath) {
            this._emergencyCleanupOnDiskFull(job.paths.folderPath);
          }
        }
        
        // КРИТИЧНО: Ограничиваем размер буфера для предотвращения утечек памяти
        // Периодически очищаем старые данные, оставляя только последние 10KB
        const now = Date.now();
        if (stderrBuffer.length > MAX_STDERR_BUFFER_SIZE || 
            (now - stderrLastCleanup > stderrCleanupInterval && stderrBuffer.length > 5000)) {
          // Оставляем последние 10KB буфера
          stderrBuffer = stderrBuffer.substring(stderrBuffer.length - MAX_STDERR_BUFFER_SIZE);
          stderrLastCleanup = now;
          logger.debug('[StreamManager] Cleaned stderr buffer', {
            deviceId: device_id,
            safeName: safe_name,
            remainingSize: stderrBuffer.length
          });
        }
      
      // Обновляем статус при первом выводе (FFmpeg начал работу)
      if (job.status === 'starting') {
        job.status = 'running';
        job.lastPlaylistUpdate = Date.now();
        // КРИТИЧНО: При успешном запуске сбрасываем счетчики и очищаем stderr буфер
        job.consecutiveFailures = 0;
        job.emergencyCleanupTriggered = false; // Сбрасываем флаг экстренной очистки
        stderrBuffer = ''; // Очищаем буфер при успешном запуске для предотвращения утечек памяти
        if (job.circuitBreakerState !== 'closed') {
          const previousState = job.circuitBreakerState;
          job.circuitBreakerState = 'closed';
          job.circuitBreakerOpenTime = null;
          logger.info('[StreamManager] Circuit breaker closed after successful start', {
            deviceId: job.deviceId,
            safeName: job.safeName,
            previousState
          });
        }
        this.emit('stream:running', { deviceId: job.deviceId, safeName: job.safeName });
        logger.info('[StreamManager] FFmpeg started successfully', {
          deviceId: device_id,
          safeName: safe_name,
          isDash
        });
      }
      
      // КРИТИЧНО: Обновляем время последнего обновления плейлиста при создании сегментов
      // Ищем паттерны создания сегментов в stderr
      if (chunk.includes('Opening') && chunk.includes('.ts')) {
        const now = Date.now();
        job.lastPlaylistUpdate = now;
        job.lastSegmentWrite = now; // КРИТИЧНО: Heartbeat для детекции зависаний
      }
      
      // Также обновляем при записи сегментов
      if (chunk.includes('segment_') && chunk.includes('.ts')) {
        const now = Date.now();
        job.lastPlaylistUpdate = now;
        job.lastSegmentWrite = now; // КРИТИЧНО: Heartbeat для детекции зависаний
      }
      
      // КРИТИЧНО: Обновляем heartbeat при любых признаках активности FFmpeg
      // Паттерны активности: frame=, time=, size=
      if (chunk.match(/\b(frame|time|size)=/i)) {
        job.lastSegmentWrite = Date.now();
      }
      
      // Логируем первые сообщения для отладки
      if (stderrBuffer.length < 5000) {
        logger.debug('[StreamManager] FFmpeg stderr', {
          deviceId: device_id,
          safeName: safe_name,
          chunk: chunk.substring(0, 200)
        });
      }
    });

    child.on('error', (err) => {
      job.lastError = err.message;
      
      // КРИТИЧНО: Обрабатываем ошибки переполнения диска
      if (err.code === 'ENOSPC' || err.message.includes('No space left on device')) {
        logger.error('[StreamManager] 🚨 DISK FULL ERROR in FFmpeg spawn, triggering emergency cleanup', {
          deviceId: device_id,
          safeName: safe_name,
          error: err.message,
          errorCode: err.code
        });
        
        // Отправляем уведомление админу
        notifyDiskFull({
          deviceId: device_id,
          safeName: safe_name,
          streamUrl: stream_url,
          error: err.message,
          errorCode: err.code
        });
        
        // Экстренная очистка всех стримов для освобождения места
        this._emergencyCleanupAllStreams();
        
        // Экстренная очистка текущего стрима
        if (job.paths && job.paths.folderPath) {
          this._emergencyCleanupOnDiskFull(job.paths.folderPath);
        }
      }
      
      logger.error('[StreamManager] ffmpeg spawn error', {
        deviceId: device_id,
        safeName: safe_name,
        streamUrl: stream_url,
        isDash,
        error: err.message,
        errorCode: err.code,
        stderr: stderrBuffer.substring(0, 1000)
      });
    });

    child.on('exit', (code, signal) => {
      const wasStopping = job.stopping;
      
      // КРИТИЧНО: Очищаем обработчики событий процесса для предотвращения утечек памяти
      try {
        if (child.stderr) {
          child.stderr.removeAllListeners('data');
        }
        child.removeAllListeners('error');
        // Не удаляем обработчик 'exit' здесь, так как мы внутри него
      } catch (err) {
        logger.debug('[StreamManager] Error removing event listeners', { error: err.message });
      }
      
      job.process = null;
      job.status = 'stopped';
      
      // КРИТИЧНО: НЕ удаляем из nameToJobMap при завершении процесса, если стрим используется
      // Это позволяет перезапустить стрим, если он еще нужен
      const safeName = job.safeName;
      const nameEntry = this.nameToJobMap.get(safeName);
      
      // КРИТИЧНО: Проверяем, используется ли стрим перед удалением
      const now = Date.now();
      // КРИТИЧНО: Проверяем активность через lastAccess (60 секунд)
      const MAX_IDLE_TIME = 60000; // 60 секунд
      const isStreamInUse = nameEntry && (
        nameEntry.devices.size > 0 || 
        (nameEntry.lastAccess && nameEntry.lastAccess.has('_direct') && 
         (now - nameEntry.lastAccess.get('_direct')) < MAX_IDLE_TIME)
      );
      
      if (wasStopping) {
        // При ручной остановке удаляем запись только если стрим не используется
        if (nameEntry) {
          if (!isStreamInUse) {
            this._cleanupFolder(job.paths.folderPath);
            this.nameToJobMap.delete(safeName);
            this.jobs.delete(safeName);
          } else {
            // Стрим используется - оставляем запись, но очищаем job
            logger.info('[StreamManager] Stream in use, keeping entry after manual stop', {
              safeName,
              devices: Array.from(nameEntry.devices)
            });
            nameEntry.job = null; // Очищаем job, но оставляем entry
            this.jobs.delete(safeName);
          }
        }
        // КРИТИЧНО: Удаляем job и очищаем файлы при остановке
        this.jobs.delete(safeName);
        this._cleanupFolder(job.paths.folderPath);
        this.emit('stream:stopped', { deviceId: job.deviceId, safeName: job.safeName, code, signal });
        logger.info('[StreamManager] FFmpeg process exited, files cleaned', { 
          deviceId: job.deviceId, 
          safeName: job.safeName, 
          code, 
          signal 
        });
        return;
      }

      // КРИТИЧНО: Классифицируем ошибку для умных перезапусков
      const errorType = this._classifyError(code, signal, stderrBuffer);
      job.lastError = `ffmpeg exited (code=${code}, signal=${signal})`;
      job.lastErrorType = errorType;
      job.consecutiveFailures += 1;
      
      logger.warn('[StreamManager] ffmpeg exited unexpectedly', {
        deviceId: job.deviceId,
        safeName: job.safeName,
        streamUrl: job.sourceUrl,
        code,
        signal,
        errorType,
        consecutiveFailures: job.consecutiveFailures,
        stderr: stderrBuffer.substring(0, 2000) // Последние 2000 символов stderr
      });

      // КРИТИЧНО: Проверяем, используется ли стрим перед принятием решения о перезапуске
      // Если стрим используется - всегда пытаемся перезапустить, даже если circuit breaker открыт
      if (isStreamInUse) {
        logger.info('[StreamManager] Stream is in use, will attempt restart despite errors', {
          deviceId: job.deviceId,
          safeName: job.safeName,
          devices: nameEntry ? Array.from(nameEntry.devices) : [],
          hasDirectAccess: nameEntry?.lastAccess?.has('_direct')
        });
        // Сбрасываем circuit breaker если стрим используется
        job.circuitBreakerState = 'halfOpen';
        job.consecutiveFailures = 0;
      }
      
      // КРИТИЧНО: Проверяем, нужно ли перезапускать
      if (!this._shouldRestart(job)) {
        logger.warn('[StreamManager] Stream restart blocked', {
          deviceId: job.deviceId,
          safeName: job.safeName,
          reason: job.circuitBreakerState === 'open' ? 'circuit_breaker' : 'max_attempts_reached',
          circuitBreakerState: job.circuitBreakerState,
          restarts: job.restarts,
          consecutiveFailures: job.consecutiveFailures,
          isStreamInUse
        });
        
        // КРИТИЧНО: Если стрим используется - НЕ удаляем запись, чтобы можно было перезапустить позже
        if (!isStreamInUse) {
          this.jobs.delete(safeName);
          const nameEntry = this.nameToJobMap.get(safeName);
          if (nameEntry) {
            this.nameToJobMap.delete(safeName);
          }
          this._cleanupFolder(job.paths.folderPath);
        } else {
          // Оставляем запись для возможного перезапуска
          logger.info('[StreamManager] Keeping stream entry for possible restart', {
            safeName,
            devices: nameEntry ? Array.from(nameEntry.devices) : []
          });
        }
        
        this.emit('stream:restart:limit_reached', { 
          deviceId: job.deviceId, 
          safeName: job.safeName,
          reason: job.circuitBreakerState === 'open' ? 'circuit_breaker' : 'max_attempts'
        });
        return;
      }

      // КРИТИЧНО: Вычисляем задержку на основе типа ошибки и количества попыток
      const delay = this._getRestartDelay(errorType, job.restarts);
      
      logger.info('[StreamManager] Scheduling restart', {
        deviceId: job.deviceId,
        safeName: job.safeName,
        attempt: job.restarts + 1,
        delay,
        errorType
      });

      setTimeout(async () => {
        // КРИТИЧНО: Проверяем nameToJobMap вместо jobs, так как job может быть удален из jobs, но остаться в nameToJobMap
        const nameEntry = this.nameToJobMap.get(safeName);
        if (!nameEntry || !nameEntry.job) {
          logger.debug('[StreamManager] Stream entry not found, skipping restart', { safeName });
          return;
        }
        
        const current = nameEntry.job;
        
        // КРИТИЧНО: Проверяем активность через lastAccess (60 секунд)
        const MAX_IDLE_TIME = 60000; // 60 секунд
        const isStreamInUse = nameEntry.devices.size > 0 || 
                              (nameEntry.lastAccess && nameEntry.lastAccess.has('_direct') && 
                               (Date.now() - nameEntry.lastAccess.get('_direct')) < MAX_IDLE_TIME);
        
        if (!isStreamInUse) {
          logger.info('[StreamManager] Stream not in use, skipping restart', {
            safeName,
            devices: Array.from(nameEntry.devices)
          });
          // Удаляем запись если стрим не используется
          this.jobs.delete(safeName);
          this.nameToJobMap.delete(safeName);
          this._cleanupFolder(current.paths.folderPath);
          return;
        }
        
        if (current.process && !current.process.killed) {
          logger.debug('[StreamManager] Process still running, skipping restart', { safeName });
          return;
        }
        
        // КРИТИЧНО: Проверяем доступность источника перед перезапуском
        // Но НЕ останавливаем стрим если источник недоступен - продолжаем попытки
        if (this.options.sourceCheckEnabled) {
          const sourceAvailable = await this._checkSourceAvailable(current.sourceUrl);
          if (!sourceAvailable) {
            logger.warn('[StreamManager] Source unavailable, but will attempt restart anyway (stream in use)', {
              deviceId: current.deviceId,
              safeName: current.safeName,
              streamUrl: current.sourceUrl,
              isStreamInUse
            });
            // НЕ останавливаем - продолжаем попытки перезапуска
          }
        }
        
        current.restarts += 1;
        current.status = 'restarting';
        this.emit('stream:restarting', { deviceId: current.deviceId, safeName: current.safeName, attempt: current.restarts });
        
        logger.info('[StreamManager] Restarting stream (in use)', {
          deviceId: current.deviceId,
          safeName: current.safeName,
          attempt: current.restarts,
          devices: Array.from(nameEntry.devices),
          hasDirectAccess: nameEntry.lastAccess?.has('_direct')
        });
        
        await this._restartJob(current);
      }, delay);
    });

    this.jobs.set(safeNameSanitized, job);
    
    // КРИТИЧНО: Обновляем nameEntry.job для синхронизации
    const nameEntry = this.nameToJobMap.get(safeNameSanitized);
    if (nameEntry) {
      nameEntry.job = job;
      nameEntry.pending = false;
    }
    
    logger.info('[StreamManager] ffmpeg started', { 
      deviceId: device_id, 
      safeName: safe_name, 
      pid: child.pid,
      hasNameEntry: !!nameEntry
    });
    return job;
  }

  /**
   * Принудительно перезапускает зависший FFmpeg процесс
   * @param {Object} job - Job объект зависшего процесса
   */
  async _restartHungProcess(job) {
    if (!job || !job.process) {
      logger.warn('[StreamManager] Cannot restart hung process: no process', {
        deviceId: job?.deviceId,
        safeName: job?.safeName
      });
      return;
    }
    
    const pid = job.process.pid;
    logger.warn('[StreamManager] 🔴 Force killing hung FFmpeg process', {
      deviceId: job.deviceId,
      safeName: job.safeName,
      pid,
      lastSegmentWrite: job.lastSegmentWrite
    });
    
    try {
      // КРИТИЧНО: Очищаем обработчики событий перед убийством процесса
      if (job.process.stderr) {
        job.process.stderr.removeAllListeners('data');
      }
      job.process.removeAllListeners('error');
      job.process.removeAllListeners('exit');
      
      // Помечаем как останавливаемый, чтобы обработчик exit не пытался перезапустить
      job.stopping = true;
      
      // Принудительно убиваем процесс
      try {
        job.process.kill('SIGKILL');
      } catch (killErr) {
        logger.error('[StreamManager] Error killing hung process', {
          deviceId: job.deviceId,
          safeName: job.safeName,
          pid,
          error: killErr.message
        });
      }
      
      // Небольшая задержка перед очисткой
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Очищаем файлы
      this._cleanupFolder(job.paths.folderPath);
      
      // Удаляем job из Maps
      this.jobs.delete(job.safeName);
      const nameEntry = this.nameToJobMap.get(job.safeName);
      if (nameEntry) {
        this.nameToJobMap.delete(job.safeName);
      }
      
      // КРИТИЧНО: Сбрасываем счетчики перезапусков для зависших процессов
      // Это не считается ошибкой, поэтому не увеличиваем consecutiveFailures
      
      // Перезапускаем процесс
      logger.info('[StreamManager] Restarting after hung process kill', {
        deviceId: job.deviceId,
        safeName: job.safeName
      });
      
      const meta = {
        device_id: job.deviceId,
        safe_name: job.safeName,
        stream_url: job.sourceUrl,
        stream_protocol: job.protocol
      };
      
      await this._spawnJob(meta);
      
    } catch (err) {
      logger.error('[StreamManager] Error restarting hung process', {
        deviceId: job.deviceId,
        safeName: job.safeName,
        pid,
        error: err.message,
        stack: err.stack
      });
    }
  }

  async _restartJob(job) {
    if (!job) return;
    const meta = {
      device_id: job.deviceId,
      safe_name: job.safeName,
      stream_url: job.sourceUrl,
      stream_protocol: job.protocol
    };
    
    logger.info('[StreamManager] _restartJob called', {
      deviceId: job.deviceId,
      safeName: job.safeName,
      restarts: job.restarts,
      consecutiveFailures: job.consecutiveFailures
    });
    
    // КРИТИЧНО: Очищаем папку перед перезапуском
    this._cleanupFolder(job.paths.folderPath);
    
    // Запускаем новый процесс
    const newJob = await this._spawnJob(meta);
    
    if (!newJob) {
      logger.error('[StreamManager] _spawnJob returned null during restart', {
        deviceId: job.deviceId,
        safeName: job.safeName
      });
      return;
    }
    
    // КРИТИЧНО: При успешном запуске сбрасываем счетчик последовательных неудач
    if (newJob && newJob.status === 'running') {
      // Сбрасываем счетчики при успешном запуске
      const existingJob = this.jobs.get(job.safeName);
      if (existingJob) {
        existingJob.consecutiveFailures = 0;
        existingJob.circuitBreakerState = 'closed';
        existingJob.circuitBreakerOpenTime = null;
        logger.info('[StreamManager] Stream restarted successfully, reset counters', {
          deviceId: job.deviceId,
          safeName: job.safeName
        });
      }
    } else {
      logger.warn('[StreamManager] Stream restart completed but status is not running', {
        deviceId: job.deviceId,
        safeName: job.safeName,
        status: newJob?.status
      });
    }
  }

  /**
   * Проверяет, жив ли процесс (не завершился ли)
   * @param {ChildProcess} process - Процесс для проверки
   * @returns {boolean} true если процесс жив
   */
  _checkProcessAlive(process) {
    if (!process || process.killed) {
      return false;
    }
    
    const pid = process.pid;
    if (!pid) {
      return false;
    }
    
    // КРИТИЧНО: На Linux используем /proc/${pid}/stat для более надежной проверки
    // Это более точно, чем kill(0), так как проверяет реальное существование процесса
    const platform = process.platform;
    if (platform === 'linux') {
      try {
        const procPath = `/proc/${pid}/stat`;
        // На Linux проверяем /proc/${pid}/stat
        if (fs.existsSync(procPath)) {
          // Процесс существует - проверяем, что он не zombie
          try {
            const statContent = fs.readFileSync(procPath, 'utf-8');
            const state = statContent.split(' ')[2]; // Третье поле - состояние процесса
            // 'Z' означает zombie процесс (завершен, но не удален)
            if (state === 'Z') {
              logger.debug('[StreamManager] Process is zombie', { pid });
              return false;
            }
            return true;
          } catch (readErr) {
            // Ошибка чтения - процесс может быть завершен
            logger.debug('[StreamManager] Error reading process stat', { pid, error: readErr.message });
            return false;
          }
        } else {
          // Файл не существует - процесс завершен
          return false;
        }
      } catch (err) {
        // Ошибка при проверке /proc - fallback на kill(0)
        logger.debug('[StreamManager] Error checking /proc, using fallback', { pid, error: err.message });
      }
    }
    
    // Fallback: проверяем существование процесса через kill(0) - не отправляет сигнал
    try {
      process.kill(0);
      return true;
    } catch (err) {
      // Если процесс не существует, kill(0) выбросит ошибку
      // ESRCH = No such process
      if (err.code === 'ESRCH') {
        return false;
      }
      // Другие ошибки (например, EPERM) считаем как процесс существует
      // Но логируем для отладки
      logger.debug('[StreamManager] kill(0) returned error, assuming process alive', {
        pid,
        errorCode: err.code,
        errorMessage: err.message
      });
      return true;
    }
  }

  /**
   * Останавливает самые старые idle стримы при превышении лимита
   * @param {number} count - Количество стримов для остановки
   */
  async _cleanupOldestIdleStreams(count) {
    const now = Date.now();
    const candidates = [];
    
    // Собираем все стримы с временем последнего доступа
    for (const [safeName, nameEntry] of this.nameToJobMap.entries()) {
      if (!nameEntry.job || nameEntry.pending) continue;
      
      // Находим самое старое время доступа среди всех устройств
      let oldestAccess = null;
      if (nameEntry.lastAccess && nameEntry.lastAccess.size > 0) {
        for (const [deviceId, lastAccess] of nameEntry.lastAccess.entries()) {
          if (!oldestAccess || lastAccess < oldestAccess) {
            oldestAccess = lastAccess;
          }
        }
      }
      
      if (!oldestAccess) continue;
      
      const idleTime = now - oldestAccess;
      candidates.push({
        key: safeName,
        job: nameEntry.job,
        lastAccess: oldestAccess,
        idleTime
      });
    }
    
    // Сортируем по времени последнего доступа (самые старые первые)
    candidates.sort((a, b) => a.lastAccess - b.lastAccess);
    
    // Останавливаем первые count стримов
    let stopped = 0;
    for (let i = 0; i < Math.min(count, candidates.length); i++) {
      const candidate = candidates[i];
      logger.info('[StreamManager] Stopping old idle stream to free up capacity', {
        deviceId: candidate.job.deviceId,
        safeName: candidate.job.safeName,
        idleTimeMs: candidate.idleTime,
        idleTimeSeconds: Math.round(candidate.idleTime / 1000)
      });
      
      this.stopStream(candidate.job.deviceId, candidate.job.safeName, 'max_jobs_limit');
      stopped++;
      
      // Небольшая задержка между остановками
      if (i < candidates.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    logger.info('[StreamManager] Cleaned up old idle streams', {
      stopped,
      requested: count,
      totalCandidates: candidates.length
    });
  }

  syncAll(entries = []) {
    const desiredKeys = new Set(entries.map(entry => sanitizePathFragment(entry.safe_name)));

    // Stop jobs that no longer exist
    for (const [key, job] of this.jobs.entries()) {
      if (!desiredKeys.has(key)) {
        this.stopStream(job.deviceId, job.safeName, 'sync_remove');
      }
    }

    // Start or update existing
    entries.forEach(entry => {
      this.upsertStream(entry).catch(err => {
        logger.error('[StreamManager] Failed to upsert stream', { entry, error: err.message });
      });
    });
  }

  async upsertStream(entry) {
    const { device_id, safe_name, stream_url } = entry;
    const safeName = sanitizePathFragment(safe_name);
    const normalizedUrl = normalizeStreamUrl(stream_url);
    
    logger.info('[StreamManager] upsertStream called', {
      deviceId: device_id,
      safeName,
      streamUrl: normalizedUrl
    });
    
    // КРИТИЧНО: Проверяем лимит на количество стримов
    if (this.jobs.size >= this.options.maxJobs) {
      logger.warn('[StreamManager] Max jobs limit reached, stopping oldest idle streams', {
        currentJobs: this.jobs.size,
        maxJobs: this.options.maxJobs
      });
      await this._cleanupOldestIdleStreams(this.jobs.size - this.options.maxJobs + 1);
    }
    
    // ШАГ 1: Проверяем, есть ли уже стрим с таким именем
    let nameEntry = this.nameToJobMap.get(safeName);
    
    if (nameEntry && nameEntry.job && nameEntry.job.process && 
        !nameEntry.job.process.killed && nameEntry.job.status !== 'stopped') {
      // Стрим уже запущен - добавляем устройство в список
      nameEntry.devices.add(device_id);
      if (!nameEntry.lastAccess) {
        nameEntry.lastAccess = new Map();
      }
      nameEntry.lastAccess.set(device_id, Date.now());
      
      logger.info('[StreamManager] Stream already running, added device', {
        safeName,
        deviceId: device_id,
        totalDevices: nameEntry.devices.size,
                streamUrl: normalizedUrl
              });
              
      return nameEntry.job;
    }
    
    // ШАГ 2: Проверяем pending операции
    const pendingPromise = this.nameToJobMapPending.get(safeName);
    if (pendingPromise) {
      logger.info('[StreamManager] Waiting for pending stream', { safeName, deviceId: device_id });
      try {
        const pendingJob = await pendingPromise;
        if (pendingJob) {
          nameEntry = this.nameToJobMap.get(safeName);
          if (nameEntry) {
            nameEntry.devices.add(device_id);
            if (!nameEntry.lastAccess) {
              nameEntry.lastAccess = new Map();
            }
            nameEntry.lastAccess.set(device_id, Date.now());
            
            logger.info('[StreamManager] Stream started from pending, added device', {
              safeName,
              deviceId: device_id,
              totalDevices: nameEntry.devices.size
            });
          }
          return pendingJob;
          }
        } catch (pendingErr) {
        logger.warn('[StreamManager] Pending operation failed', {
          safeName,
          deviceId: device_id,
            error: pendingErr.message
          });
      }
    }
    
    // ШАГ 3: Запускаем новый стрим
    logger.info('[StreamManager] Starting new stream', {
      safeName,
      deviceId: device_id,
            streamUrl: normalizedUrl
          });
    
    // Регистрируем pending ДО запуска
    this.nameToJobMap.set(safeName, {
      devices: new Set([device_id]),
      lastAccess: new Map([[device_id, Date.now()]]),
      pending: true
    });
    
    const spawnPromise = (async () => {
      const startTime = Date.now();
      const maxPendingTimeout = 120000;
      
      try {
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Pending operation timeout after ${maxPendingTimeout}ms`));
          }, maxPendingTimeout);
        });
        
        // Обновляем entry для использования безопасного имени и нормализованного URL
        const jobEntry = {
          ...entry,
          safe_name: safeName,
          stream_url: normalizedUrl
        };
        
        const job = await Promise.race([
          this._spawnJob(jobEntry),
          timeoutPromise
        ]);
        
        if (!job) {
          logger.error('[StreamManager] _spawnJob returned null', {
            safeName,
            deviceId: device_id,
            streamUrl: normalizedUrl
          });
          this.nameToJobMap.delete(safeName);
          return null;
        }
        
        // Обновляем запись после успешного запуска
        let nameEntry = this.nameToJobMap.get(safeName);
        if (nameEntry) {
          nameEntry.job = job;
          nameEntry.pending = false;
          } else {
          // Создаем новую запись, если не было
          nameEntry = {
            job,
            devices: new Set([device_id]),
            lastAccess: new Map([[device_id, Date.now()]]),
            pending: false
          };
          this.nameToJobMap.set(safeName, nameEntry);
        }
        
        // Убеждаемся, что job.sourceUrl использует нормализованный URL
        if (job.sourceUrl !== normalizedUrl) {
          logger.warn('[StreamManager] Job sourceUrl differs from normalized URL, updating', {
            safeName,
            deviceId: device_id,
            jobSourceUrl: job.sourceUrl,
            normalizedUrl: normalizedUrl
          });
          job.sourceUrl = normalizedUrl;
        }
        
        this.jobs.set(safeName, job);
        
        // КРИТИЧНО: Финальная синхронизация nameEntry.job
        if (nameEntry) {
          nameEntry.job = job;
          nameEntry.pending = false;
        }
        
        logger.info('[StreamManager] Stream started successfully', {
          safeName,
          deviceId: device_id,
          jobStatus: job.status,
          hasProcess: !!job.process,
          processPid: job.process?.pid,
          duration: Date.now() - startTime,
          hasNameEntry: !!nameEntry
        });
        
        return job;
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error('[StreamManager] Error spawning job', {
          safeName,
          deviceId: device_id,
          streamUrl: normalizedUrl,
          error: err.message,
          stack: err.stack,
          duration
        });
        this.nameToJobMap.delete(safeName);
        throw err;
      } finally {
        this.nameToJobMapPending.delete(safeName);
      }
    })();
    
    this.nameToJobMapPending.set(safeName, spawnPromise);
    
    try {
      const job = await spawnPromise;
      return job;
    } catch (err) {
      logger.error('[StreamManager] Failed to start stream', {
        safeName,
        deviceId: device_id,
          streamUrl: normalizedUrl,
          error: err.message
        });
      return null;
    }
  }

  stopStream(deviceId, safeName, reason = 'manual') {
    try {
      const safeNameSanitized = sanitizePathFragment(safeName);
      const nameEntry = this.nameToJobMap.get(safeNameSanitized);
      
      if (!nameEntry) {
        logger.info('[StreamManager] Stream not found', { deviceId, safeName: safeNameSanitized, reason });
        return;
      }
      
      // Удаляем устройство из списка
      const hadDevice = nameEntry.devices.has(deviceId);
      nameEntry.devices.delete(deviceId);
      
      if (nameEntry.lastAccess) {
        nameEntry.lastAccess.delete(deviceId);
      }
      
      const remainingDevices = nameEntry.devices.size;
      
      logger.info('[StreamManager] Removed device from stream', {
            deviceId,
        safeName: safeNameSanitized,
        reason,
        hadDevice,
        remainingDevices,
        allDevices: Array.from(nameEntry.devices)
      });
      
      // Если остались другие устройства - НЕ останавливаем стрим
      if (remainingDevices > 0) {
        logger.info('[StreamManager] Stream still in use by other devices', {
          safeName: safeNameSanitized,
          remainingDevices,
          remainingDeviceIds: Array.from(nameEntry.devices)
        });
        return;
      }
      
      // Если это последнее устройство - останавливаем стрим
      logger.info('[StreamManager] Last device removed, stopping stream', {
        safeName: safeNameSanitized,
            deviceId,
        reason
      });
      
      const job = nameEntry.job;
      if (!job) {
        logger.warn('[StreamManager] No job found for stream', { safeName: safeNameSanitized });
        this.nameToJobMap.delete(safeNameSanitized);
        this.jobs.delete(safeNameSanitized);
          return;
        }
        
      // Помечаем job как останавливаемый
      job.stopping = true;
      const folderPathToClean = job.paths.folderPath;
      
      // КРИТИЧНО: Если процесс уже завершился, сразу очищаем джоб
      if (job.process && (job.process.killed || !this._checkProcessAlive(job.process))) {
        logger.info('[StreamManager] Process already dead, cleaning up job immediately', {
          safeName: safeNameSanitized,
          pid: job.process?.pid,
          reason
        });
        this.jobs.delete(safeNameSanitized);
        this.nameToJobMap.delete(safeNameSanitized);
        this._cleanupFolder(folderPathToClean);
        this.emit('stream:stopped', { deviceId, safeName: safeNameSanitized, reason });
        return;
      }
      
      if (job.process) {
        try {
          const cleanupOnExit = () => {
            // Отменяем таймауты принудительной очистки, так как процесс завершился нормально
            if (job._cleanupTimeouts) {
              clearTimeout(job._cleanupTimeouts.forceKillTimeout);
              clearTimeout(job._cleanupTimeouts.forceCleanupTimeout);
              delete job._cleanupTimeouts;
            }
            
            if (job.process) {
              job.process.removeAllListeners('exit');
              job.process.removeAllListeners('error');
              if (job.process.stderr) {
                job.process.stderr.removeAllListeners('data');
              }
            }
            
            // Удаляем все записи
            this.jobs.delete(safeNameSanitized);
            this.nameToJobMap.delete(safeNameSanitized);
            
            // Очищаем файлы
            this._cleanupFolder(folderPathToClean);
            
            this.emit('stream:stopped', { deviceId, safeName: safeNameSanitized, reason });
            logger.info('[StreamManager] Stream stopped and files cleaned', {
              safeName: safeNameSanitized,
              reason,
              folderPath: folderPathToClean
            });
          };
          
          job.process.removeAllListeners('exit');
          job.process.removeAllListeners('error');
          job.process.once('exit', cleanupOnExit);
          
          job.process.kill('SIGTERM');
          
          // Таймаут для принудительного завершения
          const forceKillTimeout = setTimeout(() => {
              if (job.process && !job.process.killed) {
              logger.warn('[StreamManager] Force killing FFmpeg', {
                safeName: safeNameSanitized,
                pid: job.process.pid
              });
                job.process.kill('SIGKILL');
            }
          }, 5000);
          
          // Таймаут для принудительной очистки джоба, даже если процесс не завершился
          const forceCleanupTimeout = setTimeout(() => {
            // Проверяем, не завершился ли процесс
            const isProcessAlive = job.process && !job.process.killed && this._checkProcessAlive(job.process);
            
            if (isProcessAlive) {
              logger.warn('[StreamManager] Process still alive after kill, attempting final SIGKILL and force cleaning up job', {
                safeName: safeNameSanitized,
                pid: job.process?.pid
              });
              // Последняя попытка убить процесс
              try {
                if (job.process && !job.process.killed) {
                  job.process.kill('SIGKILL');
                }
              } catch (killErr) {
                logger.error('[StreamManager] Error in final SIGKILL attempt', {
                  safeName: safeNameSanitized,
                  pid: job.process?.pid,
                  error: killErr.message
                });
              }
            } else {
              logger.info('[StreamManager] Process already dead, force cleaning up job', {
                safeName: safeNameSanitized,
                pid: job.process?.pid
              });
            }
            
            // Принудительно очищаем джоб
            clearTimeout(forceKillTimeout);
            if (job.process) {
              try {
                job.process.removeAllListeners('exit');
                job.process.removeAllListeners('error');
                if (job.process.stderr) {
                  job.process.stderr.removeAllListeners('data');
                }
              } catch (e) {
                // Игнорируем ошибки при удалении слушателей
              }
            }
            
            // Удаляем все записи
            this.jobs.delete(safeNameSanitized);
            this.nameToJobMap.delete(safeNameSanitized);
            
            // Очищаем файлы
            // КРИТИЧНО: Очищаем папку даже если процесс все еще работает
            this._cleanupFolder(folderPathToClean);
            
            // Дополнительная попытка очистки через небольшую задержку, если процесс завершился
            if (!isProcessAlive) {
              setTimeout(() => {
                if (fs.existsSync(folderPathToClean)) {
                  logger.warn('[StreamManager] Folder still exists after cleanup, retrying', {
                    safeName: safeNameSanitized,
                    folderPath: folderPathToClean
                  });
                  this._cleanupFolder(folderPathToClean);
                }
              }, 1000);
            }
            
            this.emit('stream:stopped', { deviceId, safeName: safeNameSanitized, reason });
            logger.info('[StreamManager] Job force cleaned after timeout', {
              safeName: safeNameSanitized,
              reason,
              folderPath: folderPathToClean,
              processWasAlive: isProcessAlive
            });
          }, 10000); // 10 секунд на полную очистку
          
          // Сохраняем ссылку на таймауты для отмены при нормальном завершении
          job._cleanupTimeouts = { forceKillTimeout, forceCleanupTimeout };
        } catch (err) {
          logger.error('[StreamManager] Error stopping FFmpeg', {
            safeName: safeNameSanitized,
            error: err.message
          });
          
          // Отменяем таймауты при ошибке
          if (job._cleanupTimeouts) {
            clearTimeout(job._cleanupTimeouts.forceKillTimeout);
            clearTimeout(job._cleanupTimeouts.forceCleanupTimeout);
            delete job._cleanupTimeouts;
          }
          
          // Очищаем даже при ошибке
          this.jobs.delete(safeNameSanitized);
          this.nameToJobMap.delete(safeNameSanitized);
          this._cleanupFolder(folderPathToClean);
          this.emit('stream:stopped', { deviceId, safeName: safeNameSanitized, reason });
        }
      } else {
        // Если процесса нет, сразу очищаем
        this.jobs.delete(safeNameSanitized);
        this.nameToJobMap.delete(safeNameSanitized);
        this._cleanupFolder(folderPathToClean);
        this.emit('stream:stopped', { deviceId, safeName: safeNameSanitized, reason });
      }
    } catch (err) {
      logger.error('[StreamManager] Error in stopStream', {
        deviceId,
        safeName,
        reason,
        error: err.message,
        stack: err.stack
      });
    }
  }

  /**
   * Обновляет время последнего доступа к стриму
   * Вызывается при каждом запросе сегментов HLS для отслеживания активности
   */
  updateLastAccess(deviceId, safeName) {
    const safeNameSanitized = sanitizePathFragment(safeName);
    const nameEntry = this.nameToJobMap.get(safeNameSanitized);
    
    if (nameEntry && nameEntry.devices.has(deviceId)) {
      if (!nameEntry.lastAccess) {
        nameEntry.lastAccess = new Map();
      }
      nameEntry.lastAccess.set(deviceId, Date.now());
      
      logger.debug('[StreamManager] Updated last access', {
        deviceId,
        safeName: safeNameSanitized,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Обновляет время последнего доступа к стриму по safeName (для всех устройств, использующих стрим)
   * Используется когда deviceId недоступен (например, в HTTP запросах к /streams/)
   * КРИТИЧНО: Работает даже для прямых стримов без deviceId
   */
  updateLastAccessBySafeName(safeName) {
    const safeNameSanitized = sanitizePathFragment(safeName);
    const nameEntry = this.nameToJobMap.get(safeNameSanitized);
    
    if (nameEntry) {
      if (!nameEntry.lastAccess) {
        nameEntry.lastAccess = new Map();
      }
      const now = Date.now();
      
      // КРИТИЧНО: Обновляем lastAccess для всех устройств, использующих стрим
      if (nameEntry.devices.size > 0) {
        for (const deviceId of nameEntry.devices) {
          nameEntry.lastAccess.set(deviceId, now);
        }
      }
      
      // КРИТИЧНО: Для прямых стримов без deviceId используем специальный ключ '_direct'
      // Это позволяет отслеживать активность даже если devices пустой
      nameEntry.lastAccess.set('_direct', now);
      
      logger.debug('[StreamManager] Updated last access by safeName', {
        safeName: safeNameSanitized,
        devices: Array.from(nameEntry.devices),
        hasDirectAccess: true,
        timestamp: now
      });
    }
  }

  getPlaybackUrl(deviceId, safeName) {
    const safeNameSanitized = sanitizePathFragment(safeName);
    const job = this.jobs.get(safeNameSanitized);
    const nameEntry = this.nameToJobMap.get(safeNameSanitized);
    const actualJob = job || nameEntry?.job;
    
    // Обновляем время последнего доступа
    if (nameEntry && nameEntry.devices.has(deviceId)) {
      if (!nameEntry.lastAccess) {
        nameEntry.lastAccess = new Map();
      }
      nameEntry.lastAccess.set(deviceId, Date.now());
    }
    
    // КРИТИЧНО: Проверяем не только наличие job, но и валидность
    if (actualJob && actualJob.paths && actualJob.paths.publicUrl) {
      // Проверяем статус процесса
      const isProcessActive = actualJob.process && 
                             !actualJob.process.killed && 
                             actualJob.status !== 'stopped';
      
      if (isProcessActive) {
        // Процесс активен - проверяем существование и валидность файла
        const paths = actualJob.paths;
        if (fs.existsSync(paths.playlistPath)) {
          // Используем кэшированный статус для оптимизации
          const fileStatus = this._getCachedFileStatus(safeNameSanitized);
          if (fileStatus.exists && fileStatus.size > 0) {
            const fileAge = Date.now() - fileStatus.mtime;
            // Если файл обновлялся менее минуты назад - валиден
            if (fileAge < 60000) {
              // Дополнительная валидация структуры плейлиста
              if (this._validatePlaylistQuick(paths.playlistPath)) {
                return actualJob.paths.publicUrl;
              }
            }
          }
        }
      } else {
        // Процесс остановлен - проверяем существование файла как fallback
        const paths = this._getPaths(safeNameSanitized);
        const fileStatus = this._getCachedFileStatus(safeNameSanitized);
        if (fileStatus.exists && fileStatus.size > 0) {
          const fileAge = Date.now() - fileStatus.mtime;
          // Если файл обновлялся менее минуты - используем его
          if (fileAge < 60000) {
            if (this._validatePlaylistQuick(paths.playlistPath)) {
              logger.info('[StreamManager] Using existing file for stopped process', {
                deviceId,
                safeName,
                fileAge
              });
              return paths.publicUrl;
            }
          }
        }
      }
    }
    
    return null;
  }

  /**
   * Запускает FFmpeg для стрима, если он еще не запущен (lazy loading)
   * @param {string} deviceId - ID устройства
   * @param {string} safeName - Безопасное имя стрима
   * @param {Object} streamMetadata - Метаданные стрима из БД
   * @param {number} retryCount - Количество попыток retry (внутренний параметр)
   * @returns {Promise<string|null>} URL для воспроизведения или null
   */
  async ensureStreamRunning(deviceId, safeName, streamMetadata, retryCount = 0) {
    const MAX_RETRIES = 2;
    const RETRY_DELAYS = [1000, 3000]; // Задержки: 1с, 3с
    const safeNameSanitized = sanitizePathFragment(safeName);
    const existing = this.jobs.get(safeNameSanitized);
    
      logger.info('[StreamManager] ensureStreamRunning called', {
        deviceId,
        safeName,
        hasExisting: !!existing,
        existingStatus: existing?.status,
        existingProcess: !!existing?.process,
        existingProcessKilled: existing?.process?.killed,
        hasMetadata: !!streamMetadata,
        metadataStreamUrl: streamMetadata?.stream_url,
        metadataProtocol: streamMetadata?.stream_protocol,
        metadataContentType: streamMetadata?.content_type
      });
    
    // КРИТИЧНО: Проверяем также nameToJobMap, так как job может быть удален из jobs, но остаться в nameToJobMap
    const nameEntry = this.nameToJobMap.get(safeNameSanitized);
    const existingJob = existing || nameEntry?.job;
    
    // КРИТИЧНО: Максимально упрощенная логика - если job существует, возвращаем URL сразу
    if (existingJob && existingJob.paths && existingJob.paths.publicUrl) {
      // Добавляем deviceId в devices если его там нет
      if (nameEntry && !nameEntry.devices.has(deviceId)) {
        nameEntry.devices.add(deviceId);
        if (!nameEntry.lastAccess) {
          nameEntry.lastAccess = new Map();
        }
        nameEntry.lastAccess.set(deviceId, Date.now());
      }
      
      logger.info('[StreamManager] Returning existing stream URL', {
        deviceId,
        safeName,
        url: existingJob.paths.publicUrl
      });
      return existingJob.paths.publicUrl;
    }
    
    // НОВОЕ: Проверяем существование файла перед созданием job
    // Это позволяет использовать существующие файлы даже если job был остановлен
    const paths = this._getPaths(safeNameSanitized);
    if (fs.existsSync(paths.playlistPath)) {
      try {
        const fileStatus = this._getCachedFileStatus(safeNameSanitized);
        if (fileStatus.exists && fileStatus.size > 0) {
          const fileAge = Date.now() - fileStatus.mtime;
          // Если файл существует и обновлялся недавно (менее минуты) - используем его
          if (fileAge < 60000) {
            if (this._validatePlaylistQuick(paths.playlistPath)) {
              logger.info('[StreamManager] Found existing valid stream file, using it instead of creating job', {
                deviceId,
                safeName,
                filePath: paths.playlistPath,
                fileSize: fileStatus.size,
                fileAge,
                url: paths.publicUrl
              });
              
              // Добавляем deviceId в nameToJobMap для отслеживания
              if (!nameEntry) {
                this.nameToJobMap.set(safeNameSanitized, {
                  devices: new Set([deviceId]),
                  lastAccess: new Map([[deviceId, Date.now()]]),
                  pending: false
                });
              } else {
                nameEntry.devices.add(deviceId);
                if (!nameEntry.lastAccess) {
                  nameEntry.lastAccess = new Map();
                }
                nameEntry.lastAccess.set(deviceId, Date.now());
              }
              
              return paths.publicUrl;
            } else {
              logger.info('[StreamManager] Stream file exists but invalid, will recreate', {
                deviceId,
                safeName,
                fileAge
              });
              // Удаляем невалидный файл перед созданием нового
              try {
                fs.unlinkSync(paths.playlistPath);
                logger.debug('[StreamManager] Removed invalid playlist file', { playlistPath: paths.playlistPath });
              } catch (unlinkErr) {
                logger.warn('[StreamManager] Failed to remove invalid playlist file', {
                  playlistPath: paths.playlistPath,
                  error: unlinkErr.message
                });
              }
            }
          } else {
            logger.info('[StreamManager] Stream file exists but too old, will recreate', {
              deviceId,
              safeName,
              fileAge
            });
            // Удаляем старый файл перед созданием нового
            try {
              fs.unlinkSync(paths.playlistPath);
              logger.debug('[StreamManager] Removed old playlist file', { playlistPath: paths.playlistPath });
            } catch (unlinkErr) {
              logger.warn('[StreamManager] Failed to remove old playlist file', {
                playlistPath: paths.playlistPath,
                error: unlinkErr.message
              });
            }
          }
        }
      } catch (err) {
        logger.debug('[StreamManager] Error checking existing stream file', {
          deviceId,
          safeName,
          error: err.message
        });
      }
    }
    
    // Если не запущен - запускаем
    if (!existingJob && streamMetadata) {
      if (!streamMetadata.stream_url) {
        logger.error('[StreamManager] Missing stream_url in metadata, cannot start', {
          deviceId,
          safeName,
          metadata: streamMetadata
        });
        return null;
      }
      
      // КРИТИЧНО: Проверка источника перед запуском FFmpeg
      // Оптимизация: Для не-HLS стримов проверку можно отключить для ускорения запуска
      // Проверка неблокирующая - если она не удалась, все равно пытаемся запустить FFmpeg
      // (источник может быть медленным или требовать времени на инициализацию)
      if (this.options.sourceCheckEnabled) {
        // Оптимизация: Быстрая проверка источника с коротким таймаутом
        // Если проверка не успела - просто пропускаем её и запускаем FFmpeg
        const sourceCheckPromise = (async () => {
          try {
            const sourceAvailable = await Promise.race([
              this._checkSourceAvailable(streamMetadata.stream_url),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Source check timeout')), 2000) // Уменьшено до 2 сек
              )
            ]);
            
            if (sourceAvailable) {
              logger.info('[StreamManager] Source is available', {
                deviceId,
                safeName,
                streamUrl: streamMetadata.stream_url
              });
            }
            return sourceAvailable;
          } catch (checkErr) {
            logger.debug('[StreamManager] Source check timeout/error, proceeding anyway', {
              deviceId,
              safeName,
              streamUrl: streamMetadata.stream_url,
              error: checkErr.message
            });
            return false;
          }
        })();
        
        // Ждем проверку источника, но не более 2 секунд - потом запускаем FFmpeg
        try {
          await Promise.race([
            sourceCheckPromise,
            new Promise((resolve) => setTimeout(() => resolve(false), 2000))
          ]);
        } catch (err) {
          // Игнорируем ошибки - запускаем FFmpeg в любом случае
        }
      }
      
      logger.info('[StreamManager] Lazy starting stream', {
        deviceId,
        safeName,
        streamUrl: streamMetadata.stream_url,
        streamProtocol: streamMetadata.stream_protocol
      });
      
      const entry = {
        device_id: deviceId,
        safe_name: safeName,
        stream_url: streamMetadata.stream_url,
        stream_protocol: streamMetadata.stream_protocol
      };
      
      try {
        const job = await this.upsertStream(entry);
        if (!job) {
          // Если не удалось запустить и есть попытки - retry
          if (retryCount < MAX_RETRIES) {
            const delay = RETRY_DELAYS[retryCount] || 5000;
            logger.info('[StreamManager] Retrying stream start', {
              deviceId,
              safeName,
              retryCount: retryCount + 1,
              delay
            });
            
            await new Promise(resolve => setTimeout(resolve, delay));
            return this.ensureStreamRunning(deviceId, safeName, streamMetadata, retryCount + 1);
          }
          
          logger.error('[StreamManager] upsertStream returned null, FFmpeg not started', {
            deviceId,
            safeName,
            entry,
            retryCount
          });
          return null;
        }
        logger.info('[StreamManager] upsertStream completed', {
          deviceId,
          safeName,
          jobKey: job.safeName,
          jobStatus: job.status,
          hasProcess: !!job.process
        });
      } catch (err) {
        // При ошибке - retry если возможно
        if (retryCount < MAX_RETRIES) {
          const delay = RETRY_DELAYS[retryCount] || 5000;
          logger.warn('[StreamManager] Stream start error, retrying', {
            deviceId,
            safeName,
            error: err.message,
            retryCount: retryCount + 1,
            delay
          });
          
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.ensureStreamRunning(deviceId, safeName, streamMetadata, retryCount + 1);
        }
        
        logger.error('[StreamManager] upsertStream failed', {
          deviceId,
          safeName,
          error: err.message,
          stack: err.stack,
          retryCount
        });
        
        // Отправляем уведомление о неудачном запуске стрима после всех попыток
        notifyStreamStartFailed(deviceId, safeName, {
          error: err.message,
          retryCount,
          streamUrl: streamMetadata.stream_url,
          recommendation: 'Проверьте конфигурацию стрима, источник и логи сервера'
        });
        
        return null;
      }
      
      // КРИТИЧНО: Ждем, пока FFmpeg создаст плейлист
      // Проверяем наличие плейлиста с таймаутом
      // Для DASH стримов может потребоваться больше времени на инициализацию
      const safeNameSanitized = sanitizePathFragment(safeName);
      const paths = this._getPaths(safeNameSanitized);
      const isDash = streamMetadata.stream_protocol === 'dash' || (streamMetadata.stream_url?.toLowerCase().includes('.mpd'));
      // Оптимизация: уменьшаем время ожидания плейлиста для ускорения запуска
      const maxWaitTime = isDash ? 15000 : 6000; // 15 секунд для DASH, 6 для остальных (было 20 и 12)
      const checkInterval = 200; // Проверяем каждые 200мс
      const startTime = Date.now();
      let lastJobStatus = null;
      
      while (Date.now() - startTime < maxWaitTime) {
        const job = this.jobs.get(safeNameSanitized);
        
        // КРИТИЧНО: Отслеживаем изменения статуса для лучшей диагностики
        if (job && job.status !== lastJobStatus) {
          lastJobStatus = job.status;
          logger.debug('[StreamManager] Job status changed while waiting for playlist', {
            deviceId,
            safeName,
            oldStatus: lastJobStatus,
            newStatus: job.status,
            waitTime: Date.now() - startTime
          });
        }
        
        // Проверяем, что процесс запущен и не остановлен
        if (job && job.process && !job.process.killed && (job.status === 'running' || job.status === 'starting')) {
          // Проверяем, что плейлист создан
          if (fs.existsSync(paths.playlistPath)) {
            // Проверяем, что плейлист не пустой (минимум несколько байт)
            try {
              const stats = fs.statSync(paths.playlistPath);
              if (stats.size > 0) {
                // КРИТИЧНО: Проверяем, что плейлист обновляется (не застрял)
                // Если плейлист не обновлялся более 5 секунд - возможно проблема
                const playlistAge = Date.now() - stats.mtimeMs;
                if (playlistAge > 5000 && job.status === 'running') {
                  logger.warn('[StreamManager] Playlist not updating, may be stuck', {
                    deviceId,
                    safeName,
                    playlistAge,
                    waitTime: Date.now() - startTime
                  });
                  // Продолжаем ожидание, но логируем предупреждение
                }
                
                // Для процесса в статусе 'starting' - более мягкая проверка
                // Для 'running' - полная валидация через getPlaybackUrl
                const url = this.getPlaybackUrl(deviceId, safeName);
                if (url) {
                  logger.info('[StreamManager] Playlist created, ready for playback', {
                    deviceId,
                    safeName,
                    waitTime: Date.now() - startTime,
                    playlistSize: stats.size,
                    jobStatus: job.status,
                    url
                  });
                  return url;
                } else if (job.status === 'starting') {
                  // Для starting процесса возвращаем URL если плейлист валиден
                  if (this._validatePlaylistQuick(paths.playlistPath)) {
                    // Используем paths.publicUrl (из _getPaths) - он всегда определен
                    logger.info('[StreamManager] Playlist created for starting stream (relaxed validation)', {
                      deviceId,
                      safeName,
                      waitTime: Date.now() - startTime,
                      playlistSize: stats.size,
                      publicUrl: paths.publicUrl
                    });
                    return paths.publicUrl;
                  }
                }
              }
            } catch (err) {
              // Игнорируем ошибки проверки размера
              logger.debug('[StreamManager] Error checking playlist', {
                deviceId,
                safeName,
                error: err.message
              });
            }
          }
        } else if (job && job.status === 'stopped') {
          // Процесс остановился - выходим
          logger.warn('[StreamManager] FFmpeg process stopped before playlist was created', {
            deviceId,
            safeName,
            lastError: job.lastError,
            lastErrorType: job.lastErrorType,
            waitTime: Date.now() - startTime
          });
          return null;
        } else if (!job) {
          // Job не найден - возможно был удален
          logger.warn('[StreamManager] Job not found while waiting for playlist', {
            deviceId,
            safeName,
            waitTime: Date.now() - startTime
          });
          return null;
        }
        
        // Ждем перед следующей проверкой
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
      
      // Таймаут - плейлист не создан
      logger.warn('[StreamManager] Timeout waiting for playlist creation', {
        deviceId,
        safeName,
        waitTime: Date.now() - startTime,
        isDash,
        finalJobStatus: lastJobStatus
      });
      
      // Проверяем последний раз - может быть плейлист создался
      const finalUrl = this.getPlaybackUrl(deviceId, safeName);
      if (finalUrl) {
        logger.info('[StreamManager] Playlist found on final check', {
          deviceId,
          safeName,
          url: finalUrl
        });
      }
      return finalUrl;
    }
    
    return this.getPlaybackUrl(deviceId, safeName);
  }

  getStatus(deviceId, safeName) {
    const safeNameSanitized = sanitizePathFragment(safeName);
    const job = this.jobs.get(safeNameSanitized);
    if (!job) {
      const paths = this._getPaths(safeNameSanitized);
      const exists = fs.existsSync(paths.playlistPath);
      return exists
        ? { status: 'idle', playbackUrl: paths.publicUrl }
        : null;
    }
    return {
      status: job.status,
      playbackUrl: this.getPlaybackUrl(deviceId, safeName),
      restarts: job.restarts,
      lastError: job.lastError,
      lastErrorType: job.lastErrorType,
      startedAt: job.startedAt,
      circuitBreakerState: job.circuitBreakerState,
      consecutiveFailures: job.consecutiveFailures
    };
  }

  /**
   * Получает статус job по safeName (без deviceId)
   * Используется в HTTP middleware для проверки статуса стрима
   */
  getJobStatusBySafeName(safeName) {
    const safeNameSanitized = sanitizePathFragment(safeName);
    const job = this.jobs.get(safeNameSanitized);
    if (!job) {
      return null;
    }
    return {
      status: job.status,
      restarts: job.restarts,
      lastError: job.lastError,
      lastErrorType: job.lastErrorType,
      startedAt: job.startedAt,
      circuitBreakerState: job.circuitBreakerState,
      consecutiveFailures: job.consecutiveFailures
    };
  }

  /**
   * Классифицирует ошибку для умных перезапусков
   * @param {number} code - Exit code
   * @param {string} signal - Signal
   * @param {string} stderr - Stderr output
   * @returns {string} Тип ошибки: 'network', 'codec', 'source_ended', 'unknown'
   */
  _classifyError(code, signal, stderr) {
    const stderrLower = stderr.toLowerCase();
    
    // Network errors
    if (
      stderrLower.includes('connection refused') ||
      stderrLower.includes('connection timed out') ||
      stderrLower.includes('network is unreachable') ||
      stderrLower.includes('name or service not known') ||
      stderrLower.includes('http error') ||
      stderrLower.includes('404') ||
      stderrLower.includes('403') ||
      stderrLower.includes('401') ||
      code === 1 && (stderrLower.includes('server returned') || stderrLower.includes('http'))
    ) {
      return 'network';
    }
    
    // Codec errors
    if (
      stderrLower.includes('unsupported codec') ||
      stderrLower.includes('codec not found') ||
      stderrLower.includes('encoding error') ||
      stderrLower.includes('decoding error') ||
      stderrLower.includes('invalid data found')
    ) {
      return 'codec';
    }
    
    // Source ended
    if (
      stderrLower.includes('end of file') ||
      stderrLower.includes('stream ended') ||
      stderrLower.includes('connection closed') ||
      code === 0 && signal === null // Нормальное завершение без сигнала
    ) {
      return 'source_ended';
    }
    
    return 'unknown';
  }

  /**
   * Проверяет, нужно ли перезапускать стрим
   * @param {Object} job - Job объект
   * @returns {boolean}
   */
  _shouldRestart(job) {
    // КРИТИЧНО: Проверка circuit breaker с поддержкой half-open состояния
    if (job.circuitBreakerState === 'open') {
      // Circuit breaker открыт - не перезапускаем
      return false;
    }
    
    // В half-open состоянии разрешаем 1 попытку перезапуска
    if (job.circuitBreakerState === 'halfOpen') {
      // В half-open разрешаем только одну попытку
      logger.info('[StreamManager] Circuit breaker in half-open state, allowing one retry', {
        deviceId: job.deviceId,
        safeName: job.safeName
      });
      // Разрешаем перезапуск, но при неудаче снова откроем circuit breaker
      return true;
    }
    
    // Проверка лимита перезапусков
    if (job.restarts >= this.options.restartMaxAttempts) {
      // Открываем circuit breaker
      job.circuitBreakerState = 'open';
      job.circuitBreakerOpenTime = Date.now();
      logger.warn('[StreamManager] Circuit breaker opened', {
        deviceId: job.deviceId,
        safeName: job.safeName,
        restarts: job.restarts
      });
      return false;
    }
    
    // Проверка последовательных неудач для circuit breaker
    if (job.consecutiveFailures >= this.options.circuitBreakerThreshold) {
      job.circuitBreakerState = 'open';
      job.circuitBreakerOpenTime = Date.now();
      logger.warn('[StreamManager] Circuit breaker opened (consecutive failures)', {
        deviceId: job.deviceId,
        safeName: job.safeName,
        consecutiveFailures: job.consecutiveFailures
      });
      return false;
    }
    
    // Если ошибка source_ended - не перезапускать
    if (job.lastErrorType === 'source_ended') {
      logger.info('[StreamManager] Source ended, not restarting', {
        deviceId: job.deviceId,
        safeName: job.safeName
      });
      return false;
    }
    
    return true;
  }

  /**
   * Вычисляет задержку перезапуска на основе типа ошибки и попытки
   * Использует экспоненциальный backoff с jitter для предотвращения thundering herd
   * @param {string} errorType - Тип ошибки
   * @param {number} attempt - Номер попытки (0-based)
   * @returns {number} Задержка в миллисекундах
   */
  _getRestartDelay(errorType, attempt) {
    let baseDelay;
    
    switch (errorType) {
      case 'network':
        // Для сетевых ошибок используем более длинную базовую задержку
        // так как они могут быть временными и требуют больше времени на восстановление
        baseDelay = 15000; // 15 секунд для сетевых ошибок
        break;
      case 'codec':
        baseDelay = 5000; // 5 секунд для ошибок кодека
        break;
      default:
        baseDelay = this.options.restartInitialDelay; // 5 секунд по умолчанию
    }
    
    // Экспоненциальная задержка: baseDelay * 2^attempt
    let delay = Math.min(baseDelay * Math.pow(2, attempt), this.options.restartMaxDelay);
    
    // КРИТИЧНО: Добавляем jitter (случайное отклонение ±20%) для предотвращения thundering herd
    // Это особенно важно при множественных стримах с одного источника
    const jitter = delay * 0.2 * (Math.random() * 2 - 1); // ±20%
    delay = Math.max(1000, delay + jitter); // Минимум 1 секунда
    
    return Math.round(delay);
  }

  /**
   * Проверяет доступность источника стрима
   * @param {string} streamUrl - URL источника
   * @returns {Promise<boolean>}
   */
  async _checkSourceAvailable(streamUrl) {
    try {
      // КРИТИЧНО: Для HTTP/HTTPS стримов используем быструю проверку через HEAD запрос
      // Для RTSP/RTMP используем ffprobe
      const urlLower = streamUrl.toLowerCase();
      const isHttp = urlLower.startsWith('http://') || urlLower.startsWith('https://');
      
      if (isHttp) {
        // Быстрая проверка через HTTP HEAD запрос
        return await this._checkHttpSource(streamUrl);
      } else {
        // Для RTSP/RTMP используем ffprobe
        return await this._checkStreamSource(streamUrl);
      }
    } catch (error) {
      logger.debug('[StreamManager] Source check failed', {
        streamUrl,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Проверяет доступность HTTP/HTTPS источника через HEAD запрос (с fallback на GET)
   * @param {string} streamUrl - URL источника
   * @returns {Promise<boolean>}
   */
  async _checkHttpSource(streamUrl) {
    // КРИТИЧНО: Добавляем общий таймаут для всей проверки источника
    // Это предотвращает зависание, если оба запроса (HEAD и GET) зависают
    const overallTimeout = this.options.sourceCheckTimeout * 2; // Удваиваем таймаут для двух попыток
    
    return Promise.race([
      (async () => {
        try {
          // Сначала пробуем HEAD запрос (быстрее)
          const headResult = await this._checkHttpSourceWithMethod(streamUrl, 'HEAD');
          if (headResult) {
            return true;
          }
          
          // Если HEAD не сработал (405 Method Not Allowed или другой код), пробуем GET
          // Некоторые стримы не поддерживают HEAD
          logger.debug('[StreamManager] HEAD request failed, trying GET', { streamUrl });
          return await this._checkHttpSourceWithMethod(streamUrl, 'GET');
        } catch (err) {
          logger.debug('[StreamManager] HTTP source check error', {
            streamUrl,
            error: err.message
          });
          return false;
        }
      })(),
      new Promise((resolve) => {
        setTimeout(() => {
          logger.debug('[StreamManager] HTTP source check overall timeout', {
            streamUrl,
            timeout: overallTimeout
          });
          resolve(false);
        }, overallTimeout);
      })
    ]);
  }

  /**
   * Проверяет доступность HTTP/HTTPS источника через указанный метод
   * @param {string} streamUrl - URL источника
   * @param {string} method - HTTP метод (HEAD или GET)
   * @returns {Promise<boolean>}
   */
  async _checkHttpSourceWithMethod(streamUrl, method) {
    return new Promise((resolve) => {
      let resolved = false; // Флаг для предотвращения двойного resolve
      
      const safeResolve = (value) => {
        if (!resolved) {
          resolved = true;
          resolve(value);
        }
      };
      
      try {
        // КРИТИЧНО: Валидация URL перед парсингом
        if (!streamUrl || typeof streamUrl !== 'string' || streamUrl.trim().length === 0) {
          logger.debug('[StreamManager] Invalid stream URL', { streamUrl, method });
          return safeResolve(false);
        }
        
        let urlObj;
        try {
          urlObj = new URL(streamUrl);
        } catch (urlErr) {
          logger.debug('[StreamManager] URL parsing error', {
            streamUrl,
            method,
            error: urlErr.message
          });
          return safeResolve(false);
        }
        
        const client = urlObj.protocol === 'https:' ? https : http;
        
        const req = client.request({
          method,
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          timeout: this.options.sourceCheckTimeout,
          headers: {
            'User-Agent': 'VideoControl/StreamChecker',
            'Range': 'bytes=0-1' // Для GET запрашиваем только первые 2 байта
          }
        }, (res) => {
          // Проверяем статус код (2xx и 3xx считаем успешными)
          // 405 Method Not Allowed тоже считаем успешным (сервер работает, просто не поддерживает метод)
          const isAvailable = (res.statusCode >= 200 && res.statusCode < 400) || res.statusCode === 405;
          logger.debug('[StreamManager] HTTP source check result', {
            streamUrl,
            method,
            statusCode: res.statusCode,
            isAvailable
          });
          
          // Для GET метода нужно прочитать ответ, чтобы закрыть соединение
          if (method === 'GET') {
            // КРИТИЧНО: Добавляем таймаут для чтения ответа GET
            const getResponseTimeout = setTimeout(() => {
              logger.debug('[StreamManager] GET response timeout, closing connection', {
                streamUrl,
                method
              });
              res.destroy();
              req.destroy();
              safeResolve(false);
            }, this.options.sourceCheckTimeout);
            
            res.on('data', () => {}); // Игнорируем данные
            res.on('end', () => {
              clearTimeout(getResponseTimeout);
              safeResolve(isAvailable);
            });
            res.on('error', (resErr) => {
              clearTimeout(getResponseTimeout);
              logger.debug('[StreamManager] Response stream error', {
                streamUrl,
                method,
                error: resErr.message
              });
              safeResolve(false);
            });
          } else {
            safeResolve(isAvailable);
          }
          
          // КРИТИЧНО: Не вызываем req.destroy() здесь, так как для GET нужно дождаться 'end'
          if (method !== 'GET') {
            req.destroy();
          }
        });
        
        req.on('error', (err) => {
          logger.debug('[StreamManager] HTTP source check error', {
            streamUrl,
            method,
            error: err.message,
            errorCode: err.code
          });
          safeResolve(false);
        });
        
        req.on('timeout', () => {
          logger.debug('[StreamManager] HTTP source check timeout', {
            streamUrl,
            method,
            timeout: this.options.sourceCheckTimeout
          });
          req.destroy();
          safeResolve(false);
        });
        
        // КРИТИЧНО: Обработка закрытия соединения
        req.on('close', () => {
          if (method === 'GET' && !resolved) {
            // Если соединение закрылось до получения ответа для GET
            logger.debug('[StreamManager] Connection closed before response', {
              streamUrl,
              method
            });
            safeResolve(false);
          }
        });
        
        req.end();
      } catch (err) {
        logger.error('[StreamManager] HTTP source check exception', {
          streamUrl,
          method,
          error: err.message,
          stack: err.stack
        });
        safeResolve(false);
      }
    });
  }

  /**
   * Проверяет доступность RTSP/RTMP источника через ffprobe
   * @param {string} streamUrl - URL источника
   * @returns {Promise<boolean>}
   */
  async _checkStreamSource(streamUrl) {
    try {
      // Используем более быструю проверку с меньшим таймаутом для RTSP/RTMP
      const timeout = Math.min(this.options.sourceCheckTimeout, 3000); // Максимум 3 секунды
      logger.debug('[StreamManager] Checking RTSP/RTMP source with ffprobe', {
        streamUrl,
        timeout
      });
      
      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of json "${streamUrl}"`,
        { 
          timeout,
          maxBuffer: 1024 * 1024 
        }
      );
      
      logger.debug('[StreamManager] RTSP/RTMP source check successful', {
        streamUrl
      });
      
      // Если ffprobe успешно выполнился - источник доступен
      return true;
    } catch (error) {
      logger.debug('[StreamManager] RTSP/RTMP source check failed', {
        streamUrl,
        error: error.message,
        errorCode: error.code
      });
      return false;
    }
  }

  /**
   * Валидирует симлинк на плейлист
   * @param {string} symlinkPath - Путь к симлинку
   * @param {string} targetPath - Ожидаемый путь к целевому файлу
   * @param {string} deviceId - ID устройства (для логирования)
   * @param {string} safeName - Безопасное имя стрима (для логирования)
   * @returns {boolean}
   */
  _validateSymlink(symlinkPath, targetPath, deviceId, safeName) {
    try {
      // Проверяем существование симлинка
      if (!fs.existsSync(symlinkPath)) {
        logger.warn('[StreamManager] Symlink does not exist', {
          deviceId,
          safeName,
          symlinkPath
        });
        return false;
      }
      
      // Проверяем, что это действительно симлинк
      const stats = fs.lstatSync(symlinkPath);
      if (!stats.isSymbolicLink()) {
        logger.warn('[StreamManager] Created file is not a symlink', {
          deviceId,
          safeName,
          symlinkPath
        });
        return false;
      }
      
      // Проверяем, что целевой файл существует
      const realPath = fs.readlinkSync(symlinkPath);
      if (!fs.existsSync(realPath)) {
        logger.error('[StreamManager] Symlink target does not exist', {
          deviceId,
          safeName,
          symlinkPath,
          targetPath,
          realPath
        });
        return false;
      }
      
      // Проверяем, что реальный путь совпадает с ожидаемым
      const resolvedPath = path.resolve(realPath);
      const expectedPath = path.resolve(targetPath);
      if (resolvedPath !== expectedPath) {
        logger.warn('[StreamManager] Symlink target path mismatch', {
          deviceId,
          safeName,
          symlinkPath,
          expectedPath,
          actualPath: resolvedPath
        });
        // Это не критично, если файл существует
      }
      
      // Проверяем права доступа (читаемость)
      try {
        fs.accessSync(realPath, fs.constants.R_OK);
      } catch (accessErr) {
        logger.error('[StreamManager] Symlink target is not readable', {
          deviceId,
          safeName,
          symlinkPath,
          targetPath: realPath,
          error: accessErr.message
        });
        return false;
      }
      
      return true;
    } catch (err) {
      logger.warn('[StreamManager] Error validating symlink', {
        deviceId,
        safeName,
        symlinkPath,
        error: err.message
      });
      return false;
    }
  }

  /**
   * Валидирует HLS плейлист
   * @param {string} playlistPath - Путь к плейлисту
   * @param {string} folderPath - Путь к папке с сегментами
   * @returns {boolean}
   */
  _checkPlaylistValid(playlistPath, folderPath) {
    try {
      // Проверка существования файла
      if (!fs.existsSync(playlistPath)) {
        return false;
      }
      
      // Проверка размера
      const stats = fs.statSync(playlistPath);
      if (stats.size === 0) {
        return false;
      }
      
      // Читаем содержимое плейлиста
      const content = fs.readFileSync(playlistPath, 'utf-8');
      
      // Проверка наличия #EXTM3U
      if (!content.includes('#EXTM3U')) {
        return false;
      }
      
      // Проверка наличия #EXTINF
      if (!content.includes('#EXTINF')) {
        return false;
      }
      
      // КРИТИЧНО: Проверяем наличие сегментов в плейлисте
      // Для новых стримов может быть меньше сегментов - это нормально
      const lines = content.split('\n');
      const segments = [];
      
      for (const line of lines) {
        const trimmed = line.trim();
        // Ищем строки с именами сегментов (не начинаются с # и заканчиваются на .ts)
        if (trimmed && !trimmed.startsWith('#') && trimmed.endsWith('.ts')) {
          segments.push(trimmed);
        }
      }
      
      // КРИТИЧНО: Для новых стримов достаточно 1 сегмента, для старых - минимум 1
      // Убрали требование минимум 3 сегмента, так как это блокирует новые стримы
      if (segments.length === 0) {
        logger.debug('[StreamManager] Playlist has no segments', {
          playlistPath,
          segmentCount: segments.length
        });
        return false;
      }
      
      // КРИТИЧНО: Проверяем, что хотя бы один сегмент существует на диске
      // Не проверяем все сегменты - достаточно проверить последний (самый свежий)
      if (segments.length > 0) {
        const lastSegment = segments[segments.length - 1];
        const segmentPath = path.join(folderPath, lastSegment);
        if (!fs.existsSync(segmentPath)) {
          logger.debug('[StreamManager] Last playlist segment missing', {
            playlistPath,
            segment: lastSegment,
            segmentPath,
            totalSegments: segments.length
          });
          // КРИТИЧНО: Не возвращаем false - сегмент может создаваться
          // Возвращаем true если есть хотя бы один сегмент в плейлисте
          // Плеер сам обработает отсутствие сегмента
        }
      }
      
      return true;
    } catch (error) {
      logger.warn('[StreamManager] Playlist validation error', {
        playlistPath,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Запускает периодическую очистку сегментов
   */
  _startSegmentCleanup() {
    this.segmentCleanupInterval = setInterval(() => {
      this._cleanupSegments();
    }, this.options.cleanupInterval);
    
    logger.info('[StreamManager] Segment cleanup started', {
      interval: this.options.cleanupInterval
    });
  }

  /**
   * Парсит HLS плейлист и возвращает список сегментов
   * @param {string} playlistPath - Путь к плейлисту
   * @returns {Set<string>} Множество имен сегментов из плейлиста
   */
  _parsePlaylistSegments(playlistPath) {
    const segments = new Set();
    
    try {
      if (!fs.existsSync(playlistPath)) {
        return segments;
      }
      
      const content = fs.readFileSync(playlistPath, 'utf-8');
      const lines = content.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        // Ищем строки с именами сегментов (не начинаются с # и заканчиваются на .ts)
        if (trimmed && !trimmed.startsWith('#') && trimmed.endsWith('.ts')) {
          // Извлекаем только имя файла (без пути, если есть)
          const fileName = path.basename(trimmed);
          segments.add(fileName);
        }
      }
    } catch (error) {
      logger.debug('[StreamManager] Error parsing playlist for cleanup', {
        playlistPath,
        error: error.message
      });
    }
    
    return segments;
  }

  /**
   * Парсит HLS плейлист и возвращает ВСЕ сегменты (не только первые 3)
   * Используется для полной проверки при очистке
   * @param {string} playlistPath - Путь к плейлисту
   * @returns {Set<string>} Множество всех имен сегментов из плейлиста
   */
  _parseAllPlaylistSegments(playlistPath) {
    const segments = new Set();
    
    try {
      if (!fs.existsSync(playlistPath)) {
        return segments;
      }
      
      const content = fs.readFileSync(playlistPath, 'utf-8');
      const lines = content.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        // Ищем строки с именами сегментов (не начинаются с # и заканчиваются на .ts)
        if (trimmed && !trimmed.startsWith('#') && trimmed.endsWith('.ts')) {
          // Извлекаем только имя файла (без пути, если есть)
          const fileName = path.basename(trimmed);
          segments.add(fileName);
        }
      }
    } catch (error) {
      logger.debug('[StreamManager] Error parsing all playlist segments', {
        playlistPath,
        error: error.message
      });
    }
    
    return segments;
  }

  /**
   * Очищает старые сегменты для всех активных стримов
   * КРИТИЧНО: Оптимизировано с приоритизацией и ограничением времени выполнения
   */
  _cleanupSegments() {
    const now = Date.now();
    const maxAge = (this.options.segmentDuration * this.options.playlistSize * 2) * 1000; // В миллисекундах
    const maxSizeBytes = this.options.maxFolderSizeMB * 1024 * 1024;
    const maxCleanupTime = 30000; // Максимум 30 секунд на очистку
    const cleanupStartTime = Date.now();
    
    let cleanedCount = 0;
    let totalFreed = 0;
    
    // КРИТИЧНО: Собираем все стримы с информацией о размере папки для приоритизации
    const streamsToClean = [];
    for (const [key, job] of this.jobs.entries()) {
      // КРИТИЧНО: Убрали проверку isShared - теперь все стримы одинаковые для всех устройств
      if (!job.paths || !job.paths.folderPath) continue;
      
      try {
        const folderPath = job.paths.folderPath;
        if (!fs.existsSync(folderPath)) continue;
        
        // Вычисляем размер папки
        let folderSize = 0;
        try {
          const files = fs.readdirSync(folderPath);
          for (const file of files) {
            try {
              const filePath = path.join(folderPath, file);
              const stats = fs.statSync(filePath);
              folderSize += stats.size;
            } catch (err) {
              // КРИТИЧНО: Обрабатываем ошибки переполнения диска
              if (err.code === 'ENOSPC') {
                logger.error('[StreamManager] 🚨 DISK FULL ERROR while reading file stats for size calculation', {
                  deviceId: job.deviceId,
                  safeName: job.safeName,
                  file: file,
                  error: err.message
                });
                // Не запускаем экстренную очистку здесь, т.к. это сбор информации
                // Экстренная очистка будет запущена в других местах
              }
              // Игнорируем другие ошибки отдельных файлов
            }
          }
        } catch (err) {
          // КРИТИЧНО: Обрабатываем ошибки переполнения диска при чтении директории
          if (err.code === 'ENOSPC') {
            logger.error('[StreamManager] 🚨 DISK FULL ERROR while reading directory for size calculation', {
              deviceId: job.deviceId,
              safeName: job.safeName,
              folderPath,
              error: err.message
            });
            // Не запускаем экстренную очистку здесь, т.к. это сбор информации
            // Экстренная очистка будет запущена в других местах
          }
          // Игнорируем другие ошибки чтения директории
        }
        
        streamsToClean.push({
          key,
          job,
          folderSize
        });
      } catch (err) {
        // Игнорируем ошибки при сборе информации
      }
    }
    
    // КРИТИЧНО: Сортируем по размеру папки (самые большие первые) для приоритизации
    streamsToClean.sort((a, b) => b.folderSize - a.folderSize);
    
    // Очищаем стримы с приоритизацией
    for (const { key, job } of streamsToClean) {
      // Проверяем, не превысили ли лимит времени
      if (Date.now() - cleanupStartTime > maxCleanupTime) {
        logger.debug('[StreamManager] Cleanup time limit reached, stopping', {
          processed: cleanedCount,
          remaining: streamsToClean.length - cleanedCount
        });
        break;
      }
      
      try {
        const folderPath = job.paths.folderPath;
        const playlistPath = job.paths.playlistPath;
        if (!fs.existsSync(folderPath)) continue;
        
        // КРИТИЧНО: Читаем актуальный плейлист перед очисткой (ВСЕ сегменты, не только первые 3)
        const playlistSegments = this._parseAllPlaylistSegments(playlistPath);
        
        // КРИТИЧНО: Проверяем активность FFmpeg перед удалением
        const isProcessActive = job.status === 'running' && 
                                job.process && 
                                !job.process.killed &&
                                this._checkProcessAlive(job.process);
        
        // КРИТИЧНО: Проверяем время последней записи FFmpeg (heartbeat)
        // Если FFmpeg недавно писал сегменты, не удаляем сегменты, созданные после последней записи
        const lastSegmentWrite = job.lastSegmentWrite || job.startedAt;
        const timeSinceLastWrite = now - lastSegmentWrite;
        const isRecentlyActive = isProcessActive && timeSinceLastWrite < (this.options.segmentDuration * 2 * 1000);
        
        // Если процесс активен, добавляем запас времени для безопасности
        const safeAgeThreshold = isProcessActive 
          ? Math.max(maxAge, (this.options.segmentDuration * this.options.playlistSize * 3) * 1000)
          : maxAge;
        
        // КРИТИЧНО: Минимальный возраст для удаления - не удаляем сегменты, созданные после последней записи
        const minAgeForDeletion = isRecentlyActive 
          ? Math.max(safeAgeThreshold, timeSinceLastWrite + (this.options.segmentDuration * 1000))
          : safeAgeThreshold;
        
        try {
          const files = fs.readdirSync(folderPath);
          const MAX_TS_FILES = 30; // Максимум 30 .ts файлов в папке стрима
          let deletedCount = 0;
          let freedBytes = 0;
          
          // Собираем все .ts файлы с информацией о времени модификации
          const tsFiles = files
            .filter(f => f.endsWith('.ts'))
            .map(f => {
              try {
                const filePath = path.join(folderPath, f);
                const stats = fs.statSync(filePath);
                return {
                  name: f,
                  path: filePath,
                  size: stats.size,
                  mtime: stats.mtimeMs
                };
              } catch (err) {
                // КРИТИЧНО: Обрабатываем ошибки переполнения диска при чтении файлов
                if (err.code === 'ENOSPC') {
                  logger.error('[StreamManager] 🚨 DISK FULL ERROR while reading file stats, triggering emergency cleanup', {
                    deviceId: job.deviceId,
                    safeName: job.safeName,
                    file: f,
                    error: err.message
                  });
                  this._emergencyCleanupAllStreams();
                }
                return null;
              }
            })
            .filter(f => f !== null)
            .sort((a, b) => b.mtime - a.mtime); // Сортируем по времени (новые первыми)
          
          // Если файлов больше 30 - удаляем самые старые
          if (tsFiles.length > MAX_TS_FILES) {
            const toDelete = tsFiles.slice(MAX_TS_FILES); // Все файлы после первых 30
            
            for (const file of toDelete) {
              try {
                fs.unlinkSync(file.path);
                deletedCount++;
                freedBytes += file.size;
              } catch (err) {
                // КРИТИЧНО: Обрабатываем ошибки переполнения диска при удалении файлов
                if (err.code === 'ENOSPC') {
                  logger.error('[StreamManager] 🚨 DISK FULL ERROR while deleting file, triggering emergency cleanup', {
                    deviceId: job.deviceId,
                    safeName: job.safeName,
                    file: file.path,
                    error: err.message
                  });
                  this._emergencyCleanupAllStreams();
                  // Экстренная очистка текущего стрима
                  this._emergencyCleanupOnDiskFull(folderPath);
                } else {
                  logger.debug('[StreamManager] Error deleting old segment file', {
                    file: file.path,
                    error: err.message
                  });
                }
              }
            }
            
            if (deletedCount > 0) {
              logger.info('[StreamManager] Cleaned up old segments, keeping max 30 files', {
                deviceId: job.deviceId,
                safeName: job.safeName,
                totalFiles: tsFiles.length,
                deletedCount,
                remainingFiles: MAX_TS_FILES,
                freedMB: Math.round(freedBytes / 1024 / 1024)
              });
            }
          }
          
          if (deletedCount > 0) {
            cleanedCount++;
            totalFreed += freedBytes;
          }
        } catch (readError) {
          // КРИТИЧНО: Обрабатываем ошибки переполнения диска при чтении директории
          if (readError.code === 'ENOSPC') {
            logger.error('[StreamManager] 🚨 DISK FULL ERROR while reading directory, triggering emergency cleanup', {
              deviceId: job.deviceId,
              safeName: job.safeName,
              folderPath,
              error: readError.message
            });
            this._emergencyCleanupAllStreams();
            // Экстренная очистка текущего стрима
            this._emergencyCleanupOnDiskFull(folderPath);
          } else {
            logger.warn('[StreamManager] Error reading directory during segment cleanup', {
              deviceId: job.deviceId,
              safeName: job.safeName,
              folderPath,
              error: readError.message
            });
          }
        }
      } catch (error) {
        // КРИТИЧНО: Обрабатываем ошибки переполнения диска
        if (error.code === 'ENOSPC' || error.message.includes('No space left on device')) {
          logger.error('[StreamManager] 🚨 DISK FULL ERROR during segment cleanup, triggering emergency cleanup', {
            deviceId: job.deviceId,
            safeName: job.safeName,
            error: error.message,
            errorCode: error.code
          });
          this._emergencyCleanupAllStreams();
          // Экстренная очистка текущего стрима
          if (job.paths && job.paths.folderPath) {
            this._emergencyCleanupOnDiskFull(job.paths.folderPath);
          }
        } else {
          logger.warn('[StreamManager] Error during segment cleanup', {
            deviceId: job.deviceId,
            safeName: job.safeName,
            error: error.message
          });
        }
      }
    }
    
    if (cleanedCount > 0 || totalFreed > 0) {
      const cleanupDuration = Date.now() - cleanupStartTime;
      logger.info('[StreamManager] Segment cleanup completed', {
        streamsCleaned: cleanedCount,
        totalFreedMB: Math.round(totalFreed / 1024 / 1024),
        durationMs: cleanupDuration,
        streamsProcessed: cleanedCount,
        streamsTotal: streamsToClean.length
      });
    }
  }

  /**
   * Запускает периодическую проверку circuit breaker
   */
  _startCircuitBreakerCheck() {
    this.circuitBreakerCheckInterval = setInterval(() => {
      this._checkCircuitBreakers();
    }, 5 * 60 * 1000); // Каждые 5 минут
    
    logger.info('[StreamManager] Circuit breaker check started');
  }

  /**
   * Проверяет circuit breakers и пытается восстановить стримы
   */
  _checkCircuitBreakers() {
    const now = Date.now();
    
    for (const [key, job] of this.jobs.entries()) {
      if (job.circuitBreakerState !== 'open') continue;
      if (!job.circuitBreakerOpenTime) continue;
      
      // Проверяем, прошло ли достаточно времени для попытки восстановления
      const timeSinceOpen = now - job.circuitBreakerOpenTime;
      if (timeSinceOpen >= this.options.circuitBreakerTimeout) {
        logger.info('[StreamManager] Attempting circuit breaker recovery (transitioning to half-open)', {
          deviceId: job.deviceId,
          safeName: job.safeName,
          timeSinceOpen
        });
        
        // КРИТИЧНО: Переходим в half-open состояние вместо полного сброса
        job.circuitBreakerState = 'halfOpen';
        // Не сбрасываем circuitBreakerOpenTime - он все еще нужен для отслеживания
        job.consecutiveFailures = 0;
        job.restarts = 0;
        
        // В half-open состоянии не перезапускаем автоматически
        // Перезапуск произойдет при следующей попытке использования стрима
        // или при следующем вызове upsertStream/ensureStreamRunning
      }
    }
  }

  /**
   * Останавливает StreamManager и очищает все ресурсы
   */
  stop() {
    if (this.stopped) {
      logger.warn('[StreamManager] Already stopped, ignoring duplicate stop call');
      return;
    }
    
    logger.info('[StreamManager] Stopping and cleaning up...');
    this.stopped = true;
    
    // Останавливаем все активные стримы
    for (const [key, job] of this.jobs.entries()) {
      try {
        this.stopStream(job.deviceId, job.safeName, 'shutdown');
      } catch (error) {
        logger.error('[StreamManager] Error stopping stream during shutdown', {
          deviceId: job.deviceId,
          safeName: job.safeName,
          error: error.message
        });
      }
    }
    
    // КРИТИЧНО: Очищаем интервалы с проверкой существования
    if (this.idleCleanupInterval) {
      clearInterval(this.idleCleanupInterval);
      this.idleCleanupInterval = null;
    }
    
    if (this.segmentCleanupInterval) {
      clearInterval(this.segmentCleanupInterval);
      this.segmentCleanupInterval = null;
    }
    
    if (this.circuitBreakerCheckInterval) {
      clearInterval(this.circuitBreakerCheckInterval);
      this.circuitBreakerCheckInterval = null;
    }
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    
    // КРИТИЧНО: Очищаем Maps для предотвращения утечек памяти
    this.jobs.clear();
    this.nameToJobMap.clear();
    this.nameToJobMapPending.clear(); // Очищаем pending операции
    this.codecCache.clear(); // Очищаем кэш кодеков
    this.fileStatusCache.clear(); // Очищаем кэш статусов файлов
    
    logger.info('[StreamManager] Stopped');
  }
}

let managerInstance = null;

export function initStreamManager(options = {}) {
  managerInstance = new StreamManager(options);
  return managerInstance;
}

export function getStreamManager() {
  return managerInstance;
}

export function syncStreamJobs(entries = []) {
  managerInstance?.syncAll(entries);
}

export function upsertStreamJob(entry) {
  managerInstance?.upsertStream(entry);
}

export function removeStreamJob(deviceId, safeName, reason) {
  try {
    managerInstance?.stopStream(deviceId, safeName, reason);
  } catch (err) {
    logger.error('[StreamManager] Error in removeStreamJob', { 
      deviceId, 
      safeName, 
      reason, 
      error: err.message,
      stack: err.stack 
    });
    // Не пробрасываем ошибку дальше, чтобы не падал сервер
  }
}

export function getStreamPlaybackUrl(deviceId, safeName) {
  return managerInstance?.getPlaybackUrl(deviceId, safeName) || null;
}

export function getStreamRestreamStatus(deviceId, safeName) {
  return managerInstance?.getStatus(deviceId, safeName) || null;
}


