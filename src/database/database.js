/**
 * Database module - SQLite database for VideoControl
 * @module database/database
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { withRetrySync, isRetryableDatabaseError } from '../utils/retry.js';
import { circuitBreakers } from '../utils/circuit-breaker.js';
import logger from '../utils/logger.js';

let db = null;
let dbPath = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000;

/**
 * Инициализация базы данных
 * @param {string} dbPath - Путь к файлу БД (по умолчанию: ROOT/config/main.db)
 * @returns {Database} Экземпляр БД
 */
export function initDatabase(initialDbPath) {
  if (db) {
    logger.info('[DB] Database already initialized');
    return db;
  }

  dbPath = initialDbPath;

  try {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(dbPath);
    
    // ВАЖНО: better-sqlite3 не поддерживает события (db.on)
    // Ошибки обрабатываются через try-catch при выполнении запросов
    
    // Включаем WAL mode для лучшей производительности
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000'); // 64MB cache
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 30000000000'); // 30GB mmap
    
    logger.info(`[DB] Database initialized: ${dbPath}`);
    logger.info('[DB] WAL mode enabled, cache_size=64MB');
    
    // Загружаем схему
    const initPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'init.sql');
    const initSQL = fs.readFileSync(initPath, 'utf-8');
    
    // Выполняем схему
    db.exec(initSQL);
    logger.info('[DB] Database schema initialized');
    
    ensureFilesMetadataStreamingColumns();
    
    // Миграция: Добавляем роль hero_admin в существующие базы
    try {
      // Проверяем, есть ли таблица users
      const usersTableExists = db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='users'
      `).get();
      
      if (usersTableExists) {
        // Проверяем, нужно ли мигрировать CHECK constraint для роли hero_admin
        // SQLite не поддерживает изменение CHECK constraint напрямую, нужно пересоздать таблицу
        const tableInfo = db.prepare('PRAGMA table_info(users)').all();
        const roleColumn = tableInfo.find(col => col.name === 'role');
        
        if (roleColumn) {
          // Проверяем определение таблицы через sqlite_master
          const tableDef = db.prepare(`
            SELECT sql FROM sqlite_master 
            WHERE type='table' AND name='users'
          `).get();
          
          // Проверяем, содержит ли CHECK constraint роль hero_admin
          const needsMigration = tableDef && tableDef.sql && !tableDef.sql.includes("'hero_admin'");
          
          if (needsMigration) {
            logger.info('[DB] Migrating users table to support hero_admin role...');
            
            // Создаем резервную копию данных
            const usersData = db.prepare('SELECT * FROM users').all();
            logger.info(`[DB] Backed up ${usersData.length} user records`);
            
            // Переименовываем старую таблицу
            db.exec('ALTER TABLE users RENAME TO users_old');
            logger.info('[DB] Renamed old users table to users_old');
            
            // Создаем новую таблицу с обновленным CHECK constraint
            db.exec(`
              CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                full_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'speaker' CHECK(role IN ('admin', 'speaker', 'hero_admin')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME,
                is_active BOOLEAN DEFAULT 1
              )
            `);
            logger.info('[DB] Created new users table with hero_admin role support');
            
            // Копируем данные из старой таблицы
            if (usersData.length > 0) {
              const insertStmt = db.prepare(`
                INSERT INTO users (id, username, full_name, password_hash, role, created_at, updated_at, last_login, is_active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `);
              
              const insertMany = db.transaction((users) => {
                for (const user of users) {
                  insertStmt.run(
                    user.id,
                    user.username,
                    user.full_name,
                    user.password_hash,
                    user.role,
                    user.created_at,
                    user.updated_at,
                    user.last_login,
                    user.is_active
                  );
                }
              });
              
              insertMany(usersData);
              logger.info(`[DB] Migrated ${usersData.length} user records to new table`);
            }
            
            // Восстанавливаем индексы
            db.exec('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active)');
            logger.info('[DB] Restored indexes');
            
            // Исправляем foreign key в связанных таблицах (они могут ссылаться на users_old)
            try {
              // Исправляем refresh_tokens
              const refreshTokensFK = db.prepare(`
                SELECT sql FROM sqlite_master 
                WHERE type='table' AND name='refresh_tokens'
              `).get();
              
              if (refreshTokensFK && refreshTokensFK.sql && refreshTokensFK.sql.includes('users_old')) {
                logger.info('[DB] Fixing foreign key in refresh_tokens table...');
                
                // Сохраняем данные
                const tokensData = db.prepare('SELECT * FROM refresh_tokens').all();
                
                // Удаляем старую таблицу
                db.exec('DROP TABLE refresh_tokens');
                
                // Создаем новую таблицу с правильным foreign key
                db.exec(`
                  CREATE TABLE refresh_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    token TEXT UNIQUE NOT NULL,
                    expires_at DATETIME NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    ip_address TEXT,
                    user_agent TEXT,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                  )
                `);
                
                // Восстанавливаем данные
                if (tokensData.length > 0) {
                  const insertToken = db.prepare(`
                    INSERT INTO refresh_tokens (id, user_id, token, expires_at, created_at, ip_address, user_agent)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                  `);
                  
                  const insertManyTokens = db.transaction((tokens) => {
                    for (const token of tokens) {
                      insertToken.run(
                        token.id,
                        token.user_id,
                        token.token,
                        token.expires_at,
                        token.created_at,
                        token.ip_address,
                        token.user_agent
                      );
                    }
                  });
                  
                  insertManyTokens(tokensData);
                }
                
                // Восстанавливаем индексы
                db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at)');
                
                logger.info('[DB] Fixed foreign key in refresh_tokens table');
              }
              
              // Исправляем audit_log
              const auditLogFK = db.prepare(`
                SELECT sql FROM sqlite_master 
                WHERE type='table' AND name='audit_log'
              `).get();
              
              if (auditLogFK && auditLogFK.sql && auditLogFK.sql.includes('users_old')) {
                logger.info('[DB] Fixing foreign key in audit_log table...');
                
                // Сохраняем данные audit_log
                const auditData = db.prepare('SELECT * FROM audit_log').all();
                
                // Удаляем старую таблицу audit_log
                db.exec('DROP TABLE audit_log');
                
                // Создаем новую таблицу с правильным foreign key
                db.exec(`
                  CREATE TABLE audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    action TEXT NOT NULL,
                    resource TEXT,
                    details TEXT,
                    ip_address TEXT,
                    user_agent TEXT,
                    status TEXT DEFAULT 'success',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
                  )
                `);
                
                // Восстанавливаем данные
                if (auditData.length > 0) {
                  const insertAudit = db.prepare(`
                    INSERT INTO audit_log (id, user_id, action, resource, details, ip_address, user_agent, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                  `);
                  
                  const insertManyAudit = db.transaction((audits) => {
                    for (const audit of audits) {
                      insertAudit.run(
                        audit.id,
                        audit.user_id,
                        audit.action,
                        audit.resource,
                        audit.details,
                        audit.ip_address,
                        audit.user_agent,
                        audit.status,
                        audit.created_at
                      );
                    }
                  });
                  
                  insertManyAudit(auditData);
                }
                
                // Восстанавливаем индексы audit_log
                db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_status ON audit_log(status)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at)');
                
                logger.info('[DB] Fixed foreign key in audit_log table');
              }
            } catch (fkErr) {
              logger.warn('[DB] Failed to fix foreign keys (non-critical):', fkErr.message);
            }
            
            // Удаляем старую таблицу
            db.exec('DROP TABLE users_old');
            logger.info('[DB] Removed old users table');
            
            logger.info('[DB] ✅ Migration completed successfully - hero_admin role is now supported');
          } else {
            logger.info('[DB] Users table already supports hero_admin role');
          }
        }
      }
    } catch (migrationErr) {
      logger.error('[DB] Migration failed:', migrationErr);
      // Не прерываем инициализацию, но логируем ошибку
      logger.warn('[DB] Continuing with existing schema - hero_admin role may not be available');
    }
    
    reconnectAttempts = 0;
    return db;
  } catch (e) {
    logger.error('[DB] Failed to initialize database:', e);
    throw e;
  }
}

function ensureFilesMetadataStreamingColumns() {
  try {
    const columns = db.prepare('PRAGMA table_info(files_metadata)').all();
    const names = new Set(columns.map(col => col.name));
    if (!names.has('content_type')) {
      db.exec(`ALTER TABLE files_metadata ADD COLUMN content_type TEXT DEFAULT 'file'`);
      logger.info('[DB] Added content_type column to files_metadata');
    }
    if (!names.has('stream_url')) {
      db.exec(`ALTER TABLE files_metadata ADD COLUMN stream_url TEXT`);
      logger.info('[DB] Added stream_url column to files_metadata');
    }
    if (!names.has('stream_protocol')) {
      db.exec(`ALTER TABLE files_metadata ADD COLUMN stream_protocol TEXT DEFAULT 'auto'`);
      logger.info('[DB] Added stream_protocol column to files_metadata');
    }
  } catch (err) {
    logger.warn('[DB] Failed to ensure streaming columns (non-critical)', { error: err.message });
  }
}

/**
 * Переподключение к БД при сбое
 */
function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logger.error('[DB] Max reconnect attempts reached, giving up');
    return;
  }

  reconnectAttempts++;
  logger.warn(`[DB] Scheduling reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${RECONNECT_DELAY}ms`);

  setTimeout(() => {
    try {
      if (db) {
        try {
          db.close();
        } catch (e) {
          // Ignore close errors
        }
      }
      db = null;
      initDatabase(dbPath);
    } catch (e) {
      logger.error('[DB] Reconnect failed:', e);
      scheduleReconnect();
    }
  }, RECONNECT_DELAY);
}

/**
 * Получить экземпляр БД с проверкой соединения
 * @returns {Database}
 */
export function getDatabase() {
  if (!db) {
    if (dbPath) {
      // Пытаемся переподключиться
      try {
        initDatabase(dbPath);
      } catch (e) {
        logger.error('[DB] Failed to reconnect:', e);
        throw new Error('Database not available. Reconnection failed.');
      }
    } else {
      throw new Error('Database not initialized. Call initDatabase() first.');
    }
  }

  // Проверяем, что БД еще открыта
  try {
    db.prepare('SELECT 1').get();
  } catch (e) {
    logger.warn('[DB] Database connection lost, attempting reconnect');
    db = null;
    if (dbPath) {
      try {
        initDatabase(dbPath);
      } catch (reconnectError) {
        logger.error('[DB] Reconnect failed:', reconnectError);
        throw new Error('Database connection lost and reconnection failed.');
      }
    } else {
      throw new Error('Database connection lost.');
    }
  }

  return db;
}

/**
 * Закрыть БД
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    logger.info('[DB] ✅ Database closed');
  }
}

// ========================================
// DEVICES
// ========================================

/**
 * Получить все устройства
 * @returns {Object} Объект {device_id: {...}}
 */
export function getAllDevices() {
  // КРИТИЧНО: Эта функция вызывается синхронно при старте сервера
  // Не используем circuit breaker здесь, так как он асинхронный
  // Circuit breaker используется только для операций во время работы сервера
  try {
    return withRetrySync(() => {
      const database = getDatabase();
      const stmt = database.prepare(`
        SELECT device_id, name, folder, device_type, platform, capabilities, 
               last_seen, current_state, created_at, updated_at
        FROM devices
        ORDER BY device_id
      `);
      
      const rows = stmt.all();
      const devices = {};
      
      for (const row of rows) {
        try {
          devices[row.device_id] = {
            name: row.name,
            folder: row.folder,
            deviceType: row.device_type,
            platform: row.platform,
            capabilities: row.capabilities ? JSON.parse(row.capabilities) : null,
            lastSeen: row.last_seen,
            current: row.current_state ? JSON.parse(row.current_state) : { type: 'idle', file: null, state: 'idle' },
            files: [], // Заполняется при сканировании
            fileNames: [] // Заполняется при сканировании
          };
        } catch (parseError) {
          logger.error(`[DB] Error parsing device ${row.device_id}:`, parseError);
          // Продолжаем загрузку других устройств даже при ошибке парсинга одного
          devices[row.device_id] = {
            name: row.name || row.device_id,
            folder: row.folder || row.device_id,
            deviceType: row.device_type || 'browser',
            platform: row.platform || null,
            capabilities: null,
            lastSeen: row.last_seen,
            current: { type: 'idle', file: null, state: 'idle' },
            files: [],
            fileNames: []
          };
        }
      }
      
      logger.info(`[DB] getAllDevices: loaded ${Object.keys(devices).length} devices`);
      return devices;
    }, {
      maxRetries: 3,
      delay: 500,
      shouldRetry: isRetryableDatabaseError,
      onRetry: (error, attempt, max) => {
        logger.warn(`[DB] Retry ${attempt}/${max} for getAllDevices:`, error.message);
      }
    });
  } catch (e) {
    logger.error('[DB] Critical error in getAllDevices:', e);
    // Последняя попытка - загрузить хотя бы базовые данные
    try {
      const database = getDatabase();
      const stmt = database.prepare('SELECT device_id, name, folder FROM devices');
      const rows = stmt.all();
      const devices = {};
      for (const row of rows) {
        devices[row.device_id] = {
          name: row.name,
          folder: row.folder,
          deviceType: 'browser',
          platform: null,
          capabilities: null,
          lastSeen: null,
          current: { type: 'idle', file: null, state: 'idle' },
          files: [],
          fileNames: []
        };
      }
      logger.warn(`[DB] Fallback: loaded ${Object.keys(devices).length} devices with minimal data`);
      return devices;
    } catch (fallbackError) {
      logger.error('[DB] Fallback also failed:', fallbackError);
      return {};
    }
  }
}

/**
 * Сохранить устройство
 * @param {string} deviceId 
 * @param {Object} data 
 */
export function saveDevice(deviceId, data) {
  return circuitBreakers.database.execute(() => {
    return withRetrySync(() => {
      const database = getDatabase();
      const stmt = database.prepare(`
        INSERT INTO devices (device_id, name, folder, device_type, platform, capabilities, last_seen, current_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          name = excluded.name,
          folder = excluded.folder,
          device_type = excluded.device_type,
          platform = excluded.platform,
          capabilities = excluded.capabilities,
          last_seen = excluded.last_seen,
          current_state = excluded.current_state,
          updated_at = CURRENT_TIMESTAMP
      `);
      
      stmt.run(
        deviceId,
        data.name,
        data.folder,
        data.deviceType || 'browser',
        data.platform || null,
        data.capabilities ? JSON.stringify(data.capabilities) : null,
        data.lastSeen || null,
        data.current ? JSON.stringify(data.current) : null
      );
    }, {
      maxRetries: 3,
      delay: 500,
      shouldRetry: isRetryableDatabaseError
    });
  }).catch((e) => {
    logger.error('[DB] Error saving device:', e);
    throw e;
  });
}

/**
 * Удалить устройство
 * @param {string} deviceId 
 */
export function deleteDevice(deviceId) {
  const stmt = db.prepare('DELETE FROM devices WHERE device_id = ?');
  stmt.run(deviceId);
}

// ========================================
// FILE NAMES MAPPING
// ========================================

/**
 * Получить все маппинги имен файлов
 * @returns {Object} {device_id: {safe_name: original_name}}
 */
export function getAllFileNames() {
  const stmt = db.prepare('SELECT device_id, safe_name, original_name FROM file_names');
  const rows = stmt.all();
  
  const mapping = {};
  for (const row of rows) {
    if (!mapping[row.device_id]) {
      mapping[row.device_id] = {};
    }
    mapping[row.device_id][row.safe_name] = row.original_name;
  }
  
  return mapping;
}

/**
 * Сохранить маппинг имени файла
 * @param {string} deviceId 
 * @param {string} safeName 
 * @param {string} originalName 
 */
export function saveFileName(deviceId, safeName, originalName) {
  const stmt = db.prepare(`
    INSERT INTO file_names (device_id, safe_name, original_name)
    VALUES (?, ?, ?)
    ON CONFLICT(device_id, safe_name) DO UPDATE SET
      original_name = excluded.original_name
  `);
  
  stmt.run(deviceId, safeName, originalName);
}

/**
 * Удалить маппинг файла
 * @param {string} deviceId 
 * @param {string} safeName 
 */
export function deleteFileName(deviceId, safeName) {
  const stmt = db.prepare('DELETE FROM file_names WHERE device_id = ? AND safe_name = ?');
  stmt.run(deviceId, safeName);
}

/**
 * Удалить все маппинги устройства
 * @param {string} deviceId 
 */
export function deleteDeviceFileNames(deviceId) {
  const stmt = db.prepare('DELETE FROM file_names WHERE device_id = ?');
  stmt.run(deviceId);
}

// ========================================
// FILE STATUSES (для оптимизации видео)
// ========================================

/**
 * Получить статус файла
 * @param {string} deviceId 
 * @param {string} fileName 
 * @returns {Object|null}
 */
export function getFileStatus(deviceId, fileName) {
  const stmt = db.prepare(`
    SELECT status, resolution, original_resolution, needs_optimization, error, updated_at
    FROM file_statuses
    WHERE device_id = ? AND file_name = ?
  `);
  
  const row = stmt.get(deviceId, fileName);
  if (!row) return null;
  
  return {
    status: row.status,
    resolution: row.resolution,
    originalResolution: row.original_resolution,
    needsOptimization: Boolean(row.needs_optimization),
    error: row.error,
    updatedAt: row.updated_at
  };
}

/**
 * Сохранить статус файла
 * @param {string} deviceId 
 * @param {string} fileName 
 * @param {Object} statusData 
 */
export function saveFileStatus(deviceId, fileName, statusData) {
  const stmt = db.prepare(`
    INSERT INTO file_statuses 
      (device_id, file_name, status, resolution, original_resolution, needs_optimization, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, file_name) DO UPDATE SET
      status = excluded.status,
      resolution = excluded.resolution,
      original_resolution = excluded.original_resolution,
      needs_optimization = excluded.needs_optimization,
      error = excluded.error,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  stmt.run(
    deviceId,
    fileName,
    statusData.status || null,
    statusData.resolution || null,
    statusData.originalResolution || null,
    statusData.needsOptimization ? 1 : 0,
    statusData.error || null
  );
}

/**
 * Удалить статус файла
 * @param {string} deviceId 
 * @param {string} fileName 
 */
export function deleteFileStatus(deviceId, fileName) {
  const stmt = db.prepare('DELETE FROM file_statuses WHERE device_id = ? AND file_name = ?');
  stmt.run(deviceId, fileName);
}

/**
 * Получить все статусы файлов устройства
 * @param {string} deviceId 
 * @returns {Object} {fileName: statusData}
 */
export function getDeviceFileStatuses(deviceId) {
  const stmt = db.prepare(`
    SELECT file_name, status, resolution, original_resolution, needs_optimization, error, updated_at
    FROM file_statuses
    WHERE device_id = ?
  `);
  
  const rows = stmt.all(deviceId);
  const statuses = {};
  
  for (const row of rows) {
    statuses[row.file_name] = {
      status: row.status,
      resolution: row.resolution,
      originalResolution: row.original_resolution,
      needsOptimization: Boolean(row.needs_optimization),
      error: row.error,
      updatedAt: row.updated_at
    };
  }
  
  return statuses;
}

// ========================================
// PLACEHOLDERS
// ========================================

/**
 * Получить заглушку устройства
 * @param {string} deviceId 
 * @returns {Object|null}
 */
export function getPlaceholder(deviceId) {
  const stmt = db.prepare(`
    SELECT placeholder_file, placeholder_type, updated_at
    FROM placeholders
    WHERE device_id = ?
  `);
  
  const row = stmt.get(deviceId);
  if (!row) return null;
  
  return {
    file: row.placeholder_file,
    type: row.placeholder_type,
    updatedAt: row.updated_at
  };
}

/**
 * Сохранить заглушку
 * @param {string} deviceId 
 * @param {string} placeholderFile 
 * @param {string} placeholderType 
 */
export function savePlaceholder(deviceId, placeholderFile, placeholderType) {
  const stmt = db.prepare(`
    INSERT INTO placeholders (device_id, placeholder_file, placeholder_type)
    VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      placeholder_file = excluded.placeholder_file,
      placeholder_type = excluded.placeholder_type,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  stmt.run(deviceId, placeholderFile, placeholderType);
}

/**
 * Удалить заглушку
 * @param {string} deviceId 
 */
export function deletePlaceholder(deviceId) {
  const stmt = db.prepare('DELETE FROM placeholders WHERE device_id = ?');
  stmt.run(deviceId);
}

// ========================================
// DEVICE VOLUME STATE
// ========================================

export function getAllDeviceVolumeStates() {
  const stmt = db.prepare(`
    SELECT device_id, volume_level, is_muted, updated_at
    FROM device_volume
  `);
  
  const rows = stmt.all();
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

export function getDeviceVolumeState(deviceId) {
  const stmt = db.prepare(`
    SELECT device_id, volume_level, is_muted, updated_at
    FROM device_volume
    WHERE device_id = ?
  `);
  
  const row = stmt.get(deviceId);
  if (!row) return null;
  return {
    level: row.volume_level ?? 50,
    muted: Boolean(row.is_muted),
    updatedAt: row.updated_at
  };
}

export function saveDeviceVolumeState(deviceId, { volumeLevel, isMuted }) {
  const stmt = db.prepare(`
    INSERT INTO device_volume (device_id, volume_level, is_muted)
    VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      volume_level = excluded.volume_level,
      is_muted = excluded.is_muted,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  stmt.run(deviceId, Number(volumeLevel), isMuted ? 1 : 0);
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Выполнить транзакцию
 * @param {Function} fn - Функция для выполнения в транзакции
 * @returns {*} Результат функции
 */
export function transaction(fn) {
  try {
    const txn = db.transaction(fn);
    return txn();
  } catch (e) {
    logger.error('[DB] ❌ Transaction failed', { error: e.message, stack: e.stack });
    throw e; // Re-throw для обработки на уровне выше
  }
}

/**
 * Получить статистику БД
 * @returns {Object}
 */
export function getDatabaseStats() {
  const deviceCount = db.prepare('SELECT COUNT(*) as count FROM devices').get();
  const fileNameCount = db.prepare('SELECT COUNT(*) as count FROM file_names').get();
  const fileStatusCount = db.prepare('SELECT COUNT(*) as count FROM file_statuses').get();
  const placeholderCount = db.prepare('SELECT COUNT(*) as count FROM placeholders').get();
  
  const dbSize = fs.statSync(db.name).size;
  
  return {
    devices: deviceCount.count,
    fileNames: fileNameCount.count,
    fileStatuses: fileStatusCount.count,
    placeholders: placeholderCount.count,
    dbSize: dbSize,
    dbSizeMB: (dbSize / 1024 / 1024).toFixed(2),
    dbPath: db.name
  };
}

/**
 * Экспорт БД в JSON (для резервного копирования)
 * @returns {Object}
 */
export function exportToJSON() {
  const devices = getAllDevices();
  const fileNames = getAllFileNames();
  const placeholders = db.prepare('SELECT device_id, placeholder_file FROM placeholders').all();
  
  return {
    devices,
    fileNames,
    placeholders: placeholders.reduce((acc, p) => {
      acc[p.device_id] = p.placeholder_file;
      return acc;
    }, {}),
    exportedAt: new Date().toISOString()
  };
}

