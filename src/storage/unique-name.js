/**
 * Подбор свободного имени в общем content-root.
 *
 * Раньше проверялся только локальный файл `content/<safeName>`. Папка с тем
 * же именем, объект в S3 или папка, которая появится после конвертации
 * PDF/PPTX/ZIP (имя без расширения), не учитывались — загрузка затирала
 * чужие данные или конвертер писал поверх существующей папки.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isLocalStorage, toStorageKey } from './sync.js';
import { probeStorageKey } from './probe.js';

const DERIVED_FOLDER_EXTENSIONS = new Set(['.pdf', '.pptx', '.zip']);
const MAX_ATTEMPTS = 50;

async function storagePathExists(absPath, storage) {
  if (fs.existsSync(absPath)) return true;

  if (!storage || isLocalStorage(storage)) return false;

  const key = toStorageKey(absPath);
  const probe = await probeStorageKey(storage, key);
  // unknown трактуем как «занято»: лучше добавить суффикс, чем перезаписать
  // объект, который сейчас недоступен для проверки.
  if (probe.state !== 'missing') return true;

  const prefix = key ? `${key.replace(/\/+$/, '')}/` : '';
  const entries = await storage.list(prefix);
  return Array.isArray(entries) && entries.length > 0;
}

async function isCandidateTaken(candidate, devicesPath, storage) {
  if (await storagePathExists(path.join(devicesPath, candidate), storage)) {
    return true;
  }

  const ext = path.extname(candidate).toLowerCase();
  if (DERIVED_FOLDER_EXTENSIONS.has(ext)) {
    const withoutExt = path.basename(candidate, path.extname(candidate));
    if (await storagePathExists(path.join(devicesPath, withoutExt), storage)) {
      return true;
    }
  }

  return false;
}

/**
 * @param {string} baseSafeName безопасное имя с расширением
 * @param {string} devicesPath общий content-root
 * @param {object|null} storage провайдер хранилища
 * @returns {Promise<string>} свободное имя
 */
export async function findAvailableSafeName(baseSafeName, devicesPath, storage = null) {
  const ext = path.extname(baseSafeName);
  const stem = path.basename(baseSafeName, ext);
  let candidate = baseSafeName;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (!await isCandidateTaken(candidate, devicesPath, storage)) {
      return candidate;
    }
    candidate = `${stem}_${crypto.randomBytes(3).toString('hex')}${ext}`;
  }

  throw new Error('Не удалось подобрать уникальное имя файла');
}
