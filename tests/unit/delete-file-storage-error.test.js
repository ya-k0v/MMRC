/**
 * Удаление файла без записи в БД не должно превращать ошибку хранилища
 * в успешный ответ: S3-объект мог остаться, хотя локальная копия удалена.
 */
import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

jest.unstable_mockModule('../../src/middleware/auth.js', () => ({
  requireSpeaker: [
    (_req, _res, next) => next(),
    (_req, _res, next) => next()
  ],
  requireManager: [(_req, _res, next) => next(), (_req, _res, next) => next()],
  requireAdmin: (_req, _res, next) => next()
}));

jest.unstable_mockModule('../../src/middleware/device-access.js', () => ({
  hasDeviceAccess: async () => true,
  getUserDevices: async () => [],
  checkDeviceAccess: (_req, _res, next) => next()
}));

const { initDatabase, closeDatabase, getDatabase } = await import('../../src/database/database.js');
const { saveFileMetadata } = await import('../../src/database/files-metadata.js');
const { createFilesRouter } = await import('../../src/routes/files.js');
const { getDevicesPath } = await import('../../src/config/settings-manager.js');

const devicesPath = getDevicesPath();
const folder = path.join(devicesPath, 'delete-error-dev');
const physicalPath = path.join(folder, 'plain.mp4');

const storage = {
  isLocal: false,
  async rm() {},
  async delete() {},
  async exists() { return true; },
  async list() { return []; }
};

let handler;

function createResponse() {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
    send(body) { this.jsonBody = body; return this; }
  };
  return res;
}

function request() {
  return {
    params: { id: 'delete-error-dev', name: 'plain.mp4' },
    user: { userId: 'user-1', username: 'admin', role: 'admin' },
    query: {},
    headers: {},
    ip: '127.0.0.1',
    get: () => 'test-agent'
  };
}

beforeAll(async () => {
  fs.mkdirSync(folder, { recursive: true });
  await initDatabase(':memory:');

  const router = createFilesRouter({
    devices: { 'delete-error-dev': { folder: 'delete-error-dev', files: ['plain.mp4'] } },
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

  const layer = router.stack.find((entry) => entry.route?.path === '/:id/files/:name');
  handler = layer.route.stack[layer.route.stack.length - 1].handle;
});

beforeEach(async () => {
  await getDatabase().run('DELETE FROM files_metadata');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(physicalPath, 'data');
  storage.rm = async () => {};
  storage.delete = async () => {};
  storage.exists = async () => true;
});

afterAll(async () => {
  await closeDatabase();
  fs.rmSync(folder, { recursive: true, force: true });
});

describe('DELETE /:id/files/:name', () => {
  test('ошибка storage.rm без записи в БД → 500, а не ok', async () => {
    storage.rm = async () => { throw new Error('list failed'); };

    const res = createResponse();
    await handler(request(), res);

    expect(res.statusCode).toBe(500);
    expect(res.jsonBody?.ok).toBeUndefined();
  });

  test('ошибка storage.delete при наличии метаданных → 500, а не ok', async () => {
    await saveFileMetadata({
      deviceId: 'delete-error-dev',
      safeName: 'plain.mp4',
      originalName: 'plain.mp4',
      filePath: physicalPath,
      fileSize: 4,
      md5Hash: 'hash',
      fileMtime: Date.now()
    });
    storage.delete = async () => { throw new Error('AccessDenied'); };

    const res = createResponse();
    await handler(request(), res);

    expect(res.statusCode).toBe(500);
    expect(res.jsonBody?.ok).toBeUndefined();
  });
});
