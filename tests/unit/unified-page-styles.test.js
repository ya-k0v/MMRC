/**
 * Регрессия единого стиля страниц (кроме hero, картотеки и speaker).
 *
 * Эталон — админская шкала 36/32/24px. app.css — единственный источник
 * токенов, остальные страницы и CSS-файлы должны использовать эти токены,
 * а не собственные хардкод-значения и старые fallback-палитры.
 */
import fs from 'node:fs';
import path from 'node:path';

const read = (file) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

const appCss = read('public/css/app.css');
const adminCss = read('public/css/admin.css');
const statusCss = read('public/css/status.css');
const analyticsJs = read('public/js/analytics.js');
const playerHtml = read('public/player-videojs.html');

describe('канонические токены', () => {
  test('app.css задаёт basic/compact/icon и touch-таргеты', () => {
    expect(appCss).toContain('--control-height: 36px');
    expect(appCss).toContain('--control-height-sm: 32px');
    expect(appCss).toContain('--control-height-icon: 24px');
    expect(appCss).toContain('--control-height-touch: 40px');
    expect(appCss).toContain('--control-height-sm-touch: 36px');
    expect(appCss).toContain('--control-height-icon-touch: 36px');
  });

  test('старые имена остаются алиасами и не ломают существующие правила', () => {
    expect(appCss).toContain('--button-height: var(--control-height)');
    expect(appCss).toContain('--button-padding: var(--control-padding)');
  });

  test('базовые контролы используют токены', () => {
    expect(appCss).toMatch(/button\s*\{[^}]*height:\s*var\(--control-height\)/s);
    expect(appCss).toContain('.input {');
    expect(appCss).toMatch(/\.input\s*\{[^}]*min-height:\s*var\(--control-height\)/s);
    expect(appCss).toContain('button.icon-btn');
    expect(appCss).toContain('button.toolbar-icon-btn');
    expect(appCss).toContain('button.full-width');
  });

  test('админка не содержит хардкод высот контролов', () => {
    expect(adminCss).not.toMatch(/(min-height|height|width|min-width):\s*(24|28|32|36|40|44)px/);
    expect(adminCss).toContain('var(--control-height-icon)');
  });
});

describe('разметка страниц', () => {
  test('инлайн-стили размеров и палитр вынесены в CSS', () => {
    const pages = [
      'public/index.html',
      'public/admin.html',
      'public/analytics.html'
    ];

    for (const page of pages) {
      const html = read(page);
      expect(html).not.toMatch(/style="[^"]*(padding|margin|height|width|gap|display:\s*flex|background|color)[^"]*"/);
    }
  });

  test('аналитика больше не определяет собственный :root и fallback-палитру', () => {
    const html = read('public/analytics.html');
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toContain('#cdd6f4');
    expect(html).not.toContain('#313244');
  });

  test('аналитика берёт цвета из общих токенов', () => {
    expect(analyticsJs).toContain("token('--brand')");
    expect(analyticsJs).toContain("token('--success')");
    expect(analyticsJs).not.toContain('var(--muted,#6c7086)');
    expect(analyticsJs).not.toContain("getAttribute('data-theme') === 'dark'");
  });

  test('плеер использует общий токен чёрного фона', () => {
    expect(playerHtml).toContain('class="player-page"');
    expect(playerHtml).not.toMatch(/background(-color)?:\s*#000\s*!?important/);
  });
});

describe('служебные страницы', () => {
  test('403/404/503/maintenance используют общий status.css', () => {
    for (const page of ['403.html', '404.html', '503.html', 'maintenance.html']) {
      const html = read(`public/${page}`);
      expect(html).toContain('/css/status.css');
      expect(html).not.toMatch(/<style[\s>]/);
      expect(html).toMatch(/<body class="status-/);
    }
  });

  test('status.css повторяет каноническую шкалу', () => {
    expect(statusCss).toContain('--control-height: 36px');
    expect(statusCss).toContain('--control-padding: var(--control-padding-y) var(--control-padding-x)');
    expect(statusCss).toContain('--radius-pill: 999px');
  });
});

describe('изоляция стилей', () => {
  // speaker, hero и картотека намеренно исключены из этой унификации.
  test('Hero и картотека не загружают общий app.css', () => {
    const hero = read('public/hero/index.html');
    expect(hero).not.toContain('/css/app.css');
  });
});
