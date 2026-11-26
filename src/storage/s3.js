import { StorageProvider } from './provider.js';
import { PassThrough } from 'node:stream';

/**
 * Таймауты S3-операций. HEAD/GET-заголовки короткие, а тело Big-файлов может
 * идти долго — поэтому для тела отдельный idle-таймаут, который сбрасывается
 * на каждый chunk. Все значения настраиваются через env, без хардкода.
 */
function getTimeoutMs(primary, fallbackName, fallbackMs) {
  const primaryValue = Number(process.env[primary]);
  if (Number.isFinite(primaryValue) && primaryValue > 0) return primaryValue;
  const fallbackValue = Number(process.env[fallbackName]);
  if (Number.isFinite(fallbackValue) && fallbackValue > 0) return fallbackValue;
  return fallbackMs;
}

function timeoutError(message) {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

/**
 * S3-совместимые хранилища по-разному называют «объекта нет»: AWS SDK v3
 * отдаёт NoSuchKey/NotFound, MinIO может добавить код в `Code`, а HTTP-слой —
 * только 404. Все остальные ошибки (403, таймаут, сеть, 5xx) означают
 * «проверить не удалось», а не «объекта нет».
 */
function isNotFoundError(error) {
  if (!error) return false;
  const name = String(error.name || '');
  const code = String(error.Code || error.code || '');
  const status = Number(error.$metadata?.httpStatusCode || error.statusCode || 0);
  return (
    name === 'NotFound' ||
    name === 'NoSuchKey' ||
    code === 'NotFound' ||
    code === 'NoSuchKey' ||
    status === 404
  );
}

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
    // Раньше отсутствующие ключи молча подменялись minioadmin: для внешнего
    // S3 это выглядело как непонятный 403 вместо явной ошибки конфигурации.
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY must be set for S3 storage');
    }

    this.#bucket = bucket || 'mmrc';
    this.#root = root ? root.replace(/^\/+|\/+$/g, '') + '/' : '';

    this.#client = new S3.S3Client({
      endpoint,
      region: region || 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: forcePathStyle !== false,
      // Таймаут только на установку соединения: без него зависший MinIO
      // держал HTTP-запросы бесконечно, и запросы к /api/devices/:id/placeholder
      // упирались в клиентский таймаут. socketTimeout намеренно НЕ задаём —
      // он обрывал бы долгие передачи больших видео.
      connectTimeout: Number(process.env.S3_CONNECT_TIMEOUT_MS) || 5000
    });
  }

  get root() {
    return this.#root ? `s3://${this.#bucket}/${this.#root}` : `s3://${this.#bucket}/`;
  }

  get bucket() {
    return this.#bucket;
  }

  get keyPrefix() {
    return this.#root;
  }

  _key(key) {
    return this.#root + String(key).replace(/^\/+/, '');
  }

  /**
   * CopySource — это URL-путь. encodeURI() оставляет `#` и `?` как есть,
   * из-за чего объект `clip#1.mp4` превращался в обрезанный ключ и копирование
   * падало/копировало не то. Кодируем каждый сегмент отдельно.
   */
  _copySourceFor(sourceStorage, key) {
    const fullKey = `${sourceStorage.keyPrefix}${String(key).replace(/^\/+/, '')}`;
    const encodedKey = fullKey
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
    return `/${sourceStorage.bucket}/${encodedKey}`;
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
      return await parallelUpload.done();
    }
    const cmd = new S3.PutObjectCommand({
      Bucket: this.#bucket,
      Key: this._key(key),
      Body: data
    });
    return await this.#client.send(cmd);
  }

  /** незавершённая multipart-загрузка не должна оставаться в бакете после ошибки */
  async #abortMultipart(key, uploadId) {
    if (!uploadId) return;
    try {
      await this.#client.send(new S3.AbortMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: this._key(key),
        UploadId: uploadId
      }));
    } catch (error) {
      // Вторичная ошибка не должна маскировать original-ошибку загрузки.
      console.warn('[S3Storage] Failed to abort multipart upload', {
        key: String(key), error: error?.message || String(error)
      });
    }
  }

  /**
   * Потоковая загрузка — память не растёт вместе с размером файла.
   * Используется при синхронизации больших видео после оптимизации,
   * где обычный write() требовал бы держать весь файл в памяти.
   */
  async writeStream(key, stream) {
    if (libStorage) {
      const abortController = new AbortController();
      const parallelUpload = new libStorage.Upload({
        client: this.#client,
        params: {
          Bucket: this.#bucket,
          Key: this._key(key),
          Body: stream
        },
        queueSize: 4,
        partSize: 5 * 1024 * 1024,
        abortController
      });
      let completed = false;
      // Обрыв потока-источника (отмена клиентом, ошибка ffmpeg) не должен
      // оставлять незавершённые части в бакете.
      stream?.once?.('error', () => { if (!completed) parallelUpload.abort(); });
      stream?.once?.('close', () => {
        if (!completed && !stream.readableEnded) parallelUpload.abort();
      });
      try {
        const result = await parallelUpload.done();
        completed = true;
        return result;
      } catch (error) {
        completed = true;
        if (parallelUpload.uploadId) await this.#abortMultipart(key, parallelUpload.uploadId);
        throw error;
      }
    }

    // Без lib-storage читаем поток частями в multipart-загрузку вручную
    const partSize = 5 * 1024 * 1024;
    let uploadId = null;
    try {
      uploadId = (await this.#client.send(new S3.CreateMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: this._key(key)
      }))).UploadId;

      const parts = [];
      let partNumber = 1;
      let buffer = Buffer.alloc(0);
      const source = typeof stream?.pipe === 'function' ? stream : stream;
      const chunks = source[Symbol.asyncIterator]
        ? source[Symbol.asyncIterator]()
        : (async function* () { yield* source; })();

      for await (const chunk of chunks) {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        while (buffer.length >= partSize) {
          const part = buffer.subarray(0, partSize);
          buffer = buffer.subarray(partSize);
          const uploaded = await this.#client.send(new S3.UploadPartCommand({
            Bucket: this.#bucket,
            Key: this._key(key),
            UploadId: uploadId,
            PartNumber: partNumber++,
            Body: part
          }));
          parts.push({ ETag: uploaded.ETag, PartNumber: partNumber - 1 });
        }
      }

      if (buffer.length || parts.length === 0) {
        const uploaded = await this.#client.send(new S3.UploadPartCommand({
          Bucket: this.#bucket,
          Key: this._key(key),
          UploadId: uploadId,
          PartNumber: partNumber++,
          Body: buffer
        }));
        parts.push({ ETag: uploaded.ETag, PartNumber: partNumber - 1 });
      }

      return await this.#client.send(new S3.CompleteMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: this._key(key),
        UploadId: uploadId,
        MultipartUpload: { Parts: parts }
      }));
    } catch (error) {
      await this.#abortMultipart(key, uploadId);
      throw error;
    }
  }

  async delete(key) {
    const cmd = new S3.DeleteObjectCommand({ Bucket: this.#bucket, Key: this._key(key) });
    await this.#client.send(cmd);
  }

  /**
   * HEAD с таймаутом и честным три-состоянием.
   *
   * `abortSignal` обязан идти вторым аргументом `send()`: AWS SDK v3 не
   * читает `abortController` из input команды, поэтому прежний таймаут
   * фактически не работал.
   */
  async #probe(key) {
    const controller = new AbortController();
    const configured = Number(process.env.S3_HEAD_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 4000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const cmd = new S3.HeadObjectCommand({
        Bucket: this.#bucket,
        Key: this._key(key)
      });
      const response = await this.#client.send(cmd, { abortSignal: controller.signal });
      return {
        state: 'present',
        stat: {
          size: response.ContentLength,
          modifiedAt: response.LastModified,
          createdAt: response.LastModified,
          isDirectory: false,
          isFile: true,
          metadata: response.Metadata,
          contentType: response.ContentType,
          // Дополнительная проверка целостности, когда S3 её предоставляет.
          // ETag у multipart — не MD5, поэтому сравнивать его как хэш нельзя;
          // используем только явно поименованные checksum-поля.
          etag: response.ETag,
          checksums: Object.fromEntries(
            Object.entries(response).filter(([name]) => name.startsWith('Checksum') && typeof response[name] === 'string')
          )
        }
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return { state: 'missing', error };
      }
      return { state: 'unknown', error };
    } finally {
      clearTimeout(timer);
    }
  }

  async checkExists(key) {
    return this.#probe(key);
  }

  async exists(key) {
    // exists() зовут из синхронных путей API (список файлов, заглушки,
    // превью), поэтому зависшая проба не должна держать запрос. HEAD сам по
    // себе мгновенный: превышение времени означает проблему со связью или
    // правами, а не отсутствие объекта. Fail-safe: «не знаю» трактуем как
    // «есть», иначе кратковременный сбой MinIO выглядит как пропажа файла
    // и приводит к удалению метаданных/пропуску объекта при удалении.
    const probe = await this.#probe(key);
    if (probe.state === 'unknown') {
      console.warn('[S3Storage] exists() не смог проверить объект, считаем существующим', {
        key: String(key),
        error: probe.error?.name || probe.error?.message || 'unknown'
      });
      return true;
    }
    return probe.state === 'present';
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

  /**
   * Сумма размеров объектов по префиксу. ListObjectsV2 уже отдаёт Size,
   * поэтому дополнительных HEAD-запросов не делаем.
   */
  async du(prefix = '') {
    let total = 0;
    let continuationToken;
    try {
      do {
        const cmd = new S3.ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: this._key(prefix),
          ContinuationToken: continuationToken
        });
        const response = await this.#client.send(cmd);

        for (const obj of response.Contents || []) {
          total += obj.Size || 0;
        }

        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
      return total;
    } catch {
      return null;
    }
  }

  async copy(src, dest) {
    const cmd = new S3.CopyObjectCommand({
      Bucket: this.#bucket,
      CopySource: this._copySourceFor(this, src),
      Key: this._key(dest)
    });
    await this.#client.send(cmd);
  }

  /**
   * Копирование между разными корнями (например, при смене contentRoot).
   * sourceStorage должен быть S3Storage.
   */
  async copyFrom(sourceStorage, src, dest) {
    if (!sourceStorage || typeof sourceStorage.keyPrefix !== 'string') {
      throw new Error('S3Storage.copyFrom requires an S3Storage source');
    }
    const cmd = new S3.CopyObjectCommand({
      Bucket: this.#bucket,
      CopySource: this._copySourceFor(sourceStorage, src),
      Key: this._key(dest)
    });
    await this.#client.send(cmd);
  }

  async move(src, dest) {
    await this.copy(src, dest);
    await this.delete(src);
  }

  async stat(key) {
    const probe = await this.#probe(key);
    if (probe.state === 'present') return probe.stat;
    if (probe.state === 'missing') {
      const error = new Error(`S3 object not found: ${key}`);
      error.name = 'NotFound';
      error.code = 'NoSuchKey';
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    }
    throw probe.error;
  }

  async createReadStream(key, range) {
    const input = { Bucket: this.#bucket, Key: this._key(key) };
    if (range) {
      input.Range = `bytes=${range.start}-${range.end}`;
    }

    const controller = new AbortController();
    const headerTimeoutMs = getTimeoutMs('S3_GET_TIMEOUT_MS', 'S3_HEAD_TIMEOUT_MS', 4000);
    const idleTimeoutMs = getTimeoutMs('S3_STREAM_IDLE_TIMEOUT_MS', 'S3_IDLE_TIMEOUT_MS', 30000);
    let timer = setTimeout(() => controller.abort(timeoutError('S3 GET: заголовки не получены')), headerTimeoutMs);

    let response;
    try {
      const cmd = new S3.GetObjectCommand(input);
      response = await this.#client.send(cmd, { abortSignal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }

    const body = response.Body;
    let finished = false;
    const abortWith = (error) => {
      if (finished) return;
      controller.abort(error);
      body?.destroy?.(error);
    };
    const resetIdle = () => {
      clearTimeout(timer);
      if (finished) return;
      timer = setTimeout(() => {
        abortWith(timeoutError('S3 GET: тело не передаётся'));
      }, idleTimeoutMs);
    };
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
    };

    // 'readable' (а не 'data') не переводит поток в flowing-режим до consumer'а.
    body.on('readable', resetIdle);
    body.on('end', cleanup);
    body.on('error', cleanup);
    body.on('close', () => {
      if (!finished) controller.abort();
      cleanup();
    });
    resetIdle();

    return body;
  }

  createWriteStream(key) {
    if (!libStorage) {
      // Fallback: буферизуем в память и заливаем одним PutObject
      const chunks = [];
      const stream = new PassThrough();
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('finish', () => {
        this.write(key, Buffer.concat(chunks)).catch((err) => stream.emit('error', err));
      });
      return stream;
    }

    const stream = new PassThrough();
    const abortController = new AbortController();
    const upload = new libStorage.Upload({
      client: this.#client,
      params: {
        Bucket: this.#bucket,
        Key: this._key(key),
        Body: stream
      },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
      abortController
    });

    let completed = false;
    const abortUpload = () => {
      if (completed) return;
      completed = true;
      upload.abort();
      if (upload.uploadId) this.#abortMultipart(key, upload.uploadId).catch(() => {});
    };
    stream.once('error', abortUpload);
    stream.once('close', () => {
      if (!stream.writableFinished) abortUpload();
    });

    // Пробрасываем ошибки загрузки в стрим, чтобы потребитель не получал unhandled rejection
    upload.done()
      .then(() => { completed = true; })
      .catch((err) => {
        completed = true;
        stream.destroy(err);
      });

    return stream;
  }

  async rm(key) {
    const s3Key = this._key(key);
    // S3 не сообщает об отсутствии ключа при DeleteObject (всегда 204),
    // поэтому листинг по префиксу — единственный надёжный способ.
    // Удаляем только объекты, принадлежащие искомому ключу/префиксу
    // (точное совпадение или дети через '/'), чтобы не задеть соседние ключи.
    let continuationToken;
    do {
      const listCmd = new S3.ListObjectsV2Command({
        Bucket: this.#bucket,
        Prefix: s3Key,
        MaxKeys: 1000,
        ContinuationToken: continuationToken
      });
      const response = await this.#client.send(listCmd);
      const owned = (response.Contents || [])
        .map(obj => obj.Key)
        .filter(k => k === s3Key || k.startsWith(s3Key + '/'));

      if (owned.length > 0) {
        await this.#client.send(new S3.DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: { Objects: owned.map(k => ({ Key: k })), Quiet: true }
        }));
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
  }
}
