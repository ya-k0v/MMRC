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
          birth_year INTEGER,
          death_year INTEGER,
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
      if (driverType !== 'sqlite') return '';
      return `
        CREATE TRIGGER IF NOT EXISTS trg_heroes_updated
        AFTER UPDATE ON heroes
        FOR EACH ROW
        BEGIN
          UPDATE heroes SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;
      `;
    }
  },
  ad: {
    id: 'ad',
    name: 'Реклама',
    description: 'Управление рекламными дисплеями, роликами и аналитикой показов',
    roles: ['ad_admin'],
    roleLabels: { ad_admin: 'Ad Admin (управление рекламными кампаниями)' },
    getSchema() {
      const isPg = driverType === 'postgres';
      const idCol = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
      const tsCol = isPg ? 'TIMESTAMP' : 'DATETIME';
      return `
        DROP TABLE IF EXISTS ad_videos;
        DROP TABLE IF EXISTS ad_displays;
        DROP TABLE IF EXISTS ad_schedules;
        DROP TABLE IF EXISTS ad_analytics;

        CREATE TABLE ad_analytics (
          id ${idCol},
          device_id TEXT NOT NULL,
          file_name TEXT NOT NULL,
          played_at ${tsCol} NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_ad_analytics_device ON ad_analytics(device_id);
        CREATE INDEX IF NOT EXISTS idx_ad_analytics_date ON ad_analytics(played_at);
      `;
    }
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
  const boolVal = enabled ? (driverType === 'postgres' ? true : 1) : (driverType === 'postgres' ? false : 0);
  try {
    await db.run(
      `INSERT INTO modules (id, enabled, updated_at) VALUES (${ph(1)}, ${ph(2)}, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP`,
      [moduleId, boolVal, boolVal]
    );
  } catch (err) {
    await db.run(
      `UPDATE modules SET enabled = ${ph(1)}, updated_at = CURRENT_TIMESTAMP WHERE id = ${ph(2)}`,
      [boolVal, moduleId]
    );
  }
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
