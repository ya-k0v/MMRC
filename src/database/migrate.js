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

export const MIGRATIONS = [
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
  },
  {
    id: '2026-06-22-csrf-tokens',
    description: 'Create csrf_tokens table for CSRF protection',
    async up(driver) {
      if (!(await driver.tableExists('csrf_tokens'))) {
        if (driver.dialect === 'postgres') {
          await driver.exec(`
            CREATE TABLE csrf_tokens (
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              token TEXT UNIQUE NOT NULL,
              expires_at TIMESTAMP NOT NULL,
              used INTEGER DEFAULT 0,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);
        } else {
          await driver.exec(`
            CREATE TABLE IF NOT EXISTS csrf_tokens (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              token TEXT UNIQUE NOT NULL,
              expires_at DATETIME NOT NULL,
              used INTEGER DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `);
        }
        await driver.exec('CREATE INDEX IF NOT EXISTS idx_csrf_tokens_token ON csrf_tokens(token)');
        await driver.exec('CREATE INDEX IF NOT EXISTS idx_csrf_tokens_user_id ON csrf_tokens(user_id)');
      }
    }
  },
  {
    id: '2026-06-29-heroes-dates-text',
    description: 'Change heroes.birth_year/death_year from INTEGER to TEXT for full date support',
    async up(driver) {
      if (!(await driver.tableExists('heroes'))) return;

      const cols = await driver.columns('heroes');
      const birthCol = cols.find(c => c.name === 'birth_year');
      const deathCol = cols.find(c => c.name === 'death_year');

      const isInteger = (type) => type && type.toUpperCase() === 'INTEGER';

      if (!isInteger(birthCol?.type) && !isInteger(deathCol?.type)) return;

      if (driver.dialect === 'postgres') {
        if (isInteger(birthCol?.type)) {
          await driver.exec('ALTER TABLE heroes ALTER COLUMN birth_year TYPE TEXT');
        }
        if (isInteger(deathCol?.type)) {
          await driver.exec('ALTER TABLE heroes ALTER COLUMN death_year TYPE TEXT');
        }
      } else {
        await driver.exec('ALTER TABLE heroes RENAME TO heroes_old');
        await driver.exec(`
          CREATE TABLE heroes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            birth_year TEXT,
            death_year TEXT,
            rank TEXT,
            photo_base64 TEXT,
            photo_key TEXT,
            biography TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await driver.exec('INSERT INTO heroes SELECT id, full_name, birth_year, death_year, rank, photo_base64, NULL, biography, created_at, updated_at FROM heroes_old');
        await driver.exec('DROP TABLE heroes_old');
      }
    }
  },
  {
    id: '2026-06-29-heroes-storage-keys',
    description: 'Add photo_key/media_key columns for S3 storage',
    async up(driver) {
      if (!(await driver.tableExists('heroes'))) return;

      const heroesCols = await driver.columns('heroes');
      const hasPhotoKey = heroesCols.some(c => c.name === 'photo_key');
      if (!hasPhotoKey) {
        await driver.exec('ALTER TABLE heroes ADD COLUMN photo_key TEXT');
      }

      if (await driver.tableExists('hero_media')) {
        const mediaCols = await driver.columns('hero_media');
        const hasMediaKey = mediaCols.some(c => c.name === 'media_key');
        if (!hasMediaKey) {
          await driver.exec('ALTER TABLE hero_media ADD COLUMN media_key TEXT');
        }
        // Allow media_base64 to be NULL (was NOT NULL)
        if (driver.dialect === 'postgres') {
          await driver.exec('ALTER TABLE hero_media ALTER COLUMN media_base64 DROP NOT NULL');
        }
      }
    }
  },
  {
    id: '2026-07-01-heroes-photo-position',
    description: 'Add photo_offset_x/photo_offset_y/photo_scale for avatar positioning',
    async up(driver) {
      if (!(await driver.tableExists('heroes'))) return;

      const heroesCols = await driver.columns('heroes');
      const addCol = async (name, def) => {
        if (!heroesCols.some(c => c.name === name)) {
          await driver.exec(`ALTER TABLE heroes ADD COLUMN ${name} ${def}`);
        }
      };
      await addCol('photo_offset_x', 'REAL DEFAULT 0');
      await addCol('photo_offset_y', 'REAL DEFAULT 0');
      await addCol('photo_scale', 'REAL DEFAULT 1');
    }
  },
  {
    id: '2026-07-13-users-token-valid-from',
    description: 'Add token_valid_from column for instant session revocation',
    async up(driver) {
      if (!(await driver.tableExists('users'))) return;
      const cols = await driver.columns('users');
      if (!cols.some(c => c.name === 'token_valid_from')) {
        await driver.exec(`ALTER TABLE users ADD COLUMN token_valid_from ${driver.dialect === 'postgres' ? 'TIMESTAMP' : 'DATETIME'}`);
      }
    }
  },
  {
    id: '2026-07-13-devices-adb-port',
    description: 'Add adb_port column to devices for remote ADB operations',
    async up(driver) {
      if (!(await driver.tableExists('devices'))) return;
      const cols = await driver.columns('devices');
      if (!cols.some(c => c.name === 'adb_port')) {
        await driver.exec(`ALTER TABLE devices ADD COLUMN adb_port TEXT DEFAULT '5555'`);
      }
    }
  },
  {
    id: '2026-09-17-refresh-tokens-hashed',
    description: 'Remove legacy plaintext refresh tokens (tokens are now stored as sha256 hashes)',
    async up(driver) {
      if (!(await driver.tableExists('refresh_tokens'))) return;
      // Legacy tokens are plaintext JWTs (not 64-char hex hashes); keep only hash rows
      await driver.exec("DELETE FROM refresh_tokens WHERE length(token) != 64");
    }
  },
  {
    id: '2026-10-07-devices-mac-address',
    description: 'Add mac_address column to devices for Wake-on-LAN power control',
    async up(driver) {
      if (!(await driver.tableExists('devices'))) return;
      const cols = await driver.columns('devices');
      if (!cols.some(c => c.name === 'mac_address')) {
        await driver.exec('ALTER TABLE devices ADD COLUMN mac_address TEXT');
      }
    }
  },
  {
    id: '2026-10-12-devices-model',
    description: 'Add model column to devices for per-model power control',
    async up(driver) {
      if (!(await driver.tableExists('devices'))) return;
      const cols = await driver.columns('devices');
      if (!cols.some(c => c.name === 'model')) {
        await driver.exec('ALTER TABLE devices ADD COLUMN model TEXT');
      }
    }
  },
  {
    id: '2026-10-12-power-profiles',
    description: 'Create power_profiles table for admin-configured sleep/wake command sets',
    async up(driver) {
      if (await driver.tableExists('power_profiles')) return;
      const isPg = driver.dialect === 'postgres';
      await driver.exec(`
        CREATE TABLE power_profiles (
          id ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY${isPg ? '' : ' AUTOINCREMENT'},
          profile_key TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL,
          device_id TEXT,
          model TEXT,
          android_from TEXT,
          android_to TEXT,
          sleep_steps TEXT NOT NULL DEFAULT '[]',
          wake_steps TEXT NOT NULL DEFAULT '[]',
          priority INTEGER NOT NULL DEFAULT 0,
          source TEXT,
          notes TEXT,
          created_at ${isPg ? 'TIMESTAMP' : 'DATETIME'} DEFAULT CURRENT_TIMESTAMP,
          updated_at ${isPg ? 'TIMESTAMP' : 'DATETIME'} DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await driver.exec('CREATE INDEX IF NOT EXISTS idx_power_profiles_device ON power_profiles(device_id)');
      await driver.exec('CREATE INDEX IF NOT EXISTS idx_power_profiles_model ON power_profiles(model)');
      await driver.exec('CREATE INDEX IF NOT EXISTS idx_power_profiles_android_from ON power_profiles(android_from)');
    }
  },
  {
    id: '2026-10-13-power-profiles-seed',
    description: 'Seed starter power profiles as ordinary editable rows (once)',
    async up(driver) {
      if (!(await driver.tableExists('power_profiles'))) return;
      const seeds = [
        {
          key: 'default',
          label: 'приставки и прочие устройства',
          model: null,
          androidFrom: null,
          androidTo: null,
          wake: [224, 26, 170],
          sleep: [223],
          priority: 0
        },
        {
          key: 'iconbit',
          label: 'iconBIT приставки (не спим, гасим дисплей)',
          model: 'iconbit',
          androidFrom: null,
          androidTo: null,
          wake: ['cmd:power set-screen-state on', 224],
          sleep: ['svc:power stayon false', 'settings:system put screen_off_timeout 1000', 'cmd:power set-screen-state off'],
          priority: 0
        },
        {
          key: 'android-13',
          label: 'Android 13 (Lumien Basic G2 и аналоги)',
          model: null,
          androidFrom: '13',
          androidTo: '13',
          wake: [224, 'cmd:power set-screen-state on'],
          sleep: ['svc:power stayon false', 223, 'cmd:power set-screen-state off'],
          priority: 0
        },
        {
          key: 'lumien-lb3235sdg2',
          label: 'Lumien LB3235SDG2',
          model: 'lb3235sdg2',
          androidFrom: null,
          androidTo: null,
          wake: [224, 'cmd:power set-screen-state on'],
          sleep: ['svc:power stayon false', 223, 'cmd:power set-screen-state off'],
          priority: 0
        }
      ];
      const existingRows = await driver.query('SELECT profile_key FROM power_profiles');
      const existing = new Set(existingRows.map((row) => row.profile_key));
      for (const seed of seeds) {
        if (existing.has(seed.key)) continue;
        await driver.run(
          `INSERT INTO power_profiles (profile_key, label, device_id, model, android_from, android_to, sleep_steps, wake_steps, priority, source, notes)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'seed', NULL)`,
          [seed.key, seed.label, seed.model, seed.androidFrom, seed.androidTo, JSON.stringify(seed.sleep), JSON.stringify(seed.wake), seed.priority]
        );
      }
    }
  },

  {
    id: '2026-10-14-power-profiles-device-models',
    description: 'Seed explicit power profiles for production device models (Lumien LS5550SD, Smart AIO TV, iconBIT TRS2045)',
    async up(driver) {
      if (!(await driver.tableExists('power_profiles'))) return;
      // Ступени взяты из набора семейства (см. ADB-POWER.md и power-control):
      //   • Lumien (Android 11/13): не спится KEYCODE_POWER — сон «не держать экран» + SLEEP,
      //     потом принудительный set-screen-state off; пробуждение WAKEUP + set-screen-state on.
      //   • iconBIT TRS2045 (Android 10): во сне умирает сеть — не усыпляем, а гасим дисплей
      //     по таймауту; пробуждение подъёмом дисплея.
      // Привязка только по модели (android_from/to = NULL): уникальной строки модели достаточно,
      // а версия Android не персистится и на «холодном» старте может отсутствовать.
      const seeds = [
        {
          key: 'model-ls5550sduhd-cs1382d-g',
          label: 'LS5550SDUHD-CS1382D-G (Lumien, Android 11)',
          model: 'ls5550sduhd-cs1382d-g',
          sleep: ['svc:power stayon false', 223, 'cmd:power set-screen-state off'],
          wake: [224, 'cmd:power set-screen-state on'],
          priority: 1
        },
        {
          key: 'model-ls5550sd-bo1082d-g',
          label: 'LS5550SD-BO1082D-G (Lumien, Android 11)',
          model: 'ls5550sd-bo1082d-g',
          sleep: ['svc:power stayon false', 223, 'cmd:power set-screen-state off'],
          wake: [224, 'cmd:power set-screen-state on'],
          priority: 1
        },
        {
          key: 'model-smart-aio-tv',
          label: 'Smart AIO TV (Lumien, Android 13)',
          model: 'smart aio tv',
          sleep: ['svc:power stayon false', 223, 'cmd:power set-screen-state off'],
          wake: [224, 'cmd:power set-screen-state on'],
          priority: 1
        },
        {
          key: 'model-iconbit-trs2045',
          label: 'iconBIT TRS2045 (Android 10)',
          model: 'iconbit trs2045',
          sleep: ['svc:power stayon false', 'settings:system put screen_off_timeout 1000', 'cmd:power set-screen-state off'],
          wake: ['cmd:power set-screen-state on', 224],
          priority: 1
        }
      ];
      const existingRows = await driver.query('SELECT profile_key FROM power_profiles');
      const existing = new Set(existingRows.map((row) => row.profile_key));
      for (const seed of seeds) {
        if (existing.has(seed.key)) continue;
        await driver.run(
          `INSERT INTO power_profiles (profile_key, label, device_id, model, android_from, android_to, sleep_steps, wake_steps, priority, source, notes)
           VALUES (?, ?, NULL, ?, NULL, NULL, ?, ?, ?, 'seed', NULL)`,
          [seed.key, seed.label, seed.model, JSON.stringify(seed.sleep), JSON.stringify(seed.wake), seed.priority]
        );
      }
    }
  },

  {
    id: '2026-10-15-power-profiles-keep-awake',
    description: 'Add keep_awake_steps to power_profiles and seed screen-keepalive for panel profiles',
    async up(driver) {
      if (!(await driver.tableExists('power_profiles'))) return;
      const cols = await driver.columns('power_profiles');
      if (!cols.some(c => c.name === 'keep_awake_steps')) {
        await driver.exec("ALTER TABLE power_profiles ADD COLUMN keep_awake_steps TEXT NOT NULL DEFAULT '[]'");
      }

      // Скринсейвер (Ambient Mode) и таймаут экрана гасят подсветку отдельно от
      // сна и не переживают перезагрузку — поэтому удерживаем экран после
      // каждого пробуждения. Панели и приставки-«панели» (iconBIT) обновляем,
      // дефолтную лестницу приставок не трогаем.
      const keepAwake = JSON.stringify([
        'svc:power stayon true',
        'settings:secure put screensaver_enabled 0',
        'settings:secure put screensaver_activate_on_sleep 0',
        'settings:secure put screensaver_activate_on_dock 0'
      ]);
      const keys = [
        'iconbit',
        'android-13',
        'lumien-lb3235sdg2',
        'model-ls5550sduhd-cs1382d-g',
        'model-ls5550sd-bo1082d-g',
        'model-smart-aio-tv',
        'model-iconbit-trs2045'
      ];
      for (const key of keys) {
        await driver.run(
          "UPDATE power_profiles SET keep_awake_steps = ?, updated_at = CURRENT_TIMESTAMP WHERE profile_key = ? AND (keep_awake_steps IS NULL OR keep_awake_steps = '[]')",
          [keepAwake, key]
        );
      }
    }
  },

  {
    id: '2026-10-16-power-profiles-default',
    description: 'Ensure the catch-all default power profile exists (always present)',
    async up(driver) {
      if (!(await driver.tableExists('power_profiles'))) return;
      // Профиль по умолчанию — обязательная catch-all строка (без модели и версии):
      // применяется к устройствам, для которых не задано своё правило. Создаём
      // один раз, дальше админ его правит и сохраняет, но удалить нельзя.
      const existing = await driver.query('SELECT profile_key FROM power_profiles');
      if (existing.some((row) => row.profile_key === 'default')) return;
      await driver.run(
        `INSERT INTO power_profiles (profile_key, label, device_id, model, android_from, android_to, sleep_steps, wake_steps, priority, source, notes)
         VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, 0, 'seed', NULL)`,
        ['default', 'приставки и прочие устройства', JSON.stringify([223]), JSON.stringify([224, 26, 170])]
      );
    }
  },

  {
    id: '2026-10-17-power-profiles-sleep-detect',
    description: 'Add sleep_detect column: unified strategy for reading awake/asleep state',
    async up(driver) {
      if (!(await driver.tableExists('power_profiles'))) return;
      // Стратегия определения «спит» для каждого профиля:
      //   auto — экран (если маркер есть), иначе mWakefulness;
      //   display — только состояние дисплея (гашение дисплея = сон);
      //   wakefulness — только mWakefulness.
      if (!(await hasColumn(driver, 'power_profiles', 'sleep_detect'))) {
        await driver.exec("ALTER TABLE power_profiles ADD COLUMN sleep_detect TEXT DEFAULT 'auto'");
      }
      await driver.run("UPDATE power_profiles SET sleep_detect = 'auto' WHERE sleep_detect IS NULL OR sleep_detect = ''");
    }
  },

  {
    id: '2026-10-18-power-profiles-detect-command',
    description: 'Add custom state-detection columns; fix Smart AIO TV profile (Lumien, Android 13)',
    async up(driver) {
      if (!(await driver.tableExists('power_profiles'))) return;
      if (!(await hasColumn(driver, 'power_profiles', 'detect_command'))) {
        await driver.exec('ALTER TABLE power_profiles ADD COLUMN detect_command TEXT');
      }
      if (!(await hasColumn(driver, 'power_profiles', 'detect_sleep_match'))) {
        await driver.exec('ALTER TABLE power_profiles ADD COLUMN detect_sleep_match TEXT');
      }
      // Smart AIO TV (Lumien, Android 13): штатный сон (keyevent 223/26) выключает
      // панель вместе с сетью и ADB. Безопасный сон — скрытый OffScreenActivity
      // лаунчера (идемпотентен, сеть жива), пробуждение — keyevent 26 (toggle,
      // работает при persist.sys.standbymode.enable=1 — шаг выставляем в начале
      // пробуждения, свойство persist переживает перезагрузку). Штатный
      // `dumpsys power` сон НЕ отражает (mWakefulness=Awake), поэтому состояние
      // читаем из свойства sys.power.screen_off: `true` — экран погашен.
      await driver.run(
        `UPDATE power_profiles SET
           sleep_steps = ?,
           wake_steps = ?,
           sleep_detect = 'custom',
           detect_command = 'getprop sys.power.screen_off',
           detect_sleep_match = 'true',
           notes = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE profile_key = 'model-smart-aio-tv'`,
        [
          JSON.stringify(['am:start -n com.cultraview.litemeet.launcher/com.cultraview.litemeet.launcher.main.OffScreenActivity']),
          JSON.stringify(['setprop:persist.sys.standbymode.enable 1', 26]),
          'Сон — скрытый OffScreenActivity лаунчера (сеть/ADB живы). Пробуждение — keyevent 26 (toggle), требует persist.sys.standbymode.enable=1. Статус — getprop sys.power.screen_off (true = экран погашен). Клавишу 26 слать с паузой ≥2 c.'
        ]
      );
    }
  },

  {
    id: '2026-10-19-power-profiles-iconbit-trs2045-wakelock',
    description: 'iconBIT TRS2045 (Android 10): keep Ethernet alive with userspace wakelock; detect by Display Power',
    async up(driver) {
      if (!(await driver.tableExists('power_profiles'))) return;
      // На TRS2045 (Android 10) после гашения экрана SoC уходит в suspend и
      // обесточивает Ethernet — ADB/звонок пропадают. Держим userspace-wakelock:
      // система засыпает (экран гаснет, mWakefulness=Asleep), но не
      // приостанавливается, поэтому сеть и uptime живут. Разово после загрузки
      // (root через `su 0`), затем удерживается сам — повтор идемпотентен.
      // Сон — keyevent 223 (KEYCODE_SLEEP), пробуждение — 224 (KEYCODE_WAKEUP).
      // Статус — `Display Power: state=` (OFF = спит), маркер есть, поэтому display.
      await driver.run(
        `UPDATE power_profiles SET
           sleep_steps = ?,
           wake_steps = ?,
           keep_awake_steps = ?,
           sleep_detect = 'display',
           notes = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE profile_key = 'model-iconbit-trs2045'`,
        [
          JSON.stringify([223]),
          JSON.stringify([224]),
          JSON.stringify([
            "shell:su 0 sh -c 'echo mmrc_keepalive > /sys/power/wake_lock'",
            'settings:secure put screensaver_enabled 0'
          ]),
          'Сеть держит userspace-wakelock (иначе Ethernet пропадает в suspend): shell:su 0 sh -c ... Сон 223, пробуждение 224. Статус — Display Power: state (OFF = спит).'
        ]
      );
    }
  },

  {
    id: '2026-10-20-power-profiles-iconbit-trs2045-wakelock-sleep',
    description: 'iconBIT TRS2045: hold wakelock before sleep too (first sleep after boot has no prior wake)',
    async up(driver) {
      if (!(await driver.tableExists('power_profiles'))) return;
      // Wakelock в «удержании» ставится только после успешного пробуждения. Первый
      // сон после загрузки (пробуждения через MMRC ещё не было) прошёл бы без него
      // и обесточил Ethernet. Держим его и перед сном — первой ступенью, до 223.
      await driver.run(
        `UPDATE power_profiles SET
           sleep_steps = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE profile_key = 'model-iconbit-trs2045'`,
        [JSON.stringify(["shell:su 0 sh -c 'echo mmrc_keepalive > /sys/power/wake_lock'", 223])]
      );
    }
  },

  {
    id: '2026-10-21-power-profiles-ls-lan-detect',
    description: 'Lumien LS5550SD: detect sleep by LAN register E (Fake Standby keeps Android awake)',
    async up(driver) {
      if (!(await driver.tableExists('power_profiles'))) return;
      // Панели Lumien Standard уходят в «Fake Standby»: Android не спит, но
      // подсветка гаснет, поэтому dumpsys power всегда показывает «активен» и
      // статус мигал. Спрашиваем саму панель по LAN: GET `:01GE000` отвечает
      // `:01rE000` при погашенном экране и `:01rE001` — при включённом.
      const notes = 'Статус — запрос по LAN :01GE000 (:01rE000 = экран погашен, :01rE001 = включён). Панель в Fake Standby, dumpsys состояния не отражает.';
      for (const key of ['model-ls5550sd-bo1082d-g', 'model-ls5550sduhd-cs1382d-g']) {
        await driver.run(
          `UPDATE power_profiles SET
             sleep_detect = 'custom',
             detect_command = 'lan::01GE000',
             detect_sleep_match = 'rE000',
             notes = ?,
             updated_at = CURRENT_TIMESTAMP
           WHERE profile_key = ?`,
          [notes, key]
        );
      }
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
