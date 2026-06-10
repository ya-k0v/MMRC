import logger from '../../utils/logger.js';

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
