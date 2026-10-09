/**
 * Управление питанием Android-приставок из настроек админа.
 *
 * Приставки встроены в стену, их нельзя обесточить, поэтому здесь только
 * сон и пробуждение (сервер шлёт KEYCODE_SLEEP/KEYCODE_WAKEUP, а если
 * устройство в сне выпало из сети — будит его Wake-on-LAN пакетом).
 *
 * Карточка живёт в разделе «Настройки сервера» → «Управление устройствами»,
 * список плиток устройств она не засоряет.
 *
 * @module admin/device-power
 */

import { escapeHtml } from '../shared/utils.js';
import { getPowerIcon, getSunIcon, getMoonIcon, getPlayIcon, getChevronLeftIcon, getChevronRightIcon } from '../shared/svg-icons.js';

const POWER_ENDPOINT = '/api/devices/power';
const STATE_ENDPOINT = '/api/devices/power-state';

/** deviceId → {ok, awake}. Живёт дольше рендера карточки. */
const powerStates = new Map();
let deviceNames = new Map();

/** Управляемые устройства текущей карточки, текущая страница списка. */
let powerTargets = [];
let page = 0;
let listObserver = null;
let fitRaf = 0;

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

function rowHtml(device) {
  const id = device.device_id;
  const name = device.name || id;
  const ip = device.ipAddress || '';
  const badge = badgeView(null);

  return `
    <div data-power-row="${escapeHtml(id)}" class="st-power-row">
      <span class="st-power-name">${escapeHtml(name)}</span>
      <span class="meta st-power-ip">${escapeHtml(ip || 'IP не задан')}</span>
      <span data-power-badge="${escapeHtml(id)}" class="meta st-power-badge ${badge.cls}">${badge.text}</span>
      <span class="st-power-actions">
        <button type="button" class="secondary meta st-power-btn" data-power-action="sleep" data-power-id="${escapeHtml(id)}" title="Усыпить устройство" aria-label="Усыпить ${escapeHtml(name)}">${getMoonIcon(14)}</button>
        <button type="button" class="secondary meta st-power-btn" data-power-action="wake" data-power-id="${escapeHtml(id)}" title="Разбудить и запустить плеер" aria-label="Разбудить ${escapeHtml(name)}">${getSunIcon(14)}</button>
        <button type="button" class="secondary meta st-power-btn" data-power-action="launch" data-power-id="${escapeHtml(id)}" title="Завершить процесс плеера и открыть заново" aria-label="Запустить плеер на ${escapeHtml(name)}">${getPlayIcon(14)}</button>
      </span>
    </div>`;
}

/** HTML карточки «Управление устройствами» для раздела настроек. */
export function renderPowerControlsHtml(devices) {
  powerTargets = (devices || []).filter(isPowerControllable);
  page = 0;
  deviceNames = new Map((devices || []).map(device => [device.device_id, device.name || device.device_id]));

  return `
    <div class="st-card">
      <div class="st-card-h">
        ${getPowerIcon(16)}
        <span>Управление Android устройствами</span>
      </div>
      <div class="st-power-body">
        <div class="st-actions">
          <button type="button" id="stPowerSleepAll" class="secondary">${getMoonIcon(14)} Усыпить все</button>
          <button type="button" id="stPowerWakeAll" class="primary">${getSunIcon(14)} Разбудить все</button>
          <button type="button" id="stPowerWakeLaunch" class="secondary">${getSunIcon(14)} Разбудить и запустить плеер</button>
          <button type="button" id="stPowerLaunchAll" class="primary">${getPlayIcon(14)} Запустить плеер везде</button>
          <span id="stPowerStatus" class="st-status"></span>
        </div>
        <div id="stPowerList" class="st-power-list">${powerTargets.length ? powerTargets.map(rowHtml).join('') : '<div class="st-power-empty">Нет Android-устройств</div>'}</div>
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

  if (!powerTargets.length) {
    list.innerHTML = '<div class="st-power-empty">Нет Android-устройств</div>';
    pager.hidden = true;
    return;
  }

  list.innerHTML = powerTargets.map(rowHtml).join('');
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
    : powerTargets.length;
  const perPage = Math.min(powerTargets.length, fitCount);
  const totalPages = Math.ceil(powerTargets.length / perPage);

  if (totalPages <= 1) {
    page = 0;
    pager.hidden = true;
  } else {
    if (page > totalPages - 1) page = totalPages - 1;
    if (page < 0) page = 0;
    const from = page * perPage;
    list.innerHTML = powerTargets.slice(from, from + perPage).map(rowHtml).join('');
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

function updateBadges() {
  document.querySelectorAll('[data-power-badge]').forEach((el) => {
    const badge = badgeView(powerStates.get(el.getAttribute('data-power-badge')));
    el.textContent = badge.text;
    el.className = `meta st-power-badge ${badge.cls}`;
  });
}

function setBusy(busy) {
  const buttons = document.querySelectorAll('#stPowerList [data-power-action], #stPowerSleepAll, #stPowerWakeAll, #stPowerWakeLaunch, #stPowerLaunchAll, #stPowerPrev, #stPowerNext');
  buttons.forEach((button) => { button.disabled = busy; });
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
async function reportPowerResult(adminFetch, { ok, message }) {
  try {
    await adminFetch('/api/notifications/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'device_power',
        severity: ok ? 'info' : 'warning',
        title: ok ? 'Управление питанием' : 'Не все устройства отреагировали',
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
  powerStates.set(payload.deviceId, { ok: true, awake: !!payload.awake });
  updateBadges();
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
    updateBadges();
  } catch (_) {
    // недоступный опрос состояния не должен ломать раздел настроек
  }
}

function summarize(action, results, summary) {
  const verb = action === 'sleep' ? 'Усыплено'
    : action === 'launch' ? 'Плеер запущен'
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
        // Перезапуск плеера (launch) режим питания не меняет — спит/активен
        // оставляем как было, бейдж не трогаем.
        if (action !== 'launch') {
          powerStates.set(result.deviceId, { ok: true, awake: result.awake !== undefined ? result.awake : action === 'wake' });
        }
      } else {
        powerStates.set(result.deviceId, { ok: false, awake: null });
      }
    }
    updateBadges();

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

  powerTargets = (devices || []).filter(isPowerControllable);
  page = 0;

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

  // Строки перерисовываются при пагинации, поэтому вешаемся на список,
  // а не на каждую кнопку: слушатель живёт ровно столько, сколько DOM.
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-power-action]');
    if (!button || !list.contains(button)) return;
    runPower(adminFetch, button.getAttribute('data-power-action'), {
      deviceIds: [button.getAttribute('data-power-id')],
      relaunch: button.getAttribute('data-power-action') === 'wake'
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
  } else {
    setStatus('Нет Android-устройств');
  }
}
