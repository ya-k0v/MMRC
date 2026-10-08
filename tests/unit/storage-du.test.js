/**
 * du(): фактический объём данных в хранилище.
 * Для локального — рекурсивный обход дерева, для S3 — сумма Size из листинга.
 * Используется карточкой «Хранилище», чтобы показывать реальную занятость
 * контентом, а не занятость раздела целиком.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const { LocalStorage } = await import('../../src/storage/local.js');

const DATA_ROOT = mkdtempSync(path.join('/tmp', 'storage-du-'));

function writeTree(root, tree) {
  for (const [name, content] of Object.entries(tree)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

afterAll(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

describe('LocalStorage.du', () => {
  test('суммирует размер всех вложенных файлов рекурсивно', async () => {
    writeTree(DATA_ROOT, {
      'a.bin': '12345',                    // 5 байт
      'sub/b.bin': 'x'.repeat(100),        // 100 байт
      'sub/deep/c.bin': 'y'.repeat(7)      // 7 байт
    });
    const storage = new LocalStorage(DATA_ROOT);
    expect(await storage.du('')).toBe(112);
  });

  test('прямой файл считается без обхода', async () => {
    const storage = new LocalStorage(DATA_ROOT);
    expect(await storage.du('a.bin')).toBe(5);
  });

  test('несуществующий префикс возвращает null', async () => {
    const storage = new LocalStorage(DATA_ROOT);
    expect(await storage.du('missing')).toBeNull();
  });

  test('пустое хранилище — 0 байт', async () => {
    const empty = mkdtempSync(path.join('/tmp', 'storage-du-empty-'));
    try {
      const storage = new LocalStorage(empty);
      expect(await storage.du('')).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});