/**
 * Раскладка карточки APK в настройках: версия слева, поля установки справа,
 * без лишней подписи и отдельной строки статуса под полями.
 */
import fs from 'node:fs';

const read = file => fs.readFileSync(file, 'utf8');
const js = read('public/js/admin.js');
const css = read('public/css/admin.css');

describe('карточка APK и версий плеера', () => {
  test('поля установки идут в строке версии, лишний заголовок удалён', () => {
    const version = js.indexOf('id="stApkVersion"');
    const fields = js.indexOf('class="st-actions st-apk-install-fields"');
    const targets = js.indexOf('id="stApkTargets"');

    expect(version).toBeGreaterThan(-1);
    expect(fields).toBeGreaterThan(version);
    expect(fields).toBeLessThan(targets);
    expect(js).not.toContain('Установка на устройство');
    expect(js).not.toContain('st-apk-install-label');
  });

  test('CSS держит поля справа от версии и складывает их только на телефоне', () => {
    expect(css).toContain('.st-apk-version-row {');
    expect(css).toMatch(/\.st-apk-version-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1\.5fr\)/s);
    expect(css).not.toContain('.st-apk-install {');
    expect(css).not.toContain('.st-apk-install-label');
    expect(css).toMatch(/@media \(max-width: 767px\)\s*\{[^}]*\.st-apk-version-row/s);
  });
});
