/**
 * TCP-проверка доступности устройства до любого вызова ADB.
 *
 * ADB спавнит отдельный процесс, который при недоступном хосте может висеть
 * десятки секунд. Поэтому перед ADB проверяем, отвечает ли `IP:PORT` — если
 * порт молчит, ADB не запускаем вообще.
 *
 * @module utils/tcp-probe
 */

import net from 'node:net';

const CACHE_TTL_MS = 2000;

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const PROBE_TIMEOUT_MS = envInt('ADB_PROBE_TIMEOUT_MS', 500);

/** Включена ли TCP-проверка (`ADB_PROBE_ENABLED=0` отключает). */
export function isProbeEnabled() {
  return process.env.ADB_PROBE_ENABLED !== '0';
}

const cache = new Map();

/**
 * Проверить, открыт ли TCP-порт `host:port`.
 *
 * Сокет гарантированно закрывается во всех ветках (connect/error/timeout),
 * поэтому сама проверка не оставляет висящих соединений. Короткий кэш гасит
 * повторные пробы подряд идущих команд.
 *
 * @param {string} host
 * @param {string|number} port
 * @param {{timeoutMs?: number, useCache?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
export function probeTcp(host, port, options = {}) {
  const { timeoutMs = PROBE_TIMEOUT_MS, useCache = true } = options;

  return new Promise((resolve) => {
    if (!host || !port) {
      resolve(false);
      return;
    }

    const key = `${host}:${port}`;
    if (useCache) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        resolve(hit.reachable);
        return;
      }
    }

    let settled = false;
    let timer = null;
    const socket = net.connect({ host, port: Number(port) });

    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      cache.set(key, { reachable, at: Date.now() });
      resolve(reachable);
    };

    timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Проверка с учётом `ADB_PROBE_ENABLED`: при выключенной проверке считаем
 * устройство доступным и не мешаем обычной работе.
 *
 * @param {string} host
 * @param {string|number} port
 * @returns {Promise<boolean>}
 */
export function checkReachable(host, port) {
  if (!isProbeEnabled()) return Promise.resolve(true);
  return probeTcp(host, port);
}

/** Сбросить кэш проб (тесты и переподключение к сети). */
export function resetProbeCache() {
  cache.clear();
}
