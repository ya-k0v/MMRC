/**
 * @module utils/error-pages
 * Логика выбора красивой страницы ошибки вместо стандартных ответов Express.
 *
 * Раньше public/403.html, public/404.html и maintenance.html были просто
 * файлами: на них никто не ссылался, поэтому неизвестный маршрут отваливался
 * в стандартный «Cannot GET /...», а страницы ошибок не показывались никогда.
 */

import path from 'node:path';

export const ERROR_PAGES = {
  403: '403.html',
  404: '404.html',
  503: '503.html'
};

/**
 * Показывать ли красивую HTML-страницу, или нужен JSON/текст.
 *
 * Ключевое ограничение: HTML отдаётся ТОЛЬКО навигации браузера. Для /api/*,
 * картинок и прочих XHR нужен JSON, иначе клиент упадёт на res.json(), а
 * <img> вместо файла получит страницу с номером ошибки.
 *
 * @param {{ path: string, headers: Record<string,string|undefined>, xhr?: boolean }} req
 * @returns {boolean}
 */
export function wantsHtmlPage(req) {
  const urlPath = req.path || '';
  if (
    urlPath.startsWith('/api/') ||
    urlPath.startsWith('/socket.io/') ||
    urlPath.startsWith('/content/') ||
    urlPath.startsWith('/streams/') ||
    urlPath.startsWith('/internal/')
  ) {
    return false;
  }

  const accept = req.headers?.accept || '';
  if (!accept.includes('text/html')) return false;

  // XHR/fetch с X-Requested-With — не навигация
  if (req.xhr || req.headers?.['x-requested-with']) return false;

  return true;
}

/**
 * Абсолютный путь к файлу страницы ошибки.
 * @param {string} publicDir
 * @param {number} status
 * @returns {string}
 */
export function errorPagePath(publicDir, status) {
  const file = ERROR_PAGES[status];
  if (!file) throw new Error(`Нет страницы ошибки для статуса ${status}`);
  return path.join(publicDir, file);
}