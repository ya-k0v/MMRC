import pg from 'pg';
import { DatabaseDriver } from './DatabaseDriver.js';
import { createModuleLogger } from '../../utils/logger.js';
const logger = createModuleLogger('db');

export class PostgresDriver extends DatabaseDriver {
  constructor() {
    super();
    this._pool = null;
    this._config = null;
  }

  get dialect() { return 'postgres'; }

  async connect(config) {
    this._config = {
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database || 'mmrc',
      user: config.user || 'mmrc',
      password: config.password || 'mmrc',
      max: config.max || 20,
      idleTimeoutMillis: config.idleTimeoutMillis || 30000,
      connectionTimeoutMillis: config.connectionTimeoutMillis || 5000,
      ...config.extra
    };

    this._pool = new pg.Pool(this._config);

    this._pool.on('error', (err) => {
      logger.error('[PostgresDriver] Pool error', { error: err.message });
    });

    const client = await this._pool.connect();
    try {
      await client.query('SELECT 1');
      logger.info(`[PostgresDriver] Connected: ${this._config.host}:${this._config.port}/${this._config.database}`);
    } finally {
      client.release();
    }

    return this._pool;
  }

  async close() {
    if (this._pool) {
      await this._pool.end();
      this._pool = null;
      logger.info('[PostgresDriver] Disconnected');
    }
  }

  _convertParams(sql, params) {
    if (!params || params.length === 0 || sql.includes('$1')) return { sql, params };
    let idx = 0;
    const converted = sql.replace(/\?/g, () => `$${++idx}`);
    if (idx > 0) return { sql: converted, params };
    return { sql, params };
  }

  async query(sql, params = []) {
    const q = this._convertParams(sql, params);
    const result = await this._pool.query(q.sql, q.params);
    return result.rows;
  }

  async get(sql, params = []) {
    const q = this._convertParams(sql, params);
    const result = await this._pool.query(q.sql, q.params);
    return result.rows[0] || null;
  }

  async _runReturning(sql, params) {
    const result = await this._pool.query(sql, params);
    const row = result.rows[0];
    return {
      changes: result.rowCount || 0,
      lastInsertRowid: row?.id ?? row?.device_id ?? null
    };
  }

  async run(sql, params = []) {
    const q = this._convertParams(sql, params);
    let finalSql = q.sql;
    const isInsert = /^\s*INSERT\s/i.test(finalSql);
    if (isInsert && !/RETURNING\s/i.test(finalSql)) {
      finalSql += ' RETURNING *';
      try {
        return await this._runReturning(finalSql, q.params);
      } catch (err) {
        if (err.message?.includes('column "id" does not exist')) {
          const result = await this._pool.query(q.sql, q.params);
          return { changes: result.rowCount || 0, lastInsertRowid: null };
        }
        throw err;
      }
    }
    const result = await this._pool.query(finalSql, q.params);
    const row = result.rows[0];
    return {
      changes: result.rowCount || 0,
      lastInsertRowid: row?.id ?? row?.device_id ?? null
    };
  }

  async exec(sql) {
    await this._pool.query(sql);
  }

  async transaction(fn) {
    const client = await this._pool.connect();
    try {
      await client.query('BEGIN');
      const conv = (sql, params) => {
        const q = typeof sql === 'string' && params?.length && !sql.includes('$1')
          ? { sql: sql.replace(/\?/g, (() => { let i = 0; return () => `$${++i}`; })()), params }
          : { sql, params };
        return q;
      };
      const result = await fn({
        dialect: this.dialect,
        query: (sql, params) => { const q = conv(sql, params); return client.query(q.sql, q.params); },
        get: async (sql, params) => {
          const q = conv(sql, params);
          const r = await client.query(q.sql, q.params);
          return r.rows[0] || null;
        },
        run: async (sql, params) => {
          let q = conv(sql, params);
          let finalSql = q.sql;
          const isInsert = /^\s*INSERT\s/i.test(finalSql);
          if (isInsert && !/RETURNING\s/i.test(finalSql)) {
            finalSql += ' RETURNING *';
            try {
              const r = await client.query(finalSql, q.params);
              const row = r.rows[0];
              return { changes: r.rowCount || 0, lastInsertRowid: row?.id ?? row?.device_id ?? null };
            } catch (err) {
              if (err.message?.includes('column "id" does not exist')) {
                const r = await client.query(q.sql, q.params);
                return { changes: r.rowCount || 0, lastInsertRowid: null };
              }
              throw err;
            }
          }
          const r = await client.query(finalSql, q.params);
          const row = r.rows[0];
          return { changes: r.rowCount || 0, lastInsertRowid: row?.id ?? row?.device_id ?? null };
        },
        exec: async (sql) => { await client.query(sql); },
        columns: async (table) => {
          const rows = await client.query(
            `SELECT column_name as name, data_type as type,
                    is_nullable = 'NO' as not_null,
                    column_default as default_value
             FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = $1
             ORDER BY ordinal_position`,
            [table]
          );
          return rows.rows.map(r => ({
            name: r.name,
            type: r.type,
            notNull: r.not_null,
            defaultValue: r.default_value
          }));
        }
      });
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async insert(table, data) {
    const keys = Object.keys(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const returning = `${table}_returning`;

    const result = await this._pool.query(
      `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`,
      keys.map(k => data[k])
    );
    const row = result.rows[0];
    return row?.id ?? row?.device_id ?? null;
  }

  async upsert(table, data, conflictKeys) {
    const keys = Object.keys(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const cols = keys.join(', ');
    const updates = keys.map((k, i) => `${k} = $${i + 1 + keys.length}`).join(', ');
    const conflictCols = conflictKeys.join(', ');

    await this._pool.query(
      `INSERT INTO ${table} (${cols}) VALUES (${placeholders})
       ON CONFLICT (${conflictCols}) DO UPDATE SET ${updates}`,
      [...keys.map(k => data[k]), ...keys.map(k => data[k])]
    );
  }

  async update(table, data, where, whereParams = []) {
    const keys = Object.keys(data);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const offset = keys.length;
    const whereClause = typeof where === 'string'
      ? where.replace(/\?/g, () => `$${++offset}`)
      : where;

    await this._pool.query(
      `UPDATE ${table} SET ${sets} WHERE ${whereClause}`,
      [...Object.values(data), ...whereParams]
    );
  }

  async delete(table, where, whereParams = []) {
    const whereClause = typeof where === 'string'
      ? where.replace(/\?/g, (match, i) => `$${i + 1}`)
      : where;
    await this._pool.query(`DELETE FROM ${table} WHERE ${whereClause}`, whereParams);
  }

  async tableExists(name) {
    const row = await this.get(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
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
      if (!this._pool) return false;
      const client = await this._pool.connect();
      try {
        await client.query('SELECT 1');
        return true;
      } finally {
        client.release();
      }
    } catch {
      return false;
    }
  }

  async columns(table) {
    const rows = await this.query(
      `SELECT column_name as name, data_type as type,
              is_nullable = 'NO' as not_null,
              column_default as default_value
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );
    return rows.map(r => ({
      name: r.name,
      type: r.type,
      notNull: r.not_null,
      defaultValue: r.default_value
    }));
  }

  hasColumn(columns, name) {
    return columns.some(c => c.name === name);
  }

  get pool() { return this._pool; }
}
