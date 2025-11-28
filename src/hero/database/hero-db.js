import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

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
    console.log(`[Hero DB] Moved ${source} -> ${destination}`);
  } catch (err) {
    console.warn(`[Hero DB] Failed to move ${source} to ${destination}:`, err.message);
  }
};

const migrateLegacyDb = () => {
  if (!fs.existsSync(LEGACY_DB_PATH)) return;

  if (!fs.existsSync(DB_PATH)) {
    console.log('[Hero DB] Legacy heroes.db detected. Migrating to config/hero/heroes.db ...');
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
  console.log('[Hero DB] Creating heroes database...');
  ensureHeroesDb();
} else {
  console.log('[Hero DB] Syncing schema for heroes database...');
  ensureHeroesDb();
}

export const heroDb = new Database(DB_PATH);
heroDb.pragma('journal_mode = WAL');
heroDb.pragma('foreign_keys = ON');

export const HERO_DB_PATH = DB_PATH;
export const LEGACY_HERO_DB_PATH = LEGACY_DB_PATH;

