/**
 * Обертка для работы с FFmpeg/FFprobe
 * @module video/ffmpeg-wrapper
 */

import { exec } from 'child_process';
import util from 'util';
import logger from '../utils/logger.js';

const execAsync = util.promisify(exec);

/**
 * Проверка параметров видео через ffprobe
 * @param {string} filePath - Путь к видео файлу
 * @returns {Promise<Object|null>} Параметры видео или null при ошибке
 */
export async function checkVideoParameters(filePath) {
  try {
    // ИСПРАВЛЕНО: Добавлен timeout 30 секунд для предотвращения зависания
    const { stdout } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate,bit_rate,profile,level -show_entries format=duration -of json "${filePath}"`,
      { timeout: 30000, maxBuffer: 1024 * 1024 } // 30s timeout, 1MB buffer
    );
    
    const data = JSON.parse(stdout);
    const stream = data.streams?.[0];
    const fmt = data.format || {};
    
    if (!stream) return null;
    
    // Парсим frame rate (например "25/1" -> 25)
    let fps = 0;
    if (stream.r_frame_rate) {
      const [num, den] = stream.r_frame_rate.split('/').map(Number);
      fps = den ? num / den : num;
    }
    
    return {
      codec: stream.codec_name,
      width: stream.width || 0,
      height: stream.height || 0,
      fps: Math.round(fps),
      bitrate: parseInt(stream.bit_rate) || 0,
      profile: stream.profile || 'unknown',
      level: stream.level || 0,
      duration: fmt.duration ? Math.round(parseFloat(fmt.duration)) : 0
    };
  } catch (error) {
    // Проверяем timeout ошибку
    if (error.killed && error.signal === 'SIGTERM') {
      logger.error(`[VideoOpt] ⏱️ FFprobe timeout для файла: ${filePath}`, { filePath, error: error.message });
    } else {
      logger.error(`[VideoOpt] ❌ Ошибка ffprobe: ${error.message}`, { filePath, error: error.message, stack: error.stack });
    }
    return null;
  }
}

