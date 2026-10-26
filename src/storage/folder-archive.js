/**
 * Упаковка папок в ZIP и выгрузка папок из хранилища.
 *
 * S3-primary: папки (слайды PDF/PPTX, галереи) на диске могут отсутствовать —
 * они живут префиксом ключей в бакете. Перед архивацией их нужно скачать во
 * временный каталог. Валидация источника при этом должна идти относительно
 * этого временного каталога, а не data root: иначе скачивание папки из S3
 * всегда падало с «Path traversal attempt detected».
 */

import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { pipeline } from 'node:stream/promises';
import { getDataRoot } from '../config/settings-manager.js';
import { toStorageKey } from './sync.js';
import { validatePath } from '../utils/path-validator.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('storage');

/**
 * Создать ZIP из каталога.
 *
 * @param {string} sourceFolderPath  каталог-источник
 * @param {string} outputZipPath      путь к будущему архиву
 * @param {object} [options]
 * @param {string} [options.sourceRoot]  корень, относительно которого валидируется источник
 * @param {string} [options.outputRoot]  корень для валидации архива (по умолчанию его каталог)
 * @returns {Promise<void>}
 */
export async function createZipArchiveFromFolder(sourceFolderPath, outputZipPath, options = {}) {
  const sourceRoot = options.sourceRoot || getDataRoot();
  const folderPath = validatePath(path.resolve(sourceFolderPath), sourceRoot);

  const resolvedOutput = path.resolve(outputZipPath);
  const outputRoot = options.outputRoot || path.dirname(resolvedOutput);
  const safeOutputZipPath = validatePath(resolvedOutput, outputRoot);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(safeOutputZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (error) => {
      // ENOENT при обходе каталога — не повод отдавать битый архив молча,
      // но и не ошибка уровня reject: archiver уже положил файл в warning.
      if (error.code === 'ENOENT') {
        logger.warn('[folder-archive] Файл исчез во время архивации', { error: error.message });
      } else {
        reject(error);
      }
    });

    archive.pipe(output);
    archive.directory(folderPath, false);
    archive.finalize();
  });
}

/**
 * Скачать содержимое папки из хранилища во временный каталог.
 *
 * @param {string} folderPath  логический путь папки (под data root)
 * @param {string} targetDir   существующий временный каталог
 * @param {object} storage     StorageProvider
 * @returns {Promise<number>}  количество скачанных файлов
 */
export async function downloadFolderFromStorage(folderPath, targetDir, storage) {
  if (!storage) throw new Error('Storage provider is required');

  const prefix = `${toStorageKey(folderPath).replace(/\\/g, '/')}/`;
  const keys = (await storage.list(prefix)) || [];
  const safeRoot = fs.realpathSync(targetDir);
  let count = 0;

  for (const key of keys) {
    if (!key.startsWith(prefix) || key.endsWith('/')) continue;

    const relative = key.slice(prefix.length);
    if (!relative) continue;

    // validatePath() для ещё не существующего вложенного файла берёт
    // basename от ближайшего существующего родителя и теряет подкаталоги.
    // Поэтому сначала проверяем префикс, создаём родителя, и только потом
    // канонизируем путь (симлинки при этом всё ещё проверяются).
    const destination = path.resolve(safeRoot, relative);
    if (destination !== safeRoot && !destination.startsWith(safeRoot + path.sep)) {
      throw new Error(`Path traversal attempt detected: ${key}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const safeDestination = validatePath(destination, safeRoot);

    const readStream = await storage.createReadStream(key);
    try {
      await pipeline(readStream, fs.createWriteStream(safeDestination));
      count++;
    } catch (error) {
      // Частичный файл не должен попасть в архив.
      try {
        fs.unlinkSync(safeDestination);
      } catch {
        // файл мог не создаться вовсе
      }
      throw error;
    }
  }

  return count;
}
