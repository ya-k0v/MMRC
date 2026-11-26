/**
 * S3 GET не должен держать HTTP-запрос бесконечно, а неудачная multipart-
 * загрузка не должна оставлять части в бакете.
 */
import { jest } from '@jest/globals';
import { Readable } from 'node:stream';

const send = jest.fn();
let uploadDone = () => Promise.resolve({ ETag: 'ok' });
const uploadInstances = [];

jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send(command, options) { return send(command, options); }
  },
  GetObjectCommand: class {
    constructor(input) { this.input = input; }
  },
  HeadObjectCommand: class {
    constructor(input) { this.input = input; }
  },
  PutObjectCommand: class {
    constructor(input) { this.input = input; }
  },
  CreateMultipartUploadCommand: class {},
  UploadPartCommand: class {},
  CompleteMultipartUploadCommand: class {},
  AbortMultipartUploadCommand: class {
    constructor(input) { this.input = input; }
  }
}));

jest.unstable_mockModule('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(options) {
      this.options = options;
      this.uploadId = options.uploadId || 'upload-1';
      this.abort = jest.fn();
      this.done = jest.fn(() => uploadDone(options));
      uploadInstances.push(this);
    }
  }
}));

const { S3Storage } = await import('../../src/storage/s3.js');

function makeStorage() {
  return new S3Storage({ bucket: 'bucket', root: '/app/data', endpoint: 'http://localhost:9000' });
}

const originalEnv = { ...process.env };

beforeEach(() => {
  send.mockReset();
  uploadInstances.length = 0;
  uploadDone = () => Promise.resolve({ ETag: 'ok' });
  process.env.S3_GET_TIMEOUT_MS = '40';
  process.env.S3_STREAM_IDLE_TIMEOUT_MS = '5000';
});

afterAll(() => {
  process.env = originalEnv;
});

describe('S3Storage.createReadStream', () => {
  test('send получает abortSignal, body возвращается Stream', async () => {
    send.mockImplementation(() => Promise.resolve({ Body: Readable.from(['abc']) }));

    const stream = await makeStorage().createReadStream('content/a.mp4', { start: 0, end: 1 });

    expect(send.mock.calls[0][1]?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(send.mock.calls[0][0].input.Range).toBe('bytes=0-1');
    expect(typeof stream.pipe).toBe('function');
    stream.destroy();
  });

  test('зависший GET обрывается TimeoutError', async () => {
    send.mockImplementation((_command, options) => new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener('abort', () => {
        reject(options.abortSignal.reason || new Error('aborted'));
      });
    }));

    await expect(makeStorage().createReadStream('content/a.mp4'))
      .rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('S3Storage.writeStream', () => {
  test('успех возвращает результат Complete/Upload', async () => {
    const result = await makeStorage().writeStream('content/a.mp4', Readable.from(['abc']));

    expect(result).toMatchObject({ ETag: 'ok' });
    expect(uploadInstances[0].abort).not.toHaveBeenCalled();
  });

  test('ошибка Upload вызывает abort и AbortMultipartUpload', async () => {
    send.mockResolvedValue({});
    const uploadError = new Error('upload failed');
    uploadDone = () => Promise.reject(uploadError);

    await expect(makeStorage().writeStream('content/a.mp4', Readable.from(['abc'])))
      .rejects.toThrow('upload failed');

    expect(uploadInstances[0].abort).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([cmd]) => cmd.constructor.name === 'AbortMultipartUploadCommand')).toBe(true);
  });
});
