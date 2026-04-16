/**
 * Оптимизация видео для Android TV
 * @module video/optimizer
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { VIDEO_OPTIMIZATION_CONFIG_PATH } from '../config/constants.js';
import { getDevicesPath } from '../config/settings-manager.js';
import { checkVideoParameters } from './ffmpeg-wrapper.js';
import { setFileStatus, deleteFileStatus, getFileStatus } from './file-status.js';
import { needsFaststart } from './mp4-faststart.js';
import logger from '../utils/logger.js';
import { jobResourceManager } from '../utils/job-resource-manager.js';

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const VIDEO_OPT_RESOURCE_CPU_UNITS = Math.max(1, Number.parseInt(process.env.VIDEO_OPT_RESOURCE_CPU_UNITS || '1', 10) || 1);
const VIDEO_OPT_RESOURCE_MEMORY_MB = Math.max(128, Number.parseInt(process.env.VIDEO_OPT_RESOURCE_MEMORY_MB || '512', 10) || 512);
const VIDEO_OPT_RESOURCE_TIMEOUT_MS = parseNonNegativeInt(process.env.VIDEO_OPT_RESOURCE_TIMEOUT_MS, 0);

const activeOptimizationJobs = new Map();
const optimizationCancelRequests = new Map();

function makeOptimizationKey(deviceId, fileName) {
  return `${deviceId}::${fileName}`;
}

function createOptimizationCancelError(message = 'Обработка отменена пользователем') {
  const error = new Error(message);
  error.code = 'EOPT_CANCELLED';
  return error;
}

function isOptimizationCancelError(error) {
  return error?.code === 'EOPT_CANCELLED';
}

function hasOptimizationCancelRequest(jobKey) {
  return optimizationCancelRequests.has(jobKey);
}

function clearOptimizationCancelRequest(jobKey) {
  optimizationCancelRequests.delete(jobKey);
}

function parseFrameRate(rawValue = '') {
  const value = String(rawValue || '').trim();
  if (!value) return 0;

  const [numRaw, denRaw] = value.split('/');
  const num = Number(numRaw);
  const den = Number(denRaw);

  if (!Number.isFinite(num)) return 0;
  if (!Number.isFinite(den) || den === 0) return Math.round(num);

  return Math.round(num / den);
}

function spawnManagedProcess(command, args = []) {
  return spawn(command, args, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function killManagedProcess(childProcess, signal = 'SIGKILL') {
  if (!childProcess) return false;

  const pid = Number(childProcess.pid);
  const canKillGroup = process.platform !== 'win32' && Number.isFinite(pid) && pid > 0;

  if (canKillGroup) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (_error) {
      // fallback to direct kill below
    }
  }

  try {
    childProcess.kill(signal);
    return true;
  } catch (_error) {
    return false;
  }
}

function throwIfOptimizationCancelled(jobKey) {
  if (!hasOptimizationCancelRequest(jobKey)) {
    return;
  }

  const reason = optimizationCancelRequests.get(jobKey) || 'Обработка отменена пользователем';
  throw createOptimizationCancelError(reason);
}

export function hasActiveOptimizationJob(deviceId, fileName) {
  return activeOptimizationJobs.has(makeOptimizationKey(deviceId, fileName));
}

export function cancelOptimizationJob(deviceId, fileName, reason = 'Обработка отменена пользователем') {
  const key = makeOptimizationKey(deviceId, fileName);
  optimizationCancelRequests.set(key, reason);

  const activeJob = activeOptimizationJobs.get(key);
  if (!activeJob?.process) {
    return {
      requested: true,
      active: false,
      reason
    };
  }

  activeJob.cancelRequested = true;
  activeJob.cancelReason = reason;

  const killed = killManagedProcess(activeJob.process, 'SIGKILL');
  if (!killed) {
    logger.warn('[VideoOpt] Failed to kill process on cancel', {
      deviceId,
      fileName
    });
  }

  return {
    requested: true,
    active: true,
    reason
  };
}

async function runCancellableVideoProbe(filePath, jobKey, timeoutMs = 30000) {
  throwIfOptimizationCancelled(jobKey);

  return await new Promise((resolve, reject) => {
    const ffprobeArgs = [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,bit_rate,profile,level,pix_fmt,channels,sample_rate',
      '-show_entries', 'format=duration,bit_rate',
      '-of', 'json',
      filePath
    ];

    const probeProcess = spawnManagedProcess('ffprobe', ffprobeArgs);
    activeOptimizationJobs.set(jobKey, {
      process: probeProcess,
      cancelRequested: hasOptimizationCancelRequest(jobKey),
      cancelReason: optimizationCancelRequests.get(jobKey) || null,
      startedAt: Date.now(),
      stage: 'checking'
    });

    if (hasOptimizationCancelRequest(jobKey)) {
      killManagedProcess(probeProcess, 'SIGKILL');
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanupActiveJob = () => {
      const activeJob = activeOptimizationJobs.get(jobKey);
      if (activeJob?.process === probeProcess) {
        activeOptimizationJobs.delete(jobKey);
      }
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      killManagedProcess(probeProcess, 'SIGKILL');
      cleanupActiveJob();
      reject(new Error('FFprobe timeout'));
    }, timeoutMs);

    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }

    probeProcess.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    probeProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    probeProcess.on('error', (error) => {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);

      const activeJob = activeOptimizationJobs.get(jobKey);
      const cancelReason = activeJob?.cancelReason || optimizationCancelRequests.get(jobKey) || 'Обработка отменена пользователем';
      const wasCancelled = Boolean(activeJob?.cancelRequested || hasOptimizationCancelRequest(jobKey));

      cleanupActiveJob();
      if (wasCancelled) {
        reject(createOptimizationCancelError(cancelReason));
        return;
      }

      reject(error);
    });

    probeProcess.on('close', (code) => {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);

      const activeJob = activeOptimizationJobs.get(jobKey);
      const cancelReason = activeJob?.cancelReason || optimizationCancelRequests.get(jobKey) || 'Обработка отменена пользователем';
      const wasCancelled = Boolean(activeJob?.cancelRequested || hasOptimizationCancelRequest(jobKey));

      cleanupActiveJob();
      if (wasCancelled) {
        reject(createOptimizationCancelError(cancelReason));
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr.trim() || `FFprobe exited with code ${code}`));
        return;
      }

      try {
        const data = JSON.parse(stdout || '{}');
        const streams = Array.isArray(data.streams) ? data.streams : [];
        const videoStream = streams.find((stream) => stream?.codec_type === 'video') || streams[0];
        const audioStream = streams.find((stream) => stream?.codec_type === 'audio') || null;
        const fmt = data.format || {};

        if (!videoStream) {
          resolve(null);
          return;
        }

        const videoBitrate = parseInt(videoStream.bit_rate, 10) || 0;
        const formatBitrate = parseInt(fmt.bit_rate, 10) || 0;
        const audioBitrate = parseInt(audioStream?.bit_rate, 10) || 0;

        resolve({
          codec: videoStream.codec_name,
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          fps: parseFrameRate(videoStream.r_frame_rate),
          bitrate: videoBitrate || formatBitrate,
          profile: videoStream.profile || 'unknown',
          level: videoStream.level || 0,
          pixFmt: videoStream.pix_fmt || null,
          duration: fmt.duration ? Math.round(parseFloat(fmt.duration)) : 0,
          audioCodec: audioStream?.codec_name || null,
          audioBitrate,
          audioChannels: Number(audioStream?.channels) || 0,
          audioSampleRate: Number(audioStream?.sample_rate) || 0
        });
      } catch (error) {
        reject(new Error(`FFprobe JSON parse failed: ${error.message}`));
      }
    });
  });
}

// Загрузка конфигурации оптимизации
let videoOptConfig = {};
try {
  if (fs.existsSync(VIDEO_OPTIMIZATION_CONFIG_PATH)) {
    videoOptConfig = JSON.parse(fs.readFileSync(VIDEO_OPTIMIZATION_CONFIG_PATH, 'utf-8'));
    logger.info('[VideoOpt] ✅ Конфигурация загружена');
  }
} catch (e) {
  logger.warn('[VideoOpt] ⚠️ Ошибка загрузки конфигурации, используем defaults', { error: e.message, stack: e.stack });
  videoOptConfig = { enabled: false };
}

/**
 * Получить конфигурацию оптимизации
 * @returns {Object} Конфигурация
 */
export function getVideoOptConfig() {
  return videoOptConfig;
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.ogg', '.mkv', '.mov', '.avi']);
const MP4_LIKE_EXTENSIONS = new Set(['.mp4', '.m4v']);
const UNSUPPORTED_PROFILES = new Set(['High 10', 'High 4:2:2', 'High 4:4:4 Predictive']);
const SUPPORTED_AUDIO_CODECS = new Set(['aac', 'mp3']);
const SUPPORTED_PIXEL_FORMATS = new Set(['yuv420p', 'yuvj420p']);

function normalizeCodecName(codec = '') {
  const normalized = String(codec || '').trim().toLowerCase();
  if (normalized === 'h.264') return 'h264';
  return normalized;
}

function normalizePixelFormat(pixFmt = '') {
  return String(pixFmt || '').trim().toLowerCase();
}

function getThresholds() {
  const thresholds = videoOptConfig.thresholds || {};
  return {
    maxWidth: Number(thresholds.maxWidth) || 3840,
    maxHeight: Number(thresholds.maxHeight) || 2160,
    maxFps: Number(thresholds.maxFps) || 60,
    maxBitrate: Number(thresholds.maxBitrate) || 25000000
  };
}

function isAudioCodecCompatible(codec) {
  if (!codec) return true;
  return SUPPORTED_AUDIO_CODECS.has(normalizeCodecName(codec));
}

function resolveTargetProfile(params = {}) {
  const profiles = videoOptConfig.profiles || {};

  const fallbackProfile =
    profiles['1080p'] ||
    profiles['2160p'] ||
    profiles['720p'] || {
      width: 1920,
      height: 1080,
      fps: 30,
      bitrate: '4000k',
      maxrate: '5000k',
      bufsize: '8000k',
      profile: 'main',
      level: '4.0',
      audioBitrate: '192k'
    };

  if (params.width <= 1280 && params.height <= 720 && profiles['720p']) {
    return { key: '720p', profile: profiles['720p'] };
  }

  if (params.width <= 1920 && params.height <= 1080 && profiles['1080p']) {
    return { key: '1080p', profile: profiles['1080p'] };
  }

  if (params.width <= 3840 && params.height <= 2160 && profiles['2160p']) {
    return { key: '2160p', profile: profiles['2160p'] };
  }

  if (profiles['2160p']) {
    return { key: '2160p', profile: profiles['2160p'] };
  }

  return { key: 'fallback', profile: fallbackProfile };
}

async function runFfmpegWithProgress({ deviceId, fileName, ffmpegArgs, io, jobKey, timeoutMs = 30 * 60 * 1000 }) {
  const resourceRequestId = `video-opt:${deviceId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  let resourceReservation = null;

  try {
    throwIfOptimizationCancelled(jobKey);

    resourceReservation = await jobResourceManager.acquire({
      id: resourceRequestId,
      jobType: 'video-opt',
      cpuUnits: VIDEO_OPT_RESOURCE_CPU_UNITS,
      memoryMb: VIDEO_OPT_RESOURCE_MEMORY_MB,
      priority: 0,
      timeoutMs: VIDEO_OPT_RESOURCE_TIMEOUT_MS,
      meta: {
        deviceId,
        fileName
      }
    });

    throwIfOptimizationCancelled(jobKey);
  } catch (resourceError) {
    if (isOptimizationCancelError(resourceError)) {
      throw resourceError;
    }

    const message = resourceError.message === 'Resource acquisition timeout'
      ? 'Нет свободных ресурсов для оптимизации видео'
      : (resourceError.message || 'Не удалось зарезервировать ресурсы для оптимизации');
    throw new Error(message);
  }

  try {
    await new Promise((resolve, reject) => {
      const ffmpegProcess = spawnManagedProcess('ffmpeg', ffmpegArgs);
      activeOptimizationJobs.set(jobKey, {
        deviceId,
        fileName,
        process: ffmpegProcess,
        cancelRequested: hasOptimizationCancelRequest(jobKey),
        cancelReason: optimizationCancelRequests.get(jobKey) || null,
        startedAt: Date.now()
      });

      if (hasOptimizationCancelRequest(jobKey)) {
        killManagedProcess(ffmpegProcess, 'SIGKILL');
      }

      let duration = 0;
      let stderr = '';
      let isResolved = false;
      let lastProgress = -1;

      const timeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          logger.error('[VideoOpt] ⏱️ FFmpeg timeout', { deviceId, fileName, timeoutMs });
          killManagedProcess(ffmpegProcess, 'SIGKILL');
          activeOptimizationJobs.delete(jobKey);
          reject(new Error('FFmpeg timeout'));
        }
      }, timeoutMs);

      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;

        if (duration === 0) {
          const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
          if (durationMatch) {
            const hours = parseInt(durationMatch[1], 10);
            const minutes = parseInt(durationMatch[2], 10);
            const seconds = parseFloat(durationMatch[3]);
            duration = hours * 3600 + minutes * 60 + seconds;
          }
        }

        if (duration > 0) {
          const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
          if (timeMatch) {
            const hours = parseInt(timeMatch[1], 10);
            const minutes = parseInt(timeMatch[2], 10);
            const seconds = parseFloat(timeMatch[3]);
            const currentTime = hours * 3600 + minutes * 60 + seconds;

            const rawProgress = (currentTime / duration) * 100;
            const progress = Math.min(90, Math.max(10, 10 + Math.round(rawProgress * 0.8)));

            if (progress !== lastProgress) {
              lastProgress = progress;
              setFileStatus(deviceId, fileName, { status: 'processing', progress, canPlay: false });

              if (progress % 2 === 0) {
                io.emit('file/progress', { device_id: deviceId, file: fileName, progress });
              }
            }
          }
        }
      });

      ffmpegProcess.on('close', (code) => {
        if (isResolved) {
          return;
        }

        clearTimeout(timeout);
        isResolved = true;

        const activeJob = activeOptimizationJobs.get(jobKey);
        const cancelReason = activeJob?.cancelReason || optimizationCancelRequests.get(jobKey) || 'Обработка отменена пользователем';
        const wasCancelled = Boolean(activeJob?.cancelRequested || hasOptimizationCancelRequest(jobKey));
        activeOptimizationJobs.delete(jobKey);

        if (wasCancelled) {
          reject(createOptimizationCancelError(cancelReason));
          return;
        }

        if (code === 0) {
          resolve();
        } else {
          logger.error('[VideoOpt] ❌ FFmpeg exited with error', {
            deviceId,
            fileName,
            code,
            stderr: stderr.substring(Math.max(0, stderr.length - 700))
          });
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpegProcess.on('error', (err) => {
        if (isResolved) {
          return;
        }

        clearTimeout(timeout);
        isResolved = true;
        const activeJob = activeOptimizationJobs.get(jobKey);
        activeOptimizationJobs.delete(jobKey);
        if (activeJob?.cancelRequested || hasOptimizationCancelRequest(jobKey)) {
          reject(createOptimizationCancelError(activeJob?.cancelReason || optimizationCancelRequests.get(jobKey) || 'Обработка отменена пользователем'));
          return;
        }

        reject(err);
      });
    });
  } finally {
    activeOptimizationJobs.delete(jobKey);

    if (resourceReservation?.release) {
      try {
        resourceReservation.release();
      } catch (releaseErr) {
        logger.warn('[VideoOpt] Failed to release resource reservation', {
          deviceId,
          fileName,
          reservationId: resourceReservation.id,
          error: releaseErr.message
        });
      }
    } else {
      jobResourceManager.release(resourceRequestId);
    }
  }
}

/**
 * Проверяем нужна ли оптимизация видео
 * @param {Object} params - Параметры видео {codec, width, height, fps, bitrate, profile}
 * @returns {boolean} true если требуется оптимизация
 */
export function needsOptimization(params) {
  if (!params || !videoOptConfig.enabled) return false;

  const thresholds = getThresholds();
  const width = Number(params.width) || 0;
  const height = Number(params.height) || 0;
  const fps = Number(params.fps) || 0;
  const bitrate = Number(params.bitrate) || 0;
  const profile = String(params.profile || '').trim();
  const codec = normalizeCodecName(params.codec);
  const pixFmt = normalizePixelFormat(params.pixFmt);

  return (
    width > thresholds.maxWidth ||
    height > thresholds.maxHeight ||
    fps > thresholds.maxFps ||
    (bitrate > 0 && bitrate > thresholds.maxBitrate) ||
    UNSUPPORTED_PROFILES.has(profile) ||
    codec !== 'h264' ||
    (pixFmt && !SUPPORTED_PIXEL_FORMATS.has(pixFmt))
  );
}

/**
 * Автоматическая оптимизация видео для Android TV
 * @param {string} deviceId - ID устройства
 * @param {string} fileName - Имя файла
 * @param {Object} devices - Объект devices
 * @param {Object} io - Socket.IO instance
 * @param {Object} fileNamesMap - Маппинг имен файлов
 * @param {Function} saveFileNamesMapFn - Функция сохранения маппинга
 * @returns {Promise<Object>} Результат оптимизации
 */
export async function autoOptimizeVideo(deviceId, fileName, devices, io, fileNamesMap, saveFileNamesMapFn) {
  const d = devices[deviceId];
  if (!d) return { success: false, message: 'Device not found' };

  const optimizationKey = makeOptimizationKey(deviceId, fileName);
  const currentStatus = getFileStatus(deviceId, fileName);
  const currentState = String(currentStatus?.status || '').toLowerCase();

  if (hasActiveOptimizationJob(deviceId, fileName) || currentState === 'checking' || currentState === 'processing') {
    return { success: false, message: 'Optimization already in progress', alreadyRunning: true };
  }

  clearOptimizationCancelRequest(optimizationKey);

  if (!videoOptConfig.enabled) {
    return { success: false, message: 'Video optimization disabled' };
  }

  // ИСПРАВЛЕНО: Получаем путь из БД для новой архитектуры storage
  const { getFileMetadata } = await import('../database/files-metadata.js');
  const metadata = getFileMetadata(deviceId, fileName);

  let filePath;
  if (metadata && metadata.file_path) {
    // Медиафайл из БД (в /content/)
    filePath = metadata.file_path;
  } else {
    // Fallback для PDF/PPTX/folders (в /content/{device}/)
    // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
    const devicesPath = getDevicesPath();
    const deviceFolder = path.join(devicesPath, d.folder);
    filePath = path.join(deviceFolder, fileName);
  }

  if (!fs.existsSync(filePath)) {
    return { success: false, message: 'File not found' };
  }

  const ext = path.extname(fileName).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    return { success: false, message: 'Not a video file' };
  }

  logger.info(`[VideoOpt] 🔍 Проверка: ${fileName}`, { deviceId, fileName });

  // Устанавливаем статус "проверка"
  setFileStatus(deviceId, fileName, { status: 'checking', progress: 0, canPlay: false });
  throwIfOptimizationCancelled(optimizationKey);

  // 1) Быстрый старт: берем из БД что есть
  let params = metadata
    ? {
      codec: metadata.video_codec,
      width: metadata.video_width || 0,
      height: metadata.video_height || 0,
      fps: 0,
      bitrate: metadata.video_bitrate || 0,
      profile: metadata.video_profile || 'unknown',
      level: 0,
      duration: metadata.video_duration || 0,
      pixFmt: null,
      audioCodec: metadata.audio_codec || null,
      audioBitrate: metadata.audio_bitrate || 0,
      audioChannels: metadata.audio_channels || 0
    }
    : null;

  // 2) Дозаполняем через ffprobe только если нужно
  const shouldProbe =
    !params ||
    !params.codec ||
    !params.width ||
    !params.height ||
    !params.fps ||
    !params.pixFmt ||
    !params.audioCodec;

  if (shouldProbe) {
    const probed = await runCancellableVideoProbe(filePath, optimizationKey);
    if (probed) {
      params = { ...(params || {}), ...probed };
    }
  }

  throwIfOptimizationCancelled(optimizationKey);

  if (!params || !params.codec) {
    deleteFileStatus(deviceId, fileName);
    return { success: false, message: 'Cannot read video parameters' };
  }

  logger.info('[VideoOpt] 📊 Итоговые параметры файла', {
    deviceId,
    fileName,
    width: params.width,
    height: params.height,
    fps: params.fps,
    bitrate: params.bitrate,
    codec: params.codec,
    profile: params.profile,
    pixFmt: params.pixFmt,
    audioCodec: params.audioCodec
  });

  const isMp4Like = MP4_LIKE_EXTENSIONS.has(ext);
  const videoNeedsTranscode = needsOptimization(params);
  const audioNeedsTranscode = !isAudioCodecCompatible(params.audioCodec);
  const containerNeedsRewrite = !isMp4Like;

  let seekRisk = false;
  if (isMp4Like) {
    try {
      seekRisk = await needsFaststart(filePath);
    } catch (error) {
      logger.warn('[VideoOpt] ⚠️ Не удалось проверить seek-структуру, включаем безопасный режим', {
        deviceId,
        fileName,
        error: error.message
      });
      seekRisk = true;
    }
  }

  const requiresWork =
    videoNeedsTranscode ||
    audioNeedsTranscode ||
    containerNeedsRewrite ||
    seekRisk;

  if (!requiresWork) {
    logger.info(`[VideoOpt] ✅ Видео оптимально: ${fileName}`, { deviceId, fileName });
    setFileStatus(deviceId, fileName, { status: 'ready', progress: 100, canPlay: true });

    // КРИТИЧНО: Отправляем событие клиентам даже если оптимизация не требуется
    io.emit('devices/updated');
    io.emit('file/ready', { device_id: deviceId, file: fileName });

    return { success: true, message: 'Already optimized', optimized: false };
  }

  logger.info(`[VideoOpt] ⚠️ Требуется оптимизация: ${fileName}`, { deviceId, fileName });

  // Устанавливаем статус "обработка"
  setFileStatus(deviceId, fileName, { status: 'processing', progress: 5, canPlay: false });
  io.emit('file/processing', { device_id: deviceId, file: fileName });
  io.emit('file/progress', { device_id: deviceId, file: fileName, progress: 5 });
  logger.info(`[VideoOpt] 📊 Начало обработки: ${fileName} (5%)`, {
    deviceId,
    fileName,
    videoNeedsTranscode,
    audioNeedsTranscode,
    containerNeedsRewrite,
    seekRisk
  });

  const { key: targetProfileKey, profile: targetProfile } = resolveTargetProfile(params);
  const optConfig = videoOptConfig.optimization || {};

  // КРИТИЧНО: Всегда конвертируем в MP4 (даже если оригинал WebM/MKV/AVI)
  const outputExt = '.mp4';

  // ИСПРАВЛЕНО: Временный файл сохраняем в той же папке что и оригинал
  const fileDir = path.dirname(filePath);
  let tempPath = path.join(fileDir, `.optimizing_${Date.now()}${outputExt}`);

  // Определяем финальное имя файла
  const baseFileName = path.basename(fileName, ext);
  const finalFileName = ext === '.mp4' ? fileName : `${baseFileName}.mp4`;
  const finalPath = path.join(fileDir, finalFileName);

  let ffmpegArgs = [];
  let processingMode = 'transcode';

  if (!videoNeedsTranscode) {
    if (seekRisk && isMp4Like && !audioNeedsTranscode) {
      processingMode = 'faststart';
    } else {
      processingMode = 'remux';
    }

    ffmpegArgs = [
      '-i', filePath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'copy'
    ];

    if (audioNeedsTranscode) {
      ffmpegArgs.push(
        '-c:a', optConfig.audioCodec || 'aac',
        '-b:a', targetProfile.audioBitrate || '192k',
        '-ar', String(optConfig.audioSampleRate || '44100'),
        '-ac', String(optConfig.audioChannels || 2)
      );
    } else {
      ffmpegArgs.push('-c:a', 'copy');
    }

    ffmpegArgs.push('-movflags', '+faststart', '-y', tempPath);
  } else {
    processingMode = 'transcode';
    ffmpegArgs = [
      '-i', filePath,
      '-c:v', 'libx264',
      '-profile:v', targetProfile.profile,
      '-level', String(targetProfile.level),
      '-vf', `scale=${targetProfile.width}:${targetProfile.height}`,
      '-r', String(targetProfile.fps),
      '-b:v', targetProfile.bitrate,
      '-maxrate', targetProfile.maxrate,
      '-bufsize', targetProfile.bufsize,
      '-g', String(targetProfile.fps * 2),
      '-preset', optConfig.preset || 'medium',
      '-pix_fmt', optConfig.pixelFormat || 'yuv420p',
      '-c:a', optConfig.audioCodec || 'aac',
      '-b:a', targetProfile.audioBitrate,
      '-ar', String(optConfig.audioSampleRate || '44100'),
      '-ac', String(optConfig.audioChannels || 2),
      '-movflags', '+faststart',
      '-y', tempPath
    ];
  }

  logger.info('[VideoOpt] 🎬 Выбран режим обработки', {
    deviceId,
    fileName,
    processingMode,
    targetProfile: targetProfileKey,
    outputFile: finalFileName
  });

  try {
    await runFfmpegWithProgress({ deviceId, fileName, ffmpegArgs, io, jobKey: optimizationKey });

    setFileStatus(deviceId, fileName, { status: 'processing', progress: 90, canPlay: false });
    io.emit('file/progress', { device_id: deviceId, file: fileName, progress: 90 });
    logger.info(`[VideoOpt] ✅ Конвертация завершена: ${fileName} (90%)`, { deviceId, fileName });

    // Проверяем что файл создан и не пустой
    const stats = fs.statSync(tempPath);
    if (stats.size === 0) {
      throw new Error('Converted file is empty');
    }

    let resultingSafeName = fileName;
    let resultingPath = filePath;

    // КРИТИЧНО: Удаляем оригинал и заменяем оптимизированным
    // Если конвертация изменила формат (webm→mp4, m4v→mp4) - переименовываем файл
    if (ext !== '.mp4') {
      logger.info(`[VideoOpt] 🔄 Замена формата: ${fileName} → ${finalFileName}`, { deviceId, fileName, finalFileName });

      // Удаляем оригинал (.webm, .mkv, etc)
      fs.unlinkSync(filePath);

      // Переименовываем временный → финальное имя с .mp4
      fs.renameSync(tempPath, finalPath);

      resultingSafeName = finalFileName;
      resultingPath = finalPath;

      // Обновляем маппинг имен (оригинальное имя сохраняем)
      if (fileNamesMap[deviceId] && fileNamesMap[deviceId][fileName]) {
        const originalName = fileNamesMap[deviceId][fileName];
        delete fileNamesMap[deviceId][fileName];
        fileNamesMap[deviceId][finalFileName] = originalName;
        saveFileNamesMapFn(fileNamesMap);
        logger.info(`[VideoOpt] 📝 Маппинг обновлен: ${fileName} → ${finalFileName}`, { deviceId, fileName, finalFileName, originalName });
      }

      // Устанавливаем права
      fs.chmodSync(finalPath, 0o644);

      // Обновляем список файлов устройства
      const fileIndex = d.files.indexOf(fileName);
      if (fileIndex >= 0) {
        d.files[fileIndex] = finalFileName;
        if (d.fileNames && d.fileNames[fileIndex]) {
          // fileNames уже правильное из маппинга
        }
      }

      logger.info(`[VideoOpt] 🎉 Видео конвертировано: ${fileName} → ${finalFileName}`, { deviceId, fileName, finalFileName, sizeMB: Math.round(stats.size / 1024 / 1024) });
    } else {
      // MP4 → MP4 (просто замена на оптимизированный)
      fs.unlinkSync(filePath);
      fs.renameSync(tempPath, filePath);

      // Устанавливаем права
      fs.chmodSync(filePath, 0o644);

      logger.info(`[VideoOpt] 🎉 Видео оптимизировано: ${fileName}`, { deviceId, fileName, sizeMB: Math.round(stats.size / 1024 / 1024) });
    }

    const finalStats = fs.statSync(resultingPath);
    const finalParams = (await checkVideoParameters(resultingPath)) || params;

    // Обновляем метаданные в БД после обработки
    if (metadata) {
      const { deleteFileMetadata, saveFileMetadata } = await import('../database/files-metadata.js');

      if (resultingSafeName !== fileName) {
        deleteFileMetadata(deviceId, fileName);
      }

      saveFileMetadata({
        deviceId,
        safeName: resultingSafeName,
        originalName: fileNamesMap[deviceId]?.[resultingSafeName] || metadata.original_name || resultingSafeName,
        filePath: resultingPath,
        fileSize: finalStats.size,
        md5Hash: metadata.md5_hash,
        partialMd5: metadata.partial_md5,
        mimeType: 'video/mp4',
        videoParams: {
          width: finalParams.width,
          height: finalParams.height,
          duration: finalParams.duration,
          codec: finalParams.codec,
          profile: finalParams.profile,
          bitrate: finalParams.bitrate
        },
        audioParams: {
          codec: finalParams.audioCodec || metadata.audio_codec,
          bitrate: finalParams.audioBitrate || metadata.audio_bitrate,
          channels: finalParams.audioChannels || metadata.audio_channels
        },
        fileMtime: finalStats.mtimeMs
      });

      logger.info('[VideoOpt] 📊 Метаданные обновлены в БД', {
        deviceId,
        originalFile: fileName,
        finalFile: resultingSafeName,
        mode: processingMode
      });
    }

    if (resultingSafeName !== fileName) {
      deleteFileStatus(deviceId, fileName);
    }

    setFileStatus(deviceId, resultingSafeName, { status: 'ready', progress: 100, canPlay: true });
    io.emit('file/progress', { device_id: deviceId, file: resultingSafeName, progress: 100 });
    io.emit('devices/updated');
    io.emit('file/ready', { device_id: deviceId, file: resultingSafeName });
    clearOptimizationCancelRequest(optimizationKey);

    return { 
      success: true, 
      message: 'Optimized successfully', 
      optimized: true,
      mode: processingMode,
      originalFile: fileName,
      finalFile: resultingSafeName,
      formatChanged: resultingSafeName !== fileName,
      sizeBytes: finalStats.size,
      params: {
        before: params,
        after: {
          width: finalParams.width,
          height: finalParams.height,
          fps: finalParams.fps,
          bitrate: finalParams.bitrate,
          codec: finalParams.codec,
          profile: finalParams.profile
        }
      }
    };

  } catch (error) {
    const cancelled = isOptimizationCancelError(error) || hasOptimizationCancelRequest(optimizationKey);
    if (cancelled) {
      logger.info('[VideoOpt] ⏹️ Обработка отменена пользователем', {
        deviceId,
        fileName,
        reason: error.message
      });

      if (tempPath && fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }

      setFileStatus(deviceId, fileName, {
        status: 'ready',
        progress: 100,
        canPlay: true
      });
      io.emit('devices/updated');
      io.emit('file/cancelled', {
        device_id: deviceId,
        file: fileName,
        reason: error.message || 'Обработка отменена пользователем'
      });

      clearOptimizationCancelRequest(optimizationKey);
      return { success: false, cancelled: true, message: error.message || 'Обработка отменена пользователем' };
    }

    logger.error(`[VideoOpt] ❌ Ошибка конвертации`, { error: error.message, stack: error.stack, deviceId, fileName });

    // Очищаем временный файл
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    // Определяем причину ошибки для понятного сообщения
    let errorMessage = error.message;

    if (params && params.codec && params.codec.toLowerCase() === 'av1') {
      errorMessage = `Кодек AV1 не поддерживается вашей версией FFmpeg. Файл воспроизводится как WebM, но может тормозить на Android. Рекомендация: конвертируйте файл в H.264 вручную или обновите FFmpeg.`;
      logger.warn(`[VideoOpt] ⚠️ AV1 кодек не поддерживается`, { deviceId, fileName });
    } else if (params && params.codec && params.codec.toLowerCase() === 'vp9') {
      errorMessage = `Кодек VP9 может не поддерживаться. Файл воспроизводится как WebM, но может тормозить на Android.`;
    }

    // Устанавливаем статус "ошибка" но файл можно воспроизвести (оригинал)
    setFileStatus(deviceId, fileName, { 
      status: 'error', 
      progress: 0, 
      canPlay: true,  // Оригинал можно воспроизвести
      error: errorMessage 
    });
    io.emit('file/progress', { device_id: deviceId, file: fileName, progress: 0 });
    io.emit('file/error', { device_id: deviceId, file: fileName, error: errorMessage });
    clearOptimizationCancelRequest(optimizationKey);

    return { success: false, message: errorMessage };
  }
}

