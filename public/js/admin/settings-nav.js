/**
 * Дерево настроек админки: средняя колонка со списком разделов и переключение
 * правой панели. Карточки самих разделов остаются в DOM — скрываем только
 * неактивные, поэтому их фоновые опросы и обработчики не пересоздаются.
 * @module admin/settings-nav
 */

import { escapeHtml } from '../shared/utils.js';

export const DEFAULT_SETTINGS_PAGE = 'system';

/** Идентификаторы для связи role="tab" с role="tabpanel". */
function elementId(prefix, id) {
  return `${prefix}-${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

const tabId = (id) => elementId('settings-tab', id);
const panelId = (id) => elementId('settings-page', id);

/**
 * @param {Array<{id: string, label: string, icon?: string}>} items
 * @param {string} activeId
 * @returns {string} HTML меню разделов
 */
export function renderSettingsNavHtml(items, activeId = DEFAULT_SETTINGS_PAGE) {
  const pages = (Array.isArray(items) ? items : []).filter(Boolean);
  return `
    <nav class="settings-nav" aria-label="Разделы настроек">
      <div class="settings-nav-title">Разделы</div>
      <div class="settings-nav-list" role="tablist">
        ${pages.map((item) => {
          const active = item.id === activeId;
          return `<button type="button" class="settings-nav-item${active ? ' is-active' : ''}"
            id="${tabId(item.id)}"
            data-settings-page-link="${escapeHtml(item.id)}"
            role="tab" aria-selected="${active ? 'true' : 'false'}"
            aria-controls="${panelId(item.id)}"
            tabindex="${active ? '0' : '-1'}">
            <span class="settings-nav-icon">${item.icon || ''}</span>
            <span class="settings-nav-label">${escapeHtml(item.label)}</span>
          </button>`;
        }).join('')}
      </div>
    </nav>`;
}

/**
 * Вешает обработчики на меню и показывает только выбранную панель.
 *
 * @param {{root: HTMLElement, items: Array, activeId?: string, onChange?: Function}} options
 * @returns {{activate: Function, getActive: Function}|null}
 */
export function initSettingsNav({ root, items, activeId = DEFAULT_SETTINGS_PAGE, onChange } = {}) {
  const nav = root?.querySelector('.settings-nav');
  if (!nav) return null;

  const knownIds = new Set((Array.isArray(items) ? items : []).filter(Boolean).map(item => item.id));
  let current = activeId;

  function activate(id, focus = false) {
    if (!knownIds.has(id)) return false;
    current = id;

    nav.querySelectorAll('[data-settings-page-link]').forEach((button) => {
      const active = button.getAttribute('data-settings-page-link') === id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.setAttribute('tabindex', active ? '0' : '-1');
    });

    root.querySelectorAll('[data-settings-page]').forEach((page) => {
      const pageId = page.getAttribute('data-settings-page');
      page.hidden = pageId !== id;
      page.id = panelId(pageId);
      page.setAttribute('role', 'tabpanel');
      page.setAttribute('aria-labelledby', tabId(pageId));
    });

    if (focus) {
      const target = Array.from(nav.querySelectorAll('[data-settings-page-link]'))
        .find(button => button.getAttribute('data-settings-page-link') === id);
      target?.focus();
    }

    if (typeof onChange === 'function') onChange(id);
    return true;
  }

  nav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-settings-page-link]');
    if (!button || !nav.contains(button)) return;
    activate(button.getAttribute('data-settings-page-link'));
  });

  // Стандартная навигация по tablist: стрелки/Home/End переводят фокус
  // на следующий раздел. Без этого неактивные кнопки с tabindex="-1"
  // остаются недоступны с клавиатуры.
  nav.addEventListener('keydown', (event) => {
    const buttons = Array.from(nav.querySelectorAll('[data-settings-page-link]'));
    if (!buttons.length) return;
    const index = buttons.findIndex(button => button.getAttribute('data-settings-page-link') === current);
    if (index < 0) return;

    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;

    event.preventDefault();
    activate(buttons[next].getAttribute('data-settings-page-link'), true);
  });

  activate(current);
  return { activate, getActive: () => current };
}
