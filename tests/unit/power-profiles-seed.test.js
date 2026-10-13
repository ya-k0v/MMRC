/**
 * Миграции-сиды начальных профилей питания: вставляют правила в power_profiles
 * ровно один раз (по ключу), дальше они правятся и удаляются как обычные.
 */
import { MIGRATIONS } from '../../src/database/migrate.js';

const SEED_ID = '2026-10-13-power-profiles-seed';

function seedMigration() {
  const migration = MIGRATIONS.find(item => item.id === SEED_ID);
  expect(migration).toBeTruthy();
  return migration;
}

function fakeDriver(existingKeys = []) {
  const inserted = [];
  return {
    dialect: 'sqlite',
    query: async () => existingKeys.map(key => ({ profile_key: key })),
    run: async (sql, params) => { inserted.push({ sql, params }); },
    exec: async () => {},
    tableExists: async () => true,
    inserted
  };
}

describe('migration: сид начальных профилей питания', () => {
  test('вставляет четыре правила с валидными ключами и JSON-шагами', async () => {
    const driver = fakeDriver();
    await seedMigration().up(driver);

    const keys = driver.inserted.map(entry => entry.params[0]);
    expect(keys).toEqual(['default', 'iconbit', 'android-13', 'lumien-lb3235sdg2']);

    for (const entry of driver.inserted) {
      const [, label, model, androidFrom, androidTo, sleepJson, wakeJson] = entry.params;
      expect(label).toBeTruthy();
      expect(model === null || typeof model === 'string').toBe(true);
      expect(androidFrom === null || androidTo === null || androidFrom === androidTo).toBe(true);
      expect(Array.isArray(JSON.parse(sleepJson))).toBe(true);
      expect(Array.isArray(JSON.parse(wakeJson))).toBe(true);
    }
  });

  test('не вставляет уже существующие ключи', async () => {
    const driver = fakeDriver(['default', 'iconbit']);
    await seedMigration().up(driver);

    const keys = driver.inserted.map(entry => entry.params[0]);
    expect(keys).toEqual(['android-13', 'lumien-lb3235sdg2']);
  });
});

const MODELS_SEED_ID = '2026-10-14-power-profiles-device-models';

function modelsSeedMigration() {
  const migration = MIGRATIONS.find(item => item.id === MODELS_SEED_ID);
  expect(migration).toBeTruthy();
  return migration;
}

describe('migration: сид профилей под модели устройств', () => {
  test('вставляет четыре профиля моделей с валидными ключами и JSON-шагами', async () => {
    const driver = fakeDriver();
    await modelsSeedMigration().up(driver);

    const keys = driver.inserted.map(entry => entry.params[0]);
    expect(keys).toEqual([
      'model-ls5550sduhd-cs1382d-g',
      'model-ls5550sd-bo1082d-g',
      'model-smart-aio-tv',
      'model-iconbit-trs2045'
    ]);

    for (const entry of driver.inserted) {
      const [, label, model, sleepJson, wakeJson] = entry.params;
      expect(label).toBeTruthy();
      expect(typeof model).toBe('string');
      expect(Array.isArray(JSON.parse(sleepJson))).toBe(true);
      expect(Array.isArray(JSON.parse(wakeJson))).toBe(true);
      expect(JSON.parse(sleepJson).length).toBeGreaterThan(0);
      expect(JSON.parse(wakeJson).length).toBeGreaterThan(0);
    }
  });

  test('не вставляет уже существующие ключи', async () => {
    const driver = fakeDriver(['model-smart-aio-tv']);
    await modelsSeedMigration().up(driver);

    const keys = driver.inserted.map(entry => entry.params[0]);
    expect(keys).not.toContain('model-smart-aio-tv');
    expect(keys).toHaveLength(3);
  });
});

const KEEP_AWAKE_ID = '2026-10-15-power-profiles-keep-awake';

function keepAwakeMigration() {
  const migration = MIGRATIONS.find(item => item.id === KEEP_AWAKE_ID);
  expect(migration).toBeTruthy();
  return migration;
}

function keepAwakeDriver(withColumn) {
  const events = [];
  return {
    dialect: 'sqlite',
    tableExists: async () => true,
    columns: async () => (withColumn ? [{ name: 'keep_awake_steps' }] : []),
    exec: async (sql) => { events.push({ kind: 'exec', sql }); },
    query: async () => [],
    run: async (sql, params) => { events.push({ kind: 'run', sql, params }); },
    events
  };
}

describe('migration: keep_awake_steps для профилей питания', () => {
  test('добавляет колонку и засевает удержание для панельных профилей', async () => {
    const driver = keepAwakeDriver(false);
    await keepAwakeMigration().up(driver);

    const alter = driver.events.find(e => e.kind === 'exec' && /ADD COLUMN keep_awake_steps/.test(e.sql));
    expect(alter).toBeTruthy();

    const updates = driver.events.filter(e => e.kind === 'run' && /keep_awake_steps/.test(e.sql));
    const keys = updates.map(e => e.params[1]);
    expect(keys).toEqual(expect.arrayContaining(['android-13', 'iconbit', 'model-smart-aio-tv']));
    for (const update of updates) {
      const steps = JSON.parse(update.params[0]);
      expect(Array.isArray(steps)).toBe(true);
      expect(steps.some(s => String(s).includes('screensaver_enabled'))).toBe(true);
      expect(update.sql).toContain("keep_awake_steps = '[]'");
    }
  });

  test('не трогает колонку, если она уже есть', async () => {
    const driver = keepAwakeDriver(true);
    await keepAwakeMigration().up(driver);
    expect(driver.events.some(e => e.kind === 'exec' && /ADD COLUMN/.test(e.sql))).toBe(false);
  });
});
