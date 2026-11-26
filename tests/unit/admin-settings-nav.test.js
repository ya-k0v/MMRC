/**
 * @jest-environment jsdom
 *
 * Дерево настроек админки: список разделов в средней колонке и переключение
 * правой панели. Проверяем и разметку, и поведение при клике.
 */
import { jest } from '@jest/globals';

const { renderSettingsNavHtml, initSettingsNav, DEFAULT_SETTINGS_PAGE } = await import('../../public/js/admin/settings-nav.js');

const ITEMS = [
  { id: 'system', label: 'Система', icon: '<svg data-icon="cpu"></svg>' },
  { id: 'storage', label: 'Хранилище', icon: '<svg data-icon="storage"></svg>' },
  { id: 'modules', label: 'Модули', icon: '<svg data-icon="modules"></svg>' }
];

function mount(items = ITEMS, options = {}) {
  document.body.innerHTML = `
    <div id="settings">
      ${renderSettingsNavHtml(items, options.activeId)}
      <div class="settings-pages">
        ${items.map(item => `<section class="settings-page" data-settings-page="${item.id}">${item.label}</section>`).join('')}
      </div>
    </div>`;
  return document.getElementById('settings');
}

const link = id => document.querySelector(`[data-settings-page-link="${id}"]`);
const page = id => document.querySelector(`[data-settings-page="${id}"]`);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('дерево настроек', () => {
  test('меню содержит все разделы, иконки не экранируются', () => {
    mount();

    expect(document.querySelectorAll('.settings-nav-item')).toHaveLength(3);
    expect(link('system').querySelector('svg[data-icon="cpu"]')).not.toBeNull();
    expect(link('system').textContent).toContain('Система');
  });

  test('по умолчанию активен первый раздел, остальные панели скрыты', () => {
    const root = mount();
    const onChange = jest.fn();
    initSettingsNav({ root, items: ITEMS, onChange });

    expect(DEFAULT_SETTINGS_PAGE).toBe('system');
    expect(link('system').classList.contains('is-active')).toBe(true);
    expect(link('system').getAttribute('aria-selected')).toBe('true');
    expect(page('system').hidden).toBe(false);
    expect(page('storage').hidden).toBe(true);
    expect(page('modules').hidden).toBe(true);
    expect(onChange).toHaveBeenCalledWith('system');
  });

  test('клик по разделу показывает только его панель', () => {
    const root = mount();
    const onChange = jest.fn();
    initSettingsNav({ root, items: ITEMS, onChange });

    link('modules').click();

    expect(page('system').hidden).toBe(true);
    expect(page('storage').hidden).toBe(true);
    expect(page('modules').hidden).toBe(false);
    expect(link('modules').classList.contains('is-active')).toBe(true);
    expect(link('modules').getAttribute('aria-selected')).toBe('true');
    expect(link('system').getAttribute('aria-selected')).toBe('false');
    expect(onChange).toHaveBeenLastCalledWith('modules');
  });

  test('неизвестный раздел не меняет выбранную панель', () => {
    const root = mount();
    const api = initSettingsNav({ root, items: ITEMS });

    expect(api.activate('unknown')).toBe(false);
    expect(api.getActive()).toBe('system');
    expect(page('system').hidden).toBe(false);
  });

  test('можно открыть нужный раздел программно', () => {
    const root = mount(ITEMS, { activeId: 'storage' });
    const api = initSettingsNav({ root, items: ITEMS, activeId: 'storage' });

    expect(api.getActive()).toBe('storage');
    expect(page('storage').hidden).toBe(false);

    expect(api.activate('modules')).toBe(true);
    expect(api.getActive()).toBe('modules');
    expect(page('storage').hidden).toBe(true);
    expect(page('modules').hidden).toBe(false);
  });
});
