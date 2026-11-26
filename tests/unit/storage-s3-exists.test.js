/**
 * Регрессия: S3Storage.exists() возвращал false на таймаут/403 и не
 * передавал abortSignal в AWS SDK v3. Из-за этого рабочий объект считался
 * пропавшим, а очистка удаляла его метаданные.
 */
import { jest } from '@jest/globals';

const send = jest.fn();

jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send(command, options) {
      return send(command, options);
    }
  },
  HeadObjectCommand: class {
    constructor(input) { this.input = input; }
  },
  GetObjectCommand: class {
    constructor(input) { this.input = input; }
  },
  DeleteObjectCommand: class {
    constructor(input) { this.input = input; }
  },
  ListObjectsV2Command: class {
    constructor(input) { this.input = input; }
  },
  CopyObjectCommand: class {
    constructor(input) { this.input = input; }
  },
  CreateMultipartUploadCommand: class {},
  UploadPartCommand: class {},
  CompleteMultipartUploadCommand: class {}
}));

jest.unstable_mockModule('@aws-sdk/lib-storage', () => ({
  Upload: class {}
}));

const { S3Storage } = await import('../../src/storage/s3.js');

function s3Error(name, extra = {}) {
  const error = new Error(name);
  error.name = name;
  Object.assign(error, extra);
  return error;
}

function createStorage() {
  return new S3Storage({
    bucket: 'test',
    endpoint: 'http://127.0.0.1:9000',
    accessKeyId: 'key',
    secretAccessKey: 'secret'
  });
}

describe('S3Storage: конфигурация', () => {
  test('без ключей доступа — явная ошибка вместо тихого minioadmin', () => {
    expect(() => new S3Storage({
      bucket: 'test',
      endpoint: 'http://127.0.0.1:9000'
    })).toThrow(/S3_ACCESS_KEY and S3_SECRET_KEY/);
  });
});

describe('S3Storage.exists / checkExists', () => {
  let storage;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.S3_HEAD_TIMEOUT_MS;
    storage = createStorage();
  });

  afterEach(() => {
    delete process.env.S3_HEAD_TIMEOUT_MS;
  });

  test('present: объект есть', async () => {
    send.mockResolvedValue({ ContentLength: 42, LastModified: new Date(), Metadata: {} });

    await expect(storage.checkExists('content/a.mp4')).resolves.toMatchObject({
      state: 'present',
      stat: { size: 42 }
    });
    await expect(storage.exists('content/a.mp4')).resolves.toBe(true);
  });

  test('NoSuchKey: доказанное отсутствие', async () => {
    send.mockRejectedValue(s3Error('NoSuchKey'));

    await expect(storage.checkExists('content/a.mp4')).resolves.toMatchObject({ state: 'missing' });
    await expect(storage.exists('content/a.mp4')).resolves.toBe(false);
  });

  test('HTTP 404 без имени ошибки тоже missing', async () => {
    send.mockRejectedValue(s3Error('S3ServiceException', { $metadata: { httpStatusCode: 404 } }));

    await expect(storage.checkExists('content/a.mp4')).resolves.toMatchObject({ state: 'missing' });
    await expect(storage.exists('content/a.mp4')).resolves.toBe(false);
  });

  test('AccessDenied: не «нет файла», а unknown; exists fail-safe = true', async () => {
    send.mockRejectedValue(s3Error('AccessDenied'));

    const probe = await storage.checkExists('content/a.mp4');
    expect(probe.state).toBe('unknown');
    expect(probe.error).toBeTruthy();
    await expect(storage.exists('content/a.mp4')).resolves.toBe(true);
  });

  test('AbortError: unknown, exists = true', async () => {
    send.mockRejectedValue(s3Error('AbortError'));

    await expect(storage.checkExists('content/a.mp4')).resolves.toMatchObject({ state: 'unknown' });
    await expect(storage.exists('content/a.mp4')).resolves.toBe(true);
  });

  test('abortSignal передаётся вторым аргументом send(), а не в input команды', async () => {
    send.mockResolvedValue({ ContentLength: 1, LastModified: new Date(), Metadata: {} });

    await storage.checkExists('content/a.mp4');

    expect(send).toHaveBeenCalledTimes(1);
    const [command, options] = send.mock.calls[0];
    expect(command.input).toEqual({ Bucket: 'test', Key: 'content/a.mp4' });
    expect(command.input.abortController).toBeUndefined();
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(options.abortSignal.aborted).toBe(false);
  });

  test('таймаут HEAD не держит запрос и даёт unknown', async () => {
    process.env.S3_HEAD_TIMEOUT_MS = '25';
    send.mockImplementation((_command, options) => new Promise((_resolve, reject) => {
      options.abortSignal.addEventListener('abort', () => reject(s3Error('AbortError')));
    }));

    const startedAt = Date.now();
    const probe = await storage.checkExists('content/a.mp4');
    const elapsed = Date.now() - startedAt;

    expect(probe.state).toBe('unknown');
    expect(elapsed).toBeLessThan(1000);
  });

  test('stat: present отдаёт размер, missing бросает NotFound, unknown — исходную ошибку', async () => {
    send.mockResolvedValueOnce({ ContentLength: 7, LastModified: new Date(), Metadata: {} });
    await expect(storage.stat('content/a.mp4')).resolves.toMatchObject({ size: 7 });

    send.mockRejectedValueOnce(s3Error('NoSuchKey'));
    await expect(storage.stat('content/a.mp4')).rejects.toMatchObject({
      name: 'NotFound',
      code: 'NoSuchKey'
    });

    const unavailable = s3Error('AccessDenied');
    send.mockRejectedValueOnce(unavailable);
    await expect(storage.stat('content/a.mp4')).rejects.toBe(unavailable);
  });
});
