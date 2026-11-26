/**
 * Конвертеры должны запрашивать storage-префикс с завершающим '/',
 * иначе `deck` захватывает объекты соседней папки `deck-old`.
 */
import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'converter-prefix-'));

const actualSettings = await import('../../src/config/settings-manager.js');

jest.unstable_mockModule('../../src/config/settings-manager.js', () => ({
  ...actualSettings,
  getDataRoot: () => tempRoot,
  getDevicesPath: () => tempRoot
}));

const { findFileFolder, getPageSlideCount } = await import('../../src/converters/document-converter.js');

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function createStorage(entries) {
  return {
    list: jest.fn(async (prefix) => {
      if (prefix === 'dev/') return entries;
      if (prefix === 'dev/deck/') {
        return entries.filter((entry) => entry.startsWith('dev/deck/'));
      }
      return [];
    })
  };
}

describe('document-converter: префикс в storage', () => {
  test('findFileFolder ищет страницы по префиксу с завершающим /', async () => {
    const storage = createStorage(['dev/deck/page.1.png', 'dev/deck/page.2.png']);

    const folder = await findFileFolder('dev', 'deck.pdf', storage);

    expect(folder).toBe(path.join(tempRoot, 'dev', 'deck'));
    expect(storage.list).toHaveBeenCalledWith('dev/');
  });

  test('getPageSlideCount считает PNG через тот же префикс', async () => {
    const storage = createStorage(['dev/deck/page.1.png', 'dev/deck/page.2.png', 'dev/deck/page.10.png']);

    await expect(getPageSlideCount('dev', 'deck.pdf', storage)).resolves.toBe(3);
    expect(storage.list).toHaveBeenCalledWith('dev/');
  });
});
