/**
 * Дерево настроек админки: средняя колонка со списком разделов и переключение
 * правой панели. Карточки самих разделов остаются в DOM — скрываем только
 * неактивные, поэтому их фоновые опросы и обработчики не пересоздаются.
 * @module admin/settings-nav
 */

import { escapeHtml } from '../shared/utils.js';

export const DEFAULT_SETTINGS_PAGE = 'system';

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
            data-settings-page-link="${escapeHtml(item.id)}"
            role="tab" aria-selected="${active ? 'true' : 'false'}" tabindex="${active ? '0' : '-1'}">
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

  function activate(id) {
    if (!knownIds.has(id)) return false;
    current = id;

    nav.querySelectorAll('[data-settings-page-link]').forEach((button) => {
      const active = button.getAttribute('data-settings-page-link') === id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.setAttribute('tabindex', active ? '0' : '-1');
    });

    root.querySelectorAll('[data-settings-page]').forEach((page) => {
      page.hidden = page.getAttribute('data-settings-page') !== id;
    });

    if (typeof onChange === 'function') onChange(id);
    return true;
  }

  nav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-settings-page-link]');
    if (!button || !nav.contains(button)) return;
    activate(button.getAttribute('data-settings-page-link'));
  });

  activate(current);
  return { activate, getActive: () => current };
}
