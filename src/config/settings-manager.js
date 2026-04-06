import fs from 'fs';
import path from 'path';
import { ROOT, DEFAULT_DEVICES_PATH, DEFAULT_DATA_ROOT, setDevicesPath, DEVICES } from './constants.js';

// КРИТИЧНО: НЕ импортируем logger здесь, так как это создает циклическую зависимость:
// logger.js -> settings-manager.js (getLogsDir) -> logger.js
// Вместо этого используем lazy import logger только в функциях, которые его используют

// Сохраняем текущий путь для отслеживания изменений
let currentContentRoot = DEFAULT_DATA_ROOT;

const SETTINGS_FILE = path.join(ROOT, 'config', 'app-settings.json');

// КРИТИЧНО: Инициализируем settings сразу, чтобы избежать ошибки "Cannot access 'settings' before initialization"
// Это важно, так как logger.js может использовать getLogsDir() до полной инициализации модуля
let settings = {
  contentRoot: process.env.CONTENT_ROOT || DEFAULT_DATA_ROOT
};

// КРИТИЧНО: Загружаем настройки из файла синхронно при загрузке модуля
// Это предотвращает ошибку "Cannot access 'settings' before initialization"
// НЕ используем logger здесь, так как он может создать циклическую зависимость
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    if (raw?.trim()) {
      const parsed = JSON.parse(raw);
      settings = {
        ...settings,
        ...parsed
      };
    }
  } else {
    // Создаем файл с настройками по умолчанию
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  }
} catch (error) {
  // Игнорируем ошибки при загрузке настроек при инициализации модуля
  // logger еще может быть не инициализирован
}

function safeWriteSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error) {
    // КРИТИЧНО: Используем lazy import logger, чтобы избежать циклической зависимости
    import('../utils/logger.js').then(({ default: logger }) => {
      logger.error('[Settings] Failed to persist settings', { error: error.message, stack: error.stack });
    }).catch(() => {
      // Игнорируем ошибки логирования
    });
  }
}

function ensureDirectory(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    throw new Error(`Не удалось создать папку: ${error.message}`);
  }
}

function loadSettingsFromFile() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      // Создаем файл с настройками по умолчанию
      safeWriteSettings();
      return;
    }

    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    if (raw?.trim()) {
      const parsed = JSON.parse(raw);
      settings = {
        ...settings,
        ...parsed
      };
    }
  } catch (error) {
    // КРИТИЧНО: Не используем logger здесь из-за циклической зависимости
    // Используем process.stderr для критических ошибок при загрузке модуля
    process.stderr.write(`[Settings] Failed to read settings file: ${error.message}\n`);
  }
}

export async function initializeSettings() {
  // КРИТИЧНО: loadSettingsFromFile() уже вызван при загрузке модуля
  // Но вызываем еще раз для обновления настроек при инициализации
  loadSettingsFromFile();
  const currentPath = settings.contentRoot || DEFAULT_DATA_ROOT;
  const normalizedPath = path.resolve(currentPath);
  
  // КРИТИЧНО: contentRoot - это корневая директория данных (например: /mnt/videocontrol-data/)
  // getDataRoot() возвращает contentRoot
  // getDevicesPath() возвращает contentRoot/content (создается автоматически)
  setDevicesPath(getDevicesPath());
  
  // КРИТИЧНО: Создаем все необходимые директории
  ensureDirectory(normalizedPath); // dataRoot (contentRoot из настроек)
  ensureDirectory(getDevicesPath()); // dataRoot/content (DEVICES)
  ensureDirectory(getStreamsOutputDir()); // dataRoot/streams
  ensureDirectory(getConvertedCache()); // dataRoot/converted
  ensureDirectory(getLogsDir()); // dataRoot/logs
  ensureDirectory(getTempDir()); // dataRoot/temp
  
  // КРИТИЧНО: Используем lazy import logger, чтобы избежать циклической зависимости
  const { default: logger } = await import('../utils/logger.js');
  
  // КРИТИЧНО: Проверяем и мигрируем пути в БД при старте, если нужно
  // Проверяем, отличается ли путь от значения по умолчанию
  const defaultDataRoot = DEFAULT_DATA_ROOT.replace(/\/+$/, '');
  const normalizedDefault = path.resolve(defaultDataRoot);
  if (normalizedPath !== normalizedDefault) {
    try {
      const { getAllFilePaths, migrateFilePaths } = await import('../database/files-metadata.js');
      const allPaths = getAllFilePaths();
      
      if (allPaths.length > 0) {
        // Проверяем первый путь чтобы понять, нужна ли миграция
        const firstPath = allPaths[0];
        const pathNormalized = normalizedPath.replace(/\/+$/, '');
        const firstPathRoot = firstPath.split('/').slice(0, -1).join('/'); // Путь без имени файла
        
        // Если пути начинаются с другого корня - мигрируем
        if (!firstPath.startsWith(pathNormalized)) {
          // Пробуем определить старый корень из первого пути
          // Например: /vid/videocontrol/public/content/video.mp4 -> /vid/videocontrol/public/content
          const oldRoot = firstPathRoot || DEFAULT_DATA_ROOT.replace(/\/+$/, '');
          
          logger.info(`[Settings] 🔄 Detected path mismatch, migrating: ${oldRoot} -> ${pathNormalized}`);
          const updated = migrateFilePaths(oldRoot, pathNormalized);
          if (updated > 0) {
            logger.info(`[Settings] ✅ Migrated ${updated} file paths on startup`);
          }
        }
      }
    } catch (error) {
      logger.warn('[Settings] Failed to check/migrate paths on startup', {
        error: error.message,
        stack: error.stack
      });
      // Не прерываем инициализацию при ошибке миграции
    }
  }
  
  currentContentRoot = normalizedPath;
  logger.info(`[Settings] 📁 Data root (contentRoot): ${normalizedPath}`);
  logger.info(`[Settings] 📁 Devices (content): ${getDevicesPath()}`);
  logger.info(`[Settings] 📁 Streams: ${getStreamsOutputDir()}`);
  logger.info(`[Settings] 📁 Converted: ${getConvertedCache()}`);
  logger.info(`[Settings] 📁 Logs: ${getLogsDir()}`);
  logger.info(`[Settings] 📁 Temp: ${getTempDir()}`);
}

/**
 * Получить корневой путь данных (contentRoot из настроек)
 * contentRoot - это корневая директория для всех данных (например: /mnt/videocontrol-data/)
 * Это единая точка входа для всех путей данных
 */
export function getDataRoot() {
  // Используем текущий contentRoot из настроек или значение по умолчанию
  const contentRoot = settings.contentRoot || currentContentRoot || DEFAULT_DATA_ROOT;
  return path.resolve(contentRoot);
}

/**
 * Получить путь к директории стримов (HLS)
 */
export function getStreamsOutputDir() {
  return path.join(getDataRoot(), 'streams');
}

/**
 * Получить путь к кэшу конвертированных файлов (PDF/PPTX)
 */
export function getConvertedCache() {
  return path.join(getDataRoot(), 'converted');
}

/**
 * Получить путь к директории логов
 */
export function getLogsDir() {
  return path.join(getDataRoot(), 'logs');
}

/**
 * Получить путь к директории временных файлов
 */
export function getTempDir() {
  return path.join(getDataRoot(), 'temp');
}

/**
 * Получить путь к контенту устройств (DEVICES)
 * contentRoot - это корневая директория данных (например: /mnt/videocontrol-data/)
 * getDevicesPath() возвращает contentRoot/content (например: /mnt/videocontrol-data/content)
 */
export function getDevicesPath() {
  return path.join(getDataRoot(), 'content');
}

export function getSettings() {
  return {
    ...settings,
    defaults: {
      contentRoot: DEFAULT_DATA_ROOT
    },
    runtime: {
      contentRoot: getDataRoot(), // Корневая директория данных из настроек
      devices: getDevicesPath(), // Путь к контенту устройств (contentRoot/content)
      dataRoot: getDataRoot(),
      streamsOutputDir: getStreamsOutputDir(),
      convertedCache: getConvertedCache(),
      logsDir: getLogsDir(),
      tempDir: getTempDir()
    }
  };
}

export async function updateContentRootPath(newPath) {
  if (!newPath || typeof newPath !== 'string') {
    throw new Error('Путь не указан');
  }

  const trimmed = newPath.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error('Укажите абсолютный путь (начинается с /)');
  }

  const normalized = path.resolve(trimmed);
  
  // КРИТИЧНО: Сохраняем старый путь для миграции
  const oldRoot = currentContentRoot || DEFAULT_DATA_ROOT;
  const normalizedOldRoot = oldRoot.replace(/\/+$/, '');
  const normalizedNewRoot = normalized.replace(/\/+$/, '');

  // Обновляем настройки
  settings.contentRoot = normalized;
  safeWriteSettings();
  setDevicesPath(getDevicesPath()); // contentRoot/content
  
  // КРИТИЧНО: Создаем все необходимые поддиректории
  ensureDirectory(normalized); // dataRoot (contentRoot из настроек)
  ensureDirectory(getDevicesPath()); // dataRoot/content (DEVICES)
  ensureDirectory(getStreamsOutputDir()); // dataRoot/streams
  ensureDirectory(getConvertedCache()); // dataRoot/converted
  ensureDirectory(getLogsDir()); // dataRoot/logs
  ensureDirectory(getTempDir()); // dataRoot/temp
  
  // КРИТИЧНО: Используем lazy import logger, чтобы избежать циклической зависимости
  const { default: logger } = await import('../utils/logger.js');
  
  logger.info(`[Settings] 📁 Created all data directories:`, {
    dataRoot: normalized,
    devices: getDevicesPath(),
    streams: getStreamsOutputDir(),
    converted: getConvertedCache(),
    logs: getLogsDir(),
    temp: getTempDir()
  });
  
  // КРИТИЧНО: Мигрируем пути в базе данных если путь изменился
  if (normalizedOldRoot !== normalizedNewRoot) {
    try {
      const { migrateFilePaths } = await import('../database/files-metadata.js');
      const updated = migrateFilePaths(normalizedOldRoot, normalizedNewRoot);
      
      if (updated > 0) {
        logger.info(`[Settings] ✅ Migrated ${updated} file paths in database`, {
          oldRoot: normalizedOldRoot,
          newRoot: normalizedNewRoot,
          updated
        });
      } else {
        logger.info(`[Settings] 🔄 Content root updated (no paths to migrate)`, {
          oldRoot: normalizedOldRoot,
          newRoot: normalizedNewRoot
        });
      }
    } catch (error) {
      logger.error('[Settings] Failed to migrate file paths', {
        error: error.message,
        stack: error.stack,
        oldRoot: normalizedOldRoot,
        newRoot: normalizedNewRoot
      });
      // НЕ прерываем выполнение - путь всё равно обновлен в настройках
    }
  } else {
    logger.info(`[Settings] 🔄 Content root updated (same path, no migration needed)`, {
      path: normalizedNewRoot
    });
  }

  currentContentRoot = normalized;
  
  logger.info(`[Settings] 📁 Updated paths:`, {
    dataRoot: normalized,
    streams: getStreamsOutputDir(),
    converted: getConvertedCache(),
    logs: getLogsDir(),
    temp: getTempDir()
  });
  
  return normalized;
}

// Инициализация при загрузке модуля (синхронная часть)
loadSettingsFromFile();
const initialPath = settings.contentRoot || DEFAULT_DATA_ROOT;
const normalizedInitialPath = path.resolve(initialPath);
ensureDirectory(normalizedInitialPath);
// Создаем поддиректории синхронно при загрузке модуля
try {
  ensureDirectory(path.join(normalizedInitialPath, 'content')); // DEVICES
  ensureDirectory(path.join(normalizedInitialPath, 'streams'));
  ensureDirectory(path.join(normalizedInitialPath, 'converted'));
  ensureDirectory(path.join(normalizedInitialPath, 'logs'));
  ensureDirectory(path.join(normalizedInitialPath, 'temp'));
} catch (error) {
  // Игнорируем ошибки при создании поддиректорий на этом этапе
  // Они будут созданы в initializeSettings()
}
setDevicesPath(path.join(normalizedInitialPath, 'content'));
currentContentRoot = normalizedInitialPath;

// Асинхронная миграция будет вызвана после инициализации БД

