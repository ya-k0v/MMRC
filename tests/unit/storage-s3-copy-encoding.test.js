/**
 * CopySource — URL-путь. encodeURI() оставлял `#` и `?` как есть, поэтому
 * объект `clip#1.mp4` превращался в обрезанный ключ.
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
  DeleteObjectsCommand: class {
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

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({});
});

describe('S3Storage.copy: кодирование CopySource', () => {
  test('спецсимволы # и ? кодируются по сегментам', async () => {
    const storage = new S3Storage({
      bucket: 'bucket',
      root: '/app/data',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'key',
      secretAccessKey: 'secret'
    });

    await storage.copy('content/clip#1?.mp4', 'content/copy.mp4');

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    expect(command.input.CopySource).toBe('/bucket/app/data/content/clip%231%3F.mp4');
    expect(command.input.Key).toBe('app/data/content/copy.mp4');
  });

  test('copyFrom использует префикс источника, а не получателя', async () => {
    const source = new S3Storage({
      bucket: 'bucket',
      root: '/old/data',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'key',
      secretAccessKey: 'secret'
    });
    const target = new S3Storage({
      bucket: 'bucket',
      root: '/new/data',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'key',
      secretAccessKey: 'secret'
    });

    await target.copyFrom(source, 'content/a#b.mp4', 'content/a#b.mp4');

    const command = send.mock.calls[0][0];
    expect(command.input.CopySource).toBe('/bucket/old/data/content/a%23b.mp4');
    expect(command.input.Key).toBe('new/data/content/a#b.mp4');
  });
});
