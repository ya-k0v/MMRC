/**
 * Trailer generator - создаёт короткий MP4 (≈5s) для превью видео
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getConvertedCache } from '../config/settings-manager.js';

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
  try {
    if (!md5Hash || !filePath) return;
    const outPath = getTrailerPath(md5Hash);
    if (fs.existsSync(outPath)) return;
    if (inProgress.has(md5Hash)) return;
    inProgress.add(md5Hash);
    
    const startSec = options.startSec ?? 0;
    const seconds = options.seconds ?? 5;
    
    // Перекодирование в совместимый MP4 (H.264 baseline + AAC)
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', String(startSec),
      '-t', String(seconds),
      '-i', filePath,
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
      const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let errBuf = '';
      ff.stderr.on('data', d => { errBuf += d.toString(); });
      ff.on('error', reject);
      ff.on('close', (code) => {
        if (code === 0 && fs.existsSync(outPath)) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${errBuf}`));
      });
    }).catch(() => {});
  } finally {
    inProgress.delete(md5Hash);
  }
}


