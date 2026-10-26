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

    const result = await cleanupMissingFiles({ storage: fakeStorage('missing') });

    expect(result).toMatchObject({ checked: 1, missing: 1, deleted: 1, unknown: 0 });
    await expect(getFileMetadata('dev-missing', 'gone.mp4')).resolves.toBeNull();
  });

  test('ошибка удаления в БД не выдаётся за успех', async () => {
    await insertFile('dev-db-error', 'keep.mp4');
    const db = getDatabase();
    const originalRun = db.run;
    db.run = async () => { throw new Error('database is locked'); };

    try {
      const result = await cleanupMissingFiles({ storage: fakeStorage('missing') });
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
