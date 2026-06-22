import { StorageProvider } from './provider.js';

let S3;
let libStorage;
try {
  S3 = await import('@aws-sdk/client-s3');
  libStorage = await import('@aws-sdk/lib-storage');
} catch (err) {
  S3 = null;
  libStorage = null;
  console.warn('[S3Storage] @aws-sdk/client-s3 not available, install with: npm install @aws-sdk/client-s3');
}

export class S3Storage extends StorageProvider {
  #client;
  #bucket;
  #root;

  constructor({ bucket, endpoint, region, accessKeyId, secretAccessKey, forcePathStyle = true, root = '' }) {
    super();
    if (!S3) throw new Error('@aws-sdk/client-s3 is not installed');

    this.#bucket = bucket || 'mmrc';
    this.#root = root ? root.replace(/^\/+|\/+$/g, '') + '/' : '';

    this.#client = new S3.S3Client({
      endpoint,
      region: region || 'us-east-1',
      credentials: {
        accessKeyId: accessKeyId || 'minioadmin',
        secretAccessKey: secretAccessKey || 'minioadmin'
      },
      forcePathStyle: forcePathStyle !== false
    });
  }

  get root() {
    return this.#root ? `s3://${this.#bucket}/${this.#root}` : `s3://${this.#bucket}/`;
  }

  _key(key) {
    return this.#root + String(key).replace(/^\/+/, '');
  }

  async read(key) {
    const cmd = new S3.GetObjectCommand({ Bucket: this.#bucket, Key: this._key(key) });
    const response = await this.#client.send(cmd);
    const bytes = [];
    for await (const chunk of response.Body) {
      bytes.push(chunk);
    }
    return Buffer.concat(bytes);
  }

  async write(key, data) {
    if (libStorage) {
      const parallelUpload = new libStorage.Upload({
        client: this.#client,
        params: {
          Bucket: this.#bucket,
          Key: this._key(key),
          Body: data
        },
        queueSize: 4,
        partSize: 5 * 1024 * 1024
      });
      await parallelUpload.done();
    } else {
      const cmd = new S3.PutObjectCommand({
        Bucket: this.#bucket,
        Key: this._key(key),
        Body: data
      });
      await this.#client.send(cmd);
    }
  }

  async delete(key) {
    const cmd = new S3.DeleteObjectCommand({ Bucket: this.#bucket, Key: this._key(key) });
    await this.#client.send(cmd);
  }

  async exists(key) {
    try {
      const cmd = new S3.HeadObjectCommand({ Bucket: this.#bucket, Key: this._key(key) });
      await this.#client.send(cmd);
      return true;
    } catch (err) {
      if (err.name === 'NotFound' || err.name === 'NoSuchKey') return false;
      if (err.name === 'AccessDenied') return false;
      throw err;
    }
  }

  async list(prefix = '') {
    const objects = [];
    let continuationToken;

    do {
      const cmd = new S3.ListObjectsV2Command({
        Bucket: this.#bucket,
        Prefix: this._key(prefix),
        ContinuationToken: continuationToken
      });
      const response = await this.#client.send(cmd);

      if (response.Contents) {
        for (const obj of response.Contents) {
          objects.push(obj.Key.slice(this.#root.length));
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return objects;
  }

  async copy(src, dest) {
    const cmd = new S3.CopyObjectCommand({
      Bucket: this.#bucket,
      CopySource: `/${this.#bucket}/${encodeURI(this._key(src))}`,
      Key: this._key(dest)
    });
    await this.#client.send(cmd);
  }

  async move(src, dest) {
    await this.copy(src, dest);
    await this.delete(src);
  }

  async stat(key) {
    const cmd = new S3.HeadObjectCommand({ Bucket: this.#bucket, Key: this._key(key) });
    const response = await this.#client.send(cmd);
    return {
      size: response.ContentLength,
      modifiedAt: response.LastModified,
      createdAt: response.LastModified,
      isDirectory: false,
      isFile: true,
      metadata: response.Metadata,
      contentType: response.ContentType
    };
  }

  async createReadStream(key, range) {
    const input = { Bucket: this.#bucket, Key: this._key(key) };
    if (range) {
      input.Range = `bytes=${range.start}-${range.end}`;
    }
    const cmd = new S3.GetObjectCommand(input);
    const response = await this.#client.send(cmd);
    return response.Body;
  }

  createWriteStream(key) {
    throw new Error('S3 createWriteStream not yet implemented, use write() instead');
  }

  async rm(key) {
    const s3Key = this._key(key);
    // Сначала пробуем точное удаление (для файлов)
    try {
      await this.#client.send(new S3.DeleteObjectCommand({ Bucket: this.#bucket, Key: s3Key }));
      return;
    } catch (e) {
      // Если ключ не найден, возможно это "папка" (префикс) — удаляем по префиксу
      if (e.name !== 'NotFound' && e.name !== 'NoSuchKey') throw e;
    }
    // Префиксное удаление для директорий
    let continuationToken;
    do {
      const listCmd = new S3.ListObjectsV2Command({
        Bucket: this.#bucket,
        Prefix: s3Key,
        MaxKeys: 1000,
        ContinuationToken: continuationToken
      });
      const response = await this.#client.send(listCmd);
      if (response.Contents && response.Contents.length > 0) {
        await this.#client.send(new S3.DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: { Objects: response.Contents.map(obj => ({ Key: obj.Key })), Quiet: true }
        }));
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
  }
}
