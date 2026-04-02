/**
 * Unified Content Type Detection and Handling
 * @module shared/content-type-helper
 * 
 * Централизованные определения типов контентов и их обработки.
 * Используется везде вместо дублирования логики.
 */

// ========================================
// Расширения файлов для каждого типа
// ========================================

export const AUDIO_EXTENSIONS = ['mp3', 'aac', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'weba'];
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi'];
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
export const DOCUMENT_EXTENSIONS = ['pdf', 'pptx'];
export const FOLDER_EXTENSIONS = ['zip'];

// Для быстрого поиска в Set
export const AUDIO_EXT_SET = new Set(AUDIO_EXTENSIONS);
export const VIDEO_EXT_SET = new Set(VIDEO_EXTENSIONS);
export const IMAGE_EXT_SET = new Set(IMAGE_EXTENSIONS);
export const DOCUMENT_EXT_SET = new Set(DOCUMENT_EXTENSIONS);
export const FOLDER_EXT_SET = new Set(FOLDER_EXTENSIONS);

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
 * @returns {string} Тип: 'audio' | 'video' | 'image' | 'pdf' | 'pptx' | 'folder' | 'unknown'
 */
export function detectContentTypeByExtension(fileName) {
  const ext = getFileExtension(fileName);
  if (!ext) return 'unknown';
  
  if (AUDIO_EXT_SET.has(ext)) return 'audio';
  if (VIDEO_EXT_SET.has(ext)) return 'video';
  if (IMAGE_EXT_SET.has(ext)) return 'image';
  if (DOCUMENT_EXT_SET.has(ext)) return ext; // 'pdf' или 'pptx'
  if (FOLDER_EXT_SET.has(ext)) return 'folder';
  
  return 'unknown';
}

/**
 * Нормализовать тип контента по метаданным и имени файла
 * @param {object} params
 * @param {string} [params.contentType] - Тип контента из метаданных
 * @param {string} [params.fileName] - Имя файла на диске (safeName)
 * @param {string} [params.originalName] - Оригинальное имя
 * @param {boolean} [params.fallbackToFolder=false] - Считать файлы без расширения папкой
 * @returns {string} Тип: 'audio' | 'video' | 'image' | 'pdf' | 'pptx' | 'folder' | 'streaming' | 'unknown'
 */
export function resolveContentType({ contentType, fileName, originalName, fallbackToFolder = false } = {}) {
  const normalizedContentType = (contentType && contentType !== 'file' && contentType !== 'unknown')
    ? contentType
    : null;
  if (normalizedContentType) return normalizedContentType;

  const ext = getFileExtension(fileName || '') || getFileExtension(originalName || '');
  if (!ext) return fallbackToFolder ? 'folder' : 'unknown';

  if (AUDIO_EXT_SET.has(ext)) return 'audio';
  if (VIDEO_EXT_SET.has(ext)) return 'video';
  if (IMAGE_EXT_SET.has(ext)) return 'image';
  if (DOCUMENT_EXT_SET.has(ext)) return ext;
  if (FOLDER_EXT_SET.has(ext)) return 'folder';

  return 'unknown';
}

/**
 * Определить способ воспроизведения по метаданным/имени файла
 * @param {object} params
 * @returns {string} 'media' | 'slideshow' | 'stream' | 'image' | 'unknown'
 */
export function getPlaybackTypeForFile({ contentType, fileName, originalName, fallbackToFolder = false } = {}) {
  const resolvedType = resolveContentType({ contentType, fileName, originalName, fallbackToFolder });
  return getPlaybackType(resolvedType);
}

/**
 * Определить КАК воспроизводить контент
 * @param {string} contentType - Тип контента ('audio', 'video', 'folder', 'pdf', 'pptx', 'streaming', 'image')
 * @returns {string} Способ воспроизведения: 'media' | 'slideshow' | 'stream' | 'unknown'
 * 
 * media = Video.js (видео или аудио)
 * slideshow = сетка изображений (папка, PDF, PPTX)
 * stream = стрим через HLS/DASH/MPEGTS
 */
export function getPlaybackType(contentType) {
  if (!contentType) return 'unknown';
  
  if (contentType === 'streaming') return 'stream';
  if (['audio', 'video'].includes(contentType)) return 'media';
  if (['folder', 'pdf', 'pptx'].includes(contentType)) return 'slideshow';
  if (contentType === 'image') return 'image';
  
  return 'unknown';
}

/**
 * Получить человеческое описание длительности контента
 * ПРИМЕЧАНИЕ: дurationSeconds имеет разный смысл для разных типов:
 * - для video/audio: это секунды
 * - для folder/pdf/pptx: это количество элементов (но обычно используется folderImageCount)
 * 
 * @param {number} durationSeconds - Длительность/количество
 * @param {string} contentType - Тип контента
 * @returns {string} Читаемая строка ('02:45', '5 фото', '') или пустая строка
 */
export function getDurationLabel(durationSeconds, contentType) {
  if (!durationSeconds || durationSeconds <= 0) return '';
  
  // Для папок/PDF/PPTX - это количество элементов
  if (contentType === 'folder') {
    const count = Math.round(durationSeconds);
    if (count === 1) return '1 фото';
    if (count <= 4) return `${count} фото`;
    return `${count} фото`;
  }
  
  // Для видео и аудио - время в формате MM:SS или HH:MM:SS
  return formatDuration(durationSeconds);
}

/**
 * Форматировать длительность в MM:SS или HH:MM:SS
 * @param {number} seconds - Длительность в секундах
 * @returns {string} Отформатированная строка ('02:45' или '1:23:45')
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Типы контента которые отображаются как сетка изображений (статический контент)
 */
export const STATIC_CONTENT_TYPES = new Set(['pdf', 'pptx', 'folder']);

/**
 * Проверить является ли контент статическим (сетка изображений)
 * @param {string} contentType 
 * @returns {boolean}
 */
export function isStaticContent(contentType) {
  return STATIC_CONTENT_TYPES.has(contentType);
}

/**
 * Получить иконку/метку типа контента для отображения в UI
 * @param {string} contentType - Тип контента
 * @param {string} streamProtocol - Протокол потока (для streaming)
 * @returns {object} { label: 'Видео', shortLabel: 'VID', type: 'video', ... }
 */
export function getContentTypeInfo(contentType, streamProtocol = null) {
  const info = {
    audio: { label: 'Аудио', shortLabel: 'AUDIO', type: 'audio', icon: '♪' },
    video: { label: 'Видео', shortLabel: 'VID', type: 'video', icon: '▶' },
    image: { label: 'Изображение', shortLabel: 'IMG', type: 'image', icon: '🖼' },
    pdf: { label: 'PDF', shortLabel: 'PDF', type: 'pdf', icon: '📄' },
    pptx: { label: 'Презентация', shortLabel: 'PPTX', type: 'pptx', icon: '📊' },
    folder: { label: 'Папка', shortLabel: 'FOLDER', type: 'folder', icon: '📁' },
    streaming: {
      label: streamProtocol ? `Стрим (${streamProtocol.toUpperCase()})` : 'Стрим',
      shortLabel: 'STREAM',
      type: 'streaming',
      icon: '📡'
    }
  };
  
  return info[contentType] || { 
    label: 'Файл',
    shortLabel: 'FILE',
    type: contentType,
    icon: '📦'
  };
}

/**
 * Получить полный описания типа и метаданных
 * Используется на speaker panel для отображения типа + duration
 * 
 * @param {object} fileData - Данные файла { contentType, durationSeconds, folderImageCount, streamProtocol, ... }
 * @returns {string} Описание типа с метаданными ('Видео · 02:45', 'Папка · 5 фото', ...)
 */
export function getContentTypeWithMetadata(fileData = {}) {
  const { contentType, durationSeconds, folderImageCount, streamProtocol } = fileData;
  
  if (!contentType) return '';
  
  const typeInfo = getContentTypeInfo(contentType, streamProtocol);
  const parts = [typeInfo.label];
  
  // Добавляем метаданные в зависимости от типа
  if (contentType === 'folder' && Number.isFinite(folderImageCount)) {
    // Для папок используем folderImageCount (более надежно)
    const count = Math.round(folderImageCount);
    parts.push(count === 1 ? '1 фото' : `${count} фото`);
  } else if ((contentType === 'audio' || contentType === 'video') && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    // Для видео и аудио используем durationSeconds
    parts.push(formatDuration(durationSeconds));
  } else if ((contentType === 'pdf' || contentType === 'pptx') && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    // Для PDF/PPTX durationSeconds = количество страниц/слайдов
    const count = Math.round(durationSeconds);
    parts.push(count === 1 ? '1 страница' : `${count} страниц`);
  }
  
  return parts.join(' · ');
}

export default {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  FOLDER_EXTENSIONS,
  getFileExtension,
  detectContentTypeByExtension,
  resolveContentType,
  getPlaybackType,
  getPlaybackTypeForFile,
  getDurationLabel,
  formatDuration,
  STATIC_CONTENT_TYPES,
  isStaticContent,
  getContentTypeInfo,
  getContentTypeWithMetadata
};
