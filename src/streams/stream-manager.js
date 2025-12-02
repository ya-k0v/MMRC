import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';
import https from 'https';
import http from 'http';
import logger from '../utils/logger.js';
import { getStreamsOutputDir } from '../config/settings-manager.js';

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
  sourceCheckTimeout: Number(process.env.STREAM_SOURCE_CHECK_TIMEOUT || 5000),
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
    this.jobs = new Map(); // Map<deviceId::safeName, job>
    this.urlToJobMap = new Map(); // Map<streamUrl, {jobKey, devices: Set<deviceId::safeName>}>
    this.lastAccessTime = new Map(); // Отслеживание последнего доступа к стриму
    // КРИТИЧНО: Map для отслеживания pending операций по URL (предотвращение race conditions)
    this.urlToJobMapPending = new Map(); // Map<streamUrl, Promise<Job>>
    // КРИТИЧНО: Кэш результатов определения кодеков для оптимизации
    this.codecCache = new Map(); // Map<streamUrl, {codecs: {videoCodec, audioCodec}, timestamp: number}>
    this.codecCacheMaxSize = 100; // Максимум 100 записей в кэше
    this.codecCacheTTL = 10 * 60 * 1000; // TTL: 10 минут
    // КРИТИЧНО: idleTimeout для автоматической остановки неиспользуемых стримов
    // Стрим работает, пока его смотрят (плеер запрашивает сегменты)
    // Если стрим не используется (нет запросов сегментов) - останавливается через 3 минуты
    // HLS плееры запрашивают плейлист каждые 3-5 секунд, поэтому 3 минуты достаточно
    this.idleTimeout = Number(process.env.STREAM_IDLE_TIMEOUT_MS || 180000); // 180 секунд (3 минуты) по умолчанию
    
    // Интервалы для очистки при shutdown
    this.idleCleanupInterval = null;
    this.segmentCleanupInterval = null;
    this.circuitBreakerCheckInterval = null;
    
    // КРИТИЧНО: Флаг остановки для предотвращения повторного запуска
    this.stopped = false;
    
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
  }
  
  /**
   * Запускает периодическую проверку неиспользуемых стримов
   * Стрим работает, пока его смотрят (плеер запрашивает сегменты)
   * Если стрим не используется (нет запросов) - останавливается через idleTimeout
   */
  _startIdleCleanup() {
    this.idleCleanupInterval = setInterval(() => {
      const now = Date.now();
      
      // КРИТИЧНО: Очищаем "сиротские" записи в lastAccessTime для несуществующих jobs
      const orphanedKeys = [];
      for (const [key] of this.lastAccessTime.entries()) {
        if (!this.jobs.has(key)) {
          orphanedKeys.push(key);
        }
      }
      if (orphanedKeys.length > 0) {
        orphanedKeys.forEach(key => {
          this.lastAccessTime.delete(key);
        });
        logger.debug('[StreamManager] Cleaned up orphaned lastAccessTime entries', {
          count: orphanedKeys.length
        });
      }
      
      for (const [key, job] of this.jobs.entries()) {
        // КРИТИЧНО: Пропускаем shared jobs - они обрабатываются через основной job
        if (job.isShared) {
          continue;
        }
        
        // КРИТИЧНО: Проверяем зависшие процессы через heartbeat
        if (job.status === 'running' && job.process && !job.process.killed) {
          // Проверяем статус процесса через систему
          const isProcessAlive = this._checkProcessAlive(job.process);
          if (!isProcessAlive) {
            logger.warn('[StreamManager] 🔴 FFmpeg process is dead but not detected', {
              deviceId: job.deviceId,
              safeName: job.safeName,
              pid: job.process.pid
            });
            // Процесс мертв, но не был обнаружен - перезапускаем
            this._restartHungProcess(job);
            continue;
          }
          
          // Проверяем heartbeat для активных процессов
          if (job.lastSegmentWrite) {
            const timeSinceLastWrite = now - job.lastSegmentWrite;
            if (timeSinceLastWrite > this.options.hungProcessTimeout) {
              logger.warn('[StreamManager] 🔴 Detected hung FFmpeg process (no heartbeat)', {
                deviceId: job.deviceId,
                safeName: job.safeName,
                timeSinceLastWriteMs: timeSinceLastWrite,
                timeSinceLastWriteSeconds: Math.round(timeSinceLastWrite / 1000),
                hungProcessTimeoutMs: this.options.hungProcessTimeout,
                pid: job.process.pid
              });
              
              // Принудительно перезапускаем зависший процесс
              this._restartHungProcess(job);
              continue; // Пропускаем дальнейшую обработку для этого job
            }
          }
        }
        
        const lastAccess = this.lastAccessTime.get(key);
        if (!lastAccess) {
          // Если нет записи о доступе - это новый стрим, пропускаем
          continue;
        }
        
        const idleTime = now - lastAccess;
        if (idleTime > this.idleTimeout) {
          // КРИТИЧНО: Проверяем, используется ли URL другими устройствами
          // Нормализуем URL для корректного поиска (на случай старых job с ненормализованными URL)
          const normalizedSourceUrl = normalizeStreamUrl(job.sourceUrl);
          const urlEntry = this.urlToJobMap.get(normalizedSourceUrl);
          if (urlEntry && urlEntry.devices.size > 1) {
            // URL используется другими устройствами - проверяем их активность
            let hasActiveDevice = false;
            for (const deviceKey of urlEntry.devices) {
              const deviceLastAccess = this.lastAccessTime.get(deviceKey);
              if (deviceLastAccess && (now - deviceLastAccess) <= this.idleTimeout) {
                hasActiveDevice = true;
                break;
              }
            }
            if (hasActiveDevice) {
              // Есть активное устройство - не останавливаем
              continue;
            }
          }
          
          logger.info('[StreamManager] 🕐 Stopping idle stream (no activity)', {
            deviceId: job.deviceId,
            safeName: job.safeName,
            idleTimeMs: idleTime,
            idleTimeSeconds: Math.round(idleTime / 1000),
            idleTimeoutMs: this.idleTimeout,
            idleTimeoutSeconds: Math.round(this.idleTimeout / 1000)
          });
          this.stopStream(job.deviceId, job.safeName, 'idle_timeout');
        }
      }
    }, 10000); // Проверяем каждые 10 секунд для быстрой реакции
  }

  _jobKey(deviceId, safeName) {
    return `${deviceId}${STREAM_KEY_SEPARATOR}${safeName}`;
  }

  _getPaths(deviceId, safeName) {
    const safeDevice = sanitizePathFragment(deviceId);
    const safeFile = sanitizePathFragment(safeName);
    const folderPath = path.join(this.options.outputRoot, safeDevice, safeFile);
    const playlistPath = path.join(folderPath, 'index.m3u8');
    const segmentPattern = path.join(folderPath, 'segment_%05d.ts');
    const publicUrl = `${this.options.publicBasePath}/${encodeURIComponent(safeDevice)}/${encodeURIComponent(safeFile)}/index.m3u8`;
    return { folderPath, playlistPath, segmentPattern, publicUrl };
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
    const timeout = isDash ? 15000 : 5000; // 15 секунд для DASH, 5 для остальных
    
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

  _cleanupFolder(folderPath) {
    try {
      if (fs.existsSync(folderPath)) {
        // КРИТИЧНО: Сначала удаляем все .ts сегменты вручную, чтобы освободить их
        // Это важно, так как они могут быть заблокированы FFmpeg процессом
        try {
          const files = fs.readdirSync(folderPath);
          for (const file of files) {
            if (file.endsWith('.ts') || file.endsWith('.m3u8')) {
              const filePath = path.join(folderPath, file);
              try {
                fs.unlinkSync(filePath);
                logger.debug('[StreamManager] Удален файл', { filePath, file });
              } catch (e) {
                logger.warn('[StreamManager] Не удалось удалить файл', { filePath, error: e.message });
              }
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
        fs.rmSync(folderPath, { recursive: true, force: true });
        logger.info('[StreamManager] Cleaned up stream folder', { folderPath });
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

    const key = this._jobKey(device_id, safe_name);
    const paths = this._getPaths(device_id, safe_name);
    
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
      logger.error('[StreamManager] Failed to create stream folder', {
        deviceId: device_id,
        safeName: safe_name,
        folderPath: paths.folderPath,
        error: err.message,
        errorCode: err.code
      });
      throw err; // Не продолжаем, если не можем создать папку
    }

    // КРИТИЧНО: Для DASH стримов определение кодеков может быть проблематичным
    // FFprobe может не успеть прочитать манифест или выбрать представление
    // Поэтому для DASH всегда перекодируем, чтобы гарантировать запуск FFmpeg
    const isDash = stream_protocol === 'dash' || stream_url.toLowerCase().includes('.mpd');
    
    let videoCodec = 'unknown';
    let audioCodec = 'unknown';
    let needsVideoTranscode = true; // По умолчанию перекодируем
    let needsAudioTranscode = true;
    
    // Для DASH стримов пропускаем определение кодеков и всегда перекодируем
    // Это гарантирует, что FFmpeg запустится и обработает стрим
    if (!isDash) {
      try {
        const codecs = await this._detectStreamCodecs(stream_url, stream_protocol);
        videoCodec = codecs.videoCodec;
        audioCodec = codecs.audioCodec;
        needsVideoTranscode = this._needsTranscoding(videoCodec, 'video');
        needsAudioTranscode = this._needsTranscoding(audioCodec, 'audio');
      } catch (err) {
        logger.warn('[StreamManager] Codec detection failed, will transcode', {
          deviceId: device_id,
          safeName: safe_name,
          error: err.message
        });
        // Продолжаем с перекодированием
      }
    } else {
      logger.info('[StreamManager] DASH stream detected, skipping codec detection, will transcode', {
        deviceId: device_id,
        safeName: safe_name,
        streamUrl: stream_url
      });
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
      );
      logger.info('[StreamManager] Using DASH-specific input parameters', { 
        deviceId: device_id, 
        safeName: safe_name,
        streamUrl: stream_url
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
      key,
      deviceId: device_id,
      safeName: safe_name,
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
      consecutiveFailures: 0 // Количество последовательных неудач
    };

    // КРИТИЧНО: Обрабатываем stderr для отслеживания статуса и сбора ошибок
    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrBuffer += chunk;
      
      // КРИТИЧНО: Ограничиваем размер буфера для предотвращения утечек памяти
      if (stderrBuffer.length > MAX_STDERR_BUFFER_SIZE) {
        // Оставляем последние 10KB буфера
        stderrBuffer = stderrBuffer.substring(stderrBuffer.length - MAX_STDERR_BUFFER_SIZE);
      }
      
      // Обновляем статус при первом выводе (FFmpeg начал работу)
      if (job.status === 'starting') {
        job.status = 'running';
        job.lastPlaylistUpdate = Date.now();
        // КРИТИЧНО: При успешном запуске сбрасываем счетчики и очищаем stderr буфер
        job.consecutiveFailures = 0;
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
      
      // КРИТИЧНО: Удаляем из urlToJobMap при завершении процесса
      // Нормализуем URL для корректного поиска (на случай старых job с ненормализованными URL)
      const normalizedSourceUrl = normalizeStreamUrl(job.sourceUrl);
      const urlEntry = this.urlToJobMap.get(normalizedSourceUrl);
      if (urlEntry) {
        // Удаляем все устройства, использующие этот URL, и очищаем их файлы
        urlEntry.devices.forEach(deviceKey => {
          const deviceJob = this.jobs.get(deviceKey);
          if (deviceJob) {
            // Очищаем файлы устройства (симлинки или прямые файлы)
            this._cleanupFolder(deviceJob.paths.folderPath);
          }
          this.jobs.delete(deviceKey);
          this.lastAccessTime.delete(deviceKey);
        });
        this.urlToJobMap.delete(normalizedSourceUrl);
      }
      
      if (wasStopping) {
        // КРИТИЧНО: Удаляем job и очищаем файлы при остановке
        this.jobs.delete(key);
        this.lastAccessTime.delete(key);
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

      // КРИТИЧНО: Проверяем, нужно ли перезапускать
      if (!this._shouldRestart(job)) {
        logger.warn('[StreamManager] Stream restart blocked', {
          deviceId: job.deviceId,
          safeName: job.safeName,
          reason: job.circuitBreakerState === 'open' ? 'circuit_breaker' : 'max_attempts_reached',
          circuitBreakerState: job.circuitBreakerState,
          restarts: job.restarts,
          consecutiveFailures: job.consecutiveFailures
        });
        this.jobs.delete(key);
        this.lastAccessTime.delete(key);
        this._cleanupFolder(job.paths.folderPath);
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
        if (!this.jobs.has(key)) {
          return;
        }
        const current = this.jobs.get(key);
        if (!current || current.process) {
          return;
        }
        
        // КРИТИЧНО: Проверяем доступность источника перед перезапуском
        if (this.options.sourceCheckEnabled && !await this._checkSourceAvailable(current.sourceUrl)) {
          logger.error('[StreamManager] Source unavailable, stopping stream', {
            deviceId: current.deviceId,
            safeName: current.safeName,
            streamUrl: current.sourceUrl
          });
          this.jobs.delete(key);
          this.lastAccessTime.delete(key);
          this._cleanupFolder(current.paths.folderPath);
          this.emit('stream:source_unavailable', { 
            deviceId: current.deviceId, 
            safeName: current.safeName 
          });
          return;
        }
        
        current.restarts += 1;
        current.status = 'restarting';
        this.emit('stream:restarting', { deviceId: current.deviceId, safeName: current.safeName, attempt: current.restarts });
        await this._restartJob(current);
      }, delay);
    });

    this.jobs.set(key, job);
    // КРИТИЧНО: Устанавливаем время последнего доступа при запуске стрима
    // Это предотвращает немедленную остановку стрима как idle
    this.lastAccessTime.set(key, Date.now());
    logger.info('[StreamManager] ffmpeg started', { deviceId: device_id, safeName: safe_name, pid: child.pid });
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
      this.jobs.delete(job.key);
      this.lastAccessTime.delete(job.key);
      
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
    
    // КРИТИЧНО: Очищаем папку перед перезапуском
    this._cleanupFolder(job.paths.folderPath);
    
    // Запускаем новый процесс
    const newJob = await this._spawnJob(meta);
    
    // КРИТИЧНО: При успешном запуске сбрасываем счетчик последовательных неудач
    if (newJob && newJob.status === 'running') {
      // Сбрасываем счетчики при успешном запуске
      const existingJob = this.jobs.get(job.key);
      if (existingJob) {
        existingJob.consecutiveFailures = 0;
        existingJob.circuitBreakerState = 'closed';
        existingJob.circuitBreakerOpenTime = null;
      }
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
    
    // Собираем все не-shared стримы с временем последнего доступа
    for (const [key, job] of this.jobs.entries()) {
      if (job.isShared) continue;
      const lastAccess = this.lastAccessTime.get(key);
      if (!lastAccess) continue;
      
      const idleTime = now - lastAccess;
      candidates.push({
        key,
        job,
        lastAccess,
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
    const desiredKeys = new Set(entries.map(entry => this._jobKey(entry.device_id, entry.safe_name)));

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
    const key = this._jobKey(entry.device_id, entry.safe_name);
    
    // КРИТИЧНО: Нормализуем URL для корректной дедупликации
    // Это гарантирует, что одинаковые URL (с разными trailing slash, порядком параметров и т.д.) 
    // будут распознаны как одинаковые
    const normalizedUrl = normalizeStreamUrl(entry.stream_url);
    entry.stream_url = normalizedUrl; // Обновляем entry для использования нормализованного URL
    
    // КРИТИЧНО: Проверяем лимит на количество стримов для предотвращения утечек памяти
    if (this.jobs.size >= this.options.maxJobs) {
      logger.warn('[StreamManager] Max jobs limit reached, stopping oldest idle streams', {
        currentJobs: this.jobs.size,
        maxJobs: this.options.maxJobs
      });
      await this._cleanupOldestIdleStreams(this.jobs.size - this.options.maxJobs + 1);
    }
    
    const existing = this.jobs.get(key);
    
    logger.info('[StreamManager] upsertStream called', {
      deviceId: entry.device_id,
      safeName: entry.safe_name,
      streamUrl: entry.stream_url,
      originalStreamUrl: entry.stream_url, // Логируем нормализованный URL
      streamProtocol: entry.stream_protocol,
      hasExisting: !!existing,
      existingStatus: existing?.status,
      isShared: existing?.isShared
    });
    
    // КРИТИЧНО: Проверяем pending операции для этого URL (предотвращение race conditions)
    const pendingPromise = this.urlToJobMapPending.get(normalizedUrl);
    if (pendingPromise) {
      logger.info('[StreamManager] Waiting for pending operation on URL', {
        deviceId: entry.device_id,
        safeName: entry.safe_name,
        streamUrl: entry.stream_url
      });
      
      try {
        // Ждем завершения pending операции
        const pendingJob = await pendingPromise;
        
        // Если pending операция завершилась успешно, используем её результат
        if (pendingJob) {
          // Проверяем, можем ли мы использовать этот job
          const pendingUrlEntry = this.urlToJobMap.get(normalizedUrl);
          if (pendingUrlEntry) {
            const pendingExistingJob = this.jobs.get(pendingUrlEntry.jobKey);
            if (pendingExistingJob && pendingExistingJob.process && 
                !pendingExistingJob.process.killed && pendingExistingJob.status !== 'stopped') {
              
              // Если это тот же deviceId+safeName - возвращаем job
              if (pendingUrlEntry.jobKey === key) {
                this.lastAccessTime.set(key, Date.now());
                return pendingExistingJob;
              }
              
              // Для другого устройства создаем симлинк (повторяем логику дедупликации)
              logger.info('[StreamManager] Reusing job from pending operation (deduplication)', {
                deviceId: entry.device_id,
                safeName: entry.safe_name,
                streamUrl: normalizedUrl
              });
              
              // Выполняем дедупликацию (можно вынести в отдельный метод)
              if (existing && !existing.isShared) {
                this.stopStream(entry.device_id, entry.safe_name, 'switching_to_shared');
                await new Promise(resolve => setTimeout(resolve, 200));
              }
              
              pendingUrlEntry.devices.add(key);
              if (!pendingUrlEntry.devices.has(pendingUrlEntry.jobKey)) {
                pendingUrlEntry.devices.add(pendingUrlEntry.jobKey);
              }
              
              const newPaths = this._getPaths(entry.device_id, entry.safe_name);
              const existingPaths = pendingExistingJob.paths;
              
              this._cleanupFolder(newPaths.folderPath);
              ensureDir(newPaths.folderPath);
              
              try {
                if (fs.existsSync(existingPaths.playlistPath)) {
                  fs.symlinkSync(existingPaths.playlistPath, newPaths.playlistPath);
                }
              } catch (err) {
                logger.warn('[StreamManager] Failed to create symlink from pending', { error: err.message });
              }
              
              const virtualJob = {
                ...pendingExistingJob,
                deviceId: entry.device_id,
                safeName: entry.safe_name,
                key,
                paths: newPaths,
                isShared: true,
                sharedFrom: pendingUrlEntry.jobKey
              };
              
              this.jobs.set(key, virtualJob);
              this.lastAccessTime.set(key, Date.now());
              return virtualJob;
            }
          }
        }
      } catch (pendingErr) {
        logger.warn('[StreamManager] Pending operation failed, will start new process', {
          deviceId: entry.device_id,
          safeName: entry.safe_name,
          error: pendingErr.message
        });
        // Продолжаем дальше для запуска нового процесса
      }
    }
    
    // КРИТИЧНО: СНАЧАЛА проверяем дедупликацию по URL (до проверки существующего job)
    // Если для этого URL уже запущен FFmpeg процесс, используем его без перезапуска
    // Используем нормализованный URL для корректной дедупликации
    let urlEntry = this.urlToJobMap.get(normalizedUrl);
    
    // КРИТИЧНО: Дополнительная проверка pending операции после проверки urlToJobMap
    // Это защищает от race condition, когда pending операция завершилась между проверками
    if (!urlEntry) {
      const pendingAfterCheck = this.urlToJobMapPending.get(normalizedUrl);
      if (pendingAfterCheck) {
        logger.info('[StreamManager] Found pending operation after urlToJobMap check (race condition protection)', {
          deviceId: entry.device_id,
          safeName: entry.safe_name,
          streamUrl: normalizedUrl
        });
        try {
          // Ждем завершения pending операции
          const pendingJob = await pendingAfterCheck;
          if (pendingJob) {
            // Проверяем urlToJobMap еще раз после завершения pending операции
            urlEntry = this.urlToJobMap.get(normalizedUrl);
            if (urlEntry) {
              logger.info('[StreamManager] Found URL in urlToJobMap after pending operation completed', {
                deviceId: entry.device_id,
                safeName: entry.safe_name,
                streamUrl: normalizedUrl,
                jobKey: urlEntry.jobKey
              });
            }
          }
        } catch (pendingErr) {
          logger.warn('[StreamManager] Pending operation failed in race condition check', {
            deviceId: entry.device_id,
            safeName: entry.safe_name,
            streamUrl: normalizedUrl,
            error: pendingErr.message
          });
        }
      }
    }
    
    if (urlEntry) {
      const existingJobKey = urlEntry.jobKey;
      const existingJob = this.jobs.get(existingJobKey);
      
      if (existingJob && existingJob.process && !existingJob.process.killed && existingJob.status !== 'stopped') {
        // FFmpeg уже запущен для этого URL - используем его
        
        // Если это тот же deviceId+safeName - просто возвращаем существующий job
        if (existingJobKey === key) {
          logger.info('[StreamManager] Stream already running for this device, reusing', {
            deviceId: entry.device_id,
            safeName: entry.safe_name,
            streamUrl: normalizedUrl,
            jobKey: key
          });
          this.lastAccessTime.set(key, Date.now());
          return existingJob;
        }
        
        // Для другого устройства - создаем симлинк
        logger.info('[StreamManager] Reusing existing FFmpeg process for URL (deduplication)', {
          deviceId: entry.device_id,
          safeName: entry.safe_name,
          streamUrl: normalizedUrl,
          existingJobKey,
          existingDeviceId: existingJob.deviceId,
          existingSafeName: existingJob.safeName
        });
        
        // Если для этого deviceId+safeName уже есть job - останавливаем его (он не используется)
        if (existing && !existing.isShared) {
          logger.info('[StreamManager] Stopping unused job for device (will use shared stream)', {
            deviceId: entry.device_id,
            safeName: entry.safe_name,
            oldJobKey: key
          });
          this.stopStream(entry.device_id, entry.safe_name, 'switching_to_shared');
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        // КРИТИЧНО: Добавляем это устройство в список использующих этот URL
        // Также проверяем, что основное устройство (которое запустило FFmpeg) тоже в списке
        urlEntry.devices.add(key);
        if (!urlEntry.devices.has(existingJobKey)) {
          // Основное устройство еще не в списке - добавляем его
          urlEntry.devices.add(existingJobKey);
          logger.debug('[StreamManager] Added primary device to urlToJobMap.devices', {
            primaryJobKey: existingJobKey,
            primaryDeviceId: existingJob.deviceId,
            primarySafeName: existingJob.safeName
          });
        }
        
        // Создаем симлинк для нового устройства на существующий плейлист
        const newPaths = this._getPaths(entry.device_id, entry.safe_name);
        const existingPaths = existingJob.paths;
        
        // Удаляем старые файлы, если есть
        this._cleanupFolder(newPaths.folderPath);
        ensureDir(newPaths.folderPath);
        
        // Создаем симлинк на плейлист
        try {
          if (fs.existsSync(existingPaths.playlistPath)) {
            // КРИТИЧНО: Удаляем старый симлинк/файл, если существует
            if (fs.existsSync(newPaths.playlistPath)) {
              try {
                const stats = fs.lstatSync(newPaths.playlistPath);
                if (stats.isSymbolicLink()) {
                  fs.unlinkSync(newPaths.playlistPath); // Удаляем старый симлинк
                } else {
                  fs.unlinkSync(newPaths.playlistPath); // Удаляем обычный файл
                }
              } catch (unlinkErr) {
                logger.debug('[StreamManager] Error removing old symlink/file before creating new', {
                  symlinkPath: newPaths.playlistPath,
                  error: unlinkErr.message
                });
              }
            }
            
            fs.symlinkSync(existingPaths.playlistPath, newPaths.playlistPath);
            
            // КРИТИЧНО: Валидируем созданный симлинк сразу после создания
            const symlinkValid = this._validateSymlink(newPaths.playlistPath, existingPaths.playlistPath, entry.device_id, entry.safe_name);
            
            if (!symlinkValid) {
              // Пытаемся пересоздать симлинк один раз
              logger.warn('[StreamManager] Symlink validation failed, attempting to recreate', {
                deviceId: entry.device_id,
                safeName: entry.safe_name,
                symlinkPath: newPaths.playlistPath
              });
              
              try {
                // Удаляем невалидный симлинк
                if (fs.existsSync(newPaths.playlistPath)) {
                  const stats = fs.lstatSync(newPaths.playlistPath);
                  if (stats.isSymbolicLink() || stats.isFile()) {
                    fs.unlinkSync(newPaths.playlistPath);
                  }
                }
                
                // Пересоздаем симлинк
                if (fs.existsSync(existingPaths.playlistPath)) {
                  fs.symlinkSync(existingPaths.playlistPath, newPaths.playlistPath);
                  
                  // Повторная валидация
                  const retryValid = this._validateSymlink(newPaths.playlistPath, existingPaths.playlistPath, entry.device_id, entry.safe_name);
                  if (!retryValid) {
                    logger.error('[StreamManager] Symlink validation failed after retry', {
                      deviceId: entry.device_id,
                      safeName: entry.safe_name,
                      symlinkPath: newPaths.playlistPath,
                      targetPath: existingPaths.playlistPath
                    });
                  }
                }
              } catch (retryErr) {
                logger.error('[StreamManager] Failed to recreate symlink after validation error', {
                  deviceId: entry.device_id,
                  safeName: entry.safe_name,
                  error: retryErr.message
                });
              }
            }
            
            logger.info('[StreamManager] Created symlink for shared stream', {
              deviceId: entry.device_id,
              safeName: entry.safe_name,
              symlinkPath: newPaths.playlistPath,
              targetPath: existingPaths.playlistPath
            });
          } else {
            logger.warn('[StreamManager] Target playlist does not exist, cannot create symlink', {
              deviceId: entry.device_id,
              safeName: entry.safe_name,
              targetPath: existingPaths.playlistPath
            });
          }
        } catch (err) {
          logger.warn('[StreamManager] Failed to create symlink, will use direct path', {
            deviceId: entry.device_id,
            safeName: entry.safe_name,
            error: err.message,
            errorCode: err.code
          });
        }
        
        // Создаем виртуальный job для отслеживания
        const virtualJob = {
          ...existingJob,
          deviceId: entry.device_id,
          safeName: entry.safe_name,
          key,
          paths: newPaths,
          isShared: true, // Флаг, что это shared job
          sharedFrom: existingJobKey
        };
        
        this.jobs.set(key, virtualJob);
        // КРИТИЧНО: Устанавливаем время последнего доступа при создании shared job
        // Это предотвращает немедленную остановку стрима как idle
        this.lastAccessTime.set(key, Date.now());
        
        return virtualJob;
      } else {
        // Процесс остановлен, удаляем из urlToJobMap и запускаем новый
        this.urlToJobMap.delete(normalizedUrl);
      }
    }
    
    // КРИТИЧНО: Если дедупликация не сработала, проверяем существующий job для deviceId+safeName
    if (existing) {
      // Source URL change -> restart
      // Сравниваем нормализованные URL для корректного определения изменений
      const existingNormalizedUrl = normalizeStreamUrl(existing.sourceUrl || '');
      if (existingNormalizedUrl !== normalizedUrl) {
        logger.info('[StreamManager] Source URL changed, restarting', {
          deviceId: entry.device_id,
          safeName: entry.safe_name,
          oldUrl: existing.sourceUrl,
          oldNormalizedUrl: existingNormalizedUrl,
          newUrl: entry.stream_url,
          newNormalizedUrl: normalizedUrl
        });
        this.stopStream(entry.device_id, entry.safe_name, 'source_changed');
        // Продолжаем дальше, чтобы запустить новый FFmpeg процесс
      } else {
        // URL тот же и FFmpeg уже запущен - просто возвращаем существующий job
        // НЕ перезапускаем FFmpeg, так как это тот же стрим
        if (existing.process && !existing.process.killed && existing.status !== 'stopped') {
          logger.info('[StreamManager] Stream already running with same URL, reusing', {
            deviceId: entry.device_id,
            safeName: entry.safe_name,
            streamUrl: normalizedUrl,
            jobKey: key
          });
          this.lastAccessTime.set(key, Date.now());
          return existing;
        } else {
          // Процесс остановлен, но job существует - запускаем заново
          logger.info('[StreamManager] Job exists but process stopped, restarting', {
            deviceId: entry.device_id,
            safeName: entry.safe_name,
            streamUrl: normalizedUrl
          });
        }
      }
    }
    
    // Запускаем новый FFmpeg процесс для этого URL
    logger.info('[StreamManager] Starting new FFmpeg process', {
      deviceId: entry.device_id,
      safeName: entry.safe_name,
      streamUrl: normalizedUrl,
      streamProtocol: entry.stream_protocol
    });
    
    // КРИТИЧНО: Создаем Promise для pending операции и сохраняем его
    // Это предотвратит параллельный запуск нескольких процессов для одного URL
    const spawnPromise = (async () => {
      const startTime = Date.now();
      const maxPendingTimeout = 120000; // 2 минуты максимум для pending операции
      
      try {
        // КРИТИЧНО: Добавляем таймаут для pending операции
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Pending operation timeout after ${maxPendingTimeout}ms`));
          }, maxPendingTimeout);
        });
        
        const job = await Promise.race([
          this._spawnJob(entry),
          timeoutPromise
        ]);
        
        if (!job) {
          logger.error('[StreamManager] _spawnJob returned null, FFmpeg not started', {
            deviceId: entry.device_id,
            safeName: entry.safe_name,
            streamUrl: normalizedUrl
          });
          return null;
        }
        
        // Регистрируем в urlToJobMap используя нормализованный URL
        if (job) {
          if (!this.urlToJobMap.has(normalizedUrl)) {
            this.urlToJobMap.set(normalizedUrl, {
              jobKey: key,
              devices: new Set([key])
            });
            logger.info('[StreamManager] Registered new URL in urlToJobMap', {
              streamUrl: normalizedUrl,
              jobKey: key
            });
          } else {
            // Если почему-то уже есть (не должно быть), добавляем устройство
            this.urlToJobMap.get(normalizedUrl).devices.add(key);
            logger.warn('[StreamManager] URL already in urlToJobMap, added device', {
              streamUrl: normalizedUrl,
              jobKey: key
            });
          }
        }
        
        logger.info('[StreamManager] upsertStream completed successfully', {
          deviceId: entry.device_id,
          safeName: entry.safe_name,
          jobKey: job.key,
          jobStatus: job.status,
          hasProcess: !!job.process,
          processPid: job.process?.pid,
          duration: Date.now() - startTime
        });
        
        return job;
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error('[StreamManager] Error in spawn promise', {
          deviceId: entry.device_id,
          safeName: entry.safe_name,
          streamUrl: normalizedUrl,
          error: err.message,
          stack: err.stack,
          duration,
          isTimeout: err.message.includes('timeout')
        });
        
        // КРИТИЧНО: При ошибке все равно очищаем pending операцию
        // Это предотвращает блокировку последующих запросов
        this.urlToJobMapPending.delete(normalizedUrl);
        
        throw err;
      } finally {
        // КРИТИЧНО: Очищаем pending операцию после завершения (даже при успехе)
        // Дополнительная гарантия очистки
        const pendingStillExists = this.urlToJobMapPending.has(normalizedUrl);
        if (pendingStillExists) {
          this.urlToJobMapPending.delete(normalizedUrl);
          logger.debug('[StreamManager] Cleaned up pending operation in finally block', {
            streamUrl: normalizedUrl,
            duration: Date.now() - startTime
          });
        }
      }
    })();
    
    // Сохраняем Promise в pending перед запуском используя нормализованный URL
    this.urlToJobMapPending.set(normalizedUrl, spawnPromise);
    
    // КРИТИЧНО: Обрабатываем отклонение Promise, чтобы не было необработанных ошибок
    spawnPromise.catch(err => {
      // Ошибка уже обработана в try-catch внутри Promise
      // Но убеждаемся, что pending операция очищена
      if (this.urlToJobMapPending.has(normalizedUrl)) {
        logger.warn('[StreamManager] Pending operation still exists after error, cleaning up', {
          streamUrl: normalizedUrl,
          error: err.message
        });
        this.urlToJobMapPending.delete(normalizedUrl);
      }
    });
    
    // Ждем завершения операции
    const job = await spawnPromise;
    
    return job;
  }

  stopStream(deviceId, safeName, reason = 'manual') {
    try {
      const key = this._jobKey(deviceId, safeName);
      const job = this.jobs.get(key);
      const paths = job ? job.paths : this._getPaths(deviceId, safeName);
      
      if (!job) {
        // КРИТИЧНО: Даже если job не найден, очищаем старые файлы
        this._cleanupFolder(paths.folderPath);
        // Удаляем время доступа
        this.lastAccessTime.delete(key);
        logger.info('[StreamManager] Cleaned up old stream files (no job found)', { deviceId, safeName, reason });
        return;
      }
      
      // КРИТИЧНО: Проверяем, является ли это shared job (дедупликация по URL)
      if (job.isShared && job.sharedFrom) {
        // Это shared job - удаляем только симлинк и запись из urlToJobMap
        // Нормализуем URL для корректного поиска
        const normalizedSourceUrl = normalizeStreamUrl(job.sourceUrl);
        const urlEntry = this.urlToJobMap.get(normalizedSourceUrl);
        if (urlEntry) {
          // КРИТИЧНО: Сохраняем размер ДО удаления для правильной проверки
          const devicesCountBefore = urlEntry.devices.size;
          urlEntry.devices.delete(key);
          const remainingDevices = urlEntry.devices.size;
          
          logger.info('[StreamManager] Removed device from shared stream', {
            deviceId,
            safeName,
            streamUrl: job.sourceUrl,
            devicesCountBefore,
            remainingDevices
          });
          
          // КРИТИЧНО: Удаляем все связанные записи из lastAccessTime
          // Проверяем все устройства, использующие этот URL
          const devicesToClean = [];
          for (const deviceKey of urlEntry.devices) {
            if (deviceKey === key) {
              // Это текущее устройство - удаляем
              devicesToClean.push(deviceKey);
            }
          }
          devicesToClean.forEach(deviceKey => {
            this.lastAccessTime.delete(deviceKey);
          });
          
          // Если это последнее устройство, использующее этот URL, останавливаем FFmpeg
          if (remainingDevices === 0) {
            const sharedJob = this.jobs.get(job.sharedFrom);
            if (sharedJob) {
              logger.info('[StreamManager] Last device removed, stopping shared FFmpeg process', {
                streamUrl: job.sourceUrl,
                sharedJobKey: job.sharedFrom
              });
              // Останавливаем основной FFmpeg процесс
              // Используем прямой вызов stopStream, но с проверкой, чтобы не проверять дедупликацию
              sharedJob.stopping = true;
              const sharedFolderPath = sharedJob.paths.folderPath;
              
              if (sharedJob.process) {
                try {
                  const cleanupOnExit = () => {
                    // КРИТИЧНО: Очищаем все обработчики событий процесса
                    if (sharedJob.process) {
                      sharedJob.process.removeAllListeners('exit');
                      sharedJob.process.removeAllListeners('error');
                      if (sharedJob.process.stderr) {
                        sharedJob.process.stderr.removeAllListeners('data');
                      }
                    }
                    
                    // КРИТИЧНО: Удаляем все записи из Maps
                    this.jobs.delete(job.sharedFrom);
                    this.lastAccessTime.delete(job.sharedFrom);
                    // КРИТИЧНО: Удаляем из urlToJobMap после остановки процесса
                    const normalizedSourceUrl = normalizeStreamUrl(job.sourceUrl);
                    if (this.urlToJobMap.has(normalizedSourceUrl)) {
                      this.urlToJobMap.delete(normalizedSourceUrl);
                    }
                    this._cleanupFolder(sharedFolderPath);
                    this.emit('stream:stopped', { deviceId: sharedJob.deviceId, safeName: sharedJob.safeName, reason });
                    logger.info('[StreamManager] Shared FFmpeg stopped and files cleaned', { 
                      deviceId: sharedJob.deviceId, 
                      safeName: sharedJob.safeName, 
                      reason
                    });
                  };
                  
                  // КРИТИЧНО: Удаляем все старые обработчики перед установкой нового
                  sharedJob.process.removeAllListeners('exit');
                  sharedJob.process.removeAllListeners('error');
                  sharedJob.process.once('exit', cleanupOnExit);
                  sharedJob.process.kill('SIGTERM');
                  
                  setTimeout(() => {
                    if (sharedJob.process && !sharedJob.process.killed) {
                      sharedJob.process.kill('SIGKILL');
                    }
                  }, 5000);
                } catch (err) {
                  logger.error('[StreamManager] Error stopping shared FFmpeg', { error: err.message });
                  this.jobs.delete(job.sharedFrom);
                  this.lastAccessTime.delete(job.sharedFrom);
                  // КРИТИЧНО: Удаляем из urlToJobMap даже при ошибке
                  const normalizedSourceUrl = normalizeStreamUrl(job.sourceUrl);
                  if (this.urlToJobMap.has(normalizedSourceUrl)) {
                    this.urlToJobMap.delete(normalizedSourceUrl);
                  }
                  this._cleanupFolder(sharedFolderPath);
                }
              } else {
                // КРИТИЧНО: Если процесса нет, все равно очищаем все записи
                this.jobs.delete(job.sharedFrom);
                this.lastAccessTime.delete(job.sharedFrom);
                const normalizedSourceUrl = normalizeStreamUrl(job.sourceUrl);
                if (this.urlToJobMap.has(normalizedSourceUrl)) {
                  this.urlToJobMap.delete(normalizedSourceUrl);
                }
                this._cleanupFolder(sharedFolderPath);
              }
            } else {
              // КРИТИЧНО: Если shared job не найден, все равно удаляем из urlToJobMap
              const normalizedSourceUrl = normalizeStreamUrl(job.sourceUrl);
              logger.warn('[StreamManager] Shared job not found, cleaning up urlToJobMap', {
                streamUrl: normalizedSourceUrl,
                sharedFrom: job.sharedFrom
              });
              this.urlToJobMap.delete(normalizedSourceUrl);
            }
          }
        } else {
          // КРИТИЧНО: Если urlEntry не найден, логируем предупреждение
          logger.warn('[StreamManager] urlEntry not found for shared job', {
            deviceId,
            safeName,
            streamUrl: job.sourceUrl
          });
        }
        
        // Удаляем виртуальный job и очищаем симлинк
        this.jobs.delete(key);
        this.lastAccessTime.delete(key);
        this._cleanupFolder(paths.folderPath);
        
        // КРИТИЧНО: Валидация - проверяем, что все записи удалены
        if (this.jobs.has(key)) {
          logger.error('[StreamManager] Job still exists after cleanup', { deviceId, safeName, key });
        }
        if (this.lastAccessTime.has(key)) {
          logger.error('[StreamManager] lastAccessTime still exists after cleanup', { deviceId, safeName, key });
        }
        
        return;
      }
      
      // КРИТИЧНО: Для обычного job проверяем, используется ли URL другими устройствами
      // Нормализуем URL для корректного поиска
      const normalizedSourceUrl = normalizeStreamUrl(job.sourceUrl);
      const urlEntryForStop = this.urlToJobMap.get(normalizedSourceUrl);
      if (urlEntryForStop) {
        // КРИТИЧНО: Проверяем размер ДО удаления, чтобы правильно определить, остались ли другие устройства
        const hasOtherDevices = urlEntryForStop.devices.size > 1;
        
        // Удаляем это устройство из списка
        urlEntryForStop.devices.delete(key);
        
        if (hasOtherDevices) {
          // URL используется другими устройствами - только удаляем это устройство, НЕ останавливаем FFmpeg
          logger.info('[StreamManager] Removed device from shared stream (other devices still using)', {
            deviceId,
            safeName,
            streamUrl: job.sourceUrl,
            remainingDevices: urlEntryForStop.devices.size,
            remainingDeviceKeys: Array.from(urlEntryForStop.devices)
          });
          
          // Удаляем job и очищаем файлы (но не останавливаем FFmpeg)
          this.jobs.delete(key);
          this.lastAccessTime.delete(key);
          this._cleanupFolder(paths.folderPath);
          return;
        }
        
        // Если это последнее устройство, удаляем запись из urlToJobMap
        if (urlEntryForStop.devices.size === 0) {
          this.urlToJobMap.delete(normalizedSourceUrl);
          logger.info('[StreamManager] Last device removed from URL, will stop FFmpeg', {
            deviceId,
            safeName,
            streamUrl: job.sourceUrl
          });
        }
      }
      
      // КРИТИЧНО: Помечаем job как останавливаемый
      job.stopping = true;
      
      // КРИТИЧНО: Сохраняем путь для очистки после завершения процесса
      const folderPathToClean = job.paths.folderPath;
      
      if (job.process) {
        try {
          // КРИТИЧНО: Устанавливаем обработчик завершения процесса для очистки файлов
          const cleanupOnExit = () => {
            // КРИТИЧНО: Очищаем все обработчики событий процесса для предотвращения утечек памяти
            if (job.process) {
              job.process.removeAllListeners('exit');
              job.process.removeAllListeners('error');
              if (job.process.stderr) {
                job.process.stderr.removeAllListeners('data');
              }
            }
            
            // Удаляем job из списка
            this.jobs.delete(key);
            this.lastAccessTime.delete(key);
            
            // КРИТИЧНО: Удаляем все файлы стрима после завершения процесса
            this._cleanupFolder(folderPathToClean);
            
            this.emit('stream:stopped', { deviceId, safeName, reason });
            logger.info('[StreamManager] FFmpeg stopped and all files cleaned', { 
              deviceId, 
              safeName, 
              reason,
              folderPath: folderPathToClean
            });
          };
          
          // КРИТИЧНО: Удаляем все старые обработчики и устанавливаем новый
          job.process.removeAllListeners('exit');
          job.process.removeAllListeners('error');
          job.process.once('exit', cleanupOnExit);
          
          // Даем процессу время на корректное завершение
          job.process.kill('SIGTERM');
          
          // Если через 5 секунд процесс не завершился - убиваем принудительно
          setTimeout(() => {
            try {
              if (job.process && !job.process.killed) {
                logger.warn('[StreamManager] Force killing FFmpeg process', { deviceId, safeName, pid: job.process.pid });
                job.process.kill('SIGKILL');
                // После SIGKILL процесс должен завершиться быстро, очистка произойдет в обработчике exit
              }
            } catch (err) {
              logger.error('[StreamManager] Error force killing FFmpeg', { deviceId, safeName, error: err.message });
              // Если не удалось убить процесс, все равно очищаем файлы
              cleanupOnExit();
            }
          }, 5000);
        } catch (err) {
          logger.error('[StreamManager] Error stopping FFmpeg process', { deviceId, safeName, error: err.message });
          // В случае ошибки все равно очищаем
          this.jobs.delete(key);
          this.lastAccessTime.delete(key);
          this._cleanupFolder(folderPathToClean);
        }
      } else {
        // Если процесса нет, сразу очищаем
        this.jobs.delete(key);
        this.lastAccessTime.delete(key);
        this._cleanupFolder(folderPathToClean);
        this.emit('stream:stopped', { deviceId, safeName, reason });
        logger.info('[StreamManager] Stream stopped (no process), files cleaned', { deviceId, safeName, reason });
      }
    } catch (err) {
      logger.error('[StreamManager] Error in stopStream', { deviceId, safeName, reason, error: err.message, stack: err.stack });
      // Не пробрасываем ошибку дальше, чтобы не падал сервер
    }
  }

  /**
   * Обновляет время последнего доступа к стриму
   * Вызывается при каждом запросе сегментов HLS для отслеживания активности
   */
  updateLastAccess(deviceId, safeName) {
    const key = this._jobKey(deviceId, safeName);
    const job = this.jobs.get(key);
    if (job) {
      this.lastAccessTime.set(key, Date.now());
      
      // КРИТИЧНО: Для shared jobs обновляем время доступа для всех устройств, использующих этот URL
      // Это предотвращает остановку FFmpeg, если хотя бы одно устройство активно использует стрим
      // Нормализуем URL для корректного поиска
      const normalizedSourceUrl = normalizeStreamUrl(job.sourceUrl);
      if (job.isShared && job.sharedFrom) {
        const urlEntry = this.urlToJobMap.get(normalizedSourceUrl);
        if (urlEntry) {
          // Обновляем время доступа для всех устройств, использующих этот URL
          urlEntry.devices.forEach(deviceKey => {
            this.lastAccessTime.set(deviceKey, Date.now());
          });
        }
      } else {
        // Для обычных jobs обновляем время доступа для всех устройств, использующих тот же URL
        const urlEntry = this.urlToJobMap.get(normalizedSourceUrl);
        if (urlEntry && urlEntry.devices.size > 1) {
          urlEntry.devices.forEach(deviceKey => {
            this.lastAccessTime.set(deviceKey, Date.now());
          });
        }
      }
    }
  }

  getPlaybackUrl(deviceId, safeName) {
    const key = this._jobKey(deviceId, safeName);
    const job = this.jobs.get(key);
    
    // КРИТИЧНО: Обновляем время последнего доступа при запросе URL
    // Это позволяет отслеживать активность стрима (плеер запрашивает URL)
    if (job) {
      this.lastAccessTime.set(key, Date.now());
      
      // Для shared jobs обновляем время доступа для всех устройств
      // Нормализуем URL для корректного поиска
      if (job.isShared && job.sharedFrom) {
        const normalizedSourceUrl = normalizeStreamUrl(job.sourceUrl);
        const urlEntry = this.urlToJobMap.get(normalizedSourceUrl);
        if (urlEntry) {
          urlEntry.devices.forEach(deviceKey => {
            this.lastAccessTime.set(deviceKey, Date.now());
          });
        }
      }
    }
    
    // КРИТИЧНО: Для shared jobs проверяем основной процесс
    let actualJob = job;
    if (job && job.isShared && job.sharedFrom) {
      actualJob = this.jobs.get(job.sharedFrom);
      
      // КРИТИЧНО: Валидируем симлинк для shared jobs
      if (actualJob) {
        const symlinkPath = job.paths.playlistPath;
        const targetPath = actualJob.paths.playlistPath;
        
        try {
          // Проверяем, существует ли симлинк
          if (!fs.existsSync(symlinkPath)) {
            logger.warn('[StreamManager] Symlink missing, attempting to recreate', {
              deviceId,
              safeName,
              symlinkPath,
              targetPath
            });
            
            // Пытаемся пересоздать симлинк
            try {
              ensureDir(path.dirname(symlinkPath));
              if (fs.existsSync(targetPath)) {
                // Удаляем старый симлинк, если существует как обычный файл
                if (fs.existsSync(symlinkPath)) {
                  const stats = fs.lstatSync(symlinkPath);
                  if (stats.isSymbolicLink()) {
                    fs.unlinkSync(symlinkPath);
                  } else {
                    fs.unlinkSync(symlinkPath);
                  }
                }
                fs.symlinkSync(targetPath, symlinkPath);
                logger.info('[StreamManager] Symlink recreated successfully', {
                  deviceId,
                  safeName,
                  symlinkPath
                });
              } else {
                logger.warn('[StreamManager] Target playlist missing, cannot recreate symlink', {
                  deviceId,
                  safeName,
                  targetPath
                });
                return null;
              }
            } catch (symlinkErr) {
              logger.error('[StreamManager] Failed to recreate symlink', {
                deviceId,
                safeName,
                symlinkPath,
                targetPath,
                error: symlinkErr.message
              });
              return null;
            }
          } else {
            // Проверяем, является ли файл симлинком и валиден ли он
            try {
              const stats = fs.lstatSync(symlinkPath);
              if (stats.isSymbolicLink()) {
                // Проверяем, что целевой файл существует
                const realPath = fs.readlinkSync(symlinkPath);
                if (!fs.existsSync(realPath)) {
                  logger.warn('[StreamManager] Symlink target missing, attempting to fix', {
                    deviceId,
                    safeName,
                    symlinkPath,
                    realPath,
                    expectedTarget: targetPath
                  });
                  
                  // Пытаемся исправить симлинк
                  try {
                    fs.unlinkSync(symlinkPath);
                    if (fs.existsSync(targetPath)) {
                      fs.symlinkSync(targetPath, symlinkPath);
                      logger.info('[StreamManager] Symlink fixed successfully', {
                        deviceId,
                        safeName,
                        symlinkPath
                      });
                    } else {
                      logger.error('[StreamManager] Target playlist missing, cannot fix symlink', {
                        deviceId,
                        safeName,
                        targetPath
                      });
                      return null;
                    }
                  } catch (fixErr) {
                    logger.error('[StreamManager] Failed to fix symlink', {
                      deviceId,
                      safeName,
                      symlinkPath,
                      error: fixErr.message
                    });
                    return null;
                  }
                }
              }
            } catch (checkErr) {
              logger.warn('[StreamManager] Error checking symlink', {
                deviceId,
                safeName,
                symlinkPath,
                error: checkErr.message
              });
              // Продолжаем, возможно это обычный файл
            }
          }
        } catch (err) {
          logger.error('[StreamManager] Error validating symlink', {
            deviceId,
            safeName,
            symlinkPath,
            error: err.message
          });
          return null;
        }
      } else {
        logger.warn('[StreamManager] Shared job target not found', {
          deviceId,
          safeName,
          sharedFrom: job.sharedFrom
        });
        return null;
      }
    }
    
    // КРИТИЧНО: Возвращаем URL только если FFmpeg процесс активен
    // Не возвращаем URL для старых файлов, если процесс не запущен
    if (actualJob && actualJob.process && !actualJob.process.killed && actualJob.status !== 'stopped') {
      // Для shared jobs проверяем симлинк, для обычных - прямой путь
      const playlistPath = job?.isShared ? job.paths.playlistPath : actualJob.paths.playlistPath;
      
      if (fs.existsSync(playlistPath)) {
        // КРИТИЧНО: Проверяем время модификации плейлиста (детектирование зависаний)
        try {
          const stats = fs.statSync(playlistPath);
          const playlistAge = Date.now() - stats.mtimeMs;
          const maxPlaylistAge = this.options.playlistMaxAge; // 30 секунд по умолчанию
          
          // КРИТИЧНО: Если плейлист не обновлялся - процесс завис
          if (playlistAge > maxPlaylistAge) {
            logger.warn('[StreamManager] Playlist not updated, process may be hung', {
              deviceId: deviceId,
              safeName: safeName,
              playlistAge,
              maxPlaylistAge,
              lastPlaylistUpdate: actualJob.lastPlaylistUpdate
            });
            
            // Принудительно завершаем зависший процесс
            if (actualJob.process && !actualJob.process.killed) {
              logger.warn('[StreamManager] Force killing hung FFmpeg process', {
                deviceId: actualJob.deviceId,
                safeName: actualJob.safeName,
                pid: actualJob.process.pid
              });
              try {
                actualJob.process.kill('SIGKILL');
              } catch (err) {
                logger.error('[StreamManager] Error killing hung process', {
                  deviceId: actualJob.deviceId,
                  safeName: actualJob.safeName,
                  error: err.message
                });
              }
            }
            
            return null; // Плейлист слишком старый, не возвращаем URL
          }
          
          // Обновляем время последнего обновления плейлиста
          actualJob.lastPlaylistUpdate = stats.mtimeMs;
        } catch (err) {
          logger.warn('[StreamManager] Failed to check playlist age', {
            deviceId: deviceId,
            safeName: safeName,
            error: err.message
          });
        }
        
        // КРИТИЧНО: Валидация плейлиста перед возвратом URL
        const folderPath = job?.isShared ? job.paths.folderPath : actualJob.paths.folderPath;
        if (!this._checkPlaylistValid(playlistPath, folderPath)) {
          logger.warn('[StreamManager] Playlist validation failed', {
            deviceId: deviceId,
            safeName: safeName,
            playlistPath
          });
          return null; // Плейлист невалиден, не возвращаем URL
        }
        
        // Для shared jobs используем путь нового устройства, для обычных - путь основного job
        return job?.isShared ? job.paths.publicUrl : actualJob.paths.publicUrl;
      }
    }
    
    // Если процесс не запущен - не возвращаем URL даже если файлы существуют
    // Это предотвращает воспроизведение старых сегментов
    return null;
  }

  /**
   * Запускает FFmpeg для стрима, если он еще не запущен (lazy loading)
   * @param {string} deviceId - ID устройства
   * @param {string} safeName - Безопасное имя стрима
   * @param {Object} streamMetadata - Метаданные стрима из БД
   * @returns {Promise<string|null>} URL для воспроизведения или null
   */
  async ensureStreamRunning(deviceId, safeName, streamMetadata) {
    const key = this._jobKey(deviceId, safeName);
    const existing = this.jobs.get(key);
    
    logger.info('[StreamManager] ensureStreamRunning called', {
      deviceId,
      safeName,
      hasExisting: !!existing,
      existingStatus: existing?.status,
      hasMetadata: !!streamMetadata,
      metadataStreamUrl: streamMetadata?.stream_url,
      metadataProtocol: streamMetadata?.stream_protocol,
      metadataContentType: streamMetadata?.content_type
    });
    
    // Если уже запущен - очищаем старые сегменты и возвращаем URL
    if (existing && existing.status !== 'stopped') {
      logger.info('[StreamManager] Stream already running, cleaning old segments', { deviceId, safeName });
      
      // КРИТИЧНО: Очищаем старые .ts сегменты, но оставляем m3u8 и текущие сегменты
      // Это предотвращает воспроизведение старых сегментов при перезапуске плеера
      const paths = this._getPaths(deviceId, safeName);
      if (fs.existsSync(paths.folderPath)) {
        try {
          const files = fs.readdirSync(paths.folderPath);
          const now = Date.now();
          for (const file of files) {
            // Удаляем только старые .ts сегменты (старше 30 секунд)
            if (file.endsWith('.ts')) {
              const filePath = path.join(paths.folderPath, file);
              try {
                const stats = fs.statSync(filePath);
                const fileAge = now - stats.mtimeMs;
                // Удаляем сегменты старше 30 секунд
                if (fileAge > 30000) {
                  fs.unlinkSync(filePath);
                  logger.debug('[StreamManager] Удален старый сегмент', { filePath, age: fileAge });
                }
              } catch (e) {
                logger.debug('[StreamManager] Не удалось проверить/удалить сегмент', { filePath, error: e.message });
              }
            }
          }
        } catch (e) {
          logger.warn('[StreamManager] Ошибка при очистке старых сегментов', { folderPath: paths.folderPath, error: e.message });
        }
      }
      
      return this.getPlaybackUrl(deviceId, safeName);
    }
    
    // Если не запущен - запускаем
    if (!existing && streamMetadata) {
      if (!streamMetadata.stream_url) {
        logger.error('[StreamManager] Missing stream_url in metadata, cannot start', {
          deviceId,
          safeName,
          metadata: streamMetadata
        });
        return null;
      }
      
      // КРИТИЧНО: Проверяем доступность источника перед запуском FFmpeg
      // Это предотвращает запуск FFmpeg для недоступных источников
      // ВАЖНО: Проверка неблокирующая - если она не удалась, все равно пытаемся запустить FFmpeg
      // (источник может быть медленным или требовать времени на инициализацию)
      if (this.options.sourceCheckEnabled) {
        logger.info('[StreamManager] Checking source availability before starting', {
          deviceId,
          safeName,
          streamUrl: streamMetadata.stream_url
        });
        
        try {
          const sourceAvailable = await this._checkSourceAvailable(streamMetadata.stream_url);
          if (!sourceAvailable) {
            logger.warn('[StreamManager] Source check failed, but will attempt to start FFmpeg anyway', {
              deviceId,
              safeName,
              streamUrl: streamMetadata.stream_url,
              reason: 'Source may be slow or require initialization time'
            });
            // НЕ блокируем запуск - FFmpeg может справиться с медленными источниками
            // Просто логируем предупреждение
          } else {
            logger.info('[StreamManager] Source is available, proceeding with stream start', {
              deviceId,
              safeName,
              streamUrl: streamMetadata.stream_url
            });
          }
        } catch (checkErr) {
          logger.warn('[StreamManager] Source check error, but will attempt to start FFmpeg anyway', {
            deviceId,
            safeName,
            streamUrl: streamMetadata.stream_url,
            error: checkErr.message
          });
          // НЕ блокируем запуск при ошибке проверки
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
          logger.error('[StreamManager] upsertStream returned null, FFmpeg not started', {
            deviceId,
            safeName,
            entry
          });
          return null;
        }
        logger.info('[StreamManager] upsertStream completed', {
          deviceId,
          safeName,
          jobKey: job.key,
          jobStatus: job.status,
          hasProcess: !!job.process
        });
      } catch (err) {
        logger.error('[StreamManager] upsertStream failed', {
          deviceId,
          safeName,
          error: err.message,
          stack: err.stack
        });
        return null;
      }
      
      // КРИТИЧНО: Ждем, пока FFmpeg создаст плейлист
      // Проверяем наличие плейлиста с таймаутом
      // Для DASH стримов может потребоваться больше времени на инициализацию
      const paths = this._getPaths(deviceId, safeName);
      const isDash = streamMetadata.stream_protocol === 'dash' || (streamMetadata.stream_url?.toLowerCase().includes('.mpd'));
      const maxWaitTime = isDash ? 15000 : 10000; // 15 секунд для DASH, 10 для остальных
      const checkInterval = 200; // Проверяем каждые 200мс
      const startTime = Date.now();
      
      while (Date.now() - startTime < maxWaitTime) {
        const job = this.jobs.get(key);
        
        // Проверяем, что процесс запущен и не остановлен
        if (job && job.process && !job.process.killed && job.status !== 'stopped') {
          // Проверяем, что плейлист создан
          if (fs.existsSync(paths.playlistPath)) {
            // Проверяем, что плейлист не пустой (минимум несколько байт)
            try {
              const stats = fs.statSync(paths.playlistPath);
              if (stats.size > 0) {
                logger.info('[StreamManager] Playlist created, ready for playback', {
                  deviceId,
                  safeName,
                  waitTime: Date.now() - startTime,
                  playlistSize: stats.size
                });
                return this.getPlaybackUrl(deviceId, safeName);
              }
            } catch (err) {
              // Игнорируем ошибки проверки размера
            }
          }
        } else if (job && job.status === 'stopped') {
          // Процесс остановился - выходим
          logger.warn('[StreamManager] FFmpeg process stopped before playlist was created', {
            deviceId,
            safeName,
            lastError: job.lastError
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
        waitTime: Date.now() - startTime
      });
      
      // Проверяем последний раз - может быть плейлист создался
      return this.getPlaybackUrl(deviceId, safeName);
    }
    
    return this.getPlaybackUrl(deviceId, safeName);
  }

  getStatus(deviceId, safeName) {
    const key = this._jobKey(deviceId, safeName);
    const job = this.jobs.get(key);
    if (!job) {
      const paths = this._getPaths(deviceId, safeName);
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
   * @param {string} errorType - Тип ошибки
   * @param {number} attempt - Номер попытки (0-based)
   * @returns {number} Задержка в миллисекундах
   */
  _getRestartDelay(errorType, attempt) {
    let baseDelay;
    
    switch (errorType) {
      case 'network':
        baseDelay = 10000; // 10 секунд для сетевых ошибок
        break;
      case 'codec':
        baseDelay = 5000; // 5 секунд для ошибок кодека
        break;
      default:
        baseDelay = this.options.restartInitialDelay; // 5 секунд по умолчанию
    }
    
    // Экспоненциальная задержка: baseDelay * 2^attempt
    const delay = Math.min(baseDelay * Math.pow(2, attempt), this.options.restartMaxDelay);
    
    return delay;
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
      
      // КРИТИЧНО: Проверяем минимум 3 сегмента для стабильного воспроизведения
      const lines = content.split('\n');
      const segments = [];
      
      for (const line of lines) {
        const trimmed = line.trim();
        // Ищем строки с именами сегментов (не начинаются с # и заканчиваются на .ts)
        if (trimmed && !trimmed.startsWith('#') && trimmed.endsWith('.ts')) {
          segments.push(trimmed);
        }
      }
      
      // Требуем минимум 3 сегмента для валидного плейлиста
      if (segments.length < 3) {
        logger.debug('[StreamManager] Playlist has insufficient segments', {
          playlistPath,
          segmentCount: segments.length,
          required: 3
        });
        return false;
      }
      
      // Проверяем, что все сегменты из плейлиста существуют на диске
      // Проверяем первые 3 сегмента (достаточно для валидации)
      const segmentsToCheck = segments.slice(0, Math.min(3, segments.length));
      for (const segment of segmentsToCheck) {
        const segmentPath = path.join(folderPath, segment);
        if (!fs.existsSync(segmentPath)) {
          logger.debug('[StreamManager] Playlist segment missing', {
            playlistPath,
            segment,
            segmentPath
          });
          return false;
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
      if (job.isShared) continue; // Пропускаем shared jobs
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
              // Игнорируем ошибки отдельных файлов
            }
          }
        } catch (err) {
          // Игнорируем ошибки чтения директории
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
        
        // КРИТИЧНО: Читаем актуальный плейлист перед очисткой
        const playlistSegments = this._parsePlaylistSegments(playlistPath);
        
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
        
        const files = fs.readdirSync(folderPath);
        let folderSize = 0;
        let deletedCount = 0;
        
        for (const file of files) {
          const filePath = path.join(folderPath, file);
          
          try {
            const stats = fs.statSync(filePath);
            folderSize += stats.size;
            
            // Удаляем старые .ts файлы
            if (file.endsWith('.ts')) {
              // КРИТИЧНО: НЕ удаляем сегменты, которые упомянуты в плейлисте
              if (playlistSegments.has(file)) {
                // Сегмент в плейлисте - не удаляем, даже если старый
                continue;
              }
              
              const fileAge = now - stats.mtimeMs;
              
              // КРИТИЧНО: Не удаляем сегменты, созданные после последней записи FFmpeg
              // Это предотвращает удаление активных сегментов, даже если они не в плейлисте
              const fileCreatedAfterLastWrite = stats.mtimeMs > lastSegmentWrite;
              if (fileCreatedAfterLastWrite && isRecentlyActive) {
                // Сегмент создан после последней записи FFmpeg - не удаляем
                continue;
              }
              
              // КРИТИЧНО: Используем minAgeForDeletion вместо safeAgeThreshold
              if (fileAge > minAgeForDeletion) {
                fs.unlinkSync(filePath);
                deletedCount++;
                totalFreed += stats.size;
              }
            }
          } catch (err) {
            // Игнорируем ошибки отдельных файлов
          }
        }
        
        // Если папка слишком большая - принудительно удаляем старые файлы
        if (folderSize > maxSizeBytes) {
          logger.warn('[StreamManager] Folder too large, forcing cleanup', {
            deviceId: job.deviceId,
            safeName: job.safeName,
            folderSizeMB: Math.round(folderSize / 1024 / 1024),
            maxSizeMB: this.options.maxFolderSizeMB
          });
          
          // Сортируем файлы по времени модификации и удаляем самые старые
          // КРИТИЧНО: Исключаем сегменты из плейлиста
          const tsFiles = files
            .filter(f => f.endsWith('.ts') && !playlistSegments.has(f))
            .map(f => {
              try {
                return {
                  name: f,
                  path: path.join(folderPath, f),
                  mtime: fs.statSync(path.join(folderPath, f)).mtimeMs
                };
              } catch (err) {
                return null;
              }
            })
            .filter(f => f !== null)
            .sort((a, b) => a.mtime - b.mtime);
          
          // КРИТИЧНО: Удаляем максимум 50% самых старых файлов (которые не в плейлисте)
          const toDelete = Math.floor(tsFiles.length / 2);
          const maxToDelete = Math.min(toDelete, Math.floor(tsFiles.length * 0.5)); // Максимум 50%
          for (let i = 0; i < maxToDelete; i++) {
            try {
              const stats = fs.statSync(tsFiles[i].path);
              fs.unlinkSync(tsFiles[i].path);
              deletedCount++;
              totalFreed += stats.size;
            } catch (err) {
              // Игнорируем ошибки (например, файл уже удален)
              logger.debug('[StreamManager] Error deleting file during forced cleanup', {
                file: tsFiles[i].path,
                error: err.message
              });
            }
          }
        }
        
        if (deletedCount > 0) {
          cleanedCount++;
        }
      } catch (error) {
        logger.warn('[StreamManager] Error during segment cleanup', {
          deviceId: job.deviceId,
          safeName: job.safeName,
          error: error.message
        });
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
    
    // КРИТИЧНО: Очищаем Maps для предотвращения утечек памяти
    this.jobs.clear();
    this.urlToJobMap.clear();
    this.lastAccessTime.clear();
    this.urlToJobMapPending.clear(); // Очищаем pending операции
    this.codecCache.clear(); // Очищаем кэш кодеков
    
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


