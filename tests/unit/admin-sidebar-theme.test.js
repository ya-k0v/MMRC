/**
 * @jest-environment jsdom
 *
 * Кнопка смены темы в сайдбаре админки.
 * Раньше она жила в шапке, скрытой через style="display:none", поэтому
 * переключить тему было нечем. Проверяем, что кнопка появляется в сайдбаре,
 * переключает тему и переинициализируется после каждого render().
 */
import { jest } from '@jest/globals';

const mockAdminFetch = jest.fn();

jest.unstable_mockModule('../../public/js/admin/auth.js', () => ({
  adminFetch: (...args) => mockAdminFetch(...args),
  logout: jest.fn()
}));

const { createSidebar } = await import('../../public/js/admin/sidebar.js');

const USER = { username: 'admin', full_name: 'Ломаев Яков Викторович', role: 'admin' };
const KEY = 'vc_theme_admin';

const btn = () => document.querySelector('#adminSidebar #themeBtn');

async function build() {
  const sidebar = createSidebar({ adminFetch: mockAdminFetch, user: USER, onNavigate: jest.fn() });
  await sidebar.init();
  return sidebar;
}

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
  document.body.classList.remove('light');
  mockAdminFetch.mockResolvedValue({ ok: true, json: async () => ({ count: 0 }) });
});

it('кнопка темы присутствует в шапке сайдбара', async () => {
  await build();
  const el = btn();
  expect(el).not.toBeNull();
  expect(el.className).toBe('sidebar-icon-btn');
  expect(el.getAttribute('aria-label')).toBe('Переключить тему');
});

it('иконка проставлена сразу после рендера', async () => {
  await build();
  // тёмная тема по умолчанию → рисуется луна
  expect(btn().querySelector('svg')).not.toBeNull();
});

it('клик переключает тему и сохраняет выбор', async () => {
  await build();
  expect(document.body.classList.contains('light')).toBe(false);

  btn().click();

  expect(document.body.classList.contains('light')).toBe(true);
  expect(localStorage.getItem(KEY)).toBe('light');

  btn().click();
  expect(document.body.classList.contains('light')).toBe(false);
  expect(localStorage.getItem(KEY)).toBe('dark');
});

it('восстанавливает сохранённую тему при загрузке', async () => {
  localStorage.setItem(KEY, 'light');
  await build();
  expect(document.body.classList.contains('light')).toBe(true);
});

it('после повторного render() кнопка остаётся рабочей', async () => {
  const sidebar = await build();
  expect(btn()).not.toBeNull();

  // сворачивание сайдбара перерисовывает шапку целиком
  sidebar.toggle();
  sidebar.toggle();
  await Promise.resolve();

  const el = btn();
  expect(el).not.toBeNull();
  // обработчик и иконка обязаны быть на новом элементе, а не на старом
  expect(el.querySelector('svg')).not.toBeNull();

  el.click();
  expect(document.body.classList.contains('light')).toBe(true);
});