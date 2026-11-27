/**
 * Очистка осиротевших файлов: локальный бэкенд не должен удалять файл дважды.
 */
import fs from 'node:fs';
import path from 'node:path';

const { initDatabase, closeDatabase, getDatabase } = await import('../../src/database/database.js');
const { saveFileMetadata } = await import('../../src/database/files-metadata.js');
const { getDevicesPath } = await import('../../src/config/settings-manager.js');
const { cleanupOrphanedFiles } = await import('../../src/database/cleanup-orphaned-files.js');

const dir = path.join(getDevicesPath(), 'cleanup-orphan-test');

beforeAll(async () => {
  await initDatabase(':memory:');
});

beforeEach(async () => {
  fs.mkdirSync(dir, { recursive: true });
  await getDatabase().run('DELETE FROM files_metadata');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await closeDatabase();
});

test('локальный бэкенд удаляет сироту один раз и считает её в deleted', async () => {
  const tracked = path.join(dir, 'tracked.mp4');
  const orphan = path.join(dir, 'orphan.mp4');
  fs.writeFileSync(tracked, 'data');
  fs.writeFileSync(orphan, 'data');

  await saveFileMetadata({
    deviceId: 'cleanup-test',
    safeName: 'tracked.mp4',
    originalName: 'tracked.mp4',
    filePath: tracked,
    fileSize: 4,
    md5Hash: 'hash',
    fileMtime: Date.now()
  });

  let storageDeleteCalls = 0;
  const storage = {
    isLocal: true,
    async delete() {
      storageDeleteCalls++;
      throw new Error('локальный файл не должен удаляться через storage');
    }
  };

  const result = await cleanupOrphanedFiles({ dryRun: false }, storage);

  expect(result).toMatchObject({ orphaned: 1, deleted: 1, errors: [] });
  expect(storageDeleteCalls).toBe(0);
  expect(fs.existsSync(orphan)).toBe(false);
  expect(fs.existsSync(tracked)).toBe(true);
});

test('dryRun оставляет файлы на месте', async () => {
  const orphan = path.join(dir, 'orphan.mp4');
  fs.writeFileSync(orphan, 'data');

  const result = await cleanupOrphanedFiles({ dryRun: true }, { isLocal: true });

  expect(result).toMatchObject({ orphaned: 1, deleted: 0, errors: [] });
  expect(fs.existsSync(orphan)).toBe(true);
});
