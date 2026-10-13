/**
 * Работа с профилями питания в БД (таблица power_profiles).
 *
 * Отдельный модуль, чтобы utils/power-profiles оставалась чистой логикой без
 * базы, а здесь жила только привязка к драйверу БД.
 *
 * @module database/power-profiles-db
 */

import { getDatabase } from './database.js';
import { withRetrySync, isRetryableDatabaseError } from '../utils/retry.js';
import { normalizePowerSteps, normalizeAndroidVersion } from '../utils/power-profiles.js';
import { normalizeSleepDetect } from '../utils/power-state.js';

function parseSteps(raw) {
  let value = [];
  try {
    value = JSON.parse(raw || '[]');
  } catch {
    value = [];
  }
  const normalized = normalizePowerSteps(value);
  return normalized.ok ? normalized.steps : [];
}

function mapRow(row) {
  return {
    key: row.profile_key,
    label: row.label,
    deviceId: row.device_id || null,
    model: row.model || null,
    androidFrom: normalizeAndroidVersion(row.android_from) || null,
    androidTo: normalizeAndroidVersion(row.android_to) || null,
    sleepSteps: parseSteps(row.sleep_steps),
    wakeSteps: parseSteps(row.wake_steps),
    keepAwakeSteps: parseSteps(row.keep_awake_steps),
    sleepDetect: normalizeSleepDetect(row.sleep_detect),
    detectCommand: row.detect_command || null,
    detectSleepMatch: row.detect_sleep_match || null,
    priority: Number(row.priority) || 0,
    source: row.source || 'db',
    notes: row.notes || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

/** Все пользовательские профили из БД, приоритетные сверху. */
export async function loadPowerProfilesFromDb() {
  const rows = await getDatabase().query(
    'SELECT * FROM power_profiles ORDER BY priority DESC, id ASC'
  );
  return rows.map(mapRow);
}

/** Создать или обновить профиль по ключу. */
export async function savePowerProfileToDb(profile) {
  const params = [
    profile.key,
    profile.label,
    profile.deviceId || null,
    profile.model || null,
    profile.androidFrom || null,
    profile.androidTo || null,
    JSON.stringify(profile.sleepSteps || []),
    JSON.stringify(profile.wakeSteps || []),
    JSON.stringify(profile.keepAwakeSteps || []),
    normalizeSleepDetect(profile.sleepDetect),
    profile.detectCommand || null,
    profile.detectSleepMatch || null,
    Math.max(0, Math.min(100, Number(profile.priority) || 0)),
    profile.source || 'admin-ui',
    profile.notes || null
  ];
  await withRetrySync(async () => {
    await getDatabase().run(
      `INSERT INTO power_profiles
         (profile_key, label, device_id, model, android_from, android_to, sleep_steps, wake_steps, keep_awake_steps, sleep_detect, detect_command, detect_sleep_match, priority, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_key) DO UPDATE SET
         label = excluded.label,
         device_id = excluded.device_id,
         model = excluded.model,
         android_from = excluded.android_from,
         android_to = excluded.android_to,
         sleep_steps = excluded.sleep_steps,
         wake_steps = excluded.wake_steps,
         keep_awake_steps = excluded.keep_awake_steps,
         sleep_detect = excluded.sleep_detect,
         detect_command = excluded.detect_command,
         detect_sleep_match = excluded.detect_sleep_match,
         priority = excluded.priority,
         source = excluded.source,
         notes = excluded.notes,
         updated_at = CURRENT_TIMESTAMP`,
      params
    );
  }, { maxRetries: 3, delay: 200, shouldRetry: isRetryableDatabaseError });
}

/** Удалить профиль по ключу. */
export async function deletePowerProfileFromDb(key) {
  await withRetrySync(async () => {
    await getDatabase().run('DELETE FROM power_profiles WHERE profile_key = ?', [String(key)]);
  }, { maxRetries: 3, delay: 200, shouldRetry: isRetryableDatabaseError });
}