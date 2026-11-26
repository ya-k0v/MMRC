/**
 * Правило проекта: никаких emoji в UI — только SVG-иконки из shared/svg-icons.js.
 * Тест не даёт rule снова «забыться» в новых файлах админки/спикера.
 */

import fs from 'node:fs';
import path from 'node:path';

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u;
const PUBLIC = path.resolve('public');
const JS_ROOT = path.join(PUBLIC, 'js');

function collectFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, files);
    else if (/\.(js|css|html)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe('UI без emoji', () => {
  test('в исходниках админки/спикера нет пиктограмм-emoji', () => {
    const files = [
      ...collectFiles(JS_ROOT),
      ...fs.readdirSync(PUBLIC)
        .filter(name => name.endsWith('.html'))
        .map(name => path.join(PUBLIC, name))
    ];
    const offenders = [];

    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (EMOJI.test(line)) offenders.push(`${path.relative(PUBLIC, file)}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
