import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';

export function createStorage(dataRoot) {
  const backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();

  if (backend === 's3' || backend === 'minio') {
    return new S3Storage({
      bucket: process.env.S3_BUCKET,
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      root: dataRoot
    });
  }

  return new LocalStorage(dataRoot);
}
