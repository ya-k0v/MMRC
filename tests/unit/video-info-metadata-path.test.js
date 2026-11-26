/**
 * Регрессия: video-info строил путь content/<device>/<name>, игнорируя
 * metadata.file_path. После дедупликации файл лежит в общем content/<safeName>,
 * и ffprobe получал «файл не найден».
 */
import { jest } from '@jest/globals';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

jest.unstable_mockModule('../../src/middleware/auth.js', () => ({
  requireSpeaker: (_req, _res, next) => next(),
  requireManager: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next()
}));

const { initDatabase, closeDatabase, getDatabase } = await import('../../src/database/database.js');
const { saveFileMetadata } = await import('../../src/database/files-metadata.js');
const { setCurrentStorage } = await import('../../src/storage/current.js');
const { createVideoInfoRouter } = await import('../../src/routes/video-info.js');
const { getDevicesPath } = await import('../../src/config/settings-manager.js');

const devicesPath = getDevicesPath();
const deviceFolder = path.join(devicesPath, 'vi-dev');
const sharedPath = path.join(devicesPath, 'vi-shared-source.mp4');

let handler;
const probedPaths = [];

const storage = {
  isLocal: true,
  async list() { return []; }
};

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
    }
  };
  return res;
}

beforeAll(async () => {
  mkdirSync(deviceFolder, { recursive: true });
  writeFileSync(sharedPath, 'video-bytes');
  await initDatabase(':memory:');
  setCurrentStorage(storage);

  const router = createVideoInfoRouter({
    devices: {
      'vi-dev': { folder: 'vi-dev', files: ['clip.mp4'], fileNames: {} }
    },
    getFileStatus: () => null,
    checkVideoParameters: async (filePath) => {
      probedPaths.push(filePath);
      return { width: 1920, height: 1080 };
    },
    autoOptimizeVideoWrapper: async () => ({}),
    io: null
  });

  const layer = router.stack.find(entry =>
    entry.route?.path === '/:id/files/:name/video-info' && entry.route?.methods?.get
  );
  handler = layer.route.stack[layer.route.stack.length - 1].handle;
});

beforeEach(async () => {
  await getDatabase().run('DELETE FROM files_metadata');
  probedPaths.length = 0;
  await saveFileMetadata({
    deviceId: 'vi-dev',
    safeName: 'clip.mp4',
    originalName: 'clip.mp4',
    filePath: sharedPath,
    fileSize: 11,
    md5Hash: 'vi-md5',
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

describe('GET /:id/files/:name/video-info', () => {
  test('использует file_path из метаданных, а не content/<device>/<name>', async () => {
    const req = { params: { id: 'vi-dev', name: 'clip.mp4' } };
    const res = createResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true });
    expect(probedPaths).toEqual([sharedPath]);
  });
});
