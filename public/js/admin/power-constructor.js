/**
 * «Конструктор профилей питания»: кнопка в карточке «Управление Android
 * устройствами» и модалка, где админ настраивает команды сна/пробуждения.
 *
 * Слева: уникальные модели из списка устройств и общие правила (профили, не
 * привязанные к найденной модели). Справа: профиль — фиксированное число шагов
 * сна и пробуждения, каждый шаг выбирается из выпадающего списка (каталог с
 * сервера). Любой шаг можно проверить на живом устройстве.
 *
 * Все профили — обычные строки в БД: создаются, правятся и удаляются одинаково.
 *
 * @module admin/power-constructor
 */

import { escapeHtml } from '../shared/utils.js';
import { showModal } from './modal.js';
import {
  getSlidersIcon,
  getCheckIcon,
  getCrossIcon,
  getTrashIcon,
  getMoonIcon,
  getSunIcon,
  getPlayIcon,
  getAndroidIcon,
  getPlusIcon
} from '../shared/svg-icons.js';
import { isPowerControllable } from './device-power.js';

const PROFILES_ENDPOINT = '/api/power-profiles';
const DEVICES_ENDPOINT = '/api/devices';

/** Сколько шагов сна и столько же шагов пробуждения предлагаем на профиль. */
const SLOT_COUNT = 3;

const ANDROID_VERSIONS = ['10', '11', '12', '13', '14'];

const state = {
  adminFetch: null,
  devices: [],
  profiles: [],
  catalog: [],
  models: [],
  selection: null,
  draft: null
};

function stepValue(step) {
  return typeof step === 'number' ? String(step) : String(step || '');
}

function stepLabel(step) {
  if (step === undefined || step === null || step === '') return '';
  return typeof step === 'number' ? `keyevent ${step}` : String(step);
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function keyFor(modelLower, android) {
  const base = slugify(modelLower) || `rule-${Date.now().toString(36)}`;
  return android ? `model-${base}-a${android}` : `model-${base}`;
}

function profileByKey(key) {
  return state.profiles.find(profile => profile.key === key) || null;
}

function buildModels() {
  const map = new Map();
  for (const device of state.devices.filter(isPowerControllable)) {
    const rawModel = String(device.model || '').trim();
    const lower = rawModel.toLowerCase();
    const key = lower || '__none__';
    if (!map.has(key)) {
      map.set(key, { key, title: rawModel || 'Без модели', modelLower: lower, devices: [], android: new Set() });
    }
    const entry = map.get(key);
    entry.devices.push(device);
    if (device.android) entry.android.add(String(device.android));
  }
  state.models = Array.from(map.values()).sort((a, b) => {
    if (a.key === '__none__') return 1;
    if (b.key === '__none__') return -1;
    return b.devices.length - a.devices.length;
  });
}

function foundModelSet() {
  return new Set(state.models.filter(model => model.modelLower).map(model => model.modelLower));
}

function profileForModel(modelLower) {
  if (!modelLower) return null;
  return state.profiles.find(profile => String(profile.model || '').toLowerCase() === modelLower) || null;
}

function ruleProfiles() {
  const found = foundModelSet();
  return state.profiles
    .filter(profile => {
      const model = String(profile.model || '').toLowerCase();
      return !model || !found.has(model);
    })
    .sort((a, b) => String(a.label || a.key).localeCompare(String(b.label || b.key), 'ru'));
}

function matchesAndroid(android, from, to) {
  if (!from && !to) return true;
  const match = String(android || '').trim().match(/^(\d+)/);
  if (!match) return false;
  const value = Number(match[1]);
  if (from && value < Number(from)) return false;
  if (to && value > Number(to)) return false;
  return true;
}

function scoreProfile(profile, ctx) {
  if (profile.deviceId && profile.deviceId !== ctx.deviceId) return 0;
  if (profile.model && (!ctx.model || !ctx.model.includes(String(profile.model).toLowerCase()))) return 0;
  if ((profile.androidFrom || profile.androidTo) && !matchesAndroid(ctx.android, profile.androidFrom, profile.androidTo)) return 0;
  const score = (profile.deviceId ? 8 : 0) + (profile.model ? 4 : 0) + (profile.androidFrom || profile.androidTo ? 2 : 0);
  return score || 1;
}

/** Шаблон нового профиля: самое близкое правило из БД (иначе любое catch-all). */
function resolveFallback(modelLower, android) {
  const ctx = { deviceId: '', model: String(modelLower || '').toLowerCase(), android: String(android || '') };
  let best = null;
  let bestScore = 0;
  for (const profile of state.profiles) {
    const score = scoreProfile(profile, ctx);
    if (score > bestScore) {
      bestScore = score;
      best = profile;
    }
  }
  if (best) return best;
  return state.profiles.find(profile => !profile.model && !profile.androidFrom && !profile.androidTo) || null;
}

function padSteps(list) {
  const out = (list || []).map(stepValue).slice(0, SLOT_COUNT);
  while (out.length < SLOT_COUNT) out.push('');
  return out;
}

function draftFromProfile(profile) {
  const android = profile.androidFrom && profile.androidFrom === profile.androidTo ? String(profile.androidFrom) : '';
  return {
    key: profile.key,
    label: profile.label || '',
    model: String(profile.model || ''),
    android,
    sleep: padSteps(profile.sleepSteps),
    wake: padSteps(profile.wakeSteps),
    keepAwake: padSteps(profile.keepAwakeSteps),
    priority: profile.priority || 0,
    notes: profile.notes || '',
    existing: true
  };
}

function draftForModel(modelLower) {
  const existing = profileForModel(modelLower);
  if (existing) return draftFromProfile(existing);
  const model = state.models.find(item => item.modelLower === modelLower);
  const android = model && model.android.size === 1 ? Array.from(model.android)[0] : '';
  const fallback = resolveFallback(modelLower, android);
  return {
    key: '',
    label: model ? model.title : modelLower,
    model: modelLower,
    android,
    sleep: fallback ? padSteps(fallback.sleepSteps) : padSteps([]),
    wake: fallback ? padSteps(fallback.wakeSteps) : padSteps([]),
    keepAwake: fallback ? padSteps(fallback.keepAwakeSteps) : padSteps([]),
    priority: 0,
    notes: '',
    existing: false
  };
}

// ============================ Рендер ============================

function modelsListHtml() {
  if (!state.models.length) {
    return '<div class="meta pc-empty-steps">Android-приставок с определённой моделью в списке нет.</div>';
  }
  return state.models.map(model => {
    const selected = state.selection?.kind === 'model' && state.selection.key === model.key ? ' selected' : '';
    const hasProfile = Boolean(profileForModel(model.modelLower));
    const android = model.android.size ? ` · Android ${Array.from(model.android).join(', ')}` : '';
    const badge = hasProfile
      ? '<span class="pc-badge is-custom">свой профиль</span>'
      : '<span class="pc-badge is-default">по умолчанию</span>';
    return `
      <div data-pc-model="${escapeHtml(model.key)}" class="pc-profile-row${selected}">
        <div class="pc-profile-main">
          <span class="pc-profile-label">${escapeHtml(model.title)}</span>
          ${badge}
          <span class="meta pc-profile-binding">${model.devices.length} устр.${escapeHtml(android)}</span>
        </div>
      </div>`;
  }).join('');
}

function bindingLabel(profile) {
  if (profile.deviceId) return `устройство ${profile.deviceId}`;
  const model = profile.model ? `модель «${profile.model}»` : '';
  const android = profile.androidFrom
    ? (profile.androidTo && profile.androidTo !== profile.androidFrom ? `Android ${profile.androidFrom}–${profile.androidTo}` : `Android ${profile.androidFrom}`)
    : '';
  if (model && android) return `${model} + ${android}`;
  return model || android || 'любые устройства';
}

function rulesListHtml() {
  const rules = ruleProfiles();
  if (!rules.length) return '<div class="meta pc-empty-steps">Общих правил нет.</div>';
  return rules.map(profile => {
    const selected = state.selection?.kind === 'rule' && state.selection.key === profile.key ? ' selected' : '';
    return `
      <div data-pc-rule="${escapeHtml(profile.key)}" class="pc-profile-row${selected}">
        <div class="pc-profile-main">
          <span class="pc-profile-label">${escapeHtml(profile.label || profile.key)}</span>
          <span class="meta pc-profile-binding">${escapeHtml(bindingLabel(profile))}</span>
        </div>
      </div>`;
  }).join('');
}

function renderLists() {
  const modelsEl = document.getElementById('pcModelsList');
  if (modelsEl) modelsEl.innerHTML = modelsListHtml();
  const rulesEl = document.getElementById('pcRulesList');
  if (rulesEl) rulesEl.innerHTML = rulesListHtml();
}

/** Варианты модели в редакторе: модели проекта + текущая (если её нет в списке). */
function modelOptions(current) {
  const currentLower = String(current || '').toLowerCase();
  const seen = new Set(['']);
  const options = [{ value: '', label: '— общее правило (любые устройства) —' }];
  for (const model of state.models) {
    if (!model.modelLower || seen.has(model.modelLower)) continue;
    seen.add(model.modelLower);
    options.push({ value: model.modelLower, label: model.title });
  }
  if (currentLower && !seen.has(currentLower)) {
    options.push({ value: currentLower, label: currentLower });
  }
  return options
    .map(opt => `<option value="${escapeHtml(opt.value)}"${opt.value === currentLower ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`)
    .join('');
}

function selectOptions(phase, current) {
  const catalogPhase = phase === 'keep' ? 'after' : phase;
  const entries = state.catalog.filter(entry => entry.phase === catalogPhase || entry.phase === 'both');
  const seen = new Set();
  const options = [];
  const push = (value, label) => {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label });
  };
  push('', '— не задано —');
  for (const entry of entries) push(stepValue(entry.value), `${stepLabel(entry.value)} — ${entry.label}`);
  if (current && !seen.has(current)) push(current, stepLabel(current));
  return options
    .map(opt => `<option value="${escapeHtml(opt.value)}"${opt.value === current ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`)
    .join('');
}

function slotHtml(phase, index, value) {
  return `
    <div class="pc-slot">
      <span class="pc-slot-num">${index + 1}</span>
      <select class="input pc-slot-select" data-phase="${phase}" data-slot="${index}">
        ${selectOptions(phase, value)}
      </select>
      <button type="button" class="secondary meta pc-slot-test" data-phase="${phase}" data-slot="${index}" title="Проверить на устройстве">${getPlayIcon(12)}</button>
    </div>`;
}

function renderRepDevices() {
  const select = document.getElementById('pcRepDevice');
  if (!select) return;
  const lower = String(state.draft?.model || '').toLowerCase();
  const controllable = state.devices.filter(device => isPowerControllable(device) && device.ipAddress);
  const matching = lower ? controllable.filter(device => String(device.model || '').toLowerCase().includes(lower)) : [];
  const list = matching.length ? matching : controllable;
  select.innerHTML = list
    .map(device => `<option value="${escapeHtml(device.device_id)}">${escapeHtml(device.name || device.device_id)} — ${escapeHtml(device.model || 'без модели')}${device.android ? ` / Android ${escapeHtml(String(device.android))}` : ''}</option>`)
    .join('');
}

function renderEditor() {
  const editor = document.getElementById('pcEditor');
  const draft = state.draft;
  if (!editor || !draft) return;

  document.getElementById('pcEditorTitle').textContent = draft.label || draft.model || 'Общее правило';
  document.getElementById('pcLabel').value = draft.label || '';
  document.getElementById('pcModelSelect').innerHTML = modelOptions(draft.model);
  document.getElementById('pcAndroid').value = draft.android || '';
  document.getElementById('pcPriority').value = String(draft.priority || 0);
  document.getElementById('pcNotes').value = draft.notes || '';

  document.getElementById('pcSleepSlots').innerHTML = draft.sleep.map((value, index) => slotHtml('sleep', index, value)).join('');
  document.getElementById('pcWakeSlots').innerHTML = draft.wake.map((value, index) => slotHtml('wake', index, value)).join('');
  document.getElementById('pcKeepSlots').innerHTML = (draft.keepAwake || []).map((value, index) => slotHtml('keep', index, value)).join('');

  const deleteBtn = document.getElementById('pcDelete');
  deleteBtn.style.display = draft.existing ? '' : 'none';
  editor.style.display = '';

  renderRepDevices();
}

function selectModel(modelKey) {
  state.selection = { kind: 'model', key: modelKey };
  const model = state.models.find(item => item.key === modelKey);
  state.draft = draftForModel(model ? model.modelLower : '');
  renderLists();
  renderEditor();
  setTestStatus('');
}

function selectRule(profileKey) {
  const profile = profileByKey(profileKey);
  if (!profile) return;
  state.selection = { kind: 'rule', key: profileKey };
  state.draft = draftFromProfile(profile);
  renderLists();
  renderEditor();
  setTestStatus('');
}

// ============================ Действия ============================

function collectDraftFromForm() {
  const draft = state.draft;
  if (!draft) return;
  draft.label = document.getElementById('pcLabel')?.value.trim() || '';
  draft.model = (document.getElementById('pcModelSelect')?.value.trim() || '').toLowerCase();
  draft.android = document.getElementById('pcAndroid')?.value || '';
  const priority = Number.parseInt(document.getElementById('pcPriority')?.value || '0', 10);
  draft.priority = Number.isFinite(priority) ? Math.max(0, Math.min(100, priority)) : 0;
  draft.notes = document.getElementById('pcNotes')?.value || '';
  draft.sleep = Array.from({ length: SLOT_COUNT }, (_, i) => document.querySelector(`.pc-slot-select[data-phase="sleep"][data-slot="${i}"]`)?.value || '');
  draft.wake = Array.from({ length: SLOT_COUNT }, (_, i) => document.querySelector(`.pc-slot-select[data-phase="wake"][data-slot="${i}"]`)?.value || '');
  draft.keepAwake = Array.from({ length: SLOT_COUNT }, (_, i) => document.querySelector(`.pc-slot-select[data-phase="keep"][data-slot="${i}"]`)?.value || '');
}

function stepsFromSlots(list) {
  return list.filter(value => value !== '').map(value => (/^\d+$/.test(value) ? Number(value) : value));
}

function stepFromValue(value) {
  return /^\d+$/.test(String(value)) ? Number(value) : String(value);
}

function setTestStatus(html, color) {
  const el = document.getElementById('pcTestStatus');
  if (!el) return;
  el.innerHTML = html || '';
  el.style.color = color || 'var(--muted)';
}

function currentRepDevice() {
  const id = document.getElementById('pcRepDevice')?.value || '';
  return state.devices.find(device => device.device_id === id) || null;
}

async function testSlot(phase, index, button) {
  collectDraftFromForm();
  const value = phase === 'sleep'
    ? state.draft.sleep[index]
    : phase === 'keep'
      ? state.draft.keepAwake[index]
      : state.draft.wake[index];
  if (!value) {
    setTestStatus('В этом слоте команда не выбрана.', 'var(--brand)');
    return;
  }
  const device = currentRepDevice();
  if (!device) {
    setTestStatus('Для проверки выберите устройство (у него должен быть IP).', 'var(--danger)');
    return;
  }
  if (!device.ipAddress) {
    setTestStatus(`У устройства «${escapeHtml(device.name || device.device_id)}» не задан IP.`, 'var(--danger)');
    return;
  }
  const action = phase === 'sleep' ? 'уснёт' : phase === 'keep' ? 'выполнит команду удержания' : 'проснётся';
  if (!confirm(`Отправить «${stepLabel(stepFromValue(value))}» на «${device.name || device.device_id}»?\nУстройство ${action}.`)) return;

  if (button) button.disabled = true;
  try {
    const response = await state.adminFetch(`${PROFILES_ENDPOINT}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: device.device_id, step: stepFromValue(value), phase: phase === 'sleep' ? 'sleep' : 'wake' })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setTestStatus(escapeHtml(data.error || 'Ошибка проверки'), 'var(--danger)');
      return;
    }
    const result = data.result || {};
    if (result.ok) {
      const stateText = result.awake === null || result.awake === undefined
        ? 'состояние не различимо'
        : (result.awake ? 'экран активен' : 'экран спит');
      setTestStatus(`${getCheckIcon(14, 'var(--success)')} Слот ${index + 1} сработал (${escapeHtml(stateText)})`, 'var(--success)');
    } else {
      setTestStatus(`${getCrossIcon(14, 'var(--danger)')} Слот ${index + 1} не сработал: ${escapeHtml(result.error || 'ожидаемого состояния экрана нет')}`, 'var(--danger)');
    }
  } catch (error) {
    setTestStatus(escapeHtml(error.message), 'var(--danger)');
  } finally {
    if (button) button.disabled = false;
  }
}

function reselect() {
  if (state.selection?.kind === 'model') {
    const model = state.models.find(item => item.key === state.selection.key);
    if (model) return selectModel(model.key);
    if (state.models.length) return selectModel(state.models[0].key);
  } else if (state.selection?.kind === 'rule') {
    const profile = profileByKey(state.selection.key);
    if (profile) return selectRule(profile.key);
  }
  renderLists();
}

async function saveDraft() {
  collectDraftFromForm();
  const draft = state.draft;
  if (!draft) return;
  if (!draft.label) {
    setTestStatus('Укажите название профиля.', 'var(--danger)');
    return;
  }
  const sleepSteps = stepsFromSlots(draft.sleep);
  const wakeSteps = stepsFromSlots(draft.wake);
  const keepAwakeSteps = stepsFromSlots(draft.keepAwake);
  if (!sleepSteps.length && !wakeSteps.length && !keepAwakeSteps.length) {
    setTestStatus('Задайте хотя бы одну команду сна, пробуждения или удержания.', 'var(--danger)');
    return;
  }
  const key = draft.existing
    ? draft.key
    : (draft.model ? keyFor(draft.model, draft.android || null) : `rule-${slugify(draft.label) || Date.now().toString(36)}`);
  const payload = {
    key,
    label: draft.label,
    model: draft.model || null,
    androidFrom: draft.android || null,
    androidTo: draft.android || null,
    sleepSteps,
    wakeSteps,
    keepAwakeSteps,
    priority: draft.priority,
    notes: draft.notes,
    source: 'admin-ui'
  };

  const btn = document.getElementById('pcSave');
  if (btn) { btn.disabled = true; btn.textContent = 'Сохранение...'; }
  try {
    const response = await state.adminFetch(PROFILES_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setTestStatus(escapeHtml(data.error || 'Ошибка сохранения'), 'var(--danger)');
      return;
    }
    await loadProfiles();
    reselect();
    setTestStatus('Профиль сохранён.', 'var(--success)');
  } catch (error) {
    setTestStatus(escapeHtml(error.message), 'var(--danger)');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Сохранить профиль'; }
  }
}

async function deleteProfile() {
  const draft = state.draft;
  if (!draft || !draft.existing) return;
  if (!confirm(`Удалить профиль «${draft.label || draft.key}»?`)) return;
  try {
    const response = await state.adminFetch(`${PROFILES_ENDPOINT}/${encodeURIComponent(draft.key)}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setTestStatus(escapeHtml(data.error || 'Ошибка удаления'), 'var(--danger)');
      return;
    }
    await loadProfiles();
    reselect();
    setTestStatus('Профиль удалён.', 'var(--success)');
  } catch (error) {
    setTestStatus(escapeHtml(error.message), 'var(--danger)');
  }
}

async function loadProfiles() {
  const response = await state.adminFetch(PROFILES_ENDPOINT);
  const data = await response.json().catch(() => ({ profiles: [] }));
  state.profiles = data.profiles || [];
}

async function loadCatalog() {
  const response = await state.adminFetch(`${PROFILES_ENDPOINT}/steps`);
  const data = await response.json().catch(() => ({ steps: [] }));
  state.catalog = data.steps || [];
}

async function loadDevices() {
  try {
    const response = await state.adminFetch(DEVICES_ENDPOINT);
    const data = await response.json().catch(() => []);
    if (Array.isArray(data)) state.devices = data;
  } catch {
    /* остаётся список, переданный при инициализации */
  }
}

function bindHandlers() {
  document.getElementById('pcSave')?.addEventListener('click', saveDraft);
  document.getElementById('pcDelete')?.addEventListener('click', deleteProfile);
  document.getElementById('pcModelSelect')?.addEventListener('change', () => {
    collectDraftFromForm();
    renderRepDevices();
  });

  document.getElementById('pcModelsList')?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-pc-model]');
    if (row) selectModel(row.getAttribute('data-pc-model'));
  });

  document.getElementById('pcRulesList')?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-pc-rule]');
    if (row) selectRule(row.getAttribute('data-pc-rule'));
  });

  const slotsHandler = (event) => {
    const test = event.target.closest('.pc-slot-test');
    if (test) testSlot(test.getAttribute('data-phase'), Number(test.getAttribute('data-slot')), test);
  };
  document.getElementById('pcSleepSlots')?.addEventListener('click', slotsHandler);
  document.getElementById('pcWakeSlots')?.addEventListener('click', slotsHandler);
  document.getElementById('pcKeepSlots')?.addEventListener('click', slotsHandler);
}

async function openConstructorModal() {
  setTestStatus('Загрузка...');
  await Promise.all([loadProfiles(), loadCatalog(), loadDevices()]);
  buildModels();

  const content = `
    <div class="pc-modal">
      <div id="pcTestStatus" class="meta pc-status"></div>

      <div id="pcLayout" class="pc-layout">
        <section class="pc-panel pc-panel--nav">
          <div class="pc-panel-h"><span>Модели устройств</span></div>
          <div id="pcModelsList" class="pc-profiles-list"></div>
          <div class="pc-panel-h pc-panel-h--sub"><span>Общие правила</span></div>
          <div id="pcRulesList" class="pc-profiles-list"></div>
        </section>

        <section class="pc-panel pc-panel--editor">
          <div class="pc-panel-h"><span>Профиль</span><strong id="pcEditorTitle">—</strong></div>
          <div id="pcEditor" class="pc-editor" style="display:none;">
          <div class="pc-fields">
            <label class="pc-field pc-field--wide">
              <span>Название</span>
              <input id="pcLabel" class="input" placeholder="Smart AIO TV" />
            </label>
            <label class="pc-field pc-field--wide">
              <span>Модель (пусто — общее правило)</span>
              <select id="pcModelSelect" class="input"></select>
            </label>
            <label class="pc-field">
              <span>Android</span>
              <select id="pcAndroid" class="input">
                <option value="">— любая —</option>
                ${ANDROID_VERSIONS.map(v => `<option value="${v}">${v}</option>`).join('')}
              </select>
            </label>
          </div>

          <div class="pc-toolbar">
            <label class="pc-toolbar-label">${getAndroidIcon(16)} Устройство для проверки</label>
            <select id="pcRepDevice" class="input pc-device-select" aria-label="Устройство для проверки"></select>
            <span class="meta pc-warn">Проверка отправляет команду на живое устройство — оно уснёт или проснётся.</span>
          </div>

          <div class="pc-steps">
            <div class="pc-panel-h">${getMoonIcon(14)} Команды сна</div>
            <div id="pcSleepSlots" class="pc-slots"></div>
          </div>

          <div class="pc-steps">
            <div class="pc-panel-h">${getSunIcon(14)} Команды пробуждения</div>
            <div id="pcWakeSlots" class="pc-slots"></div>
          </div>

          <div class="pc-steps">
            <div class="pc-panel-h">${getSlidersIcon(14)} Удержание после пробуждения</div>
            <div id="pcKeepSlots" class="pc-slots"></div>
            <div class="meta pc-hint">Скринсейвер и таймаут экрана сбрасываются перезагрузкой — команды удержания выполняются после каждого успешного пробуждения.</div>
          </div>

          <div class="pc-fields">
            <label class="pc-field">
              <span>Приоритет</span>
              <input id="pcPriority" class="input" type="number" min="0" max="100" value="0" />
            </label>
            <label class="pc-field pc-field--wide">
              <span>Заметки</span>
              <input id="pcNotes" class="input" placeholder="откуда взяты команды, что проверено" />
            </label>
          </div>

          <div class="pc-actions">
            <button type="button" id="pcSave" class="primary">${getPlusIcon(14)} Сохранить профиль</button>
            <button type="button" id="pcDelete" class="danger">${getTrashIcon(14)} Удалить профиль</button>
          </div>
          </div>
        </section>
      </div>
    </div>
  `;

  showModal(`${getSlidersIcon(18)} Профили питания`, content, { maxWidth: 'min(96vw, 1240px)' });

  bindHandlers();

  const rules = ruleProfiles();
  if (state.models.length) {
    const keep = state.models.find(item => item.key === state.selection?.key);
    selectModel(keep ? keep.key : state.models[0].key);
  } else if (rules.length) {
    selectRule(rules[0].key);
  } else {
    renderLists();
  }
}

export function initPowerConstructor({ adminFetch, devices }) {
  state.adminFetch = adminFetch;
  state.devices = Array.isArray(devices) ? devices : [];

  document.getElementById('stPowerConstructor')?.addEventListener('click', () => {
    void openConstructorModal();
  });
}

export function stopPowerConstructor() {
  state.draft = null;
  state.selection = null;
}