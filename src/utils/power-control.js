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
  rebootDevice,
  wakeKey,
  getDeviceMac,
  getPowerState,
  launchAndroidApp,
  isAndroidDevice,
  setWifiSleepPolicy,
  setStayAwakeWhilePluggedIn,
  getDeviceInfo,
  KEYCODE_SLEEP,
  KEYCODE_WAKEUP
} from './adb.js';
import { sendWakeOnLanAuto, readHostArpMac, normalizeMac, wolBroadcastAddresses } from './wol.js';
import { parseLanStep, sendLumienCommand } from './lumien-lan.js';
import { ANDROID_PACKAGE_NAME, ANDROID_MAIN_ACTIVITY } from '../config/android.js';
import { isReservedObjectKey } from './sanitize.js';
import { createModuleLogger } from './logger.js';
import { resolvePowerProfile } from './power-profiles.js';

const powerLog = createModuleLogger('power');

export const POWER_ACTIONS = ['sleep', 'wake', 'launch', 'reboot'];

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
 * @returns {{targets: Array<{deviceId: string, ip: string, port: string|null, mac: string|null, model: string|null}>, rejected: Array<{deviceId: string, error: string}>}}
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
    mac: normalizeMac(device.macAddress) || null,
    model: device.model || null,
    android: device.android || null
  };
}

/**
 * Подготовить Android-устройство ко сну:
 *  - Wi-Fi не отключать, чтобы adbd по сети дожил до пробуждения;
 *  - снять `stay_on_while_plugged_in` — рекламные панели (Lumien и т.п.)
 *    держат экран включённым на питании, и `KEYCODE_SLEEP` тогда не гасит
 *    подсветку вовсе.
 *
 * Лучшие усилия: если одна команда упала, вторую всё равно шлём, а сон затем
 * выполняется как обычно.
 */
async function prepareForSleep(ip, port) {
  const policy = await setWifiSleepPolicy(ip, port || null, '2');
  const stayOn = await setStayAwakeWhilePluggedIn(ip, port || null, '0');
  return policy && policy.ok === false ? policy : stayOn;
}

/** Внешние команды: подменяются в тестах. */
export const DEFAULT_POWER_COMMANDS = {
  sleepDevice,
  wakeDevice,
  wakeKey,
  getDeviceMac,
  getPowerState,
  getDeviceInfo,
  sendWakeOnLan: sendWakeOnLanAuto,
  readArpMac: readHostArpMac,
  sendLanCommand: sendLumienCommand,
  delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  launchApp: async (ip, port) => launchAndroidApp(ip, ANDROID_PACKAGE_NAME, ANDROID_MAIN_ACTIVITY, port),
  rebootDevice,
  prepareForSleep
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

/** Порты WoL: шлём на все (`POWER_WOL_PORTS="9,7"`). */
const WOL_PORTS = envList('POWER_WOL_PORTS', ['9', '7']).map(Number).filter(Number.isFinite);

/** Человекочитаемый вид ступени: KEYCODE как `keyevent N`, строковые шаги как есть. */
function stepLabel(step) {
  return typeof step === 'number' ? `keyevent ${Number(step)}` : String(step);
}

/**
 * Выполнить одну ступень профиля: обычные шаги идут по ADB, а `lan:`-шаги —
 * напрямую в панель Lumien по TCP (см. lumien-lan). Вендор-команда не зависит
 * от Android и работает, пока панель в сети (в т.ч. в «Fake Standby»).
 */
async function sendPowerStep(commands, ip, port, step, adbTimeoutMs) {
  if (typeof step === 'string' && step.startsWith('lan:')) {
    const parsed = parseLanStep(step);
    if (!parsed) return { ok: false, error: 'Некорректный LAN-шаг панели' };
    if (typeof commands.sendLanCommand !== 'function') {
      return { ok: false, error: 'LAN-транспорт недоступен' };
    }
    return commands.sendLanCommand(ip, parsed.command, { port: parsed.port });
  }
  return commands.wakeKey(ip, port, step, adbTimeoutMs);
}

/**
 * Если о модели/версии Android ничего не известно (свежий старт, панель ещё
 * не открывали), доопределяем их одним дозвоном по ADB, чтобы выбрать
 * правильный профиль питания. Лучшие усилия: команда недоступна или упала —
 * работаем по дефолту.
 */
async function ensurePowerBasis(target, commands, adbTimeoutMs) {
  if (target.model || target.android) return;
  if (typeof commands.getDeviceInfo !== 'function') return;
  try {
    const info = await commands.getDeviceInfo(target.ip, target.port || null, adbTimeoutMs);
    if (info && info.ok) {
      target.model = info.model || null;
      target.android = info.android || null;
    }
  } catch (error) {
    powerLog.warn('Не удалось определить модель/версию Android', { deviceId: target.deviceId, error: error.message });
  }
}

/**
 * Выполнить команду питания на всех целях параллельно.
 *
 * Сон: сначала включается «Wi-Fi во сне не отключать» (`wifi_sleep_policy=2`),
 * чтобы ТВ не выпал из сети, затем `KEYCODE_SLEEP`. Пробуждение — универсальная
 * лестница: пробуем клавиши (`WAKEUP → POWER → TV_POWER`, последовательность
 * настраивается через `POWER_WAKE_KEYCODES`), каждую проверяя по `dumpsys
 * power`; если ADB в сне потерялся либо клавиши не подняли экран — шлём
 * Wake-on-LAN (порты из `POWER_WOL_PORTS`, по умолчанию 9 и 7; адрес —
 * подсетевой broadcast и глобальный) и повторяем клавиши. И только после
 * успешного пробуждения (если `relaunch`) поднимаем плеер, чтобы экран не
 * остался с чужим приложением, а затем (лучшие усилия) удерживаем экран
 * бодрствующим (`keepAwake` профиля).
 *
 * Акция `launch` — перезапуск плеера без сна/пробуждения: провайдер убивает
 * старый процесс приложения и запускает новый (см. adb.launchAndroidApp).
 * Режим питания при этом не меняется, поэтому в результате нет поля `awake`.
 *
 * @param {Array<{deviceId: string, ip: string, port?: string|null, mac?: string|null, model?: string|null}>} targets
 * @param {'sleep'|'wake'|'launch'|'reboot'} action
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

    // Для сна/пробуждения важно знать профиль заранее: если модель и версия
    // Android неизвестны (свежий старт), доопределяем их одним дозвоном.
    // Для перезагрузки/перезапуска плеера профиль не нужен.
    if (action !== 'launch' && action !== 'reboot') {
      await ensurePowerBasis(target, commands, adbTimeoutMs);
    }

    if (action === 'launch') {
      // Перезапуск плеера: старый процесс гасится и поднимается новый.
      // Спящее/бодрствующее состояние не трогаем.
      const launch = await commands.launchApp(ip, port);
      if (!launch.ok) {
        return { deviceId, ok: false, error: launch.error || 'ADB не отвечает' };
      }
      return { deviceId, ok: true };
    }

    if (action === 'reboot') {
      // Перезагрузка: устройство уйдёт в офлайн и вернётся само. Режим
      // питания не трогаем — кэш обновится при следующем опросе состояния.
      const reboot = await commands.rebootDevice(ip, port, adbTimeoutMs);
      if (!reboot.ok) {
        return { deviceId, ok: false, error: reboot.error || 'ADB не отвечает' };
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

      // Ступени сна из профиля устройства (по версии Android/модели).
      // Дефолт — один KEYCODE_SLEEP (как раньше, без лишних проверок).
      // У профилей с несколькими ступенями проверяем экран после каждой:
      // если уже погас — дальше не шлём.
      const profile = resolvePowerProfile(target);
      const steps = profile.sleep;
      let slept = false;
      let lastError = null;
      powerLog.info(`Сон: профиль «${profile.label}», ступени ${steps.map(stepLabel).join(' → ')}`, { deviceId, model: target.model, android: target.android });
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        powerLog.info('Сон: отправляю шаг', { deviceId, step: stepLabel(step) });
        const result = step === KEYCODE_SLEEP
          ? await commands.sleepDevice(ip, port, adbTimeoutMs)
          : await sendPowerStep(commands, ip, port, step, adbTimeoutMs);
        if (!result.ok) {
          if (typeof step === 'number') {
            // KEYCODE упал — устройство потеряно, дальше шлём что-либо бессмысленно.
            return { deviceId, ok: false, error: result.error || 'ADB не отвечает' };
          }
          // Строковые шаги (svc/cmd/settings) — «лучшие усилия»: не поддержаны
          // прошивкой? Пропускаем, надёжность даёт следующая ступень или проверка.
          powerLog.warn('Сон: шаг не поддержан — пропускаем', { deviceId, step: stepLabel(step), error: result.error });
          continue;
        }
        lastError = null;

        if (steps.length > 1) {
          // Даём экрану погаснуть и проверяем реальный результат; если state
          // разобрать не вышло (null) — считаем сон успешным.
          await commands.delay(WOL_RETRY_DELAY_MS);
          const awake = await isReallyAwake(commands, ip, port, adbTimeoutMs);
          powerLog.debug('Сон: проверка экрана после шага', { deviceId, step: stepLabel(step), awake });
          if (awake !== true) {
            slept = true;
            break;
          }
          lastError = 'экран не погас';
        }
      }
      if (steps.length > 1 && !slept) {
        powerLog.warn('Сон: экран так и не погас', { deviceId, error: lastError });
      }
      await rememberMac(target, commands, adbTimeoutMs, storeMac);
      return { deviceId, ok: true, awake: false };
    }

    const wake = await wakeTarget(target, { commands, adbTimeoutMs, wolWaitMs });

    if (!wake.ok) {
      return { deviceId, ok: false, error: wake.error || 'ADB не отвечает' };
    }

    // Удержание экрана после пробуждения: скринсейвер/таймаут гасят подсветку
    // отдельно от сна и сбрасываются перезагрузкой. Лучшие усилия — не влияет
    // на результат пробуждения.
    await applyKeepAwake(target, { commands, adbTimeoutMs, deviceId, port });

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
 * потерялся — шлём WoL на все порты и подсетевой/глобальный broadcast, затем
 * повторяем клавиши.
 *
 * @param {{deviceId: string, ip: string, port: string|null, mac: string|null}} target
 * @param {{commands: Object, adbTimeoutMs: number, wolWaitMs: number}} options
 * @returns {Promise<{ok: boolean, awake?: boolean, error?: string}>}
 */
async function wakeTarget(target, options) {
  const { commands, adbTimeoutMs, wolWaitMs } = options;
  const { deviceId, ip } = target;
  const port = target.port || null;

  // Ступени пробуждения из профиля устройства: дефолт — лестница клавиш
  // (WAKEUP → POWER → TV_POWER), Android 13 — экран через set-screen-state,
  // iconBIT — тоже (устройство не спит, достаточно поднять дисплей).
  const profile = resolvePowerProfile(target);
  const steps = profile.wake;
  powerLog.info(`Пробуждение: профиль «${profile.label}», ступени ${steps.map(stepLabel).join(' → ')}`, { deviceId, model: target.model, android: target.android });

  const ladder = async () => {
    let lastError = null;
    for (const step of steps) {
      powerLog.info('Пробуждение: отправляю шаг', { deviceId, step: stepLabel(step) });
      const send = step === KEYCODE_WAKEUP
        ? commands.wakeDevice(ip, port, adbTimeoutMs)
        : sendPowerStep(commands, ip, port, step, adbTimeoutMs);
      const result = await send;

      if (!result.ok) {
        if (typeof step === 'number') {
          // ADB потерял устройство — дальше клавиши бессмысленны, только WoL.
          return { ok: false, awake: null, error: result.error || 'ADB не отвечает' };
        }
        // Строковый шаг не поддержан прошивкой — пробуем следующую ступень.
        powerLog.warn('Пробуждение: шаг не поддержан — пропускаем', { deviceId, step: stepLabel(step), error: result.error });
        continue;
      }

      lastError = null;
      // Даём экрану реально загореться, прежде чем проверять: в «Fake Standby»
      // панелей OS уже бодрствует, а подсветка поднимается не мгновенно, иначе
      // быстрая проверка ошиблась бы и мы отправили POWER в живой экран.
      await commands.delay(WOL_RETRY_DELAY_MS);
      const awake = await isReallyAwake(commands, ip, port, adbTimeoutMs);
      powerLog.debug('Пробуждение: проверка экрана после шага', { deviceId, step: stepLabel(step), awake });
      if (awake !== false) {
        // awake === true — экран поднялся. awake === null — разобрать состояние
        // не вышло, считаем шаг сработавшим (как раньше), но дальше не шлём:
        // на уже бодрствующем устройстве POWER просто потушит экран.
        powerLog.info('Пробуждение сработало', { deviceId, step, via: typeof step === 'string' ? 'svc' : 'keyevent' });
        return { ok: true, awake: true };
      }
      // Ступень выполнилась, но экран не поднялся — пробуем следующую.
      lastError = 'клавиши не подняли экран';
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
    const addresses = wolBroadcastAddresses(ip);
    for (const wolPort of WOL_PORTS) {
      for (const broadcast of addresses) {
        await commands.sendWakeOnLan(mac, { port: wolPort, broadcast });
      }
      await commands.delay(wolWaitMs);
    }
  } catch (error) {
    return { ok: first.ok, awake: first.awake, error: `${first.error || 'ADB не отвечает'} / Wake-on-LAN: ${error.message}` };
  }

  const after = await ladder();
  return after.ok ? after : { ok: false, awake: after.awake, error: after.error || first.error || 'ADB не отвечает' };
}

/**
 * Удержать экран бодрствующим после успешного пробуждения (лучшие усилия).
 *
 * Скринсейвер (Daydream/Ambient Mode) и таймаут экрана — отдельные от сна
 * подсистемы: панель может «заснуть» даже на бодрствующем устройстве. Команды
 * удержания профиля выполняем по порядку, ошибки глотаем: они не должны ломать
 * уже состоявшееся пробуждение.
 */
async function applyKeepAwake(target, { commands, adbTimeoutMs, deviceId, port }) {
  const profile = resolvePowerProfile(target);
  const steps = profile.keepAwake || [];
  if (!steps.length) return;
  powerLog.info(`Удержание экрана: профиль «${profile.label}», ступени ${steps.map(stepLabel).join(' → ')}`, { deviceId });
  for (const step of steps) {
    try {
      const result = await sendPowerStep(commands, target.ip, port, step, adbTimeoutMs);
      if (result && result.ok === false) {
        powerLog.warn('Удержание: шаг не выполнен', { deviceId, step: stepLabel(step), error: result.error });
      }
    } catch (error) {
      powerLog.warn('Удержание: ошибка шага', { deviceId, step: stepLabel(step), error: error.message });
    }
  }
}

/**
 * Реально ли устройство проснулось: true/false, или null, если проверить нельзя.
 *
 * Смотрим на состояние экрана (screenOn / mHoldingDisplay), а не только на
 * mWakefulness: у панелей с «Fake Standby» OS остаётся бодрствующей, а подсветка
 * выключена — по одному mWakefulness такой экран выглядел бы включённым.
 * Где экранного маркера нет — откатываемся на mWakefulness (обычные приставки).
 */
async function isReallyAwake(commands, ip, port, adbTimeoutMs) {
  if (!commands.getPowerState) return null;
  try {
    const state = await commands.getPowerState(ip, port || null, adbTimeoutMs);
    if (!state || !state.ok) return null;
    if (state.screenOn !== null && state.screenOn !== undefined) {
      return !!state.screenOn;
    }
    if (state.awake === null) return null;
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

/**
 * Проверка одного шага конструктора профилей на живом устройстве.
 *
 * Отправляет шаг как есть (keyevent для чисел, `adb shell …` для строк),
 * даёт экрану отреагировать и смотрит реальный результат по `dumpsys power`.
 * Для фазы `sleep` шаг считается удачным, если экран не горит (`awake !== true`,
 * неизвестное состояние тоже засчитывается — как в обычном сне); для `wake`,
 * наоборот, удачен, если экран поднялся (`awake !== false`).
 *
 * Против «чуда» KEYCODE_POWER на уже бодрствующем устройстве (он усыпит монитор
 * вместо теста) предупреждает интерфейс, здесь это чистое выполнение шага.
 *
 * @param {Object} params
 * @param {{deviceId: string, ip: string, port?: string|null}} params.target
 * @param {number|string} params.step
 * @param {'sleep'|'wake'} [params.phase]
 * @param {Object} [params.commands]
 * @param {number} [params.adbTimeoutMs]
 * @param {number} [params.waitMs]
 * @returns {Promise<{ok: boolean, awake?: boolean|null, step: string, phase: string, error?: string}>}
 */
export async function testPowerStep({
  target,
  step,
  phase = 'wake',
  commands = DEFAULT_POWER_COMMANDS,
  adbTimeoutMs = ADB_TIMEOUT_MS,
  waitMs = WOL_RETRY_DELAY_MS
}) {
  const { deviceId, ip } = target || {};
  if (!ip) {
    return { ok: false, step: stepLabel(step), phase, error: 'IP адрес устройства не задан' };
  }
  const port = target.port || null;
  const phaseSlug = phase === 'sleep' ? 'sleep' : 'wake';

  try {
    const result = await sendPowerStep(commands, ip, port, step, adbTimeoutMs);
    if (!result.ok) {
      return { ok: false, step: stepLabel(step), phase: phaseSlug, error: result.error || 'ADB не отвечает' };
    }
    await commands.delay(waitMs);
    const awake = await isReallyAwake(commands, ip, port, adbTimeoutMs);
    const good = phaseSlug === 'sleep' ? awake !== true : awake !== false;
    return { ok: good, awake, step: stepLabel(step), phase: phaseSlug };
  } catch (error) {
    return { ok: false, step: stepLabel(step), phase: phaseSlug, error: error.message };
  }
}
