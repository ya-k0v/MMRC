/**
 * Общие константы для Frontend приложения
 * @module shared/constants
 */

import { 
  getAndroidIcon, 
  getTVIcon, 
  getBrowserIcon, 
  getMonitorIcon, 
  getFilmIcon 
} from './svg-icons.js';
import {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  FOLDER_EXTENSIONS,
  resolveContentType
} from './content-type-helper.js';

/**
 * Получить SVG иконку для типа устройства
 * @param {string} deviceType - Тип устройства
 * @returns {string} SVG код иконки
 */
export function getDeviceIcon(deviceType) {
  switch (deviceType) {
    case 'android':
    case 'NATIVE_MEDIAPLAYER':
      return getAndroidIcon();
    case 'browser':
      return getBrowserIcon();
    case 'kodi':
    case 'webos':
    case 'tizen':
      return getTVIcon();
    case 'VJC':
      return getFilmIcon();
    case 'NATIVE_MPV':
      return getMonitorIcon();
    default:
      return getTVIcon();
  }
}

// Для обратной совместимости (используется как объект)
export const DEVICE_ICONS = {
  'browser': getBrowserIcon(),
  'android': getAndroidIcon(),
  'kodi': getTVIcon(),
  'webos': getTVIcon(),
  'tizen': getTVIcon(),
  'VJC': getFilmIcon(),
  'NATIVE_MEDIAPLAYER': getAndroidIcon(),
  'NATIVE_MPV': getMonitorIcon()
};

// Названия типов устройств
export const DEVICE_TYPE_NAMES = {
  'browser': 'Browser',
  'android': 'Android TV',
  'kodi': 'Kodi',
  'webos': 'WebOS',
  'tizen': 'Tizen',
  'VJC': 'Video.js Player',
  'NATIVE_MEDIAPLAYER': 'MMRC Player',
  'NATIVE_MPV': 'Linux MPV Player'
};

// Расширения файлов по типам
export const FILE_EXTENSIONS = {
  video: VIDEO_EXTENSIONS,
  audio: AUDIO_EXTENSIONS,
  image: IMAGE_EXTENSIONS,
  document: DOCUMENT_EXTENSIONS,
  folder: FOLDER_EXTENSIONS // ZIP архивы с изображениями - папки
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
  const contentType = resolveContentType({ fileName });
  if (contentType === 'pdf') return 'PDF';
  if (contentType === 'pptx') return 'PPTX';
  if (contentType === 'folder') return 'FOLDER';
  if (contentType === 'image') return 'IMG';
  if (contentType === 'video') return 'VID';
  if (contentType === 'audio') return 'AUD';
  return 'FILE';
}

