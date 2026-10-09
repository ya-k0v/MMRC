/**
 * Wake-on-LAN для Android-приставок, которые уходят из сети в сне.
 *
 * ADB будит только те устройства, которые ещё отвечают на `adb connect`.
 * Если в сне отвалился Wi-Fi или adbd, остаётся магический пакет по Ethernet.
 *
 * @module utils/wol
 */

import dgram from 'node:dgram';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

export const WOL_BROADCAST = '255.255.255.255';
export const WOL_PORT = 9;

/** `AA-BB-CC`, `AA.BB.CC`, `aabbcc` → `aabbcc`, либо null. */
export function normalizeMac(mac) {
  const hex = String(mac || '').replace(/[^0-9a-fA-F]/g, '');
  return hex.length === 12 ? hex.toLowerCase() : null;
}

/** Магический пакет: 6 × FF + 16 копий MAC. */
export function buildMagicPacket(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) {
    throw new Error('Некорректный MAC-адрес');
  }

  const bytes = Buffer.from(normalized, 'hex');
  const packet = Buffer.alloc(6 + 16 * bytes.length);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    bytes.copy(packet, 6 + i * bytes.length);
  }
  return packet;
}

/**
 * Отправить магический пакет в широковещание.
 *
 * @param {string} mac
 * @param {{broadcast?: string, port?: number, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, mac: string, broadcast: string, port: number}>}
 */
export function sendWakeOnLan(mac, options = {}) {
  const normalized = normalizeMac(mac);
  if (!normalized) {
    return Promise.reject(new Error('Некорректный MAC-адрес'));
  }

  const broadcast = options.broadcast || WOL_BROADCAST;
  const port = options.port || WOL_PORT;
  const timeoutMs = options.timeoutMs || 2000;
  const packet = buildMagicPacket(normalized);

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch (_) {
        // сокет уже закрыт
      }
      if (error) {
        reject(error);
        return;
      }
      resolve({ ok: true, mac: normalized, broadcast, port });
    };

    const timer = setTimeout(() => finish(new Error('Wake-on-LAN: таймаут отправки')), timeoutMs);

    socket.once('error', finish);

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (error) {
        finish(error);
        return;
      }
      socket.send(packet, port, broadcast, (error) => finish(error));
    });
  });
}

/**
 * Разобрать таблицу `/proc/net/arp`.
 *
 * Возвращает MAC для `ip` (в исходном регистре, как в таблице) или null.
 *
 * @param {string} text
 * @param {string} ip
 * @returns {string|null}
 */
export function parseArpTable(text, ip) {
  const target = String(ip || '').trim();
  if (!target) return null;

  // Формат /proc/net/arp: ip hwtype flags mac mask device
  for (const line of String(text || '').split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    const addr = parts[0];
    const hwType = parts[1];
    const mac = parts[3];
    if (addr !== target || !mac) continue;
    if (hwType !== '0x1') continue;
    const normalized = normalizeMac(mac);
    if (normalized && !/^0{12}$/.test(normalized)) {
      return mac.toLowerCase();
    }
  }

  return null;
}

/**
 * MAC из таблицы ARP хоста (в контексте текущего процесса).
 *
 * @param {string} ip
 * @returns {string|null}
 */
export function readArpMac(ip) {
  const target = String(ip || '').trim();
  if (!target) return null;

  try {
    return parseArpTable(fs.readFileSync('/proc/net/arp', 'utf8'), target);
  } catch (_) {
    // /proc/net/arp недоступен — просто не используем кэш
  }

  return null;
}

// ============================================================================
// WoL из docker-контейнера.
//
// Магический пакет — L2-broadcast, а сервис mmrc работает в bridge-сети
// (mmrc-network). Broadcast из namespace контейнера уходит только в docker
// bridge и никогда не доходит до физического LAN, где стоят приставки.
// Поэтому в docker-развёртывании пакет (и чтение настоящей ARP-таблицы хоста)
// выполняем одноразовым контейнером с `--network host` через смонтированный
// docker.sock. Для локального запуска без docker всё работает как раньше.
// ============================================================================

const DOCKER_SOCKET = '/var/run/docker.sock';
const WOL_HELPER_TIMEOUT_MS = 8000;

/** Скрипт хелпера: `node -e` в контейнере с host-сетью отправляет пакет. */
const WOL_HELPER_SCRIPT = [
  "const dgram = require('node:dgram');",
  "const mac = String(process.argv[1] || '').replace(/[^0-9a-fA-F]/g, '');",
  "const port = Number(process.argv[2]) || 9;",
  "const broadcast = process.argv[3] || '255.255.255.255';",
  "const bytes = Buffer.from(mac, 'hex');",
  "if (bytes.length !== 6) process.exit(2);",
  "const packet = Buffer.alloc(6 + 16 * bytes.length);",
  "packet.fill(0xff, 0, 6);",
  "for (let i = 0; i < 16; i += 1) bytes.copy(packet, 6 + i * bytes.length);",
  "const socket = dgram.createSocket('udp4');",
  "socket.on('error', () => process.exit(1));",
  "socket.bind(() => {",
  "  try { socket.setBroadcast(true); } catch { process.exit(1); }",
  "  socket.send(packet, port, broadcast, (err) => { socket.close(); process.exit(err ? 1 : 0); });",
  "});"
].join('\n');

/** Находимся ли мы в docker-развёртывании, где нужен хост-хелпер. */
export function shouldUseHostWol() {
  const forced = String(process.env.MMRC_WOL_VIA_HOST || '').toLowerCase();
  if (forced === 'false' || forced === '0') return false;
  if (forced === 'true' || forced === '1') return true;
  if (process.env.MMRC_DOCKER !== '1') return false;

  try {
    return fs.existsSync(DOCKER_SOCKET);
  } catch {
    return false;
  }
}

/** Образ для одноразового хелпера (тот же, что у работающего сервиса). */
function hostHelperImage() {
  const image = process.env.DOCKER_IMAGE || process.env.MMRC_IMAGE;
  if (!image) return null;
  const tag = process.env.DOCKER_IMAGE_TAG || process.env.DOCKER_TAG;
  return tag ? `${image}:${tag}` : image;
}

function runDocker(args, timeoutMs = WOL_HELPER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || '').trim();
        reject(new Error(message || 'docker helper failed'));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

/**
 * Отправить магический пакет через контейнер с host-сетью.
 *
 * @param {string} mac
 * @param {{port?: number, broadcast?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, mac: string, port: number, broadcast: string}>}
 */
export async function sendWakeOnLanFromHost(mac, options = {}) {
  const normalized = normalizeMac(mac);
  if (!normalized) throw new Error('Некорректный MAC-адрес');

  const image = hostHelperImage();
  if (!image) {
    throw new Error('Не задан образ для WoL-хелпера (DOCKER_IMAGE/DOCKER_IMAGE_TAG)');
  }

  const port = options.port || WOL_PORT;
  const broadcast = options.broadcast || WOL_BROADCAST;

  await runDocker([
    'run', '--rm', '--network', 'host',
    '--entrypoint', 'node',
    image,
    '-e', WOL_HELPER_SCRIPT,
    normalized, String(port), broadcast
  ], options.timeoutMs);

  return { ok: true, mac: normalized, port, broadcast };
}

/** MAC из ARP-таблицы хоста (в docker — через хелпер с host-сетью). */
export async function readHostArpMac(ip) {
  const target = String(ip || '').trim();
  if (!target) return null;
  if (!shouldUseHostWol()) return readArpMac(target);

  const image = hostHelperImage();
  if (!image) return readArpMac(target);

  try {
    const stdout = await runDocker([
      'run', '--rm', '--network', 'host',
      '--entrypoint', 'cat',
      image, '/proc/net/arp'
    ]);
    return parseArpTable(stdout, target);
  } catch {
    return null;
  }
}

/** Отправить WoL: в docker — через host-хелпер, иначе — локально. */
export function sendWakeOnLanAuto(mac, options = {}) {
  if (shouldUseHostWol()) {
    return sendWakeOnLanFromHost(mac, options);
  }
  return sendWakeOnLan(mac, options);
}
