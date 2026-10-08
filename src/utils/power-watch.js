/**
 * Фоновое зеркалирование реального состояния питания «спит/активен».
 *
 * Хранимое состояние (power-control.powerStates) живёт в памяти и до недавнего
 * обновлялось только по командам питания и ручному опросу /power-state. Если
 * приставка уснула сама (таймаут экрана) или её разбудили пультом или
 * Wake-on-LAN мимо панели — сервер об этом долго не знает, и плитки спикера и
 * админки показывают устаревший статус. Воркер раз в N секунд читает реальное
 * состояние по ADB и рассылает изменения, поэтому статус сходится к факту
 * в пределах одного цикла опроса.
 *
 * @module utils/power-watch
 */

import { getPowerState } from './adb.js';
import {
  planPowerTargets,
  getStoredPowerAwake,
  setStoredPowerState,
  isPowerCommandRecent
} from './power-control.js';
import { createModuleLogger } from './logger.js';
import { timerRegistry } from './timer-registry.js';

const watchLog = createModuleLogger('power-watch');

export const POWER_WATCH_DEFAULT_INTERVAL_MS = 30_000;
export const POWER_WATCH_DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_ADB_TIMEOUT_MS = 8000;

/** Прогнать items через worker c не более чем `limit` одновременных вызовов. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => runner()
  );
  await Promise.all(runners);
  return results;
}

/**
 * Опросить и сохранить реальное состояние питания группы устройств.
 *
 * Обновляет хранимое состояние и рассылает `devices/power` только при реальном
 * изменении. Неудачный опрос (ADB не отвечает) хранимое состояние не трогает —
 * остаётся последнее известное. `respectCommandGuard` не даёт перетереть
 * состояние, только что записанное командой питания (см. notePowerCommand).
 *
 * @param {Array<{deviceId: string, ip: string, port?: string|null}>} targets
 * @param {Object} [options]
 * @param {(deviceId: string, target: Object) => Promise<string|number>} [options.resolvePort]
 * @param {Object|null} [options.io] Socket.IO — если передан, рассылает devices/power
 * @param {Object} [options.commands] Подмена внешних вызовов в тестах
 * @param {boolean} [options.respectCommandGuard]
 * @param {number} [options.concurrency]
 * @param {number} [options.adbTimeoutMs]
 * @returns {Promise<Array<{deviceId: string, ok: boolean, awake: boolean|null, screenOn: boolean|null, error?: string}>>}
 */
export async function pollPowerStates(targets, options = {}) {
  const list = Array.isArray(targets) ? targets : [];
  if (!list.length) return [];

  const {
    resolvePort = null,
    io = null,
    commands = {},
    respectCommandGuard = false,
    concurrency = DEFAULT_CONCURRENCY,
    adbTimeoutMs = DEFAULT_ADB_TIMEOUT_MS
  } = options;

  const getPowerStateFn = commands.getPowerState || getPowerState;

  const withPorts = await Promise.all(list.map(async (target) => {
    let port = target.port;
    if (!port && resolvePort) {
      port = String(await resolvePort(target.deviceId, target) || '');
    }
    return { ...target, port: port || null };
  }));

  const states = await mapWithConcurrency(withPorts, concurrency, async (target) => {
    const state = await getPowerStateFn(target.ip, target.port || null, adbTimeoutMs);
    if (!state || !state.ok) {
      return {
        deviceId: target.deviceId,
        ok: false,
        awake: null,
        screenOn: null,
        error: (state && state.error) || 'ADB не отвечает'
      };
    }
    return { deviceId: target.deviceId, ok: true, awake: state.awake, screenOn: state.screenOn };
  });

  for (const state of states) {
    if (!state.ok) {
      watchLog.warn('Не удалось получить состояние питания', {
        deviceId: state.deviceId,
        error: state.error
      });
      continue;
    }
    if (respectCommandGuard && isPowerCommandRecent(state.deviceId)) continue;
    const prev = getStoredPowerAwake(state.deviceId);
    setStoredPowerState(state.deviceId, state.awake);
    if (prev !== state.awake && io && typeof io.emit === 'function') {
      io.emit('devices/power', { deviceId: state.deviceId, awake: state.awake });
    }
  }

  return states;
}

/**
 * Запустить фоновый опрос питания всех Android-устройств.
 *
 * Цикл планируется рекурсивным setTimeout с интервалом от предыдущего шага —
 * опрос, затянувшийся дольше интервала, не превращается в зверинец из
 * параллельных прогонов. Первый запуск — через `initialDelayMs`, чтобы не
 * соревноваться со стартом сервера.
 *
 * @param {Object} [deps]
 * @param {Record<string, Object>|() => Record<string, Object>} [deps.devices]
 *   Живая карта устройств сервера (функция позволяет перечитать её после
 *   полуавтоматической перезагрузки кэша при переподключении к БД).
 * @param {Object} [deps.io]
 * @param {(deviceId: string, target: Object) => Promise<string>} [deps.resolvePort]
 * @param {number} [deps.intervalMs]
 * @param {number} [deps.initialDelayMs]
 * @param {Object} [deps.commands]
 * @param {{setTimeout: Function, clear: Function}} [deps.timerRegistry]
 * @returns {() => void} Функция остановки воркера
 */
export function startPowerWatchdog(deps = {}) {
  const {
    devices,
    io = null,
    resolvePort = null,
    intervalMs = POWER_WATCH_DEFAULT_INTERVAL_MS,
    initialDelayMs = POWER_WATCH_DEFAULT_INITIAL_DELAY_MS,
    commands = {},
    timerRegistry: registry = timerRegistry
  } = deps;

  let activeTimer = null;
  let scheduled = false;
  let running = false;
  let stopped = false;

  function clearActiveTimer() {
    stopped = true;
    if (activeTimer !== null) {
      registry.clear(activeTimer);
      activeTimer = null;
    }
  }

  function scheduleNext(delay) {
    if (stopped || scheduled) return;
    scheduled = true;
    activeTimer = registry.setTimeout(async () => {
      scheduled = false;
      activeTimer = null;
      await tick();
    }, delay, 'Power state watchdog');
  }

  async function tick() {
    if (running) return;
    running = true;
    const startedAt = Date.now();
    try {
      const plan = planPowerTargets(
        typeof devices === 'function' ? devices() : devices,
        null
      );

      await pollPowerStates(plan.targets, {
        resolvePort,
        io,
        commands,
        respectCommandGuard: true
      });

      if (plan.targets.length > 0) {
        watchLog.debug('Опрос состояния питания завершён', {
          polls: plan.targets.length,
          durationMs: Date.now() - startedAt
        });
      }
    } catch (error) {
      watchLog.warn('Цикл опроса состояния питания упал', { error: error.message });
    } finally {
      running = false;
      scheduleNext(Math.max(5000, intervalMs));
    }
  }

  scheduleNext(Math.max(0, initialDelayMs));

  return clearActiveTimer;
}