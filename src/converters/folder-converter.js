import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import util from 'node:util';
import crypto from 'node:crypto';
import os from 'node:os';
import { getDevicesPath, getConvertedCache, getDataRoot } from '../config/settings-manager.js';
import { getAnyFileMetadataBySafeName } from '../database/files-metadata.js';
import { makeSafeFolderName } from '../utils/transliterate.js';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('convert');

const execFileAsync = util.promisify(execFileCallback);

function toStorageKey(absPath) {
  const root = getDataRoot();
  const rel = path.relative(root, path.resolve(String(absPath)));
  if (rel.startsWith('..')) throw new Error('Path outside data root');
  return rel.replace(/\\/g, '/');
}

export async function extractZipToFolder(deviceId, zipFileName, deviceFolderName = null, storage = null) {
  try {
    const devicesPath = getDevicesPath();
    const deviceFolder = path.join(devicesPath, deviceFolderName || deviceId);
    const zipPath = path.join(deviceFolder, zipFileName);
    const originalFolderName = zipFileName.replace(/\.zip$/i, '');
    const folderName = makeSafeFolderName(originalFolderName);
    const outputFolder = path.join(deviceFolder, folderName);
    let needsCleanup = false;

    let zipAvailable = fs.existsSync(zipPath);
    if (!zipAvailable && storage) {
      try {
        const key = toStorageKey(zipPath);
        await storage.stat(key);
        const readStream = await storage.createReadStream(key);
        const writeStream = fs.createWriteStream(zipPath);
        await new Promise((resolve, reject) => {
          readStream.pipe(writeStream);
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
          readStream.on('error', reject);
        });
        zipAvailable = true;
        needsCleanup = true;
      } catch {
      }
    }

    if (!zipAvailable) {
      return { success: false, error: 'ZIP file not found' };
    }

    logger.info(`[FolderConverter] 📝 Имя папки: "${originalFolderName}" → "${folderName}"`, { deviceId, zipFileName, originalFolderName, folderName });

    if (fs.existsSync(outputFolder)) {
      fs.rmSync(outputFolder, { recursive: true, force: true });
    }

    fs.mkdirSync(outputFolder, { recursive: true });

    logger.info(`[FolderConverter] 📦 Распаковка ZIP: ${zipFileName} -> ${folderName}/`, { deviceId, zipFileName, folderName });

    try {
      await execFileAsync('unzip', ['-q', zipPath, '-d', outputFolder]);
    } catch (err) {
      logger.info('[FolderConverter] unzip недоступен, пробую 7z...', { deviceId, zipFileName });
      await execFileAsync('7z', ['x', zipPath, `-o${outputFolder}`, '-y']);
    }

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
      fs.rmSync(outputFolder, { recursive: true, force: true });
      fs.unlinkSync(zipPath);
      return { success: false, error: 'No images found in ZIP archive' };
    }

    allFiles.sort((a, b) => {
      const nameA = path.basename(a).toLowerCase();
      const nameB = path.basename(b).toLowerCase();
      return nameA.localeCompare(nameB, undefined, { numeric: true });
    });

    let movedCount = 0;
    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i];
      const relativePath = path.relative(outputFolder, file);

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

    fs.chmodSync(outputFolder, 0o755);
    allFiles.forEach(file => {
      try {
        fs.chmodSync(file, 0o644);
      } catch (e) {
        logger.warn(`[FolderConverter] ⚠️ Не удалось установить права на ${file}`, { error: e.message, deviceId, zipFileName, file });
      }
    });

    if (storage) {
      const outputKey = toStorageKey(outputFolder);
      try {
        for (const file of allFiles) {
          const fileKey = toStorageKey(file);
          const fileStream = fs.createReadStream(file);
          await storage.write(fileKey, fileStream);
        }
        logger.info(`[FolderConverter] ☁️ Загружено ${allFiles.length} изображений в storage`, { deviceId, zipFileName });
      } catch (uploadErr) {
        logger.warn(`[FolderConverter] ⚠️ Ошибка загрузки изображений в storage`, { error: uploadErr.message, deviceId, zipFileName });
      }
      try {
        const zipKey = toStorageKey(zipPath);
        await storage.delete(zipKey);
      } catch {
      }
    }

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

export async function resolveFolderPath(deviceId, folderName, storage = null) {
  const devicesPath = getDevicesPath();
  const candidates = [];
  if (deviceId) {
    candidates.push(path.join(devicesPath, deviceId, folderName));
  }
  candidates.push(path.join(devicesPath, folderName));
  try {
    const entries = fs.readdirSync(devicesPath, { withFileTypes: true });
    entries
      .filter(e => e.isDirectory())
      .forEach(e => {
        candidates.push(path.join(devicesPath, e.name, folderName));
      });
  } catch (e) {
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch (e) {
    }
  }

  if (storage) {
    for (const candidate of candidates) {
      try {
        const prefix = toStorageKey(candidate);
        const entries = await storage.list(prefix);
        const hasImages = entries.some(e => /\.(png|jpg|jpeg|gif|webp)$/i.test(e));
        if (hasImages) {
          return candidate;
        }
      } catch {
      }
    }
  }

  try {
    const meta = await getAnyFileMetadataBySafeName(folderName);
    if (meta?.file_path && fs.existsSync(meta.file_path) && fs.statSync(meta.file_path).isDirectory()) {
      return meta.file_path;
    }
  } catch (e) {
  }
  return null;
}

export async function getFolderImages(deviceId, folderName, storage = null) {
  try {
    const folderPath = await resolveFolderPath(deviceId, folderName, storage);
    if (!folderPath) return { files: [], folderPath: null };

    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

    if (fs.existsSync(folderPath)) {
      const files = fs.readdirSync(folderPath)
        .filter(file => {
          const ext = path.extname(file).toLowerCase();
          return imageExtensions.includes(ext);
        })
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return { files, folderPath };
    }

    if (storage) {
      try {
        const prefix = toStorageKey(folderPath);
        const entries = await storage.list(prefix);
        const files = entries
          .filter(e => {
            const ext = path.extname(e).toLowerCase();
            return imageExtensions.includes(ext);
          })
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        return { files, folderPath };
      } catch {
      }
    }

    return { files: [], folderPath: null };
  } catch (error) {
    logger.error('[FolderConverter] ❌ Ошибка чтения папки', { error: error.message, stack: error.stack, deviceId, folderName });
    return { files: [], folderPath: null };
  }
}

export async function getFolderImagesCount(deviceId, folderName, storage = null) {
  const { files } = await getFolderImages(deviceId, folderName, storage);
  return files.length;
}

export function findImageFolder(deviceId, fileName, storage = null) {
  try {
    const devicesPath = getDevicesPath();
    const baseName = fileName.replace(/\.zip$/i, '');
    const folderPath = path.join(devicesPath, deviceId, baseName);

    if (fs.existsSync(folderPath)) {
      const stat = fs.statSync(folderPath);
      if (stat.isDirectory()) {
        return folderPath;
      }
    }

    if (storage) {
      try {
        const prefix = toStorageKey(folderPath);
        const entries = storage.listSync ? storage.listSync(prefix) : null;
        if (entries && entries.length > 0) {
          return folderPath;
        }
      } catch {
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}
