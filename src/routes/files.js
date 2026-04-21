/**
 * API Routes для управления файлами устройств
 * @module routes/files
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import archiver from 'archiver';
import sanitizeFilename from 'sanitize-filename';
import { spawn } from 'child_process';
import { getDevicesPath, getDataRoot } from '../config/settings-manager.js';
import { ROOT } from '../config/constants.js';
import { sanitizeDeviceId } from '../utils/sanitize.js';
import { extractZipToFolder, getFolderImagesCount } from '../converters/folder-converter.js';
import { makeSafeFolderName, makeSafeFilename } from '../utils/transliterate.js';
import { uploadLimiter, deleteLimiter, readLimiter } from '../middleware/rate-limit.js';
import { auditLog, AuditAction } from '../utils/audit-logger.js';
import logger, { logFile, logSecurity } from '../utils/logger.js';
import { validatePath } from '../utils/path-validator.js';
import { getCachedResolution, clearResolutionCache } from '../video/resolution-cache.js';
import { processUploadedFilesAsync, processUploadedStaticContent } from '../utils/file-metadata-processor.js';
import { getFileMetadata, deleteFileMetadata, getDeviceFilesMetadata, deleteDeviceFilesMetadata, saveFileMetadata, countFileReferences, updateFileOriginalName, createStreamingEntry, updateStreamMetadata, cleanupMissingFiles } from '../database/files-metadata.js';
import { setFileStatus as setGlobalFileStatus } from '../video/file-status.js';
import { removeStreamJob } from '../streams/stream-manager.js';
import { getTrailerPath } from '../video/trailer-generator.js';
import { requireSpeaker } from '../middleware/auth.js';
import { getUserDevices, hasDeviceAccess } from '../middleware/device-access.js';
import { validateUploadSize } from '../middleware/multer-config.js';
import { validateFilesAsync } from '../middleware/file-validation.js';
import { getDatabase } from '../database/database.js';
import { resolveContentType, STATIC_CONTENT_TYPES, VIDEO_EXTENSIONS } from '../config/file-types.js';
import { ensureLocalYtDlpBinary } from '../utils/yt-dlp.js';
import { needsFaststart } from '../video/mp4-faststart.js';
import { needsOptimization, getVideoOptConfig } from '../video/optimizer.js';
import { notificationsManager } from '../utils/notifications.js';
import { jobResourceManager } from '../utils/job-resource-manager.js';

const STREAM_PROTOCOLS = new Set(['auto', 'hls', 'dash']);
const VIDEO_PROCESSING_EXTENSIONS = new Set(['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi', '.m4v']);
const MP4_COMPATIBLE_EXTENSIONS = new Set(['.mp4', '.m4v']);
const AUDIO_COMPATIBLE_CODECS = new Set(['aac', 'mp3']);
const YTDLP_FINAL_PATH_MARKER = '__VC_FINAL_PATH__';
const YTDLP_TITLE_MARKER = '__VC_TITLE__';

function normalizeCodecName(codec = '') {
  return String(codec || '').trim().toLowerCase();
}

function inferNeedsOptimizationFromMetadata(safeName, metadata) {
  const ext = path.extname(String(safeName || '')).toLowerCase();
  if (!VIDEO_PROCESSING_EXTENSIONS.has(ext) || !metadata) {
    return null;
  }

  const codec = normalizeCodecName(metadata.video_codec);
  const audioCodec = normalizeCodecName(metadata.audio_codec);
  const videoParams = {
    codec,
    width: Number(metadata.video_width) || 0,
    height: Number(metadata.video_height) || 0,
    fps: Number(metadata.video_fps) || 0,
    bitrate: Number(metadata.video_bitrate) || 0,
    profile: String(metadata.video_profile || ''),
    pixFmt: String(metadata.video_pix_fmt || ''),
    audioCodec
  };

  const hasEnoughVideoData = Boolean(
    videoParams.codec ||
      videoParams.width ||
      videoParams.height ||
      videoParams.bitrate ||
      videoParams.profile ||
      videoParams.pixFmt
  );

  let shouldOptimize = false;
  if (!MP4_COMPATIBLE_EXTENSIONS.has(ext)) {
    shouldOptimize = true;
  }

  if (audioCodec && !AUDIO_COMPATIBLE_CODECS.has(audioCodec)) {
    shouldOptimize = true;
  }

  if (hasEnoughVideoData) {
    shouldOptimize = shouldOptimize || needsOptimization(videoParams);
    return shouldOptimize;
  }

  return null;
}

function detectStreamProtocolFromUrl(url = '') {
  const lower = (url || '').toLowerCase();
  if (!lower) return null;
  if (lower.includes('.m3u8') || lower.includes('format=m3u8')) {
    return 'hls';
  }
  if (lower.includes('.mpd') || lower.includes('format=mpd') || lower.includes('dash-live') || lower.includes('dash/')) {
    return 'dash';
  }
  return null;
}

function detectStreamProtocolFromMime(mimeType = '') {
  const lower = (mimeType || '').toLowerCase();
  if (!lower) return null;
  if (lower.includes('dash')) {
    return 'dash';
  }
  if (lower.includes('mpegurl') || lower.includes('hls')) {
    return 'hls';
  }
  return null;
}

function normalizeStreamProtocol(protocol, url, mimeType) {
  const normalized = (protocol || '').toString().trim().toLowerCase();
  if (normalized && STREAM_PROTOCOLS.has(normalized) && normalized !== 'auto') {
    return normalized;
  }
  const byMime = detectStreamProtocolFromMime(mimeType);
  if (byMime) {
    return byMime;
  }
  const byUrl = detectStreamProtocolFromUrl(url);
  return byUrl || 'hls';
}

function isDirectPlaybackAvailable(protocol) {
  return protocol === 'hls' || protocol === 'dash';
}

<<<<<<< HEAD
=======
function shouldProxyStreamProtocol(protocol) {
  return !isDirectPlaybackAvailable(protocol);
}

>>>>>>> 76d29d0af24a9d06f52ca3c5612c50a10cc64ed0
function buildDashManifestRelayUrl(deviceId, safeName) {
  if (!deviceId || !safeName) {
    return null;
  }
  return `/api/devices/${encodeURIComponent(deviceId)}/streams/${encodeURIComponent(safeName)}/dash-manifest.mpd`;
}

function buildDashUtcSyncUrl(deviceId, safeName) {
  if (!deviceId || !safeName) {
    return null;
  }
  return `/api/devices/${encodeURIComponent(deviceId)}/streams/${encodeURIComponent(safeName)}/dash-utc-time.xml`;
}

function resolveDirectStreamPlaybackUrl(deviceId, safeName, streamUrl, protocol) {
  if (protocol === 'dash') {
    return buildDashManifestRelayUrl(deviceId, safeName) || streamUrl;
  }
  return streamUrl;
}

function rewriteDashManifestUris(manifestText, manifestUrl, options = {}) {
  if (!manifestText || !manifestUrl) {
    return manifestText;
  }

  const { utcTimingUrl = null } = options;

  let manifestUrlObject = null;
  try {
    manifestUrlObject = new URL(manifestUrl);
  } catch {
    return manifestText;
  }

  const ATTRIBUTE_URI_PATTERN = /(\s(?:media|initialization|sourceURL|href)\s*=\s*["'])([^"']+)(["'])/gi;
  const BASE_URL_PATTERN = /(<BaseURL[^>]*>)([^<]*)(<\/BaseURL>)/gi;
  const UTC_TIMING_VALUE_PATTERN = /(<UTCTiming\b[^>]*\bvalue\s*=\s*["'])([^"']+)(["'])/gi;

  const mergeManifestQueryParams = (absoluteUrl, sourceWasRelative) => {
    if (!sourceWasRelative || !manifestUrlObject.search) {
      return absoluteUrl;
    }

    try {
      const targetUrl = new URL(absoluteUrl);
      for (const [key, value] of manifestUrlObject.searchParams.entries()) {
        if (!targetUrl.searchParams.has(key)) {
          targetUrl.searchParams.append(key, value);
        }
      }
      return targetUrl.toString();
    } catch {
      return absoluteUrl;
    }
  };

  const resolveUri = (uri) => {
    const trimmed = String(uri || '').trim();
    if (!trimmed) return trimmed;

    const sourceWasRelative = !trimmed.startsWith('//') && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed);

    try {
      const resolvedUrl = new URL(trimmed, manifestUrlObject).toString();
      return mergeManifestQueryParams(resolvedUrl, sourceWasRelative);
    } catch {
      return trimmed;
    }
  };

  const withAbsoluteAttributes = manifestText.replace(ATTRIBUTE_URI_PATTERN, (match, prefix, uri, suffix) => {
    const absoluteUri = resolveUri(uri);
    return `${prefix}${absoluteUri}${suffix}`;
  });

  const withAbsoluteBaseUrls = withAbsoluteAttributes.replace(BASE_URL_PATTERN, (match, prefix, uri, suffix) => {
    const absoluteUri = resolveUri(uri);
    return `${prefix}${absoluteUri}${suffix}`;
  });

  if (!utcTimingUrl) {
    return withAbsoluteBaseUrls;
  }

  return withAbsoluteBaseUrls.replace(UTC_TIMING_VALUE_PATTERN, (match, prefix, _value, suffix) => {
    return `${prefix}${utcTimingUrl}${suffix}`;
  });
}

async function fetchTextWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/dash+xml,application/xml,text/xml;q=0.9,*/*;q=0.8'
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function resolveStreamPlaybackUrl(deviceId, safeName, metadata = null) {
  const streamUrl = metadata?.stream_url || metadata?.streamUrl || null;
  const streamProtocol = metadata?.stream_protocol || metadata?.streamProtocol || null;
  const mimeType = metadata?.mime_type || metadata?.mimeType || null;
  const protocol = normalizeStreamProtocol(streamProtocol, streamUrl, mimeType);

  if (!streamUrl) {
    return null;
  }

  return resolveDirectStreamPlaybackUrl(deviceId, safeName, streamUrl, protocol);
}

function stripWrappingQuotes(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractMarkerValue(line = '', marker = '') {
  if (!line || !marker) return null;
  const markerIndex = line.indexOf(marker);
  if (markerIndex < 0) return null;
  const value = line.slice(markerIndex + marker.length).trim();
  return value || null;
}

function extractYtDlpPathCandidate(line = '') {
  if (!line) return null;

  const fromMarker = extractMarkerValue(line, YTDLP_FINAL_PATH_MARKER);
  if (fromMarker) return stripWrappingQuotes(fromMarker);

  const destinationMatch = line.match(/\[download\]\s+Destination:\s+(.+)$/i);
  if (destinationMatch) return stripWrappingQuotes(destinationMatch[1]);

  const mergedMatch = line.match(/\[Merger\]\s+Merging formats into\s+(.+)$/i);
  if (mergedMatch) return stripWrappingQuotes(mergedMatch[1]);

  const downloadedMatch = line.match(/\[download\]\s+(.+?)\s+has already been downloaded/i);
  if (downloadedMatch) return stripWrappingQuotes(downloadedMatch[1]);

  return null;
}

function parseYtDlpProgress(line = '') {
  if (!line) return null;

  const percentMatch = line.match(/(\d{1,3}(?:\.\d+)?)%/);
  const speedMatch = line.match(/\bat\s+([^\s]+\/?s)\b/i);
  const etaMatch = line.match(/\bETA\s+([^\s]+)/i);

  if (!percentMatch && !speedMatch && !etaMatch) {
    return null;
  }

  const percent = percentMatch ? Number(percentMatch[1]) : null;
  return {
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    speed: speedMatch ? speedMatch[1] : null,
    eta: etaMatch ? etaMatch[1] : null
  };
}

function parseFrameRate(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return 0;
  const [numRaw, denRaw] = value.split('/');
  const num = Number(numRaw);
  const den = Number(denRaw);
  if (!Number.isFinite(num)) return 0;
  if (!Number.isFinite(den) || den === 0) return num;
  return num / den;
}

async function probeMediaInfo(filePath, timeoutMs = 30000) {
  return await new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=format_name',
      '-show_entries', 'stream=codec_type,codec_name,pix_fmt,profile,level,r_frame_rate,width,height',
      '-of', 'json',
      filePath
    ];

    const ffprobe = spawn('ffprobe', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffprobe.kill('SIGKILL');
      reject(new Error('ffprobe timeout'));
    }, timeoutMs);

    ffprobe.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    ffprobe.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffprobe.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    ffprobe.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout || '{}');
        resolve(parsed);
      } catch (error) {
        reject(new Error(`ffprobe JSON parse failed: ${error.message}`));
      }
    });
  });
}

async function createZipArchiveFromFolder(sourceFolderPath, outputZipPath) {
  const folderPath = validatePath(path.resolve(sourceFolderPath), getDataRoot());
  const safeOutputZipPath = validatePath(path.resolve(outputZipPath), os.tmpdir());

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(safeOutputZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(folderPath, false);
    archive.finalize();
  });
}

function safeDownloadFileName(fileName = '', fallback = 'download') {
  const normalized = String(fileName || '')
    .replace(/[\r\n]/g, '')
    .trim();

  const baseName = path.basename(normalized || fallback);
  return baseName || fallback;
}

const router = express.Router();

/**
 * Копировать папку физически (асинхронно через streams)
 * Для PPTX/PDF/изображений которые должны оставаться в /content/{device}/
 */
async function copyFolderPhysically(sourceId, targetId, folderName, move, devices, fileNamesMap, saveFileNamesMap, io, res) {
  // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
  const devicesPath = getDevicesPath();
  const sourceFolder = path.join(devicesPath, devices[sourceId].folder);
  const targetFolder = path.join(devicesPath, devices[targetId].folder);
  
  const sourcePath = path.join(sourceFolder, folderName);
  let targetSafeName = folderName;
  let targetPath = path.join(targetFolder, targetSafeName);
  
  // Если папка уже есть, генерируем уникальное имя (как для файлов)
  if (fs.existsSync(targetPath)) {
    const suffix = '_' + crypto.randomBytes(3).toString('hex');
    targetSafeName = `${folderName}${suffix}`;
    targetPath = path.join(targetFolder, targetSafeName);
    logFile('info', '⚠️ Target folder exists, using unique name', {
      sourceId,
      targetId,
      folderName,
      unique: targetSafeName
    });
  }
  
  try {
    // Асинхронное копирование папки
    logFile('info', '📁 Copying folder (async)', { sourceId, targetId, folderName });
    
    await fs.promises.cp(sourcePath, targetPath, { recursive: true });
    
    // Устанавливаем права
    await fs.promises.chmod(targetPath, 0o755);
    
    // Копируем маппинг (используем оригинальное имя, если было)
    const originalName = fileNamesMap[sourceId]?.[folderName] || folderName;
    if (originalName) {
      if (!fileNamesMap[targetId]) fileNamesMap[targetId] = {};
      fileNamesMap[targetId][targetSafeName] = originalName;
      saveFileNamesMap(fileNamesMap);
    }
    
    // Сохраняем метаданные в БД для скопированной папки
    try {
      const stat = fs.statSync(targetPath);
      const pagesCount = await getFolderImagesCount(targetId, targetSafeName);
      saveFileMetadata({
        deviceId: targetId,
        safeName: targetSafeName,
        originalName: originalName || targetSafeName,
        filePath: targetPath,
        fileSize: 0,
        md5Hash: '',
        partialMd5: null,
        mimeType: null,
        videoParams: {},
        audioParams: {},
        fileMtime: stat.mtimeMs,
        contentType: 'folder',
        streamUrl: null,
        streamProtocol: 'auto',
        pagesCount
      });
    } catch (err) {
      logger.warn('[copy-folder] Failed to save metadata for copied folder', { error: err.message, targetId, targetSafeName });
    }
    
    // Если move - удаляем из источника
    if (move) {
      await fs.promises.rm(sourcePath, { recursive: true, force: true });
      if (fileNamesMap[sourceId]?.[folderName]) {
        delete fileNamesMap[sourceId][folderName];
        saveFileNamesMap(fileNamesMap);
      }
    }
    
    // Обновляем оба устройства
    updateDeviceFilesFromDB(targetId, devices, fileNamesMap);
    if (move) updateDeviceFilesFromDB(sourceId, devices, fileNamesMap);
    
    io.emit('devices/updated');
    
    logFile('info', `✅ Folder ${move ? 'moved' : 'copied'} successfully`, {
      sourceDevice: sourceId,
      targetDevice: targetId,
      folderName: targetSafeName
    });
    
    res.json({ 
      ok: true, 
      action: move ? 'moved' : 'copied', 
      file: targetSafeName, 
      from: sourceId, 
      to: targetId,
      type: 'folder'
    });
    
  } catch (e) {
    logger.error('[copy-folder] Error', { error: e.message, sourceId, targetId, folderName });
    return res.status(500).json({ error: 'Ошибка копирования папки', detail: e.message });
  }
}

/**
 * Обновить список файлов устройства из БД + папки
 * @param {string} deviceId - ID устройства
 * @param {Object} devices - Объект devices
 * @param {Object} fileNamesMap - Маппинг имен
 */
export function updateDeviceFilesFromDB(deviceId, devices, fileNamesMap) {
  const device = devices[deviceId];
  if (!device) return;
  
  // 1. Получаем файлы из БД (обычные файлы)
  const filesMetadata = getDeviceFilesMetadata(deviceId);
  
  logger.debug(`[updateDeviceFilesFromDB] Получено метаданных из БД для ${deviceId}: ${filesMetadata.length}`, {
    deviceId,
    totalMetadata: filesMetadata.length,
    metadata: filesMetadata.map(f => ({
      safe_name: f.safe_name,
      content_type: f.content_type,
      file_path: f.file_path
    }))
  });
  
  const streamingMetadata = filesMetadata.filter(f => (f.content_type === 'streaming' || (!f.file_path && f.stream_url)));
  
  // 2. Получаем папки/PDF/PPTX из БД (content_type: 'folder', 'pdf', 'pptx')
  // КРИТИЧНО: Папки/PDF/PPTX теперь хранятся в БД, не сканируем диск
  const staticContentMetadata = filesMetadata.filter(f => 
    f.content_type === 'folder' || f.content_type === 'pdf' || f.content_type === 'pptx'
  );
  
  logger.info(`[updateDeviceFilesFromDB] Найдено статического контента для ${deviceId}: ${staticContentMetadata.length}`, {
    deviceId,
    staticContent: staticContentMetadata.map(f => ({
      safe_name: f.safe_name,
      original_name: f.original_name,
      content_type: f.content_type,
      file_path: f.file_path,
      pages_count: f.pages_count
    }))
  });
  
  // КРИТИЧНО: Исключаем статический контент из physicalMetadata, чтобы избежать дублирования
  const physicalMetadata = filesMetadata.filter(f => 
    f.content_type !== 'streaming' && 
    (!f.stream_url || f.file_path) &&
    f.content_type !== 'folder' &&  // ✅ Исключаем статический контент
    f.content_type !== 'pdf' &&
    f.content_type !== 'pptx'
  );
  
  // КРИТИЧНО: Логируем для отладки стримов
  if (streamingMetadata.length > 0) {
    logger.info('[updateDeviceFilesFromDB] Streaming metadata found', {
      deviceId,
      count: streamingMetadata.length,
      streams: streamingMetadata.map(f => ({
        safeName: f.safe_name,
        streamUrl: f.stream_url,
        streamProtocol: f.stream_protocol,
        hasStreamUrl: !!f.stream_url,
        contentType: f.content_type
      }))
    });
  }
  
  // КРИТИЧНО: Проверяем существование файлов по путям из БД
  // После миграции путей файлы должны существовать по новым путям
  const existingMetadata = physicalMetadata.filter(f => {
    if (!f.file_path) {
      logger.warn(`[updateDeviceFilesFromDB] File metadata missing file_path`, { deviceId, safeName: f.safe_name });
      return false;
    }
    
    const exists = fs.existsSync(f.file_path);
    if (!exists) {
      logger.warn(`[updateDeviceFilesFromDB] File not found at path`, {
        deviceId,
        safeName: f.safe_name,
        filePath: f.file_path
      });
    }
    return exists;
  });
  
  const missingCount = physicalMetadata.length - existingMetadata.length;
  if (missingCount > 0) {
    logger.warn(`[updateDeviceFilesFromDB] ${deviceId}: ${missingCount} files from DB not found physically`, {
      deviceId,
      missingCount,
      totalInDB: physicalMetadata.length,
      existing: existingMetadata.length,
      missingFiles: physicalMetadata.filter(f => !existingMetadata.includes(f)).map(f => f.safe_name)
    });
  }
  
  // Получаем пути к папкам из БД для фильтрации файлов внутри папок
  const folderPaths = staticContentMetadata
    .filter(f => f.file_path && fs.existsSync(f.file_path))
    .map(f => {
      const stat = fs.statSync(f.file_path);
      return stat.isDirectory() ? f.file_path : null;
    })
    .filter(Boolean);
  
  // Список папок из БД (для обратной совместимости)
  const folders = staticContentMetadata
    .filter(f => f.content_type === 'folder' && f.file_path && fs.existsSync(f.file_path))
    .map(f => path.basename(f.file_path));
  
  // 3. Фильтруем файлы из БД: исключаем только файлы внутри папок
  // КРИТИЧНО: Проверяем физический путь файла, а не только имя!
  // Файл должен скрываться только если он физически находится внутри папки
  // Это позволяет иметь файлы с одинаковыми именами в папке и в корне устройства
  // КРИТИЧНО: Плейсхолдеры НЕ фильтруем здесь - они должны быть видны в обычных списках устройств
  // Фильтрация плейсхолдеров только в GET /api/devices/all/files (агрегированный список)
  const filteredMetadata = existingMetadata.filter(f => {
    if (!f.file_path) return true; // Если нет пути - показываем (на всякий случай)
    
    // Нормализуем путь файла из БД (абсолютный путь)
    const filePath = path.normalize(f.file_path);
    
    // Проверяем, находится ли файл внутри какой-либо папки устройства
    for (const folderPath of folderPaths) {
      const normalizedFolderPath = path.normalize(folderPath);
      
      // Проверяем, что file_path начинается с folderPath + разделитель
      // Это означает, что файл физически находится внутри этой папки
      if (filePath.startsWith(normalizedFolderPath + path.sep) || 
          filePath.startsWith(normalizedFolderPath + '/')) {
        // Файл физически находится внутри этой папки - скрываем его
        return false;
      }
    }
    
    // Файл не находится ни в одной папке - показываем его
    // Даже если файл с таким же именем есть в папке, этот файл будет показан,
    // так как он физически находится в другом месте (в корне устройства)
    return true;
  });
  
  const nameMap = fileNamesMap[deviceId] || {};
  let files = filteredMetadata.map(f => f.safe_name);
  let fileNames = filteredMetadata.map(f => f.original_name || nameMap[f.safe_name] || f.safe_name);

  const metadataList = filteredMetadata.map(f => {
    const streamProtocol = f.content_type === 'streaming'
      ? normalizeStreamProtocol(f.stream_protocol, f.stream_url, f.mime_type)
      : null;
    const directUrl = f.content_type === 'streaming'
      ? resolveDirectStreamPlaybackUrl(deviceId, f.safe_name, f.stream_url, streamProtocol)
      : null;
    return {
      safeName: f.safe_name,
      originalName: f.original_name || nameMap[f.safe_name] || f.safe_name,
      folderImageCount: f.pages_count || null,  // Используем pages_count из БД
      contentType: f.content_type || null,
      streamUrl: f.stream_url || null,
      streamProxyUrl: directUrl,
      restreamStatus: null,
      streamProtocol
    };
  });

  const streams = {};
  streamingMetadata.forEach(f => {
    const safeName = f.safe_name;
    // КРИТИЧНО: Плейсхолдеры НЕ фильтруем здесь - они должны быть видны в обычных списках устройств
    // Фильтрация плейсхолдеров только в GET /api/devices/all/files (агрегированный список)
    const displayName = f.original_name || nameMap[safeName] || safeName;
    
    // КРИТИЧНО: Пропускаем стримы без stream_url - они невалидны и не могут быть воспроизведены
    if (!f.stream_url) {
      logger.warn('[updateDeviceFilesFromDB] ⚠️ Stream metadata missing stream_url, skipping', {
        deviceId,
        safeName,
        hasStreamUrl: !!f.stream_url,
        streamUrl: f.stream_url,
        content_type: f.content_type,
        stream_protocol: f.stream_protocol,
        originalName: displayName
      });
      // КРИТИЧНО: Не добавляем стрим без URL в список файлов
      // Это предотвращает ошибки при попытке воспроизведения
      return;
    }
    
    if (!files.includes(safeName)) {
      files.push(safeName);
      fileNames.push(displayName);
    }
    const protocol = normalizeStreamProtocol(f.stream_protocol, f.stream_url, f.mime_type);
<<<<<<< HEAD
    const directPlaybackUrl = resolveDirectStreamPlaybackUrl(deviceId, safeName, f.stream_url, protocol);
    const streamPlaybackUrl = directPlaybackUrl;
=======
    // КРИТИЧНО: Lazy loading - НЕ запускаем FFmpeg здесь
    // FFmpeg будет запущен только когда стрим действительно запрашивается для воспроизведения
    // Это экономит ресурсы, так как не все стримы используются одновременно
    // Формируем URL заранее, но FFmpeg запустится только при первом запросе на воспроизведение
    // КРИТИЧНО: Используем ту же логику sanitization, что и в stream-manager.js
    // для гарантии консистентности путей
    function sanitizePathFragment(value = '') {
      return String(value)
        .replace(/[^a-zA-Z0-9\-_.]/g, '_')
        .substring(0, 200);
    }
    const safeFile = sanitizePathFragment(safeName);
    // КРИТИЧНО: Убрали deviceId из пути - стримы теперь идентифицируются только по safeName
    const proxyUrl = `/streams/${encodeURIComponent(safeFile)}/index.m3u8`;
    const directPlaybackUrl = resolveDirectStreamPlaybackUrl(deviceId, safeName, f.stream_url, protocol);
    const streamPlaybackUrl = isDirectPlaybackAvailable(protocol) ? directPlaybackUrl : proxyUrl;
    const restreamStatus = getStreamRestreamStatus(deviceId, safeName);
>>>>>>> 76d29d0af24a9d06f52ca3c5612c50a10cc64ed0
    metadataList.push({
      safeName,
      originalName: displayName,
      folderImageCount: null,
      contentType: 'streaming',
      streamUrl: f.stream_url,
      streamProxyUrl: streamPlaybackUrl,
      restreamStatus: null,
      streamProtocol: protocol
    });
    streams[safeName] = {
      name: displayName,
      url: directPlaybackUrl,
<<<<<<< HEAD
      proxyUrl: null,
      status: null,
=======
      proxyUrl: isDirectPlaybackAvailable(protocol) ? null : proxyUrl,
      status: restreamStatus?.status || null,
>>>>>>> 76d29d0af24a9d06f52ca3c5612c50a10cc64ed0
      protocol
    };
    
    logger.debug('[updateDeviceFilesFromDB] Stream loaded', {
      deviceId,
      safeName,
      streamUrl: f.stream_url,
      protocol,
      hasStreamUrl: !!f.stream_url
    });
  });
  
  // 4. Добавляем папки/PDF/PPTX из БД в список файлов
  staticContentMetadata.forEach(f => {
    const safeName = f.safe_name;
    // КРИТИЧНО: Плейсхолдеры НЕ фильтруем здесь - они должны быть видны в обычных списках устройств
    // Фильтрация плейсхолдеров только в GET /api/devices/all/files (агрегированный список)
    const displayName = f.original_name || nameMap[safeName] || safeName;
    
    // Проверяем существование папки/файла
    if (!f.file_path) {
      logger.warn('[updateDeviceFilesFromDB] Static content missing file_path', {
        deviceId,
        safeName,
        contentType: f.content_type
      });
      return;
    }
    
    // КРИТИЧНО: Проверяем существование файла/папки
    // path.resolve() для абсолютных путей возвращает тот же путь, но нормализует его
    const normalizedPath = path.resolve(f.file_path);
    let exists = false;
    
    try {
      exists = fs.existsSync(normalizedPath);
      // Дополнительная проверка: если это папка, проверяем что это действительно директория
      if (exists && f.content_type === 'folder') {
        const stat = fs.statSync(normalizedPath);
        exists = stat.isDirectory();
      }
    } catch (err) {
      logger.warn('[updateDeviceFilesFromDB] Error checking static content', {
        deviceId,
        safeName,
        contentType: f.content_type,
        filePath: f.file_path,
        normalizedPath,
        error: err.message
      });
      exists = false;
    }
    
    logger.info('[updateDeviceFilesFromDB] Checking static content', {
      deviceId,
      safeName,
      displayName,
      contentType: f.content_type,
      filePath: f.file_path,
      normalizedPath,
      exists,
      pagesCount: f.pages_count
    });
    
    if (!exists) {
      // КРИТИЧНО: Если файл с contentType='pptx' или 'pdf' не существует, но папка существует,
      // значит файл был конвертирован, но метаданные не обновились
      if ((f.content_type === 'pdf' || f.content_type === 'pptx') && safeName.includes('.')) {
        const folderName = safeName.replace(/\.(pdf|pptx)$/i, '');
        const devicesPath = getDevicesPath();
        const deviceFolder = path.join(devicesPath, devices[deviceId]?.folder || deviceId);
        const possibleFolderPath = path.join(deviceFolder, folderName);
        
        if (fs.existsSync(possibleFolderPath) && fs.statSync(possibleFolderPath).isDirectory()) {
          // Папка существует - файл был конвертирован, но метаданные не обновились
          logger.warn('[updateDeviceFilesFromDB] Обнаружен конвертированный файл без обновленных метаданных, обновляем...', {
            deviceId,
            oldSafeName: safeName,
            newSafeName: folderName,
            contentType: f.content_type,
            folderPath: possibleFolderPath
          });
          
          // Обновляем метаданные в БД (в фоне, чтобы не блокировать основную логику)
          Promise.resolve().then(async () => {
            try {
              const { deleteFileMetadata, saveFileMetadata } = await import('../database/files-metadata.js');
              const folderStats = fs.statSync(possibleFolderPath);
              const { getFolderImagesCount } = await import('../converters/folder-converter.js');
              const pagesCount = await getFolderImagesCount(deviceId, folderName);
              
              // Удаляем старую запись
              deleteFileMetadata(deviceId, safeName);
              
              // Создаем новую запись для папки
              saveFileMetadata({
                deviceId,
                safeName: folderName,
                originalName: displayName.replace(/\.(pdf|pptx)$/i, ''),
                filePath: path.resolve(possibleFolderPath),
                fileSize: 0,
                md5Hash: '',
                partialMd5: null,
                mimeType: null,
                videoParams: {},
                audioParams: {},
                fileMtime: folderStats.mtimeMs,
                contentType: 'folder',
                streamUrl: null,
                streamProtocol: 'auto',
                pagesCount
              });
              
              logger.info('[updateDeviceFilesFromDB] ✅ Метаданные обновлены для конвертированного файла', {
                deviceId,
                oldSafeName: safeName,
                newSafeName: folderName,
                pagesCount
              });
              
              // Обновляем список файлов после обновления метаданных
              await new Promise(resolve => setTimeout(resolve, 200)); // Задержка для завершения транзакции БД
              updateDeviceFilesFromDB(deviceId, devices, fileNamesMap);
            } catch (updateErr) {
              logger.error('[updateDeviceFilesFromDB] Ошибка обновления метаданных для конвертированного файла', {
                deviceId,
                safeName,
                error: updateErr.message,
                stack: updateErr.stack
              });
            }
          }).catch(err => {
            logger.error('[updateDeviceFilesFromDB] Необработанная ошибка при обновлении метаданных', {
              deviceId,
              safeName,
              error: err.message
            });
          });
          
          // Пропускаем эту итерацию, метаданные будут обновлены в фоне
          return;
        }
      }
      
      logger.warn('[updateDeviceFilesFromDB] Static content not found on disk', {
        deviceId,
        safeName,
        contentType: f.content_type,
        filePath: f.file_path,
        normalizedPath
      });
      return;
    }
    
    // КРИТИЧНО: Добавляем в список файлов, даже если уже есть (для обновления метаданных)
    const existingIndex = files.indexOf(safeName);
    if (existingIndex >= 0) {
      // Обновляем имя файла если изменилось
      fileNames[existingIndex] = displayName;
      logger.debug('[updateDeviceFilesFromDB] Static content already in list, updated', {
        deviceId,
        safeName,
        displayName
      });
    } else {
      // Добавляем новый файл
      files.push(safeName);
      fileNames.push(displayName);
      
      logger.info('[updateDeviceFilesFromDB] ✅ Static content added to files list', {
        deviceId,
        safeName,
        displayName,
        contentType: f.content_type,
        pagesCount: f.pages_count,
        filePath: f.file_path
      });
    }
    
    // Добавляем/обновляем метаданные
    const existingMetaIndex = metadataList.findIndex(m => m.safeName === safeName);
    const metaEntry = {
      safeName,
      originalName: displayName,
      folderImageCount: f.pages_count || null,  // Используем pages_count из БД
      contentType: f.content_type || null,
      streamUrl: null,
      streamProxyUrl: null,
      restreamStatus: null,
      streamProtocol: null
    };
    
    if (existingMetaIndex >= 0) {
      metadataList[existingMetaIndex] = metaEntry;
    } else {
      metadataList.push(metaEntry);
    }
  });
  
  device.files = files;
  device.fileNames = fileNames;
  device.fileMetadata = metadataList;
  device.streams = streams;
  
  const staticContentCount = staticContentMetadata.length;
  const staticContentAdded = staticContentMetadata.filter(f => {
    if (!f.file_path) return false;
    return fs.existsSync(f.file_path) && files.includes(f.safe_name);
  }).length;
  
  logger.info(`[updateDeviceFilesFromDB] ${deviceId}: БД=${filteredMetadata.length} (существует=${existingMetadata.length}, отсутствует=${missingCount}), Статический контент=${staticContentCount} (добавлено=${staticContentAdded}), Всего=${files.length}`);
  if (staticContentCount > 0) {
    logger.info(`[updateDeviceFilesFromDB] Статический контент: ${staticContentMetadata.map(f => {
      const exists = f.file_path && fs.existsSync(f.file_path);
      const inList = files.includes(f.safe_name);
      return `${f.safe_name} (${f.content_type}, ${f.pages_count || 0} страниц, path=${f.file_path}, exists=${exists}, inList=${inList})`;
    }).join(', ')}`);
  }
  if (existingMetadata.length !== filteredMetadata.length) {
    logger.info(`[updateDeviceFilesFromDB] Скрыто ${existingMetadata.length - filteredMetadata.length} файлов (в папках)`);
  }
  if (missingCount > 0) {
    logger.warn(`[updateDeviceFilesFromDB] Отсутствующие файлы из БД (возможно миграция путей выполнена, но файлы не перемещены): ${physicalMetadata.filter(f => !existingMetadata.includes(f)).map(f => f.safe_name).join(', ')}`);
  }
}

/**
 * Настройка роутера для файлов
 * @param {Object} deps - Зависимости
 * @returns {express.Router} Настроенный роутер
 */
const jsonParser = express.json({ limit: '256kb' });

export function createFilesRouter(deps) {
  const { 
    devices, 
    io, 
    fileNamesMap, 
    saveFileNamesMap, 
    upload,
    autoConvertFileWrapper,
    autoOptimizeVideoWrapper,
    checkVideoParameters,
    getFileStatus,
    requireAdmin = (_req, _res, next) => next()
  } = deps;

  function isFileReadyForSpeaker(deviceId, safeName) {
    const status = getFileStatus(deviceId, safeName);
    if (!status) {
      return true;
    }

    const state = String(status.status || '').toLowerCase();
    if (state === 'checking' || state === 'processing') {
      return false;
    }

    if (status.canPlay === false) {
      return false;
    }

    return true;
  }

  function markFileAsPreProcessing(deviceId, safeName) {
    const ext = path.extname(String(safeName || '')).toLowerCase();
    if (!VIDEO_PROCESSING_EXTENSIONS.has(ext)) {
      return;
    }

    if (!getVideoOptConfig().enabled) {
      return;
    }

    setGlobalFileStatus(deviceId, safeName, {
      status: 'processing',
      progress: 1,
      canPlay: false
    });
  }

  const ytDlpJobs = new Map();
  const YTDLP_JOB_TTL_MS = 6 * 60 * 60 * 1000;
  const YTDLP_JOB_HISTORY_LIMIT = 100;
  const YTDLP_ACTIVE_STATUSES = new Set(['queued', 'waiting_resources', 'preparing', 'downloading', 'processing']);
  const YTDLP_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
  const ytDlpNotificationSnapshot = new Map();
  const ytDlpDeviceQueue = new Map();
  const ytDlpResourceCpuUnits = Math.max(1, Number.parseInt(process.env.YTDLP_RESOURCE_CPU_UNITS || '1', 10) || 1);
  const ytDlpResourceMemoryMb = Math.max(128, Number.parseInt(process.env.YTDLP_RESOURCE_MEMORY_MB || '512', 10) || 512);
  const ytDlpResourceTimeoutRaw = Number.parseInt(process.env.YTDLP_RESOURCE_TIMEOUT_MS || '0', 10);
  const ytDlpResourceTimeoutMs = Number.isFinite(ytDlpResourceTimeoutRaw) && ytDlpResourceTimeoutRaw >= 0
    ? ytDlpResourceTimeoutRaw
    : 0;

  function enqueueYtDlpDeviceJob(deviceId, runner) {
    const queueKey = String(deviceId || 'unknown');
    const previousTask = ytDlpDeviceQueue.get(queueKey) || Promise.resolve();

    const nextTask = previousTask
      .catch((err) => {
        logger.warn('[yt-dlp] Previous queued job failed', {
          deviceId: queueKey,
          error: err?.message || String(err)
        });
      })
      .then(async () => await runner())
      .finally(() => {
        if (ytDlpDeviceQueue.get(queueKey) === nextTask) {
          ytDlpDeviceQueue.delete(queueKey);
        }
      });

    ytDlpDeviceQueue.set(queueKey, nextTask);
    return nextTask;
  }

  function getYtDlpStatusLabel(status) {
    switch (status) {
      case 'queued':
        return 'В очереди';
      case 'waiting_resources':
        return 'Ожидание ресурсов';
      case 'preparing':
        return 'Подготовка';
      case 'downloading':
        return 'Загрузка';
      case 'processing':
        return 'Обработка';
      case 'completed':
        return 'Завершено';
      case 'cancelled':
        return 'Отменено';
      case 'failed':
        return 'Ошибка';
      default:
        return 'Загрузка';
    }
  }

  function getYtDlpNotificationSeverity(status) {
    if (status === 'failed') return 'critical';
    if (status === 'cancelled') return 'warning';
    return 'info';
  }

  function buildYtDlpJobActions(job) {
    if (!isYtDlpJobActive(job)) {
      return [];
    }

    return [{
      id: 'cancel',
      label: 'Отменить',
      method: 'POST',
      url: `/api/devices/${encodeURIComponent(job.deviceId)}/download-url/cancel`,
      body: { jobId: job.id },
      confirm: 'Отменить текущую загрузку по ссылке?',
      variant: 'danger'
    }];
  }

  function buildYtDlpNotificationMessage(job) {
    const progress = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
    const speedText = job.speed ? ` • ${job.speed}` : '';
    const etaText = job.eta ? ` • ETA ${job.eta}` : '';

    if (job.status === 'completed') {
      return `Файл сохранен: ${job.fileName || job.title || 'готово'}`;
    }
    if (job.status === 'cancelled') {
      return job.error || 'Загрузка отменена';
    }
    if (job.status === 'failed') {
      return job.error || 'Ошибка загрузки';
    }
    if (job.status === 'waiting_resources') {
      return 'Ожидание свободных ресурсов сервера';
    }
    if (job.status === 'downloading') {
      return `${getYtDlpStatusLabel(job.status)}: ${progress}%${speedText}${etaText}`;
    }
    return getYtDlpStatusLabel(job.status);
  }

  function publishYtDlpJobNotification(job, { force = false } = {}) {
    if (!job?.id || !job?.deviceId) return;

    const status = String(job.status || 'queued');
    const progress = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
    const progressStep = Math.floor(progress / 10) * 10;
    const now = Date.now();
    const snapshot = ytDlpNotificationSnapshot.get(job.id);

    let shouldPublish = force || !snapshot || snapshot.status !== status;
    if (!shouldPublish && status === 'downloading' && progressStep > (snapshot.progressStep ?? -10)) {
      shouldPublish = true;
    }
    if (!shouldPublish && status === 'waiting_resources' && (now - (snapshot.lastPublishedAt || 0)) >= 15000) {
      shouldPublish = true;
    }
    if (!shouldPublish && YTDLP_TERMINAL_STATUSES.has(status) && snapshot?.error !== (job.error || null)) {
      shouldPublish = true;
    }

    if (!shouldPublish) return;

    notificationsManager.upsert({
      key: `yt-dlp-job:${job.id}`,
      type: 'yt_dlp_job',
      severity: getYtDlpNotificationSeverity(status),
      title: `Загрузка по ссылке • ${job.deviceId}`,
      message: buildYtDlpNotificationMessage(job),
      source: 'yt-dlp',
      actions: buildYtDlpJobActions(job),
      details: {
        deviceId: job.deviceId,
        jobId: job.id,
        status,
        progress,
        speed: job.speed || null,
        eta: job.eta || null,
        title: job.title || null,
        fileName: job.fileName || null,
        error: job.error || null,
        updatedAt: job.updatedAt || new Date().toISOString()
      }
    });

    ytDlpNotificationSnapshot.set(job.id, {
      status,
      progressStep,
      error: job.error || null,
      lastPublishedAt: now
    });

    if (YTDLP_TERMINAL_STATUSES.has(status)) {
      const cleanupTimer = setTimeout(() => {
        ytDlpNotificationSnapshot.delete(job.id);
      }, YTDLP_JOB_TTL_MS);
      if (typeof cleanupTimer.unref === 'function') {
        cleanupTimer.unref();
      }
    }
  }

  function pruneFinishedYtDlpJobs() {
    if (ytDlpJobs.size <= YTDLP_JOB_HISTORY_LIMIT) return;

    const finishedJobs = Array.from(ytDlpJobs.values())
      .filter((job) => job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());

    while (ytDlpJobs.size > YTDLP_JOB_HISTORY_LIMIT && finishedJobs.length > 0) {
      const oldest = finishedJobs.shift();
      ytDlpJobs.delete(oldest.id);
      ytDlpNotificationSnapshot.delete(oldest.id);
    }
  }

  function scheduleYtDlpJobCleanup(jobId) {
    const timer = setTimeout(() => {
      ytDlpJobs.delete(jobId);
      ytDlpNotificationSnapshot.delete(jobId);
    }, YTDLP_JOB_TTL_MS);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function updateYtDlpJob(jobId, patch = {}) {
    const current = ytDlpJobs.get(jobId);
    if (!current) return null;

    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    ytDlpJobs.set(jobId, next);
    publishYtDlpJobNotification(next);
    return next;
  }

  function createYtDlpJob({ deviceId, url, username }) {
    const id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
    const now = new Date().toISOString();

    const job = {
      id,
      deviceId,
      url,
      status: 'queued',
      progress: 0,
      speed: null,
      eta: null,
      fileName: null,
      title: null,
      error: null,
      lastLogLine: null,
      cancelRequested: false,
      resourceRequestId: `yt-dlp:${id}`,
      resourceReservationId: null,
      startedBy: username || 'anonymous',
      createdAt: now,
      updatedAt: now
    };

    ytDlpJobs.set(id, job);
    publishYtDlpJobNotification(job, { force: true });
    pruneFinishedYtDlpJobs();
    return job;
  }

  function isYtDlpJobActive(job) {
    return !!job && YTDLP_ACTIVE_STATUSES.has(job.status);
  }

  function cancelYtDlpJob(job, reason = 'Загрузка отменена пользователем') {
    if (!isYtDlpJobActive(job)) return false;

    const pid = Number(job.pid || 0);
    const resourceRequestId = String(job.resourceRequestId || `yt-dlp:${job.id}`);

    jobResourceManager.cancel(resourceRequestId, reason);

    updateYtDlpJob(job.id, {
      status: 'cancelled',
      error: reason,
      speed: null,
      eta: null,
      pid: null,
      resourceReservationId: null,
      cancelRequested: true
    });

    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        logger.warn('[yt-dlp] Failed to stop process on cancel', {
          jobId: job.id,
          pid,
          error: error.message
        });
      }

      const hardKillTimer = setTimeout(() => {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch {
          // Процесс уже завершен
        }
      }, 4000);

      if (typeof hardKillTimer.unref === 'function') {
        hardKillTimer.unref();
      }
    }

    scheduleYtDlpJobCleanup(job.id);
    pruneFinishedYtDlpJobs();
    return true;
  }

  async function evaluateYtDlpVideoCompatibility(safeName, filePath) {
    const optConfig = getVideoOptConfig();
    const thresholds = optConfig.thresholds || {};
    const maxWidth = Number(thresholds.maxWidth) || 3840;
    const maxHeight = Number(thresholds.maxHeight) || 2160;
    const maxFps = Number(thresholds.maxFps) || 60;
    const maxLevel = (maxWidth > 1920 || maxHeight > 1080 || maxFps > 30) ? 52 : 42;

    const reasons = new Set();
    const ext = path.extname(safeName).toLowerCase();
    const isMp4Like = ext === '.mp4' || ext === '.m4v';
    const result = {
      shouldOptimize: false,
      reasons: [],
      details: {
        ext,
        isMp4Like,
        needsFaststart: null,
        basicParams: null,
        videoCodec: null,
        audioCodec: null,
        pixelFormat: null,
        profile: null,
        level: null,
        fps: null,
        formatName: null
      }
    };

    if (!fs.existsSync(filePath)) {
      reasons.add('missing_file');
      result.reasons = Array.from(reasons);
      result.shouldOptimize = true;
      return result;
    }

    if (!isMp4Like) {
      reasons.add(`container:${ext || 'unknown'}`);
    }

    if (isMp4Like) {
      try {
        const seekRisk = await needsFaststart(filePath);
        result.details.needsFaststart = seekRisk;
        if (seekRisk) {
          reasons.add('seek_structure');
        }
      } catch (error) {
        logger.warn('[yt-dlp] Failed to verify MP4 seekability', {
          safeName,
          filePath,
          error: error.message
        });
        reasons.add('seek_check_failed');
      }
    }

    try {
      const params = await checkVideoParameters(filePath);
      result.details.basicParams = params;
      if (!params) {
        reasons.add('video_params_unavailable');
      } else if (needsOptimization(params)) {
        reasons.add('optimizer_thresholds');
      }
    } catch (error) {
      logger.warn('[yt-dlp] Failed to read basic video parameters', {
        safeName,
        filePath,
        error: error.message
      });
      reasons.add('video_probe_failed');
    }

    try {
      const probe = await probeMediaInfo(filePath);
      const streams = Array.isArray(probe?.streams) ? probe.streams : [];
      const videoStream = streams.find((stream) => stream?.codec_type === 'video') || null;
      const audioStream = streams.find((stream) => stream?.codec_type === 'audio') || null;

      const videoCodec = String(videoStream?.codec_name || '').toLowerCase();
      const audioCodec = String(audioStream?.codec_name || '').toLowerCase();
      const pixelFormat = String(videoStream?.pix_fmt || '').toLowerCase();
      const profile = String(videoStream?.profile || '').trim();
      const level = Number(videoStream?.level || 0);
      const fps = parseFrameRate(videoStream?.r_frame_rate || '');
      const formatName = String(probe?.format?.format_name || '').toLowerCase();

      result.details.videoCodec = videoCodec || null;
      result.details.audioCodec = audioCodec || null;
      result.details.pixelFormat = pixelFormat || null;
      result.details.profile = profile || null;
      result.details.level = Number.isFinite(level) ? level : null;
      result.details.fps = Number.isFinite(fps) ? Number(fps.toFixed(2)) : null;
      result.details.formatName = formatName || null;

      if (!videoStream) {
        reasons.add('no_video_stream');
      }

      if (videoCodec && videoCodec !== 'h264') {
        reasons.add(`video_codec:${videoCodec}`);
      }

      if (pixelFormat && pixelFormat !== 'yuv420p' && pixelFormat !== 'yuvj420p') {
        reasons.add(`pix_fmt:${pixelFormat}`);
      }

      if (profile === 'High 10' || profile === 'High 4:2:2' || profile === 'High 4:4:4 Predictive') {
        reasons.add(`profile:${profile}`);
      }

      if (Number.isFinite(level) && level > maxLevel) {
        reasons.add(`level:${level}`);
      }

      if (Number.isFinite(fps) && fps > maxFps + 0.01) {
        reasons.add(`fps:${fps.toFixed(2)}`);
      }

      if (audioCodec && audioCodec !== 'aac' && audioCodec !== 'mp3') {
        reasons.add(`audio_codec:${audioCodec}`);
      }

      if (isMp4Like && formatName && !formatName.includes('mp4')) {
        reasons.add(`format:${formatName}`);
      }
    } catch (error) {
      logger.warn('[yt-dlp] Failed to read detailed media info', {
        safeName,
        filePath,
        error: error.message
      });
      reasons.add('media_probe_failed');
    }

    result.reasons = Array.from(reasons);
    result.shouldOptimize = result.reasons.length > 0;
    return result;
  }

  function runSmartYtDlpOptimization(deviceId, safeName, filePath) {
    Promise.resolve().then(async () => {
      const ext = path.extname(safeName).toLowerCase();
      if (!VIDEO_PROCESSING_EXTENSIONS.has(ext)) {
        return;
      }

      markFileAsPreProcessing(deviceId, safeName);

      const decision = await evaluateYtDlpVideoCompatibility(safeName, filePath);

      if (!decision.shouldOptimize) {
        setGlobalFileStatus(deviceId, safeName, { status: 'ready', progress: 100, canPlay: true });
        io.emit('file/progress', { device_id: deviceId, file: safeName, progress: 100 });
        io.emit('devices/updated');
        io.emit('file/ready', { device_id: deviceId, file: safeName });

        logger.info('[yt-dlp] ✅ Full transcode skipped: file is already seekable and compatible', {
          deviceId,
          safeName,
          filePath,
          details: decision.details
        });
        return;
      }

      logger.info('[yt-dlp] ⚠️ Full optimization required after compatibility check', {
        deviceId,
        safeName,
        reasons: decision.reasons,
        details: decision.details
      });

      const optimizeResult = await autoOptimizeVideoWrapper(deviceId, safeName);
      if (!optimizeResult?.success) {
        logger.warn('[yt-dlp] Full optimization failed after compatibility check', {
          deviceId,
          safeName,
          reasons: decision.reasons,
          message: optimizeResult?.message || 'Unknown optimization error'
        });
      }
    }).catch((error) => {
      logger.warn('[yt-dlp] Smart optimization pipeline failed', {
        deviceId,
        safeName,
        filePath,
        error: error.message
      });
    });
  }

  async function registerYtDlpDownloadedFile(deviceId, downloadedPath, preferredOriginalName = null) {
    if (!downloadedPath) {
      throw new Error('Файл не найден после загрузки');
    }

    const devicesPath = getDevicesPath();
    const resolvedDevicesPath = path.resolve(devicesPath);
    let finalPath = path.resolve(downloadedPath);

    if (!fs.existsSync(finalPath)) {
      throw new Error('Загруженный файл отсутствует на диске');
    }

    let safeName = makeSafeFilename(path.basename(finalPath));
    if (!safeName) {
      safeName = `video_${Date.now()}.mp4`;
    }

    const ext = path.extname(safeName).toLowerCase().replace('.', '');
    if (!VIDEO_EXTENSIONS.includes(ext)) {
      throw new Error(`Неподдерживаемый формат загруженного файла: .${ext || 'unknown'}`);
    }

    if (safeName.toLowerCase() === 'default.mp4') {
      safeName = `video_${Date.now()}.mp4`;
    }

    let targetPath = path.join(resolvedDevicesPath, safeName);
    while (fs.existsSync(targetPath) && path.resolve(targetPath) !== finalPath) {
      const extName = path.extname(safeName);
      const baseName = path.basename(safeName, extName);
      safeName = `${baseName}_${crypto.randomBytes(3).toString('hex')}${extName}`;
      targetPath = path.join(resolvedDevicesPath, safeName);
    }

    if (path.resolve(targetPath) !== finalPath) {
      fs.renameSync(finalPath, targetPath);
      finalPath = targetPath;
    }

    try {
      fs.chmodSync(finalPath, 0o644);
    } catch (chmodErr) {
      logger.warn('[yt-dlp] Failed to set permissions on downloaded file', {
        deviceId,
        safeName,
        filePath: finalPath,
        error: chmodErr.message
      });
    }

    const originalName = preferredOriginalName || path.basename(finalPath);

    if (!fileNamesMap[deviceId]) fileNamesMap[deviceId] = {};
    fileNamesMap[deviceId][safeName] = originalName;
    saveFileNamesMap(fileNamesMap);

    await processUploadedFilesAsync(
      deviceId,
      [{ filename: safeName, originalname: originalName, path: finalPath }],
      resolvedDevicesPath,
      fileNamesMap
    );

    markFileAsPreProcessing(deviceId, safeName);

    updateDeviceFilesFromDB(deviceId, devices, fileNamesMap);
    io.emit('devices/updated');

    const currentMetadata = getFileMetadata(deviceId, safeName);
    const optimizationPath = currentMetadata?.file_path && fs.existsSync(currentMetadata.file_path)
      ? currentMetadata.file_path
      : finalPath;

    runSmartYtDlpOptimization(deviceId, safeName, optimizationPath);

    return {
      safeName,
      originalName,
      filePath: finalPath
    };
  }

  // GET /api/devices/all/files - агрегированный список файлов по всем устройствам
  // Доступен только для авторизованных ролей (requireSpeaker: speaker/admin/hero_admin)
  router.get('/all/files', requireSpeaker[0], requireSpeaker[1], (req, res) => {
    const readyOnly = req.query.readyOnly === '1' || req.query.readyOnly === 'true';
    const q = (req.query.q || '').toString().trim();
    const deviceFilter = sanitizeDeviceId(req.query.device);
    const excludeDevice = sanitizeDeviceId(req.query.excludeDevice); // Исключить файлы выбранного устройства
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 500);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    const isSpeaker = req.user?.role === 'speaker';
    const allowedDevices = isSpeaker ? getUserDevices(req.user.userId) : [];
    const allowedDevicesSet = new Set(allowedDevices);

    if (isSpeaker && allowedDevices.length === 0) {
      return res.json({
        items: [],
        total: 0,
        limit,
        offset,
        count: 0,
        hasMore: false
      });
    }

    if (isSpeaker && deviceFilter && !allowedDevicesSet.has(deviceFilter)) {
      return res.status(403).json({ error: 'Доступ к устройству запрещен', deviceId: deviceFilter });
    }

    if (isSpeaker && excludeDevice && !allowedDevicesSet.has(excludeDevice)) {
      return res.status(403).json({ error: 'Доступ к устройству запрещен', deviceId: excludeDevice });
    }

    try {
      const db = getDatabase();
      const params = [];
      const where = [];

      if (isSpeaker) {
        where.push(`device_id IN (${allowedDevices.map(() => '?').join(',')})`);
        params.push(...allowedDevices);
      }

      if (deviceFilter) {
        where.push('device_id = ?');
        params.push(deviceFilter);
      }

      if (excludeDevice) {
        where.push('device_id != ?');
        params.push(excludeDevice);
      }

      if (q) {
        where.push('(safe_name LIKE ? OR original_name LIKE ?)');
        const like = `%${q}%`;
        params.push(like, like);
      }

      // КРИТИЧНО: Исключаем плейсхолдеры и временные файлы
      where.push('(is_placeholder = 0 OR is_placeholder IS NULL)');
      where.push('safe_name NOT LIKE ?');
      where.push('safe_name NOT LIKE ?');
      where.push('safe_name != ?');
      params.push('.optimizing_%', '.placeholder%', 'placeholder.mp4');

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const stmt = db.prepare(`
        SELECT 
          device_id,
          safe_name,
          original_name,
          file_size,
          mime_type,
          content_type,
          stream_url,
          stream_protocol,
          file_mtime,
          md5_hash,
          video_duration,
          video_width,
          video_height,
          pages_count,
          is_placeholder
        FROM files_metadata
        ${whereSql}
        ORDER BY file_mtime DESC, created_at DESC
        LIMIT ? OFFSET ?
      `);

      const rows = stmt.all(...params, limit, offset);
      const visibleRows = readyOnly
        ? rows.filter((row) => isFileReadyForSpeaker(row.device_id, row.safe_name))
        : rows;
      // COUNT запрос использует те же условия WHERE
      const countRow = db.prepare(`SELECT COUNT(*) as total FROM files_metadata ${whereSql}`).get(...params);
      const total = countRow?.total ?? rows.length;

      // Дополняем списком папок/PDF/PPTX, которые не лежат в files_metadata
      const itemsMap = new Map();
      const items = visibleRows.map((r) => {
        const key = `${r.device_id}::${r.safe_name}`;
        itemsMap.set(key, true);
        return {
          deviceId: r.device_id,
          safeName: r.safe_name,
          originalName: r.original_name,
          size: r.file_size,
          mime: r.mime_type,
          contentType: r.content_type,
          streamUrl: r.stream_url,
          streamProtocol: r.stream_protocol,
          mtime: r.file_mtime,
          md5: r.md5_hash,
          pagesCount: r.pages_count || null,  // Количество страниц/слайдов/изображений
          video: r.video_duration ? {
            duration: r.video_duration,
            width: r.video_width,
            height: r.video_height
          } : null
        };
      });

      // Добавляем псевдо-записи для папок/презентаций, которых нет в БД
      for (const [deviceId, device] of Object.entries(devices)) {
        if (isSpeaker && !allowedDevicesSet.has(deviceId)) continue;
        // Исключаем файлы выбранного устройства
        if (excludeDevice && deviceId === excludeDevice) continue;
        
        const files = device?.files || [];
        const names = device?.fileNames || files;
        files.forEach((safeName, idx) => {
        const key = `${deviceId}::${safeName}`;
        const isTemp = safeName.startsWith('.optimizing_') || safeName.startsWith('.placeholder') || safeName === 'placeholder.mp4';
        if (isTemp) return;
        if (readyOnly && !isFileReadyForSpeaker(deviceId, safeName)) return;
          if (itemsMap.has(key)) return;
          const ext = safeName.includes('.') ? safeName.split('.').pop().toLowerCase() : '';
          const isFolder = !safeName.includes('.') || ext === 'zip';
          const isPdf = ext === 'pdf';
          const isPptx = ext === 'pptx';
          if (!(isFolder || isPdf || isPptx)) return;
          items.push({
            deviceId,
            safeName,
            originalName: names[idx] || safeName,
            size: null,
            mime: null,
            contentType: isFolder ? 'folder' : ext,
            streamUrl: null,
            streamProtocol: null,
            mtime: null,
            md5: null,
            video: null
          });
          itemsMap.set(key, true);
        });
      }

      const resultTotal = readyOnly
        ? items.length
        : total + (items.length - rows.length);

      res.json({
        items,
        total: resultTotal,
        limit,
        offset,
        count: items.length,
        hasMore: offset + rows.length < total
      });
    } catch (err) {
      logger.error('[files] Failed to fetch all files', { error: err.message });
      res.status(500).json({ error: 'Не удалось получить список файлов' });
    }
  });

  // POST /api/devices/play-from-all - подготовка к воспроизведению файла с другого устройства
  // Создает (или переиспользует) ссылку на файл в целевом устройстве без физического копирования.
  router.post('/play-from-all', requireSpeaker[0], requireSpeaker[1], jsonParser, async (req, res) => {
    const sourceDeviceId = sanitizeDeviceId(req.body?.sourceDeviceId);
    const targetDeviceId = sanitizeDeviceId(req.body?.targetDeviceId);
    const safeName = req.body?.safeName;
    const page = typeof req.body?.page === 'number' ? req.body.page : undefined;

    if (!sourceDeviceId || !targetDeviceId || !safeName) {
      return res.status(400).json({ error: 'sourceDeviceId, targetDeviceId и safeName обязательны' });
    }

    if (req.user?.role === 'speaker') {
      const hasSourceAccess = hasDeviceAccess(req.user.userId, sourceDeviceId, req.user.role);
      const hasTargetAccess = hasDeviceAccess(req.user.userId, targetDeviceId, req.user.role);

      if (!hasSourceAccess || !hasTargetAccess) {
        return res.status(403).json({ error: 'Доступ к одному из устройств запрещен' });
      }
    }

    let sourceMeta = getFileMetadata(sourceDeviceId, safeName);

    // Fallback для папок/PDF/PPTX, которые не лежат в files_metadata, но есть в файловой системе
    if (!sourceMeta) {
      const sourceDevice = devices[sourceDeviceId];
      if (!sourceDevice) {
        return res.status(404).json({ error: 'Источник не найден' });
      }
      const ext = safeName.includes('.') ? safeName.split('.').pop().toLowerCase() : '';
      const isFolder = !safeName.includes('.') || ext === 'zip';
      const isPdf = ext === 'pdf';
      const isPptx = ext === 'pptx';
      if (isFolder || isPdf || isPptx) {
        const devicesPath = getDevicesPath();
        const baseFolder = path.join(devicesPath, sourceDevice.folder || sourceDeviceId);
        let filePath = path.join(baseFolder, safeName);
        if (isFolder && ext === 'zip') {
          // zip-папка: оставляем как есть, пусть path указывает на архив
          filePath = path.join(baseFolder, safeName);
        }
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'Файл не найден в источнике' });
        }
        const stat = fs.statSync(filePath);
        const mimeGuess = isPdf ? 'application/pdf' : isPptx ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : null;
        // КРИТИЧНО: file_size обязателен в БД (NOT NULL), для папок используем 0
        const fileSize = stat.isFile() ? stat.size : 0;
        
        // КРИТИЧНО: Получаем originalName из fileNamesMap или fileNames устройства-источника
        const sourceNameMap = fileNamesMap[sourceDeviceId] || {};
        const sourceFiles = sourceDevice.files || [];
        const sourceFileNames = sourceDevice.fileNames || sourceFiles;
        const fileIndex = sourceFiles.indexOf(safeName);
        const originalName = sourceNameMap[safeName] || (fileIndex >= 0 ? sourceFileNames[fileIndex] : null) || safeName;
        
        sourceMeta = {
          device_id: sourceDeviceId,
          safe_name: safeName,
          original_name: originalName, // КРИТИЧНО: Используем реальное originalName, а не safeName
          file_path: filePath,
          file_size: fileSize,
          file_mtime: stat.mtime?.toISOString?.() || null,
          content_type: isFolder ? 'folder' : (isPdf ? 'pdf' : isPptx ? 'pptx' : null),
          mime_type: mimeGuess,
          md5_hash: null,
          partial_md5: null,
          video_width: null,
          video_height: null,
          video_duration: null,
          video_bitrate: null,
          video_codec: null,
          stream_url: null,
          stream_protocol: null
        };
      }
    }

    if (!sourceMeta) {
      return res.status(404).json({ error: 'Файл не найден в источнике' });
    }

    // Проверяем наличие целевого устройства
    if (!devices[targetDeviceId]) {
      return res.status(404).json({ error: 'Целевое устройство не найдено' });
    }

    // Получаем originalName с правильным приоритетом
    const originalName =
      sourceMeta.original_name ||
      fileNamesMap[sourceDeviceId]?.[safeName] ||
      safeName;

    // Подготовка путей/копирования для статического контента (folder/pdf/pptx) если цель другое устройство
    let targetFilePath = sourceMeta.file_path || null;
    let pagesCount = sourceMeta.pages_count || null;
    const extLower = path.extname(sourceMeta.safe_name || safeName).toLowerCase();
    const isStaticContent = ['folder', 'pdf', 'pptx'].includes(sourceMeta.content_type);
    const isImageFile = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extLower);

    // Ищем существующий safeName на целевом устройстве
    let targetSafeName = safeName;
    let skipCopy = false;
    const existing = getFileMetadata(targetDeviceId, targetSafeName);

    if (existing) {
      const existingPath = existing.file_path;
      const existsOnDisk = existingPath && fs.existsSync(existingPath);
      const existingIsStatic = ['folder', 'pdf', 'pptx', 'image'].includes(existing.content_type || '');

      if (existingIsStatic) {
        // Всегда переиспользуем то же имя; путь берем из существующей записи, если есть
        targetSafeName = existing.safe_name;
        if (existing.file_path) {
          targetFilePath = existing.file_path;
        }
        // Если физически есть — копировать не надо
        if (existsOnDisk) {
          skipCopy = true;
        }
      } else if (existing.file_path !== sourceMeta.file_path) {
        // Конфликт по имени — генерируем уникальное (для разных путей)
        const ext = path.extname(targetSafeName);
        const base = path.basename(targetSafeName, ext);
        targetSafeName = `${base}_${crypto.randomBytes(3).toString('hex')}${ext}`;
      }
    }

    // Если это статический контент и pagesCount отсутствует, считаем на источнике
    if (isStaticContent && (pagesCount === null || pagesCount === undefined)) {
      try {
        const ext = path.extname(sourceMeta.safe_name || safeName).toLowerCase();
        const folderName = sourceMeta.content_type === 'folder'
          ? sourceMeta.safe_name || safeName
          : (sourceMeta.safe_name || safeName).replace(/\.(pdf|pptx)$/i, '');
        pagesCount = await getFolderImagesCount(sourceDeviceId, folderName);
      } catch (err) {
        pagesCount = null;
      }
    }

    // Новая логика: не копируем статический контент, используем путь источника
    if (isStaticContent && targetDeviceId !== sourceDeviceId) {
      skipCopy = true;
      targetFilePath = sourceMeta.file_path;
      targetSafeName = safeName;
    }

    // Копирование одиночных изображений (png/jpg/gif/webp) между устройствами
    // Не копируем одиночные изображения, играем с источника
    if (isImageFile && targetDeviceId !== sourceDeviceId) {
      skipCopy = true;
      targetFilePath = sourceMeta.file_path;
      targetSafeName = safeName;
    }

    // Если записи нет или путь отличается — сохраняем метаданные, указывая на целевой путь (или исходный, если тот же девайс)
    const alreadyLinked = (existing && existing.file_path === targetFilePath) || skipCopy;
    const shouldSaveMetadata =
      !isStaticContent && !isImageFile
        ? !alreadyLinked
        : (targetDeviceId === sourceDeviceId && !alreadyLinked); // для статического контента/изображений не сохраняем запись на целевое устройство, если оно другое

    if (shouldSaveMetadata) {
      saveFileMetadata({
        deviceId: targetDeviceId,
        safeName: targetSafeName,
        originalName,
        filePath: targetFilePath,
        fileSize: sourceMeta.file_size ?? 0, // КРИТИЧНО: file_size обязателен (NOT NULL), используем 0 по умолчанию
        md5Hash: sourceMeta.md5_hash,
        partialMd5: sourceMeta.partial_md5,
        mimeType: sourceMeta.mime_type,
        videoParams: {
          width: sourceMeta.video_width,
          height: sourceMeta.video_height,
          duration: sourceMeta.video_duration,
          codec: sourceMeta.video_codec,
          bitrate: sourceMeta.video_bitrate
        },
        audioParams: {
          codec: sourceMeta.audio_codec,
          bitrate: sourceMeta.audio_bitrate,
          channels: sourceMeta.audio_channels
        },
        fileMtime: sourceMeta.file_mtime,
        contentType: sourceMeta.content_type,
        streamUrl: sourceMeta.stream_url,
        streamProtocol: sourceMeta.stream_protocol,
        pagesCount
      });

      if (!fileNamesMap[targetDeviceId]) fileNamesMap[targetDeviceId] = {};
      fileNamesMap[targetDeviceId][targetSafeName] = originalName;
      saveFileNamesMap(fileNamesMap);

      updateDeviceFilesFromDB(targetDeviceId, devices, fileNamesMap);
    } else {
      // КРИТИЧНО: Даже если файл уже существует, обновляем fileNamesMap с правильным originalName
      // Это важно, если файл был создан ранее без правильного originalName
      const currentNameInMap = fileNamesMap[targetDeviceId]?.[targetSafeName];
      if (currentNameInMap !== originalName) {
        if (!fileNamesMap[targetDeviceId]) fileNamesMap[targetDeviceId] = {};
        fileNamesMap[targetDeviceId][targetSafeName] = originalName;
        saveFileNamesMap(fileNamesMap);
        // Обновляем метаданные в БД, если originalName отличается
        if (existing && existing.original_name !== originalName) {
          updateFileOriginalName(targetDeviceId, targetSafeName, originalName);
        }
        updateDeviceFilesFromDB(targetDeviceId, devices, fileNamesMap);
      }
    }

    // Возвращаем safeName, чтобы фронт мог вызвать обычный play по целевому устройству
    // КРИТИЧНО: Используем content_type из метаданных БД (приоритет), fallback только если нет
    const metadata = existing || sourceMeta;
    let contentType = metadata?.content_type;
    
    // Fallback только если content_type отсутствует в БД (старые записи)
    if (!contentType) {
      const targetDevice = devices[targetDeviceId];

      if (metadata?.stream_url || targetDevice?.streams?.[targetSafeName]) {
        contentType = 'streaming';
      } else {
        const inferredType = resolveContentType({
          fileName: targetSafeName,
          originalName,
          fallbackToFolder: true
        });
        contentType = inferredType || 'video';
      }
    }
    
    const playPayload = {
      device_id: targetDeviceId,
      file: targetSafeName,
      type: contentType,
      page: STATIC_CONTENT_TYPES.has(contentType) ? (page || 1) : undefined,
      streamProtocol: contentType === 'streaming'
        ? normalizeStreamProtocol(sourceMeta.stream_protocol, sourceMeta.stream_url, sourceMeta.mime_type)
        : undefined
    };
    res.json({
      ok: true,
      sourceDeviceId,
      targetDeviceId,
      safeName: targetSafeName,
      alreadyLinked,
      type: contentType,
      playPayload
    });
  });
  // POST /api/devices/:id/streams - Добавление стрима (только админ)
  router.post('/:id/streams', requireAdmin, jsonParser, async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Неверный ID устройства' });
    const device = devices[id];
    if (!device) return res.status(404).json({ error: 'Устройство не найдено' });

    const { name, url, protocol } = req.body || {};
    if (!name || !url) {
      return res.status(400).json({ error: 'Требуются название и URL' });
    }
    let parsedUrl = null;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return res.status(400).json({ error: 'Поддерживаются только HTTP/HTTPS стримы' });
      }
    } catch {
      return res.status(400).json({ error: 'Неверный URL' });
    }

    const requestedProtocol = (protocol || 'auto').toString().trim().toLowerCase();
    if (requestedProtocol && !STREAM_PROTOCOLS.has(requestedProtocol)) {
      return res.status(400).json({ error: 'Поддерживаются только HLS и DASH стримы' });
    }

    const baseSafe = makeSafeFolderName(name) || `stream_${Date.now()}`;
    let safeName = baseSafe;
    let suffix = 1;
    while ((device.files || []).includes(safeName)) {
      safeName = `${baseSafe}_${suffix++}`;
    }

    const normalizedProtocol = normalizeStreamProtocol(protocol, parsedUrl.toString());
    if (!isDirectPlaybackAvailable(normalizedProtocol)) {
      return res.status(400).json({ error: 'Поддерживаются только HLS и DASH стримы' });
    }

    try {
      createStreamingEntry({
        deviceId: id,
        safeName,
        originalName: name,
        streamUrl: parsedUrl.toString(),
        protocol: normalizedProtocol
      });
<<<<<<< HEAD
=======
      const newMetadata = getFileMetadata(id, safeName);
      if (newMetadata && shouldProxyStreamProtocol(normalizedProtocol)) {
        upsertStreamJob(newMetadata);
      }
>>>>>>> 76d29d0af24a9d06f52ca3c5612c50a10cc64ed0
      if (!fileNamesMap[id]) fileNamesMap[id] = {};
      fileNamesMap[id][safeName] = name;
      saveFileNamesMap(fileNamesMap);

      updateDeviceFilesFromDB(id, devices, fileNamesMap);
      io.emit('devices/updated');

      await auditLog({
        userId: req.user?.id || null,
        action: AuditAction.FILE_UPLOAD,
        resource: `device:${id}`,
        details: {
          deviceId: id,
          filesCount: 1,
          files: [safeName],
          uploadedBy: req.user?.username || 'anonymous',
          type: 'streaming'
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        status: 'success'
      });

      res.status(201).json({
        ok: true,
        safeName,
        originalName: name,
        streamUrl: parsedUrl.toString(),
        protocol: normalizedProtocol
      });
    } catch (error) {
      logger.error('[streams] Failed to create stream', { error: error.message, deviceId: id });
      res.status(500).json({ error: 'Не удалось создать стрим' });
    }
  });

  // GET /api/devices/:id/streams/:safeName - Получить данные стрима (для плееров)
  router.get('/:id/streams/:safeName/dash-utc-time.xml', (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    if (!id) return res.status(400).send('invalid device id');

    const safeName = req.params.safeName;
    if (!safeName) return res.status(400).send('invalid stream name');

    const metadata = getFileMetadata(id, safeName);
    if (!metadata || metadata.content_type !== 'streaming') {
      return res.status(404).send('stream not found');
    }

    const protocol = normalizeStreamProtocol(metadata.stream_protocol, metadata.stream_url, metadata.mime_type);
    if (protocol !== 'dash') {
      return res.status(400).send('dash only');
    }

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(new Date().toISOString());
  });

  router.get('/:id/streams/:safeName/dash-manifest.mpd', async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Неверный ID устройства' });

    const safeName = req.params.safeName;
    if (!safeName) return res.status(400).json({ error: 'Неверное название стрима' });

    const metadata = getFileMetadata(id, safeName);
    if (!metadata || metadata.content_type !== 'streaming') {
      return res.status(404).json({ error: 'Стрим не найден' });
    }

    const protocol = normalizeStreamProtocol(metadata.stream_protocol, metadata.stream_url, metadata.mime_type);
    if (protocol !== 'dash') {
      return res.status(400).json({ error: 'Режим доступен только для DASH стримов' });
    }

    let upstreamUrl;
    try {
      upstreamUrl = new URL(metadata.stream_url).toString();
      const parsed = new URL(upstreamUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'Поддерживаются только HTTP/HTTPS DASH источники' });
      }
    } catch {
      return res.status(400).json({ error: 'Некорректный URL DASH источника' });
    }

    try {
      const upstreamResponse = await fetchTextWithTimeout(upstreamUrl);
      if (!upstreamResponse.ok) {
        logger.warn('[streams] DASH manifest relay upstream error', {
          deviceId: id,
          safeName,
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          upstreamUrl
        });
        return res.status(upstreamResponse.status).json({ error: 'Не удалось получить DASH манифест' });
      }

      const upstreamManifest = await upstreamResponse.text();
      if (!upstreamManifest || !upstreamManifest.includes('<MPD')) {
        logger.warn('[streams] DASH manifest relay received invalid payload', {
          deviceId: id,
          safeName,
          upstreamUrl
        });
        return res.status(502).json({ error: 'Источник вернул некорректный DASH манифест' });
      }

      const utcTimingUrl = buildDashUtcSyncUrl(id, safeName);
      const rewrittenManifest = rewriteDashManifestUris(upstreamManifest, upstreamUrl, { utcTimingUrl });
      res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.send(rewrittenManifest);
    } catch (error) {
      logger.error('[streams] DASH manifest relay failed', {
        deviceId: id,
        safeName,
        upstreamUrl,
        error: error.message
      });
      res.status(502).json({ error: 'Не удалось загрузить DASH манифест' });
    }
  });

  router.get('/:id/streams/:safeName', async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Неверный ID устройства' });
    const safeName = req.params.safeName;
    if (!safeName) return res.status(400).json({ error: 'Неверное название стрима' });

    const metadata = getFileMetadata(id, safeName);
    if (!metadata || metadata.content_type !== 'streaming') {
      return res.status(404).json({ error: 'Стрим не найден' });
    }

    const protocol = normalizeStreamProtocol(metadata.stream_protocol, metadata.stream_url, metadata.mime_type);
<<<<<<< HEAD
    const directPlaybackUrl = resolveDirectStreamPlaybackUrl(id, safeName, metadata.stream_url, protocol);
    const playbackStrategy = protocol === 'dash' ? 'direct_dash_manifest_relay' : 'direct_hls';
=======
    const directPlaybackAvailable = isDirectPlaybackAvailable(protocol);
    const forceProxyPlayback = req.query.proxy === '1' || req.query.forceProxy === '1';
    const explicitDirectPlayback = req.query.direct === '1' || req.query.preferDirect === '1';
    const preferDirectPlayback = directPlaybackAvailable && (explicitDirectPlayback || !forceProxyPlayback);

    // КРИТИЧНО: Lazy loading - запускаем FFmpeg только когда стрим запрашивается для воспроизведения
    // Это экономит ресурсы, так как не все стримы используются одновременно
    const { getStreamManager } = await import('../streams/stream-manager.js');
    const streamManager = getStreamManager();
    let streamProxyUrl = null;
    let proxyFallbackUrl = null;
    let playbackStrategy = 'proxy';
    const directPlaybackUrl = resolveDirectStreamPlaybackUrl(id, safeName, metadata.stream_url, protocol);

    if (preferDirectPlayback) {
      streamProxyUrl = directPlaybackUrl;
      proxyFallbackUrl = getStreamPlaybackUrl(id, safeName);
      playbackStrategy = protocol === 'dash' ? 'direct_dash_manifest_relay' : 'direct_hls';
    } else if (streamManager) {
      // Запускаем FFmpeg, если еще не запущен (lazy loading)
      streamProxyUrl = await streamManager.ensureStreamRunning(id, safeName, metadata);
      proxyFallbackUrl = streamProxyUrl;
    } else {
      // Fallback: используем старый метод
      streamProxyUrl = getStreamPlaybackUrl(id, safeName);
      proxyFallbackUrl = streamProxyUrl;
    }
>>>>>>> 76d29d0af24a9d06f52ca3c5612c50a10cc64ed0

    res.json({
      safeName: metadata.safe_name,
      originalName: metadata.original_name,
      streamUrl: metadata.stream_url,
<<<<<<< HEAD
      streamProxyUrl: directPlaybackUrl,
      directStreamUrl: directPlaybackUrl,
      proxyStreamUrl: null,
=======
      streamProxyUrl: streamProxyUrl,
      directStreamUrl: preferDirectPlayback ? directPlaybackUrl : null,
      proxyStreamUrl: proxyFallbackUrl,
>>>>>>> 76d29d0af24a9d06f52ca3c5612c50a10cc64ed0
      protocol,
      playbackStrategy,
      directPlaybackAvailable: true
    });
  });

  // PUT /api/devices/:id/streams/:safeName - Обновление стрима (только админ)
  router.put('/:id/streams/:safeName', requireAdmin, jsonParser, async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Неверный ID устройства' });
    const device = devices[id];
    if (!device) return res.status(404).json({ error: 'Устройство не найдено' });

    const safeName = req.params.safeName;
    if (!safeName) return res.status(400).json({ error: 'Неверное название стрима' });

    const { name, url, protocol } = req.body || {};
    if (!name || !url) {
      return res.status(400).json({ error: 'Требуются название и URL' });
    }

    const requestedProtocol = (protocol || 'auto').toString().trim().toLowerCase();
    if (requestedProtocol && !STREAM_PROTOCOLS.has(requestedProtocol)) {
      return res.status(400).json({ error: 'Поддерживаются только HLS и DASH стримы' });
    }

    // Проверяем существование стрима
    const existingMetadata = getFileMetadata(id, safeName);
    if (!existingMetadata || existingMetadata.content_type !== 'streaming') {
      return res.status(404).json({ error: 'Стрим не найден' });
    }

    // Валидация URL
    let parsedUrl = null;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return res.status(400).json({ error: 'Поддерживаются только HTTP/HTTPS стримы' });
      }
    } catch {
      return res.status(400).json({ error: 'Неверный URL' });
    }

    const normalizedProtocol = normalizeStreamProtocol(protocol, parsedUrl.toString());
    if (!isDirectPlaybackAvailable(normalizedProtocol)) {
      return res.status(400).json({ error: 'Поддерживаются только HLS и DASH стримы' });
    }

    try {
      // Обновляем метаданные стрима
      const updated = updateStreamMetadata(
        id,
        safeName,
        name,
        parsedUrl.toString(),
        normalizedProtocol
      );

      if (!updated) {
        return res.status(404).json({ error: 'Стрим не найден' });
      }

      // Обновляем fileNamesMap
      if (!fileNamesMap[id]) fileNamesMap[id] = {};
      fileNamesMap[id][safeName] = name;
      saveFileNamesMap(fileNamesMap);

<<<<<<< HEAD
=======
      // КРИТИЧНО: Перезапускаем FFmpeg с новым URL, если стрим был запущен
      // Сначала останавливаем старый job
      try {
        removeStreamJob(id, safeName, 'updated');
      } catch (err) {
        // Игнорируем ошибки остановки (может быть не запущен)
        logger.debug('[streams] Stream job not running or already stopped', { deviceId: id, safeName });
      }

      // Получаем обновленные метаданные и создаем новый job
      const updatedMetadata = getFileMetadata(id, safeName);
      if (updatedMetadata && shouldProxyStreamProtocol(normalizedProtocol)) {
        upsertStreamJob(updatedMetadata);
      }

>>>>>>> 76d29d0af24a9d06f52ca3c5612c50a10cc64ed0
      // Обновляем список файлов устройства
      updateDeviceFilesFromDB(id, devices, fileNamesMap);
      io.emit('devices/updated');

      await auditLog({
        userId: req.user?.id || null,
        action: AuditAction.FILE_UPLOAD,
        resource: `device:${id}`,
        details: {
          deviceId: id,
          action: 'stream_updated',
          safeName,
          originalName: name,
          streamUrl: parsedUrl.toString(),
          protocol: normalizedProtocol,
          updatedBy: req.user?.username || 'anonymous'
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        status: 'success'
      });

      res.json({
        ok: true,
        safeName,
        originalName: name,
        streamUrl: parsedUrl.toString(),
        protocol: normalizedProtocol
      });
    } catch (error) {
      logger.error('[streams] Failed to update stream', { error: error.message, deviceId: id, safeName });
      res.status(500).json({ error: 'Не удалось обновить стрим' });
    }
  });

  // POST /api/devices/:id/streams/:safeName/stop-preview - Остановить стрим после превью
  // КРИТИЧНО: Используем requireSpeaker для доступа из speaker панели
  // КРИТИЧНО: Теперь стримы общие, проверяем только наличие активных устройств
  router.post('/:id/streams/:safeName/stop-preview', requireSpeaker[0], requireSpeaker[1], jsonParser, async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Неверный ID устройства' });

    if (!hasDeviceAccess(req.user.userId, id, req.user.role)) {
      return res.status(403).json({ error: 'Доступ к устройству запрещен' });
    }

    const safeName = req.params.safeName;
    if (!safeName) return res.status(400).json({ error: 'Неверное название стрима' });

    const device = devices[id];
    if (!device) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }

    const metadata = getFileMetadata(id, safeName);
    if (!metadata || metadata.content_type !== 'streaming') {
      return res.status(404).json({ error: 'Стрим не найден' });
    }

    // КРИТИЧНО: Проверяем, используется ли стрим на любом устройстве
    // Если используется - не останавливаем
    let isPlayingOnAnyDevice = false;
    for (const [deviceId, dev] of Object.entries(devices)) {
      if (dev.current && dev.current.type === 'streaming' && dev.current.file === safeName) {
        isPlayingOnAnyDevice = true;
        break;
      }
    }

    if (isPlayingOnAnyDevice) {
      return res.status(409).json({ error: 'Стрим используется устройством' });
    }

    // В direct-link режиме ничего останавливать не нужно: нет stream worker/proxy.
    logger.info('[streams] Preview stream stop requested (direct mode)', { deviceId: id, safeName });
    res.json({ ok: true, stopped: false, mode: 'direct' });
  });

  // POST /api/devices/:id/streams/:safeName/cancel-worker
  // В direct-link режиме stream worker отсутствует; endpoint сохранен для обратной совместимости.
  router.post('/:id/streams/:safeName/cancel-worker', requireAdmin, jsonParser, async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Неверный ID устройства' });

    const safeName = (req.params.safeName || '').toString().trim();
    if (!safeName) return res.status(400).json({ error: 'Неверное название стрима' });

    if (!devices[id]) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }

    const metadata = getFileMetadata(id, safeName);
    if (!metadata || metadata.content_type !== 'streaming') {
      return res.status(404).json({ error: 'Стрим не найден' });
    }

    logger.info('[streams] Cancel-worker ignored in direct mode', {
      deviceId: id,
      safeName,
      user: req.user?.username || 'unknown'
    });

    res.status(409).json({
      ok: false,
      requested: false,
      safeName,
      mode: 'direct',
      error: 'Stream worker disabled: используется только прямой stream_url'
    });
  });

  // POST /api/devices/:id/download-url - Загрузка видео по ссылке через локальный yt-dlp
  router.post('/:id/download-url', requireAdmin, jsonParser, async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Неверный ID устройства' });
    if (!devices[id]) return res.status(404).json({ error: 'Устройство не найдено' });

    const rawUrl = (req.body?.url || '').toString().trim();
    if (!rawUrl) {
      return res.status(400).json({ error: 'Требуется ссылка на видео' });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return res.status(400).json({ error: 'Неверный URL' });
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Поддерживаются только HTTP/HTTPS ссылки' });
    }

    const job = createYtDlpJob({
      deviceId: id,
      url: parsedUrl.toString(),
      username: req.user?.username
    });

    res.status(202).json({
      ok: true,
      jobId: job.id,
      status: job.status
    });

    enqueueYtDlpDeviceJob(id, async () => {
      let finalPathCandidate = null;
      let titleCandidate = null;
      let lastErrorLine = null;
      let resourceReservation = null;

      try {
        const queuedJob = ytDlpJobs.get(job.id);
        if (!queuedJob || queuedJob.cancelRequested || queuedJob.status === 'cancelled') {
          return;
        }

        updateYtDlpJob(job.id, {
          status: 'waiting_resources',
          progress: 0,
          error: null
        });

        resourceReservation = await jobResourceManager.acquire({
          id: job.resourceRequestId,
          jobType: 'yt-dlp-download',
          cpuUnits: ytDlpResourceCpuUnits,
          memoryMb: ytDlpResourceMemoryMb,
          priority: 1,
          timeoutMs: ytDlpResourceTimeoutMs,
          meta: {
            deviceId: id,
            jobId: job.id
          }
        });

        const reservedJob = ytDlpJobs.get(job.id);
        if (!reservedJob || reservedJob.cancelRequested || reservedJob.status === 'cancelled') {
          return;
        }

        updateYtDlpJob(job.id, {
          status: 'preparing',
          progress: 0,
          error: null,
          resourceReservationId: resourceReservation.id
        });

        const binaryPath = await ensureLocalYtDlpBinary({ logger });
        const devicesPath = getDevicesPath();

        updateYtDlpJob(job.id, {
          status: 'downloading',
          progress: 0,
          binaryPath
        });

        const args = [
          '--no-playlist',
          '--newline',
          '--progress',
          '--progress-delta', '1',
          '--restrict-filenames',
          '--merge-output-format', 'mp4',
          '--print', `before_dl:${YTDLP_TITLE_MARKER}%(title)s`,
          '--print', `after_move:${YTDLP_FINAL_PATH_MARKER}%(filepath)s`,
          '--no-write-thumbnail',
          '--no-write-info-json',
          '-P', devicesPath,
          '-o', '%(title).180B [%(id)s].%(ext)s',
          parsedUrl.toString()
        ];

        const child = spawn(binaryPath, args, {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        updateYtDlpJob(job.id, { pid: child.pid || null });

        const handleLine = (line) => {
          const cleanLine = (line || '').trim();
          if (!cleanLine) return;

          const currentJob = ytDlpJobs.get(job.id);
          if (!currentJob || currentJob.cancelRequested || currentJob.status === 'cancelled') {
            return;
          }

          const titleValue = extractMarkerValue(cleanLine, YTDLP_TITLE_MARKER);
          if (titleValue) {
            titleCandidate = titleValue;
            updateYtDlpJob(job.id, { title: titleCandidate, lastLogLine: cleanLine });
            return;
          }

          const pathCandidate = extractYtDlpPathCandidate(cleanLine);
          if (pathCandidate) {
            finalPathCandidate = pathCandidate;
          }

          const progress = parseYtDlpProgress(cleanLine);
          if (progress) {
            const current = ytDlpJobs.get(job.id);
            updateYtDlpJob(job.id, {
              progress: progress.percent !== null
                ? Math.max(current?.progress || 0, progress.percent)
                : current?.progress || 0,
              speed: progress.speed || current?.speed || null,
              eta: progress.eta || current?.eta || null,
              lastLogLine: cleanLine
            });
          } else {
            updateYtDlpJob(job.id, { lastLogLine: cleanLine });
          }

          if (cleanLine.includes('ERROR:')) {
            lastErrorLine = cleanLine;
          }
        };

        const bindStream = (stream) => {
          let buffered = '';
          stream.on('data', (chunk) => {
            buffered += chunk.toString();
            const lines = buffered.split(/\r?\n/);
            buffered = lines.pop() || '';
            lines.forEach(handleLine);
          });
          stream.on('end', () => {
            if (buffered.trim()) {
              handleLine(buffered);
            }
          });
        };

        bindStream(child.stdout);
        bindStream(child.stderr);

        await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code) => {
            if (code === 0) {
              resolve();
              return;
            }
            reject(new Error(lastErrorLine || `yt-dlp exited with code ${code}`));
          });
        });

        const afterDownloadJob = ytDlpJobs.get(job.id);
        if (!afterDownloadJob || afterDownloadJob.cancelRequested || afterDownloadJob.status === 'cancelled') {
          return;
        }

        updateYtDlpJob(job.id, {
          status: 'processing',
          progress: 100,
          eta: null
        });

        const resolvedCandidate = finalPathCandidate
          ? (path.isAbsolute(finalPathCandidate)
            ? path.resolve(finalPathCandidate)
            : path.resolve(path.join(devicesPath, finalPathCandidate)))
          : null;

        const preferredName = titleCandidate
          ? `${titleCandidate}${resolvedCandidate ? path.extname(resolvedCandidate) : ''}`
          : null;

        const uploadedFile = await registerYtDlpDownloadedFile(id, resolvedCandidate, preferredName);

        await auditLog({
          userId: req.user?.userId || null,
          action: AuditAction.FILE_UPLOAD,
          resource: `device:${id}`,
          details: {
            deviceId: id,
            filesCount: 1,
            files: [uploadedFile.safeName],
            uploadedBy: req.user?.username || 'anonymous',
            source: 'yt-dlp',
            url: parsedUrl.toString()
          },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          status: 'success'
        });

        updateYtDlpJob(job.id, {
          status: 'completed',
          progress: 100,
          fileName: uploadedFile.safeName,
          title: titleCandidate || uploadedFile.originalName,
          error: null,
          speed: null,
          eta: null,
          pid: null,
          resourceReservationId: null
        });
      } catch (error) {
        const cancelledJob = ytDlpJobs.get(job.id);
        if (cancelledJob?.cancelRequested || cancelledJob?.status === 'cancelled') {
          logger.info('[yt-dlp] URL download cancelled', {
            deviceId: id,
            jobId: job.id,
            url: parsedUrl?.toString?.() || rawUrl
          });

          updateYtDlpJob(job.id, {
            status: 'cancelled',
            error: cancelledJob?.error || 'Загрузка отменена пользователем',
            speed: null,
            eta: null,
            pid: null,
            resourceReservationId: null
          });
          return;
        }

        const failureMessage = error.message === 'Resource acquisition timeout'
          ? 'Нет свободных ресурсов для загрузки, попробуйте позже'
          : (error.message || 'Ошибка загрузки');

        logger.error('[yt-dlp] URL download failed', {
          deviceId: id,
          jobId: job.id,
          url: parsedUrl?.toString?.() || rawUrl,
          error: failureMessage,
          rawError: error.message,
          stack: error.stack
        });

        updateYtDlpJob(job.id, {
          status: 'failed',
          error: failureMessage,
          speed: null,
          eta: null,
          pid: null,
          resourceReservationId: null
        });
      } finally {
        if (resourceReservation?.release) {
          try {
            resourceReservation.release();
          } catch (releaseError) {
            logger.warn('[yt-dlp] Failed to release reservation', {
              deviceId: id,
              jobId: job.id,
              reservationId: resourceReservation.id,
              error: releaseError.message
            });
          }
        } else {
          jobResourceManager.release(job.resourceRequestId);
        }

        updateYtDlpJob(job.id, {
          resourceReservationId: null
        });

        scheduleYtDlpJobCleanup(job.id);
        pruneFinishedYtDlpJobs();
      }
    }).catch((err) => {
      const cancelledJob = ytDlpJobs.get(job.id);
      if (cancelledJob?.cancelRequested || cancelledJob?.status === 'cancelled') {
        updateYtDlpJob(job.id, {
          status: 'cancelled',
          error: cancelledJob?.error || 'Загрузка отменена пользователем',
          speed: null,
          eta: null,
          pid: null,
          resourceReservationId: null
        });
        scheduleYtDlpJobCleanup(job.id);
        return;
      }

      logger.error('[yt-dlp] Unexpected background handler error', {
        deviceId: id,
        jobId: job.id,
        error: err.message,
        stack: err.stack
      });
      updateYtDlpJob(job.id, {
        status: 'failed',
        error: err.message || 'Ошибка фоновой обработки',
        resourceReservationId: null
      });
      scheduleYtDlpJobCleanup(job.id);
    });
  });

  // POST /api/devices/:id/download-url/cancel - Отменить задачи загрузки по ссылке
  router.post('/:id/download-url/cancel', requireAdmin, jsonParser, (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Неверный ID устройства' });
    if (!devices[id]) return res.status(404).json({ error: 'Устройство не найдено' });

    const requestedJobId = (req.body?.jobId || '').toString().trim();
    const reason = req.user?.username
      ? `Загрузка отменена пользователем ${req.user.username}`
      : 'Загрузка отменена пользователем';

    let jobsToCancel = [];

    if (requestedJobId) {
      const singleJob = ytDlpJobs.get(requestedJobId);
      if (!singleJob || singleJob.deviceId !== id) {
        return res.status(404).json({ error: 'Задача не найдена' });
      }
      if (isYtDlpJobActive(singleJob)) {
        jobsToCancel.push(singleJob);
      }
    } else {
      jobsToCancel = Array.from(ytDlpJobs.values()).filter((job) => {
        return job.deviceId === id && isYtDlpJobActive(job);
      });
    }

    const cancelledIds = [];
    jobsToCancel.forEach((job) => {
      if (cancelYtDlpJob(job, reason)) {
        cancelledIds.push(job.id);
      }
    });

    res.json({
      ok: true,
      cancelled: cancelledIds.length,
      jobIds: cancelledIds
    });
  });

  // GET /api/devices/:id/download-url/:jobId - Получить статус загрузки по ссылке
  router.get('/:id/download-url/:jobId', requireAdmin, (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Неверный ID устройства' });

    const jobId = (req.params.jobId || '').toString();
    if (!jobId) return res.status(400).json({ error: 'Неверный jobId' });

    const job = ytDlpJobs.get(jobId);
    if (!job || job.deviceId !== id) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }

    res.json({
      ok: true,
      job: {
        id: job.id,
        deviceId: job.deviceId,
        status: job.status,
        progress: job.progress,
        speed: job.speed,
        eta: job.eta,
        fileName: job.fileName,
        title: job.title,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt
      }
    });
  });

  
  // POST /api/devices/:id/upload - Загрузка файлов
  router.post('/:id/upload', uploadLimiter, validateUploadSize, async (req, res, next) => {
    logger.debug('[UPLOAD ROUTE] Upload request received', {
      url: req.url,
      method: req.method,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      params: req.params
    });
    
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }
    
    if (!devices[id]) {
      logger.warn('[UPLOAD ROUTE] Device not found', { deviceId: id, availableDevices: Object.keys(devices) });
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    // КРИТИЧНО: Обрабатываем отмену загрузки клиентом
    let isAborted = false;
    const uploadedFiles = []; // Сохраняем список загруженных файлов для очистки при отмене
    
    // КРИТИЧНО: Флаг для отслеживания, были ли файлы уже сохранены multer
    let filesSavedByMulter = false;
    let multerStarted = false; // Флаг что multer начал обработку
    
    const cleanupOnAbort = () => {
      // КРИТИЧНО: Если multer уже начал обработку - НЕ удаляем файлы!
      // Браузер может закрыть соединение во время загрузки - это нормально для больших файлов
      // Multer продолжит сохранение файла в фоне
      if (multerStarted) {
        logger.warn('[Upload] Client closed connection but multer is processing, skipping cleanup', {
          deviceId: id,
          multerStarted,
          filesSavedByMulter
        });
        isAborted = true; // Помечаем как прерванное, но НЕ удаляем файлы
        return; // НЕ удаляем файлы, multer их сохранит
      }
      
      // КРИТИЧНО: Если файлы уже сохранены multer - НЕ удаляем их!
      if (filesSavedByMulter) {
        logger.warn('[Upload] Client closed connection but files are already saved, skipping cleanup', {
          deviceId: id,
          uploadedFiles: uploadedFiles.length
        });
        return; // НЕ удаляем файлы, они уже сохранены и должны быть обработаны
      }
      
      if (isAborted) return;
      isAborted = true;
      
      logger.warn('[Upload] Upload aborted by client BEFORE multer started', {
        deviceId: id,
        uploadedFiles: uploadedFiles.length
      });
      
      // Удаляем все частично загруженные файлы (только если multer еще не начал)
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          try {
            if (file.path && fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
              logger.debug('[Upload] Cleaned up aborted file', { path: file.path });
            }
          } catch (cleanupErr) {
            logger.error('[Upload] Error cleaning up aborted file', {
              path: file.path,
              error: cleanupErr.message
            });
          }
        }
      }
      
      // Также удаляем файлы из uploadedFiles
      for (const filePath of uploadedFiles) {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (cleanupErr) {
          logger.error('[Upload] Error cleaning up uploaded file', {
            path: filePath,
            error: cleanupErr.message
          });
        }
      }
    };
    
    // КРИТИЧНО: НЕ устанавливаем обработчики до multer
    // Multer сам обработает закрытие соединения и сохранит файл
    // Обработчики установим ПОСЛЕ multer callback
    
    // КРИТИЧНО: Помечаем что multer начал обработку
    // Это предотвратит удаление файлов если клиент закроет соединение во время загрузки
    multerStarted = true;
    
    upload.array('files', 50)(req, res, async (err) => {
      // КРИТИЧНО: Помечаем что файлы сохранены multer
      // После этого cleanupOnAbort не будет удалять файлы
      if (req.files && req.files.length > 0) {
        filesSavedByMulter = true;
        
        // Проверяем что файлы действительно существуют на диске
        for (const file of req.files) {
          if (file.path && !fs.existsSync(file.path)) {
            logger.error('[UPLOAD ROUTE] ⚠️ File path from multer does not exist!', {
              filename: file.filename,
              path: file.path
            });
          }
        }
      }
      
      // КРИТИЧНО: НЕ устанавливаем обработчики после multer
      // Файлы уже сохранены, обработчики не нужны
      // Если клиент закрыл соединение - это нормально, продолжаем обработку
      
      // КРИТИЧНО: Проверяем isAborted ПОСЛЕ multer, но НЕ прерываем обработку
      // Клиент может закрыть соединение после получения ответа, это нормально
      // Файлы уже сохранены multer, нужно их обработать
      if (isAborted && (!req.files || req.files.length === 0)) {
        logger.warn('[UPLOAD ROUTE] Upload was aborted BEFORE files were saved', { deviceId: id });
        // Загрузка была отменена ДО сохранения файлов - не обрабатываем
        return;
      }
      
      // КРИТИЧНО: Если файлы сохранены, но клиент закрыл соединение - это нормально
      // Продолжаем обработку в фоне НЕЗАВИСИМО от isAborted
      if (isAborted && req.files && req.files.length > 0) {
        logger.warn('[UPLOAD ROUTE] Client closed connection but files are saved, continuing processing', {
          deviceId: id,
          filesCount: req.files.length
        });
      }
      
      // КРИТИЧНО: Сбрасываем isAborted если файлы сохранены
      // Это позволит продолжить обработку
      if (filesSavedByMulter) {
        isAborted = false; // Сбрасываем флаг чтобы продолжить обработку
      }
      
      if (err) {
        // ИСПРАВЛЕНО: Специфичная обработка ошибок загрузки
        if (err.code === 'ENOSPC') {
          logger.error('[Upload] No space left on device', { error: err.message });
          // Очищаем загруженные файлы при ошибке диска
          cleanupOnAbort();
          return res.status(507).json({ error: 'Недостаточно места на устройстве' });
        } else if (err.code === 'LIMIT_FILE_SIZE') {
          logger.warn('[Upload] File size limit exceeded', { error: err.message });
          cleanupOnAbort();
          return res.status(413).json({ error: 'Превышен лимит размера файла' });
        } else if (err.message === 'unsupported type') {
          cleanupOnAbort();
          return res.status(415).json({ error: 'Неподдерживаемый тип файла' });
        }
        
        logger.error('[Upload] Upload error', { error: err.message, code: err.code });
        cleanupOnAbort();
        return res.status(400).json({ error: err.message });
      }
      
      // КРИТИЧНО: Валидация MIME-типов файлов (проверка реального типа, а не только расширения)
      // Это дополнительная защита от подделки расширений файлов
      if (req.files && req.files.length > 0) {
        try {
          const validationResult = await validateFilesAsync(req.files);
          
          if (!validationResult.valid) {
            logger.warn('[Upload] ⚠️ File MIME type validation failed', {
              deviceId: id,
              invalidFiles: validationResult.invalid
            });
            
            // Очищаем файлы при ошибке валидации
            cleanupOnAbort();
            
            return res.status(400).json({
              error: 'Обнаружены файлы с недопустимыми типами',
              invalid: validationResult.invalid
            });
          }
          
          // Сохраняем результаты валидации для дальнейшего использования
          req.validatedFiles = validationResult.results;
          
          logger.debug('[Upload] ✅ File MIME type validation passed', {
            deviceId: id,
            filesCount: req.files.length,
            validatedMimes: validationResult.results.map(r => r.mime)
          });
        } catch (validationErr) {
          logger.error('[Upload] ❌ File MIME type validation error', {
            deviceId: id,
            error: validationErr.message,
            stack: validationErr.stack
          });
          
          // Очищаем файлы при ошибке валидации
          cleanupOnAbort();
          
          return res.status(500).json({ error: 'Ошибка валидации файлов' });
        }
      }
      
      const uploaded = (req.files || []).map(f => {
        // Сохраняем пути для возможной очистки
        if (f.path) {
          uploadedFiles.push(f.path);
        }
        return f.filename;
      });

      for (const safeName of uploaded) {
        markFileAsPreProcessing(id, safeName);
      }

      const folderName = req.body.folderName; // Имя папки если загружается через выбор папки

      logger.debug('[Upload] Files uploaded', {
        deviceId: id,
        filesCount: uploaded.length,
        uploaded,
        folderName: folderName || null
      });

      // КРИТИЧНО: Отправляем ответ СРАЗУ после сохранения файлов multer
      // Все дальнейшие обработки выполняются в фоне
      // НЕ прерываем обработку если клиент закрыл соединение - файлы уже сохранены!
      
      // Отправляем ответ СРАЗУ (не ждём обработки)
      if (!res.headersSent) {
        try {
          res.json({ ok: true, files: [], uploaded });
          logger.debug('[Upload] Response sent immediately after file save (all processing in background)', { 
            deviceId: id, 
            filesCount: uploaded.length 
          });
        } catch (sendErr) {
          // Если не удалось отправить ответ (клиент закрыл соединение) - это нормально
          // Файлы уже сохранены, продолжаем обработку
          logger.warn('[Upload] Failed to send response (client closed connection), continuing processing', {
            deviceId: id,
            error: sendErr.message
          });
        }
      }
      
      // Обновляем список файлов в фоне (не блокирует ответ)
      Promise.resolve().then(() => {
        updateDeviceFilesFromDB(id, devices, fileNamesMap);
        io.emit('devices/updated');
      }).catch(err => {
        logger.error('[Upload] Error updating device files in background', { error: err.message, deviceId: id });
      });

      // КРИТИЧНО: Все дальнейшие операции в фоне (не блокируют ответ)
      
      // Сохраняем оригинальные имена ДО любых конвертаций (PDF/PPTX используют их сразу)
      if (req.originalFileNames && req.originalFileNames.size > 0) {
        if (!fileNamesMap[id]) fileNamesMap[id] = {};
        for (const [safeName, originalName] of req.originalFileNames) {
          fileNamesMap[id][safeName] = originalName;
        }
        saveFileNamesMap(fileNamesMap);
      }
      
      // ИСПРАВЛЕНО: Перемещаем PDF/PPTX/ZIP в /content/{device}/
      // Только видео/аудио/одиночные изображения остаются в /content/ для дедупликации
      
      // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути (объявляем один раз для всего блока)
      const devicesPath = getDevicesPath();
      
      // Проверяем есть ли PDF/PPTX/ZIP среди загруженных файлов
      // КРИТИЧНО: PDF/PPTX/ZIP обрабатываются через processUploadedStaticContent
      // Они остаются в /content/ и обрабатываются асинхронно
      const staticContentFiles = req.files ? req.files.filter(file => {
        const ext = path.extname(file.filename).toLowerCase();
        const isStatic = ext === '.pdf' || ext === '.pptx' || ext === '.zip';
        if (isStatic) {
          logger.debug(`[upload] 📄 Статический файл обнаружен: ${file.filename} (${ext})`, { 
            deviceId: id, 
            filename: file.filename, 
            originalname: file.originalname,
            ext 
          });
        }
        return isStatic;
      }) : [];
      
      logger.info(`[upload] 📊 Анализ загруженных файлов`, {
        deviceId: id,
        totalFiles: req.files ? req.files.length : 0,
        staticContentFiles: staticContentFiles.length,
        staticFiles: staticContentFiles.map(f => ({ filename: f.filename, originalname: f.originalname, ext: path.extname(f.filename).toLowerCase() }))
      });
      
      // Обрабатываем статический контент в фоне
      if (staticContentFiles.length > 0) {
        logger.info(`[upload] 📦 Найдено статического контента для обработки: ${staticContentFiles.length}`, {
          deviceId: id,
          files: staticContentFiles.map(f => ({ filename: f.filename, originalname: f.originalname }))
        });
        
        Promise.resolve().then(async () => {
          for (const file of staticContentFiles) {
            try {
              const ext = path.extname(file.filename).toLowerCase();
              const sourcePath = path.join(devicesPath, file.filename);  // В /content/
              const originalName = fileNamesMap[id]?.[file.filename] || file.originalname || file.filename;
              
              logger.info(`[upload] 🔄 Начало обработки статического контента: ${file.filename}`, {
                deviceId: id,
                filename: file.filename,
                originalname: file.originalname,
                ext,
                sourcePath,
                exists: fs.existsSync(sourcePath)
              });
              
              if (!fs.existsSync(sourcePath)) {
                logger.warn(`[upload] ⚠️ Статический файл не найден: ${file.filename}`, { 
                  deviceId: id, 
                  filePath: sourcePath,
                  devicesPath,
                  filename: file.filename,
                  originalname: file.originalname
                });
                continue;
              }
              
              let contentType = 'folder';
              if (ext === '.pdf') {
                contentType = 'pdf';
              } else if (ext === '.pptx') {
                contentType = 'pptx';
              } else if (ext === '.zip') {
                contentType = 'folder';
                // Для ZIP сначала распаковываем
                // ZIP файл находится в /content/, но нужно распаковать в /content/{device}/
                // Сначала перемещаем ZIP в папку устройства
                const zipDeviceFolder = path.join(devicesPath, devices[id].folder);
                if (!fs.existsSync(zipDeviceFolder)) {
                  fs.mkdirSync(zipDeviceFolder, { recursive: true });
                }
                const zipTargetPath = path.join(zipDeviceFolder, file.filename);
                if (fs.existsSync(sourcePath) && !fs.existsSync(zipTargetPath)) {
                  fs.renameSync(sourcePath, zipTargetPath);
                  fs.chmodSync(zipTargetPath, 0o644);
                }
                
                const extractResult = await extractZipToFolder(id, file.filename, devices[id].folder);
                if (!extractResult.success) {
                  logger.error(`[upload] ❌ Ошибка распаковки ZIP ${file.filename}`, { 
                    deviceId: id, 
                    fileName: file.filename, 
                    error: extractResult.error 
                  });
                  continue;
                }
                
                // После распаковки обрабатываем папку
                const folderName = extractResult.folderName;
                const folderPath = path.join(zipDeviceFolder, folderName);
                
                if (fs.existsSync(folderPath)) {
                  const originalFolderName = extractResult.originalFolderName || folderName;
                  const result = await processUploadedStaticContent(
                    id,
                    folderName,
                    originalFolderName,
                    folderPath,
                    'folder',
                    {
                      updateDeviceFilesFromDB, // КРИТИЧНО: Передаем функцию для обновления списка файлов
                      devices,
                      fileNamesMap
                    }
                  );
                  
                  if (result.success) {
                    // Сохраняем маппинг
                    if (!fileNamesMap[id]) fileNamesMap[id] = {};
                    fileNamesMap[id][folderName] = originalFolderName;
                    saveFileNamesMap(fileNamesMap);
                    
                    logger.info(`[upload] ✅ Папка обработана: ${folderName} (${result.pagesCount} изображений)`, {
                      deviceId: id,
                      folderName,
                      pagesCount: result.pagesCount
                    });
                    
                    // КРИТИЧНО: Обновляем список файлов устройства из БД (сразу после сохранения метаданных)
                    await new Promise(resolve => setTimeout(resolve, 200)); // Задержка для завершения транзакции БД
                    updateDeviceFilesFromDB(id, devices, fileNamesMap);
                    io.emit('devices/updated');
                    
                    // Проверяем, что папка действительно добавлена в список
                    const device = devices[id];
                    const isInList = device && device.files && device.files.includes(folderName);
                    
                    logger.info(`[upload] 📋 Список файлов обновлен для устройства ${id}`, {
                      deviceId: id,
                      folderName,
                      isInList,
                      totalFiles: device ? device.files.length : 0
                    });
                    
                    if (!isInList) {
                      logger.warn(`[upload] ⚠️ Папка не добавлена в список файлов после обработки`, {
                        deviceId: id,
                        folderName,
                        deviceFiles: device ? device.files : null
                      });
                    }
                  } else {
                    logger.error(`[upload] ❌ Ошибка обработки папки ${folderName}`, {
                      deviceId: id,
                      folderName,
                      error: result.error
                    });
                  }
                }
                
                // Удаляем исходный ZIP файл после распаковки
                // КРИТИЧНО: ZIP уже перемещен в zipTargetPath, проверяем его
                try {
                  if (fs.existsSync(zipTargetPath)) {
                    fs.unlinkSync(zipTargetPath);
                    logger.info(`[upload] 🗑️ Исходный ZIP удален: ${file.filename}`, { deviceId: id });
                  } else if (fs.existsSync(sourcePath)) {
                    // Fallback: если не найден в zipTargetPath, проверяем sourcePath
                    fs.unlinkSync(sourcePath);
                    logger.info(`[upload] 🗑️ Исходный ZIP удален (из sourcePath): ${file.filename}`, { deviceId: id });
                  }
                } catch (delErr) {
                  logger.warn(`[upload] ⚠️ Не удалось удалить ZIP: ${file.filename}`, { error: delErr.message });
                }
                
                continue;
              }
              
              // Для PDF/PPTX: сначала перемещаем в папку устройства, затем обрабатываем
              // КРИТИЧНО: autoConvertFile ожидает файл в /content/{device}/, а не в корне
              const deviceFolder = path.join(devicesPath, devices[id].folder);
              if (!fs.existsSync(deviceFolder)) {
                fs.mkdirSync(deviceFolder, { recursive: true });
              }
              
              const targetPath = path.join(deviceFolder, file.filename);
              
              // Перемещаем файл в папку устройства
              if (fs.existsSync(sourcePath) && !fs.existsSync(targetPath)) {
                fs.renameSync(sourcePath, targetPath);
                fs.chmodSync(targetPath, 0o644);
                logger.info(`[upload] 📄 Файл перемещен в папку устройства: ${file.filename}`, { deviceId: id });
              } else if (!fs.existsSync(targetPath)) {
                // Если файл уже не в sourcePath, возможно он уже перемещен
                logger.warn(`[upload] ⚠️ Файл не найден ни в sourcePath, ни в targetPath: ${file.filename}`, { 
                  deviceId: id, 
                  sourcePath, 
                  targetPath 
                });
                continue;
              }
              
              // Теперь обрабатываем через processUploadedStaticContent
              // (конвертация произойдет внутри функции)
              const result = await processUploadedStaticContent(
                id,
                file.filename,
                originalName,
                targetPath,  // Используем targetPath вместо sourcePath
                contentType,
                {
                  autoConvertFileFn: autoConvertFileWrapper,
                  devices,
                  fileNamesMap,
                  saveFileNamesMapFn: saveFileNamesMap,
                  updateDeviceFilesFromDB, // КРИТИЧНО: Передаем функцию для обновления списка файлов
                  io
                }
              );
              
              if (result.success) {
                logger.info(`[upload] ✅ ${contentType.toUpperCase()} обработан: ${file.filename} (${result.pagesCount} слайдов)`, {
                  deviceId: id,
                  fileName: file.filename,
                  contentType,
                  pagesCount: result.pagesCount
                });
                
                // КРИТИЧНО: Обновляем список файлов устройства из БД (сразу после сохранения метаданных)
                updateDeviceFilesFromDB(id, devices, fileNamesMap);
                
                // Проверяем, что папка действительно добавлена в список
                const device = devices[id];
                const folderName = file.filename.replace(/\.(pdf|pptx)$/i, '');
                const isInList = device && device.files && device.files.includes(folderName);
                
                logger.info(`[upload] 📋 Список файлов обновлен для устройства ${id}`, {
                  deviceId: id,
                  fileName: file.filename,
                  folderName,
                  isInList,
                  totalFiles: device ? device.files.length : 0
                });
                
                if (!isInList) {
                  logger.warn(`[upload] ⚠️ Папка не добавлена в список файлов после обработки`, {
                    deviceId: id,
                    folderName,
                    deviceFiles: device ? device.files : null
                  });
                }
                
                io.emit('devices/updated');
              } else {
                logger.error(`[upload] ❌ Ошибка обработки ${contentType} ${file.filename}`, {
                  deviceId: id,
                  fileName: file.filename,
                  contentType,
                  error: result.error
                });
              }
              
            } catch (err) {
              logger.error(`[upload] ❌ Ошибка обработки статического контента ${file.filename}`, {
                deviceId: id,
                fileName: file.filename,
                error: err.message,
                stack: err.stack
              });
            }
          }
          
          // Обновляем список файлов после обработки всех файлов
          updateDeviceFilesFromDB(id, devices, fileNamesMap);
          
          // Проверяем результат обновления
          const device = devices[id];
          const staticContentInList = device && device.files ? 
            staticContentFiles.map(f => {
              const folderName = f.filename.replace(/\.(pdf|pptx|zip)$/i, '');
              return { filename: f.filename, folderName, inList: device.files.includes(folderName) };
            }) : [];
          
          logger.info(`[upload] ✅ Обработка статического контента завершена для устройства ${id}`, {
            deviceId: id,
            processedFiles: staticContentFiles.length,
            totalFiles: device ? device.files.length : 0,
            staticContentInList
          });
          
          io.emit('devices/updated');
        }).catch(err => {
          logger.error('[upload] ❌ Критическая ошибка обработки статического контента', {
            deviceId: id,
            error: err.message,
            stack: err.stack,
            filesCount: staticContentFiles.length,
            files: staticContentFiles.map(f => f.filename)
          });
        });
      } else {
        logger.debug(`[upload] Нет статического контента для обработки`, {
          deviceId: id,
          totalFiles: req.files ? req.files.length : 0
        });
      }
      
      // КРИТИЧНО: Обработку папок переносим в фон, чтобы не блокировать ответ
      // Если это загрузка папки - создаем в /content/{device}/ (для изображений)
      if (folderName && req.files && req.files.length > 0) {
        // Запускаем обработку папки в фоне (не блокирует ответ)
        Promise.resolve().then(async () => {
          logger.info(`[upload] 📁 Обнаружена загрузка папки: ${folderName}`);
          
          // Создаем безопасное имя папки через транслитерацию
          const safeFolderName = makeSafeFolderName(folderName);
          const devicesPath = getDevicesPath();
          const deviceFolder = path.join(devicesPath, devices[id].folder);
          const targetFolder = path.join(deviceFolder, safeFolderName);
          
          logger.info(`[upload] 📝 Имя папки: "${folderName}" → "${safeFolderName}"`);
          
          if (!fs.existsSync(targetFolder)) {
            fs.mkdirSync(targetFolder, { recursive: true });
            fs.chmodSync(targetFolder, 0o755);
          }
          
          // Перемещаем файлы из /content/ в /content/{device}/{folder}/
          let movedCount = 0;
          let errorCount = 0;
          
          for (const file of req.files) {
            try {
              const devicesPath = getDevicesPath();
              const sourcePath = path.join(devicesPath, file.filename);  // Из /content/
              
              // Получаем оригинальное имя файла из originalname
              let targetFileName = file.originalname;
              if (targetFileName.includes('/')) {
                const parts = targetFileName.split('/');
                targetFileName = parts[parts.length - 1];
              }
              
              const targetPath = path.join(targetFolder, targetFileName);
              
              if (fs.existsSync(targetPath)) {
                logFile('info', `🔄 Файл уже существует, заменяем: ${targetFileName}`, { fileName: targetFileName, deviceId: id });
                fs.unlinkSync(targetPath);
              }
              
              if (!fs.existsSync(sourcePath)) {
                logFile('info', `⚠️ Исходный файл не найден: ${file.filename}`, { fileName: file.filename, deviceId: id });
                
                const devicesPath = getDevicesPath();
                const sharedFile = path.join(devicesPath, targetFileName);
                if (fs.existsSync(sharedFile)) {
                  logFile('info', `🔄 Файл найден в shared storage, копируем: ${targetFileName}`, { fileName: targetFileName, deviceId: id });
                  
                  fs.copyFileSync(sharedFile, targetPath);
                  fs.chmodSync(targetPath, 0o644);
                  logFile('info', `✅ Скопирован из shared: ${targetFileName} -> ${safeFolderName}/${targetFileName}`, { fileName: targetFileName, folderName: safeFolderName, deviceId: id });
                  movedCount++;
                  continue;
                }
                
                logFile('warn', `❌ Файл не найден ни в uploads, ни в shared: ${targetFileName}`, { fileName: targetFileName, deviceId: id });
                errorCount++;
                continue;
              }
              
              fs.renameSync(sourcePath, targetPath);
              fs.chmodSync(targetPath, 0o644);
              logFile('info', `✅ Перемещен: ${file.filename} -> ${safeFolderName}/${targetFileName}`, { fileName: file.filename, folderName: safeFolderName, deviceId: id });
              movedCount++;
            } catch (e) {
              errorCount++;
              logger.error('[upload] ❌ Ошибка перемещения файла в папку', { 
                error: e.message, 
                fileName: file.filename,
                originalName: file.originalname,
                deviceId: id,
                folderName: safeFolderName,
                stack: e.stack
              });
              
              try {
                const devicesPath = getDevicesPath();
                const sourcePath = path.join(devicesPath, file.filename);
                if (fs.existsSync(sourcePath)) {
                  fs.unlinkSync(sourcePath);
                  logFile('info', `🗑️ Удален файл который не удалось переместить: ${file.filename}`, { fileName: file.filename, deviceId: id });
                }
              } catch (cleanupErr) {
                logger.error('[upload] Failed to cleanup unmoved file', { 
                  error: cleanupErr.message,
                  fileName: file.filename,
                  stack: cleanupErr.stack
                });
              }
            }
          }
          
          logFile('info', `📁 Папка создана: ${safeFolderName} (${movedCount}/${req.files.length} файлов перемещено${errorCount > 0 ? `, ${errorCount} ошибок` : ''})`, { folderName: safeFolderName, movedCount, totalFiles: req.files.length, errorCount, deviceId: id });
          
          if (errorCount > 0) {
            logger.warn('[upload] Some files failed to move to folder', { 
              deviceId: id,
              folderName: safeFolderName,
              totalFiles: req.files.length,
              movedFiles: movedCount,
              errorCount
            });
          }
          
          let allExpectedFiles = [];
          if (req.body.expectedFiles) {
            try {
              allExpectedFiles = JSON.parse(req.body.expectedFiles);
              logFile('info', `📋 Frontend передал список ожидаемых файлов: ${allExpectedFiles.length}`, { deviceId: id, folderName: safeFolderName, expectedFilesCount: allExpectedFiles.length });
            } catch (e) {
              logger.warn('[upload] ⚠️ Не удалось распарсить expectedFiles', { error: e.message, deviceId: id, stack: e.stack });
            }
          }
          
          if (allExpectedFiles.length === 0) {
            logFile('info', '⚠️ Frontend не передал expectedFiles, используем req.files', { deviceId: id, folderName: safeFolderName });
            allExpectedFiles = req.files.map(f => {
              let fileName = f.originalname;
              if (fileName.includes('/')) {
                fileName = fileName.split('/').pop();
              }
              return fileName;
            });
          }
          
          const filesInFolder = fs.readdirSync(targetFolder);
          const missingFiles = allExpectedFiles.filter(f => !filesInFolder.includes(f));
          
          logFile('info', `🔍 Проверка папки: ожидалось ${allExpectedFiles.length}, найдено ${filesInFolder.length}, не хватает ${missingFiles.length}`, { deviceId: id, folderName: safeFolderName, expected: allExpectedFiles.length, found: filesInFolder.length, missing: missingFiles.length });
          
          let copiedFromShared = 0;
          const devicesPathForCopy = getDevicesPath();
          for (const missingFile of missingFiles) {
            const sharedPath = path.join(devicesPathForCopy, missingFile);
            if (fs.existsSync(sharedPath)) {
              const targetPath = path.join(targetFolder, missingFile);
              try {
                fs.copyFileSync(sharedPath, targetPath);
                fs.chmodSync(targetPath, 0o644);
                logFile('info', `✅ Скопирован из shared: ${missingFile}`, { fileName: missingFile, deviceId: id, folderName: safeFolderName });
                copiedFromShared++;
              } catch (e) {
                logger.error('[upload] Failed to copy from shared', { 
                  error: e.message,
                  fileName: missingFile,
                  deviceId: id,
                  folderName: safeFolderName,
                  stack: e.stack
                });
              }
            } else {
              logFile('warn', `⚠️ Файл не найден в shared storage: ${missingFile}`, { fileName: missingFile, deviceId: id, folderName: safeFolderName });
            }
          }
          
          const finalCount = fs.readdirSync(targetFolder).length;
          logFile('info', `📁 Папка готова: ${safeFolderName} (${finalCount} файлов${copiedFromShared > 0 ? `, ${copiedFromShared} скопировано из shared` : ''})`, { deviceId: id, folderName: safeFolderName, finalCount, copiedFromShared });
          
          if (!fileNamesMap[id]) fileNamesMap[id] = {};
          fileNamesMap[id][safeFolderName] = folderName;
          saveFileNamesMap(fileNamesMap);

          // Сохраняем метаданные папки в БД (pages_count, file_path, content_type=folder)
          try {
            const processResult = await processUploadedStaticContent(
              id,
              safeFolderName,
              folderName,
              targetFolder,
              'folder'
            );

            if (processResult.success) {
              logFile('info', `✅ Папка сохранена в БД: ${safeFolderName} (${processResult.pagesCount} изображений)`, {
                deviceId: id,
                folderName: safeFolderName,
                pagesCount: processResult.pagesCount,
                targetFolder
              });
            } else {
              logger.error('[upload] ❌ Не удалось сохранить метаданные папки', {
                deviceId: id,
                folderName: safeFolderName,
                error: processResult.error,
                targetFolder
              });
            }
          } catch (err) {
            logger.error('[upload] ❌ Ошибка сохранения метаданных папки', {
              deviceId: id,
              folderName: safeFolderName,
              error: err.message,
              stack: err.stack,
              targetFolder
            });
          }

          updateDeviceFilesFromDB(id, devices, fileNamesMap);
          io.emit('devices/updated');
        }).catch(err => {
          logger.error('[upload] ❌ Ошибка обработки папки в фоне', { 
            error: err.message, 
            deviceId: id, 
            folderName,
            stack: err.stack 
          });
        });
      } else {
        // КРИТИЧНО: Устанавливаем права 644 на загруженные файлы (кроме PDF/PPTX/ZIP - они уже перемещены)
        for (const file of (req.files || [])) {
          const ext = path.extname(file.filename).toLowerCase();
          // Пропускаем PDF/PPTX/ZIP - для них права уже установлены при перемещении
          if (ext === '.pdf' || ext === '.pptx' || ext === '.zip') continue;
          
          try {
            // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
            const devicesPath = getDevicesPath();
            const filePath = path.join(devicesPath, file.filename);  // В /content/
            fs.chmodSync(filePath, 0o644);
            logFile('info', `✅ Права 644 установлены: ${file.filename}`, { fileName: file.filename, deviceId: id });
          } catch (e) {
            logger.warn(`[upload] ⚠️ Не удалось установить права на ${file.filename}`, { error: e.message, fileName: file.filename, deviceId: id, stack: e.stack });
          }
        }
      }
      
      // КРИТИЧНО: НЕ прерываем обработку если файлы уже сохранены multer
      // Клиент может закрыть соединение после получения ответа - это нормально
      // Файлы уже на диске, нужно их обработать и сохранить в БД
      if (isAborted && (!req.files || req.files.length === 0)) {
        logger.warn('[Upload] Upload was aborted before files were saved, skipping file processing', { deviceId: id });
        return;
      }
      
      // КРИТИЧНО: Если файлы сохранены, но клиент закрыл соединение - продолжаем обработку
      // Сбрасываем isAborted чтобы код продолжил выполнение
      if (isAborted && req.files && req.files.length > 0) {
        logger.warn('[Upload] Client closed connection but files are saved, continuing processing', {
          deviceId: id,
          filesCount: req.files.length
        });
        // Сбрасываем флаг чтобы продолжить обработку
        isAborted = false;
      }
      
      // Обрабатываем файлы ТОЛЬКО если это не прямая загрузка папки
      if (!folderName) {
        for (const fileName of uploaded) {
          const ext = path.extname(fileName).toLowerCase();
          if (ext === '.pdf' || ext === '.pptx') {
            autoConvertFileWrapper(id, fileName).catch(() => {});
          }
        // Автоматическая обработка ZIP архивов с изображениями
        else if (ext === '.zip') {
          // ZIP файл должен быть в папке устройства
          const devicesPath = getDevicesPath();
          const deviceFolder = path.join(devicesPath, devices[id].folder);
          const zipPath = path.join(deviceFolder, fileName);
          
          if (!fs.existsSync(zipPath)) {
            logger.warn(`[upload] ⚠️ ZIP файл не найден в папке устройства: ${zipPath}`, { deviceId: id, fileName });
            continue;
          }
          
          extractZipToFolder(id, fileName, devices[id].folder).then(async (result) => {
            if (result.success) {
              logFile('info', `📦 ZIP распакован: ${fileName} -> ${result.folderName}/ (${result.imagesCount} изображений)`, { fileName, deviceId: id, folderName: result.folderName, imagesCount: result.imagesCount });
              
              // Обрабатываем папку через processUploadedStaticContent
              const folderPath = path.join(deviceFolder, result.folderName);
              if (fs.existsSync(folderPath)) {
                const originalFolderName = result.originalFolderName || result.folderName;
                const processResult = await processUploadedStaticContent(
                  id,
                  result.folderName,
                  originalFolderName,
                  folderPath,
                  'folder'
                );
                
                if (processResult.success) {
                  // Сохраняем маппинг
                  if (!fileNamesMap[id]) fileNamesMap[id] = {};
                  fileNamesMap[id][result.folderName] = originalFolderName;
                  saveFileNamesMap(fileNamesMap);
                  
                  logFile('info', `✅ Папка обработана и сохранена в БД: ${result.folderName} (${processResult.pagesCount} изображений)`, {
                    deviceId: id,
                    folderName: result.folderName,
                    pagesCount: processResult.pagesCount
                  });
                } else {
                  logger.error(`[upload] ❌ Ошибка обработки папки ${result.folderName}`, {
                    deviceId: id,
                    folderName: result.folderName,
                    error: processResult.error
                  });
                }
              }
              
              // Обновляем список файлов после распаковки
              updateDeviceFilesFromDB(id, devices, fileNamesMap);
              io.emit('devices/updated');
            } else {
              logger.error(`[upload] ❌ Ошибка распаковки ZIP ${fileName}`, { fileName, deviceId: id, error: result.error });
            }
          }).catch(err => {
            logger.error(`[upload] ❌ Ошибка обработки ZIP ${fileName}`, { fileName, deviceId: id, error: err.message, stack: err.stack });
          });
        }
          // УДАЛЕНО: Автоматическая оптимизация переносится ПОСЛЕ сохранения метаданных
        }
      }
      
      // ИСПРАВЛЕНО: Отправляем ответ СРАЗУ, обработку метаданных и audit log запускаем в фоне
      // НЕ прерываем обработку если файлы уже сохранены
      // Audit log в фоне (не блокирует ответ)
      if (uploaded.length > 0) {
        auditLog({
          userId: req.user?.id || null,
          action: AuditAction.FILE_UPLOAD,
          resource: `device:${id}`,
          details: { 
            deviceId: id, 
            filesCount: uploaded.length,
            files: uploaded,
            folderName: folderName || null,
            uploadedBy: req.user?.username || 'anonymous'
          },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          status: 'success'
        }).catch(err => {
          logger.error('[Upload] Audit log failed', { error: err.message, deviceId: id });
        });
        
        logFile('info', 'Files uploaded', { 
          deviceId: id, 
          filesCount: uploaded.length, 
          folderName: folderName || null,
          uploadedBy: req.user?.username || 'anonymous'
        });
        
        // ИСПРАВЛЕНО: Отправляем ответ СРАЗУ, обработку метаданных запускаем в фоне
        // Обрабатываем только обычные файлы (не папки, не PDF/PPTX/ZIP)
        if (!folderName) {
          // Фильтруем файлы: только видео/аудио/изображения (не PDF/PPTX/ZIP)
          const filesToProcess = (req.files || []).filter(file => {
            const ext = path.extname(file.filename).toLowerCase();
            return ext !== '.pdf' && ext !== '.pptx' && ext !== '.zip';
          });
          
          // КРИТИЧНО: Логируем если файлов для обработки нет
          if (filesToProcess.length === 0) {
            logger.debug('[Upload] No files to process metadata (all filtered out or folder upload)', {
              deviceId: id,
              totalFiles: (req.files || []).length,
              folderName: folderName || null
            });
          }
          
          // Запускаем обработку метаданных в ФОНОВОМ режиме (без await)
          if (filesToProcess.length > 0) {
            const devicesPath = getDevicesPath();
            
            logger.debug('[Upload] Starting metadata processing for uploaded files', {
              deviceId: id,
              filesCount: filesToProcess.length,
              devicesPath,
              files: filesToProcess.map(f => ({
                filename: f.filename,
                originalname: f.originalname,
                path: f.path,
                size: f.size,
                hasPath: !!f.path
              }))
            });
            
            // Дополнительное логирование в файл
            logFile('info', '🚀 Starting metadata processing for uploaded files', {
              deviceId: id,
              filesCount: filesToProcess.length,
              devicesPath,
              files: filesToProcess.map(f => ({
                filename: f.filename,
                originalname: f.originalname,
                path: f.path,
                size: f.size
              }))
            });
            
            processUploadedFilesAsync(id, filesToProcess, devicesPath, fileNamesMap)
              .then(() => {
                logger.warn('[Upload] ✅ File metadata processed successfully', { 
                  deviceId: id, 
                  filesCount: filesToProcess.length 
                });
                logFile('info', '✅ File metadata processed successfully', { 
                  deviceId: id, 
                  filesCount: filesToProcess.length 
                });
                // Обновляем список файлов после обработки метаданных
                updateDeviceFilesFromDB(id, devices, fileNamesMap);
                io.emit('devices/updated');
                
                // Автоматическая оптимизация видео в фоне (после обработки метаданных)
          for (const fileName of uploaded) {
            const ext = path.extname(fileName).toLowerCase();
            if (['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi'].includes(ext)) {
                    autoOptimizeVideoWrapper(id, fileName)
                      .then(result => {
                if (result.success) {
                  logFile('info', 'Video processed', { 
                    deviceId: id, 
                    fileName, 
                    optimized: result.optimized 
                  });
                          updateDeviceFilesFromDB(id, devices, fileNamesMap);
                          io.emit('devices/updated');
                }
                      })
                      .catch(err => {
                logger.error('Video optimization failed', { 
                  error: err.message, 
                  deviceId: id, 
                  fileName 
                });
              });
            }
          }
              })
              .catch(err => {
                logger.error('[Upload] ❌ Metadata processing failed', { 
                  error: err.message,
                  stack: err.stack,
                  deviceId: id,
                  filesCount: filesToProcess.length
                });
              });
          }
        }
      }
      
      // КРИТИЧНО: Ответ уже отправлен на строке 751, все обработки выполняются в фоне
      // Обновляем список файлов в фоне после обработки
      if (!isAborted) {
        updateDeviceFilesFromDB(id, devices, fileNamesMap);
        io.emit('devices/updated');
      }
    });
  });
  
  // POST /api/devices/:targetId/copy-file - Копирование/перемещение файла между устройствами
  // НОВОЕ: Мгновенное копирование через БД для файлов, физическое для папок
  router.post('/:targetId/copy-file', async (req, res) => {
    const targetId = sanitizeDeviceId(req.params.targetId);
    const { sourceDeviceId, fileName, move } = req.body;
    const sourceId = sanitizeDeviceId(sourceDeviceId);
    
    if (!targetId || !sourceId) {
      return res.status(400).json({ error: 'Неверные ID устройств' });
    }
    
    if (!devices[targetId] || !devices[sourceId]) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    if (!fileName) {
      return res.status(400).json({ error: 'Требуется имя файла' });
    }
    
    try {
      // Проверяем это файл или папка
      // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
      const devicesPath = getDevicesPath();
      const sourceFolder = path.join(devicesPath, devices[sourceId].folder);
      const sourcePath = path.join(sourceFolder, fileName);
      
      // Если это папка (PPTX/PDF/изображения) - используем физическое копирование
      if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
        return await copyFolderPhysically(sourceId, targetId, fileName, move, devices, fileNamesMap, saveFileNamesMap, io, res);
    } 
      
      // 1. Получаем метаданные файла из источника (обычный файл)
      const sourceMetadata = getFileMetadata(sourceId, fileName);
      
      if (!sourceMetadata) {
        return res.status(404).json({ error: 'Исходный файл не найден в базе данных' });
    }
    
      if (sourceMetadata.content_type === 'streaming') {
        let targetSafeNameStreaming = fileName;
        const existingStream = getFileMetadata(targetId, targetSafeNameStreaming);
        if (existingStream) {
          const ext = path.extname(fileName);
          const nameBase = path.basename(fileName, ext);
          const suffix = '_' + crypto.randomBytes(3).toString('hex');
          targetSafeNameStreaming = `${nameBase}${suffix}${ext}`;
        }

        const streamUrl = sourceMetadata.stream_url || sourceMetadata.file_path;
        if (!streamUrl) {
          return res.status(400).json({ error: 'Неверные метаданные стрима' });
        }

        const targetOriginalNameStreaming = sourceMetadata.original_name || fileNamesMap[sourceId]?.[fileName] || fileName;
        const sourceProtocol = normalizeStreamProtocol(sourceMetadata.stream_protocol, streamUrl, sourceMetadata.mime_type);

        createStreamingEntry({
          deviceId: targetId,
          safeName: targetSafeNameStreaming,
          originalName: targetOriginalNameStreaming,
          streamUrl,
          protocol: sourceProtocol
        });

        if (!fileNamesMap[targetId]) fileNamesMap[targetId] = {};
        fileNamesMap[targetId][targetSafeNameStreaming] = targetOriginalNameStreaming;
        saveFileNamesMap(fileNamesMap);
<<<<<<< HEAD
=======
        const newMeta = getFileMetadata(targetId, targetSafeNameStreaming);
        if (newMeta && shouldProxyStreamProtocol(sourceProtocol)) {
          upsertStreamJob(newMeta);
        }

>>>>>>> 76d29d0af24a9d06f52ca3c5612c50a10cc64ed0
        if (move) {
          deleteFileMetadata(sourceId, fileName);
          removeStreamJob(sourceId, fileName, 'moved');
          if (fileNamesMap[sourceId] && fileNamesMap[sourceId][fileName]) {
            delete fileNamesMap[sourceId][fileName];
            if (Object.keys(fileNamesMap[sourceId]).length === 0) {
              delete fileNamesMap[sourceId];
            }
            saveFileNamesMap(fileNamesMap);
          }
        }

        updateDeviceFilesFromDB(targetId, devices, fileNamesMap);
        if (move) {
          updateDeviceFilesFromDB(sourceId, devices, fileNamesMap);
        }
        io.emit('devices/updated');

        return res.json({
          ok: true,
          action: move ? 'moved' : 'copied',
          file: fileName,
          from: sourceId,
          to: targetId,
          instant: true,
          type: 'streaming',
          streamProtocol: sourceProtocol
        });
      }

      logFile('info', '📋 Copying file metadata', {
        sourceDevice: sourceId,
        targetDevice: targetId,
        fileName,
        filePath: sourceMetadata.file_path,
        md5: sourceMetadata.md5_hash?.substring(0, 12)
      });
      
      // 2. Проверяем не существует ли уже на целевом устройстве
      let targetSafeName = fileName;
      const existingOnTarget = getFileMetadata(targetId, fileName);
      
      if (existingOnTarget) {
        // Если файл существует - генерируем уникальное имя (как в Multer)
        const ext = path.extname(fileName);
        const name = path.basename(fileName, ext);
        const suffix = '_' + crypto.randomBytes(3).toString('hex');
        targetSafeName = `${name}${suffix}${ext}`;
        
        logFile('info', '⚠️ File exists on target, using unique name', {
          original: fileName,
          unique: targetSafeName
        });
        }
        
      // 3. ⚡ МГНОВЕННОЕ КОПИРОВАНИЕ: просто INSERT метаданных с тем же file_path!
      // КРИТИЧНО: Определяем правильное original_name - приоритет у original_name из БД (обновляется при переименовании)
      // Если в БД нет или оно не актуально - проверяем fileNamesMap
      let targetOriginalName = fileName;
      if (sourceMetadata.original_name) {
        // Используем из метаданных БД (самый надежный источник, обновляется при переименовании)
        targetOriginalName = sourceMetadata.original_name;
      } else if (fileNamesMap[sourceId] && fileNamesMap[sourceId][fileName]) {
        // Fallback: используем из fileNamesMap если в БД нет
        targetOriginalName = fileNamesMap[sourceId][fileName];
      }
      
      saveFileMetadata({
        deviceId: targetId,
        safeName: targetSafeName,
        originalName: targetOriginalName,
        filePath: sourceMetadata.file_path,  // ✅ ТОТ ЖЕ физический файл!
        fileSize: sourceMetadata.file_size,
        md5Hash: sourceMetadata.md5_hash,
        partialMd5: sourceMetadata.partial_md5,
        mimeType: sourceMetadata.mime_type,
        videoParams: {
          width: sourceMetadata.video_width,
          height: sourceMetadata.video_height,
          duration: sourceMetadata.video_duration,
          codec: sourceMetadata.video_codec,
          bitrate: sourceMetadata.video_bitrate
        },
        audioParams: {
          codec: sourceMetadata.audio_codec,
          bitrate: sourceMetadata.audio_bitrate,
          channels: sourceMetadata.audio_channels
        },
        fileMtime: sourceMetadata.file_mtime
      });
      
      // 4. КРИТИЧНО: Обновляем fileNamesMap для нового устройства, чтобы отображение работало правильно
      if (!fileNamesMap[targetId]) fileNamesMap[targetId] = {};
      fileNamesMap[targetId][targetSafeName] = targetOriginalName;
      saveFileNamesMap(fileNamesMap);
      
      // 5. Если move - удаляем из источника (только из БД!)
      if (move) {
        deleteFileMetadata(sourceId, fileName);
        
        if (fileNamesMap[sourceId] && fileNamesMap[sourceId][fileName]) {
          delete fileNamesMap[sourceId][fileName];
          if (Object.keys(fileNamesMap[sourceId]).length === 0) {
            delete fileNamesMap[sourceId];
          }
          saveFileNamesMap(fileNamesMap);
        }
        
        logFile('info', '🔄 File moved (metadata only)', {
          from: sourceId,
          to: targetId,
          fileName
        });
      }
      
      // 6. Обновляем devices.files из БД
      updateDeviceFilesFromDB(targetId, devices, fileNamesMap);
      if (move) {
        updateDeviceFilesFromDB(sourceId, devices, fileNamesMap);
      }
      
      io.emit('devices/updated');
      
      logFile('info', `✅ File ${move ? 'moved' : 'copied'} instantly via DB`, {
        sourceDevice: sourceId,
        targetDevice: targetId,
        fileName,
        sharedFilePath: sourceMetadata.file_path,
        timeTaken: '<1ms'
      });
      
      res.json({ 
        ok: true, 
        action: move ? 'moved' : 'copied', 
        file: fileName, 
        from: sourceId, 
        to: targetId,
        instant: true  // Мгновенное копирование!
      });
      
    } catch (e) {
      logger.error('[copy-file] Error', { 
        error: e.message, 
        sourceId, 
        targetId, 
        fileName 
      });
      return res.status(500).json({ error: 'Ошибка копирования/перемещения', detail: e.message });
    }
  });
  
  // POST /api/devices/:id/files/:name/rename - Переименование файла или папки
  router.post('/:id/files/:name/rename', express.json(), (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }
    
    const oldName = req.params.name;
    const { newName } = req.body;
    
    if (!newName) {
      return res.status(400).json({ error: 'Требуется новое имя' });
    }
    
    const d = devices[id];
    if (!d) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
    const devicesPath = getDevicesPath();
    const deviceFolder = path.join(devicesPath, d.folder);
    
    // НОВОЕ: Проверяем, это медиафайл с metadata в БД?
    const metadata = getFileMetadata(id, oldName);
    if (metadata) {
      // Медиафайл - обновляем только original_name в БД, физический файл НЕ трогаем
      logFile('info', `📝 Обновление originalName в БД: ${oldName} -> ${newName}`, { deviceId: id, oldName, newName });
      updateFileOriginalName(id, oldName, newName);
      
      // КРИТИЧНО: Также обновляем fileNamesMap чтобы при копировании использовалось правильное имя
      if (!fileNamesMap[id]) fileNamesMap[id] = {};
      fileNamesMap[id][oldName] = newName; // safe_name -> original_name (переименованное)
      saveFileNamesMap(fileNamesMap);
      
      logFile('info', `📝 Обновлен fileNamesMap: ${oldName} -> ${newName}`, { deviceId: id, oldName, newName });
      
      // КРИТИЧНО: Если переименованный файл был текущим воспроизводимым - обновляем состояние
      if (devices[id] && devices[id].current && devices[id].current.file === oldName) {
        logger.info(`[RENAME file] Обновляем состояние устройства ${id}, т.к. переименован текущий файл ${oldName} -> ${newName}`);
        devices[id].current.file = newName;
        // Отправляем обновленное состояние на устройство
        io.to(`device:${id}`).emit('player/state', devices[id].current);
      }
      
      // Обновляем список файлов из БД
      updateDeviceFilesFromDB(id, devices, fileNamesMap);
      io.emit('devices/updated');
      return res.json({ success: true, oldName, newName, message: 'File renamed successfully (display name only)' });
    }
    
    // Старая логика для PDF/PPTX/папок - физическое переименование
    let oldPath = path.join(deviceFolder, oldName);
    let isFolder = false;
    let actualOldName = oldName;
    
    // Проверяем, может это PDF/PPTX файл с папкой
    const folderNamePdf = oldName.replace(/\.(pdf|pptx)$/i, '');
    const possiblePdfFolder = path.join(deviceFolder, folderNamePdf);
    
    if (fs.existsSync(possiblePdfFolder) && fs.statSync(possiblePdfFolder).isDirectory()) {
      // Это PDF/PPTX с папкой - переименовываем папку
      oldPath = possiblePdfFolder;
      isFolder = true;
      actualOldName = folderNamePdf;
      logFile('info', `📁 Переименование папки PDF/PPTX: ${folderNamePdf}`, { deviceId: id, oldName, folderNamePdf });
    } 
    // Проверяем, может это папка с изображениями (без расширения)
    else if (!oldName.includes('.')) {
      const folderPath = path.join(deviceFolder, oldName);
      if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
        oldPath = folderPath;
        isFolder = true;
        actualOldName = oldName;
        logFile('info', `📁 Переименование папки с изображениями: ${oldName}`, { deviceId: id, oldName });
      }
    }
    
    if (!fs.existsSync(oldPath)) {
      logFile('error', `❌ Не найден: ${oldPath}`, { deviceId: id, oldName, oldPath });
      return res.status(404).json({ error: 'Файл не найден', path: oldPath });
    }
    
    // Определяем новый путь
    let newPath;
    if (isFolder) {
      // Для папок используем новое имя без расширения
      const newFolderName = newName.replace(/\.(pdf|pptx)$/i, '');
      newPath = path.join(deviceFolder, newFolderName);
    } else {
      newPath = path.join(deviceFolder, newName);
    }
    
    if (fs.existsSync(newPath) && oldPath !== newPath) {
      return res.status(409).json({ error: 'Файл с таким именем уже существует' });
    }
    
    try {
      logFile('info', `🔄 ${oldPath} -> ${newPath}`, { deviceId: id, oldName, newName, oldPath, newPath });
      fs.renameSync(oldPath, newPath);
      
      // Обновляем маппинг имен
      if (!fileNamesMap[id]) fileNamesMap[id] = {};
      
      // Удаляем старое имя из маппинга
      if (fileNamesMap[id][actualOldName]) {
        delete fileNamesMap[id][actualOldName];
      }
      // Для PDF/PPTX также удаляем маппинг файла
      if (isFolder && oldName.match(/\.(pdf|pptx)$/i)) {
        if (fileNamesMap[id][oldName]) {
          delete fileNamesMap[id][oldName];
        }
      }
      
      // Добавляем новое имя в маппинг
      const finalName = isFolder ? path.basename(newPath) : newName;
      fileNamesMap[id][finalName] = newName;
      
      // Для PDF/PPTX папки также добавляем маппинг для файла с расширением
      if (isFolder) {
        const pdfExt = oldName.match(/\.(pdf|pptx)$/i);
        if (pdfExt) {
          const newFileWithExt = newName;
          fileNamesMap[id][newFileWithExt] = newName;
        }
      }
      
      saveFileNamesMap(fileNamesMap);
      
      // КРИТИЧНО: НЕ пересканируем всё устройство!
      // scanDeviceFiles вернёт ТОЛЬКО файлы на диске (PDF/PPTX/папки)
      // и ПОТЕРЯЕТ медиафайлы из БД!
      
      // Вместо этого обновляем только конкретные записи в d.files и d.fileNames
      // КРИТИЧНО: Если переименованный файл был текущим воспроизводимым - обновляем состояние
      if (devices[id] && devices[id].current && 
          (devices[id].current.file === oldName || devices[id].current.file === actualOldName)) {
        logger.info(`[RENAME file] Обновляем состояние устройства ${id}, т.к. переименован текущий файл ${actualOldName} -> ${finalName}`);
        devices[id].current.file = finalName;
        // Отправляем обновленное состояние на устройство
        io.to(`device:${id}`).emit('player/state', devices[id].current);
      }
      
      // Обновляем список файлов из БД + файловой системы (это перезагрузит весь список)
      updateDeviceFilesFromDB(id, devices, fileNamesMap);
      io.emit('devices/updated');
      res.json({ success: true, oldName: actualOldName, newName: finalName });
    } catch (e) {
      logger.error('[rename] Ошибка', { error: e.message, stack: e.stack, deviceId: id, oldName, newName, oldPath, newPath });
      res.status(500).json({ error: 'Ошибка переименования', details: e.message });
    }
  });

  // GET /api/devices/:id/files/:name/download - Скачать файл или папку
  // Папки скачиваются как ZIP архив
  router.get('/:id/files/:name/download', readLimiter, requireSpeaker[0], requireSpeaker[1], async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);

    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }

    if (!hasDeviceAccess(req.user.userId, id, req.user.role)) {
      return res.status(403).json({ error: 'Доступ к устройству запрещен' });
    }

    const rawName = String(req.params.name || '').trim();
    const sanitizedRequestedName = sanitizeFilename(rawName);
    if (
      !rawName ||
      rawName.includes('\0') ||
      rawName.includes('..') ||
      /[\\/]/.test(rawName) ||
      !sanitizedRequestedName ||
      sanitizedRequestedName !== rawName
    ) {
      return res.status(400).json({ error: 'Неверное имя файла' });
    }
    const name = sanitizedRequestedName;

    const d = devices[id];
    if (!d) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }

    const rawDeviceFolderName = String(d.folder || id || '').trim();
    const safeDeviceFolderName = sanitizeDeviceId(rawDeviceFolderName);
    if (!safeDeviceFolderName) {
      return res.status(400).json({ error: 'Неверный путь устройства' });
    }

    const appRoot = path.resolve(ROOT);
    const mountRoot = path.resolve('/mnt');
    const devicesPath = path.resolve(getDevicesPath());

    let devicesBaseDir = null;
    if (devicesPath === appRoot || devicesPath.startsWith(appRoot + path.sep)) {
      devicesBaseDir = appRoot;
    } else if (devicesPath === mountRoot || devicesPath.startsWith(mountRoot + path.sep)) {
      devicesBaseDir = mountRoot;
    }

    if (!devicesBaseDir) {
      return res.status(400).json({ error: 'Неверный корневой путь контента' });
    }

    let safeDevicesPath;
    try {
      safeDevicesPath = validatePath(devicesPath, devicesBaseDir);
    } catch (error) {
      return res.status(400).json({ error: 'Неверный корневой путь контента' });
    }

    let deviceFolder = null;
    try {
      const resolvedDeviceFolder = validatePath(path.resolve(safeDevicesPath, safeDeviceFolderName), safeDevicesPath);
      deviceFolder = validatePath(fs.realpathSync(resolvedDeviceFolder), safeDevicesPath);
    } catch (error) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }

    const metadata = getFileMetadata(id, name);

    if (metadata?.content_type === 'streaming') {
      return res.status(400).json({ error: 'Стримы нельзя скачать как файл' });
    }

    let entries = [];
    try {
      const safeFolderForRead = validatePath(deviceFolder, safeDevicesPath);
      entries = fs.readdirSync(safeFolderForRead, { withFileTypes: true });
    } catch (error) {
      logger.error('[download] Failed to read device folder', {
        deviceId: id,
        deviceFolder,
        error: error.message
      });
      return res.status(500).json({ error: 'Не удалось прочитать содержимое устройства' });
    }

    const allowedDownloadPaths = new Map();
    for (const entry of entries) {
      if (!entry || (!entry.isFile() && !entry.isDirectory())) {
        continue;
      }

      const safeEntryName = sanitizeFilename(String(entry.name || '').trim());
      if (!safeEntryName || safeEntryName !== entry.name) {
        continue;
      }

      try {
        const resolvedEntryPath = validatePath(path.resolve(deviceFolder, safeEntryName), deviceFolder);
        const entryRealPath = validatePath(fs.realpathSync(resolvedEntryPath), deviceFolder);
        allowedDownloadPaths.set(entry.name, entryRealPath);
      } catch (error) {
        continue;
      }
    }

    const folderCandidateName = name.replace(/\.(pdf|pptx|zip)$/i, '');
    const targetPath = allowedDownloadPaths.get(name) || allowedDownloadPaths.get(folderCandidateName);

    if (!targetPath) {
      return res.status(404).json({ error: 'Файл или папка не найдены' });
    }

    let safeTargetPath;
    let safeDeviceRoot;
    try {
      safeDeviceRoot = validatePath(fs.realpathSync(deviceFolder), safeDevicesPath);
      safeTargetPath = validatePath(fs.realpathSync(targetPath), safeDeviceRoot);
    } catch (error) {
      return res.status(404).json({ error: 'Файл или папка не найдены' });
    }

    if (!safeTargetPath.startsWith(safeDeviceRoot + path.sep) && safeTargetPath !== safeDeviceRoot) {
      return res.status(400).json({ error: 'Неверный путь к файлу' });
    }

    let downloadTargetPath;
    try {
      downloadTargetPath = validatePath(safeTargetPath, safeDeviceRoot);
    } catch (error) {
      return res.status(400).json({ error: 'Неверный путь к файлу' });
    }

    let stat;
    try {
      stat = fs.statSync(downloadTargetPath);
    } catch (error) {
      logger.error('[download] Failed to stat target', {
        deviceId: id,
        name,
        targetPath: safeTargetPath,
        error: error.message
      });
      return res.status(500).json({ error: 'Не удалось получить информацию о файле' });
    }

    if (stat.isDirectory()) {
      const originalName = metadata?.original_name || name.replace(/\.(zip|pdf|pptx)$/i, '') || path.basename(safeTargetPath);
      const zipName = safeDownloadFileName(
        /\.zip$/i.test(originalName) ? originalName : `${originalName}.zip`,
        `${path.basename(downloadTargetPath)}.zip`
      );

      let tempDirPath = null;

      const cleanupTemp = () => {
        if (!tempDirPath) return;
        fs.rm(tempDirPath, { recursive: true, force: true }, () => {});
        tempDirPath = null;
      };

      try {
        tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'videocontrol-download-'));
        const zipPath = path.join(tempDirPath, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.zip`);

          await createZipArchiveFromFolder(downloadTargetPath, zipPath);

        res.setHeader('X-Download-Filename', zipName);
        return res.download(zipPath, zipName, (error) => {
          cleanupTemp();
          if (!error) return;

          logger.error('[download] Failed to send ZIP archive', {
            deviceId: id,
            name,
              targetPath: downloadTargetPath,
            zipName,
            error: error.message
          });

          if (!res.headersSent) {
            res.status(500).json({ error: 'Ошибка передачи ZIP архива' });
          }
        });
      } catch (error) {
        cleanupTemp();
        logger.error('[download] Failed to create ZIP archive', {
          deviceId: id,
          name,
            targetPath: downloadTargetPath,
          error: error.message
        });
        return res.status(500).json({ error: 'Не удалось создать ZIP архив' });
      }
    }

    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Поддерживается скачивание только файлов и папок' });
    }

    const resolvedBaseName = path.basename(downloadTargetPath);
    const metadataOriginalName = metadata?.original_name || fileNamesMap[id]?.[name] || resolvedBaseName;
    const ext = path.extname(resolvedBaseName);
    const fileNameForDownload = safeDownloadFileName(
      path.extname(metadataOriginalName) ? metadataOriginalName : `${metadataOriginalName}${ext}`,
        path.basename(downloadTargetPath)
    );

    res.setHeader('X-Download-Filename', fileNameForDownload);
    return res.download(downloadTargetPath, fileNameForDownload, (error) => {
      if (!error) return;

      logger.error('[download] Failed to send file', {
        deviceId: id,
        name,
        targetPath: downloadTargetPath,
        fileNameForDownload,
        error: error.message
      });

      if (!res.headersSent) {
        res.status(500).json({ error: 'Ошибка передачи файла' });
      }
    });
  });
  
  // DELETE /api/devices/:id/files/:name - Удаление файла или папки
  // DELETE /api/devices/:id/files - Полная очистка устройства
  router.delete('/:id/files', deleteLimiter, requireAdmin, async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }
    
    const d = devices[id];
    if (!d) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    // КРИТИЧНО: Используем getDevicesPath() и d.folder для получения правильного пути
    const devicesPath = getDevicesPath();
    if (!devicesPath) {
      logger.error('[clear-device-files] Devices path not configured', { deviceId: id });
      return res.status(500).json({ error: 'Путь к устройствам не настроен' });
    }
    
    const devicePath = path.join(devicesPath, d.folder || id);
    
    try {
      logger.info('[clear-device-files] Начало очистки устройства', { deviceId: id, devicePath });
      
      // Останавливаем все стримы устройства перед очисткой
      const metadata = getDeviceFilesMetadata(id);
      const streamingFiles = metadata.filter(m => m.content_type === 'streaming');
      
      for (const fileMeta of streamingFiles) {
        try {
          logger.info('[clear-device-files] Останавливаем стрим', { deviceId: id, fileName: fileMeta.safe_name });
          removeStreamJob(id, fileMeta.safe_name, 'device_cleared');
        } catch (streamErr) {
          logger.warn('[clear-device-files] Ошибка остановки стрима', { 
            deviceId: id, 
            fileName: fileMeta.safe_name, 
            error: streamErr.message 
          });
        }
      }
      
      // Удаляем каталог устройства полностью (включая заглушки и медиа)
      if (fs.existsSync(devicePath)) {
        logger.info('[clear-device-files] Удаление директории', { deviceId: id, devicePath });
        fs.rmSync(devicePath, { recursive: true, force: true });
      } else {
        logger.warn('[clear-device-files] Директория не существует', { deviceId: id, devicePath });
      }
      
      // Создаем пустую директорию заново
      fs.mkdirSync(devicePath, { recursive: true });
      logger.info('[clear-device-files] Директория создана заново', { deviceId: id, devicePath });
      
      // Очищаем метаданные в БД (используем функцию вместо цикла)
      const deletedCount = deleteDeviceFilesMetadata(id);
      logger.info('[clear-device-files] Метаданные удалены', { deviceId: id, deletedCount });
      
      // Очищаем fileNamesMap и сохраняем
      if (fileNamesMap[id]) {
        fileNamesMap[id] = {};
        saveFileNamesMap();
        logger.info('[clear-device-files] fileNamesMap очищен', { deviceId: id });
      }
      
      // Обновляем кеш устройств/файлов
      updateDeviceFilesFromDB(id, devices, fileNamesMap);
      
      // Сбрасываем текущее состояние воспроизведения устройства
      if (devices[id]) {
        devices[id].current = null;
        devices[id].files = [];
      }
      
      io.emit('devices/updated');
      
      auditLog(req, AuditAction.Delete, `Device ${id} cleared`);
      
      logger.info('[clear-device-files] Очистка завершена успешно', { deviceId: id });
      res.json({ success: true, cleared: true, deletedFiles: deletedCount });
    } catch (e) {
      logger.error('[clear-device-files] Ошибка очистки', { 
        deviceId: id, 
        devicePath,
        error: e.message, 
        stack: e.stack 
      });
      res.status(500).json({ 
        error: 'Ошибка очистки устройства', 
        details: process.env.NODE_ENV === 'development' ? e.message : undefined
      });
    }
  });

  router.delete('/:id/files/:name', deleteLimiter, async (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }
    
    const name = req.params.name;
    const d = devices[id];
    
    if (!d) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
    const devicesPath = getDevicesPath();
    const deviceFolder = path.join(devicesPath, d.folder);
    
    // ЗАЩИТА: Простая проверка path traversal
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) {
      // Логируем подозрительную активность
      await auditLog({
        userId: req.user?.id || null,
        action: AuditAction.PATH_TRAVERSAL_ATTEMPT,
        resource: `device:${id}`,
        details: { attemptedPath: name, deviceId: id },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        status: 'failure'
      });
      logSecurity('warn', 'Path traversal attempt detected on file delete', { 
        deviceId: id, 
        attemptedPath: name, 
        ip: req.ip 
      });
      return res.status(400).json({ error: 'Неверный путь к файлу' });
    }
    
    const existingMetadata = getFileMetadata(id, name);
    if (existingMetadata && existingMetadata.content_type === 'streaming') {
      // КРИТИЧНО: Останавливаем FFmpeg перед удалением из БД
      try {
        removeStreamJob(id, name, 'deleted');
      } catch (err) {
        // Логируем ошибку, но продолжаем удаление
        logger.warn('[DELETE file] Failed to stop stream job', { 
          deviceId: id, 
          fileName: name, 
          error: err.message 
        });
      }
      
      // Удаляем из БД
      try {
        deleteFileMetadata(id, name);
      } catch (err) {
        logger.error('[DELETE file] Failed to delete stream metadata', { 
          deviceId: id, 
          fileName: name, 
          error: err.message 
        });
        return res.status(500).json({ error: 'Не удалось удалить метаданные стрима' });
      }
      
      // Обновляем fileNamesMap
      if (fileNamesMap[id]?.[name]) {
        delete fileNamesMap[id][name];
        saveFileNamesMap(fileNamesMap);
      }
      
      // Обновляем список файлов устройства
      try {
        updateDeviceFilesFromDB(id, devices, fileNamesMap);
      } catch (err) {
        logger.error('[DELETE file] Failed to update device files', { 
          deviceId: id, 
          fileName: name, 
          error: err.message 
        });
      }
      
      io.emit('devices/updated');
      await auditLog({
        userId: req.user?.id || null,
        action: AuditAction.FILE_DELETE,
        resource: `device:${id}`,
        details: { 
          deviceId: id, 
          fileName: name, 
          isFolder: false,
          deletedBy: req.user?.username || 'anonymous',
          type: 'streaming'
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        status: 'success'
      });
      return res.json({ ok: true });
    }

    const folderName = name.replace(/\.(pdf|pptx)$/i, '');
    const possibleFolder = path.join(deviceFolder, folderName);
    
    let deletedFileName = name;
    let isFolder = false;
    
    // Проверяем PDF/PPTX папку
    if (fs.existsSync(possibleFolder) && fs.statSync(possibleFolder).isDirectory()) {
      try {
        fs.rmSync(possibleFolder, { recursive: true, force: true });
        deletedFileName = folderName;
        isFolder = true;
        logFile('info', `Удалена папка PDF/PPTX: ${folderName}`, { deviceId: id, fileName: name, folderName });
      } catch (e) {
        logger.error(`[DELETE file] Ошибка удаления папки ${folderName}`, { error: e.message, stack: e.stack, deviceId: id, fileName: name, folderName });
        return res.status(500).json({ error: 'Не удалось удалить папку' });
      }
    } 
    // Проверяем папку с изображениями (без расширения)
    else if (!name.includes('.')) {
      const imageFolderPath = path.join(deviceFolder, name);
      if (fs.existsSync(imageFolderPath) && fs.statSync(imageFolderPath).isDirectory()) {
        try {
          fs.rmSync(imageFolderPath, { recursive: true, force: true });
          deletedFileName = name;
          isFolder = true;
          logFile('info', `Удалена папка с изображениями: ${name}`, { deviceId: id, fileName: name });
        } catch (e) {
          logger.error(`[DELETE file] Ошибка удаления папки ${name}`, { error: e.message, stack: e.stack, deviceId: id, fileName: name });
          return res.status(500).json({ error: 'Не удалось удалить папку с изображениями' });
        }
      }
    } else {
      // НОВОЕ: Обычный файл - умное удаление с подсчетом ссылок
      
      // 1. Получаем метаданные из БД
      const metadata = existingMetadata || getFileMetadata(id, name);
      
      if (!metadata) {
        logFile('warn', 'File not found in DB', { deviceId: id, fileName: name });
        return res.status(404).json({ error: 'Файл не найден' });
      }
      
      const physicalPath = metadata.file_path;
      
      // 2. Удаляем запись из БД
      deleteFileMetadata(id, name);
      
      // 3. Подсчитываем сколько еще устройств используют этот файл
      const refCount = countFileReferences(physicalPath);
      
      logFile('info', 'File reference removed', {
        deviceId: id,
        fileName: name,
        physicalPath,
        remainingReferences: refCount
      });
      
      // 4. Если никто не использует - удаляем физический файл
      if (refCount === 0) {
        try {
          if (fs.existsSync(physicalPath)) {
            fs.unlinkSync(physicalPath);
            logFile('info', '🗑️ Physical file deleted (no references)', {
              filePath: physicalPath,
              sizeMB: (metadata.file_size / 1024 / 1024).toFixed(2)
            });
          }
        } catch (e) {
          logger.error('Failed to delete physical file', {
            error: e.message,
            filePath: physicalPath
          });
        }
      } else {
        logFile('info', '✅ Physical file kept (still used)', {
          filePath: physicalPath,
          usedByDevices: refCount
        });
      }
      
      // Очищаем кэш разрешения
      clearResolutionCache(physicalPath);
    }
    
    // Удаляем из маппинга
    if (fileNamesMap[id]) {
      if (fileNamesMap[id][name]) delete fileNamesMap[id][name];
      if (fileNamesMap[id][deletedFileName] && deletedFileName !== name) {
        delete fileNamesMap[id][deletedFileName];
      }
      if (Object.keys(fileNamesMap[id]).length === 0) delete fileNamesMap[id];
      saveFileNamesMap(fileNamesMap);
    }
    
    // КРИТИЧНО: Если удаляемый файл был текущим воспроизводимым - сбрасываем состояние
    if (devices[id] && devices[id].current && devices[id].current.file === deletedFileName) {
      logger.info(`[DELETE file] Сбрасываем состояние устройства ${id}, т.к. удален текущий файл ${deletedFileName}`);
      devices[id].current = { type: 'idle', file: null, state: 'idle' };
      // Отправляем команду остановки на устройство
      io.to(`device:${id}`).emit('player/stop', { reason: 'file_deleted' });
    }
    
    // НОВОЕ: Обновляем список файлов из БД (а не из файловой системы)
    updateDeviceFilesFromDB(id, devices, fileNamesMap);
    io.emit('devices/updated');
    
    // Audit log
    await auditLog({
      userId: req.user?.id || null,
      action: AuditAction.FILE_DELETE,
      resource: `device:${id}`,
      details: { 
        deviceId: id, 
        fileName: deletedFileName, 
        isFolder, 
        deletedBy: req.user?.username || 'anonymous' 
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      status: 'success'
    });
    logFile('info', 'File deleted', { 
      deviceId: id, 
      fileName: deletedFileName, 
      isFolder, 
      deletedBy: req.user?.username || 'anonymous' 
    });
    
    res.json({ ok: true });
  });
  
  // GET /api/devices/:id/files - Получить список файлов устройства
  router.get('/:id/files', (req, res) => {
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }
    
    const d = devices[id];
    if (!d) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }
    
    const files = d.files || [];
    const fileNames = d.fileNames || files;
    // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
    const devicesPath = getDevicesPath();
    const deviceFolderPath = path.join(devicesPath, d.folder || id);
    
    const metadataMap = Array.isArray(d.fileMetadata)
      ? d.fileMetadata.reduce((acc, meta) => {
          if (meta && meta.safeName) {
            acc.set(meta.safeName, meta);
          }
          return acc;
        }, new Map())
      : new Map();
    
    const response = files.map((safeName, index) => {
      const meta = metadataMap.get(safeName);
      return {
        safeName,
        originalName: fileNames[index] || safeName,
        contentType: meta?.contentType || null,
        streamUrl: meta?.streamUrl || null,
        streamProxyUrl: resolveStreamPlaybackUrl(id, safeName, meta)
      };
    });
    
    res.json(response);
  });
  
  // GET /api/devices/:id/files-with-status - Получить список файлов со статусами
  router.get('/:id/files-with-status', readLimiter, requireSpeaker[0], requireSpeaker[1], async (req, res) => {
    const readyOnly = req.query.readyOnly === '1' || req.query.readyOnly === 'true';
    const id = sanitizeDeviceId(req.params.id);
    
    if (!id) {
      return res.status(400).json({ error: 'Неверный ID устройства' });
    }

    if (!hasDeviceAccess(req.user.userId, id, req.user.role)) {
      return res.status(403).json({ error: 'Доступ к устройству запрещен' });
    }
    
    const d = devices[id];
    if (!d) {
      return res.status(404).json({ error: 'Устройство не найдено' });
    }

    // Fallback: если список файлов пуст или не инициализирован (после перезапуска), подтягиваем из БД
    if (!d.files || d.files.length === 0) {
      try {
        updateDeviceFilesFromDB(id, devices, fileNamesMap);
      } catch (e) {
        logger.warn('[files-with-status] Failed to refresh files from DB', { deviceId: id, error: e.message });
      }
    }
    
    const files = d.files || [];
    const fileNames = d.fileNames || files;
    
    // КРИТИЧНО: Логируем для отладки
    logger.debug('[files-with-status] Getting files for device', {
      deviceId: id,
      filesCount: files.length,
      files: files.slice(0, 10), // Первые 10 файлов для отладки
      hasFileMetadata: !!d.fileMetadata,
      fileMetadataCount: d.fileMetadata ? d.fileMetadata.length : 0
    });
    
    const filesData = [];
    
    for (let i = 0; i < files.length; i++) {
      const safeName = files[i];
      
      // КРИТИЧНО: Для папок проверяем статус и по исходному имени файла (PDF/PPTX)
      // Это нужно, так как статус сохраняется с исходным именем файла (например, "file.pdf"),
      // а в списке файлов после конвертации будет имя папки (например, "file")
      let fileStatus = getFileStatus(id, safeName);
      if (!fileStatus || fileStatus.status === 'ready') {
        // Если статус не найден или файл готов, проверяем исходное имя файла (для PDF/PPTX)
        const ext = path.extname(safeName).toLowerCase();
        if (!ext || ext === '' || ext === '.zip') {
          // Это папка, проверяем возможные исходные имена (PDF/PPTX)
          const pdfName = `${safeName}.pdf`;
          const pptxName = `${safeName}.pptx`;
          const pdfStatus = getFileStatus(id, pdfName);
          const pptxStatus = getFileStatus(id, pptxName);
          if (pdfStatus && pdfStatus.status !== 'ready') {
            fileStatus = pdfStatus;
          } else if (pptxStatus && pptxStatus.status !== 'ready') {
            fileStatus = pptxStatus;
          }
        }
      }
      fileStatus = fileStatus || { status: 'ready', progress: 100, canPlay: true };

      if (readyOnly) {
        const state = String(fileStatus.status || '').toLowerCase();
        if (state === 'checking' || state === 'processing' || fileStatus.canPlay === false) {
          continue;
        }
      }
      
      let resolution = null;
      let isPlaceholder = false;
      let durationSeconds = null;
      let folderImageCount = null;
      let contentType = 'file';
      let streamUrl = null;
      let streamProtocol = null;
      let hasTrailer = false;
      let trailerUrl = null;
      
      // Получаем метаданные из БД (разрешение + флаг заглушки + originalName)
      const ext = path.extname(safeName).toLowerCase();
      let metadata = getFileMetadata(id, safeName);
      let needsOptimizationHint = inferNeedsOptimizationFromMetadata(safeName, metadata);
      
      // КРИТИЧНО: originalName берем с правильным приоритетом: metadata.original_name → fileNamesMap → fileNames → safeName
      const nameMap = fileNamesMap[id] || {};
      let originalName;
      if (metadata && metadata.original_name) {
        originalName = metadata.original_name;
      } else if (nameMap[safeName]) {
        originalName = nameMap[safeName];
      } else {
        originalName = fileNames[i] || safeName;
      }
      
      if (metadata) {
        // Флаг заглушки
        isPlaceholder = !!metadata.is_placeholder;
        if (metadata.content_type === 'streaming') {
          contentType = 'streaming';
          streamUrl = metadata.stream_url || null;
          streamProtocol = normalizeStreamProtocol(metadata.stream_protocol, metadata.stream_url, metadata.mime_type);
          const streamProxyUrl = resolveStreamPlaybackUrl(id, safeName, metadata);
          filesData.push({
            safeName,
            originalName,
            status: 'ready',
            progress: 100,
            canPlay: true,
            error: null,
            resolution: null,
            isPlaceholder: false,
            durationSeconds: null,
            folderImageCount: null,
            contentType: 'streaming',
            needsOptimization: null,
            streamUrl,
            streamProxyUrl,
            restreamStatus: null,
            streamProtocol,
            hasTrailer: false,
            trailerUrl: null
          });
          continue;
        }
        
        if (metadata.video_duration) {
          durationSeconds = Math.round(metadata.video_duration);
        }

        if (metadata.md5_hash && ['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi'].includes(ext)) {
          try {
            const trailerPath = getTrailerPath(metadata.md5_hash);
            if (fs.existsSync(trailerPath)) {
              hasTrailer = true;
              trailerUrl = `/api/files/trailer/${encodeURIComponent(id)}/${encodeURIComponent(safeName)}`;
            }
          } catch (error) {
            logger.debug('[files-with-status] Trailer lookup failed', {
              deviceId: id,
              safeName,
              error: error.message
            });
          }
        }
        
        // Разрешение для видео файлов
        if (['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi'].includes(ext)) {
          if (metadata.video_width && metadata.video_height) {
            resolution = {
              width: metadata.video_width,
              height: metadata.video_height
            };
          }
        }
      }

      // Дополнительный ffprobe fallback для старых файлов
      if (['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi'].includes(ext)) {
        const devicesPath = getDevicesPath();
        const deviceFolderPath = path.join(devicesPath, id);
        const filePath = (metadata && metadata.file_path) || path.join(deviceFolderPath, safeName);
        if (
          (fileStatus.status !== 'processing' && fileStatus.status !== 'checking') &&
          ((!resolution || !resolution.width || !resolution.height) || !durationSeconds)
        ) {
          try {
            const params = await getCachedResolution(filePath, checkVideoParameters);
            if (params) {
              if ((!resolution || !resolution.width || !resolution.height) && params.width && params.height) {
                resolution = { width: params.width, height: params.height };
              }
              if (!durationSeconds && params.duration) {
                durationSeconds = Number(params.duration);
              }
            }
          } catch (e) {
            // ignore ffprobe errors
          }
        }
      }
      
      // КРИТИЧНО: Определяем contentType для папок/PDF/PPTX из метаданных БД
      if (metadata && STATIC_CONTENT_TYPES.has(metadata.content_type)) {
        contentType = metadata.content_type;
        
        // КРИТИЧНО: Если в БД указан contentType = 'pdf' или 'pptx', но файл не существует на диске,
        // проверяем, не был ли он уже конвертирован в папку
        if ((contentType === 'pdf' || contentType === 'pptx') && metadata.file_path) {
          if (!fs.existsSync(metadata.file_path)) {
            // Файл не существует, проверяем наличие папки (конвертированный файл)
            const folderName = safeName.replace(/\.(pdf|pptx)$/i, '');
            const devicesPath = getDevicesPath();
            const deviceFolder = path.join(devicesPath, devices[id]?.folder || id);
            const possibleFolderPath = path.join(deviceFolder, folderName);
            
            if (fs.existsSync(possibleFolderPath) && fs.statSync(possibleFolderPath).isDirectory()) {
              // Папка существует - файл был конвертирован, но метаданные не обновились
              logger.warn('[files-with-status] Обнаружен конвертированный файл без обновленных метаданных', {
                deviceId: id,
                safeName,
                contentType,
                folderPath: possibleFolderPath
              });
              
              // Обновляем contentType на 'folder'
              contentType = 'folder';
              
              // Пытаемся обновить метаданные в БД
              try {
                const { deleteFileMetadata, saveFileMetadata } = await import('../database/files-metadata.js');
                const folderStats = fs.statSync(possibleFolderPath);
                const { getFolderImagesCount } = await import('../converters/folder-converter.js');
                const pagesCount = await getFolderImagesCount(id, folderName);
                
                // Удаляем старую запись
                deleteFileMetadata(id, safeName);
                
                // Создаем новую запись для папки
                saveFileMetadata({
                  deviceId: id,
                  safeName: folderName,
                  originalName: originalName.replace(/\.(pdf|pptx)$/i, ''),
                  filePath: path.resolve(possibleFolderPath),
                  fileSize: 0,
                  md5Hash: '',
                  partialMd5: null,
                  mimeType: null,
                  videoParams: {},
                  audioParams: {},
                  fileMtime: folderStats.mtimeMs,
                  contentType: 'folder',
                  streamUrl: null,
                  streamProtocol: 'auto',
                  pagesCount
                });
                
                logger.info('[files-with-status] ✅ Метаданные обновлены для конвертированного файла', {
                  deviceId: id,
                  oldSafeName: safeName,
                  newSafeName: folderName,
                  pagesCount
                });
                
                // Обновляем safeName для дальнейшей обработки
                safeName = folderName;
                metadata = getFileMetadata(id, folderName);
                needsOptimizationHint = inferNeedsOptimizationFromMetadata(safeName, metadata);
                if (metadata) {
                  contentType = metadata.content_type || 'folder';
                }
              } catch (updateErr) {
                logger.error('[files-with-status] Ошибка обновления метаданных для конвертированного файла', {
                  deviceId: id,
                  safeName,
                  error: updateErr.message
                });
              }
            }
          }
        }
      } else if (!ext || ext === '' || ext === '.zip') {
        // Fallback: если нет метаданных, определяем по отсутствию расширения
        contentType = 'folder';
      } else if (ext === '.pdf') {
        contentType = 'pdf';
      } else if (ext === '.pptx') {
        contentType = 'pptx';
      }
      
      // Если это папка, PDF или PPTX — используем pages_count из БД
      if (STATIC_CONTENT_TYPES.has(contentType)) {
        // Используем pages_count из метаданных БД
        if (metadata && metadata.pages_count !== null && metadata.pages_count !== undefined) {
          folderImageCount = metadata.pages_count;
        } else {
          // Fallback: считаем вручную только если нет в БД (для старых записей)
          const folderName = safeName.replace(/\.(zip|pdf|pptx)$/i, '');
          try {
            if (contentType === 'folder' || !ext || ext === '' || ext === '.zip') {
              folderImageCount = await getFolderImagesCount(id, folderName);
            } else {
              // Для PDF/PPTX используем getPageSlideCount
              const { getPageSlideCount } = await import('../converters/document-converter.js');
              folderImageCount = await getPageSlideCount(id, safeName);
            }
          } catch (error) {
            folderImageCount = null;
          }
        }
      }
      
      // КРИТИЧНО: Проверяем существование файла/папки перед добавлением в список
      // Для статического контента (папки/PDF/PPTX) проверяем существование папки
      if (STATIC_CONTENT_TYPES.has(contentType)) {
        const checkPath = metadata?.file_path || path.join(getDevicesPath(), devices[id]?.folder || id, safeName);
        if (!fs.existsSync(checkPath)) {
          logger.warn('[files-with-status] Статический контент не найден на диске, пропускаем', {
            deviceId: id,
            safeName,
            contentType,
            filePath: checkPath
          });
          continue; // Пропускаем этот файл
        }
        
        // Дополнительная проверка для папок
        if (contentType === 'folder') {
          try {
            const stat = fs.statSync(checkPath);
            if (!stat.isDirectory()) {
              logger.warn('[files-with-status] Путь существует, но это не папка, пропускаем', {
                deviceId: id,
                safeName,
                filePath: checkPath
              });
              continue; // Пропускаем этот файл
            }
          } catch (statErr) {
            logger.warn('[files-with-status] Ошибка проверки папки, пропускаем', {
              deviceId: id,
              safeName,
              filePath: checkPath,
              error: statErr.message
            });
            continue; // Пропускаем этот файл
          }
        }
      } else if (contentType !== 'streaming') {
        // Для обычных файлов проверяем существование
        const checkPath = metadata?.file_path || path.join(getDevicesPath(), devices[id]?.folder || id, safeName);
        if (!fs.existsSync(checkPath)) {
          logger.warn('[files-with-status] Файл не найден на диске, пропускаем', {
            deviceId: id,
            safeName,
            contentType,
            filePath: checkPath
          });
          continue; // Пропускаем этот файл
        }
      }
      
      const streamProxyUrl = contentType === 'streaming'
        ? resolveStreamPlaybackUrl(id, safeName, metadata)
        : null;
      const restreamStatus = null;

      filesData.push({
        safeName,
        originalName,
        status: fileStatus.status || 'ready',
        progress: fileStatus.progress || 100,
        canPlay: fileStatus.canPlay !== false,
        error: fileStatus.error || null,
        resolution,
        isPlaceholder,  // НОВОЕ: Флаг заглушки
        durationSeconds,
        folderImageCount,
        contentType,
        needsOptimization: needsOptimizationHint,
        streamUrl,
        streamProxyUrl,
        restreamStatus,
        streamProtocol,
        hasTrailer,
        trailerUrl
      });
    }
    
    res.json(filesData);
  });
  
  // POST /api/devices/:id/cleanup-missing-files - Очистка несуществующих файлов из БД
  // POST /api/devices/cleanup-missing-files - Очистка для всех устройств
  const cleanupMissingFilesHandler = async (req, res) => {
    try {
      const deviceId = req.params.id ? sanitizeDeviceId(req.params.id) : null;
      const { dryRun = false } = req.body || {};
      
      if (deviceId && !devices[deviceId]) {
        return res.status(404).json({ error: 'Устройство не найдено' });
      }
      
      logger.info('[Cleanup] Starting cleanup missing files', {
        deviceId: deviceId || 'all',
        dryRun,
        requestedBy: req.user?.username || 'unknown'
      });
      
      const result = await cleanupMissingFiles({
        deviceId,
        dryRun: Boolean(dryRun)
      });
      
      auditLog({
        userId: req.user?.id,
        action: AuditAction.FILE_DELETE,
        resource: `cleanup-missing-files`,
        details: JSON.stringify({
          deviceId: deviceId || 'all',
          checked: result.checked,
          missing: result.missing,
          deleted: result.deleted,
          errors: result.errors,
          dryRun
        }),
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      });
      
      res.json({
        success: true,
        ...result,
        message: dryRun 
          ? `Found ${result.missing} missing files (dry run, no deletions)` 
          : `Cleaned up ${result.deleted} missing files`
      });
    } catch (error) {
      logger.error('[Cleanup] Failed to cleanup missing files', {
        error: error.message,
        stack: error.stack,
        deviceId: req.params.id
      });
      res.status(500).json({ 
        error: 'Failed to cleanup missing files',
        message: error.message 
      });
    }
  };

  router.post('/cleanup-missing-files', requireAdmin, express.json(), cleanupMissingFilesHandler);
  router.post('/:id/cleanup-missing-files', requireAdmin, express.json(), cleanupMissingFilesHandler);
  
  return router;
}

