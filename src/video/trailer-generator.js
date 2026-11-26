/**
 * Trailer generator - создаёт короткий MP4 (≈10s) для превью видео
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConvertedCache } from '../config/settings-manager.js';
import { spawnFfmpeg } from '../utils/docker-ffmpeg.js';
import { getCurrentStorage } from '../storage/current.js';
import { createModuleLogger } from '../utils/logger.js';
import { recordStorageEvent } from '../utils/metrics.js';
import { probeStorageKey } from '../storage/probe.js';
import {
  isLocalStorage,
  toStorageKey,
  materializeToLocal,
  syncFileToStorage,
  removeLocalCopy,
  createScratchPath
} from '../storage/sync.js';

const logger = createModuleLogger('trailer');

// TRAILERS_DIR вычисляется динамически из настроек БД
function getTrailersDir() {
  return path.join(getConvertedCache(), 'trailers');
}

const inProgress = new Set(); // md5 в процессе генерации

function ensureDirs() {
  const convertedCache = getConvertedCache();
  const trailersDir = getTrailersDir();
  if (!fs.existsSync(convertedCache)) {
    fs.mkdirSync(convertedCache, { recursive: true });
  }
  if (!fs.existsSync(trailersDir)) {
    fs.mkdirSync(trailersDir, { recursive: true });
  }
}

export function getTrailerPath(md5Hash) {
  ensureDirs();
  return path.join(getTrailersDir(), `${md5Hash}.mp4`);
}

/**
 * Асинхронно гарантирует наличие трейлера для файла
 * Не бросает исключений наружу; безопасен для параллельных вызовов
 */
export async function ensureTrailerForFile(md5Hash, filePath, options = {}) {
  // Исходник и сам трейлер могут лежать только в S3: ffmpeg умеет читать
  // лишь файловую систему, поэтому материализуем во временную рабочую
  // область, а результат коммитим обратно.
  let localSource = null;
  let scratchOutput = null;
  try {
    if (!md5Hash || !filePath) return;

    const storage = options.storage || getCurrentStorage();
    let trailerKey = null;

    // Трейлер уже есть в хранилище — ничего генерировать не нужно.
    // unknown (таймаут/403) НЕ означает «нет», поэтому перезаписывать не будем.
    if (!isLocalStorage(storage)) {
      try {
        trailerKey = toStorageKey(getTrailerPath(md5Hash));
        const probe = await probeStorageKey(storage, trailerKey);
        recordStorageEvent('probe');
        recordStorageEvent(probe.state);
        if (probe.state === 'present') return;
        if (probe.state === 'unknown') {
          logger.warn('[Trailer] Storage check inconclusive, skipping generation', {
            md5Hash, error: probe.error?.message || null
          });
          return;
        }
      } catch (error) {
        recordStorageEvent('unknown');
        logger.warn('[Trailer] Cannot verify trailer in storage, skipping generation', {
          md5Hash, error: error.message
        });
        return;
      }
    }

    // Работаем во временной папке: локальный диск при S3 — только scratch.
    const outPath = isLocalStorage(storage)
      ? getTrailerPath(md5Hash)
      : (scratchOutput = createScratchPath('trailer', `${md5Hash}.mp4`));
    if (fs.existsSync(outPath)) return;
    if (inProgress.has(md5Hash)) return;
    inProgress.add(md5Hash);

    localSource = await materializeToLocal(filePath, storage, { fileName: md5Hash });
    if (!localSource) {
      logger.warn('[Trailer] Исходник недоступен ни локально, ни в S3', { md5Hash, filePath });
      return;
    }
    
    const startSec = options.startSec ?? 0;
    const seconds = options.seconds ?? 5;
    
    // Перекодирование в совместимый MP4 (H.264 baseline + AAC)
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', String(startSec),
      '-t', String(seconds),
      '-i', localSource,
      '-analyzeduration', '0',
      '-probesize', '500000',
      '-vf', 'scale=trunc(min(iw\\,1920)/2)*2:trunc(min(ih\\,1080)/2)*2',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-b:v', '1800k',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart+frag_keyframe+empty_moov',
      '-f', 'mp4',
      outPath
    ];
    
    await new Promise((resolve, reject) => {
      const ff = spawnFfmpeg(args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let errBuf = '';
      ff.stderr.on('data', d => { errBuf += d.toString(); });
      ff.on('error', reject);
      ff.on('close', (code) => {
        if (code === 0 && fs.existsSync(outPath)) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${errBuf}`));
      });
    }).catch((error) => {
      logger.warn('[Trailer] ffmpeg failed', { md5Hash, error: error.message });
      throw error;
    });

    // Коммитим трейлер в S3 и убираем локальную копию: при S3 как основном
    // хранилище оставлять превью на диске бессмысленно.
    if (fs.existsSync(outPath) && !isLocalStorage(storage)) {
      try {
        const result = await syncFileToStorage(outPath, storage, {
          fileName: `${md5Hash}.mp4`,
          targetKey: trailerKey,
          force: false,
          removeLocal: true
        });
        if (!result.synced) {
          logger.warn('[Trailer] Трейлер не попал в S3', { md5Hash, reason: result.reason });
        }
      } catch (error) {
        // Трейлер — превью, его отсутствие не ломает воспроизведение
        logger.error('[Trailer] Ошибка коммита трейлера в S3', { md5Hash, error: error.message });
      }
    }
  } finally {
    // Исходник мог быть материализован специально для генерации
    if (localSource && localSource !== filePath) {
      await removeLocalCopy(localSource);
    }
    // Неудачный/нескоммиченный результат не должен копиться в scratch.
    if (scratchOutput && fs.existsSync(scratchOutput)) {
      try {
        await removeLocalCopy(scratchOutput);
      } catch (error) {
        logger.warn('[Trailer] Cannot remove scratch output', {
          path: scratchOutput, error: error.message
        });
      }
    }
    inProgress.delete(md5Hash);
  }
}


