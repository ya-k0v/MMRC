/**
 * Фоновое зеркалирование состояния питания «спит/активен»: опрос перетирает
 * хранимое состояние и рассылает devices/power только при реальном изменении;
 * команды питания ставят устройство в «тихую зону», чтобы опрос не откатил
 * результат, записанный в тот же момент.
 */
import { jest } from '@jest/globals';

const {
  pollPowerStates,
  startPowerWatchdog
} = await import('../../src/utils/power-watch.js');
const {
  getStoredPowerAwake,
  setStoredPowerState,
  notePowerCommand
} = await import('../../src/utils/power-control.js');

const TARGET = { deviceId: 'tv1', ip: '192.168.1.10', port: '5555' };

function fakeGetPowerState(awake) {
  return jest.fn(async () => ({ ok: true, awake, screenOn: true }));
}

function emptyIo() {
  return { emit: jest.fn() };
}

afterEach(() => {
  setStoredPowerState('tv1', null);
  setStoredPowerState('tv2', null);
  setStoredPowerState('tv3', null);
  setStoredPowerState('tv4', null);
});

describe('pollPowerStates', () => {
  test('обновляет хранимое состояние и рассылает devices/power при изменении', async () => {
    const io = emptyIo();
    await pollPowerStates([TARGET], {
      io,
      commands: { getPowerState: fakeGetPowerState(true) }
    });

    expect(getStoredPowerAwake('tv1')).toBe(true);
    expect(io.emit).toHaveBeenCalledWith('devices/power', { deviceId: 'tv1', awake: true });
  });

  test('не рассылает, если состояние не изменилось', async () => {
    setStoredPowerState('tv2', true);
    const io = emptyIo();
    await pollPowerStates([{ ...TARGET, deviceId: 'tv2' }], {
      io,
      commands: { getPowerState: fakeGetPowerState(true) }
    });

    expect(getStoredPowerAwake('tv2')).toBe(true);
    expect(io.emit).not.toHaveBeenCalled();
  });

  test('неудачный опрос сохраняет последнее известное состояние', async () => {
    setStoredPowerState('tv3', false);
    const io = emptyIo();
    await pollPowerStates([{ ...TARGET, deviceId: 'tv3' }], {
      io,
      commands: { getPowerState: jest.fn(async () => ({ ok: false, error: 'ADB не отвечает' })) }
    });

    expect(getStoredPowerAwake('tv3')).toBe(false);
    expect(io.emit).not.toHaveBeenCalled();
  });

  test('уважает «тихую зону» после команды питания', async () => {
    setStoredPowerState('tv4', false);
    notePowerCommand('tv4');
    const io = emptyIo();

    await pollPowerStates([{ ...TARGET, deviceId: 'tv4' }], {
      io,
      commands: { getPowerState: fakeGetPowerState(true) },
      respectCommandGuard: true
    });

    expect(getStoredPowerAwake('tv4')).toBe(false);
    expect(io.emit).not.toHaveBeenCalled();
  });

  test('без «тихой зоны» состояние обновляется и после команды', async () => {
    setStoredPowerState('tv4', false);
    notePowerCommand('tv4');
    const io = emptyIo();

    await pollPowerStates([{ ...TARGET, deviceId: 'tv4' }], {
      io,
      commands: { getPowerState: fakeGetPowerState(true) },
      respectCommandGuard: false
    });

    expect(getStoredPowerAwake('tv4')).toBe(true);
    expect(io.emit).toHaveBeenCalledWith('devices/power', { deviceId: 'tv4', awake: true });
  });
});

describe('startPowerWatchdog', () => {
  test('планирует первый опрос, перезапускает цикл и останавливается', async () => {
    const timers = [];
    const registry = {
      setTimeout: jest.fn((callback) => {
        const id = timers.length + 1;
        timers.push({ id, callback });
        return id;
      }),
      clear: jest.fn()
    };
    const getPowerState = fakeGetPowerState(true);
    const io = emptyIo();
    const devices = {
      tv1: { deviceType: 'android', ipAddress: '192.168.1.10', adbPort: '5555' }
    };

    const stop = startPowerWatchdog({
      devices: () => devices,
      io,
      commands: { getPowerState },
      timerRegistry: registry,
      intervalMs: 30000,
      initialDelayMs: 5000
    });

    expect(registry.setTimeout).toHaveBeenCalledTimes(1);
    expect(registry.setTimeout.mock.calls[0][1]).toBe(5000);

    await timers[0].callback(); // первый цикл опроса

    expect(getPowerState).toHaveBeenCalledWith('192.168.1.10', '5555', 8000);
    expect(registry.setTimeout).toHaveBeenCalledTimes(2); // запланирован следующий
    expect(registry.setTimeout.mock.calls[1][1]).toBe(30000);
    expect(io.emit).toHaveBeenCalledWith('devices/power', { deviceId: 'tv1', awake: true });

    stop();
    expect(registry.clear).toHaveBeenCalledTimes(1);
  });

  test('после остановки новые циклы не планируются', async () => {
    const timers = [];
    const registry = {
      setTimeout: jest.fn((callback) => {
        const id = timers.length + 1;
        timers.push({ id, callback });
        return id;
      }),
      clear: jest.fn()
    };
    const devices = {
      tv1: { deviceType: 'android', ipAddress: '192.168.1.10', adbPort: '5555' }
    };

    const stop = startPowerWatchdog({
      devices,
      io: emptyIo(),
      commands: { getPowerState: fakeGetPowerState(false) },
      timerRegistry: registry,
      intervalMs: 30000,
      initialDelayMs: 0
    });

    stop();
    await timers[0].callback();

    expect(registry.setTimeout).toHaveBeenCalledTimes(1); // новый цикл не запланирован
  });
});