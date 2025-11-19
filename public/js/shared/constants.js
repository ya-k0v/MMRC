/**
 * Общие константы для Frontend приложения
 * @module shared/constants
 */

// Иконки для типов устройств
export const DEVICE_ICONS = {
  'browser': '🌐',
  'android': '📱',
  'kodi': '📺',
  'webos': '📺',
  'tizen': '📺',
  'VJC': '🎬',
  'NATIVE_MEDIAPLAYER': '📱',
  'NATIVE_MPV': '🖥️'
};

// Названия типов устройств
export const DEVICE_TYPE_NAMES = {
  'browser': 'Browser',
  'android': 'Android TV',
  'kodi': 'Kodi',
  'webos': 'WebOS',
  'tizen': 'Tizen',
  'VJC': 'Video.js Player',
  'NATIVE_MEDIAPLAYER': 'VCMediaPlayer',
  'NATIVE_MPV': 'Linux MPV Player'
};

// Расширения файлов по типам
export const FILE_EXTENSIONS = {
  video: ['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi'],
  audio: ['mp3', 'wav', 'm4a'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  document: ['pdf', 'pptx'],
  folder: ['zip'] // ZIP архивы с изображениями - папки
};

// Метки разрешения видео
export const RESOLUTION_LABELS = {
  '4K': { minWidth: 3840, minHeight: 2160 },
  'FHD': { minWidth: 1920, minHeight: 1080 },
  'HD': { minWidth: 1280, minHeight: 720 },
  'SD': { minWidth: 1, minHeight: 1 }
};

/**
 * Определить метку разрешения по ширине и высоте
 * @param {number} width - Ширина видео
 * @param {number} height - Высота видео
 * @returns {string} Метка разрешения (4K, FHD, HD, SD)
 */
export function getResolutionLabel(width, height) {
  if (width >= 3840 || height >= 2160) return '4K';
  if (width >= 1920 || height >= 1080) return 'FHD';
  if (width >= 1280 || height >= 720) return 'HD';
  if (width > 0) return 'SD';
  return '';
}

/**
 * Определить тип файла по расширению
 * @param {string} fileName - Имя файла
 * @returns {string} Тип файла (VID, IMG, PDF, PPTX, FOLDER)
 */
export function getFileTypeLabel(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  
  if (ext === 'pdf') return 'PDF';
  if (ext === 'pptx') return 'PPTX';
  if (ext === 'zip') return 'FOLDER';
  if (FILE_EXTENSIONS.image.includes(ext)) return 'IMG';
  if (FILE_EXTENSIONS.video.includes(ext)) return 'VID';
  if (FILE_EXTENSIONS.audio.includes(ext)) return 'AUD';
  
  return 'FILE';
}

