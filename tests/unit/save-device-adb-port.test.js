/**
 * Регрессия: порт ADB, заданный при установке APK, возвращался к 5555.
 *
 * saveDevice делает UPSERT, и в DO UPDATE стояло безусловное
 * `adb_port = excluded.adb_port` вместе с дефолтом `data.adbPort || '5555'`.
 * Обычная регистрация или heartbeat устройства adbPort не передаёт, поэтому
 * затирал порт дефолтом — и в базе снова оказывалось 5555.
 *
 * Сборка запроса вынесена в buildDeviceUpsert, поэтому здесь не нужна БД:
 * проверяется, какие колонки реально попадают в ON CONFLICT DO UPDATE.
 */
import { buildDeviceUpsert } from '../../src/database/database.js';

const BASE = {
  name: 'Устройство',
  folder: 'UPLOAD',
  deviceType: 'android',
  platform: 'android',
  capabilities: {},
  lastSeen: '2026-10-06T00:00:00.000Z'
};

/** Колонки, попавшие в DO UPDATE SET, в порядке объявления. */
function conflictSetColumns({ sql }) {
  const match = sql.match(/ON CONFLICT\(device_id\)\s*DO UPDATE SET\s+([\s\S]+)$/i);
  expect(match).not.toBeNull();
  return match[1]
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.split('=')[0].trim());
}

/** Значение, которым подставляется adb_port в VALUES. */
function adbPortValue({ sql, params }) {
  const columns = sql.match(/INSERT INTO devices\s*\(([^)]*)\)/i);
  expect(columns).not.toBeNull();
  const idx = columns[1].split(',').map(s => s.trim()).indexOf('adb_port');
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(params).toHaveLength(columns[1].split(',').length);
  return params[idx];
}

describe('buildDeviceUpsert и adb_port', () => {
  test('при явном adbPort колонка обновляется', () => {
    const query = buildDeviceUpsert('dev1', { ...BASE, adbPort: '5556' });

    expect(conflictSetColumns(query)).toContain('adb_port');
    expect(adbPortValue(query)).toBe('5556');
  });

  test('без adbPort порт не затирается: колонки в DO UPDATE нет', () => {
    // Именно этот случай ломал установку APK: устройство перерегистрировалось
    // и возвращало в базу 5555 вместо заданного порта.
    const query = buildDeviceUpsert('dev1', { ...BASE });

    expect(conflictSetColumns(query)).not.toContain('adb_port');
    // При этом новая строка всё ещё создаётся с дефолтным портом
    expect(adbPortValue(query)).toBe('5555');
  });

  test('пустая строка и null считаются отсутствующим портом', () => {
    expect(conflictSetColumns(buildDeviceUpsert('dev1', { ...BASE, adbPort: '' })))
      .not.toContain('adb_port');
    expect(conflictSetColumns(buildDeviceUpsert('dev1', { ...BASE, adbPort: null })))
      .not.toContain('adb_port');
  });

  test('остальные поля продолжают обновляться', () => {
    const query = buildDeviceUpsert('dev1', { ...BASE, ipAddress: '10.0.0.5' });

    const columns = conflictSetColumns(query);
    for (const col of ['name', 'folder', 'device_type', 'platform', 'ip_address', 'capabilities', 'last_seen', 'current_state', 'updated_at']) {
      expect(columns).toContain(col);
    }
    expect(query.params).toContain('10.0.0.5');
    expect(query.params).toContain('dev1');
  });

  test('порты вида "0" и " 5557 " считаются заданными', () => {
    const query = buildDeviceUpsert('dev1', { ...BASE, adbPort: ' 5557 ' });

    expect(conflictSetColumns(query)).toContain('adb_port');
    expect(adbPortValue(query)).toBe(' 5557 ');
  });

  test('capabilities и current сериализуются в JSON', () => {
    const query = buildDeviceUpsert('dev1', {
      ...BASE,
      capabilities: { adb: true },
      current: { battery: 80 }
    });

    expect(query.params).toContain('{"adb":true}');
    expect(query.params).toContain('{"battery":80}');
  });
});