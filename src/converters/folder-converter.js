/**
 * Конвертация ZIP архивов в папки с изображениями
 * @module converters/folder-converter
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import util from 'node:util';
import { getDevicesPath, getConvertedCache } from '../config/settings-manager.js';
import { getAnyFileMetadataBySafeName } from '../database/files-metadata.js';
import { makeSafeFolderName } from '../utils/transliterate.js';
import logger from '../utils/logger.js';

const execFileAsync = util.promisify(execFileCallback);

/**
 * Распаковать ZIP архив с изображениями в папку
 * @param {string} deviceId - ID устройства
 * @param {string} zipFileName - Имя ZIP файла
 * @param {string} deviceFolderName - Имя папки устройства (опционально, по умолчанию deviceId)
 * @returns {Promise<{success: boolean, error?: string, imagesCount?: number, folderName?: string, originalFolderName?: string}>}
 */
export async function extractZipToFolder(deviceId, zipFileName, deviceFolderName = null) {
  try {
    // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
    const devicesPath = getDevicesPath();
    const deviceFolder = path.join(devicesPath, deviceFolderName || deviceId);
    const zipPath = path.join(deviceFolder, zipFileName);
    
    if (!fs.existsSync(zipPath)) {
      return { success: false, error: 'ZIP file not found' };
    }
    
    // Создаем папку для изображений (без расширения .zip)
    const originalFolderName = zipFileName.replace(/\.zip$/i, '');
    const folderName = makeSafeFolderName(originalFolderName); // Транслитерация
    const outputFolder = path.join(deviceFolder, folderName);
    
    logger.info(`[FolderConverter] 📝 Имя папки: "${originalFolderName}" → "${folderName}"`, { deviceId, zipFileName, originalFolderName, folderName });
    
    // Если папка уже существует, удаляем её
    if (fs.existsSync(outputFolder)) {
      fs.rmSync(outputFolder, { recursive: true, force: true });
    }
    
    // Создаем новую папку
    fs.mkdirSync(outputFolder, { recursive: true });
    
    logger.info(`[FolderConverter] 📦 Распаковка ZIP: ${zipFileName} -> ${folderName}/`, { deviceId, zipFileName, folderName });
    
    // Распаковываем ZIP с помощью unzip (доступен на большинстве Linux систем)
    try {
      await execFileAsync('unzip', ['-q', zipPath, '-d', outputFolder]);
    } catch (err) {
      // Если unzip недоступен, пробуем 7z
      logger.info('[FolderConverter] unzip недоступен, пробую 7z...', { deviceId, zipFileName });
      await execFileAsync('7z', ['x', zipPath, `-o${outputFolder}`, '-y']);
    }
    
    // Проверяем, что внутри есть изображения
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const allFiles = [];
    
    function scanDirectory(dir) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          scanDirectory(fullPath);
        } else if (stat.isFile()) {
          const ext = path.extname(item).toLowerCase();
          if (imageExtensions.includes(ext)) {
            allFiles.push(fullPath);
          }
        }
      }
    }
    
    scanDirectory(outputFolder);
    
    if (allFiles.length === 0) {
      // Если изображений нет, удаляем папку и ZIP
      fs.rmSync(outputFolder, { recursive: true, force: true });
      fs.unlinkSync(zipPath);
      return { success: false, error: 'No images found in ZIP archive' };
    }
    
    // Сортируем изображения по имени
    allFiles.sort((a, b) => {
      const nameA = path.basename(a).toLowerCase();
      const nameB = path.basename(b).toLowerCase();
      return nameA.localeCompare(nameB, undefined, { numeric: true });
    });
    
    // КРИТИЧНО: Если изображения находятся в подпапках, перемещаем их в корень папки
    let movedCount = 0;
    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i];
      const relativePath = path.relative(outputFolder, file);
      
      // Если файл в подпапке
      if (relativePath.includes(path.sep)) {
        const ext = path.extname(file);
        const newName = `image_${String(i + 1).padStart(4, '0')}${ext}`;
        const newPath = path.join(outputFolder, newName);
        
        fs.renameSync(file, newPath);
        allFiles[i] = newPath;
        movedCount++;
      }
    }
    
    if (movedCount > 0) {
      logger.info(`[FolderConverter] 📁 Перемещено файлов из подпапок: ${movedCount}`, { deviceId, zipFileName, movedCount });
      
      // Удаляем пустые подпапки
      const subdirs = fs.readdirSync(outputFolder, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => path.join(outputFolder, dirent.name));
      
      for (const subdir of subdirs) {
        try {
          fs.rmSync(subdir, { recursive: true, force: true });
        } catch (e) {
          logger.warn(`[FolderConverter] ⚠️ Не удалось удалить подпапку ${subdir}`, { error: e.message, deviceId, zipFileName, subdir });
        }
      }
    }
    
    // Устанавливаем права на папку и все файлы внутри
    fs.chmodSync(outputFolder, 0o755);
    allFiles.forEach(file => {
      try {
        fs.chmodSync(file, 0o644);
      } catch (e) {
        logger.warn(`[FolderConverter] ⚠️ Не удалось установить права на ${file}`, { error: e.message, deviceId, zipFileName, file });
      }
    });
    
    // Удаляем исходный ZIP файл
    fs.unlinkSync(zipPath);
    
    logger.info(`[FolderConverter] ✅ ZIP распакован: ${allFiles.length} изображений`, { deviceId, zipFileName, imagesCount: allFiles.length, folderName });
    
    return { 
      success: true, 
      imagesCount: allFiles.length,
      folderName: folderName,
      originalFolderName: originalFolderName
    };
    
  } catch (error) {
    logger.error('[FolderConverter] ❌ Ошибка распаковки ZIP', { error: error.message, stack: error.stack, deviceId, zipFileName });
    return { success: false, error: error.message };
  }
}

/**
 * Получить список изображений в папке
 * @param {string} deviceId - ID устройства
 * @param {string} folderName - Имя папки
 * @returns {Promise<string[]>} Список файлов изображений
 */
export function resolveFolderPath(deviceId, folderName) {
  const devicesPath = getDevicesPath();
  const candidates = [];
  if (deviceId) {
    candidates.push(path.join(devicesPath, deviceId, folderName));
  }
  // общий корень
  candidates.push(path.join(devicesPath, folderName));
  // fallback: поиск по всем устройствам (одноуровневый обход)
  try {
    const entries = fs.readdirSync(devicesPath, { withFileTypes: true });
    entries
      .filter(e => e.isDirectory())
      .forEach(e => {
        candidates.push(path.join(devicesPath, e.name, folderName));
      });
  } catch (e) {
    // ignore
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch (e) {
      // ignore candidate
    }
  }

  // Fallback: ищем по метаданным (любое устройство)
  try {
    const meta = getAnyFileMetadataBySafeName(folderName);
    if (meta?.file_path && fs.existsSync(meta.file_path) && fs.statSync(meta.file_path).isDirectory()) {
      return meta.file_path;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

export async function getFolderImages(deviceId, folderName) {
  try {
    const folderPath = resolveFolderPath(deviceId, folderName);
    if (!folderPath) return { files: [], folderPath: null };

    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const files = fs.readdirSync(folderPath)
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return imageExtensions.includes(ext);
      })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    
    return { files, folderPath };
  } catch (error) {
    logger.error('[FolderConverter] ❌ Ошибка чтения папки', { error: error.message, stack: error.stack, deviceId, folderName });
    return { files: [], folderPath: null };
  }
}

/**
 * Получить количество изображений в папке
 * @param {string} deviceId - ID устройства
 * @param {string} folderName - Имя папки
 * @returns {Promise<number>} Количество изображений
 */
export async function getFolderImagesCount(deviceId, folderName) {
  const { files } = await getFolderImages(deviceId, folderName);
  return files.length;
}

/**
 * Найти папку для файла (если это папка с изображениями)
 * @param {string} deviceId - ID устройства
 * @param {string} fileName - Имя файла или папки
 * @returns {string|null} Путь к папке или null
 */
export function findImageFolder(deviceId, fileName) {
  try {
    // КРИТИЧНО: Используем getDevicesPath() для получения актуального пути
    const devicesPath = getDevicesPath();
    // Убираем расширение .zip если есть
    const baseName = fileName.replace(/\.zip$/i, '');
    const folderPath = path.join(devicesPath, deviceId, baseName);
    
    if (fs.existsSync(folderPath)) {
      const stat = fs.statSync(folderPath);
      if (stat.isDirectory()) {
        return folderPath;
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

