/**
 * Определение состояния командой профиля (`sleepDetect: 'custom'`).
 * LAN-ветка проверяется на локальном TCP-сервере вместо настоящей панели.
 */
import net from 'node:net';

const { queryCustomPowerState } = await import('../../src/utils/power-control.js');

function panelServer(reply) {
  return new Promise(resolve => {
    const server = net.createServer(socket => {
      socket.on('data', () => {
        if (reply !== null) socket.write(`:01GE${reply}\r`);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

describe('queryCustomPowerState', () => {
  test('пустая команда — ошибка', async () => {
    const result = await queryCustomPowerState('127.0.0.1', '5555', '  ', 'true', 1000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/не задана/);
  });

  test('некорректный lan-шаг — ошибка', async () => {
    const result = await queryCustomPowerState('127.0.0.1', '5555', 'lan:not-a-frame', 'true', 1000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/LAN-шаг/);
  });

  test('lan: ответ без образца — активен', async () => {
    const { server, port } = await panelServer('001');
    const result = await queryCustomPowerState('127.0.0.1', null, `lan:${port}::01GE000`, 'E000', 1000);
    server.close();

    expect(result.ok).toBe(true);
    expect(result.awake).toBe(true);
  });

  test('lan: образец найден в ответе — спит', async () => {
    const { server, port } = await panelServer('E000');
    const result = await queryCustomPowerState('127.0.0.1', null, `lan:${port}::01GE000`, 'E000', 1000);
    server.close();

    expect(result.ok).toBe(true);
    expect(result.awake).toBe(false);
    expect(result.output).toMatch(/E000/);
  });
});