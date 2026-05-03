import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import logger from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(process.cwd(), 'config', 'hero', 'heroes.db');
const LEGACY_DB_PATH = path.join(process.cwd(), 'config', 'heroes.db');

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
  if (!fs.existsSync(LEGACY_DB_PATH)) return;

  if (!fs.existsSync(DB_PATH)) {
    logger.info('[Hero DB] Legacy heroes.db detected. Migrating to config/hero/heroes.db ...');
    moveFileIfExists(LEGACY_DB_PATH, DB_PATH);
  }

  // Переносим wal/shm файлы, если они остались
  ['-wal', '-shm'].forEach((suffix) => {
    const legacyFile = `${LEGACY_DB_PATH}${suffix}`;
    const newFile = `${DB_PATH}${suffix}`;
    if (!fs.existsSync(newFile)) {
      moveFileIfExists(legacyFile, newFile);
    }
  });
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

migrateLegacyDb();

if (!fs.existsSync(DB_PATH)) {
  logger.info('[Hero DB] Creating heroes database...');
  ensureHeroesDb();
} else {
  logger.info('[Hero DB] Syncing schema for heroes database...');
  ensureHeroesDb();
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

export function closeHeroDb() {
  if (!heroDb) return;

  try {
    heroDb.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    logger.warn('[Hero DB] WAL checkpoint before close failed', { error: error.message });
  }

  try {
    heroDb.close();
  } catch (error) {
    logger.warn('[Hero DB] Failed to close hero DB connection', { error: error.message });
  } finally {
    heroDb = null;
  }
}

export function reloadHeroDb() {
  closeHeroDb();
  ensureHeroesDb();
  heroDb = openHeroDbConnection();
  logger.info('[Hero DB] Connection reloaded', { dbPath: DB_PATH });
  return heroDb;
}

reloadHeroDb();

export const HERO_DB_PATH = DB_PATH;
export const LEGACY_HERO_DB_PATH = LEGACY_DB_PATH;

