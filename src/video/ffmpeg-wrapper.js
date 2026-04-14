/**
 * Обертка для работы с FFmpeg/FFprobe
 * @module video/ffmpeg-wrapper
 */

import { execFile } from 'child_process';
import util from 'util';
import logger from '../utils/logger.js';

const execFileAsync = util.promisify(execFile);

/**
 * Проверка параметров видео через ffprobe
 * @param {string} filePath - Путь к видео файлу
 * @returns {Promise<Object|null>} Параметры видео или null при ошибке
 */
export async function checkVideoParameters(filePath) {
  try {
    // ИСПРАВЛЕНО: Добавлен timeout 30 секунд для предотвращения зависания
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,bit_rate,profile,level,pix_fmt,channels,sample_rate',
      '-show_entries', 'format=duration,bit_rate',
      '-of', 'json',
      filePath
    ], {
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024
    }); // 30s timeout, 2MB buffer
    
    const data = JSON.parse(stdout);
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const videoStream = streams.find((stream) => stream?.codec_type === 'video') || streams[0];
    const audioStream = streams.find((stream) => stream?.codec_type === 'audio') || null;
    const fmt = data.format || {};
    
    if (!videoStream) return null;
    
    // Парсим frame rate (например "25/1" -> 25)
    let fps = 0;
    if (videoStream.r_frame_rate) {
      const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
      fps = den ? num / den : num;
    }

    const videoBitrate = parseInt(videoStream.bit_rate, 10) || 0;
    const formatBitrate = parseInt(fmt.bit_rate, 10) || 0;
    const audioBitrate = parseInt(audioStream?.bit_rate, 10) || 0;
    
    return {
      codec: videoStream.codec_name,
      width: videoStream.width || 0,
      height: videoStream.height || 0,
      fps: Math.round(fps),
      bitrate: videoBitrate || formatBitrate,
      profile: videoStream.profile || 'unknown',
      level: videoStream.level || 0,
      pixFmt: videoStream.pix_fmt || null,
      duration: fmt.duration ? Math.round(parseFloat(fmt.duration)) : 0,
      audioCodec: audioStream?.codec_name || null,
      audioBitrate,
      audioChannels: Number(audioStream?.channels) || 0,
      audioSampleRate: Number(audioStream?.sample_rate) || 0
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

