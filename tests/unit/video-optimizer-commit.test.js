/**
 * Регрессия: видео коммитил в S3 только успешный оптимизатор. При
 * выключенной оптимизации/ошибке/отмене файл оставался только на локальном
 * диске, который в S3-режиме является временной рабочей областью.
 */
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const { ensureOriginalCommitted } = await import('../../src/video/optimizer.js');
const { getDataRoot } = await import('../../src/config/settings-manager.js');

const workDir = mkdtempSync(path.join(getDataRoot(), 'video-commit-'));
let counter = 0;

function localFile(content = 'video') {
  const file = path.join(workDir, `video-${++counter}.mp4`);
  writeFileSync(file, content);
  return file;
}

function s3Storage({ checkState = 'present', size = 5 } = {}) {
  return {
    isLocal: false,
    async exists() { return false; },
    async writeStream(_key, stream) {
      for await (const _chunk of stream) {
        // потребляем поток, иначе fs.createReadStream откроет удалённый файл
      }
    },
    async checkExists() {
      return checkState === 'unknown'
        ? { state: 'unknown', error: new Error('HEAD timeout') }
        : { state: checkState, stat: { size } };
    }
  };
}

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('ensureOriginalCommitted', () => {
  test('локальный файл коммитится и удаляется после подтверждения', async () => {
    const file = localFile();
    const storage = s3Storage({ checkState: 'present', size: 5 });

    const result = await ensureOriginalCommitted(file, storage, {
      deviceId: 'dev', fileName: 'video.mp4'
    });

    expect(result).toMatchObject({ committed: true, reason: 'synced' });
    expect(existsSync(file)).toBe(false);
  });

  test('локального файла нет, но объект есть в S3 — committed', async () => {
    const file = path.join(workDir, 'already-in-s3.mp4');
    const storage = s3Storage({ checkState: 'present' });

    const result = await ensureOriginalCommitted(file, storage, {
      deviceId: 'dev', fileName: 'already-in-s3.mp4'
    });

    expect(result).toMatchObject({ committed: true, reason: 'present' });
  });

  test('unknown в S3 — committed false, локальный файл остаётся', async () => {
    const file = localFile();
    const storage = s3Storage({ checkState: 'unknown' });

    const result = await ensureOriginalCommitted(file, storage, {
      deviceId: 'dev', fileName: 'video.mp4'
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toBe('sync-failed');
    expect(existsSync(file)).toBe(true);
  });

  test('локального файла нет и S3 не подтверждает объект — committed false', async () => {
    const file = path.join(workDir, 'unknown-in-s3.mp4');
    const storage = s3Storage({ checkState: 'unknown' });

    const result = await ensureOriginalCommitted(file, storage, {
      deviceId: 'dev', fileName: 'unknown-in-s3.mp4'
    });

    expect(result).toMatchObject({ committed: false, reason: 'unknown' });
  });

  test('локальный backend ничего не коммитит', async () => {
    const file = localFile();

    const result = await ensureOriginalCommitted(file, { isLocal: true }, {
      deviceId: 'dev', fileName: 'video.mp4'
    });

    expect(result).toEqual({ committed: true, reason: 'local-storage' });
    expect(existsSync(file)).toBe(true);
  });
});
