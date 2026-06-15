import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DatabaseDriver } from './DatabaseDriver.js';
import { createModuleLogger } from '../../utils/logger.js';
const logger = createModuleLogger('db');

export class SqliteDriver extends DatabaseDriver {
  constructor() {
    super();
    this._db = null;
    this._dbPath = null;
  }

  get dialect() { return 'sqlite'; }

  async connect(config) {
    const dbPath = config.path;
    if (!dbPath) throw new Error('SQLite path required');

    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this._db = new Database(dbPath);
    this._dbPath = dbPath;

    this._db.pragma('journal_mode = WAL');
    this._db.pragma('synchronous = NORMAL');
    this._db.pragma('cache_size = -64000');
    this._db.pragma('temp_store = MEMORY');
    this._db.pragma('mmap_size = 30000000000');

    logger.info(`[SqliteDriver] Connected: ${dbPath}`);
    return this._db;
  }

  async close() {
    if (this._db) {
      this._db.close();
      this._db = null;
      logger.info('[SqliteDriver] Disconnected');
    }
  }

  async query(sql, params = []) {
    return this._db.prepare(sql).all(...params);
  }

  async get(sql, params = []) {
    return this._db.prepare(sql).get(...params) || null;
  }

  async run(sql, params = []) {
    const stmt = this._db.prepare(sql);
    const result = stmt.run(...params);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  async exec(sql) {
    return this._db.exec(sql);
  }

  async transaction(fn) {
    this._db.exec('BEGIN');
    try {
      const result = await fn(this);
      this._db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this._db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  async insert(table, data) {
    const keys = Object.keys(data);
    const placeholders = keys.map(() => '?').join(', ');
    const cols = keys.join(', ');
    const result = await this.run(
      `INSERT INTO ${table} (${cols}) VALUES (${placeholders})`,
      keys.map(k => data[k])
    );
    return result.lastInsertRowid;
  }

  async upsert(table, data, conflictKeys) {
    const keys = Object.keys(data);
    const placeholders = keys.map(() => '?').join(', ');
    const cols = keys.join(', ');
    const updates = keys.map(k => `${k} = excluded.${k}`).join(', ');
    const conflictCols = conflictKeys.join(', ');

    await this.run(
      `INSERT INTO ${table} (${cols}) VALUES (${placeholders})
       ON CONFLICT(${conflictCols}) DO UPDATE SET ${updates}`,
      keys.map(k => data[k])
    );
  }

  async update(table, data, where, whereParams = []) {
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    await this.run(
      `UPDATE ${table} SET ${sets} WHERE ${where}`,
      [...Object.values(data), ...whereParams]
    );
  }

  async delete(table, where, whereParams = []) {
    await this.run(`DELETE FROM ${table} WHERE ${where}`, whereParams);
  }

  async tableExists(name) {
    const row = await this.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      [name]
    );
    return !!row;
  }

  async getSchemaVersion() {
    try {
      const row = await this.get("SELECT value FROM settings WHERE key = 'schema_version'");
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  async setSchemaVersion(version) {
    await this.upsert('settings', { key: 'schema_version', value: String(version) }, ['key']);
  }

  async isConnected() {
    try {
      if (!this._db) return false;
      this._db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async columns(table) {
    const rows = this._db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.map(r => ({
      name: r.name,
      type: r.type,
      notNull: !!r.notnull,
      defaultValue: r.dflt_value
    }));
  }

  hasColumn(columns, name) {
    return columns.some(c => c.name === name);
  }

  get walPath() {
    return this._dbPath ? this._dbPath + '-wal' : null;
  }

  getWalStats() {
    if (!this.walPath || !fs.existsSync(this.walPath)) return null;
    const stats = fs.statSync(this.walPath);
    return { size: stats.size, sizeMB: stats.size / (1024 * 1024) };
  }

  async performWalCheckpoint(mode = 'PASSIVE') {
    this._db.pragma(`wal_checkpoint(${mode})`);
  }

  get dbPath() { return this._dbPath; }

  get raw() { return this._db; }
}
