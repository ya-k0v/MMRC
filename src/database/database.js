/**
 * Database module - SQLite database for MMRC
 * @module database/database
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { withRetrySync, isRetryableDatabaseError } from '../utils/retry.js';
import { circuitBreakers } from '../utils/circuit-breaker.js';
import logger from '../utils/logger.js';
import { notifyDbError } from '../utils/notifications.js';
import { timerRegistry } from '../utils/timer-registry.js';
import {
  createDriver, getDriver, closeDriver,
  resolveDriverConfig, getSchemaSql
} from './driver/manager.js';

let driver = null;
let driverType = 'sqlite';
let dbPath = null;

/**
 * Инициализация базы данных
 * @param {string} dbPath - Путь к файлу БД (по умолчанию: /var/lib/mmrc-data/db/main.db)
 * @returns {Database} Экземпляр БД
 */
export function initDatabase(initialDbPath) {
  if (db) {
    logger.info('[DB] Database already initialized');
    return driver;
  }

  const resolvedConfig = config || resolveDriverConfig();
  driverType = resolvedConfig.type || 'sqlite';
  dbPath = resolvedConfig.path || null;

  try {
    const dir = path.dirname(dbPath);
    // Only create directory for local paths, NOT system paths (Docker creates them)
    if (!fs.existsSync(dir)) {
      const isSystemPath = dir.startsWith('/var/') || dir.startsWith('/etc/') || dir.startsWith('/usr/');
      if (isSystemPath) {
        throw new Error(`Database directory does not exist: ${dir}. Docker should create it.`);
      }
      fs.mkdirSync(dir, { recursive: true });
    }

    const schemaSql = getSchemaSql(driverType);
    await driver.exec(schemaSql);
    logger.info(`[DB] Schema initialized (${driverType})`);

    await ensureFilesMetadataStreamingColumns();
    await ensureUsersAuthColumns();
    await ensureUserDevicesTable();
    await ensureDefaultAdminUser();
    await ensureHeroAdminMigration();

    logger.info(`[DB] Database initialized (${driverType})`);
    return driver;
  } catch (e) {
    logger.error('[DB] Failed to initialize database:', e);
    throw e;
  }
}

export function getDatabase() {
  if (!driver) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return driver;
}

export async function closeDatabase() {
  await closeDriver();
  driver = null;
  logger.info('[DB] Database closed');
}

export function getDriverType() {
  return driverType;
}

async function ensureTableExists(name, createSql) {
  const exists = await driver.tableExists(name);
  if (!exists) {
    await driver.exec(createSql);
    logger.info(`[DB] Created table: ${name}`);
  }
}

async function ensureUserDevicesTable() {
  await ensureTableExists('user_devices', `
    CREATE TABLE IF NOT EXISTS user_devices (
      id ${driverType === 'postgres' ? 'SERIAL' : 'INTEGER'} PRIMARY KEY${driverType === 'sqlite' ? ' AUTOINCREMENT' : ''},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      created_at ${driverType === 'postgres' ? 'TIMESTAMP' : 'DATETIME'} DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, device_id)
    )
  `);
}

async function ensureUsersAuthColumns() {
  try {
    const hasTable = await driver.tableExists('users');
    if (!hasTable) return;

    const cols = await driver.columns('users');
    const names = new Set(cols.map(c => c.name));

    if (!names.has('auth_source')) {
      await driver.exec(`ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'`);
      logger.info('[DB] Added auth_source column to users');
    }
    if (!names.has('ldap_dn')) {
      await driver.exec('ALTER TABLE users ADD COLUMN ldap_dn TEXT');
      logger.info('[DB] Added ldap_dn column to users');
    }
  } catch (err) {
    logger.warn('[DB] Failed to ensure users auth columns (non-critical)', { error: err.message });
  }
}

async function ensureFilesMetadataStreamingColumns() {
  try {
    const hasTable = await driver.tableExists('files_metadata');
    if (!hasTable) return;

    const cols = await driver.columns('files_metadata');
    const names = new Set(cols.map(c => c.name));

    const addIfMissing = async (col, def) => {
      if (!names.has(col)) {
        await driver.exec(`ALTER TABLE files_metadata ADD COLUMN ${def}`);
        logger.info(`[DB] Added column files_metadata.${col}`);
      }
    };

    await addIfMissing('content_type', "content_type TEXT DEFAULT 'file'");
    await addIfMissing('stream_url', 'stream_url TEXT');
    await addIfMissing('stream_protocol', "stream_protocol TEXT DEFAULT 'auto'");
    await addIfMissing('pages_count', 'pages_count INTEGER');
  } catch (err) {
    logger.warn('[DB] Failed to ensure streaming columns (non-critical)', { error: err.message });
  }
}

async function ensureDefaultAdminUser() {
  try {
    const hasTable = await driver.tableExists('users');
    if (!hasTable) return;

    const count = await driver.get('SELECT COUNT(*) as count FROM users');
    if (Number(count.count) === 0) {
      const hash = '$2b$10$jgHKNtHUKUhkftKlOfDqOulY9LFBVi/AirOu0YSKfzDlvFD60QI/W';
      if (driverType === 'postgres') {
        await driver.run(
          `INSERT INTO users (username, full_name, password_hash, role, is_active)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (username) DO NOTHING`,
          ['admin', 'Администратор', hash, 'admin', true]
        );
      } else {
        await driver.run(
          `INSERT OR IGNORE INTO users (username, full_name, password_hash, role, is_active)
           VALUES (?, ?, ?, ?, ?)`,
          ['admin', 'Администратор', hash, 'admin', 1]
        );
      }
      logger.info('[DB] Default admin user created (admin/admin123)');
    }
  } catch (err) {
    logger.warn('[DB] Failed to ensure default admin user (non-critical):', err.message);
  }
}

async function ensureHeroAdminMigration() {
  try {
    const hasTable = await driver.tableExists('users');
    if (!hasTable) return;

    if (driverType === 'sqlite') {
      const tableDef = await driver.get(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
      );
      if (tableDef && tableDef.sql && !tableDef.sql.includes("'hero_admin'")) {
        logger.info('[DB] Migrating users table to support hero_admin role...');
        const usersData = await driver.query('SELECT * FROM users');
        await driver.exec('ALTER TABLE users RENAME TO users_old');
        await driver.exec(`
          CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            auth_source TEXT NOT NULL DEFAULT 'local' CHECK(auth_source IN ('local', 'ldap')),
            ldap_dn TEXT,
            role TEXT DEFAULT 'speaker' CHECK(role IN ('admin', 'speaker', 'hero_admin')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME,
            is_active INTEGER DEFAULT 1
          )
        `);
        for (const u of usersData) {
          await driver.run(
            `INSERT INTO users (id, username, full_name, password_hash, auth_source, ldap_dn, role, created_at, updated_at, last_login, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [u.id, u.username, u.full_name, u.password_hash, u.auth_source || 'local',
             u.ldap_dn || null, u.role, u.created_at, u.updated_at, u.last_login, u.is_active]
          );
        }
        await driver.exec('DROP TABLE users_old');
        logger.info('[DB] Hero_admin migration completed');
      }
    }
  } catch (err) {
    logger.warn('[DB] Hero admin migration skipped (non-critical):', err.message);
  }
}

// ========================================
// WAL CHECKPOINT (SQLite only)
// ========================================

let walCheckpointInterval = null;

export function performWalCheckpoint(force = false) {
  if (driverType !== 'sqlite' || !driver || !driver.dbPath) {
    return { success: false, message: 'WAL checkpoint only available for SQLite' };
  }

  try {
    const walPath = driver.dbPath + '-wal';
    const walExists = fs.existsSync(walPath);
    if (!walExists) {
      return { success: true, message: 'WAL file does not exist' };
    }

    const stats = fs.statSync(walPath);
    const walSizeMB = stats.size / (1024 * 1024);
    const thresholdMB = parseInt(process.env.WAL_CHECKPOINT_THRESHOLD_MB || '100', 10);

    if (!force && stats.size < thresholdMB * 1024 * 1024) {
      return { success: true, walSize: walSizeMB,
        message: `WAL size (${walSizeMB.toFixed(2)}MB) below threshold (${thresholdMB}MB)` };
    }

    try {
      driver.performWalCheckpoint('PASSIVE');
    } catch {
      driver.performWalCheckpoint('TRUNCATE');
    }

    let newWalSizeMB = 0;
    if (fs.existsSync(walPath)) {
      newWalSizeMB = fs.statSync(walPath).size / (1024 * 1024);
    }

    return {
      success: true, walSize: newWalSizeMB, oldSize: walSizeMB,
      reduced: walSizeMB - newWalSizeMB,
      message: `Checkpoint: ${walSizeMB.toFixed(2)}MB → ${newWalSizeMB.toFixed(2)}MB`
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

export function startWalCheckpointInterval(intervalMs = 60 * 1000) {
  if (walCheckpointInterval) return;
  walCheckpointInterval = timerRegistry.setInterval(() => {
    const result = performWalCheckpoint(false);
    if (result.success && result.reduced && result.reduced > 0) {
      logger.debug('[DB] Periodic WAL checkpoint', {
        reducedMB: result.reduced.toFixed(2), newSizeMB: result.walSize?.toFixed(2)
      });
    }
  }, intervalMs, 'WAL checkpoint interval');
}

export function stopWalCheckpointInterval() {
  if (walCheckpointInterval) {
    timerRegistry.clear(walCheckpointInterval);
    walCheckpointInterval = null;
  }
}

// ========================================
// DEVICES
// ========================================

export async function getAllDevices() {
  try {
    return await withRetrySync(async () => {
      const rows = await driver.query(
        `SELECT device_id, name, folder, device_type, platform, ip_address, capabilities,
                last_seen, current_state, created_at, updated_at
         FROM devices ORDER BY device_id`
      );

      const devices = {};
      for (const row of rows) {
        try {
          devices[row.device_id] = {
            name: row.name,
            folder: row.folder,
            deviceType: row.device_type,
            platform: row.platform,
            ipAddress: row.ip_address || null,
            capabilities: row.capabilities ? JSON.parse(row.capabilities) : null,
            lastSeen: row.last_seen,
            current: row.current_state ? JSON.parse(row.current_state) : { type: 'idle', file: null, state: 'idle' },
            files: [], fileNames: []
          };
        } catch (parseError) {
          logger.error(`[DB] Error parsing device ${row.device_id}:`, parseError);
          devices[row.device_id] = {
            name: row.name || row.device_id, folder: row.folder || row.device_id,
            deviceType: row.device_type || 'browser', platform: row.platform || null,
            ipAddress: row.ip_address || null, capabilities: null,
            lastSeen: row.last_seen,
            current: { type: 'idle', file: null, state: 'idle' },
            files: [], fileNames: []
          };
        }
      }
      logger.info(`[DB] getAllDevices: loaded ${Object.keys(devices).length} devices`);
      return devices;
    }, {
      maxRetries: 3, delay: 500,
      shouldRetry: isRetryableDatabaseError,
      onRetry: (error, attempt, max) => {
        logger.warn(`[DB] Retry ${attempt}/${max} for getAllDevices:`, error.message);
      }
    });
  } catch (e) {
    logger.error('[DB] Critical error in getAllDevices:', e);
    try {
      const rows = await driver.query('SELECT device_id, name, folder FROM devices');
      const devices = {};
      for (const row of rows) {
        devices[row.device_id] = {
          name: row.name, folder: row.folder, deviceType: 'browser',
          platform: null, capabilities: null, lastSeen: null,
          current: { type: 'idle', file: null, state: 'idle' },
          files: [], fileNames: []
        };
      }
      logger.warn(`[DB] Fallback: loaded ${Object.keys(devices).length} devices with minimal data`);
      return devices;
    } catch (fallbackError) {
      logger.error('[DB] Fallback also failed:', fallbackError);
      notifyDbError({
        error: fallbackError.message, errorCode: fallbackError.code,
        operation: 'getAllDevices',
        recommendation: 'База данных недоступна. Проверьте целостность БД и перезапустите сервис.'
      });
      return {};
    }
  }
}

export function saveDevice(deviceId, data) {
  return circuitBreakers.database.execute(() => {
    return withRetrySync(async () => {
      await driver.run(
        `INSERT INTO devices (device_id, name, folder, device_type, platform, ip_address, capabilities, last_seen, current_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           name = excluded.name, folder = excluded.folder,
           device_type = excluded.device_type, platform = excluded.platform,
           ip_address = excluded.ip_address, capabilities = excluded.capabilities,
           last_seen = excluded.last_seen, current_state = excluded.current_state,
           updated_at = CURRENT_TIMESTAMP`,
        [deviceId, data.name, data.folder, data.deviceType || 'browser',
         data.platform || null, data.ipAddress || null,
         data.capabilities ? JSON.stringify(data.capabilities) : null,
         data.lastSeen || null, data.current ? JSON.stringify(data.current) : null]
      );
    }, { maxRetries: 3, delay: 500, shouldRetry: isRetryableDatabaseError });
  }).catch((e) => {
    logger.error('[DB] Error saving device:', e);
    throw e;
  });
}

export async function deleteDevice(deviceId) {
  await driver.run('DELETE FROM devices WHERE device_id = ?', [deviceId]);
}

// ========================================
// FILE NAMES MAPPING
// ========================================

export async function getAllFileNames() {
  const rows = await driver.query('SELECT device_id, safe_name, original_name FROM file_names');
  const mapping = {};
  for (const row of rows) {
    if (!mapping[row.device_id]) mapping[row.device_id] = {};
    mapping[row.device_id][row.safe_name] = row.original_name;
  }
  return mapping;
}

export async function saveFileName(deviceId, safeName, originalName) {
  return withRetrySync(async () => {
    await driver.run(
      `INSERT INTO file_names (device_id, safe_name, original_name) VALUES (?, ?, ?)
       ON CONFLICT(device_id, safe_name) DO UPDATE SET original_name = excluded.original_name`,
      [deviceId, safeName, originalName]
    );
  }, {
    maxRetries: 3, delay: 100, shouldRetry: isRetryableDatabaseError,
    onRetry: (error, attempt, maxRetries) => {
      logger.warn('Retrying saveFileName', { deviceId, safeName, attempt, maxRetries, error: error.message });
    }
  });
}

export async function deleteFileName(deviceId, safeName) {
  await driver.run('DELETE FROM file_names WHERE device_id = ? AND safe_name = ?', [deviceId, safeName]);
}

export async function deleteDeviceFileNames(deviceId) {
  await driver.run('DELETE FROM file_names WHERE device_id = ?', [deviceId]);
}

// ========================================
// FILE STATUSES
// ========================================

export async function getFileStatus(deviceId, fileName) {
  const row = await driver.get(
    `SELECT status, resolution, original_resolution, needs_optimization, error, updated_at
     FROM file_statuses WHERE device_id = ? AND file_name = ?`,
    [deviceId, fileName]
  );
  if (!row) return null;
  return {
    status: row.status, resolution: row.resolution,
    originalResolution: row.original_resolution,
    needsOptimization: Boolean(row.needs_optimization),
    error: row.error, updatedAt: row.updated_at
  };
}

export async function saveFileStatus(deviceId, fileName, statusData) {
  await driver.run(
    `INSERT INTO file_statuses (device_id, file_name, status, resolution, original_resolution, needs_optimization, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id, file_name) DO UPDATE SET
       status = excluded.status, resolution = excluded.resolution,
       original_resolution = excluded.original_resolution,
       needs_optimization = excluded.needs_optimization,
       error = excluded.error, updated_at = CURRENT_TIMESTAMP`,
    [deviceId, fileName, statusData.status || null, statusData.resolution || null,
      statusData.originalResolution || null, statusData.needsOptimization ? true : false,
     statusData.error || null]
  );
}

export async function deleteFileStatus(deviceId, fileName) {
  await driver.run('DELETE FROM file_statuses WHERE device_id = ? AND file_name = ?', [deviceId, fileName]);
}

export async function getDeviceFileStatuses(deviceId) {
  const rows = await driver.query(
    `SELECT file_name, status, resolution, original_resolution, needs_optimization, error, updated_at
     FROM file_statuses WHERE device_id = ?`,
    [deviceId]
  );
  const statuses = {};
  for (const row of rows) {
    statuses[row.file_name] = {
      status: row.status, resolution: row.resolution,
      originalResolution: row.original_resolution,
      needsOptimization: Boolean(row.needs_optimization),
      error: row.error, updatedAt: row.updated_at
    };
  }
  return statuses;
}

// ========================================
// PLACEHOLDERS
// ========================================

export async function getPlaceholder(deviceId) {
  const row = await driver.get(
    'SELECT placeholder_file, placeholder_type, updated_at FROM placeholders WHERE device_id = ?',
    [deviceId]
  );
  if (!row) return null;
  return { file: row.placeholder_file, type: row.placeholder_type, updatedAt: row.updated_at };
}

export async function savePlaceholder(deviceId, placeholderFile, placeholderType) {
  await driver.run(
    `INSERT INTO placeholders (device_id, placeholder_file, placeholder_type) VALUES (?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       placeholder_file = excluded.placeholder_file,
       placeholder_type = excluded.placeholder_type,
       updated_at = CURRENT_TIMESTAMP`,
    [deviceId, placeholderFile, placeholderType]
  );
}

export async function deletePlaceholder(deviceId) {
  await driver.run('DELETE FROM placeholders WHERE device_id = ?', [deviceId]);
}

// ========================================
// DEVICE VOLUME STATE
// ========================================

export async function getAllDeviceVolumeStates() {
  const rows = await driver.query('SELECT device_id, volume_level, is_muted, updated_at FROM device_volume');
  const volumeMap = {};
  for (const row of rows) {
    volumeMap[row.device_id] = {
      level: row.volume_level ?? 50,
      muted: Boolean(row.is_muted),
      updatedAt: row.updated_at
    };
  }
  return volumeMap;
}

export async function getDeviceVolumeState(deviceId) {
  const row = await driver.get(
    'SELECT device_id, volume_level, is_muted, updated_at FROM device_volume WHERE device_id = ?',
    [deviceId]
  );
  if (!row) return null;
  return { level: row.volume_level ?? 50, muted: Boolean(row.is_muted), updatedAt: row.updated_at };
}

export async function saveDeviceVolumeState(deviceId, { volumeLevel, isMuted }) {
  try {
    return await withRetrySync(async () => {
      await driver.run(
        `INSERT INTO device_volume (device_id, volume_level, is_muted) VALUES (?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           volume_level = excluded.volume_level,
           is_muted = excluded.is_muted,
           updated_at = CURRENT_TIMESTAMP`,
        [deviceId, Number(volumeLevel), isMuted ? true : false]
      );
    }, {
      maxRetries: 3, delay: 100, shouldRetry: isRetryableDatabaseError,
      onRetry: (error, attempt, maxRetries) => {
        logger.warn('Retrying saveDeviceVolumeState', { deviceId, attempt, maxRetries, error: error.message });
      }
    });
  } catch (err) {
    if (err.message?.includes('foreign key constraint') || err.code === '23503') {
      logger.warn('[DB] Deferred volume state save (device not yet registered)', { deviceId });
      return;
    }
    throw err;
  }
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

export async function transaction(fn) {
  return driver.transaction(fn);
}

export async function getDatabaseStats() {
  const deviceCount = await driver.get('SELECT COUNT(*) as count FROM devices');
  const fileNameCount = await driver.get('SELECT COUNT(*) as count FROM file_names');
  const fileStatusCount = await driver.get('SELECT COUNT(*) as count FROM file_statuses');
  const placeholderCount = await driver.get('SELECT COUNT(*) as count FROM placeholders');
  const dbSize = driverType === 'sqlite' && driver.dbPath ? fs.statSync(driver.dbPath).size : 0;

  return {
    devices: Number(deviceCount.count),
    fileNames: Number(fileNameCount.count),
    fileStatuses: Number(fileStatusCount.count),
    placeholders: Number(placeholderCount.count),
    dbSize, dbSizeMB: (dbSize / 1024 / 1024).toFixed(2),
    dbPath: driver.dbPath || 'postgresql'
  };
}

export async function exportToJSON() {
  const devices = await getAllDevices();
  const fileNames = await getAllFileNames();
  const placeholders = await driver.query('SELECT device_id, placeholder_file FROM placeholders');

  return {
    devices, fileNames,
    placeholders: placeholders.reduce((acc, p) => { acc[p.device_id] = p.placeholder_file; return acc; }, {}),
    exportedAt: new Date().toISOString()
  };
}

export { driverType };
