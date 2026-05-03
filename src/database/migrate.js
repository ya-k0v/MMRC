#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, getDatabase } from './database.js';
import { ROOT } from '../config/constants.js';
import logger from '../utils/logger.js';

function hasColumn(db, tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function ensureSchemaMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

const MIGRATIONS = [
  {
    id: '2026-04-07-users-auth-columns',
    description: 'Ensure users.auth_source/users.ldap_dn and index',
    up(db) {
      if (!hasColumn(db, 'users', 'auth_source')) {
        db.exec("ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'");
      }

      if (!hasColumn(db, 'users', 'ldap_dn')) {
        db.exec('ALTER TABLE users ADD COLUMN ldap_dn TEXT');
      }

      db.exec("UPDATE users SET auth_source = 'local' WHERE auth_source IS NULL OR auth_source = ''");
      db.exec('CREATE INDEX IF NOT EXISTS idx_users_auth_source ON users(auth_source)');
    }
  },
  {
    id: '2026-04-13-refresh-tokens-last-used',
    description: 'Ensure refresh_tokens.last_used column and index',
    up(db) {
      if (!hasColumn(db, 'refresh_tokens', 'last_used')) {
        db.exec('ALTER TABLE refresh_tokens ADD COLUMN last_used DATETIME');
      }

      db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_last_used ON refresh_tokens(last_used)');
    }
  }
];

function runRegisteredMigrations(db) {
  ensureSchemaMigrationsTable(db);

  const executedRows = db
    .prepare('SELECT id FROM schema_migrations')
    .all();
  const executedIds = new Set(executedRows.map((row) => row.id));

  for (const migration of MIGRATIONS) {
    if (executedIds.has(migration.id)) {
      continue;
    }

    logger.info('[migrate] Applying migration', {
      id: migration.id,
      description: migration.description
    });

    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (id, description, executed_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
      ).run(migration.id, migration.description);
    });

    tx();

    logger.info('[migrate] Migration applied', {
      id: migration.id
    });
  }
}

export function runMigrations(dbPath) {
  const DATA_DIR = process.env.MMRC_DATA_DIR || path.join(ROOT, 'data');
  const finalPath = dbPath || path.join(DATA_DIR, 'db', 'main.db');
  logger.info('[migrate] Running database initialization/migration', { dbPath: finalPath });
  initDatabase(finalPath);
  const db = getDatabase();
  runRegisteredMigrations(db);
  logger.info('[migrate] Database initialization/migration completed');
}

// If executed directly, run and exit with code
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runMigrations();
    process.exit(0);
  } catch (err) {
    logger.error('[migrate] Migration failed', { error: err?.message || String(err) });
    process.exit(2);
  }
}
