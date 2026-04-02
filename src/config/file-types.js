/**
 * Unified Content Type Detection and Handling (Backend)
 * @module config/file-types
 * 
 * Централизованные определения типов контентов для backend.
 * Синхронизирует с public/js/shared/content-type-helper.js
 */

// ========================================
// Расширения файлов для каждого типа
// ========================================

export const AUDIO_EXTENSIONS = ['mp3', 'aac', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'weba'];
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi'];
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
export const DOCUMENT_EXTENSIONS = ['pdf', 'pptx'];
export const FOLDER_EXTENSIONS = ['zip'];

// Все допустимые расширения
export const ALL_EXTENSIONS = [
  ...AUDIO_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
  ...FOLDER_EXTENSIONS
];

/**
 * Получить расширение файла (без точки, в нижнем регистре)
 * @param {string} fileName - Имя файла
 * @returns {string} Расширение без точки (например 'mp3')
 */
export function getFileExtension(fileName) {
  if (!fileName || typeof fileName !== 'string') return '';
  const parts = fileName.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

/**
 * Определить СУБТИП контента по расширению файла
 * @param {string} fileName - Имя файла
 * @returns {string} Тип: 'audio' | 'video' | 'image' | 'pdf' | 'pptx' | 'folder' | null
 */
export function detectContentTypeByExtension(fileName) {
  if (!fileName) return null;
  
  const ext = getFileExtension(fileName);
  if (!ext) return null;
  
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (DOCUMENT_EXTENSIONS.includes(ext)) return ext; // 'pdf' или 'pptx'
  if (FOLDER_EXTENSIONS.includes(ext)) return 'folder';
  
  return null;
}

/**
 * Нормализовать тип контента по метаданным и имени файла
 * @param {object} params
 * @param {string} [params.contentType]
 * @param {string} [params.fileName]
 * @param {string} [params.originalName]
 * @param {boolean} [params.fallbackToFolder=false]
 * @returns {string|null} Тип контента или null
 */
export function resolveContentType({ contentType, fileName, originalName, fallbackToFolder = false } = {}) {
  const normalizedContentType = (contentType && contentType !== 'file' && contentType !== 'unknown')
    ? contentType
    : null;
  if (normalizedContentType) return normalizedContentType;

  const ext = getFileExtension(fileName || '') || getFileExtension(originalName || '');
  if (!ext) return fallbackToFolder ? 'folder' : null;

  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (DOCUMENT_EXTENSIONS.includes(ext)) return ext;
  if (FOLDER_EXTENSIONS.includes(ext)) return 'folder';

  return null;
}

/**
 * Проверить является ли файл видео файлом по расширению
 * @param {string} fileName - Имя файла
 * @returns {boolean}
 */
export function isVideoFile(fileName) {
  const ext = getFileExtension(fileName);
  return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Проверить является ли файл аудио файлом по расширению
 * @param {string} fileName - Имя файла
 * @returns {boolean}
 */
export function isAudioFile(fileName) {
  const ext = getFileExtension(fileName);
  return AUDIO_EXTENSIONS.includes(ext);
}

/**
 * Проверить является ли файл статическим контентом (PDF, PPTX, папка)
 * @param {string} fileName - Имя файла
 * @returns {boolean}
 */
export function isStaticContent(fileName) {
  const ext = getFileExtension(fileName);
  return DOCUMENT_EXTENSIONS.includes(ext) || FOLDER_EXTENSIONS.includes(ext);
}

/**
 * Проверить является ли файл изображением
 * @param {string} fileName - Имя файла
 * @returns {boolean}
 */
export function isImageFile(fileName) {
  const ext = getFileExtension(fileName);
  return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Типы контента которые отображаются как сетка изображений
 */
export const STATIC_CONTENT_TYPES = new Set(['pdf', 'pptx', 'folder']);

/**
 * Получить MIME type по типу контента
 * @param {string} contentType - Тип контента ('audio', 'video', 'image', 'pdf', 'pptx', 'folder')
 * @returns {string} MIME type
 */
export function getMimeType(contentType, fileName = '') {
  const mimeMap = {
    audio: 'audio/mpeg',      // Default для audio
    video: 'video/mp4',        // Default для video
    image: 'image/jpeg',       // Default для image
    pdf: 'application/pdf',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    folder: 'application/x-zip-compressed',
    streaming: 'application/x-mpegurl' // Default для стримов
  };
  
  // Если передан fileName, можем быть более точными
  if (fileName) {
    const ext = getFileExtension(fileName);
    const mimeByExt = {
      mp3: 'audio/mpeg',
      aac: 'audio/aac',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
      flac: 'audio/flac',
      'm4a': 'audio/mp4',
      opus: 'audio/opus',
      weba: 'audio/webp',
      
      mp4: 'video/mp4',
      webm: 'video/webm',
      mkv: 'video/x-matroska',
      mov: 'video/quicktime',
      avi: 'video/x-msvideo',
      
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp'
    };
    
    return mimeByExt[ext] || mimeMap[contentType] || 'application/octet-stream';
  }
  
  return mimeMap[contentType] || 'application/octet-stream';
}

/**
 * Получить информацию о типе файла (для логирования и обработки)
 * @param {string} fileName - Имя файла
 * @returns {object} { ext: 'mp4', contentType: 'video', isMedia: true, isStatic: false, ... }
 */
export function getFileTypeInfo(fileName) {
  const ext = getFileExtension(fileName);
  const contentType = detectContentTypeByExtension(fileName);
  const mimeType = getMimeType(contentType, fileName);
  
  return {
    fileName,
    ext,
    contentType,
    mimeType,
    isMedia: ['audio', 'video'].includes(contentType),
    isStatic: STATIC_CONTENT_TYPES.has(contentType),
    isImage: contentType === 'image',
    isVideo: contentType === 'video',
    isAudio: contentType === 'audio',
    isPdf: contentType === 'pdf',
    isPptx: contentType === 'pptx',
    isFolder: contentType === 'folder'
  };
}

export default {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  FOLDER_EXTENSIONS,
  ALL_EXTENSIONS,
  getFileExtension,
  detectContentTypeByExtension,
  resolveContentType,
  isVideoFile,
  isAudioFile,
  isStaticContent,
  isImageFile,
  STATIC_CONTENT_TYPES,
  getMimeType,
  getFileTypeInfo
};
