/**
 * Профили питания Android-устройств: набор команд сна/пробуждения.
 *
 * Профилем управляет админ из админки («Конструктор профилей питания»):
 * наборы команд хранятся в БД (таблица power_profiles) и применяются к
 * устройству по привязке. Приоритет привязки:
 *   device_id → модель + версия Android → модель → версия Android → любой.
 *
 * Хранилище БД подключается извне (server.js) через configurePowerProfileStore,
 * чтобы модуль оставался чистым и тестируемым без базы. Все профили (в т.ч.
 * засеянные при первом запуске) — обычные строки БД: их можно удалять и
 * редактировать. Резервный набор применяется, только если в БД нет ни одного
 * подходящего профиля, и в админке не показывается.
 *
 * @module utils/power-profiles
 */

import { createModuleLogger } from './logger.js';
import { KEYCODE_SLEEP, KEYCODE_WAKEUP } from './adb.js';
import { parseLanStep } from './lumien-lan.js';
import { ANDROID_PACKAGE_NAME } from '../config/android.js';

const powerLog = createModuleLogger('power-profiles');

function envList(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const values = raw.split(',').map(value => value.trim()).filter(Boolean);
  return values.length > 0 ? values : fallback;
}

/** Лестница клавиш пробуждения по умолчанию (`POWER_WAKE_KEYCODES="224,26,170"`; 170 = KEYCODE_TV). */
const WAKE_KEYCODES = envList('POWER_WAKE_KEYCODES', ['224', '26', '170']).map(Number).filter(Number.isFinite);

/**
 * Резервный набор на случай, когда в БД нет ни одного подходящего профиля.
 * В админке не отображается и не хранится — это последний рубеж, чтобы
 * сон/пробуждение работали на чистой базе.
 */
const FALLBACK_POWER_PROFILE = {
  key: 'default',
  label: 'приставки и прочие устройства',
  wake: WAKE_KEYCODES.length ? WAKE_KEYCODES : [KEYCODE_WAKEUP],
  sleep: [KEYCODE_SLEEP],
  keepAwake: []
};

// ========================================
// Валидация шагов и профилей
// ========================================

const STEP_BINARY_PREFIX = /^(svc|cmd|settings|am|input|dumpsys|wm|lan):/;

/** Шаг как число (KEYCODE) либо строка `svc:/cmd:/settings:/am:/input:/dumpsys:/wm:/lan:`. */
export function normalizePowerStep(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed.length <= 255 && STEP_BINARY_PREFIX.test(trimmed)) {
      if (trimmed.startsWith('lan:') && !parseLanStep(trimmed)) return null;
      return trimmed;
    }
  }
  return null;
}

export function normalizePowerSteps(value) {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'Список шагов должен быть массивом' };
  }
  const steps = [];
  for (const item of value) {
    const step = normalizePowerStep(item);
    if (step === null) {
      return { ok: false, error: `Некорректный шаг: ${String(item)}` };
    }
    steps.push(step);
  }
  return { ok: true, steps };
}

export function normalizeAndroidVersion(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return n >= 1 && n <= 99 ? String(n) : false;
}

const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Проверить профиль из запроса админки и привести к единому виду.
 *
 * @param {Object} input
 * @returns {{ok: true, profile: Object} | {ok: false, error: string}}
 */
export function validatePowerProfile(input = {}) {
  const key = String(input.key || '').trim();
  if (!KEY_PATTERN.test(key)) {
    return { ok: false, error: 'Ключ профиля: только буквы, цифры, _ . - (1..64 символа)' };
  }
  const label = String(input.label || '').trim();
  if (!label || label.length > 120) {
    return { ok: false, error: 'Укажите название профиля (до 120 символов)' };
  }
  const deviceId = input.deviceId ? String(input.deviceId).trim().slice(0, 128) : null;
  if (deviceId === '__proto__' || deviceId === 'constructor' || deviceId === 'prototype') {
    return { ok: false, error: 'Некорректный device_id' };
  }
  const model = input.model ? String(input.model).trim().slice(0, 128) : null;
  const androidFrom = normalizeAndroidVersion(input.androidFrom);
  if (androidFrom === false) return { ok: false, error: 'Версия Android «с» — число, например 13' };
  const androidTo = normalizeAndroidVersion(input.androidTo);
  if (androidTo === false) return { ok: false, error: 'Версия Android «по» — число, например 13' };

  const sleep = normalizePowerSteps(input.sleepSteps !== undefined ? input.sleepSteps : []);
  if (!sleep.ok) return { ok: false, error: `Команды сна: ${sleep.error}` };
  const wake = normalizePowerSteps(input.wakeSteps !== undefined ? input.wakeSteps : []);
  if (!wake.ok) return { ok: false, error: `Команды пробуждения: ${wake.error}` };
  const keepAwake = normalizePowerSteps(input.keepAwakeSteps !== undefined ? input.keepAwakeSteps : []);
  if (!keepAwake.ok) return { ok: false, error: `Команды удержания: ${keepAwake.error}` };

  let priority = Number(input.priority);
  if (!Number.isFinite(priority)) priority = 0;
  priority = Math.max(0, Math.min(100, Math.floor(priority)));

  const notes = input.notes ? String(input.notes).slice(0, 500) : null;
  const source = input.source ? String(input.source).slice(0, 32) : 'admin-ui';

  return {
    ok: true,
    profile: { key, label, deviceId, model, androidFrom, androidTo, sleepSteps: sleep.steps, wakeSteps: wake.steps, keepAwakeSteps: keepAwake.steps, priority, notes, source }
  };
}

/** Профиль из БД привести к каноническому виду (битые строки выбрасываем). */
function sanitizeProfileRow(profile) {
  if (!profile || !profile.key) return null;
  const sleep = normalizePowerSteps(profile.sleepSteps);
  const wake = normalizePowerSteps(profile.wakeSteps);
  const keepAwake = normalizePowerSteps(profile.keepAwakeSteps !== undefined ? profile.keepAwakeSteps : []);
  if (!sleep.ok || !wake.ok || !keepAwake.ok) {
    powerLog.warn('Профиль питания пропущен: некорректные шаги', { key: profile.key });
    return null;
  }
  return {
    key: String(profile.key).slice(0, 64),
    label: String(profile.label || profile.key).slice(0, 120),
    deviceId: profile.deviceId || null,
    model: profile.model || null,
    androidFrom: normalizeAndroidVersion(profile.androidFrom) || null,
    androidTo: normalizeAndroidVersion(profile.androidTo) || null,
    sleepSteps: sleep.steps,
    wakeSteps: wake.steps,
    keepAwakeSteps: keepAwake.steps,
    priority: Number(profile.priority) || 0,
    source: profile.source || 'db',
    notes: profile.notes || null
  };
}

// ========================================
// Хранилище (кэш профилей из БД)
// ========================================

let dbStore = { configured: false, load: null, save: null, remove: null, profiles: [] };

/**
 * Подключить хранилище профилей. Вызывается на старте сервера после миграций.
 *
 * @param {Object} deps
 * @param {Function} [deps.load] async () => массив профилей из БД
 * @param {Function} [deps.save] async (profile) => запись/обновление
 * @param {Function} [deps.remove] async (key) => удаление
 */
export function configurePowerProfileStore({ load, save, remove } = {}) {
  dbStore.load = typeof load === 'function' ? load : null;
  dbStore.save = typeof save === 'function' ? save : null;
  dbStore.remove = typeof remove === 'function' ? remove : null;
  dbStore.configured = typeof dbStore.load === 'function';
}

export function isPowerProfileStoreConfigured() {
  return dbStore.configured;
}

/** Сброс стора (для тестов): чистит кэш и отключает хранилище. */
export function resetPowerProfileStore() {
  dbStore.profiles = [];
  dbStore.load = null;
  dbStore.save = null;
  dbStore.remove = null;
  dbStore.configured = false;
}

/** Перечитать профили из БД в кэш. */
export async function loadPowerProfiles() {
  if (!dbStore.configured || typeof dbStore.load !== 'function') {
    dbStore.profiles = [];
    return [];
  }
  const rows = (await dbStore.load()) || [];
  dbStore.profiles = rows
    .map(sanitizeProfileRow)
    .filter(Boolean)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  powerLog.info('Профили питания загружены', { count: dbStore.profiles.length });
  return dbStore.profiles;
}

/**
 * Все профили для админки — только строки из БД. Понятия «встроенный профиль»
 * нет: засеянные при первом запуске правила равны прочим (правятся, удаляются).
 */
export function listPowerProfiles() {
  return dbStore.profiles.map(profile => ({ ...profile }));
}

/** Сохранить профиль (валидация + запись в БД + обновление кэша). */
export async function savePowerProfile(input) {
  const validated = validatePowerProfile(input);
  if (!validated.ok) return validated;
  if (typeof dbStore.save !== 'function') {
    return { ok: false, error: 'Хранилище профилей не настроено' };
  }
  await dbStore.save(validated.profile);
  await loadPowerProfiles();
  return { ok: true, profile: validated.profile };
}

/** Удалить профиль по ключу. */
export async function deletePowerProfile(key) {
  const normalized = String(key || '').trim();
  if (!normalized) return { ok: false, error: 'Не указан ключ профиля' };
  if (typeof dbStore.remove !== 'function') {
    return { ok: false, error: 'Хранилище профилей не настроено' };
  }
  await dbStore.remove(normalized);
  await loadPowerProfiles();
  return { ok: true };
}

// ========================================
// Выбор профиля под устройство
// ========================================

function matchesAndroid(android, from, to) {
  if (!from && !to) return true;
  const m = String(android || '').trim().match(/^(\d+)/);
  if (!m) return false;
  const v = Number(m[1]);
  if (from && v < Number(from)) return false;
  if (to && v > Number(to)) return false;
  return true;
}

/** Специфичность профиля под устройство: 0 — не подходит, больше — точнее. */
function scoreProfile(profile, ctx) {
  if (profile.deviceId && profile.deviceId !== ctx.deviceId) return 0;
  if (profile.model && (!ctx.model || !ctx.model.includes(String(profile.model).toLowerCase()))) return 0;
  if ((profile.androidFrom || profile.androidTo) && !matchesAndroid(ctx.android, profile.androidFrom, profile.androidTo)) return 0;
  const score = (profile.deviceId ? 8 : 0) + (profile.model ? 4 : 0) + (profile.androidFrom || profile.androidTo ? 2 : 0);
  return score || 1;
}

/** Профиль из пользовательского хранилища под устройство (null — нет подходящего). */
export function resolveStoredPowerProfile(target) {
  const ctx = {
    deviceId: String(target?.deviceId || ''),
    model: String(target?.model || '').trim().toLowerCase(),
    android: String(target?.android || '').trim()
  };
  let best = null;
  let bestScore = 0;
  for (const profile of dbStore.profiles) {
    const score = scoreProfile(profile, ctx);
    if (score > bestScore) {
      bestScore = score;
      best = profile;
    }
  }
  return best;
}

/**
 * Профиль питания под устройство: подходящая строка из БД, иначе резервный
 * набор. Модель/устройство определяют выбор только через параметры профиля.
 */
export function resolvePowerProfile(target) {
  const stored = resolveStoredPowerProfile(target);
  if (stored) {
    return { key: stored.key, label: stored.label, wake: stored.wakeSteps, sleep: stored.sleepSteps, keepAwake: stored.keepAwakeSteps || [] };
  }
  return FALLBACK_POWER_PROFILE;
}

// ========================================
// Каталог шагов для конструктора
// ========================================

/** Ступени сна/пробуждения, предлагаемые админу в конструкторе. */
export const POWER_STEP_CATALOG = [
  // --- Клавиши (KEYCODE) ---
  { value: 224, kind: 'keyevent', label: 'KEYCODE_WAKEUP (224)', phase: 'wake', androidMin: 20, risk: 'low', hint: 'Стандартная клавиша пробуждения экрана.' },
  { value: 26, kind: 'keyevent', label: 'KEYCODE_POWER (26)', phase: 'both', androidMin: 20, risk: 'high', hint: 'Тумблер питания: на бодрствующем устройстве усыпит обратно; на ТВ-приставках гасит Wi-Fi насовсем.' },
  { value: 170, kind: 'keyevent', label: 'KEYCODE_TV (170)', phase: 'wake', androidMin: 20, risk: 'medium', hint: 'Кнопка перехода на ТВ-вход: на многих панелях будит экран и не гасит сеть.' },
  { value: 177, kind: 'keyevent', label: 'KEYCODE_TV_POWER (177)', phase: 'wake', androidMin: 20, risk: 'medium', hint: 'Питание ТВ-панели (по CEC): поднимает панель, не трогая питание приставки.' },
  { value: 179, kind: 'keyevent', label: 'KEYCODE_STB_POWER (179)', phase: 'wake', androidMin: 20, risk: 'medium', hint: 'Питание приставки (Set-Top Box): будит бокс по CEC.' },
  { value: 181, kind: 'keyevent', label: 'KEYCODE_AVR_POWER (181)', phase: 'wake', androidMin: 20, risk: 'low', hint: 'Питание AVR/ресивера по CEC.' },
  { value: 223, kind: 'keyevent', label: 'KEYCODE_SLEEP (223)', phase: 'sleep', androidMin: 20, risk: 'medium', hint: 'Перевод экрана в сон; на ТВ-приставках может отключить сеть.' },
  { value: 276, kind: 'keyevent', label: 'KEYCODE_SOFT_SLEEP (276)', phase: 'sleep', androidMin: 20, risk: 'low', hint: 'Мягкий suspend: экран гаснет, сеть обычно остаётся. Не поддержан частью прошивок.' },
  { value: 82, kind: 'keyevent', label: 'KEYCODE_MENU (82)', phase: 'wake', androidMin: 20, risk: 'medium', hint: 'Запасная «мягкая» клавиша пробуждения без toggle.' },

  // --- cmd power ---
  { value: 'cmd:power set-screen-state on', kind: 'cmd', label: 'Экран принудительно вкл', phase: 'wake', androidMin: 11, risk: 'medium', hint: 'cmd power; есть на части прошивок (не AOSP-стандарт).' },
  { value: 'cmd:power set-screen-state off', kind: 'cmd', label: 'Экран принудительно выкл', phase: 'sleep', androidMin: 11, risk: 'medium', hint: 'Гасит подсветку даже в «Fake Standby».' },
  { value: 'cmd:power sleep', kind: 'cmd', label: 'cmd power sleep', phase: 'sleep', androidMin: 16, risk: 'low', hint: 'PowerManagerShellCommand: только Android 16+ (проверяйте cmd power help).' },
  { value: 'cmd:power sleep --disable-wakelocks', kind: 'cmd', label: 'cmd power sleep (снять wakelock)', phase: 'sleep', androidMin: 16, risk: 'medium', hint: 'Android 16+ QPR: усыпление с отключением wakelock-ов, может рвать фоновые задачи.' },
  { value: 'cmd:power wakeup', kind: 'cmd', label: 'cmd power wakeup', phase: 'wake', androidMin: 16, risk: 'low', hint: 'PowerManagerShellCommand: только Android 16+ (поддержка не гарантирована).' },

  // --- cmd display ---
  { value: 'cmd:display power-off 0', kind: 'cmd', label: 'cmd display power-off 0', phase: 'sleep', androidMin: 15, risk: 'medium', hint: 'DisplayManagerShellCommand: Android 15+. Гасит дисплей по id (обычно 0).' },
  { value: 'cmd:display power-on 0', kind: 'cmd', label: 'cmd display power-on 0', phase: 'wake', androidMin: 15, risk: 'medium', hint: 'Android 15. В Android 16 команда заменена на power-reset.' },
  { value: 'cmd:display power-reset 0', kind: 'cmd', label: 'cmd display power-reset 0', phase: 'wake', androidMin: 16, risk: 'medium', hint: 'Android 16+: сбрасывает переопределённое состояние дисплея (заменил power-on).' },

  // --- svc power ---
  { value: 'svc:power stayon false', kind: 'svc', label: 'Не держать экран на питании', phase: 'sleep', androidMin: 11, risk: 'low', hint: 'Снимает stay_on_while_plugged_in перед сном.' },
  { value: 'svc:power stayon true', kind: 'svc', label: 'Держать экран на питании', phase: 'sleep', androidMin: 11, risk: 'medium', hint: 'Обратный флаг; для панелей, гаснущих только так (см. Fake Standby).' },

  // --- svc wifi ---
  { value: 'svc:wifi enable', kind: 'svc', label: 'Включить Wi-Fi', phase: 'wake', androidMin: 10, risk: 'low', hint: 'Вернуть Wi-Fi после сна, если он отвалился (единственный способ без перезагрузки).' },

  // --- input ---
  { value: 'input:keyevent 223', kind: 'input', label: 'input keyevent 223', phase: 'sleep', androidMin: 20, risk: 'medium', hint: 'Тот же KEYCODE_SLEEP, но вызывается явно.' },
  { value: 'input:keyevent 224', kind: 'input', label: 'input keyevent 224', phase: 'wake', androidMin: 20, risk: 'low', hint: 'Тот же KEYCODE_WAKEUP, но вызывается явно.' },

  // --- settings ---
  { value: 'settings:system put screen_off_timeout 1000', kind: 'settings', label: 'Таймаут экрана 1 сек', phase: 'sleep', androidMin: 10, risk: 'low', hint: 'Рекламные панели iconBIT засыпают по таймауту, оставаясь в сети.' },
  { value: 'settings:global put stay_on_while_plugged_in 0', kind: 'settings', label: 'stay_on при питании = 0', phase: 'sleep', androidMin: 10, risk: 'low', hint: 'Дублирует svc power stayon false: разрешает гасить экран на питании.' },
  { value: 'settings:global put stay_on_while_plugged_in 7', kind: 'settings', label: 'stay_on при питании = 7', phase: 'sleep', androidMin: 10, risk: 'medium', hint: 'Битмаска 7 = AC+USB+беспроводная: экран никогда не гаснет (для панелей, которые иначе не выходят из сна).' },
  { value: 'settings:global put wifi_sleep_policy 2', kind: 'settings', label: 'Wi-Fi не спит (policy 2)', phase: 'sleep', androidMin: 10, risk: 'low', hint: '«Wi-Fi никогда не спит»: adbd остаётся доступен во сне. На Android 10+ действует не везде, для Ethernet не нужен.' },
  { value: 'settings:system put screen_brightness 0', kind: 'settings', label: 'Яркость 0 (мягкое гашение)', phase: 'sleep', androidMin: 10, risk: 'low', hint: 'Гасит подсветку, но устройство остаётся в сети и не засыпает — для панелей, которым сон рвёт связь.' },
  { value: 'settings:system put screen_brightness 200', kind: 'settings', label: 'Вернуть яркость 200', phase: 'wake', androidMin: 10, risk: 'low', hint: 'Поднять подсветку обратно, если гасили яркостью.' },

  // --- Удержание после пробуждения (сбрасывается перезагрузкой) ---
  { value: 'svc:power stayon true', kind: 'svc', label: 'Держать экран бодрым', phase: 'after', androidMin: 11, risk: 'medium', hint: 'Запрещает таймаут экрана на питании: типовой способ оставить панель включённой.' },
  { value: 'settings:secure put screensaver_enabled 0', kind: 'settings', label: 'Скринсейвер выключен', phase: 'after', androidMin: 10, risk: 'low', hint: 'Ambient Mode/Daydream гасит экран отдельно от таймаута. Сбрасывается перезагрузкой — применяем при каждом пробуждении.' },
  { value: 'settings:secure put screensaver_activate_on_sleep 0', kind: 'settings', label: 'Скринсейвер не включать во сне', phase: 'after', androidMin: 10, risk: 'low', hint: 'Запрещает запуск скринсейвера при засыпании.' },
  { value: 'settings:secure put screensaver_activate_on_dock 0', kind: 'settings', label: 'Скринсейвер не включать на доке', phase: 'after', androidMin: 10, risk: 'low', hint: 'Запрещает запуск скринсейвера на док-станции/зарядке.' },
  { value: 'settings:secure put attentive_timeout 2147483647', kind: 'settings', label: 'Отключить «невнимательный сон»', phase: 'after', androidMin: 30, risk: 'low', hint: 'Android 11+ TV (inattentive sleep): экран не гаснет по неактивности. См. AOSP TV standby.' },
  { value: 'settings:secure put amazon_ambient_enabled 0', kind: 'settings', label: 'Fire OS: Ambient выключен', phase: 'after', androidMin: 10, risk: 'low', hint: 'Fire OS 8: отдельный Ambient Experience скринсейвер.' },
  { value: 'wm:dismiss-keyguard', kind: 'wm', label: 'Снять экран блокировки', phase: 'after', androidMin: 10, risk: 'low', hint: 'Убирает keyguard, чтобы после пробуждения был виден плеер.' },

  // --- dumpsys (Doze/App Standby) ---
  { value: 'dumpsys:deviceidle disable', kind: 'dumpsys', label: 'Отключить Doze', phase: 'both', androidMin: 10, risk: 'medium', hint: 'Полностью выключает Doze без root (сбрасывается перезагрузкой).' },
  { value: 'dumpsys:deviceidle unforce', kind: 'dumpsys', label: 'Снять force-idle', phase: 'both', androidMin: 10, risk: 'low', hint: 'Вывести устройство из принудительного idle после тестов Doze.' },
  { value: `dumpsys:deviceidle whitelist +${ANDROID_PACKAGE_NAME}`, kind: 'dumpsys', label: 'Плеер вне Doze (whitelist)', phase: 'both', androidMin: 10, risk: 'low', hint: 'Пакет плеера исключается из Doze; на части прошивок переживает перезагрузку.' },
  { value: `cmd:appops set ${ANDROID_PACKAGE_NAME} RUN_ANY_IN_BACKGROUND allow`, kind: 'cmd', label: 'Фон без лимитов (appops)', phase: 'both', androidMin: 11, risk: 'low', hint: 'Android 11+: снимает фоновые ограничения для пакета плеера.' },
  { value: `am:set-standby-bucket ${ANDROID_PACKAGE_NAME} active`, kind: 'am', label: 'Плеер вне App Standby', phase: 'both', androidMin: 10, risk: 'low', hint: 'Выводит пакет плеера из App Standby, чтобы его не выгружала система.' },

  // --- Вендор: панели Lumien серии Standard (LS) по LAN (TCP 4664, ASCII) ---
  // Команда идёт в саму панель, а не в Android: работает и в «Fake Standby»,
  // где OS бодрствует, а гаснет только подсветка. Формат: `:01` + S/G + тип +
  // 3 цифры + CR (см. utils/lumien-lan.js). Серия Basic (LB3235SDG2) порт
  // 4664 НЕ слушает — у неё RS232/веб-интерфейс 8081, используйте её ADB-профиль.
  { value: 'lan::01SE0000', kind: 'lan', label: 'Lumien Standard LAN: экран off', phase: 'sleep', androidMin: 10, risk: 'medium', hint: 'Вендор-команда панелей серии Standard (LS) по TCP 4664: гасит подсветку независимо от версии Android. У Basic (LB3235SDG2) порт 4664 закрыт.' },
  { value: 'lan::01SE0001', kind: 'lan', label: 'Lumien Standard LAN: экран on', phase: 'wake', androidMin: 10, risk: 'medium', hint: 'Поднимает подсветку панели Lumien Standard по LAN, даже если Android остаётся в «Fake Standby». Только серия LS.' },
  { value: 'lan::01S0000', kind: 'lan', label: 'Lumien Standard LAN: подсветка off', phase: 'sleep', androidMin: 10, risk: 'medium', hint: 'Power-команда Lumien: 000 — подсветка off. В Fake Standby гасит только её, платы и Android живы. Только серия LS.' },
  { value: 'lan::01S0001', kind: 'lan', label: 'Lumien Standard LAN: питание on', phase: 'wake', androidMin: 10, risk: 'medium', hint: 'Power-команда Lumien «включить» (0001..0003 — состояния). Проверьте точное значение на панели. Только серия LS.' }
];