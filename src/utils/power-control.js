/**
 * Управление питанием Android-устройств: выбор целей и выполнение команд.
 *
 * Логика вынесена из роутов, чтобы покрыть её тестами без Express и без
 * настоящего ADB: все внешние вызовы подменяются через `commands`.
 *
 * @module utils/power-control
 */

import { sleepDevice, wakeDevice, getDeviceMac, launchAndroidApp, isAndroidDevice } from './adb.js';
import { sendWakeOnLan, readArpMac, normalizeMac } from './wol.js';
import { ANDROID_PACKAGE_NAME, ANDROID_MAIN_ACTIVITY } from '../config/android.js';
import { isReservedObjectKey } from './sanitize.js';

export const POWER_ACTIONS = ['sleep', 'wake'];

export { isAndroidDevice };

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
  getDeviceMac,
  sendWakeOnLan,
  readArpMac,
  delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  launchApp: async (ip, port) => launchAndroidApp(ip, ANDROID_PACKAGE_NAME, ANDROID_MAIN_ACTIVITY, port)
};

const ADB_TIMEOUT_MS = 8000;
const WOL_WAIT_MS = 2500;

/**
 * Выполнить команду питания на всех целях параллельно.
 *
 * Сон всегда идёт только по ADB. Пробуждение сначала пробуем ADB, а если
 * устройство в сне выпало из сети — шлём магический пакет по Ethernet и
 * повторяем ADB-команду. И только после успешного пробуждения (если
 * `relaunch`) поднимаем плеер, чтобы экран не остался с чужим приложением.
 *
 * @param {Array<{deviceId: string, ip: string, port?: string|null, mac?: string|null}>} targets
 * @param {'sleep'|'wake'} action
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

    if (action === 'sleep') {
      const result = await commands.sleepDevice(ip, port, adbTimeoutMs);
      if (!result.ok) {
        return { deviceId, ok: false, error: result.error || 'ADB не отвечает' };
      }
      await rememberMac(target, commands, adbTimeoutMs, storeMac);
      return { deviceId, ok: true, awake: false };
    }

    let wake = await commands.wakeDevice(ip, port, adbTimeoutMs);

    if (!wake.ok) {
      const mac = target.mac || commands.readArpMac(ip);
      if (mac) {
        try {
          await commands.sendWakeOnLan(mac);
          await commands.delay(wolWaitMs);
          wake = await commands.wakeDevice(ip, port, adbTimeoutMs);
        } catch (error) {
          wake = { ok: false, error: `${wake.error || 'ADB не отвечает'} / Wake-on-LAN: ${error.message}` };
        }
      }
    }

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
