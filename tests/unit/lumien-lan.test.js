/**
 * Вендорский LAN-транспорт Lumien: разбор шага `lan:`, сборка кадра и отправка
 * по TCP 4664 (поднимаем локальный сервер вместо настоящей панели).
 */
import net from 'node:net';

const {
  parseLanStep,
  normalizeLumienCommand,
  sendLumienCommand,
  LUMIEN_LAN_PORT
} = await import('../../src/utils/lumien-lan.js');

describe('parseLanStep', () => {
  test('команда без порта идёт на порт по умолчанию', () => {
    expect(parseLanStep('lan::01SE0001')).toEqual({ port: LUMIEN_LAN_PORT, command: ':01SE0001' });
  });

  test('явный порт отделяется первым двоеточием', () => {
    expect(parseLanStep('lan:5555::01S0000')).toEqual({ port: 5555, command: ':01S0000' });
  });

  test('не-lan и пустые команды отклоняются', () => {
    expect(parseLanStep('cmd:power sleep')).toBeNull();
    expect(parseLanStep('lan:')).toBeNull();
    expect(parseLanStep('lan::')).toBeNull();
    expect(parseLanStep('lan::01SE 0001')).toBeNull();
  });
});

describe('normalizeLumienCommand', () => {
  test('добавляет ровно один CR', () => {
    expect(normalizeLumienCommand(':01SE0001')).toBe(':01SE0001\r');
  });

  test('повторный CR не дублируется', () => {
    expect(normalizeLumienCommand(':01SE0001\r')).toBe(':01SE0001\r');
    expect(normalizeLumienCommand(':01SE0001\r\n')).toBe(':01SE0001\r');
  });

  test('пустая команда даёт пустую строку', () => {
    expect(normalizeLumienCommand('')).toBe('');
    expect(normalizeLumienCommand('  ')).toBe('');
  });
});

describe('sendLumienCommand', () => {
  test('без хоста возвращает ошибку, не открывая сокет', async () => {
    await expect(sendLumienCommand('', ':01SE0001')).resolves.toEqual({ ok: false, error: 'IP адрес устройства не задан' });
  });

  test('пустая команда отклоняется', async () => {
    await expect(sendLumienCommand('127.0.0.1', '   ')).resolves.toEqual({ ok: false, error: 'Пустая команда панели Lumien' });
  });

  test('GET-команда дожидается ответа панели', async () => {
    let received = '';
    const server = net.createServer(socket => {
      socket.on('data', chunk => {
        received += chunk.toString('latin1');
        socket.write(':01rE000\r');
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const result = await sendLumienCommand('127.0.0.1', ':01GE000', { port });

    expect(result).toEqual({ ok: true, reply: ':01rE000' });
    expect(received).toBe(':01GE000\r');
    server.close();
  });

  test('SET-команда считается отправленной без ответа', async () => {
    let received = '';
    const server = net.createServer(socket => {
      socket.on('data', chunk => { received += chunk.toString('latin1'); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const result = await sendLumienCommand('127.0.0.1', ':01SE0000', { port });

    expect(result.ok).toBe(true);
    expect(received).toBe(':01SE0000\r');
    server.close();
  });

  test('недоступный порт возвращает ошибку соединения', async () => {
    const result = await sendLumienCommand('127.0.0.1', ':01SE0000', { port: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
