/**
 * Регрессия: медиа может лежать в общем content/<safeName>, а clear-device
 * удалял только content/<device>. Общий файл, на который ссылается другое
 * устройство, удалять нельзя; метаданные очищаются только после
 * подтверждённого удаления объектов.
 */
import { jest } from '@jest/globals';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const passThrough = (_req, _res, next) => next();

jest.unstable_mockModule('../../src/middleware/auth.js', () => ({
  requireSpeaker: [passThrough, passThrough],
  requireManager: [passThrough, passThrough],
  requireAdmin: [passThrough, passThrough]
}));

jest.unstable_mockModule('../../src/middleware/device-access.js', () => ({
  hasDeviceAccess: async () => true,
  getUserDevices: async () => [],
  checkDeviceAccess: (_req, _res, next) => next()
}));

const { initDatabase, closeDatabase, getDatabase } = await import('../../src/database/database.js');
const { saveFileMetadata, getDeviceFilesMetadata } = await import('../../src/database/files-metadata.js');
const { createFilesRouter } = await import('../../src/routes/files.js');
const { getDevicesPath, getDataRoot } = await import('../../src/config/settings-manager.js');

const devicesPath = getDevicesPath();
const deviceFolder = path.join(devicesPath, 'clear-dev');
const ownPath = path.join(deviceFolder, 'own.mp4');
const sharedPath = path.join(devicesPath, 'shared.mp4');

const storage = {
  isLocal: true,
  async rm(key) {
    const fullPath = path.resolve(getDataRoot(), key);
    rmSync(fullPath, { recursive: true, force: true });
  },
  async list() {
    return [];
  }
};

let handler;

function createResponse() {
  const res = {
    statusCode: 200,
    jsonBody: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.jsonBody = body;
      return res;
    },
    send() {
      return res;
    }
  };
  return res;
}

beforeAll(async () => {
  mkdirSync(deviceFolder, { recursive: true });
  writeFileSync(ownPath, 'own');
  writeFileSync(sharedPath, 'shared');
  await initDatabase(':memory:');

  const router = createFilesRouter({
    devices: {
      'clear-dev': { folder: 'clear-dev', files: ['own.mp4'], fileNames: {} },
      'other-dev': { folder: 'other-dev', files: ['shared.mp4'], fileNames: {} }
    },
    io: { emit() {}, to() { return { emit() {} }; } },
    storage,
    fileNamesMap: {},
    saveFileNamesMap() {},
    upload: {},
    autoConvertFileWrapper: async () => {},
    autoOptimizeVideoWrapper: async () => ({}),
    checkVideoParameters: async () => null,
    getFileStatus: () => null
  });

  const layer = router.stack.find(entry => entry.route?.path === '/:id/files' && entry.route?.methods?.delete);
  handler = layer.route.stack[layer.route.stack.length - 1].handle;
});

beforeEach(async () => {
  await getDatabase().run('DELETE FROM files_metadata');
  mkdirSync(deviceFolder, { recursive: true });
  writeFileSync(ownPath, 'own');
  writeFileSync(sharedPath, 'shared');

  await saveFileMetadata({
    deviceId: 'clear-dev',
    safeName: 'own.mp4',
    originalName: 'own.mp4',
    filePath: ownPath,
    fileSize: 3,
    md5Hash: 'own-md5',
    mimeType: 'video/mp4',
    fileMtime: Date.now(),
    contentType: 'video'
  });
  await saveFileMetadata({
    deviceId: 'clear-dev',
    safeName: 'shared.mp4',
    originalName: 'shared.mp4',
    filePath: sharedPath,
    fileSize: 6,
    md5Hash: 'shared-md5',
    mimeType: 'video/mp4',
    fileMtime: Date.now(),
    contentType: 'video'
  });
  await saveFileMetadata({
    deviceId: 'other-dev',
    safeName: 'shared.mp4',
    originalName: 'shared.mp4',
    filePath: sharedPath,
    fileSize: 6,
    md5Hash: 'shared-md5',
    mimeType: 'video/mp4',
    fileMtime: Date.now(),
    contentType: 'video'
  });
});

afterAll(async () => {
  await closeDatabase();
  rmSync(deviceFolder, { recursive: true, force: true });
  rmSync(sharedPath, { force: true });
});

describe('DELETE /:id/files (clear-device)', () => {
  test('удаляет свои файлы, но оставляет общий файл другого устройства', async () => {
    const req = { params: { id: 'clear-dev' } };
    const res = createResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true, cleared: true });

    expect(existsSync(ownPath)).toBe(false);
    expect(existsSync(sharedPath)).toBe(true);
    expect(await getDeviceFilesMetadata('clear-dev')).toHaveLength(0);
    expect(await getDeviceFilesMetadata('other-dev')).toHaveLength(1);
  });
});
