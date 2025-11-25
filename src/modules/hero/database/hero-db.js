import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(process.cwd(), 'config', 'heroes.db');

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

