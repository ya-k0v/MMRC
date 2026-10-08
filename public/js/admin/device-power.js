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
  if (!state) return { text: '—', background: 'rgba(148,163,184,0.12)', color: 'var(--muted)' };
  if (!state.ok) return { text: 'нет ответа', background: 'rgba(239,68,68,0.14)', color: '#ef4444' };
  if (state.awake) return { text: 'активен', background: 'rgba(34,197,94,0.14)', color: 'var(--success)' };
  return { text: 'спит', background: 'rgba(245,158,11,0.16)', color: '#f59e0b' };
}

function rowHtml(device) {
  const id = device.device_id;
  const name = device.name || id;
  const ip = device.ipAddress || '';
  const badge = badgeView(null);

  return `
    <div data-power-row="${escapeHtml(id)}" style="display:flex; align-items:center; gap:var(--space-sm); padding:6px 8px; border:1px solid var(--border); border-radius:var(--radius-sm); flex-wrap:wrap;">
      <span style="font-weight:500; font-size:0.85rem; flex:1 1 140px; min-width:0; word-break:break-word;">${escapeHtml(name)}</span>
      <span class="meta" style="font-size:0.75rem; color:var(--muted); flex:0 1 auto;">${escapeHtml(ip || 'IP не задан')}</span>
      <span data-power-badge="${escapeHtml(id)}" class="meta" style="font-size:0.7rem; padding:1px 8px; border-radius:999px; background:${badge.background}; color:${badge.color}; flex:none;">${badge.text}</span>
      <button type="button" class="secondary meta" data-power-action="sleep" data-power-id="${escapeHtml(id)}" style="font-size:0.75rem; padding:3px 10px; min-width:auto;">Усыпить</button>
      <button type="button" class="secondary meta" data-power-action="wake" data-power-id="${escapeHtml(id)}" title="Разбудить и запустить плеер" style="font-size:0.75rem; padding:3px 10px; min-width:auto;">Разбудить</button>
      <button type="button" class="secondary meta" data-power-action="launch" data-power-id="${escapeHtml(id)}" title="Завершить процесс плеера и открыть заново" style="font-size:0.75rem; padding:3px 10px; min-width:auto;">Запустить плеер</button>
    </div>`;
}

/** HTML карточки «Управление устройствами» для раздела настроек. */
export function renderPowerControlsHtml(devices) {
  powerTargets = (devices || []).filter(isPowerControllable);
  page = 0;
  deviceNames = new Map((devices || []).map(device => [device.device_id, device.name || device.device_id]));

  return `
    <div class="st-card" style="background:var(--panel-2); border:1px solid var(--border); border-radius:var(--radius-sm); overflow:hidden;">
      <div class="st-card-h" style="display:flex; align-items:center; gap:var(--space-sm); padding:var(--space-sm) var(--space-sm); background:var(--panel); border-bottom:1px solid var(--border); font-weight:600; font-size:0.9rem;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
        Управление устройствами
      </div>
      <div class="st-power-body">
        <div style="display:flex; gap:var(--space-sm); flex-wrap:wrap; align-items:center;">
          <button type="button" id="stPowerSleepAll" class="secondary">Усыпить все</button>
          <button type="button" id="stPowerWakeAll" class="primary">Разбудить все</button>
          <button type="button" id="stPowerWakeLaunch" class="secondary">Разбудить и запустить плеер</button>
          <button type="button" id="stPowerLaunchAll" class="primary">Запустить плеер везде</button>
          <span id="stPowerStatus" class="meta" style="font-size:0.8rem; min-height:1.2em;"></span>
        </div>
        <div id="stPowerList" class="st-power-list">${powerTargets.length ? powerTargets.map(rowHtml).join('') : '<div class="meta" style="font-size:0.8rem; color:var(--muted);">Нет Android-устройств</div>'}</div>
        <div id="stPowerPager" class="st-power-pager" hidden>
          <button type="button" id="stPowerPrev" class="secondary meta" style="min-width:auto; padding:2px 8px;" title="Предыдущая страница">‹</button>
          <span id="stPowerPagerInfo"></span>
          <button type="button" id="stPowerNext" class="secondary meta" style="min-width:auto; padding:2px 8px;" title="Следующая страница">›</button>
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
    list.innerHTML = '<div class="meta" style="font-size:0.8rem; color:var(--muted);">Нет Android-устройств</div>';
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
    el.style.background = badge.background;
    el.style.color = badge.color;
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

async function showToast({ message, ok }) {
  try {
    const { showToastNotification } = await import('./notifications.js');
    showToastNotification({
      id: `power-${Date.now()}`,
      title: ok ? 'Управление питанием' : 'Не все устройства отреагировали',
      message,
      severity: ok ? 'info' : 'warning',
      timestamp: Date.now()
    });
  } catch (_) {
    // тост — приятное дополнение, без него не должно падать всё остальное
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
      await showToast({ message, ok: false });
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
    await showToast(summary);
  } catch (error) {
    setStatus(error.message);
    await showToast({ message: error.message, ok: false });
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
