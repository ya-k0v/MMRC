/**
 * Конструктор профилей питания: валидация шагов, хранилище (кэш из БД),
 * выбор профиля под устройство (специфичность привязки) и проверка шага
 * на живом устройстве. Хранилище БД подменяется фейком, ADB — commands.
 */
import { jest } from '@jest/globals';

const {
  normalizePowerStep,
  normalizePowerSteps,
  validatePowerProfile,
  configurePowerProfileStore,
  resetPowerProfileStore,
  isPowerProfileStoreConfigured,
  loadPowerProfiles,
  listPowerProfiles,
  savePowerProfile,
  deletePowerProfile,
  resolveStoredPowerProfile,
  resolvePowerProfile,
  POWER_STEP_CATALOG
} = await import('../../src/utils/power-profiles.js');
const { testPowerStep } = await import('../../src/utils/power-control.js');

const CONSTRUCTOR_PROFILE = {
  key: 'lv5-machuca',
  label: 'MiTV (machuca)',
  deviceId: null,
  model: 'MiTV',
  androidFrom: '11',
  androidTo: '11',
  sleepSteps: ['svc:power stayon false', 223],
  wakeSteps: [224, 26],
  priority: 5,
  source: 'admin-ui',
  notes: 'тест'
};

describe('normalizePowerStep / normalizePowerSteps', () => {
  test('принимает KEYCODE числом', () => {
    expect(normalizePowerStep(224)).toBe(224);
    expect(normalizePowerStep(0)).toBe(0);
  });

  test('отвергает отрицательные и дробные числа', () => {
    expect(normalizePowerStep(-1)).toBeNull();
    expect(normalizePowerStep(1.5)).toBeNull();
  });

  test('принимает svc/cmd/settings/am/input строки', () => {
    expect(normalizePowerStep('svc:power stayon false')).toBe('svc:power stayon false');
    expect(normalizePowerStep('cmd:power set-screen-state on')).toBe('cmd:power set-screen-state on');
    expect(normalizePowerStep('settings:system put screen_off_timeout 1000')).toBeTruthy();
    expect(normalizePowerStep('am:set-standby-bucket package active')).toBeTruthy();
    expect(normalizePowerStep('input:keyevent 224')).toBe('input:keyevent 224');
  });

  test('принимает dumpsys-строки (Doze/App Standby)', () => {
    expect(normalizePowerStep('dumpsys:deviceidle disable')).toBe('dumpsys:deviceidle disable');
    expect(normalizePowerStep('dumpsys:deviceidle whitelist +com.videocontrol.mediaplayer')).toBeTruthy();
  });

  test('принимает LAN-шаги Lumien (порт 4664) и отвергает битые', () => {
    expect(normalizePowerStep('lan::01SE0001')).toBe('lan::01SE0001');
    expect(normalizePowerStep('lan:4664::01S0000')).toBe('lan:4664::01S0000');
    expect(normalizePowerStep('lan:')).toBeNull();
    expect(normalizePowerStep('lan::01SE\t0001')).toBeNull();
    expect(normalizePowerStep('lan:99999::01SE0001')).toBeNull();
  });

  test('отвергает посторонние строки и числа вне диапазона', () => {
    expect(normalizePowerStep('hello world')).toBeNull();
    expect(normalizePowerStep('svc')).toBeNull();
    expect(normalizePowerStep(70000)).toBeNull();
    expect(normalizePowerStep(true)).toBeNull();
  });

  test('нормализует массив и сообщает о первом некорректном шаге', () => {
    expect(normalizePowerSteps([224, 'cmd:power sleep'])).toEqual({ ok: true, steps: [224, 'cmd:power sleep'] });
    const bad = normalizePowerSteps([224, 'rm -rf /']);
    expect(bad.ok).toBe(false);
  });

  test('не массив — ошибка', () => {
    expect(normalizePowerSteps('224').ok).toBe(false);
    expect(normalizePowerSteps(224).ok).toBe(false);
  });
});

describe('validatePowerProfile', () => {
  test('валидный профиль приводится к единому виду', () => {
    const result = validatePowerProfile(CONSTRUCTOR_PROFILE);
    expect(result.ok).toBe(true);
    expect(result.profile).toMatchObject({
      key: 'lv5-machuca',
      label: 'MiTV (machuca)',
      model: 'MiTV',
      androidFrom: '11',
      androidTo: '11',
      priority: 5
    });
    expect(result.profile.sleepSteps).toEqual(['svc:power stayon false', 223]);
  });

  test('требует ключ и название', () => {
    expect(validatePowerProfile({ ...CONSTRUCTOR_PROFILE, key: 'bad key!' }).ok).toBe(false);
    expect(validatePowerProfile({ ...CONSTRUCTOR_PROFILE, key: '' }).ok).toBe(false);
    expect(validatePowerProfile({ ...CONSTRUCTOR_PROFILE, label: '' }).ok).toBe(false);
  });

  test('отвергает опасный device_id', () => {
    expect(validatePowerProfile({ ...CONSTRUCTOR_PROFILE, deviceId: '__proto__' }).ok).toBe(false);
  });

  test('отвергает некорректные версии Android и шаги', () => {
    expect(validatePowerProfile({ ...CONSTRUCTOR_PROFILE, androidFrom: '13.3' }).ok).toBe(false);
    expect(validatePowerProfile({ ...CONSTRUCTOR_PROFILE, androidFrom: 'abc' }).ok).toBe(false);
    expect(validatePowerProfile({ ...CONSTRUCTOR_PROFILE, sleepSteps: ['svc:power stayon false', 'sudo reboot'] }).ok).toBe(false);
  });

  test('пустые привязки и шаги допустимы (catch-all)', () => {
    const result = validatePowerProfile({
      key: 'catch-all',
      label: 'Любые устройства',
      sleepSteps: [],
      wakeSteps: []
    });
    expect(result.ok).toBe(true);
    expect(result.profile.deviceId).toBeNull();
    expect(result.profile.sleepSteps).toEqual([]);
    expect(result.profile.keepAwakeSteps).toEqual([]);
  });

  test('команды удержания валидируются и попадают в профиль', () => {
    const result = validatePowerProfile({
      ...CONSTRUCTOR_PROFILE,
      keepAwakeSteps: ['svc:power stayon true', 'settings:secure put screensaver_enabled 0']
    });
    expect(result.ok).toBe(true);
    expect(result.profile.keepAwakeSteps).toEqual(['svc:power stayon true', 'settings:secure put screensaver_enabled 0']);

    const bad = validatePowerProfile({ ...CONSTRUCTOR_PROFILE, keepAwakeSteps: ['sudo reboot'] });
    expect(bad.ok).toBe(false);
  });
});

describe('хранилище профилей (кэш из БД)', () => {
  function configureFakeStore(profiles) {
    let rows = [...profiles];
    const store = {
      load: jest.fn(async () => rows.map(row => ({ ...row }))),
      save: jest.fn(async (profile) => {
        const existing = rows.find(row => row.key === profile.key);
        if (existing) Object.assign(existing, profile);
        else rows.push({ ...profile });
      }),
      remove: jest.fn(async (key) => {
        rows = rows.filter(row => row.key !== key);
      })
    };
    return { store, getRows: () => rows };
  }

  beforeEach(() => {
    resetPowerProfileStore();
  });

  afterEach(() => {
    resetPowerProfileStore();
  });

  test('без хранилища список пуст (резерв не показывается)', async () => {
    expect(isPowerProfileStoreConfigured()).toBe(false);
    await loadPowerProfiles();
    const profiles = listPowerProfiles();
    expect(profiles).toEqual([]);
  });

  test('configure + load загружает и сортирует по приоритету', async () => {
    const { store } = configureFakeStore([
      CONSTRUCTOR_PROFILE,
      { key: 'catch', label: 'Все устройства', sleepSteps: [], wakeSteps: [], priority: -5 }
    ]);
    configurePowerProfileStore(store);
    const profiles = await loadPowerProfiles();

    expect(store.load).toHaveBeenCalled();
    expect(profiles).toHaveLength(2);
    expect(profiles[0].key).toBe('lv5-machuca');
  });

  test('save пишет в хранилище и перечитывает кэш', async () => {
    const { store } = configureFakeStore([]);
    configurePowerProfileStore(store);

    const result = await savePowerProfile(CONSTRUCTOR_PROFILE);
    expect(result.ok).toBe(true);
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ key: 'lv5-machuca' }));
    expect(listPowerProfiles().find(p => p.key === 'lv5-machuca')).toBeTruthy();
  });

  test('save возвращает ошибку валидации, не дойдя до хранилища', async () => {
    const { store } = configureFakeStore([]);
    configurePowerProfileStore(store);

    const result = await savePowerProfile({ ...CONSTRUCTOR_PROFILE, label: '' });
    expect(result.ok).toBe(false);
    expect(store.save).not.toHaveBeenCalled();
  });

  test('delete удаляет и перечитывает', async () => {
    const { store } = configureFakeStore([CONSTRUCTOR_PROFILE]);
    configurePowerProfileStore(store);
    await loadPowerProfiles();

    const result = await deletePowerProfile('lv5-machuca');
    expect(result.ok).toBe(true);
    expect(listPowerProfiles().filter(p => p.key === 'lv5-machuca')).toHaveLength(0);
  });

  test('битые строки из БД выбрасываются', async () => {
    const { store } = configureFakeStore([{
      ...CONSTRUCTOR_PROFILE,
      sleepSteps: [{ unsafe: true }]
    }]);
    configurePowerProfileStore(store);
    const profiles = await loadPowerProfiles();
    expect(profiles).toHaveLength(0);
  });
});

describe('resolveStoredPowerProfile: специфичность привязки', () => {
  const ROWS = [
    { key: 'catch', label: 'Любые', sleepSteps: [], wakeSteps: [], priority: 0 },
    { key: 'a11', label: 'Android 11', androidFrom: '11', androidTo: '11', sleepSteps: [223], wakeSteps: [224], priority: 0 },
    { key: 'machuca-model', label: 'модель MiTV', model: 'MiTV', sleepSteps: [223], wakeSteps: [224], priority: 0 },
    { key: 'machuca-android', label: 'MiTV на 11', model: 'MiTV', androidFrom: '11', androidTo: '11', sleepSteps: [223], wakeSteps: [224], priority: 0 },
    { key: 'tv-a', label: 'конкретное устройство', deviceId: 'tv-a', sleepSteps: [223], wakeSteps: [224], priority: 0 },
    { key: 'tv-a-model', label: 'устройство + модель', deviceId: 'tv-a', model: 'MiTV', sleepSteps: [223], wakeSteps: [224], priority: 0 }
  ];

  beforeEach(() => {
    resetPowerProfileStore();
    configurePowerProfileStore({
      load: async () => ROWS.map(row => ({ ...row })),
      save: async () => {},
      remove: async () => {}
    });
  });

  test('полное совпадение (устройство + модель) побеждает', async () => {
    await loadPowerProfiles();
    const profile = resolveStoredPowerProfile({ deviceId: 'tv-a', model: 'MiTV', android: '11' });
    expect(profile.key).toBe('tv-a-model');
  });

  test('модель + версия точнее, чем только модель', async () => {
    await loadPowerProfiles();
    const profile = resolveStoredPowerProfile({ deviceId: 'other', model: 'MiTV', android: '11' });
    expect(profile.key).toBe('machuca-android');
  });

  test('без версии — только модель', async () => {
    await loadPowerProfiles();
    const profile = resolveStoredPowerProfile({ deviceId: 'other', model: 'MiTV', android: '9' });
    expect(profile.key).toBe('machuca-model');
  });

  test('чужая модель, но версия 11 — профиль по версии', async () => {
    await loadPowerProfiles();
    const profile = resolveStoredPowerProfile({ deviceId: 'other', model: 'Sony', android: '11' });
    expect(profile.key).toBe('a11');
  });

  test('совсем нет совпадений — catch-all', async () => {
    await loadPowerProfiles();
    const profile = resolveStoredPowerProfile({ deviceId: 'other', model: 'Sony', android: '9' });
    expect(profile.key).toBe('catch');
  });

  test('нет привязок в БД — null', async () => {
    resetPowerProfileStore();
    configurePowerProfileStore({ load: async () => [], save: async () => {}, remove: async () => {} });
    await loadPowerProfiles();
    expect(resolveStoredPowerProfile({ model: 'MiTV', android: '11' })).toBeNull();
  });
});

describe('resolvePowerProfile: БД, иначе резервный набор', () => {
  test('пустой кэш — резервный набор', () => {
    resetPowerProfileStore();
    expect(resolvePowerProfile({ model: 'LB3235SDG2' }).key).toBe('default');
    expect(resolvePowerProfile({ android: '13' }).key).toBe('default');
    expect(resolvePowerProfile({ model: 'iconBIT TRS2045' }).key).toBe('default');
    expect(resolvePowerProfile({ model: 'LUMEN LS5550SD', android: '11' }).key).toBe('default');
  });

  test('профиль из БД выигрывает у резерва', async () => {
    resetPowerProfileStore();
    configurePowerProfileStore({
      load: async () => [CONSTRUCTOR_PROFILE],
      save: async () => {},
      remove: async () => {}
    });
    await loadPowerProfiles();

    const profile = resolvePowerProfile({ deviceId: 'tv-a', model: 'MiTV', android: '11' });
    expect(profile.key).toBe('lv5-machuca');
    expect(profile.wake).toEqual([224, 26]);
    expect(profile.sleep).toEqual(['svc:power stayon false', 223]);
    expect(profile.keepAwake).toEqual([]);
  });

  test('keepAwake из БД попадает в результат резолва', async () => {
    resetPowerProfileStore();
    configurePowerProfileStore({
      load: async () => [{
        ...CONSTRUCTOR_PROFILE,
        keepAwakeSteps: ['svc:power stayon true', 'settings:secure put screensaver_enabled 0']
      }],
      save: async () => {},
      remove: async () => {}
    });
    await loadPowerProfiles();

    const profile = resolvePowerProfile({ model: 'MiTV', android: '11' });
    expect(profile.keepAwake).toEqual(['svc:power stayon true', 'settings:secure put screensaver_enabled 0']);
  });
});

describe('сид профилей под модели устройств: разрешение по строке модели', () => {
  const ROWS = [
    { key: 'model-ls5550sduhd-cs1382d-g', label: 'LS5550SDUHD', model: 'ls5550sduhd-cs1382d-g', sleepSteps: [223], wakeSteps: [224], priority: 1 },
    { key: 'model-ls5550sd-bo1082d-g', label: 'LS5550SD', model: 'ls5550sd-bo1082d-g', sleepSteps: [223], wakeSteps: [224], priority: 1 },
    { key: 'model-smart-aio-tv', label: 'Smart AIO TV', model: 'smart aio tv', sleepSteps: [223], wakeSteps: [224], priority: 1 },
    { key: 'model-iconbit-trs2045', label: 'iconBIT TRS2045', model: 'iconbit trs2045', sleepSteps: [223], wakeSteps: [224], priority: 1 }
  ];

  beforeEach(() => {
    resetPowerProfileStore();
    configurePowerProfileStore({
      load: async () => ROWS.map(row => ({ ...row })),
      save: async () => {},
      remove: async () => {}
    });
  });

  afterEach(() => resetPowerProfileStore());

  test('каждая модель получает свой профиль', async () => {
    await loadPowerProfiles();
    expect(resolveStoredPowerProfile({ model: 'LS5550SDUHD-CS1382D-G', android: '11' }).key).toBe('model-ls5550sduhd-cs1382d-g');
    expect(resolveStoredPowerProfile({ model: 'LS5550SD-BO1082D-G', android: '11' }).key).toBe('model-ls5550sd-bo1082d-g');
    expect(resolveStoredPowerProfile({ model: 'Smart AIO TV', android: '13' }).key).toBe('model-smart-aio-tv');
    expect(resolveStoredPowerProfile({ model: 'iconBIT TRS2045', android: '10' }).key).toBe('model-iconbit-trs2045');
  });

  test('похожие модели LS5550SDUHD и LS5550SD не путаются', async () => {
    await loadPowerProfiles();
    expect(resolveStoredPowerProfile({ model: 'LS5550SDUHD-CS1382D-G' }).key).toBe('model-ls5550sduhd-cs1382d-g');
    expect(resolveStoredPowerProfile({ model: 'LS5550SD-BO1082D-G' }).key).toBe('model-ls5550sd-bo1082d-g');
  });
});

describe('testPowerStep: проверка шага на устройстве', () => {
  function fakeCommands(overrides = {}) {
    return {
      wakeKey: jest.fn(async () => ({ ok: true, output: '' })),
      getPowerState: jest.fn(async () => ({ ok: true, awake: true, screenOn: true })),
      delay: jest.fn(async () => {}),
      ...overrides
    };
  }

  async function run(targetIp, phase, overrides) {
    return testPowerStep({
      target: { deviceId: 'tv-a', ip: targetIp, port: null },
      step: 224,
      phase,
      commands: fakeCommands(overrides)
    });
  }

  test('без IP — ошибка, команда не уходит', async () => {
    const commands = fakeCommands();
    const result = await testPowerStep({ target: {}, step: 224, phase: 'wake', commands });
    expect(result.ok).toBe(false);
    expect(commands.wakeKey).not.toHaveBeenCalled();
  });

  test('пробуждение удачно, если экран реально поднялся', async () => {
    const result = await run('192.168.1.10', 'wake');
    expect(result.ok).toBe(true);
    expect(result.awake).toBe(true);
    expect(result.phase).toBe('wake');
  });

  test('сон удачен, когда экран погас', async () => {
    const result = await run('192.168.1.10', 'sleep', {
      getPowerState: async () => ({ ok: true, awake: false, screenOn: false })
    });
    expect(result.ok).toBe(true);
    expect(result.awake).toBe(false);
  });

  test('пробуждение не сработало — экран не поднялся', async () => {
    const result = await run('192.168.1.10', 'wake', {
      getPowerState: async () => ({ ok: true, awake: false, screenOn: false })
    });
    expect(result.ok).toBe(false);
    expect(result.awake).toBe(false);
  });

  test('разобрать состояние не вышло — шаг засчитывается (как в лестнице)', async () => {
    const result = await run('192.168.1.10', 'sleep', {
      getPowerState: async () => null
    });
    expect(result.ok).toBe(true);
    expect(result.awake).toBeNull();
  });

  test('ADB потерял устройство — ошибка', async () => {
    const result = await run('192.168.1.10', 'wake', {
      wakeKey: async () => ({ ok: false, error: 'ADB не отвечает' })
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ADB не отвечает');
  });
});

describe('каталог шагов для конструктора', () => {
  test('их много и каждый имеет значение/фазу/риск', () => {
    expect(POWER_STEP_CATALOG.length).toBeGreaterThan(5);
    for (const entry of POWER_STEP_CATALOG) {
      expect(entry.value).toBeDefined();
      expect(['wake', 'sleep', 'both', 'after']).toContain(entry.phase);
      expect(['low', 'medium', 'high']).toContain(entry.risk);
      expect(entry.hint).toBeTruthy();
    }
  });

  test('содержит команды из ADB-мануала проекта', () => {
    const values = POWER_STEP_CATALOG.map(entry => entry.value);
    expect(values).toEqual(expect.arrayContaining([
      'cmd:display power-off 0',
      'cmd:display power-reset 0',
      'svc:wifi enable',
      'settings:global put wifi_sleep_policy 2',
      'settings:global put stay_on_while_plugged_in 7',
      'dumpsys:deviceidle disable',
      'dumpsys:deviceidle unforce'
    ]));
    expect(values.some(value => String(value).includes('RUN_ANY_IN_BACKGROUND'))).toBe(true);
    expect(values.some(value => String(value).includes('set-standby-bucket'))).toBe(true);
    expect(values.some(value => String(value).includes('deviceidle whitelist'))).toBe(true);
  });

  test('содержит команды скринсейвера, удержания и CEC-клавиши', () => {
    const values = POWER_STEP_CATALOG.map(entry => entry.value);
    expect(values).toEqual(expect.arrayContaining([
      276,
      177,
      179,
      181,
      'svc:power stayon true',
      'settings:secure put screensaver_enabled 0',
      'settings:secure put screensaver_activate_on_sleep 0',
      'settings:secure put screensaver_activate_on_dock 0',
      'wm:dismiss-keyguard',
      'settings:system put screen_brightness 0'
    ]));
    const tvPower = POWER_STEP_CATALOG.find(entry => entry.value === 177);
    expect(tvPower.label).toContain('KEYCODE_TV_POWER');
    const tv = POWER_STEP_CATALOG.find(entry => entry.value === 170);
    expect(tv.label).toContain('KEYCODE_TV');
  });

  test('шаги удержания имеют фазу after и валидны как шаги профиля', () => {
    const keep = POWER_STEP_CATALOG.filter(entry => entry.phase === 'after');
    expect(keep.length).toBeGreaterThan(3);
    for (const entry of keep) {
      expect(normalizePowerStep(entry.value)).not.toBeNull();
    }
  });

  test('содержит вендорские LAN-команды Lumien', () => {
    const lan = POWER_STEP_CATALOG.filter(entry => entry.kind === 'lan');
    expect(lan.map(entry => entry.value)).toEqual(expect.arrayContaining([
      'lan::01SE0000',
      'lan::01SE0001',
      'lan::01S0000'
    ]));
    for (const entry of lan) {
      expect(normalizePowerStep(entry.value)).not.toBeNull();
    }
  });
});

describe('все профили — обычные строки из БД', () => {
  afterEach(() => {
    resetPowerProfileStore();
  });

  test('в списке только строки БД, без синтетических профилей', async () => {
    configurePowerProfileStore({
      load: async () => [{
        key: 'default',
        label: 'Мой дефолт',
        model: null,
        androidFrom: null,
        androidTo: null,
        sleepSteps: [223],
        wakeSteps: [224],
        priority: 0,
        source: 'seed'
      }, {
        key: 'android-13',
        label: 'Android 13',
        model: null,
        androidFrom: '13',
        androidTo: '13',
        sleepSteps: [223],
        wakeSteps: [224],
        priority: 0,
        source: 'seed'
      }],
      save: async () => {},
      remove: async () => {}
    });
    await loadPowerProfiles();

    const profiles = listPowerProfiles();
    // В списке только строки БД: без синтетических «встроенных» и без поля builtin.
    expect(profiles).toHaveLength(2);
    expect(profiles.some(profile => Object.prototype.hasOwnProperty.call(profile, 'builtin'))).toBe(false);
    expect(profiles.find(profile => profile.key === 'default').label).toBe('Мой дефолт');
  });

  test('профиль из БД подхватывается по версии Android', async () => {
    configurePowerProfileStore({
      load: async () => [{
        key: 'android-13',
        label: 'Свой Android 13',
        model: null,
        androidFrom: '13',
        androidTo: '13',
        sleepSteps: ['cmd:power set-screen-state off'],
        wakeSteps: ['cmd:power set-screen-state on'],
        priority: 0,
        source: 'seed'
      }],
      save: async () => {},
      remove: async () => {}
    });
    await loadPowerProfiles();

    const profile = resolvePowerProfile({ android: '13' });
    expect(profile.key).toBe('android-13');
    expect(profile.wake).toEqual(['cmd:power set-screen-state on']);
  });

  test('все профили БД удаляются одинаково (в т.ч. засеянные)', async () => {
    const removed = [];
    configurePowerProfileStore({
      load: async () => [{
        key: 'android-13',
        label: 'Android 13',
        model: null,
        androidFrom: '13',
        androidTo: '13',
        sleepSteps: [223],
        wakeSteps: [224],
        priority: 0,
        source: 'seed'
      }],
      save: async () => {},
      remove: async (key) => { removed.push(key); }
    });
    await loadPowerProfiles();

    const result = await deletePowerProfile('android-13');
    expect(result.ok).toBe(true);
    expect(removed).toEqual(['android-13']);
  });
});