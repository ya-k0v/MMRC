/**
 * Trailer generator - создаёт короткий MP4 (≈10s) для превью видео
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConvertedCache } from '../config/settings-manager.js';
import { spawnFfmpeg } from '../utils/docker-ffmpeg.js';
import { getCurrentStorage } from '../storage/current.js';
import { createModuleLogger } from '../utils/logger.js';
import {
  isLocalStorage,
  toStorageKey,
  materializeToLocal,
  syncFileToStorage,
  removeLocalCopy
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
  try {
    if (!md5Hash || !filePath) return;

    const storage = options.storage || getCurrentStorage();

    // Трейлер уже есть в хранилище — ничего генерировать не нужно
    if (!isLocalStorage(storage)) {
      try {
        const trailerKey = toStorageKey(getTrailerPath(md5Hash));
        if (await storage.exists(trailerKey)) return;
      } catch (error) {
        // Проверка вспомогательная: при ошибке просто генерируем заново
        logger.debug('[Trailer] Не удалось проверить наличие трейлера в S3', {
          md5Hash, error: error.message
        });
      }
    }

    const outPath = getTrailerPath(md5Hash);
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
    }).catch(() => {});

    // Коммитим трейлер в S3 и убираем локальную копию: при S3 как основном
    // хранилище оставлять превью на диске бессмысленно.
    if (fs.existsSync(outPath) && !isLocalStorage(storage)) {
      try {
        const result = await syncFileToStorage(outPath, storage, {
          fileName: `${md5Hash}.mp4`,
          force: true,
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
    inProgress.delete(md5Hash);
  }
}


