/**
 * Стартовая сверка S3-primary и отчёт БД ↔ storage.
 * Проверяем tri-state: unknown не даёт права ни загружать, ни удалять.
 */
import fs from 'node:fs';
import path from 'node:path';

const { initDatabase, closeDatabase, getDatabase } = await import('../../src/database/database.js');
const { saveFileMetadata, getFileMetadata } = await import('../../src/database/files-metadata.js');
const { getDevicesPath, getDataRoot } = await import('../../src/config/settings-manager.js');
const { reconcileStartupLocalToStorage, reconcileDbWithStorage } = await import('../../src/storage/reconcile.js');
const { getMetrics, resetMetrics } = await import('../../src/utils/metrics.js');

const devicesPath = getDevicesPath();
const deviceDir = path.join(devicesPath, 'reconcile-dev');

function createStorage({ objects = new Map(), state = 'missing', delayMs = 0 } = {}) {
  return {
    isLocal: false,
    objects,
    async checkExists(key) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (objects.has(key)) return { state: 'present', stat: { size: objects.get(key) } };
      return state === 'unknown' ? { state, error: new Error('HEAD timeout') } : { state: 'missing' };
    },
    async exists(key) { return objects.has(key); },
    async writeStream(key, stream) {
      let size = 0;
      for await (const chunk of stream) size += chunk.length;
      objects.set(key, size);
    },
    async rm(key) { objects.delete(key); },
    async list() {
      return [...objects.keys()];
    }
  };
}

function storageKey(filePath) {
  return path.relative(getDataRoot(), filePath).replace(/\\/g, '/');
}

async function insertFile(deviceId, safeName, filePath) {
  await saveFileMetadata({
    deviceId,
    safeName,
    originalName: safeName,
    filePath,
    fileSize: 4,
    md5Hash: 'hash',
    fileMtime: Date.now()
  });
}

beforeAll(async () => {
  await initDatabase(':memory:');
});

beforeEach(async () => {
  await getDatabase().run('DELETE FROM files_metadata');
  fs.mkdirSync(deviceDir, { recursive: true });
  resetMetrics();
});

afterEach(() => {
  fs.rmSync(deviceDir, { recursive: true, force: true });
});

afterAll(async () => {
  await closeDatabase();
});

describe('reconcileStartupLocalToStorage', () => {
  test('локальный backend пропускает коммит', async () => {
    const report = await reconcileStartupLocalToStorage({ storage: { isLocal: true }, root: deviceDir });

    expect(report).toMatchObject({ checked: 0, committed: 0, skippedReason: 'local-storage' });
  });

  test('подтверждённо отсутствующий файл коммитится с ограниченным параллелизмом', async () => {
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(deviceDir, `f${i}.mp4`), 'data');
    const objects = new Map();
    const storage = createStorage({ objects, delayMs: 5 });
    let active = 0;
    let peak = 0;
    const originalWrite = storage.writeStream;
    storage.writeStream = async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try { await originalWrite(...args); } finally { active--; }
    };

    const report = await reconcileStartupLocalToStorage({ storage, root: deviceDir, concurrency: 2 });

    expect(report).toMatchObject({ checked: 3, missing: 3, committed: 3, commitErrors: 0 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(objects.size).toBe(3);
    expect(fs.readdirSync(deviceDir)).toHaveLength(0);
    expect(getMetrics().storage.commitAttempts).toBe(3);
  });

  test('unknown не коммитится и локальная копия остаётся', async () => {
    fs.writeFileSync(path.join(deviceDir, 'keep.mp4'), 'data');
    const objects = new Map();
    const storage = createStorage({ objects, state: 'unknown' });

    const report = await reconcileStartupLocalToStorage({ storage, root: deviceDir });

    expect(report).toMatchObject({ checked: 1, unknown: 1, committed: 0 });
    expect(objects.size).toBe(0);
    expect(fs.existsSync(path.join(deviceDir, 'keep.mp4'))).toBe(true);
    expect(getMetrics().storage.unknown).toBeGreaterThanOrEqual(1);
  });

  test('present с совпадающим размером не перезаливается', async () => {
    const file = path.join(deviceDir, 'present.mp4');
    fs.writeFileSync(file, 'data');
    const objects = new Map([[storageKey(file), 4]]);

    const report = await reconcileStartupLocalToStorage({
      storage: createStorage({ objects }), root: deviceDir
    });

    expect(report).toMatchObject({ checked: 1, present: 1, mismatched: 0, committed: 0 });
    expect(objects.get(storageKey(file))).toBe(4);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('present с другим размером перезаливается с силой', async () => {
    const file = path.join(deviceDir, 'truncated.mp4');
    fs.writeFileSync(file, 'data');
    const key = storageKey(file);
    const objects = new Map([[key, 2]]);

    const report = await reconcileStartupLocalToStorage({
      storage: createStorage({ objects }), root: deviceDir
    });

    expect(report).toMatchObject({
      checked: 1, present: 0, mismatched: 1, committed: 1, commitErrors: 0
    });
    expect(objects.get(key)).toBe(4);
    expect(fs.existsSync(file)).toBe(false);
    expect(report.samples).toContainEqual({ key, state: 'mismatch', localSize: 4, storedSize: 2 });
  });

  test('dryRun не загружает и не удаляет локальные файлы', async () => {
    fs.writeFileSync(path.join(deviceDir, 'keep.mp4'), 'data');
    const objects = new Map();

    const report = await reconcileStartupLocalToStorage({
      storage: createStorage({ objects }), root: deviceDir, dryRun: true
    });

    expect(report).toMatchObject({ missing: 1, committed: 0, skipped: 1 });
    expect(fs.existsSync(path.join(deviceDir, 'keep.mp4'))).toBe(true);
  });
});

describe('reconcileDbWithStorage', () => {
  test('отчёт считает present/missing/unknown и сироты, но ничего не удаляет', async () => {
    const presentPath = path.join(deviceDir, 'present.mp4');
    const missingPath = path.join(deviceDir, 'missing.mp4');
    const unknownPath = path.join(deviceDir, 'unknown.mp4');
    fs.writeFileSync(presentPath, 'data');
    await insertFile('reconcile-dev', 'present.mp4', presentPath);
    await insertFile('reconcile-dev', 'missing.mp4', missingPath);
    await insertFile('reconcile-dev', 'unknown.mp4', unknownPath);

    const objects = new Map([[storageKey(presentPath), 4], ['content/orphan.mp4', 4]]);
    const storage = {
      isLocal: false,
      async checkExists(key) {
        if (key === storageKey(unknownPath)) return { state: 'unknown', error: new Error('timeout') };
        if (objects.has(key)) return { state: 'present', stat: { size: objects.get(key) } };
        return { state: 'missing' };
      },
      async list() { return [...objects.keys()]; }
    };

    const report = await reconcileDbWithStorage({ storage });

    expect(report).toMatchObject({ checked: 3, present: 1, missing: 1, unknown: 1, orphanCount: 1 });
    expect(report.samples.orphans).toContain('content/orphan.mp4');
    await expect(getFileMetadata('reconcile-dev', 'missing.mp4')).resolves.toBeTruthy();
    expect(getMetrics().storage.orphanObjects).toBe(1);
    expect(getMetrics().storage.lastReconcileAt).toBeTruthy();
  });

  test('папка-префикс из БД не считается сиротой', async () => {
    const filePath = path.join(deviceDir, 'deck', 'page.1.png');
    await insertFile('reconcile-dev', 'page.1.png', filePath);
    const storage = {
      isLocal: false,
      async checkExists() { return { state: 'missing' }; },
      async list() { return [storageKey(path.join(deviceDir, 'deck'))]; }
    };

    const report = await reconcileDbWithStorage({ storage });

    expect(report.orphanCount).toBe(0);
  });
});
