/**
 * Регрессия: красивые страницы 403/404/503 не показывались никогда.
 *
 * public/403.html и public/404.html существовали, но на них никто не
 * ссылался — неизвестный маршрут отваливался в стандартный «Cannot GET».
 * Страницу ошибки при этом обязательно нужно отдавать ТОЛЬКО навигации
 * браузера: JSON-клиенту нужен JSON, а <img> не отрисует HTML-разметку.
 */
import { wantsHtmlPage, errorPagePath, ERROR_PAGES } from '../../src/utils/error-pages.js';

const html = (extra = {}) => ({ headers: { accept: 'text/html,application/xhtml+xml', ...extra } });

describe('wantsHtmlPage', () => {
  test('навигация браузера получает красивую страницу', () => {
    expect(wantsHtmlPage({ path: '/some-page', ...html() })).toBe(true);
    expect(wantsHtmlPage({ path: '/', ...html() })).toBe(true);
  });

  test('API всегда получает JSON, даже с Accept: text/html', () => {
    expect(wantsHtmlPage({ path: '/api/devices/br002', ...html() })).toBe(false);
    expect(wantsHtmlPage({ path: '/api/files/resolve/x/1.png', ...html() })).toBe(false);
  });

  test('медиапотоки не получают HTML', () => {
    expect(wantsHtmlPage({ path: '/content/br002/photo.png', ...html() })).toBe(false);
    expect(wantsHtmlPage({ path: '/streams/video/index.m3u8', ...html() })).toBe(false);
    expect(wantsHtmlPage({ path: '/socket.io/?EIO=4', ...html() })).toBe(false);
    expect(wantsHtmlPage({ path: '/internal/metrics', ...html() })).toBe(false);
  });

  test('картинка не должна получать страницу ошибки', () => {
    // Вот сценарий бага: <img> на 503 получил бы HTML и остался битым
    expect(wantsHtmlPage({
      path: '/api/devices/br002/folder/Album/image/31',
      headers: { accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }
    })).toBe(false);
  });

  test('XHR и fetch без text/html — не навигация', () => {
    expect(wantsHtmlPage({
      path: '/whatever',
      headers: { accept: '*/*' },
      xhr: true
    })).toBe(false);
    expect(wantsHtmlPage({
      path: '/whatever',
      headers: { accept: 'text/html', 'x-requested-with': 'XMLHttpRequest' }
    })).toBe(false);
    expect(wantsHtmlPage({ path: '/whatever', headers: { accept: 'application/json' } })).toBe(false);
  });

  test('отсутствующий Accept трактуется как не-HTML', () => {
    expect(wantsHtmlPage({ path: '/x', headers: {} })).toBe(false);
    expect(wantsHtmlPage({ path: '/x', headers: {} })).toBe(false);
  });
});

describe('errorPagePath', () => {
  test('известные статусы мапятся на файлы', () => {
    expect(ERROR_PAGES[403]).toBe('403.html');
    expect(ERROR_PAGES[404]).toBe('404.html');
    expect(ERROR_PAGES[503]).toBe('503.html');
    expect(errorPagePath('/srv/public', 404)).toBe('/srv/public/404.html');
  });

  test('неизвестный статус падает явно, а не молча отдаёт мусор', () => {
    expect(() => errorPagePath('/srv/public', 418)).toThrow(/418/);
  });
});