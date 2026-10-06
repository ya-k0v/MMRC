/**
 * Регрессия: конвертация PDF теряла все страницы начиная с 26-й.
 *
 * BATCH_SIZE = 25, а нумерация выходных файлов у ghostscript с "%d"
 * относительная: при -dFirstPage=26 -dLastPage=45 страницы пишутся как
 * <prefix>1.png … <prefix>20.png. Код искал файлы по абсолютному номеру
 * (26..45), не находил их, и sharp падал с "Input file is missing" на
 * каждой странице второго и последующих батчей.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { mapBatchOutputFiles } from '../../src/converters/document-converter.js';

const BATCH_SIZE = 25;
const hasGs = (() => {
  try { execFileSync('gs', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

describe('mapBatchOutputFiles', () => {
  test('первый батч: относительная нумерация совпадает с абсолютной', () => {
    const files = mapBatchOutputFiles('/tmp/p-', 1, BATCH_SIZE);

    expect(files.size).toBe(BATCH_SIZE);
    expect(files.get(1)).toBe('/tmp/p-1.png');
    expect(files.get(BATCH_SIZE)).toBe('/tmp/p-25.png');
  });

  test('второй батч начинается с 1.png, а не с 26.png', () => {
    const start = BATCH_SIZE + 1;
    const files = mapBatchOutputFiles('/tmp/p-', start, start + 19);

    expect(files.size).toBe(20);
    expect(files.get(26)).toBe('/tmp/p-1.png');
    expect(files.get(45)).toBe('/tmp/p-20.png');
    expect(files.has(1)).toBe(false);
  });

  test('покрывает весь PDF длиннее одного батча без пропусков и дублей', () => {
    const pageCount = 45;
    const seen = new Map();

    for (let start = 1; start <= pageCount; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE - 1, pageCount);
      for (const [page, file] of mapBatchOutputFiles(`/tmp/b${start}-`, start, end)) {
        expect(page).toBeGreaterThanOrEqual(start);
        expect(page).toBeLessThanOrEqual(end);
        seen.set(page, file);
      }
    }

    expect(seen.size).toBe(pageCount);
    for (let page = 1; page <= pageCount; page++) {
      expect(seen.has(page)).toBe(true);
    }
    expect(new Set(seen.values()).size).toBe(pageCount);
  });

  test('последний неполный батч', () => {
    const files = mapBatchOutputFiles('/tmp/p-', 51, 53);

    expect(files.get(51)).toBe('/tmp/p-1.png');
    expect(files.get(53)).toBe('/tmp/p-3.png');
    expect(files.size).toBe(3);
  });
});

const describeGs = hasGs ? describe : describe.skip;

describeGs('контракт ghostscript (нумерация выходных файлов)', () => {
  test('gs нумерует файлы относительно диапазона, а не по номеру страницы', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 30; i++) doc.addPage([200, 200]);
    const pdfPath = path.join(os.tmpdir(), `mmrc-test-${Date.now()}.pdf`);
    const prefix = path.join(os.tmpdir(), `mmrc-test-out-${Date.now()}-`);

    fs.writeFileSync(pdfPath, await doc.save());

    try {
      execFileSync('gs', [
        '-dNOPAUSE', '-dBATCH', '-dSAFER',
        '-sDEVICE=png16m', '-r36',
        '-dFirstPage=30', '-dLastPage=30',
        `-sOutputFile=${prefix}%d.png`,
        pdfPath
      ], { stdio: 'ignore' });

      const created = fs.readdirSync(os.tmpdir())
        .filter(f => f.startsWith(path.basename(prefix)));

      expect(created).toHaveLength(1);
      expect(created[0]).toBe(`${path.basename(prefix)}1.png`);
      expect(created[0]).not.toBe(`${path.basename(prefix)}30.png`);

      for (const f of created) fs.unlinkSync(path.join(os.tmpdir(), f));
    } finally {
      fs.unlinkSync(pdfPath);
    }
  }, 30000);
});