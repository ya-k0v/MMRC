#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, getDatabase, driverType } from './database.js';
import { ROOT } from '../config/constants.js';
import logger from '../utils/logger.js';

async function hasColumn(driver, tableName, columnName) {
  const cols = await driver.columns(tableName);
  return cols.some(c => c.name === columnName);
}

async function ensureSchemaMigrationsTable(driver) {
  const exists = await driver.tableExists('schema_migrations');
  if (!exists) {
    await driver.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        description TEXT,
        executed_at ${driverType === 'postgres' ? 'TIMESTAMP' : 'DATETIME'} DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
}

const MIGRATIONS = [
  {
    id: '2026-04-07-users-auth-columns',
    description: 'Ensure users.auth_source/users.ldap_dn and index',
    async up(driver) {
      if (!(await hasColumn(driver, 'users', 'auth_source'))) {
        await driver.exec("ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'");
      }
      if (!(await hasColumn(driver, 'users', 'ldap_dn'))) {
        await driver.exec('ALTER TABLE users ADD COLUMN ldap_dn TEXT');
      }
      await driver.exec("UPDATE users SET auth_source = 'local' WHERE auth_source IS NULL OR auth_source = ''");
      await driver.exec('CREATE INDEX IF NOT EXISTS idx_users_auth_source ON users(auth_source)');
    }
  },
  {
    id: '2026-04-13-refresh-tokens-last-used',
    description: 'Ensure refresh_tokens.last_used column and index',
    async up(driver) {
      if (!(await hasColumn(driver, 'refresh_tokens', 'last_used'))) {
        await driver.exec(`ALTER TABLE refresh_tokens ADD COLUMN last_used ${driverType === 'postgres' ? 'TIMESTAMP' : 'DATETIME'}`);
      }
      await driver.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_last_used ON refresh_tokens(last_used)');
    }
  }
];

async function runRegisteredMigrations(driver) {
  await ensureSchemaMigrationsTable(driver);

  const executedRows = await driver.query('SELECT id FROM schema_migrations');
  const executedIds = new Set(executedRows.map((row) => row.id));

  for (const migration of MIGRATIONS) {
    if (executedIds.has(migration.id)) continue;

    logger.info('[migrate] Applying migration', { id: migration.id, description: migration.description });

    const ph = (i) => driverType === 'postgres' ? `$${i}` : '?';
    await driver.transaction(async (tx) => {
      await migration.up(tx || driver);
      await (tx || driver).run(
        `INSERT INTO schema_migrations (id, description, executed_at) VALUES (${ph(1)}, ${ph(2)}, CURRENT_TIMESTAMP)`,
        [migration.id, migration.description]
      );
    });

    logger.info('[migrate] Migration applied', { id: migration.id });
  }
}

export async function runMigrations(dbPath) {
  const dbType = (process.env.DB_TYPE || 'sqlite').toLowerCase();

  let config;
  if (dbType === 'postgres') {
    config = {
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'mmrc',
      user: process.env.DB_USER || 'mmrc',
      password: process.env.DB_PASSWORD || 'mmrc'
    };
  } else {
    const finalPath = dbPath || path.join(ROOT, 'config', 'main.db');
    config = { type: 'sqlite', path: finalPath };
  }

  logger.info('[migrate] Running database initialization/migration', {
    dbType,
    ...(dbType === 'postgres'
      ? { host: config.host, port: config.port, database: config.database }
      : { dbPath: config.path })
  });

  await initDatabase(config);
  const driver = getDatabase();
  await runRegisteredMigrations(driver);
  logger.info('[migrate] Database initialization/migration completed');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runMigrations();
    process.exit(0);
  } catch (err) {
    logger.error('[migrate] Migration failed', { error: err?.message || String(err) });
    process.exit(2);
  }
}
