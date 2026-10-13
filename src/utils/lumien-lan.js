/**
 * Вендорский транспорт панелей Lumien **серии Standard (LS)** по LAN
 * (TCP-порт 4664).
 *
 * Панели Lumien Standard (например LS5550SD) управляются короткими ASCII-
 * командами: кадр начинается с `:`, далее ID панели («01»), затем `S` (set)
 * или `G` (get), тип команды и три ASCII-цифры, завершается `CR`. Этот же
 * набор кодов уходит и в RS232, поэтому LAN-порт 4664 принимает идентичные
 * строки (см. «Параметры для управления панелью по RS232 и LAN»).
 *
 * ВАЖНО: это протокол серии Standard. Панели серии Basic (LB3235SDG2 и др.,
 * Android 13) порт 4664 НЕ открывают — у них управление идёт по RS232
 * (38400 8N1, команды вида `k01sA000` / `k01sA001`) и через веб-интерфейс на
 * порту 8081. Для Basic используйте ADB-профиль панели, а не `lan:`-шаги.
 *
 * Отличие от ADB: команда идёт в саму панель, а не в Android. В «Fake Standby»
 * Android продолжает работать, а подсветка управляется именно так — поэтому
 * LAN-команда гасит/поднимает экран независимо от версии Android.
 *
 * @module utils/lumien-lan
 */

import net from 'node:net';
import { createModuleLogger } from './logger.js';

const lanLog = createModuleLogger('lumien-lan');

/** Порт LAN-управления панелей Lumien (совпадает с RS232-протоколом). */
export const LUMIEN_LAN_PORT = 4664;

const LUMIEN_TIMEOUT_MS = 4000;

/** SET-команды панель подтверждает не всегда — ждём ответ лишь короткое время. */
const LUMIEN_SET_GRACE_MS = 300;

const LAN_STEP_PREFIX = 'lan:';

/**
 * Проверить кадр: печатный ASCII без пробелов и управляющих символов. Перевод
 * строки/CR добавляется транспортом, поэтому в шаге их быть не должно.
 */
function isPrintableAscii(text) {
  return /^[\x21-\x7E]+$/.test(text);
}

/**
 * Разобрать шаг профиля вида `lan:<port>:<команда>` либо `lan:<команда>`.
 *
 * Порт необязателен: `lan::01SE0001` — команда `:01SE0001` на порт по
 * умолчанию (4664); `lan:4664::01SE0001` — явный порт. Команда Lumien сама
 * начинается с `:`, отсюда двойное двоеточие.
 *
 * @param {string} step
 * @returns {{port: number, command: string}|null}
 */
export function parseLanStep(step) {
  const text = String(step || '');
  if (!text.startsWith(LAN_STEP_PREFIX)) return null;

  let rest = text.slice(LAN_STEP_PREFIX.length);
  let port = LUMIEN_LAN_PORT;

  const explicitPort = /^(\d{1,5}):/.exec(rest);
  if (explicitPort) {
    port = Number(explicitPort[1]);
    rest = rest.slice(explicitPort[0].length);
  }

  const command = rest.trim();
  if (!command || command[0] !== ':' || command.length < 3 || command.length > 120) return null;
  if (!isPrintableAscii(command)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { port, command };
}

/** Собрать кадр Lumien: убрать хвостовые пробелы и гарантировать ровно один CR. */
export function normalizeLumienCommand(command) {
  const text = String(command || '').replace(/[\r\n]+$/, '').trim();
  return text ? `${text}\r` : '';
}

/**
 * Отправить команду панели Lumien и, если она запрашивающая (`G`), дождаться
 * ответа. Для SET-команд ответ не ждём: панель может молчать, поэтому после
 * короткой паузы считаем команду отправленной.
 *
 * @param {string} host - IP панели
 * @param {string} command - ASCII-кадр, например `:01SE0000`
 * @param {{port?: number, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, reply?: string|null, error?: string}>}
 */
export function sendLumienCommand(host, command, options = {}) {
  const port = options.port || LUMIEN_LAN_PORT;
  const timeoutMs = options.timeoutMs || LUMIEN_TIMEOUT_MS;

  return new Promise(resolve => {
    if (!host) {
      return resolve({ ok: false, error: 'IP адрес устройства не задан' });
    }
    const frame = normalizeLumienCommand(command);
    if (!frame) {
      return resolve({ ok: false, error: 'Пустая команда панели Lumien' });
    }

    const socket = new net.Socket();
    let settled = false;
    let reply = '';
    // byte4 кадра — `S`/`G`: только на запрос состояния панель отвечает.
    const expectReply = frame.length > 3 && frame[3] === 'G';

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      socket.destroy();
      if (result.ok && result.reply) {
        lanLog.debug('Ответ панели Lumien', { host, port, reply: result.reply });
      }
      resolve(result);
    };

    const hardTimer = setTimeout(
      () => finish({ ok: false, error: 'таймаут ответа панели Lumien' }),
      timeoutMs
    );

    socket.on('connect', () => {
      socket.write(frame, error => {
        if (error) return finish({ ok: false, error: error.message });
        if (!expectReply) {
          setTimeout(() => finish({ ok: true, reply: reply.trim() || null }), LUMIEN_SET_GRACE_MS);
        }
      });
    });

    socket.on('data', chunk => {
      reply += chunk.toString('latin1');
      if (reply.includes('\r')) finish({ ok: true, reply: reply.trim() });
    });

    socket.on('timeout', () => finish({ ok: false, error: 'таймаут соединения с панелью Lumien' }));
    socket.on('error', error => finish({ ok: false, error: error.message }));

    if (expectReply) socket.setTimeout(timeoutMs);
    socket.connect(port, host);
  });
}
