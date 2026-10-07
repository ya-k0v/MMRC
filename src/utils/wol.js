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
 * MAC из таблицы ARP хоста.
 *
 * Резерв на случай, если ADB уже недоступен: приставка на проводе видна
 * роутеру/серверу после любого недавнего обмена пакетами.
 *
 * @param {string} ip
 * @returns {string|null}
 */
export function readArpMac(ip) {
  const target = String(ip || '').trim();
  if (!target) return null;

  try {
    const lines = fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1);
    for (const line of lines) {
      const [addr, , , hwType, mac] = line.trim().split(/\s+/);
      if (addr !== target || !mac) continue;
      if (hwType !== '0x1') continue;
      const normalized = normalizeMac(mac);
      if (normalized && !/^0{12}$/.test(normalized)) {
        return mac.toLowerCase();
      }
    }
  } catch (_) {
    // /proc/net/arp недоступен — просто не используем кэш
  }

  return null;
}
