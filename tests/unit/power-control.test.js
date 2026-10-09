/**
 * Управление питанием Android-устройств: выбор целей, команды сна/пробуждения
 * и Wake-on-LAN как подстраховка, когда устройство в сне выпало из сети.
 *
 * Все внешние вызовы (ADB, WOL, плеер) подменяются через `commands`, поэтому
 * здесь нет ни настоящего adb, ни сокетов.
 */
import { jest } from '@jest/globals';

const { planPowerTargets, runPowerAction, isAndroidDevice } = await import('../../src/utils/power-control.js');
const { parsePowerState, parseMacAddress } = await import('../../src/utils/adb.js');
const { buildMagicPacket, normalizeMac, parseArpTable, readArpMac } = await import('../../src/utils/wol.js');

const DEVICES = {
  tv1: { deviceType: 'android', ipAddress: '192.168.1.10', adbPort: '5555' },
  tv2: { deviceType: 'android', ipAddress: '192.168.1.11', macAddress: 'AA-BB-CC-DD-EE-FF' },
  tvNoIp: { deviceType: 'android' },
  browser: { deviceType: 'browser', ipAddress: '192.168.1.99' }
};

function fakeCommands(overrides = {}) {
  return {
    sleepDevice: jest.fn(async () => ({ ok: true, output: '' })),
    wakeDevice: jest.fn(async () => ({ ok: true, output: '' })),
    getDeviceMac: jest.fn(async () => ({ ok: true, mac: 'b8:27:eb:12:34:56' })),
    sendWakeOnLan: jest.fn(async () => ({ ok: true })),
    readArpMac: jest.fn(() => null),
    delay: jest.fn(async () => {}),
    launchApp: jest.fn(async () => ({ ok: true })),
    ...overrides
  };
}

describe('planPowerTargets', () => {
  test('без списка id берёт только Android-устройства с IP', () => {
    const { targets, rejected } = planPowerTargets(DEVICES, null);

    expect(targets.map(t => t.deviceId)).toEqual(['tv1', 'tv2']);
    expect(rejected).toEqual([]);
  });

  test('MAC нормализуется к нижнему hex', () => {
    const { targets } = planPowerTargets(DEVICES, null);
    expect(targets.find(t => t.deviceId === 'tv2').mac).toBe('aabbccddeeff');
    expect(targets.find(t => t.deviceId === 'tv1').mac).toBeNull();
  });

  test('явный список объясняет, почему устройство не взято в работу', () => {
    const { targets, rejected } = planPowerTargets(
      DEVICES,
      ['tv1', 'tvNoIp', 'browser', 'ghost', '__proto__']
    );

    expect(targets.map(t => t.deviceId)).toEqual(['tv1']);
    expect(rejected).toEqual([
      { deviceId: 'tvNoIp', error: 'IP адрес устройства не задан' },
      { deviceId: 'browser', error: 'Не Android-устройство' },
      { deviceId: 'ghost', error: 'Устройство не найдено' },
      { deviceId: '__proto__', error: 'Устройство не найдено' }
    ]);
  });

  test('дубликаты id не дают второй цели', () => {
    const { targets } = planPowerTargets(DEVICES, ['tv1', 'tv1', ' tv1 ']);
    expect(targets).toHaveLength(1);
  });

  test('isAndroidDevice принимает тип, платформу и нативный плеер', () => {
    expect(isAndroidDevice({ deviceType: 'android' })).toBe(true);
    expect(isAndroidDevice({ platform: 'Android' })).toBe(true);
    expect(isAndroidDevice({ device_type: 'NATIVE_MEDIAPLAYER' })).toBe(true);
    expect(isAndroidDevice({ deviceType: 'browser', platform: 'Win32' })).toBe(false);
    expect(isAndroidDevice(null)).toBe(false);
  });
});

describe('runPowerAction: сон', () => {
  test('спит через ADB и запоминает MAC, если его раньше не было', async () => {
    const commands = fakeCommands();
    const storeMac = jest.fn(async () => {});

    const outcome = await runPowerAction(
      [{ deviceId: 'tv1', ip: '192.168.1.10', port: '5555', mac: null }],
      'sleep',
      { commands, storeMac, relaunch: true }
    );

    expect(outcome.succeeded).toBe(1);
    expect(outcome.results[0]).toEqual({ deviceId: 'tv1', ok: true, awake: false });
    expect(commands.sleepDevice).toHaveBeenCalledWith('192.168.1.10', '5555', expect.any(Number));
    expect(commands.launchApp).not.toHaveBeenCalled();
    expect(storeMac).toHaveBeenCalledWith('tv1', 'b8:27:eb:12:34:56');
  });

  test('MAC уже известен — лишний ADB-запрос не шлём', async () => {
    const commands = fakeCommands();
    const storeMac = jest.fn(async () => {});

    await runPowerAction(
      [{ deviceId: 'tv2', ip: '192.168.1.11', port: '5555', mac: 'aabbccddeeff' }],
      'sleep',
      { commands, storeMac }
    );

    expect(commands.getDeviceMac).not.toHaveBeenCalled();
    expect(storeMac).not.toHaveBeenCalled();
  });

  test('ADB не ответил — попадает в failed с текстом ошибки', async () => {
    const commands = fakeCommands({
      sleepDevice: jest.fn(async () => ({ ok: false, error: 'adb connect error: timeout' }))
    });

    const outcome = await runPowerAction(
      [{ deviceId: 'tv1', ip: '192.168.1.10', port: '5555', mac: null }],
      'sleep',
      { commands }
    );

    expect(outcome.failed).toBe(1);
    expect(outcome.results[0]).toEqual({ deviceId: 'tv1', ok: false, error: 'adb connect error: timeout' });
  });

  test('без IP цель отклоняется до любых внешних вызовов', async () => {
    const commands = fakeCommands();

    const outcome = await runPowerAction(
      [{ deviceId: 'tvNoIp', ip: null, port: '5555', mac: null }],
      'sleep',
      { commands }
    );

    expect(outcome.failed).toBe(1);
    expect(outcome.results[0].error).toBe('IP адрес устройства не задан');
    expect(commands.sleepDevice).not.toHaveBeenCalled();
  });
});

describe('runPowerAction: пробуждение', () => {
  test('будит по ADB и запускает плеер', async () => {
    const commands = fakeCommands();

    const outcome = await runPowerAction(
      [{ deviceId: 'tv2', ip: '192.168.1.11', port: '5555', mac: 'aabbccddeeff' }],
      'wake',
      { commands }
    );

    expect(outcome.results[0]).toEqual({ deviceId: 'tv2', ok: true, awake: true });
    expect(commands.launchApp).toHaveBeenCalledWith('192.168.1.11', '5555');
  });

  test('relaunch: false — плеер не трогаем', async () => {
    const commands = fakeCommands();

    await runPowerAction(
      [{ deviceId: 'tv2', ip: '192.168.1.11', port: '5555', mac: 'aabbccddeeff' }],
      'wake',
      { commands, relaunch: false }
    );

    expect(commands.launchApp).not.toHaveBeenCalled();
  });

  test('ADB не ответил — шлём Wake-on-LAN и повторяем команду', async () => {
    const commands = fakeCommands({
      wakeDevice: jest.fn()
        .mockResolvedValueOnce({ ok: false, error: 'adb connect error: timeout' })
        .mockResolvedValueOnce({ ok: true, output: '' })
    });

    const outcome = await runPowerAction(
      [{ deviceId: 'tv2', ip: '192.168.1.11', port: '5555', mac: 'aabbccddeeff' }],
      'wake',
      { commands, wolWaitMs: 10 }
    );

    expect(outcome.succeeded).toBe(1);
    expect(commands.sendWakeOnLan).toHaveBeenCalledWith('aabbccddeeff');
    expect(commands.delay).toHaveBeenCalledWith(10);
    expect(commands.wakeDevice).toHaveBeenCalledTimes(2);
  });

  test('MAC неизвестен и в ARP нет — будить нечем', async () => {
    const commands = fakeCommands({
      wakeDevice: jest.fn(async () => ({ ok: false, error: 'adb connect error: timeout' })),
      readArpMac: jest.fn(() => null),
      getDeviceMac: jest.fn(async () => ({ ok: false, error: 'adb connect error: timeout' }))
    });

    const outcome = await runPowerAction(
      [{ deviceId: 'tv1', ip: '192.168.1.10', port: '5555', mac: null }],
      'wake',
      { commands }
    );

    expect(outcome.failed).toBe(1);
    expect(commands.sendWakeOnLan).not.toHaveBeenCalled();
    expect(outcome.results[0].error).toBe('adb connect error: timeout');
  });

  test('проснулось, но плеер не поднялся — ошибка с пометкой awake', async () => {
    const commands = fakeCommands({
      launchApp: jest.fn(async () => ({ ok: false, error: 'activity not found' }))
    });

    const outcome = await runPowerAction(
      [{ deviceId: 'tv2', ip: '192.168.1.11', port: '5555', mac: 'aabbccddeeff' }],
      'wake',
      { commands }
    );

    expect(outcome.failed).toBe(1);
    expect(outcome.results[0].awake).toBe(true);
    expect(outcome.results[0].error).toContain('плеер не запустился');
  });

  test('смешанный результат: succeeded и failed считаются по-разному', async () => {
    const commands = fakeCommands({
      wakeDevice: jest.fn(async (ip) => ip === '192.168.1.10'
        ? { ok: false, error: 'timeout' }
        : { ok: true, output: '' }),
      readArpMac: jest.fn(() => null),
      getDeviceMac: jest.fn(async () => ({ ok: false, error: 'timeout' }))
    });

    const outcome = await runPowerAction(
      [
        { deviceId: 'tv1', ip: '192.168.1.10', port: '5555', mac: null },
        { deviceId: 'tv2', ip: '192.168.1.11', port: '5555', mac: 'aabbccddeeff' }
      ],
      'wake',
      { commands }
    );

    expect(outcome.succeeded).toBe(1);
    expect(outcome.failed).toBe(1);
  });

  test('неизвестная команда отклоняется до любых вызовов', async () => {
    const commands = fakeCommands();
    await expect(runPowerAction([], 'reboot', { commands })).rejects.toThrow('Неизвестная команда');
  });
});

describe('runPowerAction: перезапуск плеера', () => {
  test('launch убивает старый процесс и поднимает новый через launchApp', async () => {
    const commands = fakeCommands();

    const outcome = await runPowerAction(
      [{ deviceId: 'tv1', ip: '192.168.1.10', port: '5555', mac: null }],
      'launch',
      { commands }
    );

    expect(outcome.succeeded).toBe(1);
    expect(outcome.results[0]).toEqual({ deviceId: 'tv1', ok: true });
    expect(commands.launchApp).toHaveBeenCalledWith('192.168.1.10', '5555');
    expect(commands.wakeDevice).not.toHaveBeenCalled();
    expect(commands.sleepDevice).not.toHaveBeenCalled();
  });

  test('launch не трогает режим питания и не запоминает MAC', async () => {
    const commands = fakeCommands();
    const storeMac = jest.fn(async () => {});

    const outcome = await runPowerAction(
      [{ deviceId: 'tv1', ip: '192.168.1.10', port: '5555', mac: null }],
      'launch',
      { commands, storeMac }
    );

    expect(commands.getDeviceMac).not.toHaveBeenCalled();
    expect(storeMac).not.toHaveBeenCalled();
    expect(outcome.results[0].awake).toBeUndefined();
  });

  test('ADB не ответил — результат в failed с текстом ошибки', async () => {
    const commands = fakeCommands({
      launchApp: jest.fn(async () => ({ ok: false, error: 'adb shell error: timeout' }))
    });

    const outcome = await runPowerAction(
      [{ deviceId: 'tv1', ip: '192.168.1.10', port: '5555', mac: null }],
      'launch',
      { commands }
    );

    expect(outcome.failed).toBe(1);
    expect(outcome.results[0].error).toBe('adb shell error: timeout');
    expect(outcome.results[0].awake).toBeUndefined();
  });
});

describe('parsePowerState', () => {
  test('современный dumpsys power: бодрствует и экран включён', () => {
    const state = parsePowerState('mWakefulness=Awake\nDisplay Power: state=ON');
    expect(state).toEqual({ awake: true, screenOn: true, wakefulness: 'awake' });
  });

  test('спящее устройство', () => {
    const state = parsePowerState('mWakefulness=Asleep\nDisplay Power: state=OFF');
    expect(state.awake).toBe(false);
    expect(state.screenOn).toBe(false);
  });

  test('Dozing считается сном, а не бодрствованием', () => {
    expect(parsePowerState('mWakefulness=Dozing').awake).toBe(false);
  });

  test('старые сборки: только mScreenState', () => {
    const state = parsePowerState('mScreenState=ON');
    expect(state).toEqual({ awake: null, screenOn: true, wakefulness: null });
  });

  test('мусорный вывод даёт null, а не ложный Awake', () => {
    expect(parsePowerState('')).toEqual({ awake: null, screenOn: null, wakefulness: null });
    expect(parsePowerState('some unrelated text').awake).toBeNull();
  });
});

describe('parseMacAddress', () => {
  // Формат `ip -o link`: интерфейс и MAC на одной строке.
  const OUTPUT = [
    '1: lo: <LOOPBACK,UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group DEFAULT',
    '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP mode DEFAULT group DEFAULT qlen 1000 link/ether b8:27:eb:12:34:56 brd ff:ff:ff:ff:ff:ff',
    '3: wlan0: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN mode DEFAULT group DEFAULT qlen 1000 link/ether 00:11:22:33:44:55 brd ff:ff:ff:ff:ff:ff'
  ].join('\n');

  test('предпочитает Ethernet Wi-Fi', () => {
    expect(parseMacAddress(OUTPUT)).toBe('b8:27:eb:12:34:56');
  });

  test('только Wi-Fi интерфейс — берём его', () => {
    const wifiOnly = '2: wlan0: <UP> mtu 1500 state UP link/ether 00:11:22:33:44:55 brd ff:ff:ff:ff:ff:ff';
    expect(parseMacAddress(wifiOnly)).toBe('00:11:22:33:44:55');
  });

  test('нулевой MAC отбрасывается', () => {
    const zero = '2: eth0: <UP> mtu 1500 state UP link/ether 00:00:00:00:00:00 brd ff:ff:ff:ff:ff:ff';
    expect(parseMacAddress(zero)).toBeNull();
  });

  test('пустой вывод — null', () => {
    expect(parseMacAddress('')).toBeNull();
    expect(parseMacAddress(null)).toBeNull();
  });
});

describe('Wake-on-LAN пакет', () => {
  test('формат: 6 × FF + 16 копий MAC', () => {
    const packet = buildMagicPacket('AA:BB:CC:DD:EE:FF');
    expect(packet).toHaveLength(102);
    expect([...packet.subarray(0, 6)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const mac = Buffer.from('aabbccddeeff', 'hex');
    for (let i = 0; i < 16; i++) {
      expect(packet.subarray(6 + i * 6, 12 + i * 6)).toEqual(mac);
    }
  });

  test('разные разделители нормализуются', () => {
    expect(normalizeMac('AA-BB-CC-DD-EE-FF')).toBe('aabbccddeeff');
    expect(normalizeMac('aa.bb.cc.dd.ee.ff')).toBe('aabbccddeeff');
    expect(normalizeMac('aabbccddeeff')).toBe('aabbccddeeff');
    expect(normalizeMac('zz:zz')).toBeNull();
    expect(buildMagicPacket.bind(null, 'nope')).toThrow('Некорректный MAC-адрес');
  });

  test('ARP-таблица: неизвестный адрес и пустой ip дают null', () => {
    expect(readArpMac('')).toBeNull();
    expect(readArpMac('203.0.113.77')).toBeNull();
  });

  test('parseArpTable берёт MAC из правильной колонки', () => {
    const table = [
      'IP address       HW type     Flags       HW address            Mask     Device',
      '10.172.1.94      0x1         0x2         00:ef:00:1b:08:5f     *        eth2',
      '10.172.1.95      0x1         0x0         00:00:00:00:00:00     *        eth2'
    ].join('\n');

    expect(parseArpTable(table, '10.172.1.94')).toBe('00:ef:00:1b:08:5f');
    expect(parseArpTable(table, '10.172.1.95')).toBeNull();
    expect(parseArpTable(table, '10.0.0.9')).toBeNull();
  });
});
