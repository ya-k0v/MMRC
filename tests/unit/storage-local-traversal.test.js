import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { LocalStorage } = await import('../../src/storage/local.js');

const parent = mkdtempSync(path.join(os.tmpdir(), 'local-storage-traversal-'));
const root = path.join(parent, 'data');

afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

describe('LocalStorage._resolve: граница каталога', () => {
  test('соседний каталог с общим префиксом (data2 для data) запрещён', async () => {
    const storage = new LocalStorage(root);

    await expect(storage.read('../data2/secret.txt')).rejects.toThrow(/Path traversal/);
    await expect(storage.write('../data2/secret.txt', 'x')).rejects.toThrow(/Path traversal/);
  });

  test('обычный относительный путь внутри root разрешён', async () => {
    const storage = new LocalStorage(root);
    await storage.write('content/file.txt', 'ok');

    await expect(storage.read('content/file.txt').then(buf => buf.toString())).resolves.toBe('ok');
  });
});
