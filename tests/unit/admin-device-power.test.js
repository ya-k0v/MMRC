/**
 * @jest-environment jsdom
 *
 * Карточка «Управление устройствами» в настройках админа: кнопки сна и
 * пробуждения, бейдж состояния и итоговый тост по результатам bulk-команды.
 */
import { jest } from '@jest/globals';

const mockShowToastNotification = jest.fn();

jest.unstable_mockModule('../../public/js/admin/notifications.js', () => ({
  initNotifications: jest.fn(),
  showToastNotification: (...args) => mockShowToastNotification(...args)
}));

const {
  isPowerControllable,
  renderPowerControlsHtml,
  initPowerControls,
  applyPowerState
} = await import('../../public/js/admin/device-power.js');

const DEVICES = [
  { device_id: 'tv1', name: 'Зал', deviceType: 'android', ipAddress: '192.168.1.10' },
  { device_id: 'tv2', name: 'Кухня', deviceType: 'VJC', platform: 'Android', ipAddress: '192.168.1.11' },
  { device_id: 'native1', name: 'MMRC', deviceType: 'NATIVE_MEDIAPLAYER', ipAddress: '192.168.1.12' },
  { device_id: 'browser', name: 'Браузер', deviceType: 'browser', ipAddress: '192.168.1.13' }
];

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function jsonFetch(payload, ok = true) {
  return jest.fn(async () => ({ ok, json: async () => payload }));
}

function badge(deviceId) {
  return document.querySelector(`[data-power-badge="${deviceId}"]`);
}

function row(deviceId) {
  return document.querySelector(`[data-power-row="${deviceId}"]`);
}

function bodyOf(call) {
  return JSON.parse(call[1].body);
}

function findCall(mock, url) {
  return mock.mock.calls.find(call => call[0] === url);
}

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '';
});

describe('карточка «Управление устройствами»', () => {
  test('показывает только устройства, которыми можно управлять по ADB', () => {
    const html = renderPowerControlsHtml(DEVICES);
    document.body.innerHTML = html;

    expect(html).toContain('Управление устройствами');
    expect(row('tv1')).not.toBeNull();
    expect(row('tv2')).not.toBeNull();
    expect(row('native1')).not.toBeNull();
    expect(document.querySelector('[data-power-row="browser"]')).toBeNull();
    expect(html).toContain('Усыпить все');
    expect(html).toContain('Разбудить и запустить плеер');
    expect(html).toContain('Запустить плеер везде');
    expect(html).toContain('Запустить плеер');
    expect(document.querySelector('[data-power-action="launch"][data-power-id="tv1"]')).not.toBeNull();
  });

  test('isPowerControllable принимает тип, платформу и нативный плеер', () => {
    expect(isPowerControllable({ deviceType: 'android' })).toBe(true);
    expect(isPowerControllable({ platform: 'Android TV' })).toBe(true);
    expect(isPowerControllable({ device_type: 'NATIVE_MEDIAPLAYER' })).toBe(true);
    expect(isPowerControllable({ deviceType: 'browser' })).toBe(false);
  });

  test('если список не влезает в высоту карточки — включается пагинация', () => {
    document.body.innerHTML = renderPowerControlsHtml(DEVICES);
    const list = document.getElementById('stPowerList');
    const offsetDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const clientDesc = Object.getOwnPropertyDescriptor(list, 'clientHeight');

    // Колонка вмещает два ряда: 100px при высоте строки 40px + gap 6px.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() { return this.hasAttribute?.('data-power-row') ? 40 : 0; }
    });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 });

    try {
      initPowerControls({ devices: DEVICES, adminFetch: jsonFetch({ ok: true, states: [] }) });

      expect(row('tv1')).not.toBeNull();
      expect(row('tv2')).not.toBeNull();
      expect(row('native1')).toBeNull();
      expect(document.getElementById('stPowerPager').hidden).toBe(false);
      expect(document.getElementById('stPowerPagerInfo').textContent).toBe('1 / 2');

      document.getElementById('stPowerNext').click();
      expect(row('tv1')).toBeNull();
      expect(row('native1')).not.toBeNull();
      expect(document.getElementById('stPowerPagerInfo').textContent).toBe('2 / 2');

      document.getElementById('stPowerPrev').click();
      expect(row('tv1')).not.toBeNull();
      expect(document.getElementById('stPowerPagerInfo').textContent).toBe('1 / 2');
    } finally {
      if (offsetDesc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetDesc);
      else delete HTMLElement.prototype.offsetHeight;
      if (clientDesc) Object.defineProperty(list, 'clientHeight', clientDesc);
      else delete list.clientHeight;
    }
  });

  test('без Android-устройств в списке показывается подсказка', async () => {
    document.body.innerHTML = renderPowerControlsHtml([
      { device_id: 'browser', deviceType: 'browser' }
    ]);
    initPowerControls({ devices: [{ device_id: 'browser', deviceType: 'browser' }], adminFetch: jsonFetch({}) });
    await flush();

    expect(document.getElementById('stPowerList').textContent).toContain('Нет Android-устройств');
    expect(document.getElementById('stPowerStatus').textContent).toContain('Нет Android-устройств');
  });
});

describe('бейдж состояния', () => {
  test('после события из сокета показывает спит/активен', () => {
    document.body.innerHTML = renderPowerControlsHtml(DEVICES);

    applyPowerState({ deviceId: 'tv1', awake: false });
    applyPowerState({ deviceId: 'tv2', awake: true });

    expect(badge('tv1').textContent).toBe('спит');
    expect(badge('tv2').textContent).toBe('активен');
  });

  test('состояние подтягивается из /api/devices/power-state', async () => {
    document.body.innerHTML = renderPowerControlsHtml(DEVICES);
    const adminFetch = jsonFetch({
      ok: true,
      states: [
        { deviceId: 'tv1', ok: true, awake: false },
        { deviceId: 'tv2', ok: false, awake: null }
      ]
    });

    initPowerControls({ devices: DEVICES, adminFetch });
    await flush();

    expect(findCall(adminFetch, '/api/devices/power-state')).toBeDefined();
    expect(bodyOf(findCall(adminFetch, '/api/devices/power-state')))
      .toEqual({ deviceIds: ['tv1', 'tv2', 'native1'] });
    expect(badge('tv1').textContent).toBe('спит');
    expect(badge('tv2').textContent).toBe('нет ответа');
  });
});

describe('команды питания', () => {
  test('«Усыпить все» уходит без deviceIds и relaunch', async () => {
    document.body.innerHTML = renderPowerControlsHtml(DEVICES);
    const adminFetch = jsonFetch({
      ok: true,
      results: [{ deviceId: 'tv1', ok: true, awake: false }],
      summary: { total: 1, succeeded: 1, failed: 0 }
    });
    initPowerControls({ devices: DEVICES, adminFetch });
    await flush();

    document.getElementById('stPowerSleepAll').click();
    await flush();

    const call = findCall(adminFetch, '/api/devices/power');
    expect(call).toBeDefined();
    expect(bodyOf(call)).toEqual({ action: 'sleep', relaunch: false });
    expect(badge('tv1').textContent).toBe('спит');
    expect(mockShowToastNotification).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Усыплено 1 из 1' })
    );
  });

  test('кнопка на строке будит конкретное устройство и поднимает плеер', async () => {
    document.body.innerHTML = renderPowerControlsHtml(DEVICES);
    const adminFetch = jsonFetch({
      ok: true,
      results: [{ deviceId: 'tv2', ok: true, awake: true }],
      summary: { total: 1, succeeded: 1, failed: 0 }
    });
    initPowerControls({ devices: DEVICES, adminFetch });
    await flush();

    document.querySelector('[data-power-action="wake"][data-power-id="tv2"]').click();
    await flush();

    const call = findCall(adminFetch, '/api/devices/power');
    expect(bodyOf(call)).toEqual({ action: 'wake', deviceIds: ['tv2'], relaunch: true });
    expect(badge('tv2').textContent).toBe('активен');
  });

  test('частичный успех: в тосте перечислены устройства, которые не отреагировали', async () => {
    document.body.innerHTML = renderPowerControlsHtml(DEVICES);
    const adminFetch = jsonFetch({
      ok: true,
      results: [
        { deviceId: 'tv1', ok: true, awake: false },
        { deviceId: 'tv2', ok: false, error: 'timeout' }
      ],
      summary: { total: 2, succeeded: 1, failed: 1 }
    });
    initPowerControls({ devices: DEVICES, adminFetch });
    await flush();

    document.getElementById('stPowerSleepAll').click();
    await flush();

    expect(mockShowToastNotification).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Усыплено 1 из 2 · не сработало: Кухня',
      severity: 'warning'
    }));
    expect(badge('tv1').textContent).toBe('спит');
    expect(badge('tv2').textContent).toBe('нет ответа');
  });

  test('ошибка ответа сервера показывается в статусе', async () => {
    document.body.innerHTML = renderPowerControlsHtml(DEVICES);
    const adminFetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'Укажите action' }) }));
    initPowerControls({ devices: DEVICES, adminFetch });
    await flush();

    document.getElementById('stPowerWakeAll').click();
    await flush();

    expect(document.getElementById('stPowerStatus').textContent).toBe('Укажите action');
    expect(mockShowToastNotification).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warning' })
    );
  });

  test('«Запустить плеер везде» шлёт launch на все устройства', async () => {
    document.body.innerHTML = renderPowerControlsHtml(DEVICES);
    const adminFetch = jsonFetch({
      ok: true,
      results: [{ deviceId: 'tv1', ok: true }],
      summary: { total: 1, succeeded: 1, failed: 0 }
    });
    initPowerControls({ devices: DEVICES, adminFetch });
    await flush();

    document.getElementById('stPowerLaunchAll').click();
    await flush();

    const call = findCall(adminFetch, '/api/devices/power');
    expect(call).toBeDefined();
    expect(bodyOf(call)).toEqual({ action: 'launch' });
    expect(mockShowToastNotification).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Плеер запущен 1 из 1' })
    );
  });

  test('кнопка на строке «Запустить плеер» перезапускает конкретное устройство', async () => {
    document.body.innerHTML = renderPowerControlsHtml(DEVICES);
    const adminFetch = jsonFetch({
      ok: true,
      results: [{ deviceId: 'tv1', ok: true }],
      summary: { total: 1, succeeded: 1, failed: 0 }
    });
    initPowerControls({ devices: DEVICES, adminFetch });
    await flush();

    document.querySelector('[data-power-action="launch"][data-power-id="tv1"]').click();
    await flush();

    const call = findCall(adminFetch, '/api/devices/power');
    expect(call).toBeDefined();
    expect(bodyOf(call)).toEqual({ action: 'launch', deviceIds: ['tv1'], relaunch: false });
  });

  test('перезапуск плеера не меняет бейдж спит/активен', async () => {
    document.body.innerHTML = renderPowerControlsHtml(DEVICES);
    applyPowerState({ deviceId: 'tv1', awake: false });
    const adminFetch = jsonFetch({
      ok: true,
      results: [
        { deviceId: 'tv1', ok: true },
        { deviceId: 'tv2', ok: false }
      ],
      summary: { total: 2, succeeded: 1, failed: 1 }
    });
    initPowerControls({ devices: DEVICES, adminFetch });
    await flush();

    document.getElementById('stPowerLaunchAll').click();
    await flush();

    expect(badge('tv1').textContent).toBe('спит');
    expect(badge('tv2').textContent).toBe('нет ответа');
  });
});
