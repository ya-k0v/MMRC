import { jest } from '@jest/globals';
import { Readable, Writable } from 'node:stream';

const DATA_ROOT = '/app/data';

const mockGetFileMetadata = jest.fn();
const mockGetAnyMetadata = jest.fn();
const mockStorage = {
  stat: jest.fn(),
  createReadStream: jest.fn(),
  exists: jest.fn()
};

// jest.requireActual не умеет синхронно грузить ESM, поэтому оригиналы
// импортируем напрямую и подмешиваем в мок.
const actualFilesMetadata = await import('../../src/database/files-metadata.js');
const actualSettings = await import('../../src/config/settings-manager.js');

jest.unstable_mockModule('../../src/database/files-metadata.js', () => ({
  ...actualFilesMetadata,
  getFileMetadata: (...args) => mockGetFileMetadata(...args),
  getAnyFileMetadataBySafeName: (...args) => mockGetAnyMetadata(...args)
}));

jest.unstable_mockModule('../../src/storage/current.js', () => ({
  getCurrentStorage: () => mockStorage
}));

jest.unstable_mockModule('../../src/config/settings-manager.js', () => ({
  ...actualSettings,
  getDataRoot: () => DATA_ROOT,
  getDevicesPath: () => `${DATA_ROOT}/content`
}));

const resolverRouter = (await import('../../src/routes/file-resolver.js')).default;

const FILE_SIZE = 1000;

function fakeRes() {
  const res = new Writable({ write(chunk, enc, cb) { cb(); } });
  res.statusCode = 200;
  res.headersSent = false;
  res.headers = {};
  res.status = function (code) { this.statusCode = code; return this; };
  // express поддерживает обе формы: set({...}) и set(field, value)
  res.set = function (field, value) {
    if (typeof field === 'object') Object.assign(this.headers, field);
    else this.headers[field] = value;
    return this;
  };
  res.send = function (body) { this.headersSent = true; this.body = body; return this; };
  res.end = function (...a) { this.headersSent = true; return Writable.prototype.end.apply(this, a); };
  return res;
}

function metadata(overrides = {}) {
  return {
    device_id: 'ATV001',
    safe_name: 'default.mp4',
    file_path: `${DATA_ROOT}/content/ATV001/default.mp4`,
    file_size: FILE_SIZE,
    mime_type: null,
    md5_hash: null,
    ...overrides
  };
}

async function request(overrides = {}, range = undefined, storageSize = FILE_SIZE) {
  mockStorage.stat.mockResolvedValue({ size: storageSize });
  mockStorage.createReadStream.mockImplementation(async () => Readable.from([Buffer.alloc(8)]));
  mockGetFileMetadata.mockResolvedValue(metadata(overrides));

  const layer = resolverRouter.stack.find((l) => l.route?.path === '/resolve/:deviceId/*fileName');
  const handler = layer.route.stack[0].handle;

  const req = { params: { deviceId: 'ATV001', fileName: 'default.mp4' }, headers: range ? { range } : {} };
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('отдача файла из S3 (sendFileFromStorage)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('берёт размер из хранилища, когда в БД он нулевой', async () => {
    const res = await request({ file_size: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Length']).toBe(FILE_SIZE);
    expect(mockStorage.stat).toHaveBeenCalled();
  });

  it('не шлёт Content-Range на полном ответе 200', async () => {
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Range']).toBeUndefined();
  });

  it('подставляет настоящий MIME по расширению, а не octet-stream', async () => {
    const res = await request({ mime_type: null, safe_name: 'default.mp4' });
    expect(res.headers['Content-Type']).toBe('video/mp4');
  });

  it('отдаёт 206 на открытом диапазоне bytes=0-', async () => {
    const res = await request({}, 'bytes=0-');
    expect(res.statusCode).toBe(206);
    expect(res.headers['Content-Range']).toBe(`bytes 0-${FILE_SIZE - 1}/${FILE_SIZE}`);
    expect(res.headers['Content-Length']).toBe(FILE_SIZE);
  });

  it('понимает суффиксный диапазон bytes=-N', async () => {
    const res = await request({}, 'bytes=-500');
    expect(res.statusCode).toBe(206);
    expect(res.headers['Content-Range']).toBe(`bytes 500-${FILE_SIZE - 1}/${FILE_SIZE}`);
  });

  it('обрезает end, если клиент просит больше размера файла', async () => {
    const res = await request({}, 'bytes=0-999999');
    expect(res.statusCode).toBe(206);
    expect(res.headers['Content-Range']).toBe(`bytes 0-${FILE_SIZE - 1}/${FILE_SIZE}`);
  });

  it('возвращает 416, если начало диапазона за пределами файла', async () => {
    const res = await request({}, 'bytes=5000-6000');
    expect(res.statusCode).toBe(416);
    expect(res.headers['Content-Range']).toBe(`bytes */${FILE_SIZE}`);
  });

  it('не превращает нераспознанный Range в 416', async () => {
    const res = await request({}, 'bytes=abc');
    expect(res.statusCode).toBe(200);
  });

  it('возвращает 404, когда размер неизвестен даже в хранилище', async () => {
    const res = await request({ file_size: 0 }, undefined, 0);
    expect(res.statusCode).toBe(404);
  });

  it('не отдаёт файл вне data root', async () => {
    mockGetFileMetadata.mockResolvedValue(metadata({ file_path: '/etc/passwd' }));
    mockStorage.stat.mockResolvedValue({ size: FILE_SIZE });
    mockStorage.createReadStream.mockImplementation(async () => Readable.from([Buffer.alloc(8)]));
    const layer = resolverRouter.stack.find((l) => l.route?.path === '/resolve/:deviceId/*fileName');
    const res = fakeRes();
    await layer.route.stack[0].handle(
      { params: { deviceId: 'ATV001', fileName: 'default.mp4' }, headers: {} },
      res
    );
    expect(res.statusCode).toBe(403);
  });
});