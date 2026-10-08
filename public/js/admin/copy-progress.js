/**
 * Прогресс переноса/копирования папки между устройствами.
 *
 * Копирование большой папки выполняется внутри одного HTTP-запроса и занимает
 * минуты: без карточки прогресса пользователь просто не видит, что происходит,
 * и перенос выглядит зависшим. Сервер шлёт события copy/progress|done|error,
 * здесь они превращаются в плавающую карточку со полосой; итог уходит в
 * раздел «Уведомления».
 *
 * @module admin/copy-progress
 */

const PHASE_LABELS = {
  prepare: 'Подготовка',
  storage: 'загрузка в хранилище',
  disk: 'копирование на диск'
};

/** opId → { el, bar, meta, title, route } */
const cards = new Map();
/** Завершённые операции: событие сокета и HTTP-ответ приходят оба, тост — один. */
const finished = new Set();

/** Уникальный идентификатор операции для сшивания HTTP-ответа и событий сокета. */
export function createCopyOpId() {
  return `copy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureStack() {
  let stack = document.querySelector('.copy-progress-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'copy-progress-stack';
    document.body.appendChild(stack);
  }
  return stack;
}

function actionLabel(action) {
  return action === 'move' ? 'Перенос папки' : 'Копирование папки';
}

function routeLabel(payload) {
  const from = payload.fromName || payload.from || '';
  const to = payload.toName || payload.to || '';
  const folder = payload.folder || '';
  return `${folder} · ${from} → ${to}`;
}

function createCard(payload) {
  const el = document.createElement('div');
  el.className = 'copy-progress-toast';
  el.dataset.opId = payload.opId || '';

  const title = document.createElement('div');
  title.className = 'copy-progress-toast__title';
  title.textContent = actionLabel(payload.action);

  const route = document.createElement('div');
  route.className = 'copy-progress-toast__route';
  route.textContent = routeLabel(payload);

  const bar = document.createElement('div');
  bar.className = 'copy-progress-toast__bar';
  const fill = document.createElement('span');
  bar.appendChild(fill);

  const meta = document.createElement('div');
  meta.className = 'copy-progress-toast__meta';
  meta.textContent = 'Подготовка…';

  el.append(title, route, bar, meta);
  ensureStack().appendChild(el);

  const card = { el, fill, meta, title };
  cards.set(payload.opId, card);
  return card;
}

function removeCard(opId) {
  const card = cards.get(opId);
  if (!card) return;
  card.el.remove();
  cards.delete(opId);
  if (cards.size === 0) {
    const stack = document.querySelector('.copy-progress-stack');
    if (stack) stack.remove();
  }
}

/** Показать карточку прогресса (создаёт, если её ещё нет). */
export function showCopyProgress(payload) {
  if (!payload || !payload.opId) return;
  if (finished.has(payload.opId)) return;
  if (!cards.has(payload.opId)) createCard(payload);
  updateCopyProgress(payload);
}

/** Обновить полосу и подпись. */
export function updateCopyProgress(payload) {
  if (!payload || !payload.opId) return;
  if (finished.has(payload.opId)) return;

  const card = cards.get(payload.opId) || createCard(payload);
  card.title.textContent = actionLabel(payload.action);
  card.el.querySelector('.copy-progress-toast__route').textContent = routeLabel(payload);

  const total = Number(payload.total) || 0;
  const done = Number(payload.done) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  card.fill.style.width = `${total > 0 ? percent : 0}%`;
  card.el.dataset.percent = String(percent);

  if (total > 0) {
    const phase = PHASE_LABELS[payload.phase] || '';
    card.meta.textContent = `${done} из ${total}${phase ? ` · ${phase}` : ''}`;
  } else {
    card.meta.textContent = 'Подготовка…';
  }
}

/**
 * Завершить операцию: убрать карточку и показать тост.
 *
 * Идемпотентно — итог приходит и из события сокета, и из HTTP-ответа,
 * а дублирующиеся тосты раздражают не меньше, чем их отсутствие.
 */
export function finishCopyProgress(payload) {
  if (!payload || !payload.opId) return false;
  const opId = payload.opId;

  removeCard(opId);

  if (finished.has(opId)) return false;
  finished.add(opId);

  const ok = payload.ok !== false;
  const title = ok ? actionLabel(payload.action) : 'Ошибка переноса';
  let message;
  if (ok) {
    message = `${payload.folder || ''}: ${payload.fromName || payload.from || ''} → ${payload.toName || payload.to || ''}`;
  } else {
    message = payload.error || 'Не удалось выполнить операцию';
  }

  // Итог уходит в раздел «Уведомления»: тост вернётся по сокету, запись
  // переживёт рестарт и будет видна всем админам, а не только инициатору.
  import('./notifications.js')
    .then(({ reportNotification }) => reportNotification({
      type: ok ? 'folder_transfer' : 'folder_transfer_error',
      severity: ok ? 'info' : 'critical',
      title,
      message: message.trim(),
      source: 'admin-ui'
    }))
    .catch(() => {});

  return true;
}
