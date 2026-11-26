/**
 * Перенос данных при смене contentRoot.
 *
 * Раньше смена корня обновляла только пути в БД: файлы оставались на старом
 * месте, а приложение начинало искать их в новом. Здесь данные сначала
 * копируются (локальные каталоги и/или объекты S3) и только после успешной
 * проверки вызывающий код обновляет настройки и БД. Старый корень не удаляем:
 * это бесплатная резервная копия на случай ошибки.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createModuleLogger } from '../utils/logger.js';
import { isLocalStorage } from './sync.js';
import { probeStorageKey } from './probe.js';

const logger = createModuleLogger('storage');

// Каталоги, которые составляют содержимое data-root. temp/ можно потерять,
// но копируем и его: там могут лежать незавершённые загрузки.
const DATA_SUBDIRS = ['content', 'converted', 'streams', 'logs', 'temp'];

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function pathKind(targetPath) {
  try {
    const stat = await fsp.stat(targetPath);
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function collectFiles(rootDir, relativeDir = '') {
  const dir = path.join(rootDir, relativeDir);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const rel = path.join(relativeDir, entry.name);
    const full = path.join(rootDir, rel);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(rootDir, rel));
    } else if (entry.isFile()) {
      files.push({ rel, size: (await fsp.stat(full)).size });
    }
  }

  return files;
}

/**
 * Копирование локальных каталогов без перезаписи конфликтующих файлов.
 * Если в новом корне уже лежит другой файл с тем же именем — это ошибка,
 * а не повод молча затереть данные.
 */
async function migrateLocalDirectories(oldRoot, newRoot) {
  let copied = 0;
  let skipped = 0;
  let bytes = 0;

  for (const subdir of DATA_SUBDIRS) {
    const sourceDir = path.join(oldRoot, subdir);
    const targetDir = path.join(newRoot, subdir);

    const sourceKind = await pathKind(sourceDir);
    if (sourceKind === 'missing') continue;
    if (sourceKind !== 'directory') {
      throw new Error(`Ожидался каталог ${sourceDir}, найден ${sourceKind}`);
    }

    const files = await collectFiles(sourceDir);
    for (const file of files) {
      const targetPath = path.join(targetDir, file.rel);
      const targetKind = await pathKind(targetPath);
      if (targetKind === 'missing') continue;
      if (targetKind !== 'file') {
        throw new Error(`В новом contentRoot ${targetPath} уже существует и не является файлом`);
      }
      const targetSize = (await fsp.stat(targetPath)).size;
      if (targetSize !== file.size) {
        throw new Error(
          `В новом contentRoot уже есть другой файл ${targetPath} ` +
          `(${targetSize} байт вместо ${file.size}); перенос отменён`
        );
      }
    }

    await fsp.mkdir(targetDir, { recursive: true });
    for (const file of files) {
      const sourcePath = path.join(sourceDir, file.rel);
      const targetPath = path.join(targetDir, file.rel);
      if (await pathKind(targetPath) === 'missing') {
        await fsp.mkdir(path.dirname(targetPath), { recursive: true });
        await fsp.copyFile(sourcePath, targetPath);
        copied += 1;
        bytes += file.size;
      } else {
        skipped += 1;
      }
    }

    // Проверяем каждый файл: копирование не считается успешным, пока
    // получатель не совпадает по размеру с источником.
    for (const file of files) {
      const targetPath = path.join(targetDir, file.rel);
      const targetSize = (await fsp.stat(targetPath)).size;
      if (targetSize !== file.size) {
        throw new Error(
          `Копирование не подтверждено для ${targetPath}: ` +
          `ожидалось ${file.size}, получено ${targetSize}`
        );
      }
    }
  }

  return { copied, skipped, bytes };
}

function sameBucket(source, target) {
  return source?.bucket && target?.bucket && source.bucket === target.bucket;
}

async function copyObject(source, target, key) {
  if (typeof target.copyFrom === 'function' && sameBucket(source, target)) {
    await target.copyFrom(source, key, key);
    return;
  }

  if (typeof target.writeStream === 'function' && typeof source.createReadStream === 'function') {
    const stream = await source.createReadStream(key);
    await target.writeStream(key, stream);
    return;
  }

  const data = await source.read(key);
  await target.write(key, data);
}

/**
 * Копирование всех объектов старого S3-префикса в новый.
 * Каждый объект проверяется после копирования и сверяется по размеру.
 */
async function migrateS3Objects(sourceStorage, targetStorage) {
  const keys = await sourceStorage.list('');
  let copied = 0;
  let skipped = 0;
  let bytes = 0;

  for (const key of keys) {
    if (!key || key.endsWith('/')) continue;

    const sourceStat = await sourceStorage.stat(key);
    const sourceSize = Number(sourceStat?.size);
    const targetProbe = await probeStorageKey(targetStorage, key);

    if (targetProbe.state === 'present') {
      const targetSize = Number(targetProbe.stat?.size);
      if (Number.isFinite(sourceSize) && Number.isFinite(targetSize) && sourceSize === targetSize) {
        skipped += 1;
        continue;
      }
      throw new Error(
        `В новом хранилище уже есть другой объект ${key} ` +
        `(${targetSize} байт вместо ${sourceSize}); перенос отменён`
      );
    }

    if (targetProbe.state === 'unknown') {
      throw new Error(
        `Не удалось проверить объект ${key} в новом хранилище: ` +
        `${targetProbe.error?.message || 'неизвестная ошибка'}`
      );
    }

    await copyObject(sourceStorage, targetStorage, key);

    const verify = await probeStorageKey(targetStorage, key);
    if (verify.state !== 'present') {
      throw new Error(
        `Копирование объекта ${key} не подтверждено ` +
        `(${verify.state}${verify.error ? `: ${verify.error.message}` : ''})`
      );
    }
    const targetSize = Number(verify.stat?.size);
    if (Number.isFinite(sourceSize) && Number.isFinite(targetSize) && sourceSize !== targetSize) {
      throw new Error(
        `Размер объекта ${key} после копирования не совпадает: ` +
        `источник ${sourceSize}, получатель ${targetSize}`
      );
    }

    copied += 1;
    bytes += Number.isFinite(sourceSize) ? sourceSize : 0;
  }

  return { copied, skipped, bytes };
}

/**
 * Перенести данные из старого contentRoot в новый.
 *
 * @param {object} options
 * @param {string} options.oldRoot
 * @param {string} options.newRoot
 * @param {object|null} [options.sourceStorage]  провайдер старого корня
 * @param {object|null} [options.targetStorage]  провайдер нового корня
 * @returns {Promise<{local: object, remote: object|null}>}
 */
export async function migrateContentRoot({ oldRoot, newRoot, sourceStorage = null, targetStorage = null }) {
  const resolvedOld = path.resolve(String(oldRoot || ''));
  const resolvedNew = path.resolve(String(newRoot || ''));

  if (!resolvedOld || !resolvedNew) {
    throw new Error('Не указан старый или новый contentRoot');
  }

  if (resolvedOld === resolvedNew) {
    return { local: { copied: 0, skipped: 0, bytes: 0 }, remote: null };
  }

  if (isInside(resolvedOld, resolvedNew) || isInside(resolvedNew, resolvedOld)) {
    throw new Error('Новый contentRoot не должен находиться внутри старого (или наоборот)');
  }

  logger.info('[Storage] Starting contentRoot migration', {
    oldRoot: resolvedOld,
    newRoot: resolvedNew
  });

  const local = await migrateLocalDirectories(resolvedOld, resolvedNew);

  let remote = null;
  const sourceIsRemote = sourceStorage && !isLocalStorage(sourceStorage);
  const targetIsRemote = targetStorage && !isLocalStorage(targetStorage);
  if (sourceIsRemote || targetIsRemote) {
    if (!sourceIsRemote || !targetIsRemote) {
      throw new Error('Нельзя переносить данные между локальным и удалённым хранилищем автоматически');
    }
    remote = await migrateS3Objects(sourceStorage, targetStorage);
  }

  logger.info('[Storage] contentRoot migration completed', {
    oldRoot: resolvedOld,
    newRoot: resolvedNew,
    local,
    remote
  });

  return { local, remote };
}
