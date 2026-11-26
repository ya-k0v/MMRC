/**
 * @jest-environment jsdom
 *
 * Регрессия иконочных кнопок уведомлений: внутри #grid общее правило админки
 * задаёт padding 6px 14px, из-за чего SVG в 24px кнопке схлопывался до нуля.
 */
import fs from 'node:fs';
import path from 'node:path';

const css = [
  'public/css/app.css',
  'public/css/admin.css'
].map((file) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')).join('\n');

beforeEach(() => {
  document.head.innerHTML = `<style>${css}</style>`;
  document.body.className = 'admin-page';
  document.body.innerHTML = `
    <div id="grid">
      <button id="next" class="notification-btn-icon"><svg width="16" height="16"></svg></button>
      <button id="close" class="notification-btn-icon notification-btn-icon--remove"><svg width="16" height="16"></svg></button>
    </div>
  `;
});

// jsdom не вычисляет var(), поэтому подставляем значения из :root вручную.
function resolveVar(value) {
  const root = getComputedStyle(document.documentElement);
  return String(value).replace(/var\((--[\w-]+)\)/g, (_, name) => root.getPropertyValue(name).trim() || _);
}

test('иконочные кнопки уведомлений не получают padding из общего правила #grid', () => {
  expect(resolveVar(getComputedStyle(document.documentElement).getPropertyValue('--control-height-icon'))).toBe('24px');

  for (const id of ['next', 'close']) {
    const style = getComputedStyle(document.getElementById(id));
    expect(resolveVar(style.padding)).toBe('0px');
    expect(resolveVar(style.minWidth)).toBe('24px');
    expect(resolveVar(style.minHeight)).toBe('24px');
  }
});

test('тост остаётся за пределами #grid и сохраняет компактный крестик', () => {
  document.body.insertAdjacentHTML('beforeend', `
    <div class="notification-toast"><button class="notification-toast__close"><svg></svg></button></div>
  `);
  const style = getComputedStyle(document.querySelector('.notification-toast__close'));
  expect(style.padding).toBe('2px');
});
