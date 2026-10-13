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

const DEFAULT_ID = '2026-10-16-power-profiles-default';

function defaultMigration() {
  const migration = MIGRATIONS.find(item => item.id === DEFAULT_ID);
  expect(migration).toBeTruthy();
  return migration;
}

describe('migration: профиль по умолчанию', () => {
  test('вставляет catch-all профиль default, если его нет', async () => {
    const driver = fakeDriver(['model-smart-aio-tv']);
    await defaultMigration().up(driver);

    expect(driver.inserted).toHaveLength(1);
    const { params } = driver.inserted[0];
    expect(params[0]).toBe('default');
    expect(params[1]).toBeTruthy();
    expect(JSON.parse(params[2])).toEqual([223]);
    expect(JSON.parse(params[3])).toEqual([224, 26, 170]);
  });

  test('не дублирует профиль по умолчанию', async () => {
    const driver = fakeDriver(['default']);
    await defaultMigration().up(driver);
    expect(driver.inserted).toHaveLength(0);
  });
});

const SLEEP_DETECT_ID = '2026-10-17-power-profiles-sleep-detect';

function sleepDetectMigration() {
  const migration = MIGRATIONS.find(item => item.id === SLEEP_DETECT_ID);
  expect(migration).toBeTruthy();
  return migration;
}

function columnDriver(existingColumns = []) {
  const events = [];
  return {
    dialect: 'sqlite',
    columns: async () => existingColumns.map(name => ({ name })),
    exec: async (sql) => { events.push({ kind: 'exec', sql }); },
    run: async (sql, params) => { events.push({ kind: 'run', sql, params }); },
    tableExists: async () => true,
    events
  };
}

describe('migration: колонка sleep_detect', () => {
  test('добавляет колонку и проставляет auto, если её нет', async () => {
    const driver = columnDriver(['profile_key']);
    await sleepDetectMigration().up(driver);

    expect(driver.events.some(e => e.kind === 'exec' && /ADD COLUMN sleep_detect/.test(e.sql))).toBe(true);
    expect(driver.events.some(e => e.kind === 'run' && /UPDATE power_profiles SET sleep_detect = 'auto'/.test(e.sql))).toBe(true);
  });

  test('не добавляет колонку повторно', async () => {
    const driver = columnDriver(['profile_key', 'sleep_detect']);
    await sleepDetectMigration().up(driver);
    expect(driver.events.some(e => e.kind === 'exec' && /ADD COLUMN/.test(e.sql))).toBe(false);
  });
});

const DETECT_COMMAND_ID = '2026-10-18-power-profiles-detect-command';

function detectCommandMigration() {
  const migration = MIGRATIONS.find(item => item.id === DETECT_COMMAND_ID);
  expect(migration).toBeTruthy();
  return migration;
}

describe('migration: своя команда проверки состояния', () => {
  test('добавляет обе колонки, если их нет', async () => {
    const driver = columnDriver(['profile_key', 'sleep_detect']);
    await detectCommandMigration().up(driver);

    expect(driver.events.some(e => e.kind === 'exec' && /ADD COLUMN detect_command/.test(e.sql))).toBe(true);
    expect(driver.events.some(e => e.kind === 'exec' && /ADD COLUMN detect_sleep_match/.test(e.sql))).toBe(true);
  });

  test('не добавляет колонки повторно', async () => {
    const driver = columnDriver(['profile_key', 'sleep_detect', 'detect_command', 'detect_sleep_match']);
    await detectCommandMigration().up(driver);
    expect(driver.events.some(e => e.kind === 'exec' && /ADD COLUMN/.test(e.sql))).toBe(false);
  });

  test('переводит профиль Smart AIO TV на OffScreenActivity и чтение screen_off', async () => {
    const driver = columnDriver(['profile_key']);
    await detectCommandMigration().up(driver);

    const update = driver.events.find(e => e.kind === 'run' && /UPDATE power_profiles SET/.test(e.sql));
    expect(update).toBeTruthy();
    expect(update.sql).toMatch(/WHERE profile_key = 'model-smart-aio-tv'/);
    expect(update.sql).toMatch(/sleep_detect = 'custom'/);
    expect(update.sql).toMatch(/detect_command = 'getprop sys.power.screen_off'/);
    expect(update.sql).toMatch(/detect_sleep_match = 'true'/);
    const lists = update.params.map(p => { try { return JSON.parse(p); } catch { return null; } }).filter(Array.isArray);
    expect(lists[0]).toEqual(['am:start -n com.cultraview.litemeet.launcher/com.cultraview.litemeet.launcher.main.OffScreenActivity']);
    expect(lists[1]).toEqual(['setprop:persist.sys.standbymode.enable 1', 26]);
  });
});

const ICONBIT_WAKELOCK_ID = '2026-10-19-power-profiles-iconbit-trs2045-wakelock';

function iconbitWakelockMigration() {
  const migration = MIGRATIONS.find(item => item.id === ICONBIT_WAKELOCK_ID);
  expect(migration).toBeTruthy();
  return migration;
}

describe('migration: iconBIT TRS2045 держит сеть через wakelock', () => {
  test('ставит sleep/wake 223/224, keep-awake с wakelock и detect=display', async () => {
    const driver = columnDriver(['profile_key']);
    await iconbitWakelockMigration().up(driver);

    const update = driver.events.find(e => e.kind === 'run' && /UPDATE power_profiles SET/.test(e.sql));
    expect(update).toBeTruthy();
    expect(update.sql).toMatch(/WHERE profile_key = 'model-iconbit-trs2045'/);
    expect(update.sql).toMatch(/sleep_detect = 'display'/);

    const lists = update.params.map(p => { try { return JSON.parse(p); } catch { return null; } }).filter(Array.isArray);
    expect(lists[0]).toEqual([223]);
    expect(lists[1]).toEqual([224]);
    expect(lists[2][0]).toContain('/sys/power/wake_lock');
    expect(lists[2][0]).toContain('su 0 sh -c');
  });
});

describe('миграция wakelock перед сном (iconBIT TRS2045)', () => {
  test('ставит wakelock первой ступенью сна, перед 223', async () => {
    const migration = MIGRATIONS.find(m => m.id === '2026-10-20-power-profiles-iconbit-trs2045-wakelock-sleep');
    expect(migration).toBeTruthy();

    const driver = columnDriver(['profile_key']);
    await migration.up(driver);

    const update = driver.events.find(e => e.kind === 'run' && /UPDATE power_profiles SET/.test(e.sql));
    expect(update.sql).toMatch(/WHERE profile_key = 'model-iconbit-trs2045'/);
    expect(JSON.parse(update.params[0])).toEqual([
      "shell:su 0 sh -c 'echo mmrc_keepalive > /sys/power/wake_lock'",
      223
    ]);
  });
});

describe('миграция LAN-детекции для панелей Lumien LS', () => {
  test('переводит оба LS-профиля на custom-запрос :01GE000', async () => {
    const migration = MIGRATIONS.find(m => m.id === '2026-10-21-power-profiles-ls-lan-detect');
    expect(migration).toBeTruthy();

    const driver = columnDriver(['profile_key']);
    await migration.up(driver);

    const updates = driver.events.filter(e => e.kind === 'run' && /UPDATE power_profiles SET/.test(e.sql));
    expect(updates.map(u => u.params[1])).toEqual([
      'model-ls5550sd-bo1082d-g',
      'model-ls5550sduhd-cs1382d-g'
    ]);
    for (const update of updates) {
      expect(update.sql).toMatch(/sleep_detect = 'custom'/);
      expect(update.sql).toMatch(/detect_command = 'lan::01GE000'/);
      expect(update.sql).toMatch(/detect_sleep_match = 'rE000'/);
    }
  });
});
