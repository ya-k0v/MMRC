/**
 * Сверка локального диска, базы данных и primary-хранилища (S3).
 *
 * Два разных режима, которые нельзя путать:
 *  - startup: локальные файлы, которых нет в S3, и файлы с доказанным
 *    расхождением размера ставятся в очередь на коммит с ограничением
 *    параллелизма; локальная копия удаляется только после подтверждённой
 *    загрузки (это делает syncFileToStorage);
 *  - report: сверка БД ↔ storage только считает present/missing/unknown и
 *    сироты, не удаляя ничего. Удаление метаданных остаётся в cleanupMissingFiles.
 *
 * Правило tri-state соблюдается: unknown (403, таймаут, обрыв) никогда не
 * означает «объекта нет» и не даёт права перезаписывать или удалять данные.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { getDevicesPath } from '../config/settings-manager.js';
import { getDatabase } from '../database/database.js';
import { createModuleLogger } from '../utils/logger.js';
import { recordStorageEvent } from '../utils/metrics.js';
import { getCurrentStorage } from './current.js';
import { probeStorageKey } from './probe.js';
import { isLocalStorage, syncFileToStorage, toStorageKey } from './sync.js';

const logger = createModuleLogger('storage');

const IGNORED_DIRS = new Set(['scratch', 'logs', 'streams', 'converted', 'temp']);

/** Ограниченный parallel-пул: не нагружаем MinIO и диск сотнями одновременных загрузок. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Об Progress-колбэе: ошибки внешнего наблюдателя не должны ломать сверку. */
function reportProgress(onProgress, payload) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(payload);
  } catch (error) {
    logger.warn('[StorageReconcile] Progress callback failed', { error: error.message });
  }
}

function normalizeLimit(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Обход файлов под root без следования в служебные каталоги и без временных
 * файлов ffmpeg/загрузок. Возвращает абсолютные пути.
 */
export async function walkLocalFiles(root) {
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      logger.warn('[StorageReconcile] Cannot read directory', { dir, error: error.message });
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.') || entry.name.endsWith('.part') || entry.name.includes('.optimizing_')) continue;
        files.push(full);
      }
    }
  }

  await walk(root);
  return files;
}

function describeLocalFile(root, absolutePath) {
  const relative = path.relative(root, absolutePath).replace(/\\/g, '/');
  const parts = relative.split('/').filter(Boolean);
  return {
    deviceId: parts.length > 1 ? parts[0] : null,
    fileName: path.basename(absolutePath)
  };
}

/**
 * Стартовая сверка: локальные файлы без подтверждённого объекта в S3 идут
 * в очередь коммита. Для локального бэкенда работа не нужна.
 *
 * @returns {Promise<object>} отчёт: { checked, present, missing, mismatched,
 *   unknown, committed, skipped, commitErrors, errors, samples, skippedReason? }
 */
export async function reconcileStartupLocalToStorage({
  storage = getCurrentStorage(),
  root = getDevicesPath(),
  dryRun = false,
  concurrency = normalizeLimit(process.env.STORAGE_RECONCILE_CONCURRENCY, 4, 1, 16),
  onProgress = null
} = {}) {
  const report = {
    checked: 0,
    present: 0,
    missing: 0,
    mismatched: 0,
    unknown: 0,
    committed: 0,
    skipped: 0,
    commitErrors: 0,
    errors: 0,
    samples: [],
    dryRun
  };

  if (!storage || isLocalStorage(storage)) {
    report.skippedReason = 'local-storage';
    logger.info('[StorageReconcile] Startup commit skipped (local storage)', report);
    return report;
  }

  const localFiles = await walkLocalFiles(root);
  report.checked = localFiles.length;
  logger.info('[StorageReconcile] Startup commit started', { files: localFiles.length, concurrency, dryRun });

  const pending = [];
  for (const absolutePath of localFiles) {
    let key;
    try {
      key = toStorageKey(absolutePath);
    } catch (error) {
      report.errors++;
      logger.warn('[StorageReconcile] Local file outside data root', {
        path: absolutePath, error: error.message
      });
      continue;
    }

    const probe = await probeStorageKey(storage, key);
    recordStorageEvent('probe');
    recordStorageEvent(probe.state);

    if (probe.state === 'present') {
      // present ≠ целый: усечённый объект остаётся «существующим» и блокирует
      // повторный коммит. Сверяем размер локального файла и объекта.
      const stat = probe.stat
        || (typeof storage.stat === 'function' ? await storage.stat(key).catch(() => null) : null);
      const localStat = await fsp.stat(absolutePath).catch(() => null);
      const storedSize = Number(stat?.size);
      const localSize = Number(localStat?.size);

      if (Number.isFinite(localSize) && Number.isFinite(storedSize) && storedSize !== localSize) {
        report.mismatched++;
        if (report.samples.length < 20) {
          report.samples.push({ key, state: 'mismatch', localSize, storedSize });
        }
        logger.warn('[StorageReconcile] Stored object size mismatch, recommit queued', {
          key, localSize, storedSize
        });
        pending.push({ absolutePath, key, force: true, ...describeLocalFile(root, absolutePath) });
      } else {
        report.present++;
      }
      continue;
    }
    if (probe.state === 'unknown') {
      report.unknown++;
      if (report.samples.length < 20) report.samples.push({ key, state: 'unknown' });
      logger.warn('[StorageReconcile] Storage check inconclusive, file not queued', {
        key, error: probe.error?.message || null
      });
      continue;
    }

    report.missing++;
    pending.push({ absolutePath, key, ...describeLocalFile(root, absolutePath) });
  }

  reportProgress(onProgress, { phase: 'probe', done: localFiles.length, total: localFiles.length, pending: pending.length });

  let done = 0;
  await mapWithConcurrency(pending, concurrency, async (item) => {
    try {
      recordStorageEvent('commit_attempt');
      if (dryRun) {
        report.skipped++;
      } else {
        const result = await syncFileToStorage(item.absolutePath, storage, {
          force: Boolean(item.force),
          removeLocal: true,
          deviceId: item.deviceId,
          fileName: item.fileName
        });
        if (result.synced && result.localRemoved) report.committed++;
        else report.skipped++;
      }
    } catch (error) {
      report.commitErrors++;
      recordStorageEvent('commit_error');
      if (report.samples.length < 20) report.samples.push({ key: item.key, state: 'commit_error', error: error.message });
      logger.error('[StorageReconcile] Startup commit failed', {
        key: item.key, error: error.message
      });
    }
    done++;
    reportProgress(onProgress, { phase: 'commit', done, total: pending.length, ...report });
  });

  logger.info('[StorageReconcile] Startup commit completed', report);
  return report;
}

/** Записи БД, которые участвуют в сверке контента (без потоков). */
export async function getTrackedFileRecords({ deviceId = null } = {}) {
  let query = `
    SELECT device_id, safe_name, file_path, content_type
    FROM files_metadata
    WHERE content_type != 'streaming' AND file_path IS NOT NULL AND file_path != ''
  `;
  const params = [];
  if (deviceId) {
    query += ' AND device_id = ?';
    params.push(deviceId);
  }
  return getDatabase().query(query, params);
}

/** Ключи хранилища, которые уже учтены в БД. */
export async function getTrackedStorageKeys(options = {}) {
  const records = await getTrackedFileRecords(options);
  const keys = new Set();
  for (const record of records) {
    try {
      keys.add(toStorageKey(record.file_path));
    } catch {
      // Путь вне data root не даёт ключа; ошибка будет учтена при самой сверке.
    }
  }
  return keys;
}

/**
 * Файлы в хранилище, про которые нет записи в БД. Общая точка для отчёта
 * сверки и проверки файлов в разделе БД: обе проверки должны показывать
 * одно и то же число сирот.
 */
export async function collectStorageOrphans({
  storage = getCurrentStorage(),
  dbKeys = null,
  deviceId = null,
  sampleLimit = 20
} = {}) {
  const result = { orphanCount: 0, samples: [], error: null };
  if (!storage) return result;

  try {
    const tracked = dbKeys || await getTrackedStorageKeys({ deviceId });
    if (isLocalStorage(storage)) {
      // LocalStorage.list — плоский и не обходит подпапки устройств.
      const files = await walkLocalFiles(getDevicesPath());
      const keys = files.map((file) => toStorageKey(file)).filter(Boolean);
      result.orphanCount = countOrphans(keys, tracked, result.samples, sampleLimit);
    } else {
      const objects = await storage.list('');
      result.orphanCount = countOrphans(objects, tracked, result.samples, sampleLimit);
    }
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

/**
 * Сверка БД ↔ storage. Только отчёт: никаких DELETE и изменений файлов.
 * Для локального бэкенда сироты ищутся рекурсивно (LocalStorage.list — плоский).
 */
export async function reconcileDbWithStorage({
  storage = getCurrentStorage(),
  deviceId = null,
  includeOrphans = true,
  sampleLimit = 20,
  onProgress = null
} = {}) {
  const report = {
    checked: 0,
    present: 0,
    missing: 0,
    unknown: 0,
    orphanCount: 0,
    errors: 0,
    samples: { missing: [], unknown: [], orphans: [] }
  };

  const records = await getTrackedFileRecords({ deviceId });
  report.checked = records.length;
  const dbKeys = new Set();

  let done = 0;
  for (const record of records) {
    try {
      const key = toStorageKey(record.file_path);
      dbKeys.add(key);
      const probe = await probeStorageKey(storage, key);
      recordStorageEvent('probe');
      recordStorageEvent(probe.state);

      if (probe.state === 'present') report.present++;
      else if (probe.state === 'missing') {
        report.missing++;
        if (report.samples.missing.length < sampleLimit) {
          report.samples.missing.push({ key, deviceId: record.device_id, safeName: record.safe_name });
        }
      } else {
        report.unknown++;
        if (report.samples.unknown.length < sampleLimit) {
          report.samples.unknown.push({ key, error: probe.error?.message || null });
        }
      }
    } catch (error) {
      report.errors++;
      logger.warn('[StorageReconcile] Cannot check DB record', {
        deviceId: record.device_id, safeName: record.safe_name, error: error.message
      });
    }
    done++;
    reportProgress(onProgress, { phase: 'db', done, total: records.length });
  }

  if (includeOrphans && storage) {
    const orphans = await collectStorageOrphans({ storage, dbKeys, sampleLimit });
    report.orphanCount = orphans.orphanCount;
    report.samples.orphans = orphans.samples;
    if (orphans.error) {
      report.errors++;
      report.orphansUnavailable = orphans.error;
      logger.warn('[StorageReconcile] Cannot enumerate storage objects', { error: orphans.error });
    }
  }

  if (report.orphanCount > 0) {
    recordStorageEvent('orphan');
  }
  recordStorageEvent('reconcile');
  logger.info('[StorageReconcile] DB/storage report completed', {
    checked: report.checked,
    present: report.present,
    missing: report.missing,
    unknown: report.unknown,
    orphanCount: report.orphanCount,
    errors: report.errors
  });
  return report;
}

/** Ключ-папка не считается сиротой, если под ней лежат файлы из БД. */
function countOrphans(objects, dbKeys, samples, sampleLimit) {
  const folderPrefixes = new Set();
  for (const key of dbKeys) {
    const parts = key.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      folderPrefixes.add(parts.slice(0, i).join('/'));
    }
  }

  let count = 0;
  for (const entry of objects) {
    const key = typeof entry === 'string' ? entry : entry?.key || entry?.Key;
    if (!key || key.endsWith('/')) continue;
    if (/^(streams|converted|logs|temp)\//.test(key)) continue;
    if (dbKeys.has(key) || folderPrefixes.has(key)) continue;
    count++;
    if (samples.length < sampleLimit) samples.push(key);
  }
  return count;
}
