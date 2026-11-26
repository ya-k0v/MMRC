/**
 * Регрессия: очистка удаляла метаданные по любому false от storage.exists().
 * Таймаут/403/недоступный MinIO выглядели как «файла нет», и библиотека
 * теряла записи о рабочих объектах.
 */
import path from 'node:path';

const { initDatabase, closeDatabase, getDatabase } = await import('../../src/database/database.js');
const {
  cleanupMissingFiles,
  saveFileMetadata,
  getFileMetadata,
  countFileReferences
} = await import('../../src/database/files-metadata.js');
const { getDevicesPath } = await import('../../src/config/settings-manager.js');

const devicesPath = getDevicesPath();

function fakeStorage(state) {
  return {
    isLocal: false,
    async checkExists() {
      return state === 'unknown'
        ? { state, error: new Error('HEAD timeout') }
        : { state };
    }
  };
}

async function insertFile(deviceId, safeName) {
  await saveFileMetadata({
    deviceId,
    safeName,
    originalName: safeName,
    filePath: path.join(devicesPath, safeName),
    fileSize: 10,
    md5Hash: 'd41d8cd98f00b204e9800998ecf8427e',
    fileMtime: Date.now()
  });
}

beforeAll(async () => {
  await initDatabase(':memory:');
});

beforeEach(async () => {
  await getDatabase().run('DELETE FROM files_metadata');
});

afterAll(async () => {
  await closeDatabase();
});

describe('cleanupMissingFiles', () => {
  test('unknown не удаляет метаданные', async () => {
    await insertFile('dev-unknown', 'keep.mp4');

    const result = await cleanupMissingFiles({ storage: fakeStorage('unknown') });

    expect(result).toMatchObject({ checked: 1, missing: 0, deleted: 0, unknown: 1 });
    await expect(getFileMetadata('dev-unknown', 'keep.mp4')).resolves.toBeTruthy();
  });

  test('доказанное missing удаляет метаданные', async () => {
    await insertFile('dev-missing', 'gone.mp4');

    const result = await cleanupMissingFiles({ storage: fakeStorage('missing'), dryRun: false });

    expect(result).toMatchObject({ checked: 1, missing: 1, deleted: 1, unknown: 0 });
    await expect(getFileMetadata('dev-missing', 'gone.mp4')).resolves.toBeNull();
  });

  test('вызов без dryRun ничего не удаляет', async () => {
    await insertFile('dev-default', 'keep.mp4');

    const result = await cleanupMissingFiles({ storage: fakeStorage('missing') });

    expect(result).toMatchObject({ checked: 1, missing: 1, deleted: 0, dryRun: true });
    await expect(getFileMetadata('dev-default', 'keep.mp4')).resolves.toBeTruthy();
  });

  test('прогресс приходит по батчам и учитывает лимит параллелизма', async () => {
    for (let i = 0; i < 5; i++) await insertFile('dev-progress', `file${i}.mp4`);
    const updates = [];
    let active = 0;
    let peak = 0;
    const storage = {
      isLocal: false,
      async checkExists() {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active--;
        return { state: 'missing' };
      }
    };

    const result = await cleanupMissingFiles({
      storage,
      dryRun: false,
      batchSize: 2,
      concurrency: 2,
      onProgress: (payload) => updates.push(payload)
    });

    expect(result).toMatchObject({ checked: 5, missing: 5, deleted: 5 });
    expect(updates.length).toBe(3);
    expect(updates.at(-1)).toMatchObject({ checked: 5, total: 5, deleted: 5 });
    expect(peak).toBeLessThanOrEqual(2);
  });

  test('ошибка удаления в БД не выдаётся за успех', async () => {
    await insertFile('dev-db-error', 'keep.mp4');
    const db = getDatabase();
    const originalRun = db.run;
    db.run = async () => { throw new Error('database is locked'); };

    try {
      const result = await cleanupMissingFiles({ storage: fakeStorage('missing'), dryRun: false });
      expect(result).toMatchObject({ missing: 1, deleted: 0 });
      expect(result.errors).toBeGreaterThanOrEqual(1);
      await expect(getFileMetadata('dev-db-error', 'keep.mp4')).resolves.toBeTruthy();
    } finally {
      db.run = originalRun;
    }
  });
});

describe('countFileReferences', () => {
  test('при ошибке БД возвращает null, а не 0', async () => {
    const db = getDatabase();
    const originalGet = db.get;
    db.get = async () => { throw new Error('query failed'); };

    try {
      await expect(countFileReferences('/some/file.mp4')).resolves.toBeNull();
    } finally {
      db.get = originalGet;
    }
  });
});
