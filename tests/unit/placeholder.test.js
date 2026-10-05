import { jest } from '@jest/globals';

const mockDbGet = jest.fn();
const mockStorage = { exists: jest.fn(), root: 's3://mmrc/' };

jest.unstable_mockModule('../../src/database/database.js', () => ({
  getDatabase: () => ({ get: mockDbGet })
}));

jest.unstable_mockModule('../../src/storage/current.js', () => ({
  getCurrentStorage: () => mockStorage
}));

const { createPlaceholderRouter } = await import('../../src/routes/placeholder.js');

const PLACEHOLDER_ROW = {
  safe_name: 'Девчата 1961.mp4',
  file_path: '/app/data/content/ATV001/Devchata_1961.mp4',
  mime_type: 'video/mp4'
};

function getHandler() {
  const router = createPlaceholderRouter({
    devices: { ATV001: { id: 'ATV001' } },
    io: { emit: jest.fn(), to: jest.fn(() => ({ emit: jest.fn() })) },
    fileNamesMap: {},
    storage: mockStorage
  });
  const layer = router.stack.find((l) => l.route?.path === '/:id/placeholder');
  return layer.route.stack[0].handle;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; }
  };
  return res;
}

const handler = getHandler();

describe('GET /api/devices/:id/placeholder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.exists.mockResolvedValue(true);
  });

  it('returns the placeholder when the DB flag is set', async () => {
    mockDbGet.mockResolvedValue(PLACEHOLDER_ROW);
    const res = fakeRes();
    await handler({ params: { id: 'ATV001' } }, res);
    expect(res.body.placeholder).toBe('Девчата 1961.mp4');
  });

  it('still returns the placeholder when the object is missing in storage', async () => {
    mockDbGet.mockResolvedValue(PLACEHOLDER_ROW);
    mockStorage.exists.mockResolvedValue(false);
    const res = fakeRes();
    await handler({ params: { id: 'ATV001' } }, res);
    expect(res.body.placeholder).toBe('Девчата 1961.mp4');
  });

  it('still returns the placeholder when storage throws', async () => {
    mockDbGet.mockResolvedValue(PLACEHOLDER_ROW);
    mockStorage.exists.mockRejectedValue(new Error('MinIO unreachable'));
    const res = fakeRes();
    await handler({ params: { id: 'ATV001' } }, res);
    expect(res.body.placeholder).toBe('Девчата 1961.mp4');
  });

  it('does not block on a hanging storage probe', async () => {
    mockDbGet.mockResolvedValue(PLACEHOLDER_ROW);
    // Проба не резолвится никогда — ответ всё равно должен прийти сразу.
    mockStorage.exists.mockImplementation(() => new Promise(() => {}));
    const res = fakeRes();
    const started = Date.now();
    await handler({ params: { id: 'ATV001' } }, res);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.body.placeholder).toBe('Девчата 1961.mp4');
  });

  it('returns null when no placeholder flag is set', async () => {
    mockDbGet.mockResolvedValue(null);
    const res = fakeRes();
    await handler({ params: { id: 'ATV001' } }, res);
    expect(res.body.placeholder).toBeNull();
  });

  it('returns 404 for an unknown device', async () => {
    const res = fakeRes();
    await handler({ params: { id: 'NOPE' } }, res);
    expect(res.statusCode).toBe(404);
  });
});