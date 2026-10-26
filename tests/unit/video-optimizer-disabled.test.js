/**
 * Регрессия: при выключенной оптимизации autoOptimizeVideo() выходил до
 * коммита, и видео в S3-режиме оставалось только на локальном диске.
 */
import { jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configPath = path.join(
  mkdtempSync(path.join(os.tmpdir(), 'video-opt-disabled-')),
  'video-optimization.json'
);
writeFileSync(configPath, JSON.stringify({ enabled: false }), 'utf8');

const actualConstants = await import('../../src/config/constants.js');
jest.unstable_mockModule('../../src/config/constants.js', () => ({
  ...actualConstants,
  VIDEO_OPTIMIZATION_CONFIG_PATH: configPath
}));

const { initDatabase, closeDatabase, getDatabase } = await import('../../src/database/database.js');
const { saveFileMetadata } = await import('../../src/database/files-metadata.js');
const { autoOptimizeVideo } = await import('../../src/video/optimizer.js');
const { getDevicesPath } = await import('../../src/config/settings-manager.js');

const deviceId = 'opt-disabled-dev';
const fileName = 'clip.mp4';
const deviceFolder = path.join(getDevicesPath(), deviceId);
const filePath = path.join(deviceFolder, fileName);

const storage = {
  isLocal: false,
  async exists() { return false; },
  async writeStream(_key, stream) {
    for await (const _chunk of stream) {
      // потребляем поток, чтобы файл был реально прочитан до удаления
    }
  },
  async checkExists() {
    return { state: 'present', stat: { size: 5 } };
  }
};

beforeAll(async () => {
  mkdirSync(deviceFolder, { recursive: true });
  writeFileSync(filePath, 'video', 'utf8');
  await initDatabase(':memory:');
  await saveFileMetadata({
    deviceId,
    safeName: fileName,
    originalName: fileName,
    filePath,
    fileSize: 5,
    md5Hash: 'd41d8cd98f00b204e9800998ecf8427e',
    fileMtime: Date.now()
  });
});

beforeEach(async () => {
  await getDatabase().run('DELETE FROM files_metadata');
  writeFileSync(filePath, 'video', 'utf8');
  await saveFileMetadata({
    deviceId,
    safeName: fileName,
    originalName: fileName,
    filePath,
    fileSize: 5,
    md5Hash: 'd41d8cd98f00b204e9800998ecf8427e',
    fileMtime: Date.now()
  });
});

afterAll(async () => {
  await closeDatabase();
  rmSync(deviceFolder, { recursive: true, force: true });
  rmSync(path.dirname(configPath), { recursive: true, force: true });
});

test('disabled: оригинал коммитится в S3', async () => {
  const result = await autoOptimizeVideo(
    deviceId,
    fileName,
    { [deviceId]: { folder: deviceId } },
    { emit() {}, to() { return { emit() {} }; } },
    {},
    () => {},
    storage
  );

  expect(result).toMatchObject({
    success: false,
    message: 'Video optimization disabled',
    committed: true
  });
  expect(existsSync(filePath)).toBe(false);
});
