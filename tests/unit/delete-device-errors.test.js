/**
 * Удаление устройства не должно рапортовать успех при ошибке хранилища
 * или базы данных: устройство обязано остаться в списке для повтора.
 */
import { jest } from '@jest/globals';

const passThrough = (_req, _res, next) => next();

jest.unstable_mockModule('../../src/middleware/auth.js', () => ({
  requireAuth: passThrough,
  requireSpeaker: [passThrough, passThrough],
  requireManager: [passThrough, passThrough],
  requireAdmin: [passThrough, passThrough]
}));

const { initDatabase, closeDatabase, getDatabase } = await import('../../src/database/database.js');
const { createDevicesRouter } = await import('../../src/routes/devices.js');

const devices = { 'dev-1': { name: 'Test', folder: 'dev-1', files: [] } };
const fileNamesMap = {};
const storage = {
  isLocal: true,
  async rm() {},
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
    params: { id: 'dev-1' },
    body: {},
    query: {},
    user: { id: 1, username: 'admin', role: 'admin' },
    ip: '127.0.0.1',
    get: () => 'test-agent'
  };
}

beforeAll(async () => {
  await initDatabase(':memory:');
  const router = createDevicesRouter({
    devices,
    io: { emit() {}, to() { return { emit() {} }; } },
    saveDevicesJson() {},
    fileNamesMap,
    saveFileNamesMap() {},
    requireAdmin: passThrough,
    requireSpeaker: passThrough,
    onDeviceCreated() {},
    onDeviceDeleted() {},
    storage
  });
  const layer = router.stack.find((entry) =>
    entry.route?.path === '/:id' && entry.route?.methods?.delete
  );
  handler = layer.route.stack[layer.route.stack.length - 1].handle;
});

beforeEach(async () => {
  devices['dev-1'] = { name: 'Test', folder: 'dev-1', files: [] };
  storage.rm = async () => {};
  await getDatabase().run('DELETE FROM files_metadata');
});

afterAll(async () => {
  await closeDatabase();
});

describe('DELETE /api/devices/:id', () => {
  test('ошибка storage.rm → 500, устройство остаётся', async () => {
    storage.rm = async () => { throw new Error('list failed'); };

    const res = createResponse();
    await handler(request(), res);

    expect(res.statusCode).toBe(500);
    expect(devices['dev-1']).toBeDefined();
  });

  test('ошибка удаления метаданных → 500, устройство остаётся', async () => {
    await closeDatabase();

    const res = createResponse();
    await handler(request(), res);

    expect(res.statusCode).toBe(500);
    expect(devices['dev-1']).toBeDefined();
  });
});
