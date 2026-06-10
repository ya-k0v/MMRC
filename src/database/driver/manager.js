import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SqliteDriver } from './SqliteDriver.js';
import { PostgresDriver } from './PostgresDriver.js';
import logger from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _driver = null;

export function getSchemaSql(dialect) {
  const file = dialect === 'postgres' ? 'postgres-schema.sql' : 'sqlite-schema.sql';
  const schemaPath = path.join(__dirname, file);
  return fs.readFileSync(schemaPath, 'utf-8');
}

export function resolveDriverConfig() {
  const type = (process.env.DB_TYPE || 'sqlite').toLowerCase();

  if (type === 'postgres') {
    return {
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'mmrc',
      user: process.env.DB_USER || 'mmrc',
      password: process.env.DB_PASSWORD || 'mmrc',
      max: parseInt(process.env.DB_POOL_MAX || '20', 10)
    };
  }

  return {
    type: 'sqlite',
    path: process.env.DB_PATH || path.join(process.cwd(), 'config', 'main.db')
  };
}

export async function createDriver(config) {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }

  if (config.type === 'postgres') {
    _driver = new PostgresDriver();
    await _driver.connect(config);
  } else {
    _driver = new SqliteDriver();
    await _driver.connect(config);
  }

  logger.info(`[DB] Driver created: ${config.type}`);
  return _driver;
}

export function getDriver() {
  if (!_driver) {
    throw new Error('Database driver not initialized. Call createDriver() first.');
  }
  return _driver;
}

export async function closeDriver() {
  if (_driver) {
    await _driver.close();
    _driver = null;
    logger.info('[DB] Driver closed');
  }
}
