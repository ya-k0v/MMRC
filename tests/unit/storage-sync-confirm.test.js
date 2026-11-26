/**
 * Регрессия: после загрузки syncFileToStorage() проверял только exists().
 * При таймауте/403 fail-safe exists() = true, и локальная копия удалялась,
 * хотя запись в S3 не подтверждена. Теперь unknown — ошибка, файл остаётся.
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const { syncFileToStorage, materializeToLocal } = await import('../../src/storage/sync.js');
const { getDataRoot } = await import('../../src/config/settings-manager.js');

const DATA_ROOT = getDataRoot();
const workDir = mkdtempSync(path.join(DATA_ROOT, 'sync-confirm-'));
let counter = 0;

function localFile(content = 'hello') {
  const file = path.join(workDir, `file-${++counter}.bin`);
  writeFileSync(file, content);
  return file;
}

function createStorage(overrides = {}) {
  return {
    isLocal: false,
    async writeStream(_key, stream) {
      // Потребляем поток: иначе fs.createReadStream откроет уже удалённый
      // файл и упадёт ENOENT после завершения теста.
      for await (const _chunk of stream) {
        // содержимое для этих тестов не важно
      }
    },
    async checkExists() { return { state: 'present', stat: { size: 5 } }; },
    async exists() { return true; },
    async stat() { return { size: 5 }; },
    async rm() {},
    ...overrides
  };
}

function storageKey(filePath) {
  return path.relative(DATA_ROOT, filePath).replace(/\\/g, '/');
}

const goodHash = crypto.createHash('sha256').update('hello').digest('base64');
const badHash = crypto.createHash('sha256').update('other').digest('base64');

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('syncFileToStorage: подтверждение записи', () => {
  test('unknown после загрузки — ошибка, локальный файл остаётся', async () => {
    const file = localFile();
    const storage = createStorage({
      async checkExists() {
        return { state: 'unknown', error: new Error('HEAD timeout') };
      }
    });

    await expect(syncFileToStorage(file, storage, { force: true, removeLocal: true }))
      .rejects.toThrow(/не подтверждена/);

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('hello');
  });

  test('present с совпадающим размером — успех, локальная копия удаляется', async () => {
    const file = localFile();
    const storage = createStorage();

    const result = await syncFileToStorage(file, storage, { force: true, removeLocal: true });

    expect(result).toMatchObject({ synced: true, localRemoved: true, size: 5 });
    expect(existsSync(file)).toBe(false);
  });

  test('present, но размер не совпал — объект удаляется, локальный файл остаётся', async () => {
    const file = localFile();
    const removed = [];
    const storage = createStorage({
      async checkExists() {
        return { state: 'present', stat: { size: 999 } };
      },
      async rm(key) { removed.push(key); }
    });

    await expect(syncFileToStorage(file, storage, { force: true, removeLocal: true }))
      .rejects.toThrow(/Размер в хранилище не совпадает/);

    expect(removed).toEqual([storageKey(file)]);
    expect(existsSync(file)).toBe(true);
  });

  test('unknown после загрузки — объект не удаляется', async () => {
    const file = localFile();
    const removed = [];
    const storage = createStorage({
      async checkExists() {
        return { state: 'unknown', error: new Error('HEAD timeout') };
      },
      async rm(key) { removed.push(key); }
    });

    await expect(syncFileToStorage(file, storage, { force: true, removeLocal: true }))
      .rejects.toThrow(/не подтверждена/);

    expect(removed).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  test('совпадающий checksum позволяет пропустить загрузку', async () => {
    const file = localFile();
    let uploads = 0;
    let removed = 0;
    const storage = createStorage({
      async stat() { return { size: 5, checksums: { ChecksumSHA256: goodHash } }; },
      async writeStream(_key, stream) {
        uploads++;
        for await (const _chunk of stream) { /* consume */ }
      },
      async rm() { removed++; }
    });

    const result = await syncFileToStorage(file, storage, { removeLocal: true });

    expect(result).toMatchObject({ synced: true, skipped: true, localRemoved: true });
    expect(uploads).toBe(0);
    expect(removed).toBe(0);
  });

  test('checksum того же размера, но другой — объект удаляется и загружается заново', async () => {
    const file = localFile();
    const removed = [];
    let uploads = 0;
    const storage = createStorage({
      async stat() { return { size: 5, checksums: { ChecksumSHA256: badHash } }; },
      async writeStream(_key, stream) {
        uploads++;
        for await (const _chunk of stream) { /* consume */ }
      },
      async rm(key) { removed.push(key); }
    });

    const result = await syncFileToStorage(file, storage, { removeLocal: true });

    expect(result.synced).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(removed).toEqual([storageKey(file)]);
    expect(uploads).toBe(1);
    expect(existsSync(file)).toBe(false);
  });

  test('checksum после загрузки не совпал — объект удаляется, локальный файл остаётся', async () => {
    const file = localFile();
    const removed = [];
    const storage = createStorage({
      async checkExists() {
        return { state: 'present', stat: { size: 5, checksums: { ChecksumSHA256: badHash } } };
      },
      async rm(key) { removed.push(key); }
    });

    await expect(syncFileToStorage(file, storage, { force: true, removeLocal: true }))
      .rejects.toThrow(/Checksum sha256 не совпадает/);

    expect(removed).toEqual([storageKey(file)]);
    expect(existsSync(file)).toBe(true);
  });
});

describe('materializeToLocal: не качать при unknown', () => {
  test('unknown — null, файл не создаётся', async () => {
    const target = path.join(workDir, 'materialize-unknown.bin');
    const storage = createStorage({
      async checkExists() {
        return { state: 'unknown', error: new Error('AccessDenied') };
      }
    });

    await expect(materializeToLocal(target, storage)).resolves.toBeNull();
    expect(existsSync(target)).toBe(false);
  });

  test('present — файл скачивается и размер проверяется', async () => {
    const target = path.join(workDir, 'materialize-present.bin');
    const storage = createStorage({
      async checkExists() {
        return { state: 'present', stat: { size: 5 } };
      },
      async createReadStream() {
        return Readable.from([Buffer.from('hello')]);
      }
    });

    await expect(materializeToLocal(target, storage)).resolves.toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('hello');
  });
});
