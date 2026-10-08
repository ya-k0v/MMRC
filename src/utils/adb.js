/**
 * ADB: транспорт (connect → shell → disconnect), запуск приложения и
 * управление питанием Android-устройств.
 *
 * Весь ADB живёт в одном модуле: обвязка с `execFile`, таймаутами и
 * disconnect написана один раз, а не копируется в каждый потребитель.
 *
 * @module utils/adb
 */

import { execFile } from 'node:child_process';
import { ANDROID_PACKAGE_NAME, ANDROID_MAIN_ACTIVITY, DEFAULT_ADB_PORT } from '../config/android.js';
import { createModuleLogger } from './logger.js';

const adbLog = createModuleLogger('adb');

const DEFAULT_TIMEOUT_MS = 15000;

export const KEYCODE_SLEEP = 223;
export const KEYCODE_WAKEUP = 224;

/**
 * Устройство, которым можно управлять по ADB.
 *
 * Маркеры собраны из того, что реально приходит с плееров: тип устройства,
 * платформа WebView и нативный плеер MMRC.
 *
 * @param {{deviceType?: string, device_type?: string, platform?: string}|null} device
 * @returns {boolean}
 */
export function isAndroidDevice(device) {
  const deviceType = String(device?.deviceType || device?.device_type || '').toLowerCase();
  const platform = String(device?.platform || '').toLowerCase();

  return deviceType.includes('android')
    || deviceType.includes('native_mediaplayer')
    || platform.includes('android');
}

const DAEMON_STARTUP_ERROR = /daemon not running|cannot connect to daemon|failed to start daemon/i;

/**
 * Одна adb-команда с таймаутом: без него зависший adb виснет навсегда.
 *
 * При холодном старте два одновременных вызова adb сорятся за порт 5037, и
 * проигравший падает с «daemon not running; starting now» — тогда повторяем
 * один раз, пока победитель поднимет демон.
 *
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<string>} stdout
 */
export async function runAdb(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    return await execAdb(args, timeoutMs);
  } catch (error) {
    if (!DAEMON_STARTUP_ERROR.test(String(error?.message || ''))) throw error;
    await new Promise(resolve => setTimeout(resolve, 500));
    return execAdb(args, timeoutMs);
  }
}

function execAdb(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      reject(new Error(`adb timeout: ${args.join(' ')}`));
    }, timeoutMs);
    execFile('adb', args, (err, stdout, stderr) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (err) {
        const message = stderr || err.message;
        adbLog.error('adb команда упала', { args, durationMs, error: message });
        reject(new Error(message));
        return;
      }
      adbLog.debug('adb команда выполнена', { args, durationMs });
      resolve(stdout || '');
    });
  });
}

/**
 * Очереди команд по устройствам.
 *
 * `connect → shell → disconnect` на одном target нельзя выполнять параллельно:
 * disconnect одной команды рвёт сессию другой, и та падает с «device not
 * found». Именно так «нет ответа» и появлялось: `/power-state` опрашивал
 * состояние питания и MAC одновременно, более быстрая команда успевала
 * отключиться, пока `dumpsys power` ещё шёл.
 */
const targetQueues = new Map();

function enqueueAdbCommand(target, task) {
  const previous = targetQueues.get(target) || Promise.resolve();
  const current = previous.then(task);
  // Цепочка хранится как промис, который никогда не отклоняется, — упавшая
  // команда не должна ронять очередь для следующих.
  const settled = current.then(() => {}, () => {});
  targetQueues.set(target, settled);

  settled.then(() => {
    if (targetQueues.get(target) === settled) targetQueues.delete(target);
  });

  return current;
}

/**
 * Выполнить shell-команду на устройстве: connect → shell → disconnect.
 *
 * Команды для одного устройства выполняются строго по очереди (см.
 * `targetQueues`), для разных устройств — параллельно.
 *
 * @param {string} ip
 * @param {string|number} port
 * @param {string[]} command
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
 */
export function adbShell(ip, port, command, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const target = `${ip}:${port}`;

  return enqueueAdbCommand(target, () => adbShellNow(target, command, timeoutMs));
}

async function adbShellNow(target, command, timeoutMs) {
  try {
    await runAdb(['connect', target], timeoutMs);
  } catch (error) {
    return { ok: false, error: `adb connect error: ${error.message}` };
  }

  try {
    const output = await runAdb(['-s', target, 'shell', ...command], timeoutMs);
    return { ok: true, output };
  } catch (error) {
    return { ok: false, error: `adb shell error: ${error.message}` };
  } finally {
    try {
      await runAdb(['disconnect', target], Math.min(timeoutMs, 5000));
    } catch (_) {
      // разрыв соединения не критичен
    }
  }
}

/**
 * Запуск Android-приложения на устройстве по IP через adb
 *
 * Перед запуском старый процесс приложения обязательно гасится: `am start` по
 * живому плееру с высокой вероятностью укладывает второй экземпляр окном поверх
 * основного.
 *
 * Команды нельзя склеивать через `sh -c` с `&&`: adb передаёт аргументы в
 * устройство как есть, и `['sh', '-c', 'am force-stop ... && am start ...']`
 * превращается на стороне приставки в `sh -c am force-stop ... && am start ...`
 * — `sh -c` берёт строкой только `am` (запускается без аргументов и падает с
 * ошибкой), поэтому `am start` никогда не выполняется. Поэтому запускаем две
 * команды последовательно; очередь адресуется к тому же target, так что обе
 * сессии не конкурируют.
 *
 * @param {string} ip - IP адрес устройства
 * @param {string} [packageName] - package name приложения (по умолчанию из конфига)
 * @param {string} [activity] - activity для запуска (по умолчанию из конфига)
 * @param {string|number} [port] - adb-порт устройства
 * @param {number} [timeoutMs] - таймаут операций adb в мс
 * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
 */
export async function launchAndroidApp(ip, packageName = ANDROID_PACKAGE_NAME, activity = ANDROID_MAIN_ACTIVITY, port = DEFAULT_ADB_PORT, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const forceStop = await adbShell(ip, port, ['am', 'force-stop', packageName], timeoutMs);
  if (!forceStop.ok) {
    return forceStop;
  }
  return adbShell(ip, port, ['am', 'start', '-n', `${packageName}/${activity}`], timeoutMs);
}

/**
 * Разобрать вывод `dumpsys power`.
 *
 * Формат меняется между версиями Android, поэтому проверяем несколько
 * каноничных маркеров: mWakefulness есть на всех современных сборках,
 * а состояние экрана встречается как `Display Power: state=`,
 * `mScreenOn=` и старое `mScreenState=`.
 *
 * @param {string} text
 * @returns {{awake: boolean|null, screenOn: boolean|null, wakefulness: string|null}}
 */
export function parsePowerState(text) {
  const source = String(text || '');

  let awake = null;
  let wakefulness = null;
  const wakeMatch = /mWakefulness=(\w+)/.exec(source);
  if (wakeMatch) {
    wakefulness = wakeMatch[1].toLowerCase();
    awake = wakeMatch[1] === 'Awake';
  }

  let screenOn = null;
  const displayState = /Display Power:\s*state=(ON|OFF)/i.exec(source);
  if (displayState) {
    screenOn = displayState[1].toUpperCase() === 'ON';
  } else {
    const screenFlag = /mScreenOn=(true|false)/i.exec(source);
    if (screenFlag) {
      screenOn = screenFlag[1].toLowerCase() === 'true';
    } else {
      const legacyState = /mScreenState=(ON|OFF)/i.exec(source);
      if (legacyState) {
        screenOn = legacyState[1].toUpperCase() === 'ON';
      }
    }
  }

  return { awake, screenOn, wakefulness };
}

/** Состояние питания: спит устройство или нет. */
export async function getPowerState(ip, port = DEFAULT_ADB_PORT, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const result = await adbShell(ip, port, ['dumpsys', 'power'], timeoutMs);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const state = parsePowerState(result.output);
  if (state.awake === null && state.screenOn === null) {
    return { ok: false, error: 'Не удалось разобрать состояние питания' };
  }
  return { ok: true, ...state };
}

/**
 * Усыпить: гасит экран, приложение уходит на паузу, сеть остаётся.
 *
 * Именно KEYCODE_SLEEP, а не POWER: 26 на части ТВ — полноценное выключение,
 * после которого обратно включить его может только тот, кто подошёл вплотную.
 */
export async function sleepDevice(ip, port = DEFAULT_ADB_PORT, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return adbShell(ip, port, ['input', 'keyevent', String(KEYCODE_SLEEP)], timeoutMs);
}

/** Разбудить. Идемпотентно: на уже будущем устройстве ничего не меняется. */
export async function wakeDevice(ip, port = DEFAULT_ADB_PORT, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return adbShell(ip, port, ['input', 'keyevent', String(KEYCODE_WAKEUP)], timeoutMs);
}

/**
 * MAC-адрес устройства из `ip -o link`.
 *
 * Нужен для Wake-on-LAN: на части ТВ сеть в сне отваливается, и будить по
 * ADB уже нечем. Ethernet предпочтительнее Wi-Fi — у приставок на проводе
 * WOL обычно включён прошивкой.
 *
 * @returns {Promise<{ok: boolean, mac?: string|null, error?: string}>}
 */
export async function getDeviceMac(ip, port = DEFAULT_ADB_PORT, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const result = await adbShell(ip, port, ['ip', '-o', 'link'], timeoutMs);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, mac: parseMacAddress(result.output) };
}

/** Разобрать вывод `ip -o link`: предпочитаем eth*, затем wlan*. */
export function parseMacAddress(text) {
  const candidates = [];

  for (const line of String(text || '').split('\n')) {
    const iface = /^\d+:\s*([^:@\s]+)/.exec(line);
    const mac = /link\/ether\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i.exec(line);
    if (!iface || !mac) continue;

    const value = mac[1].toLowerCase();
    if (value === '00:00:00:00:00:00') continue;
    candidates.push({ iface: iface[1], mac: value });
  }

  if (candidates.length === 0) return null;

  const ethernet = candidates.find(candidate => /^eth/i.test(candidate.iface));
  const wifi = candidates.find(candidate => /^wlan/i.test(candidate.iface));
  return (ethernet || wifi || candidates[0]).mac;
}
