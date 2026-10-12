/**
 * Управление питанием Android-устройств: выбор целей и выполнение команд.
 *
 * Логика вынесена из роутов, чтобы покрыть её тестами без Express и без
 * настоящего ADB: все внешние вызовы подменяются через `commands`.
 *
 * @module utils/power-control
 */

import {
  sleepDevice,
  wakeDevice,
  wakeKey,
  getDeviceMac,
  getPowerState,
  launchAndroidApp,
  isAndroidDevice,
  setWifiSleepPolicy,
  KEYCODE_WAKEUP
} from './adb.js';
import { sendWakeOnLanAuto, readHostArpMac, normalizeMac } from './wol.js';
import { ANDROID_PACKAGE_NAME, ANDROID_MAIN_ACTIVITY } from '../config/android.js';
import { isReservedObjectKey } from './sanitize.js';
import { createModuleLogger } from './logger.js';

const powerLog = createModuleLogger('power');

export const POWER_ACTIONS = ['sleep', 'wake', 'launch'];

export { isAndroidDevice };

/**
 * Последний известный режим питания: deviceId → awake (boolean).
 *
 * Живёт в памяти как «последнее известное»: опрос по ADB дорогой, поэтому
 * статусы «спит/активен» раскрашиваются из этого кэша во всех панелях
 * (спикер, админка), а не опрашивают каждое устройство на каждый рендер.
 */
const powerStates = new Map();

/** Сохранить известное состояние питания устройства (null стирает запись). */
export function setStoredPowerState(deviceId, awake) {
  const key = String(deviceId || '');
  if (!key || isReservedObjectKey(key)) return;
  if (awake === null || awake === undefined) {
    powerStates.delete(key);
  } else {
    powerStates.set(key, Boolean(awake));
  }
}

/** Известное состояние питания: true — активен, false — спит, null — неизвестно. */
export function getStoredPowerAwake(deviceId) {
  const value = powerStates.get(String(deviceId || ''));
  return value === undefined ? null : value;
}

/**
 * После команды питания фоновый опрос не должен перетирать только что
 * записанное состояние результатом опроса, стартовавшего ДО команды (тот мог
 * прочитать ещё старое состояние экрана). На это время устройство попадает
 * в «тихую зону»: команды питания отмечают её, а pollPowerStates пропускает
 * такие устройства через isPowerCommandRecent.
 */
const POWER_COMMAND_QUIET_MS = 10_000;

/** Момент последней команды питания по устройству: deviceId → timestamp. */
const powerCommandTimestamps = new Map();

/** Отметить, что по устройству только что выполнялась команда питания. */
export function notePowerCommand(deviceId) {
  const key = String(deviceId || '');
  if (!key || isReservedObjectKey(key)) return;
  powerCommandTimestamps.set(key, Date.now());
}

/** Выполнялась ли по устройству команда питания в последние `windowMs`. */
export function isPowerCommandRecent(deviceId, windowMs = POWER_COMMAND_QUIET_MS) {
  const key = String(deviceId || '');
  if (!key) return false;
  const timestamp = powerCommandTimestamps.get(key);
  return timestamp !== undefined && Date.now() - timestamp < windowMs;
}

/**
 * Собрать цели для команды.
 *
 * Без списка id берём все Android-устройства с известным IP (кнопка «усыпить
 * всё»). С явным списком чужие и не-Android id попадают в `rejected` с
 * понятной причиной, а не игнорируются молча.
 *
 * @param {Object} devicesMap
 * @param {string[]|null} requestedIds
 * @returns {{targets: Array<{deviceId: string, ip: string, port: string|null, mac: string|null}>, rejected: Array<{deviceId: string, error: string}>}}
 */
export function planPowerTargets(devicesMap, requestedIds) {
  const targets = [];
  const rejected = [];
  const explicit = Array.isArray(requestedIds) && requestedIds.length > 0;

  if (explicit) {
    const seen = new Set();
    for (const rawId of requestedIds) {
      const deviceId = String(rawId || '').trim();
      if (!deviceId || seen.has(deviceId)) continue;
      seen.add(deviceId);

      const device = (devicesMap || {})[deviceId];
      if (isReservedObjectKey(deviceId) || !device) {
        rejected.push({ deviceId, error: 'Устройство не найдено' });
        continue;
      }
      if (!isAndroidDevice(device)) {
        rejected.push({ deviceId, error: 'Не Android-устройство' });
        continue;
      }
      if (!device.ipAddress) {
        rejected.push({ deviceId, error: 'IP адрес устройства не задан' });
        continue;
      }

      targets.push(toTarget(deviceId, device));
    }
    return { targets, rejected };
  }

  for (const [deviceId, device] of Object.entries(devicesMap || {})) {
    if (isReservedObjectKey(deviceId) || !isAndroidDevice(device)) continue;
    if (!device.ipAddress) continue;
    targets.push(toTarget(deviceId, device));
  }

  return { targets, rejected };
}

function toTarget(deviceId, device) {
  return {
    deviceId,
    ip: device.ipAddress,
    port: device.adbPort || null,
    mac: normalizeMac(device.macAddress) || null
  };
}

/** Внешние команды: подменяются в тестах. */
export const DEFAULT_POWER_COMMANDS = {
  sleepDevice,
  wakeDevice,
  wakeKey,
  getDeviceMac,
  getPowerState,
  sendWakeOnLan: sendWakeOnLanAuto,
  readArpMac: readHostArpMac,
  delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  launchApp: async (ip, port) => launchAndroidApp(ip, ANDROID_PACKAGE_NAME, ANDROID_MAIN_ACTIVITY, port),
  prepareForSleep: (ip, port) => setWifiSleepPolicy(ip, port || null, '2')
};

function envList(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const values = raw.split(',').map(value => value.trim()).filter(Boolean);
  return values.length > 0 ? values : fallback;
}

const ADB_TIMEOUT_MS = 8000;
const WOL_WAIT_MS = 2500;
const WOL_RETRY_DELAY_MS = 400;

/** Перед сном включать «Wi-Fi не отключать» (`POWER_PREPARE_NETWORK=0` отключает). */
const PREPARE_NETWORK_BEFORE_SLEEP = process.env.POWER_PREPARE_NETWORK !== '0';

/** Клавиши пробуждения по порядку (`POWER_WAKE_KEYCODES="224,26,170"`). */
const WAKE_KEYCODES = envList('POWER_WAKE_KEYCODES', ['224', '26', '170']).map(Number).filter(Number.isFinite);

/** Порты WoL: шлём на все (`POWER_WOL_PORTS="9,7"`). */
const WOL_PORTS = envList('POWER_WOL_PORTS', ['9', '7']).map(Number).filter(Number.isFinite);

/**
 * Выполнить команду питания на всех целях параллельно.
 *
 * Сон: сначала включается «Wi-Fi во сне не отключать» (`wifi_sleep_policy=2`),
 * чтобы ТВ не выпал из сети, затем `KEYCODE_SLEEP`. Пробуждение — универсальная
 * лестница: пробуем клавиши (`WAKEUP → POWER → TV_POWER`, последовательность
 * настраивается через `POWER_WAKE_KEYCODES`), каждую проверяя по `dumpsys
 * power`; если ADB в сне потерялся либо клавиши не подняли экран — шлём
 * Wake-on-LAN (на порты из `POWER_WOL_PORTS`, по умолчанию 9 и 7) и повторяем
 * клавиши. И только после успешного пробуждения (если `relaunch`) поднимаем
 * плеер, чтобы экран не остался с чужим приложением.
 *
 * Акция `launch` — перезапуск плеера без сна/пробуждения: провайдер убивает
 * старый процесс приложения и запускает новый (см. adb.launchAndroidApp).
 * Режим питания при этом не меняется, поэтому в результате нет поля `awake`.
 *
 * @param {Array<{deviceId: string, ip: string, port?: string|null, mac?: string|null}>} targets
 * @param {'sleep'|'wake'|'launch'} action
 * @param {{commands?: Object, relaunch?: boolean, adbTimeoutMs?: number, wolWaitMs?: number, storeMac?: (deviceId: string, mac: string) => Promise<any>}} [options]
 * @returns {Promise<{results: Array<{deviceId: string, ok: boolean, awake?: boolean, error?: string}>, succeeded: number, failed: number}>}
 */
export async function runPowerAction(targets, action, options = {}) {
  if (!POWER_ACTIONS.includes(action)) {
    throw new Error(`Неизвестная команда питания: ${action}`);
  }

  const commands = options.commands || DEFAULT_POWER_COMMANDS;
  const adbTimeoutMs = options.adbTimeoutMs ?? ADB_TIMEOUT_MS;
  const wolWaitMs = options.wolWaitMs ?? WOL_WAIT_MS;
  const relaunch = options.relaunch !== false;
  const storeMac = options.storeMac || (async () => {});

  const results = await Promise.all(targets.map(target =>
    runForTarget(target, action, { commands, adbTimeoutMs, wolWaitMs, relaunch, storeMac })
  ));

  for (const result of results) {
    notePowerCommand(result.deviceId);
    if (result.ok) {
      powerLog.info(`Команда питания выполнена: ${action}`, {
        deviceId: result.deviceId,
        awake: result.awake
      });
    } else {
      powerLog.warn(`Команда питания не выполнена: ${action}`, {
        deviceId: result.deviceId,
        awake: result.awake ?? null,
        error: result.error
      });
    }
  }

  const succeeded = results.filter(result => result.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}

async function runForTarget(target, action, options) {
  const { commands, adbTimeoutMs, wolWaitMs, relaunch, storeMac } = options;
  const { deviceId, ip } = target;

  try {
    if (!ip) {
      return { deviceId, ok: false, error: 'IP адрес устройства не задан' };
    }
    const port = target.port || null;

    if (action === 'launch') {
      // Перезапуск плеера: старый процесс гасится и поднимается новый.
      // Спящее/бодрствующее состояние не трогаем.
      const launch = await commands.launchApp(ip, port);
      if (!launch.ok) {
        return { deviceId, ok: false, error: launch.error || 'ADB не отвечает' };
      }
      return { deviceId, ok: true };
    }

    if (action === 'sleep') {
      // Перед сном включаем «Wi-Fi во сне не отключать», чтобы ТВ не выпал из
      // сети и его можно было разбудить по ADB. Лучшие усилия: если команда
      // не прошла, сон всё равно пробуем — вдруг политика уже выставлена.
      if (PREPARE_NETWORK_BEFORE_SLEEP && commands.prepareForSleep) {
        try {
          const prepared = await commands.prepareForSleep(ip, port);
          if (prepared && prepared.ok === false) {
            powerLog.warn('Не удалось настроить Wi-Fi перед сном', { deviceId, error: prepared.error });
          }
        } catch (error) {
          powerLog.warn('Ошибка настройки Wi-Fi перед сном', { deviceId, error: error.message });
        }
      }

      const result = await commands.sleepDevice(ip, port, adbTimeoutMs);
      if (!result.ok) {
        return { deviceId, ok: false, error: result.error || 'ADB не отвечает' };
      }
      await rememberMac(target, commands, adbTimeoutMs, storeMac);
      return { deviceId, ok: true, awake: false };
    }

    const wake = await wakeTarget(target, { commands, adbTimeoutMs, wolWaitMs });

    if (!wake.ok) {
      return { deviceId, ok: false, error: wake.error || 'ADB не отвечает' };
    }

    await rememberMac(target, commands, adbTimeoutMs, storeMac);

    if (relaunch) {
      try {
        const launch = await commands.launchApp(ip, port);
        if (launch && launch.ok === false) {
          return { deviceId, ok: false, awake: true, error: `Проснулось, но плеер не запустился: ${launch.error || 'неизвестная ошибка'}` };
        }
      } catch (error) {
        return { deviceId, ok: false, awake: true, error: `Проснулось, но плеер не запустился: ${error.message}` };
      }
    }

    return { deviceId, ok: true, awake: true };
  } catch (error) {
    return { deviceId, ok: false, error: error.message };
  }
}

/**
 * Пробуждение универсальной лестницей: клавиши → Wake-on-LAN → клавиши.
 *
 * Приставки обычно будятся одним KEYCODE_WAKEUP. На полноценных ТВ (LUMEN)
 * эта клавиша не срабатывает: либо устройство в глубоком сне выпало из сети
 * (тогда нужен магический пакет), либо экран не поднимается от WAKEUP и
 * требуется KEYCODE_POWER/KEYCODE_TV_POWER. Поэтому пробуем клавиши по
 * очереди, проверяя реальный результат по `dumpsys power`, и если ADB в сне
 * потерялся — шлём WoL на все порты и повторяем клавиши.
 *
 * @param {{deviceId: string, ip: string, port: string|null, mac: string|null}} target
 * @param {{commands: Object, adbTimeoutMs: number, wolWaitMs: number}} options
 * @returns {Promise<{ok: boolean, awake?: boolean, error?: string}>}
 */
async function wakeTarget(target, options) {
  const { commands, adbTimeoutMs, wolWaitMs } = options;
  const { deviceId, ip } = target;
  const port = target.port || null;

  const keycodes = (options.keycodes && options.keycodes.length) ? options.keycodes
    : (WAKE_KEYCODES.length ? WAKE_KEYCODES : [KEYCODE_WAKEUP]);

  const ladder = async () => {
    let lastError = null;
    for (const keycode of keycodes) {
      const send = keycode === KEYCODE_WAKEUP
        ? commands.wakeDevice(ip, port, adbTimeoutMs)
        : commands.wakeKey(ip, port, keycode, adbTimeoutMs);
      const result = await send;

      if (!result.ok) {
        // ADB потерял устройство — дальше клавиши бессмысленны, только WoL.
        return { ok: false, awake: null, error: result.error || 'ADB не отвечает' };
      }

      lastError = null;
      const awake = await isReallyAwake(commands, ip, port, adbTimeoutMs);
      if (awake !== false) {
        // awake === true — экран поднялся. awake === null — разобрать состояние
        // не вышло, считаем клавишу сработавшей (как раньше), но POWER дальше
        // не шлём: на уже бодрствующем устройстве он экран просто потушит.
        powerLog.info('Пробуждение сработало клавишей', { deviceId, keycode, via: 'keyevent' });
        return { ok: true, awake: true };
      }
      // Клавиша выполнилась, но экран не поднялся — пробуем следующую.
      lastError = 'клавиши не подняли экран';
      await commands.delay(WOL_RETRY_DELAY_MS);
    }
    return { ok: false, awake: false, error: lastError || 'ADB не отвечает' };
  };

  const first = await ladder();
  if (first.ok) return first;

  // ADB потерял устройство (first.awake === null) или клавиши не помогли —
  // пробуем разбудить магическим пакетом, затем повторяем клавиши.
  const mac = target.mac || await commands.readArpMac(ip);
  if (!mac) return first;

  try {
    for (const wolPort of WOL_PORTS) {
      await commands.sendWakeOnLan(mac, { port: wolPort });
      await commands.delay(wolWaitMs);
    }
  } catch (error) {
    return { ok: first.ok, awake: first.awake, error: `${first.error || 'ADB не отвечает'} / Wake-on-LAN: ${error.message}` };
  }

  const after = await ladder();
  return after.ok ? after : { ok: false, awake: after.awake, error: after.error || first.error || 'ADB не отвечает' };
}

/** Реально ли устройство проснулось: true/false, или null, если проверить нельзя. */
async function isReallyAwake(commands, ip, port, adbTimeoutMs) {
  if (!commands.getPowerState) return null;
  try {
    const state = await commands.getPowerState(ip, port || null, adbTimeoutMs);
    if (!state.ok || state.awake === null) return null;
    return state.awake;
  } catch (_) {
    return null;
  }
}

/** MAC узнаём один раз, пока устройство доступно по ADB, и дальше храним. */
async function rememberMac(target, commands, adbTimeoutMs, storeMac) {
  if (target.mac) return;

  try {
    const discovered = await commands.getDeviceMac(target.ip, target.port || null, adbTimeoutMs);
    if (discovered.ok && discovered.mac) {
      target.mac = normalizeMac(discovered.mac) || null;
      await storeMac(target.deviceId, discovered.mac);
    }
  } catch (_) {
    // MAC — приятный бонус, без него обойдёмся
  }
}
