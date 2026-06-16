#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { createStorage } from './factory.js';
import { getDataRoot, getDevicesPath, getStreamsOutputDir, getConvertedCache, getLogsDir, getTempDir } from '../config/settings-manager.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const prefix = args.find(a => a.startsWith('--prefix='))?.split('=')[1] || 'devices';
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '10', 10);
const verbose = args.includes('--verbose');

const dataRoot = getDataRoot();

const SUBDIR_ALIASES = {
  devices: getDevicesPath(),
  streams: getStreamsOutputDir(),
  converted: getConvertedCache(),
  logs: getLogsDir(),
  temp: getTempDir()
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

function toStorageKey(absPath) {
  const rel = path.relative(dataRoot, absPath);
  if (rel.startsWith('..')) throw new Error(`Path outside data root: ${absPath}`);
  return rel.replace(/\\/g, '/');
}

async function migrateFile(filePath, storage, stats) {
  const key = toStorageKey(filePath);
  const alreadyExists = await storage.exists(key);
  if (alreadyExists) {
    if (verbose) console.log(`[SKIP] ${key} (already in storage)`);
    stats.skipped++;
    return;
  }
  const readStream = fs.createReadStream(filePath);
  try {
    await storage.write(key, readStream);
    if (verbose) console.log(`[OK]   ${key}`);
    stats.migrated++;
  } catch (err) {
    console.error(`[FAIL] ${key}: ${err.message}`);
    stats.errors++;
    readStream.destroy();
  }
}

async function migrateDir(sourceDir, storage, stats) {
  const files = walkDir(sourceDir);
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
    await Promise.all(batch.map(f => migrateFile(f, storage, stats)));
    const pct = Math.min(100, Math.round(((i + batch.length) / files.length) * 100));
    process.stdout.write(`\r[migrate] Progress: ${pct}% (${stats.migrated} migrated, ${stats.skipped} skipped, ${stats.errors} errors)`);
  }
  console.log();
}

async function main() {
  console.log(`[migrate] Data root: ${dataRoot}`);
  console.log(`[migrate] Prefix: ${prefix}`);
  console.log(`[migrate] Dry run: ${dryRun === true ? 'yes' : 'no'}`);
  console.log(`[migrate] Concurrency: ${concurrency}`);

  const storage = createStorage(dataRoot);
  console.log(`[migrate] Storage backend: ${storage.constructor.name}`);

  if (storage.constructor.name === 'LocalStorage') {
    console.log('[migrate] Local storage detected — nothing to migrate (already local)');
    process.exit(0);
  }

  const prefixes = prefix === 'all' ? Object.keys(SUBDIR_ALIASES) : [prefix];
  const totalStats = { migrated: 0, skipped: 0, errors: 0, dryRun: 0 };

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
  if (dryRun) console.log(`[migrate] (dry run — ${totalStats.dryRun} files would be migrated)`);
  if (totalStats.errors > 0) process.exit(1);
}

main().catch(err => {
  console.error(`[migrate] Fatal: ${err.message}`);
  process.exit(1);
});
