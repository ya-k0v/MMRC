/**
 * Управление питанием Android-приставок из настроек админа.
 *
 * Приставки встроены в стену, их нельзя обесточить, поэтому здесь только
 * сон и пробуждение (сервер шлёт KEYCODE_SLEEP/KEYCODE_WAKEUP, а если
 * устройство в сне выпало из сети — будит его Wake-on-LAN пакетом).
 *
 * Карточка живёт в разделе «Настройки сервера» → «Управление устройствами»,
 * список плиток устройств она не засоряет. Чипы сводки над списком — это
 * фильтры: по ним показываются только устройства с выбранным статусом.
 *
 * @module admin/device-power
 */

import { escapeHtml } from '../shared/utils.js';
import { getPowerIcon, getSunIcon, getMoonIcon, getPlayIcon, getRestartIcon, getChevronLeftIcon, getChevronRightIcon, getSlidersIcon, getUpdateIcon } from '../shared/svg-icons.js';

const POWER_ENDPOINT = '/api/devices/power';
const STATE_ENDPOINT = '/api/devices/power-state';
const APK_VERSION_ENDPOINT = '/api/admin/apk-version';
const PLAYER_UPDATE_ENDPOINT = '/api/admin/install-apk-bound';

/** deviceId → {ok, awake}. Живёт дольше рендера карточки. */
const powerStates = new Map();
/** deviceId → {currentVersion, releaseVersion}. Обновляется после запроса версии APK. */
let playerVersions = new Map();
let releaseVersion = '';
let deviceNames = new Map();

/** Управляемые устройства текущей карточки, текущая страница списка. */
let powerTargets = [];
let page = 0;
let listObserver = null;
let fitRaf = 0;

/** Активный фильтр сводки: 'all' или одно из состояний/«требуют обновления». */
let activeFilter = 'all';

/** Пока идёт команда, повторные нажатия не должны запускать её ещё раз. */
let busy = false;

const SUMMARY_FILTERS = [
  { key: 'all', label: 'Всего', tone: '' },
  { key: 'active', label: 'Активны', tone: 'is-success' },
  { key: 'sleeping', label: 'Спят', tone: 'is-warning' },
  { key: 'unreachable', label: 'Нет ответа', tone: 'is-danger' },
  { key: 'unknown', label: 'Не опрошены', tone: '' },
  { key: 'outdated', label: 'Требуют обновления', tone: 'is-success' }
];

/** Отступ между рядами в списке, px (должен совпадать с .st-power-list). */
const LIST_GAP = 6;

/** Тот же признак, что и на сервере: тип устройства, платформа, нативный плеер. */
export function isPowerControllable(device) {
  const deviceType = String(device?.deviceType || device?.device_type || '').toLowerCase();
  const platform = String(device?.platform || '').toLowerCase();
  return deviceType.includes('android')
    || deviceType.includes('native_mediaplayer')
    || platform.includes('android');
}

function badgeView(state) {
  if (!state) return { text: '—', cls: 'is-unknown' };
  if (!state.ok) return { text: 'нет ответа', cls: 'is-error' };
  if (state.awake) return { text: 'активен', cls: 'is-active' };
  return { text: 'спит', cls: 'is-sleep' };
}

/** Версии приходят и как «3.4.1», и как «v3.4.1» — сравниваем без префикса. */
function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

/**
 * Сравнение версий по частям: '3.4.2' новее '3.4.1', а '3.4.1-rc1' — старее
 * '3.4.1'. Для неразбираемой строки возвращаем null: такая версия считается
 * неизвестной и подлежит обновлению, если релиз известен.
 */
function compareVersions(current, target) {
  const parse = (value) => {
    const match = /^(\d+(?:\.\d+)*)([-+].*)?$/.exec(normalizeVersion(value));
    if (!match) return null;
    return { parts: match[1].split('.').map(Number), suffix: match[2] || '' };
  };
  const a = parse(current);
  const b = parse(target);
  if (!a || !b) return null;

  const length = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a.parts[i] || 0) - (b.parts[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  // Номер совпал: пререлиз считается более старой версией, чем релиз.
  if (a.suffix !== b.suffix) {
    if (!a.suffix) return 1;
    if (!b.suffix) return -1;
    return a.suffix < b.suffix ? -1 : 1;
  }
  return 0;
}

function updateAvailable(id) {
  const versions = playerVersions.get(id);
  if (!versions || !releaseVersion) return false;
  const current = normalizeVersion(versions.currentVersion);
  if (!current) return true;
  const comparison = compareVersions(current, releaseVersion);
  return comparison === null ? true : comparison < 0;
}

/** Один источник правды для счётчиков сводки и фильтрации списка. */
function deviceMatchesFilter(device, filter) {
  const id = device.device_id;
  if (filter === 'all') return true;
  if (filter === 'outdated') return updateAvailable(id);

  const state = powerStates.get(id);
  if (filter === 'active') return Boolean(state?.ok && state.awake);
  if (filter === 'sleeping') return Boolean(state?.ok && !state.awake);
  if (filter === 'unreachable') return Boolean(state && !state.ok);
  if (filter === 'unknown') return !state;
  return true;
}

function summaryCounts() {
  const counts = Object.fromEntries(SUMMARY_FILTERS.map(({ key }) => [key, 0]));
  powerTargets.forEach((device) => {
    SUMMARY_FILTERS.forEach(({ key }) => {
      if (deviceMatchesFilter(device, key)) counts[key] += 1;
    });
  });
  return counts;
}

function summaryChipsHtml(counts = summaryCounts()) {
  return SUMMARY_FILTERS.map(({ key, label, tone }) => `
    <button type="button" class="st-power-summary-item${tone ? ` ${tone}` : ''}"
      data-power-filter="${key}" aria-pressed="${key === activeFilter}"
      title="Показать устройства: ${label}">
      <span>${label}</span><strong>${counts[key]}</strong>
    </button>`).join('');
}

function rowHtml(device) {
  const id = device.device_id;
  const name = device.name || id;
  const model = device.model ? String(device.model) : '';
  const android = device.android ? ` / Android ${escapeHtml(String(device.android))}` : '';
  const ip = device.ipAddress || '';
  const badge = badgeView(null);

  return `
    <div data-power-row="${escapeHtml(id)}" class="st-power-row">
      <span class="st-power-name">${escapeHtml(name)}${model ? ` <span class="st-power-model">(${escapeHtml(model)}${android})</span>` : ''}</span>
      <span class="meta st-power-ip">${escapeHtml(ip || 'IP не задан')}</span>
      <span data-power-badge="${escapeHtml(id)}" class="meta st-power-badge ${badge.cls}">${badge.text}</span>
      <span class="st-power-actions">
        <button type="button" class="secondary meta st-power-btn st-power-update" data-power-action="update-player" data-power-id="${escapeHtml(id)}" data-player-update="${escapeHtml(id)}" title="Обновить плеер" aria-label="Обновить плеер на ${escapeHtml(name)}" hidden>${getUpdateIcon(14)}</button>
        <button type="button" class="secondary meta st-power-btn" data-power-action="sleep" data-power-id="${escapeHtml(id)}" title="Усыпить устройство" aria-label="Усыпить ${escapeHtml(name)}">${getMoonIcon(14)}</button>
        <button type="button" class="secondary meta st-power-btn" data-power-action="wake" data-power-id="${escapeHtml(id)}" title="Разбудить и запустить плеер" aria-label="Разбудить ${escapeHtml(name)}">${getSunIcon(14)}</button>
        <button type="button" class="secondary meta st-power-btn" data-power-action="launch" data-power-id="${escapeHtml(id)}" title="Запустить плеер" aria-label="Запустить плеер на ${escapeHtml(name)}">${getPlayIcon(14)}</button>
        <button type="button" class="secondary meta st-power-btn" data-power-action="reboot" data-power-id="${escapeHtml(id)}" title="Перезагрузить устройство" aria-label="Перезагрузить ${escapeHtml(name)}">${getRestartIcon(14)}</button>
      </span>
    </div>`;
}

/** Обновляем снимок устройств из свежего списка без пересоздания карточки. */
function setPowerDevices(devices) {
  const list = Array.isArray(devices) ? devices : [];
  powerTargets = list.filter(isPowerControllable);
  deviceNames = new Map(list.map(device => [device.device_id, device.name || device.device_id]));
  playerVersions = new Map(list.map(device => [
    device.device_id,
    {
      currentVersion: device.appVersion || device.app_version || '',
      releaseVersion
    }
  ]));
}

/**
 * Вызывается после socket-события devices/updated: карточка настроек живёт в
 * DOM постоянно, поэтому её снимок устройств надо обновлять явно.
 */
export function syncPowerDevices(devices) {
  setPowerDevices(devices);
  if (document.getElementById('stPowerList')) fitPowerList();
}

/**
 * HTML карточки «Управление устройствами» для раздела настроек.
 * `bulkActionsHtml` — доверенная статическая разметка дополнительных кнопок
 * массовых действий (например, обновления плеера на всех устройствах).
 */
export function renderPowerControlsHtml(devices, { bulkActionsHtml = '' } = {}) {
  setPowerDevices(devices);
  page = 0;
  activeFilter = 'all';

  return `
    <div class="st-card st-card--power">
      <div class="st-card-h">
        ${getPowerIcon(16)}
        <span>Управление Android устройствами</span>
        <span id="stPowerStatus" class="st-status st-card-h-status"></span>
      </div>
      <div id="stPowerSummary" class="st-power-summary">${summaryChipsHtml()}</div>
      <div class="st-power-body">
        <div class="st-actions">
          <button type="button" id="stPowerSleepAll" class="secondary st-power-btn" title="Усыпить все" aria-label="Усыпить все">${getMoonIcon(14)}</button>
          <button type="button" id="stPowerWakeAll" class="primary st-power-btn" title="Разбудить все" aria-label="Разбудить все">${getSunIcon(14)}</button>
          <button type="button" id="stPowerWakeLaunch" class="secondary st-power-btn" title="Разбудить и запустить плеер" aria-label="Разбудить и запустить плеер">${getSunIcon(14)}</button>
          <button type="button" id="stPowerLaunchAll" class="primary st-power-btn" title="Запустить плеер везде" aria-label="Запустить плеер везде">${getPlayIcon(14)}</button>
          <button type="button" id="stPowerRebootAll" class="secondary st-power-btn" title="Перезагрузить все устройства" aria-label="Перезагрузить все устройства">${getRestartIcon(14)}</button>
          <button type="button" id="stPowerConstructor" class="secondary st-power-btn" title="Профили питания" aria-label="Профили питания">${getSlidersIcon(14)}</button>
          ${bulkActionsHtml}
        </div>
        <div id="stPowerList" class="st-power-list">${powerTargets.map(rowHtml).join('')}</div>
        <div id="stPowerPager" class="st-power-pager" hidden>
          <button type="button" id="stPowerPrev" class="secondary meta st-pager-btn" title="Предыдущая страница" aria-label="Предыдущая страница">${getChevronLeftIcon(14)}</button>
          <span id="stPowerPagerInfo"></span>
          <button type="button" id="stPowerNext" class="secondary meta st-pager-btn" title="Следующая страница" aria-label="Следующая страница">${getChevronRightIcon(14)}</button>
        </div>
      </div>
    </div>`;
}

/**
 * Вписывает список устройств в высоту карточки: если все ряды помещаются —
 * показывает их разом, иначе режет на страницы и включает пагинацию.
 *
 * Полный список рисуется каждый раз ради измерения: и высота строки, и сам
 * факт переполнения нужны до разбиения на страницы, а иначе высота контейнера
 * меряется уже по куску и получается порочный круг.
 */
function fitPowerList() {
  const list = document.getElementById('stPowerList');
  const pager = document.getElementById('stPowerPager');
  if (!list || !pager) return;

  const targets = powerTargets.filter(device => deviceMatchesFilter(device, activeFilter));
  if (!targets.length) {
    list.innerHTML = activeFilter === 'all'
      ? ''
      : '<div class="st-power-empty">Нет устройств с таким статусом</div>';
    pager.hidden = true;
    updateBadges();
    return;
  }

  list.innerHTML = targets.map(rowHtml).join('');
  const available = list.clientHeight;
  if (!(available > 0)) {
    // Контейнер не разложен (скрытая секция, измерения невозможны) —
    // показываем все ряды сразу, пагинация включится при реальном ресайзе.
    pager.hidden = true;
    updateBadges();
    return;
  }
  const rowHeight = (list.firstElementChild?.offsetHeight || 0) + LIST_GAP;
  const fitCount = rowHeight > 0
    ? Math.max(1, Math.floor((available + LIST_GAP) / rowHeight))
    : targets.length;
  const perPage = Math.min(targets.length, fitCount);
  const totalPages = Math.ceil(targets.length / perPage);

  if (totalPages <= 1) {
    page = 0;
    pager.hidden = true;
  } else {
    if (page > totalPages - 1) page = totalPages - 1;
    if (page < 0) page = 0;
    const from = page * perPage;
    list.innerHTML = targets.slice(from, from + perPage).map(rowHtml).join('');
    pager.hidden = false;
    const info = document.getElementById('stPowerPagerInfo');
    if (info) info.textContent = `${page + 1} / ${totalPages}`;
  }

  updateBadges();
}

/** Пересчёт после изменения размеров: ResizeObserver шлёт пачками, гасим rAF. */
function scheduleFit() {
  if (fitRaf) return;
  fitRaf = requestAnimationFrame(() => {
    fitRaf = 0;
    fitPowerList();
  });
}

/** Пересчёт после показа карточки, которая была скрыта деревом настроек. */
export function refreshPowerControlsLayout() {
  scheduleFit();
}

/** Отписка от ресайзов — вызывается при удалении секции настроек. */
export function stopPowerControls() {
  if (listObserver) {
    listObserver.disconnect();
    listObserver = null;
  }
  if (fitRaf) {
    cancelAnimationFrame(fitRaf);
    fitRaf = 0;
  }
}

function updatePlayerUpdateButtons() {
  document.querySelectorAll('[data-player-update]').forEach((el) => {
    const id = el.getAttribute('data-player-update');
    const versions = playerVersions.get(id) || {};
    const available = updateAvailable(id);
    const current = normalizeVersion(versions.currentVersion);
    const from = current ? `v${current}` : 'версия неизвестна';
    const title = available
      ? `Обновить плеер: ${from} → v${releaseVersion} (настройки сохранятся)`
      : releaseVersion
        ? `Плеер уже на версии v${releaseVersion}`
        : 'Обновить плеер';

    // Актуальная версия — кнопку вообще не показываем.
    el.hidden = !available;
    el.classList.toggle('st-power-update--available', available);
    el.title = title;
    el.setAttribute('aria-label', `${title} на ${deviceNames.get(id) || id}`);
  });
}

/** Сводка по устройствам: те же счётчики, что работают в фильтрах списка. */
function updateSummary() {
  const el = document.getElementById('stPowerSummary');
  if (!el) return;

  const counts = summaryCounts();
  let chips = el.querySelectorAll('[data-power-filter]');
  if (!chips.length) {
    el.innerHTML = summaryChipsHtml(counts);
    chips = el.querySelectorAll('[data-power-filter]');
  }

  chips.forEach((chip) => {
    const key = chip.getAttribute('data-power-filter');
    const value = chip.querySelector('strong');
    if (value) value.textContent = String(counts[key] ?? 0);
    const selected = key === activeFilter;
    chip.classList.toggle('is-selected', selected);
    chip.setAttribute('aria-pressed', String(selected));
  });
}

function updateBadges() {
  document.querySelectorAll('[data-power-badge]').forEach((el) => {
    const badge = badgeView(powerStates.get(el.getAttribute('data-power-badge')));
    el.textContent = badge.text;
    el.className = `meta st-power-badge ${badge.cls}`;
  });
  updatePlayerUpdateButtons();
  updateSummary();
  applyBusyState();
}

/**
 * После смены состояния/версии список надо пересобрать только при активном
 * фильтре: при «Всего» состав строк не меняется, а при фильтре устройство
 * может войти в выборку или выйти из неё.
 */
function syncAfterStatusChange() {
  updateBadges();
  if (activeFilter !== 'all') fitPowerList();
}

const BUSY_SELECTOR = [
  '#stPowerList [data-power-action]',
  '#stPowerSleepAll',
  '#stPowerWakeAll',
  '#stPowerWakeLaunch',
  '#stPowerLaunchAll',
  '#stPowerRebootAll',
  '#stApkBatch',
  '#stPowerPrev',
  '#stPowerNext'
].join(', ');

/** Список перерисовывается при смене фильтра — состояние кнопок храним в модуле. */
function applyBusyState() {
  document.querySelectorAll(BUSY_SELECTOR).forEach((button) => {
    button.disabled = busy;
  });
}

/** Блокирует все элементы управления обновлением/питанием на время команды. */
export function setPowerBusy(value) {
  busy = Boolean(value);
  applyBusyState();
}

function setBusy(value) {
  setPowerBusy(value);
}

function setStatus(text) {
  const el = document.getElementById('stPowerStatus');
  if (el) el.textContent = text || '';
}

/**
 * Итог bulk-команды уходит в раздел «Уведомления» (а оттуда — тостом и в
 * бейдж по сокету). Прямой локальный тост не показываем: уведомление живёт
 * на сервере, переживает рестарт и видно всем админам.
 */
async function reportPowerResult(adminFetch, { ok, message, title }) {
  try {
    await adminFetch('/api/notifications/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'device_power',
        severity: ok ? 'info' : 'warning',
        title: title || (ok ? 'Управление питанием' : 'Не все устройства отреагировали'),
        message,
        source: 'admin-ui'
      })
    });
  } catch (_) {
    // уведомление — приятное дополнение, без него не должно падать всё остальное
  }
}

/** Состояние, пришедшее по сокету после команды питания в другой вкладке. */
export function applyPowerState(payload) {
  if (!payload || !payload.deviceId) return;
  const awake = payload.awake;
  if (awake === null || awake === undefined) {
    // Устройство ушло в офлайн: состояние неизвестно, показываем «нет ответа».
    powerStates.set(payload.deviceId, { ok: false, awake: null });
  } else {
    powerStates.set(payload.deviceId, { ok: true, awake: !!awake });
  }
  syncAfterStatusChange();
}

async function refreshStates(adminFetch, deviceIds) {
  try {
    const response = await adminFetch(STATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds })
    });
    if (!response.ok) return;
    const data = await response.json();
    for (const state of data.states || []) {
      powerStates.set(state.deviceId, { ok: state.ok, awake: state.awake });
    }
    syncAfterStatusChange();
  } catch (_) {
    // недоступный опрос состояния не должен ломать раздел настроек
  }
}

/**
 * Версия, которую поставит кнопка обновления: сначала выбранная в настройках,
 * затем последний релиз GitHub, затем уже установленная на сервере APK.
 */
export async function refreshPlayerVersions(adminFetch) {
  try {
    const response = await adminFetch(APK_VERSION_ENDPOINT);
    if (!response?.ok) return;
    const data = await response.json();
    releaseVersion = normalizeVersion(
      data.selectedVersion || data.latestVersion || data.installedVersion || data.version
    );

    for (const device of powerTargets) {
      const versions = playerVersions.get(device.device_id) || {};
      playerVersions.set(device.device_id, {
        currentVersion: versions.currentVersion || device.appVersion || device.app_version || '',
        releaseVersion
      });
    }
    syncAfterStatusChange();
  } catch (_) {
    // Недоступный GitHub не должен ломать карточку: просто не подсвечиваем.
  }
}

async function runPlayerUpdate(adminFetch, deviceId) {
  setBusy(true);
  setStatus('Обновление плеера...');
  try {
    const response = await adminFetch(PLAYER_UPDATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds: [deviceId] })
    });
    const data = await response.json().catch(() => ({}));
    const name = deviceNames.get(deviceId) || deviceId;

    if (!response.ok || data.ok === false) {
      const message = data.error || 'Не удалось обновить плеер';
      setStatus(message);
      await reportPowerResult(adminFetch, {
        ok: false,
        message: `${name}: ${message}`,
        title: 'Обновление плеера'
      });
      return;
    }

    // После успешной установки устройство перерегистрируется с новой версией,
    // но подсветку снимаем сразу, не дожидаясь socket-события.
    const versions = playerVersions.get(deviceId) || {};
    playerVersions.set(deviceId, {
      ...versions,
      currentVersion: releaseVersion || versions.currentVersion
    });
    syncAfterStatusChange();

    const message = `Плеер обновлён: ${name}`;
    setStatus(message);
    await reportPowerResult(adminFetch, { ok: true, message, title: 'Обновление плеера' });
  } catch (error) {
    setStatus(error.message);
    await reportPowerResult(adminFetch, {
      ok: false,
      message: error.message,
      title: 'Обновление плеера'
    });
  } finally {
    setBusy(false);
  }
}

function summarize(action, results, summary) {
  const verb = action === 'sleep' ? 'Усыплено'
    : action === 'launch' ? 'Плеер запущен'
    : action === 'reboot' ? 'Перезагружено'
    : 'Пробуждено';
  const failed = results.filter(result => !result.ok);

  if (!summary.total) {
    return { ok: true, message: 'Нет Android-устройств для управления' };
  }

  let message = `${verb} ${summary.succeeded} из ${summary.total}`;
  if (failed.length) {
    const names = failed.map(result => deviceNames.get(result.deviceId) || result.deviceId);
    message += ` · не сработало: ${names.join(', ')}`;
  }
  return { ok: failed.length === 0, message };
}

async function runPower(adminFetch, action, options = {}) {
  const body = { action };
  if (options.deviceIds) body.deviceIds = options.deviceIds;
  if (options.relaunch !== undefined) body.relaunch = options.relaunch;

  setBusy(true);
  setStatus('Выполняется...');
  try {
    const response = await adminFetch(POWER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error || 'Ошибка выполнения команды';
      setStatus(message);
      await reportPowerResult(adminFetch, { message, ok: false });
      return;
    }

    for (const result of data.results || []) {
      if (result.ok) {
        // Перезапуск плеера (launch) и перезагрузка (reboot) режим питания не
        // меняют — спит/активен оставляем как было, бейдж не трогаем.
        if (action !== 'launch' && action !== 'reboot') {
          powerStates.set(result.deviceId, { ok: true, awake: result.awake !== undefined ? result.awake : action === 'wake' });
        }
      } else {
        powerStates.set(result.deviceId, { ok: false, awake: null });
      }
    }
    syncAfterStatusChange();

    const summary = summarize(action, data.results || [], data.summary || { total: 0, succeeded: 0 });
    setStatus(summary.message);
    await reportPowerResult(adminFetch, summary);
  } catch (error) {
    setStatus(error.message);
    await reportPowerResult(adminFetch, { message: error.message, ok: false });
  } finally {
    setBusy(false);
  }
}

/**
 * Вешает обработчики на карточку и запрашивает текущее состояние питания.
 *
 * @param {{devices: Array, adminFetch: Function}} deps
 */
export function initPowerControls({ devices, adminFetch }) {
  const list = document.getElementById('stPowerList');
  if (!list) return;

  setPowerDevices(devices);
  page = 0;
  activeFilter = 'all';

  // Фильтры в сводке: слушатель на контейнере, чипы при этом не пересоздаются.
  document.getElementById('stPowerSummary')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-power-filter]');
    if (!chip || !chip.closest('#stPowerSummary')) return;
    activeFilter = chip.getAttribute('data-power-filter') || 'all';
    page = 0;
    fitPowerList();
  });

  document.getElementById('stPowerSleepAll')?.addEventListener('click', () => {
    runPower(adminFetch, 'sleep', { relaunch: false });
  });
  document.getElementById('stPowerWakeAll')?.addEventListener('click', () => {
    runPower(adminFetch, 'wake', { relaunch: false });
  });
  document.getElementById('stPowerWakeLaunch')?.addEventListener('click', () => {
    runPower(adminFetch, 'wake', { relaunch: true });
  });
  document.getElementById('stPowerLaunchAll')?.addEventListener('click', () => {
    runPower(adminFetch, 'launch');
  });
  document.getElementById('stPowerRebootAll')?.addEventListener('click', () => {
    runPower(adminFetch, 'reboot', { relaunch: false });
  });

  // Строки перерисовываются при пагинации, поэтому вешаемся на список,
  // а не на каждую кнопку: слушатель живёт ровно столько, сколько DOM.
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-power-action]');
    if (!button || !list.contains(button)) return;
    const action = button.getAttribute('data-power-action');

    if (action === 'update-player') {
      runPlayerUpdate(adminFetch, button.getAttribute('data-power-id'));
      return;
    }

    runPower(adminFetch, action, {
      deviceIds: [button.getAttribute('data-power-id')],
      relaunch: action === 'wake'
    });
  });

  document.getElementById('stPowerPrev')?.addEventListener('click', () => {
    page -= 1;
    fitPowerList();
  });
  document.getElementById('stPowerNext')?.addEventListener('click', () => {
    page += 1;
    fitPowerList();
  });

  if (listObserver) listObserver.disconnect();
  // Без ResizeObserver (jsdom/старые среды) просто не пересчитываем по ресайзу.
  listObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleFit) : null;
  listObserver?.observe(list);
  fitPowerList();

  if (powerTargets.length) {
    refreshStates(adminFetch, powerTargets.map(target => target.device_id));
    refreshPlayerVersions(adminFetch);
  } else {
    setStatus('Нет Android-устройств');
  }
}
