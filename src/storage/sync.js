/**
 * Синхронизация между локальным диском и S3-совместимым хранилищем.
 *
 * Схема хранения: источником истины является S3. Локальный диск используется
 * только как временная рабочая область: multer пишет в неё файл, мы его
 * проверяем/конвертируем и коммитим в S3, после чего локальная копия
 * удаляется. Всё, что требует обработки (ffmpeg, ffprobe, конвертеры,
 * трейлеры), материализуется из S3 во временную папку.
 *
 * Ключевой принцип: локальный файл НИКОГДА не считается успешно сохранённым,
 * пока объект не появился в хранилище. Раньше ошибки загрузки глотались
 * пустым catch, и файл молча оставался только на диске.
 *
 * @module storage/sync
 */

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getDataRoot, getTempDir } from '../config/settings-manager.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('storage');

/**
 * Является ли хранилище локальным (файловая система).
 * Для локального бэкенда синхронизация не нужна — файл уже на месте.
 */
export function isLocalStorage(storage) {
  if (!storage) return true;
  if (storage.isLocal === true) return true;
  const ctorName = storage.constructor?.name || '';
  return ctorName === 'LocalStorage';
}

/**
 * Преобразовать абсолютный путь в ключ хранилища.
 * @throws {Error} если путь вне data root
 */
export function toStorageKey(absPath) {
  const root = getDataRoot();
  const rel = path.relative(root, path.resolve(String(absPath)));
  if (rel.startsWith('..')) throw new Error('Path outside data root');
  return rel;
}

/**
 * Загрузить локальный файл в S3 и проверить результат.
 *
 * @param {string} localPath  абсолютный путь к файлу
 * @param {object} storage    экземпляр StorageProvider
 * @param {object} [options]
 * @param {boolean} [options.force]  перезалить даже если размер совпадает
 * @param {boolean} [options.removeLocal]  удалить локальную копию после успеха
 * @returns {Promise<{synced: boolean, key?: string, reason?: string, size?: number|null}>}
 */
export async function syncFileToStorage(localPath, storage, options = {}) {
  const { force = false, removeLocal = false, deviceId = null, fileName = null } = options;

  if (!storage || isLocalStorage(storage)) {
    return { synced: false, reason: 'local-storage' };
  }

  if (!localPath || !fs.existsSync(localPath)) {
    return { synced: false, reason: 'file-missing' };
  }

  let key;
  try {
    key = toStorageKey(localPath);
  } catch (error) {
    return { synced: false, reason: 'path-outside-data-root', error: error.message };
  }

  const localSize = fs.statSync(localPath).size;

  // Уже лежит в хранилище и размер совпадает — не перезаливаем
  try {
    if (!force && await storage.exists(key)) {
      const stat = await storage.stat(key).catch(() => null);
      if (stat && Number(stat.size) === localSize) {
        const localRemoved = removeLocal ? await removeLocalCopy(localPath, key) : false;
        return { synced: true, key, skipped: true, size: localSize, localRemoved };
      }
    }
  } catch {
    // Проверка не критична — если не удалось, просто зальём заново
  }

  await uploadStream(storage, key, localPath);

  // КРИТИЧНО: «успешная» загрузка без объекта в хранилище — это ошибка.
  // Без этой проверки файл молча оставался только на диске.
  const stored = await storage.exists(key);
  if (!stored) {
    throw new Error(`Объект не появился в хранилище после загрузки: ${key}`);
  }

  const stat = await storage.stat(key).catch(() => null);

  // КРИТИЧНО: существование объекта не доказывает целостность. Обрыв
  // потока на середине (сеть, рестарт MinIO) оставляет в хранилище
  // усечённый объект, который раньше молча помечался как успешная загрузка:
  // видео на 2 ГБ «загружалось», а воспроизвести его было невозможно.
  const storedSize = Number(stat?.size);
  if (Number.isFinite(localSize) && Number.isFinite(storedSize) && storedSize !== localSize) {
    throw new Error(
      `Размер в хранилище не совпадает с локальным для ${key}: ` +
      `локально ${localSize}, в хранилище ${storedSize}`
    );
  }

  const localRemoved = removeLocal ? await removeLocalCopy(localPath, key) : false;

  logger.info('[StorageSync] Файл загружен в S3', {
    deviceId,
    fileName,
    key,
    localSize,
    storedSize: stat?.size ?? null,
    localRemoved
  });

  return { synced: true, key, size: stat?.size ?? null, localRemoved };
}

/**
 * Потоковая загрузка: память не растёт вместе с размером файла.
 * Никогда не читать файл целиком через readFileSync — на видео в 2 ГБ это
 * синхронное выделение памяти размером с файл, которое блокирует event loop.
 */
async function uploadStream(storage, key, localPath) {
  const size = fs.statSync(localPath).size;

  if (typeof storage.writeStream === 'function') {
    await storage.writeStream(key, fs.createReadStream(localPath));
    return;
  }

  if (typeof storage.uploadStream === 'function') {
    await storage.uploadStream(key, fs.createReadStream(localPath), { size });
    return;
  }

  // Фолбэк: write() понимает только Buffer. Полное чтение допустимо только
  // для мелких файлов, дальше это вернётся к проблеме с памятью.
  if (size <= 32 * 1024 * 1024) {
    await storage.write(key, await fs.promises.readFile(localPath));
    return;
  }

  throw new Error(
    `Хранилище не поддерживает потоковую загрузку (${storage.constructor?.name || 'unknown'}), ` +
    `файл ${size} байт не может быть загружен безопасно`
  );
}

/**
 * Скачать файл из хранилища в локальный путь.
 * Нужно всему, что работает с файловой системой: ffmpeg, ffprobe,
 * конвертеры, генератор трейлеров.
 *
 * @returns {Promise<string|null>} локальный путь, либо null если файл недоступен
 */
export async function materializeToLocal(localPath, storage, options = {}) {
  const { deviceId = null, fileName = null, sourcePath = null } = options;

  if (!localPath) return null;

  // Если путь назначения совпадает с источником и файл уже на диске,
  // материализация не нужна. При разных путях (скачивание во временную
  // рабочую область) проверять нечего — файла там ещё нет.
  const samePath = !sourcePath || path.resolve(sourcePath) === path.resolve(localPath);
  if (samePath && fs.existsSync(localPath)) return localPath;

  if (!storage || isLocalStorage(storage)) {
    logger.warn('[StorageSync] Файл отсутствует локально и нет S3-хранилища', {
      deviceId, fileName, localPath
    });
    return null;
  }

  // Ключ всегда строится от логического пути файла в хранилище, а не от
  // назначения: скачивание во временную папку не должно искать объект
  // по ключу самой временной папки.
  let key;
  try {
    key = toStorageKey(sourcePath || localPath);
  } catch (error) {
    logger.error('[StorageSync] Невозможно построить ключ хранилища', {
      deviceId, fileName, localPath, error: error.message
    });
    return null;
  }

  const expectedStat = await storage.stat(key).catch(() => null);
  if (!expectedStat || !(await storage.exists(key).catch(() => false))) {
    logger.error('[StorageSync] Файл не найден в хранилище', { deviceId, fileName, key });
    return null;
  }

  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  // Качаем во временный файл рядом и переименовываем только после успеха.
  // Прямая запись в localPath при обрыве сети оставила бы на диске
  // усечённый файл, который затем молча отдавался бы устройству как рабочий.
  const partPath = `${localPath}.${process.pid}.part`;

  try {
    const readStream = await storage.createReadStream(key);
    await pipeline(readStream, fs.createWriteStream(partPath));

    const expectedSize = Number(expectedStat.size);
    const actualSize = fs.statSync(partPath).size;
    if (Number.isFinite(expectedSize) && expectedSize > 0 && actualSize !== expectedSize) {
      throw new Error(`Размер не совпал после скачивания: ожидалось ${expectedSize}, получено ${actualSize}`);
    }

    fs.renameSync(partPath, localPath);
  } catch (error) {
    try {
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    } catch {
      // Частичный файл мог исчезнуть сам
    }
    logger.error('[StorageSync] Не удалось скачать файл из хранилища', {
      deviceId, fileName, key, error: error.message
    });
    return null;
  }

  logger.info('[StorageSync] Файл скачан из S3 для обработки', {
    deviceId,
    fileName,
    key,
    sizeMB: (fs.statSync(localPath).size / 1024 / 1024).toFixed(2)
  });

  return localPath;
}

/**
 * Удалить локальную копию файла после успешного коммита в S3.
 * Ошибка удаления не критична: файл уже в хранилище, чтение сработает
 * через storage.
 */
export async function removeLocalCopy(localPath, key = null) {
  try {
    if (localPath && fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
      logger.debug('[StorageSync] Локальная копия удалена', { key, localPath });
      return true;
    }
  } catch (error) {
    logger.warn('[StorageSync] Не удалось удалить локальную копию', {
      key, localPath, error: error.message
    });
  }
  return false;
}

/**
 * Путь во временной рабочей области (вне devices/, чтобы не попасть
 * в список файлов и не конфликтовать с содержимым).
 */
export function createScratchPath(prefix, fileName = '') {
  const dir = path.join(getTempDir(), 'scratch', prefix);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(String(fileName || 'file'));
  return path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${base}`);
}

/**
 * Очистить временную рабочую область от старых файлов.
 * Вызывается при старте: после падения оптимизации 2 ГБ мусор мог остаться.
 */
export function cleanupScratchDir(maxAgeMs = 6 * 60 * 60 * 1000) {
  const dir = path.join(getTempDir(), 'scratch');
  if (!fs.existsSync(dir)) return { removed: 0 };

  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;

  for (const subDir of fs.readdirSync(dir, { withFileTypes: true })) {
    const subPath = path.join(dir, subDir.name);
    if (!subDir.isDirectory()) continue;

    for (const entry of fs.readdirSync(subPath, { withFileTypes: true })) {
      const entryPath = path.join(subPath, entry.name);
      try {
        const stat = fs.statSync(entryPath);
        if (stat.mtimeMs < cutoff) {
          if (entry.isDirectory()) {
            fs.rmSync(entryPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(entryPath);
          }
          removed++;
        }
      } catch {
        // Файл мог исчезнуть между чтением каталога и удалением
      }
    }
  }

  if (removed > 0) {
    logger.info('[StorageSync] Очищена временная рабочая область', { removed });
  }
  return { removed };
}

/**
 * Скопировать папку с источника на цель — в хранилище и/или на диске.
 *
 * После перехода на S3-primary папки на диске закономерно нет: содержимое
 * живёт префиксом ключей в бакете, и fs.promises.cp падал с ENOENT
 * («lstat /app/data/content/<src>/<folder>»), из-за чего перенос папки
 * между устройствами возвращал 500. Здесь объекты копируются по одному
 * через storage.copy(), локальная копия — отдельно.
 *
 * Обе фазы идут поштучно, чтобы вызывающий код могла показывать прогресс:
 * при сотнях файлов перенос занимает минуты, а раньше пользователь не видел
 * ничего до самого конца.
 *
 * @param {string} sourcePath  абсолютный путь к исходной папке
 * @param {string} targetPath  абсолютный путь к папке-получателю
 * @param {object|null} storage  экземпляр StorageProvider
 * @param {object} [options]
 * @param {(p: {phase: 'prepare'|'storage'|'disk', done: number, total: number, file: string}) => void} [options.onProgress]
 * @returns {Promise<{copiedInStorage: number, copiedOnDisk: number}>}
 */
export async function copyFolderEverywhere(sourcePath, targetPath, storage, options = {}) {
  const { onProgress = null } = options;
  const emit = (payload) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress(payload);
      } catch (error) {
        logger.debug('[copy-folder] Ошибка колбэка прогресса', { error: error.message });
      }
    }
  };

  const sourceOnDisk = fs.existsSync(sourcePath);
  let storageKeys = [];
  let sourcePrefix = null;
  let copiedInStorage = 0;

  if (storage && !isLocalStorage(storage)) {
    sourcePrefix = `${toStorageKey(sourcePath).replace(/\\/g, '/')}/`;
    storageKeys = ((await storage.list(sourcePrefix)) || [])
      .filter(key => key.startsWith(sourcePrefix) && !key.endsWith('/'));

    if (storageKeys.length === 0 && !sourceOnDisk) {
      throw new Error(`Исходная папка не найдена в хранилище: ${sourcePrefix}`);
    }
  }

  const diskFiles = sourceOnDisk ? await countFiles(sourcePath) : [];

  // Папка зеркалится: объекты в бакете и файлы на диске — один и тот же
  // набор. Это одна работа, а не две — иначе прогресс показывал бы «90 из 90»
  // при 45 файлах папки. В зеркальном случае каждый файл копируется в оба
  // места за один проход, и счётчик соответствует числу файлов.
  const mirrored = storageKeys.length > 0
    && sourceOnDisk
    && storageKeys.length === diskFiles.length
    && sameRelSets(storageKeys.map(key => key.slice(sourcePrefix.length)), diskFiles);

  const total = mirrored ? storageKeys.length : storageKeys.length + diskFiles.length;
  emit({ phase: 'prepare', done: 0, total, file: path.basename(sourcePath) });

  let done = 0;
  let copiedOnDisk = 0;

  if (mirrored) {
    const targetPrefix = `${toStorageKey(targetPath).replace(/\\/g, '/')}/`;
    await fs.promises.mkdir(targetPath, { recursive: true });
    for (const key of storageKeys) {
      const rel = key.slice(sourcePrefix.length);
      await storage.copy(key, targetPrefix + rel);
      await copyOneFile(sourcePath, targetPath, rel);
      copiedInStorage += 1;
      copiedOnDisk += 1;
      done += 1;
      emit({ phase: 'disk', done, total, file: rel });
    }
    try {
      await fs.promises.chmod(targetPath, 0o755);
    } catch (error) {
      logger.debug('[copy-folder] Не удалось выставить права на копию', { targetPath, error: error.message });
    }
  } else if (storageKeys.length > 0) {
    const targetPrefix = `${toStorageKey(targetPath).replace(/\\/g, '/')}/`;
    for (const key of storageKeys) {
      await storage.copy(key, targetPrefix + key.slice(sourcePrefix.length));
      copiedInStorage += 1;
      done += 1;
      emit({ phase: 'storage', done, total, file: key.slice(sourcePrefix.length) });
    }
  }

  if (!mirrored && sourceOnDisk) {
    await copyTree(sourcePath, targetPath, (file) => {
      copiedOnDisk += 1;
      done += 1;
      emit({ phase: 'disk', done, total, file });
    });
    try {
      await fs.promises.chmod(targetPath, 0o755);
    } catch (error) {
      logger.debug('[copy-folder] Не удалось выставить права на копию', { targetPath, error: error.message });
    }

    // Копия существует только на диске — докладываем её в бакет,
    // иначе на устройстве-получателе содержимого в S3 не будет
    if (storage && !isLocalStorage(storage)) {
      const commit = await commitFolderToStorage(targetPath, storage, { removeLocal: false });
      if (!commit.synced && commit.reason !== 'local-storage') {
        logger.warn('[copy-folder] Не удалось залить копию папки в хранилище', {
          targetPath, reason: commit.reason, failed: commit.failed?.length || 0
        });
      }
    }
  } else if (copiedInStorage === 0) {
    throw new Error(`Исходная папка не найдена: ${sourcePath}`);
  }

  if (total > 0 && done < total) {
    emit({ phase: 'disk', done: total, total, file: '' });
  }

  return { copiedInStorage, copiedOnDisk };
}

/** Одинаковый ли набор файлов у объектов бакета и локальных файлов папки. */
function sameRelSets(a, b) {
  const norm = value => String(value).replace(/\\/g, '/');
  const aSet = [...new Set(a.map(norm))].sort();
  const bSet = [...new Set(b.map(norm))].sort();
  if (aSet.length !== bSet.length) return false;
  for (let i = 0; i < aSet.length; i++) {
    if (aSet[i] !== bSet[i]) return false;
  }
  return true;
}

/**
 * Скопировать один файл папки на диск, создав вложенные папки при
 * необходимости. Используется в зеркальном проходе, где объект уже
 * скопирован в бакет, а локальная копия делается здесь же.
 */
async function copyOneFile(sourceDir, targetDir, rel) {
  const to = path.join(targetDir, rel);
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.copyFile(path.join(sourceDir, rel), to);
}

/** Относительные пути всех файлов в папке (для подсчёта объёма работы). */
async function countFiles(dir) {
  const found = [];
  const walk = async (current) => {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        found.push(path.relative(dir, full));
      }
    }
  };
  await walk(dir);
  return found;
}

/**
 * Рекурсивная копия файла за файлом вместо fs.cp одной операцией:
 * на сотнях файлов иначе прогресса не видно вообще.
 */
async function copyTree(sourceDir, targetDir, onFile) {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to, onFile);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(from, to);
      onFile(entry.name);
    }
  }
}


/**
 * Рекурсивно закоммитить содержимое папки в хранилище.
 *
 * Нужно для результатов конвертации: PDF/PPTX/ZIP превращаются в папку
 * со слайдами, и без этого в S3 попадал бы только исходник, а сами
 * изображения оставались бы только на диске.
 *
 * @param {string} folderPath  абсолютный путь к папке
 * @param {object} storage  экземпляр StorageProvider
 * @param {object} [options]
 * @param {boolean} [options.removeLocal]  удалить локальные копии после загрузки
 * @param {number} [options.maxFiles]  предохранитель от бесконечного обхода
 * @returns {Promise<{synced: boolean, count?: number, failed: string[], reason?: string}>}
 */
export async function commitFolderToStorage(folderPath, storage, options = {}) {
  const { removeLocal = false, maxFiles = 5000 } = options;

  if (!storage || isLocalStorage(storage)) {
    return { synced: false, count: 0, failed: [], reason: 'local-storage' };
  }

  if (!folderPath || !fs.existsSync(folderPath)) {
    return { synced: false, count: 0, failed: [], reason: 'folder-missing' };
  }

  const failed = [];
  let count = 0;

  const walk = async (dir) => {
    if (count >= maxFiles) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= maxFiles) return;

      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }

      if (!entry.isFile()) continue;

      try {
        const result = await syncFileToStorage(entryPath, storage, {
          force: true,
          removeLocal
        });
        if (result.synced) {
          count++;
        } else {
          failed.push(entryPath);
        }
      } catch (error) {
        failed.push(entryPath);
        logger.error('[StorageSync] Не удалось загрузить файл из папки', {
          entryPath, error: error.message
        });
      }
    }
  };

  try {
    await walk(folderPath);
  } catch (error) {
    logger.error('[StorageSync] Ошибка обхода папки', { folderPath, error: error.message });
    return { synced: false, count, failed, reason: 'walk-failed' };
  }

  // Удаляем саму папку, только если в ней больше не осталось файлов
  if (removeLocal && count > 0 && failed.length === 0) {
    try {
      fs.rmSync(folderPath, { recursive: true, force: true });
      logger.info('[StorageSync] Локальная папка удалена после коммита', { folderPath, count });
    } catch (error) {
      logger.warn('[StorageSync] Не удалось удалить локальную папку', {
        folderPath, error: error.message
      });
    }
  }

  logger.info('[StorageSync] Папка закоммичена в S3', { folderPath, count, failed: failed.length });

  return { synced: failed.length === 0, count, failed };
}
