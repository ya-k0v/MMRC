/**
 * Константы конфигурации приложения
 * @module config/constants
 */

import path from 'path';
import fs from 'fs';

// Базовые пути
export const ROOT = process.cwd();
export const PUBLIC = path.join(ROOT, 'public');

// КРИТИЧНО: Все пути к данным теперь вычисляются динамически из настроек БД
// Используйте функции из settings-manager.js:
// - getDataRoot() - корневая папка данных (contentRoot из настроек)
// - getStreamsOutputDir() - директория для HLS стримов
// - getConvertedCache() - кэш конвертированных файлов
// - getLogsDir() - директория для логов
// - getTempDir() - директория для временных файлов
// - getDevicesPath() - путь к контенту устройств (то же что getDataRoot())

// Путь по умолчанию (используется только при первой инициализации)
// ВАЖНО: После инициализации все пути берутся из настроек БД (config/app-settings.json)
// По умолчанию используется локальная папка проекта (/var/lib/mmrc/data)
// Админ может изменить на внешний диск через настройки (/mnt/videocontrol-data)
export const DEFAULT_DATA_ROOT = path.join(ROOT, 'data');
const useExternalDataDisk = process.env.DATA_ROOT && fs.existsSync(process.env.DATA_ROOT);

// Единая директория для всех данных по умолчанию (до загрузки настроек)
// Теперь всегда используем DEFAULT_DATA_ROOT (локальная папка проекта)
const DEFAULT_DATA_DIR = DEFAULT_DATA_ROOT;

// Экспортируем для логирования в server.js (устаревшее, оставлено для обратной совместимости)
export const useExternalDataDiskFlag = useExternalDataDisk;

// DEVICES - папка с контентом устройств (может переопределяться настройками)
// ВАЖНО: Это значение по умолчанию, реальное значение берется из настроек через settings-manager
export const DEFAULT_DEVICES_PATH = path.join(DEFAULT_DATA_DIR, 'content');

// ВАЖНО: DEVICES теперь устанавливается через setDevicesPath() из settings-manager.js
// Не используйте это значение напрямую, используйте getDevicesPath() из settings-manager
export let DEVICES = process.env.CONTENT_ROOT || DEFAULT_DEVICES_PATH;

export function setDevicesPath(newPath) {
  if (!newPath || typeof newPath !== 'string') {
    return;
  }
  DEVICES = newPath;
}

// УСТАРЕВШЕЕ: Эти константы больше не используются
// Используйте функции из settings-manager.js вместо них
// Оставлены для обратной совместимости, но будут удалены в будущем
export const STREAMS_OUTPUT_DIR = path.join(DEFAULT_DATA_DIR, 'streams');
export const CONVERTED_CACHE = path.join(DEFAULT_DATA_DIR, 'converted');
export const LOGS_DIR = path.join(DEFAULT_DATA_DIR, 'logs');
export const TEMP_DIR = path.join(DEFAULT_DATA_DIR, 'temp');

// Пути к конфигурационным файлам
export const VIDEO_OPTIMIZATION_CONFIG_PATH = path.join(ROOT, 'config', 'video-optimization.json');

// Лимиты файлов
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB
export const ALLOWED_EXT = /\.(mp4|webm|ogg|mkv|mov|avi|mp3|wav|m4a|png|jpg|jpeg|gif|webp|pdf|pptx|zip)$/i;

// Сетевые настройки
export const PORT = process.env.PORT || 3000;
export const HOST = process.env.HOST || '127.0.0.1'; // 127.0.0.1 для server (Nginx в том же контейнере), 0.0.0.0 для воркеров

