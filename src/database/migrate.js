#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, getDatabase } from './database.js';
import { ROOT } from '../config/constants.js';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('db');

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
        executed_at ${driver.dialect === 'postgres' ? 'TIMESTAMP' : 'DATETIME'} DEFAULT CURRENT_TIMESTAMP
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
        await driver.exec(`ALTER TABLE refresh_tokens ADD COLUMN last_used ${driver.dialect === 'postgres' ? 'TIMESTAMP' : 'DATETIME'}`);
      }
      await driver.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_last_used ON refresh_tokens(last_used)');
    }
  }
];

async function runRegisteredMigrations(driver) {
  await ensureSchemaMigrationsTable(driver);

  // PostgreSQL: use advisory lock so only one replica runs migrations
  const isPostgres = driver.dialect === 'postgres';
  let lockHeld = false;

  if (isPostgres) {
    const lockResult = await driver.query("SELECT pg_try_advisory_lock(20260407) as locked");
    lockHeld = lockResult[0]?.locked === true || lockResult[0]?.locked === 't';
    if (!lockHeld) {
      logger.warn('[migrate] Advisory lock not acquired — another replica is running migrations, skipping');
    }
  }

  try {
    const executedRows = await driver.query('SELECT id FROM schema_migrations');
    const executedIds = new Set(executedRows.map((row) => row.id));

    for (const migration of MIGRATIONS) {
      if (executedIds.has(migration.id)) continue;

      if (isPostgres && !lockHeld) {
        logger.warn('[migrate] Skipping migration (no lock)', { id: migration.id });
        continue;
      }

      logger.info('[migrate] Applying migration', { id: migration.id, description: migration.description });

      const ph = (i) => driver.dialect === 'postgres' ? `$${i}` : '?';
      await driver.transaction(async (tx) => {
        await migration.up(tx || driver);
        await (tx || driver).run(
          `INSERT INTO schema_migrations (id, description, executed_at) VALUES (${ph(1)}, ${ph(2)}, CURRENT_TIMESTAMP)`,
          [migration.id, migration.description]
        );
      });

      logger.info('[migrate] Migration applied', { id: migration.id });
    }
  } finally {
    if (lockHeld) {
      await driver.query("SELECT pg_advisory_unlock(20260407)").catch(() => {});
    }
  }
}

export async function runMigrations(dbPath) {
  const DATA_DIR = process.env.MMRC_DATA_DIR || path.join(ROOT, 'data');
  const finalPath = dbPath || path.join(DATA_DIR, 'db', 'main.db');
  logger.info('[migrate] Running database initialization/migration', { dbPath: finalPath });
  await initDatabase(finalPath);
  const db = getDatabase();
  await runRegisteredMigrations(db);
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
