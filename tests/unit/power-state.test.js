/**
 * Единый резолвер состояния «спит/активен»: стратегии auto/display/wakefulness
 * и нормализация значения из профиля.
 */
import {
  resolveAwakeState,
  normalizeSleepDetect,
  matchesSleepOutput,
  SLEEP_DETECT_STRATEGIES,
  DEFAULT_SLEEP_DETECT
} from '../../src/utils/power-state.js';

describe('normalizeSleepDetect', () => {
  test('пропускает известные стратегии', () => {
    for (const strategy of SLEEP_DETECT_STRATEGIES) {
      expect(normalizeSleepDetect(strategy)).toBe(strategy);
    }
  });

  test('неизвестное и пустое значение приводится к auto', () => {
    expect(normalizeSleepDetect('')).toBe(DEFAULT_SLEEP_DETECT);
    expect(normalizeSleepDetect('display ')).toBe('display');
    expect(normalizeSleepDetect('AUTO')).toBe('auto');
    expect(normalizeSleepDetect('nonsense')).toBe(DEFAULT_SLEEP_DETECT);
    expect(normalizeSleepDetect(undefined)).toBe(DEFAULT_SLEEP_DETECT);
  });
});

describe('resolveAwakeState', () => {
  test('auto: экранный маркер важнее mWakefulness (Fake Standby)', () => {
    // OS бодрствует, но подсветка погашена — это сон.
    expect(resolveAwakeState({ awake: true, screenOn: false }, 'auto')).toBe(false);
    expect(resolveAwakeState({ awake: false, screenOn: true }, 'auto')).toBe(true);
  });

  test('auto: без экранного маркера падает на mWakefulness', () => {
    expect(resolveAwakeState({ awake: true, screenOn: null }, 'auto')).toBe(true);
    expect(resolveAwakeState({ awake: false, screenOn: null }, 'auto')).toBe(false);
  });

  test('display: гашение дисплея = сон, состояние системы игнорируется', () => {
    expect(resolveAwakeState({ awake: true, screenOn: false }, 'display')).toBe(false);
    expect(resolveAwakeState({ awake: false, screenOn: null }, 'display')).toBeNull();
  });

  test('wakefulness: дисплей игнорируется', () => {
    expect(resolveAwakeState({ awake: true, screenOn: false }, 'wakefulness')).toBe(true);
    expect(resolveAwakeState({ awake: null, screenOn: true }, 'wakefulness')).toBeNull();
  });

  test('оба сигнала неизвестны или состояние отсутствует — null', () => {
    expect(resolveAwakeState({ awake: null, screenOn: null }, 'auto')).toBeNull();
    expect(resolveAwakeState(null, 'auto')).toBeNull();
  });

  test('по умолчанию используется auto', () => {
    expect(resolveAwakeState({ awake: true, screenOn: false })).toBe(false);
  });

  test('custom не резолвится по dumpsys — состояние читает команда профиля', () => {
    expect(resolveAwakeState({ awake: true, screenOn: true }, 'custom')).toBeNull();
    expect(normalizeSleepDetect('custom')).toBe('custom');
  });
});

describe('matchesSleepOutput', () => {
  test('находит подстроку без учёта регистра и пробелов', () => {
    expect(matchesSleepOutput('true\n', 'true')).toBe(true);
    expect(matchesSleepOutput('TRUE', 'true')).toBe(true);
    expect(matchesSleepOutput('true', ' true ')).toBe(true);
  });

  test('нет совпадения или пустой образец — false', () => {
    expect(matchesSleepOutput('false', 'true')).toBe(false);
    expect(matchesSleepOutput('true', '')).toBe(false);
    expect(matchesSleepOutput('', 'true')).toBe(false);
  });
});
