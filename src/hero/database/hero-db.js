import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createModuleLogger } from '../../utils/logger.js';
const logger = createModuleLogger('hero');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use system-wide data directory (same fallback as server.js)
const DATA_DIR = process.env.MMRC_DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'db', 'heroes.db');
const LEGACY_DB_PATH = path.join(process.cwd(), 'config', 'heroes.db');
const LEGACY_DB_PATH2 = path.join(process.cwd(), 'config', 'hero', 'heroes.db');

const moveFileIfExists = (source, destination) => {
  try {
    if (!fs.existsSync(source)) return;
    const destDir = path.dirname(destination);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.renameSync(source, destination);
    logger.info(`[Hero DB] Moved ${source} -> ${destination}`);
  } catch (err) {
    logger.warn(`[Hero DB] Failed to move ${source} to ${destination}`, { error: err.message });
  }
};

const migrateLegacyDb = () => {
  // Try multiple legacy locations
  const legacyPaths = [LEGACY_DB_PATH, LEGACY_DB_PATH2].filter(p => p && fs.existsSync(p));

  if (legacyPaths.length === 0) return;

  // Ensure target directory exists
  const targetDir = path.dirname(DB_PATH);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  for (const legacyPath of legacyPaths) {
    if (!fs.existsSync(DB_PATH)) {
      logger.info(`[Hero DB] Migrating from ${legacyPath} -> ${DB_PATH}`);
      moveFileIfExists(legacyPath, DB_PATH);
    }

    // Migrate wal/shm files
    ['-wal', '-shm'].forEach((suffix) => {
      const legacyFile = `${legacyPath}${suffix}`;
      const newFile = `${DB_PATH}${suffix}`;
      if (fs.existsSync(legacyFile) && !fs.existsSync(newFile)) {
        moveFileIfExists(legacyFile, newFile);
      }
    });
  }
};

const ensureHeroesDb = () => {
  const configDir = path.dirname(DB_PATH);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const initSQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const initDb = new Database(DB_PATH);
  initDb.exec('PRAGMA foreign_keys = ON;');
  initDb.exec(initSQL);
  initDb.close();
};

const isPostgres = process.env.DB_TYPE === 'postgres';

if (!isPostgres) {
  migrateLegacyDb();

  if (!fs.existsSync(DB_PATH)) {
    logger.info('[Hero DB] Creating heroes database...');
    ensureHeroesDb();
  } else {
    logger.info('[Hero DB] Syncing schema for heroes database...');
    ensureHeroesDb();
  }
}

const applyHeroDbPragmas = (db) => {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
};

const openHeroDbConnection = () => {
  const db = new Database(DB_PATH);
  applyHeroDbPragmas(db);
  return db;
};

export let heroDb = null;

export async function getHeroDb() {
  if (!heroDb) {
    const { getDatabase } = await import('../../database/database.js');
    heroDb = getDatabase();
  }
  return heroDb;
}

export function setHeroDb(db) {
  heroDb = db;
}

export function closeHeroDb() {
  heroDb = null;
  logger.info('[Hero DB] Connection released');
}

export async function reloadHeroDb() {
  closeHeroDb();
  return getHeroDb();
}

export const HERO_DB_PATH = null;
export const LEGACY_HERO_DB_PATH = null;
