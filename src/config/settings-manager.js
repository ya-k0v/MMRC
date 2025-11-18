import fs from 'fs';
import path from 'path';
import { ROOT, DEFAULT_DEVICES_PATH, setDevicesPath, DEVICES } from './constants.js';

const SETTINGS_FILE = path.join(ROOT, 'config', 'app-settings.json');

let settings = {
  contentRoot: process.env.CONTENT_ROOT || DEFAULT_DEVICES_PATH
};

function safeWriteSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error) {
    console.error('[Settings] Failed to persist settings:', error.message);
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
    console.error('[Settings] Failed to read settings file:', error.message);
  }
}

export function initializeSettings() {
  loadSettingsFromFile();
  const currentPath = settings.contentRoot || DEFAULT_DEVICES_PATH;
  ensureDirectory(currentPath);
  setDevicesPath(currentPath);
  console.log(`[Settings] 📁 Content root: ${currentPath}`);
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

export function updateContentRootPath(newPath) {
  if (!newPath || typeof newPath !== 'string') {
    throw new Error('Путь не указан');
  }

  const trimmed = newPath.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error('Укажите абсолютный путь (начинается с /)');
  }

  const normalized = path.resolve(trimmed);
  ensureDirectory(normalized);

  settings.contentRoot = normalized;
  safeWriteSettings();
  setDevicesPath(normalized);
  console.log(`[Settings] 🔄 Content root updated: ${normalized}`);

  return normalized;
}

// Инициализация при загрузке модуля
initializeSettings();

