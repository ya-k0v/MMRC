import { getDatabase, driverType } from '../database/database.js';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('system');

const MODULES = {
  hero: {
    id: 'hero',
    name: 'Картотека',
    description: 'Учёт героев и медиа-материалов',
    roles: ['hero_admin'],
    roleLabels: { hero_admin: 'Hero Admin (управление карточками героев)' },
    getSchema() {
      const isPg = driverType === 'postgres';
      const idCol = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
      const tsCol = isPg ? 'TIMESTAMP' : 'DATETIME';
      return `
        CREATE TABLE IF NOT EXISTS heroes (
          id ${idCol},
          full_name TEXT NOT NULL,
          birth_year TEXT,
          death_year TEXT,
          rank TEXT,
          photo_base64 TEXT,
          biography TEXT,
          created_at ${tsCol} DEFAULT CURRENT_TIMESTAMP,
          updated_at ${tsCol} DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS hero_media (
          id ${idCol},
          hero_id INTEGER NOT NULL REFERENCES heroes(id) ON DELETE CASCADE,
          type TEXT CHECK(type IN ('photo','video')),
          media_base64 TEXT NOT NULL,
          caption TEXT,
          order_index INTEGER DEFAULT 0,
          created_at ${tsCol} DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_hero_full_name ON heroes(full_name);
        CREATE INDEX IF NOT EXISTS idx_hero_media ON hero_media(hero_id);
      `;
    },
    getIndexes() {
      if (driverType === 'sqlite') {
        return `
          CREATE TRIGGER IF NOT EXISTS trg_heroes_updated
          AFTER UPDATE ON heroes
          FOR EACH ROW
          BEGIN
            UPDATE heroes SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
          END;
        `;
      }
      if (driverType === 'postgres') {
        return `
          CREATE TRIGGER IF NOT EXISTS trg_heroes_updated
          BEFORE UPDATE ON heroes
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();

          ALTER TABLE heroes ADD COLUMN IF NOT EXISTS fts_search tsvector
            GENERATED ALWAYS AS (to_tsvector('russian', coalesce(full_name, '') || ' ' || coalesce(rank, ''))) STORED;

          CREATE INDEX IF NOT EXISTS idx_heroes_fts ON heroes USING GIN(fts_search);
        `;
      }
      return '';
    },
  }
};

export function getModuleInfo(id) {
  return MODULES[id] || null;
}

export function getAvailableModules() {
  return Object.values(MODULES).map(m => ({
    id: m.id,
    name: m.name,
    description: m.description,
    roles: m.roles || [],
    roleLabels: m.roleLabels || {}
  }));
}

export async function initModuleSchema(moduleId) {
  const mod = MODULES[moduleId];
  if (!mod) {
    throw new Error(`Unknown module: ${moduleId}`);
  }

  const db = getDatabase();
  const schema = typeof mod.getSchema === 'function' ? mod.getSchema() : (mod.schema || '');
  const indexes = typeof mod.getIndexes === 'function' ? mod.getIndexes() : (mod.indexes || '');
  const combined = schema + indexes;
  for (const stmt of combined.split(';').filter(s => s.trim())) {
    try {
      await db.exec(stmt.trim() + ';');
    } catch (err) {
      logger.warn(`[Modules] Schema statement for ${moduleId} failed (non-critical): ${err.message}`);
    }
  }
  logger.info(`[Modules] Schema initialized for module: ${moduleId}`);
}

export async function getEnabledModules() {
  const db = getDatabase();
  const ph = driverType === 'postgres' ? '$1' : '?';
  const rows = await db.query(`SELECT id FROM modules WHERE enabled = ${ph}`, driverType === 'postgres' ? [true] : [1]);
  return rows.map(r => r.id);
}

export async function setModuleEnabled(moduleId, enabled) {
  const db = getDatabase();
  if (enabled) {
    await initModuleSchema(moduleId);
  }
  const ph = (i) => driverType === 'postgres' ? `$${i}` : '?';
  await db.run(
    `UPDATE modules SET enabled = ${ph(1)}, updated_at = CURRENT_TIMESTAMP WHERE id = ${ph(2)}`,
    [enabled ? (driverType === 'postgres' ? true : 1) : (driverType === 'postgres' ? false : 0), moduleId]
  );
  logger.info(`[Modules] Module ${moduleId} ${enabled ? 'enabled' : 'disabled'}`);
}

export async function initEnabledModules() {
  const enabled = await getEnabledModules();
  for (const id of enabled) {
    try {
      await initModuleSchema(id);
      logger.info(`[Modules] Initialized module: ${id}`);
    } catch (err) {
      logger.error(`[Modules] Failed to init module ${id}:`, err.message);
    }
  }
  return enabled;
}
