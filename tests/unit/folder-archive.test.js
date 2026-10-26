/**
 * Регрессия: скачивание папки, которая живёт только в S3, всегда падало.
 * createZipArchiveFromFolder() валидировал staging-каталог в os.tmpdir()
 * относительно getDataRoot(), хотя источник уже скачан во временную папку.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const { createZipArchiveFromFolder, downloadFolderFromStorage } = await import('../../src/storage/folder-archive.js');
const { getDataRoot } = await import('../../src/config/settings-manager.js');

const AdmZip = (await import('adm-zip')).default;

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'folder-archive-test-'));
const dataRoot = getDataRoot();

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('createZipArchiveFromFolder', () => {
  test('архивирует каталог, если sourceRoot передан явно (staging вне data root)', async () => {
    const source = path.join(tempRoot, 'content', 'slides');
    mkdirSync(path.join(source, 'nested'), { recursive: true });
    writeFileSync(path.join(source, '1.png'), 'one');
    writeFileSync(path.join(source, 'nested', '2.jpg'), 'two');

    const zipPath = path.join(tempRoot, 'slides.zip');
    await createZipArchiveFromFolder(source, zipPath, { sourceRoot: tempRoot });

    const entries = new AdmZip(zipPath).getEntries()
      .map(entry => entry.entryName)
      .filter(name => !name.endsWith('/'))
      .sort();
    expect(entries).toEqual(['1.png', 'nested/2.jpg']);
  });

  test('без sourceRoot каталог вне data root отклоняется', async () => {
    const source = path.join(tempRoot, 'outside');
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, 'a.txt'), 'a');

    await expect(
      createZipArchiveFromFolder(source, path.join(tempRoot, 'outside.zip'))
    ).rejects.toThrow(/Path traversal/);
  });
});

describe('downloadFolderFromStorage', () => {
  function fakeStorage(keys) {
    return {
      isLocal: false,
      async list(prefix) {
        return keys.filter(key => key.startsWith(prefix));
      },
      async createReadStream(key) {
        return Readable.from([Buffer.from(`content:${key}`)]);
      }
    };
  }

  test('скачивает только файлы под префиксом, сохраняет вложенность и считает файлы', async () => {
    // Логический путь под data root, но на диске его нет — как S3-папка.
    const folderPath = path.join(dataRoot, 'content', 'dev-x', 'deck');
    const prefix = 'content/dev-x/deck/';
    const storage = fakeStorage([
      `${prefix}a.png`,
      `${prefix}nested/b.jpg`,
      `${prefix}`,
      'content/dev-x/deck-old/c.png'
    ]);

    const target = path.join(tempRoot, 'staged');
    mkdirSync(target, { recursive: true });

    const count = await downloadFolderFromStorage(folderPath, target, storage);

    expect(count).toBe(2);
    expect(readFileSync(path.join(target, 'a.png'), 'utf8')).toBe(`content:${prefix}a.png`);
    expect(readFileSync(path.join(target, 'nested', 'b.jpg'), 'utf8')).toBe(`content:${prefix}nested/b.jpg`);
    expect(existsSync(path.join(target, 'c.png'))).toBe(false);
  });

  test('ключ с выходом за пределы targetDir отклоняется', async () => {
    const folderPath = path.join(dataRoot, 'content', 'dev-y', 'deck');
    const prefix = 'content/dev-y/deck/';
    const storage = fakeStorage([`${prefix}../../evil.txt`]);
    const target = path.join(tempRoot, 'staged-evil');
    mkdirSync(target, { recursive: true });

    await expect(downloadFolderFromStorage(folderPath, target, storage))
      .rejects.toThrow(/Path traversal/);
  });
});
