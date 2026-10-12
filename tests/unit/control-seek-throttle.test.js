import { jest } from '@jest/globals';
import { setupControlHandlers } from '../../src/socket/control-handlers.js';

function createHarness(deviceId, file = 'v.mp4') {
  const handlers = {};
  const socket = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    emit: jest.fn()
  };
  const emit = jest.fn();
  const io = { to: jest.fn(() => ({ emit })) };
  const devices = { [deviceId]: { current: { type: 'video', file } } };
  setupControlHandlers(socket, { devices, io, getVolumeState: () => null });
  return { handlers, emit, io, devices };
}

function seekCalls(emit) {
  return emit.mock.calls.filter(([event]) => event === 'player/seek');
}

describe('control/seek: троттлинг 3с', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('первая перемотка отправляется сразу', () => {
    const { handlers, emit } = createHarness('ATV001');
    handlers['control/seek']({ device_id: 'ATV001', file: 'v.mp4', position: 10 });

    const calls = seekCalls(emit);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ position: 10 });
  });

  test('перемотки чаще 3с не отправляются сразу, применяется последняя', () => {
    const { handlers, emit } = createHarness('ATV002');
    handlers['control/seek']({ device_id: 'ATV002', file: 'v.mp4', position: 10 });
    handlers['control/seek']({ device_id: 'ATV002', file: 'v.mp4', position: 20 });
    handlers['control/seek']({ device_id: 'ATV002', file: 'v.mp4', position: 30 });

    expect(seekCalls(emit)).toHaveLength(1);

    jest.advanceTimersByTime(3000);

    const calls = seekCalls(emit);
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual({ position: 30 });
  });

  test('перемотки с интервалом 3с отправляются сразу каждая', () => {
    const { handlers, emit } = createHarness('ATV003');
    handlers['control/seek']({ device_id: 'ATV003', file: 'v.mp4', position: 10 });
    jest.advanceTimersByTime(3000);
    handlers['control/seek']({ device_id: 'ATV003', file: 'v.mp4', position: 20 });

    const calls = seekCalls(emit);
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual({ position: 10 });
    expect(calls[1][1]).toEqual({ position: 20 });
  });

  test('отложенная перемотка не применяется, если контент сменился', () => {
    const { handlers, emit, devices } = createHarness('ATV004');
    handlers['control/seek']({ device_id: 'ATV004', file: 'v.mp4', position: 10 });
    handlers['control/seek']({ device_id: 'ATV004', file: 'v.mp4', position: 20 });

    devices.ATV004.current = { type: 'video', file: 'other.mp4' };
    jest.advanceTimersByTime(3000);

    expect(seekCalls(emit)).toHaveLength(1);
  });
});
