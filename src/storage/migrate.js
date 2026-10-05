#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { createStorage } from './factory.js';
import { getDataRoot, getDevicesPath, getStreamsOutputDir, getConvertedCache, getLogsDir, getTempDir } from '../config/settings-manager.js';
import { isLocalStorage, syncFileToStorage, toStorageKey } from './sync.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const removeLocal = args.includes('--remove-local');
const prefix = args.find(a => a.startsWith('--prefix='))?.split('=')[1] || 'devices';
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '4', 10) || 4;
const verbose = args.includes('--verbose');

const dataRoot = getDataRoot();

const SUBDIR_ALIASES = {
  devices: getDevicesPath(),
  streams: getStreamsOutputDir(),
  converted: getConvertedCache(),
  logs: getLogsDir()
};

function walkDir(dir) {
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkDir(fullPath));
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  } catch (err) {
    if (verbose) console.error(`[migrate] Cannot read directory ${dir}: ${err.message}`);
  }
  return files;
}

async function migrateFile(filePath, storage, stats) {
  const key = toStorageKey(filePath);

  // Пропускаем только если в хранилище лежит объект ТОЧНО такого же размера.
  // Прежняя проверка по одному лишь exists() оставляла усечённые объекты
  // навсегда: файл считался перенесённым, но был битым.
  try {
    if (await storage.exists(key)) {
      const stat = await storage.stat(key).catch(() => null);
      const localSize = fs.statSync(filePath).size;
      if (stat && Number(stat.size) === localSize) {
        if (verbose) console.log(`[SKIP] ${key} (уже в хранилище, размер совпадает)`);
        stats.skipped++;
        if (removeLocal) removeLocalFile(filePath, key, stats);
        return;
      }
      if (verbose) {
        console.log(`[RETRY] ${key} (размер в хранилище ${stat?.size ?? '?'} != локальный ${localSize})`);
      }
    }
  } catch {
    // Проверка не критична — просто загружаем заново
  }

  const result = await syncFileToStorage(filePath, storage, {
    force: true,
    removeLocal: false
  });

  if (result.synced) {
    if (verbose) console.log(`[OK]   ${key}`);
    stats.migrated++;
    if (removeLocal) removeLocalFile(filePath, key, stats);
  } else {
    console.error(`[FAIL] ${key}: не загружен (${result.reason || 'unknown'})`);
    stats.errors++;
  }
}

function removeLocalFile(filePath, key, stats) {
  try {
    fs.unlinkSync(filePath);
    stats.removed = (stats.removed || 0) + 1;
    if (verbose) console.log(`[RM]   ${key}`);
  } catch (err) {
    console.error(`[FAIL] не удалось удалить локально ${key}: ${err.message}`);
    stats.errors++;
  }
}

async function migrateDir(sourceDir, storage, stats) {
  // Рабочая область не переносится: это временные файлы оптимизации,
  // их незачем складывать в постоянное хранилище.
  const scratch = path.join(getTempDir(), 'scratch');
  const files = walkDir(sourceDir).filter(f => !f.startsWith(scratch + path.sep));

  if (files.length === 0) {
    console.log(`[migrate] No files found in ${sourceDir}`);
    return;
  }
  console.log(`[migrate] Found ${files.length} files in ${sourceDir}`);
  if (dryRun) {
    console.log(`[migrate] DRY RUN — would migrate ${files.length} files`);
    stats.dryRun += files.length;
    return;
  }

  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    await Promise.all(batch.map(f => migrateFile(f, storage, stats).catch((err) => {
      console.error(`[FAIL] ${f}: ${err.message}`);
      stats.errors++;
    })));
    const pct = Math.min(100, Math.round(((i + batch.length) / files.length) * 100));
    process.stdout.write(`\r[migrate] Progress: ${pct}% (${stats.migrated} migrated, ${stats.skipped} skipped, ${stats.errors} errors)`);
  }
  console.log();
}

async function main() {
  console.log(`[migrate] Data root: ${dataRoot}`);
  console.log(`[migrate] Prefix: ${prefix}`);
  console.log(`[migrate] Dry run: ${dryRun === true ? 'yes' : 'no'}`);
  console.log(`[migrate] Remove local copies: ${removeLocal === true ? 'yes' : 'no'}`);
  console.log(`[migrate] Concurrency: ${concurrency}`);

  const storage = createStorage(dataRoot);
  console.log(`[migrate] Storage backend: ${storage.constructor.name}`);

  if (isLocalStorage(storage)) {
    console.log('[migrate] Local storage detected — nothing to migrate (already local)');
    process.exit(0);
  }

  const prefixes = prefix === 'all' ? Object.keys(SUBDIR_ALIASES) : [prefix];
  const totalStats = { migrated: 0, skipped: 0, errors: 0, dryRun: 0, removed: 0 };

  for (const p of prefixes) {
    const sourceDir = SUBDIR_ALIASES[p] || (() => {
      const resolved = path.resolve(dataRoot, p);
      if (fs.existsSync(resolved)) return resolved;
      throw new Error(`Unknown prefix "${p}". Use one of: ${Object.keys(SUBDIR_ALIASES).join(', ')}, or a custom path`);
    })();

    if (!fs.existsSync(sourceDir)) {
      console.log(`[migrate] Source directory does not exist: ${sourceDir}`);
      continue;
    }

    console.log(`\n[migrate] === Migrating ${p} ===`);
    await migrateDir(sourceDir, storage, totalStats);
  }

  console.log(`\n[migrate] === Summary ===`);
  console.log(`[migrate] Done. Stats: ${totalStats.migrated} migrated, ${totalStats.skipped} skipped, ${totalStats.errors} errors`);
  if (removeLocal) console.log(`[migrate] Local copies removed: ${totalStats.removed}`);
  if (dryRun) console.log(`[migrate] (dry run — ${totalStats.dryRun} files would be migrated)`);
  if (totalStats.errors > 0) process.exit(1);
}

main().catch(err => {
  console.error(`[migrate] Fatal: ${err.message}`);
  process.exit(1);
});