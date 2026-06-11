import { getDatabase, driverType } from '../database/database.js';
import logger from '../utils/logger.js';

const MODULES = {};

export function getModuleInfo(id) {
  return MODULES[id] || null;
}

export function getAvailableModules() {
  return Object.values(MODULES).map(m => ({
    id: m.id,
    name: m.name,
    description: m.description
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
