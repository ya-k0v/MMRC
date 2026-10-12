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
const { resetReachability, markOffline } = await import('../../src/utils/device-reachability.js');

const TARGET = { deviceId: 'tv1', ip: '192.168.1.10', port: '5555' };

const reachable = async () => true;

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
  resetReachability();
});

describe('pollPowerStates', () => {
  test('обновляет хранимое состояние и рассылает devices/power при изменении', async () => {
    const io = emptyIo();
    await pollPowerStates([TARGET], {
      io,
      probe: reachable,
      commands: { getPowerState: fakeGetPowerState(true) }
    });

    expect(getStoredPowerAwake('tv1')).toBe(true);
    expect(io.emit).toHaveBeenCalledWith('devices/power', { deviceId: 'tv1', awake: true });
  });

  test('«Fake Standby»: экран выключен, хотя OS бодрствует — бейдж «спит»', async () => {
    const io = emptyIo();
    await pollPowerStates([{ ...TARGET, deviceId: 'tv1' }], {
      io,
      probe: reachable,
      commands: {
        getPowerState: jest.fn(async () => ({ ok: true, awake: true, screenOn: false }))
      }
    });

    expect(getStoredPowerAwake('tv1')).toBe(false);
    expect(io.emit).toHaveBeenCalledWith('devices/power', { deviceId: 'tv1', awake: false });
  });

  test('не рассылает, если состояние не изменилось', async () => {
    setStoredPowerState('tv2', true);
    const io = emptyIo();
    await pollPowerStates([{ ...TARGET, deviceId: 'tv2' }], {
      io,
      probe: reachable,
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
      probe: reachable,
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
      probe: reachable,
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
      probe: reachable,
      commands: { getPowerState: fakeGetPowerState(true) },
      respectCommandGuard: false
    });

    expect(getStoredPowerAwake('tv4')).toBe(true);
    expect(io.emit).toHaveBeenCalledWith('devices/power', { deviceId: 'tv4', awake: true });
  });

  test('офлайн-устройство: ADB не вызывается, а панели узнают о пропаже', async () => {
    setStoredPowerState('tv1', true);
    const io = emptyIo();
    const getPowerState = fakeGetPowerState(true);

    const states = await pollPowerStates([TARGET], {
      io,
      probe: async () => false,
      commands: { getPowerState }
    });

    expect(getPowerState).not.toHaveBeenCalled();
    expect(states[0].online).toBe(false);
    expect(getStoredPowerAwake('tv1')).toBe(null);
    expect(io.emit).toHaveBeenCalledWith('devices/power', { deviceId: 'tv1', awake: null });
  });

  test('офлайн-устройство уходит в backoff: следующая проба не сразу', async () => {
    const probe = jest.fn(async () => false);

    await pollPowerStates([TARGET], { probe, commands: { getPowerState: fakeGetPowerState(true) } });
    await pollPowerStates([TARGET], { probe, commands: { getPowerState: fakeGetPowerState(true) } });

    expect(probe).toHaveBeenCalledTimes(1);
  });

  test('вернувшееся устройство снова опрашивается (событие авто-обновления)', async () => {
    const io = emptyIo();
    const getPowerState = fakeGetPowerState(true);

    // Устройство было в офлайне, backoff уже истёк — проба снова разрешена.
    markOffline('tv1', Date.now() - 120000);

    await pollPowerStates([TARGET], { io, probe: async () => true, commands: { getPowerState } });

    expect(getPowerState).toHaveBeenCalledTimes(1);
    expect(io.emit).toHaveBeenCalledWith('devices/power', { deviceId: 'tv1', awake: true });
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
      probe: reachable,
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
      probe: reachable,
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