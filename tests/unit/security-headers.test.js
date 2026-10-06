/**
 * Security-заголовки приложения.
 *
 * Раньше их не было совсем: не было helmet, CSP, HSTS, а X-Powered-By
 * отдавался по умолчанию. В nginx заголовки стояли только в http-блоке и
 * терялись в location, где есть свои add_header (/content/, /streams/,
 * /converted/trailers/), поэтому статика уходила без X-Frame-Options и nosniff.
 *
 * Заголовки проверяются здесь, в приложении: именно Express отвечает за
 * проксируемые ответы, а nginx — только за отдачу alias-путей.
 */
import express from 'express';
import { setupExpressMiddleware } from '../../src/middleware/express-config.js';

describe('security-заголовки', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    const app = express();
    setupExpressMiddleware(app);
    app.get('/probe', (req, res) => res.json({ ok: true }));

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('X-Powered-By отключён', async () => {
    const response = await fetch(`${baseUrl}/probe`);
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  test('базовые заголовки присутствуют', async () => {
    const response = await fetch(`${baseUrl}/probe`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
  });

  test('CSP разрешает только нужные источники скриптов', async () => {
    const response = await fetch(`${baseUrl}/probe`);
    const csp = response.headers.get('content-security-policy');

    expect(csp).not.toBeNull();
    expect(csp).toContain("script-src 'self' 'unsafe-inline' blob: https://cdn.jsdelivr.net");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");

    // Плеер грузит stream_url с внешнего CDN напрямую
    // (public/js/player-videojs.js), поэтому default-src/media-src/connect-src
    // должны отсутствовать — иначе видео перестанет играть.
    expect(csp).not.toContain('default-src');
    expect(csp).not.toContain('media-src');
    expect(csp).not.toContain('connect-src');
  });

  test('HSTS не выставляется по обычному HTTP', async () => {
    const response = await fetch(`${baseUrl}/probe`);
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  test('HSTS выставляется, когда запрос пришёл по HTTPS через прокси', async () => {
    const response = await fetch(`${baseUrl}/probe`, {
      headers: { 'X-Forwarded-Proto': 'https' }
    });
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });
});
