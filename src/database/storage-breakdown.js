/**
 * Разбивка контента по типам для карточки «Хранилище».
 *
 * Группировка делается в БД, чтобы не тащить в админку все строки метаданных.
 * SUM(bigint) в PostgreSQL приходит строкой, поэтому все числа нормализуются
 * через Number. Выражение для расширения выбрано по драйверу: INSTR — SQLite,
 * STRPOS — PostgreSQL; остальной SQL общий для обоих.
 */

import { getDatabase, getDriverType } from './database.js';
import { detectContentTypeByExtension } from '../config/file-types.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('storage');

/** Порядок сегментов в легенде: от медиа к «прочему». */
export const STORAGE_TYPE_GROUPS = [
  { key: 'video', label: 'Видео' },
  { key: 'audio', label: 'Аудио' },
  { key: 'image', label: 'Изображения' },
  { key: 'documents', label: 'Документы' },
  { key: 'other', label: 'Другое' }
];

const CONTENT_TYPE_GROUPS = {
  video: 'video',
  streaming: 'video',
  audio: 'audio',
  image: 'image',
  pdf: 'documents',
  pptx: 'documents',
  folder: 'documents'
};

/** Привести строку метаданных к одному из групп STORAGE_TYPE_GROUPS. */
export function classifyStorageType({ contentType = '', mimeType = '', extension = '' } = {}) {
  const type = String(contentType || '').trim().toLowerCase();
  if (CONTENT_TYPE_GROUPS[type]) return CONTENT_TYPE_GROUPS[type];

  const mime = String(mimeType || '').trim().toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  if (
    mime === 'application/pdf' ||
    mime.startsWith('text/') ||
    mime.includes('powerpoint') ||
    mime.includes('presentation') ||
    mime.includes('spreadsheet') ||
    mime.includes('wordprocessing')
  ) return 'documents';

  const ext = String(extension || '').trim().toLowerCase().replace(/^\./, '');
  if (ext) {
    const detected = detectContentTypeByExtension(`file.${ext}`);
    if (detected === 'video' || detected === 'audio' || detected === 'image') return detected;
    if (detected === 'pdf' || detected === 'pptx' || detected === 'folder') return 'documents';
  }

  return 'other';
}

/** SQL, общий для SQLite и PostgreSQL (различается только функция позиции точки). */
export function buildStorageBreakdownQuery(driverType = 'sqlite') {
  const dotPos = driverType === 'postgres' ? "STRPOS(safe_name, '.')" : "INSTR(safe_name, '.')";
  const contentType = "LOWER(COALESCE(content_type, ''))";
  const mimeType = "LOWER(COALESCE(mime_type, ''))";
  const extension = `LOWER(CASE WHEN ${dotPos} > 0 THEN SUBSTR(safe_name, ${dotPos} + 1) ELSE '' END)`;

  return `SELECT ${contentType} AS content_type, ${mimeType} AS mime_type, ${extension} AS extension,
       SUM(file_size) AS bytes, COUNT(*) AS files
    FROM files_metadata
    WHERE COALESCE(file_size, 0) > 0
    GROUP BY ${contentType}, ${mimeType}, ${extension}`;
}

/**
 * @returns {Promise<Array<{key: string, label: string, bytes: number, files: number}>>}
 */
export async function fetchStorageBreakdown(db = getDatabase()) {
  try {
    const rows = await db.query(buildStorageBreakdownQuery(getDriverType()));
    const totals = new Map();

    for (const row of Array.isArray(rows) ? rows : []) {
      const key = classifyStorageType({
        contentType: row.content_type,
        mimeType: row.mime_type,
        extension: row.extension
      });
      const bytes = Math.max(0, Number(row.bytes ?? row.total_bytes ?? 0) || 0);
      const files = Math.max(0, Number(row.files ?? 0) || 0);
      const current = totals.get(key) || { bytes: 0, files: 0 };
      current.bytes += bytes;
      current.files += files;
      totals.set(key, current);
    }

    return STORAGE_TYPE_GROUPS
      .filter(group => (totals.get(group.key)?.bytes || 0) > 0)
      .map(group => ({
        key: group.key,
        label: group.label,
        bytes: Math.round(totals.get(group.key).bytes),
        files: totals.get(group.key).files
      }));
  } catch (error) {
    // Разбивка — необязательная диагностика: карточка должна показать занятость
    // диска, даже если метаданные недоступны (например, БД на реплике).
    logger.warn('Failed to load storage type breakdown', { error: error.message });
    return [];
  }
}
