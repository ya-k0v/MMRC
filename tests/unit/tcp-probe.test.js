/**
 * TCP-проба доступности: проверяем, что проба честно отвечает на открытый и
 * закрытый порт, не висит и учитывает выключатель ADB_PROBE_ENABLED.
 */
import { jest } from '@jest/globals';
import net from 'node:net';

const { probeTcp, checkReachable } = await import('../../src/utils/tcp-probe.js');

function listen() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('открытый порт отвечает true', async () => {
  const server = await listen();
  const port = server.address().port;

  await expect(probeTcp('127.0.0.1', port, { timeoutMs: 300, useCache: false })).resolves.toBe(true);

  await close(server);
});

test('недостижимый адрес отвечает false по таймауту', async () => {
  // TEST-NET-1 (RFC 5737) — заведомо не маршрутизируемый адрес.
  await expect(probeTcp('192.0.2.1', 5555, { timeoutMs: 200, useCache: false })).resolves.toBe(false);
});

test('checkReachable при ADB_PROBE_ENABLED=0 не блокирует работу', async () => {
  process.env.ADB_PROBE_ENABLED = '0';
  try {
    await expect(checkReachable('192.0.2.1', 5555)).resolves.toBe(true);
  } finally {
    delete process.env.ADB_PROBE_ENABLED;
  }
});
