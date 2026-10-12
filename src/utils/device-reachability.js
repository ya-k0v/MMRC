/**
 * Состояние доступности устройств и backoff опроса.
 *
 * Устройство может быть выключено (например, пропало питание). Чтобы проект
 * работал 24/7 и не упирался в лимиты процессов, недоступные устройства
 * опрашиваются реже, но интервал ограничен сверху (по умолчанию 60с) — как
 * только устройство вернётся, оно обнаружится в пределах этого интервала.
 *
 * Состояние хранится в памяти по `deviceId`: размер ограничен числом
 * устройств и не растёт со временем.
 *
 * @module utils/device-reachability
 */

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const OFFLINE_BASE_MS = envInt('ADB_BACKOFF_BASE_MS', 30_000);
const OFFLINE_MAX_MS = Math.max(
  OFFLINE_BASE_MS,
  envInt('ADB_BACKOFF_MAX_MS', 60_000)
);

const states = new Map();

function keyOf(deviceId) {
  return String(deviceId || '');
}

/** Пора ли проверять устройство (у офлайн — по расписанию backoff). */
export function shouldProbe(deviceId, now = Date.now()) {
  const state = states.get(keyOf(deviceId));
  if (!state) return true;
  return state.nextProbeAt <= now;
}

/** Известная доступность: true/false или null, если ещё не проверяли. */
export function isOnline(deviceId) {
  const state = states.get(keyOf(deviceId));
  return state ? state.online : null;
}

/** Отметить успешную проверку: доступно, backoff сброшен. */
export function markOnline(deviceId, now = Date.now()) {
  states.set(keyOf(deviceId), {
    online: true,
    failures: 0,
    lastSeenAt: now,
    lastProbeAt: now,
    nextProbeAt: now
  });
}

/**
 * Отметить неудачную проверку: доступно=false, пауза растёт экспоненциально,
 * но не больше `ADB_BACKOFF_MAX_MS`.
 *
 * @returns {number} задержка до следующей проверки, мс
 */
export function markOffline(deviceId, now = Date.now()) {
  const key = keyOf(deviceId);
  const previous = states.get(key);
  const failures = (previous ? previous.failures : 0) + 1;
  const delay = Math.min(OFFLINE_BASE_MS * 2 ** (failures - 1), OFFLINE_MAX_MS);

  states.set(key, {
    online: false,
    failures,
    lastSeenAt: previous ? previous.lastSeenAt : null,
    lastProbeAt: now,
    nextProbeAt: now + delay
  });

  return delay;
}

/** Снимок состояния доступности устройства. */
export function getReachability(deviceId) {
  const state = states.get(keyOf(deviceId));
  if (!state) {
    return { online: null, failures: 0, lastSeenAt: null, lastProbeAt: null, nextProbeAt: null };
  }
  return { ...state };
}

/** Забыть устройство (например, при удалении). */
export function forgetDevice(deviceId) {
  states.delete(keyOf(deviceId));
}

/** Полный сброс (тесты). */
export function resetReachability() {
  states.clear();
}
