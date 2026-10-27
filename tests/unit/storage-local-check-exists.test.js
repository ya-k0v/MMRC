import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { LocalStorage } = await import('../../src/storage/local.js');

const root = mkdtempSync(path.join(os.tmpdir(), 'local-storage-check-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('LocalStorage.checkExists', () => {
  test('present для существующего файла', async () => {
    writeFileSync(path.join(root, 'present.txt'), 'data');
    const storage = new LocalStorage(root);

    await expect(storage.checkExists('present.txt')).resolves.toMatchObject({ state: 'present' });
    await expect(storage.exists('present.txt')).resolves.toBe(true);
  });

  test('missing только для ENOENT', async () => {
    const storage = new LocalStorage(root);

    await expect(storage.checkExists('no-such-file.txt')).resolves.toMatchObject({ state: 'missing' });
    await expect(storage.exists('no-such-file.txt')).resolves.toBe(false);
  });

  test('ENOTDIR — unknown, а не «файла нет»', async () => {
    writeFileSync(path.join(root, 'plain.txt'), 'data');
    const storage = new LocalStorage(root);

    const probe = await storage.checkExists('plain.txt/child');
    expect(probe.state).toBe('unknown');
    expect(probe.error.code).toBe('ENOTDIR');

    // exists() тоже fail-safe: unknown не должен выглядеть как пропажа.
    await expect(storage.exists('plain.txt/child')).resolves.toBe(true);
  });
});
