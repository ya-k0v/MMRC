import fs from 'fs';
import path from 'path';
import { ROOT, DEFAULT_DEVICES_PATH, setDevicesPath, DEVICES } from './constants.js';
import logger from '../utils/logger.js';

// Сохраняем текущий путь для отслеживания изменений
let currentContentRoot = DEFAULT_DEVICES_PATH;

const SETTINGS_FILE = path.join(ROOT, 'config', 'app-settings.json');

let settings = {
  contentRoot: process.env.CONTENT_ROOT || DEFAULT_DEVICES_PATH
};

function safeWriteSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error) {
    logger.error('[Settings] Failed to persist settings', { error: error.message, stack: error.stack });
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
  if (!fs.existsSync(SETTINGS_FILE)) {
    // Создаем файл с настройками по умолчанию
    safeWriteSettings();
    return;
  }

  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    if (raw?.trim()) {
      const parsed = JSON.parse(raw);
      settings = {
        ...settings,
        ...parsed
      };
    }
  } catch (error) {
    logger.error('[Settings] Failed to read settings file', { error: error.message, stack: error.stack });
  }
}

export async function initializeSettings() {
  loadSettingsFromFile();
  const currentPath = settings.contentRoot || DEFAULT_DEVICES_PATH;
  ensureDirectory(currentPath);
  setDevicesPath(currentPath);
  
  // КРИТИЧНО: Проверяем и мигрируем пути в БД при старте, если нужно
  if (currentPath !== DEFAULT_DEVICES_PATH) {
    try {
      const { getAllFilePaths, migrateFilePaths } = await import('../database/files-metadata.js');
      const allPaths = getAllFilePaths();
      
      if (allPaths.length > 0) {
        // Проверяем первый путь чтобы понять, нужна ли миграция
        const firstPath = allPaths[0];
        const pathNormalized = currentPath.replace(/\/+$/, '');
        const firstPathRoot = firstPath.split('/').slice(0, -1).join('/'); // Путь без имени файла
        
        // Если пути начинаются с другого корня - мигрируем
        if (!firstPath.startsWith(pathNormalized)) {
          // Пробуем определить старый корень из первого пути
          // Например: /vid/videocontrol/public/content/video.mp4 -> /vid/videocontrol/public/content
          const oldRoot = firstPathRoot || DEFAULT_DEVICES_PATH.replace(/\/+$/, '');
          
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
  
  currentContentRoot = currentPath;
  logger.info(`[Settings] 📁 Content root: ${currentPath}`);
}

export function getSettings() {
  return {
    ...settings,
    defaults: {
      contentRoot: DEFAULT_DEVICES_PATH
    },
    runtime: {
      contentRoot: DEVICES
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
  ensureDirectory(normalized);

  // КРИТИЧНО: Сохраняем старый путь для миграции
  const oldRoot = currentContentRoot || DEVICES || DEFAULT_DEVICES_PATH;
  const normalizedOldRoot = oldRoot.replace(/\/+$/, '');
  const normalizedNewRoot = normalized.replace(/\/+$/, '');

  // Обновляем настройки
  settings.contentRoot = normalized;
  safeWriteSettings();
  setDevicesPath(normalized);
  
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
  return normalized;
}

// Инициализация при загрузке модуля (синхронная часть)
loadSettingsFromFile();
const initialPath = settings.contentRoot || DEFAULT_DEVICES_PATH;
ensureDirectory(initialPath);
setDevicesPath(initialPath);
currentContentRoot = initialPath;

// Асинхронная миграция будет вызвана после инициализации БД

