/**
 * Регрессия: дедуплицированный файл воспроизводился, но не скачивался.
 * У записи устройства-получателя safe_name = new.mp4, а file_path указывает
 * на физический old.mp4 устройства-источника. Роут требовал совпадения
 * basename и отдавал 404.
 */
import { jest } from '@jest/globals';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

jest.unstable_mockModule('../../src/middleware/auth.js', () => ({
  requireSpeaker: [
    (_req, _res, next) => next(),
    (_req, _res, next) => next()
  ],
  requireManager: (_req, _res, next) => next(),
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
const targetFolder = path.join(devicesPath, 'target-dev');
const sourceFolder = path.join(devicesPath, 'source-dev');
const sourcePath = path.join(sourceFolder, 'old.mp4');

const storage = {
  isLocal: false,
  async stat() { return { size: 5 }; },
  async createReadStream() { return Readable.from([Buffer.from('hello')]); },
  async list() { return []; },
  async checkExists() { return { state: 'present' }; }
};

let handler;

function createResponse() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });

  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.jsonBody = body;
    res.end();
    return res;
  };
  res.setHeader = (key, value) => {
    res.headers[String(key).toLowerCase()] = value;
    return res;
  };
  res.getHeader = (key) => res.headers[String(key).toLowerCase()];
  res.download = () => {
    throw new Error('download() не должен вызываться в этом тесте');
  };
  res.body = () => Buffer.concat(chunks).toString('utf8');

  return res;
}

beforeAll(async () => {
  mkdirSync(targetFolder, { recursive: true });
  mkdirSync(sourceFolder, { recursive: true });
  await initDatabase(':memory:');

  const router = createFilesRouter({
    devices: { 'target-dev': { folder: 'target-dev' } },
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

  const layer = router.stack.find((entry) => entry.route?.path === '/:id/files/:name/download');
  const stack = layer.route.stack;
  handler = stack[stack.length - 1].handle;
});

beforeEach(async () => {
  await getDatabase().run('DELETE FROM files_metadata');
});

afterAll(async () => {
  await closeDatabase();
  rmSync(targetFolder, { recursive: true, force: true });
  rmSync(sourceFolder, { recursive: true, force: true });
});

describe('GET /:id/files/:name/download', () => {
  test('дедуплицированный файл скачивается по file_path, хотя basename другой', async () => {
    await saveFileMetadata({
      deviceId: 'target-dev',
      safeName: 'new.mp4',
      originalName: 'new.mp4',
      filePath: sourcePath,
      fileSize: 5,
      md5Hash: 'd41d8cd98f00b204e9800998ecf8427e',
      fileMtime: Date.now()
    });

    const req = {
      params: { id: 'target-dev', name: 'new.mp4' },
      user: { userId: 'user-1', role: 'admin' },
      query: {},
      headers: {},
      method: 'GET'
    };
    const res = createResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(5);
    expect(res.body()).toBe('hello');
    expect(res.jsonBody).toBeUndefined();
  });

  test('NoSuchKey от storage → 404, а не 500', async () => {
    await saveFileMetadata({
      deviceId: 'target-dev',
      safeName: 'missing.mp4',
      originalName: 'missing.mp4',
      filePath: path.join(sourceFolder, 'missing.mp4'),
      fileSize: 5,
      md5Hash: 'd41d8cd98f00b204e9800998ecf8427e',
      fileMtime: Date.now()
    });

    const noSuchKey = new Error('NoSuchKey');
    noSuchKey.name = 'NoSuchKey';

    const failingStorage = {
      ...storage,
      async stat() { throw noSuchKey; }
    };
    // createFilesRouter уже замкнул storage; подменяем метод на время теста.
    const originalStat = storage.stat;
    storage.stat = failingStorage.stat;

    try {
      const req = {
        params: { id: 'target-dev', name: 'missing.mp4' },
        user: { userId: 'user-1', role: 'admin' },
        query: {},
        headers: {},
        method: 'GET'
      };
      const res = createResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(res.jsonBody).toMatchObject({ error: expect.stringMatching(/не найден/i) });
    } finally {
      storage.stat = originalStat;
    }
  });
});
