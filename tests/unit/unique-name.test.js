import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { findAvailableSafeName } = await import('../../src/storage/unique-name.js');
const { getDataRoot } = await import('../../src/config/settings-manager.js');

const localRoot = mkdtempSync(path.join(os.tmpdir(), 'unique-name-'));

afterAll(() => {
  rmSync(localRoot, { recursive: true, force: true });
});

describe('findAvailableSafeName: локальные коллизии', () => {
  test('занятое имя файла получает суффикс', async () => {
    writeFileSync(path.join(localRoot, 'clip.mp4'), 'x');

    const result = await findAvailableSafeName('clip.mp4', localRoot, null);

    expect(result).not.toBe('clip.mp4');
    expect(result).toMatch(/^clip_[0-9a-f]{6}\.mp4$/);
  });

  test('папка с именем будущего PDF-каталога считается коллизией', async () => {
    mkdirSync(path.join(localRoot, 'deck'), { recursive: true });

    const result = await findAvailableSafeName('deck.pdf', localRoot, null);

    expect(result).toMatch(/^deck_[0-9a-f]{6}\.pdf$/);
  });

  test('свободное имя не меняется', async () => {
    const result = await findAvailableSafeName('free.pdf', localRoot, null);
    expect(result).toBe('free.pdf');
  });
});

describe('findAvailableSafeName: коллизии S3', () => {
  test('учитывает объект и папку-префикс в хранилище', async () => {
    const dataRoot = getDataRoot();
    const devicesPath = path.join(dataRoot, 'content');
    const toKey = (name) => path.relative(dataRoot, path.join(devicesPath, name)).split(path.sep).join('/');

    const objects = new Set([toKey('taken.mp4'), `${toKey('deck')}/page-1.png`]);
    const storage = {
      isLocal: false,
      async checkExists(key) {
        return objects.has(key) ? { state: 'present', stat: { size: 1 } } : { state: 'missing' };
      },
      async list(prefix) {
        return [...objects].filter(key => key.startsWith(prefix));
      }
    };

    await expect(findAvailableSafeName('taken.mp4', devicesPath, storage))
      .resolves.toMatch(/^taken_[0-9a-f]{6}\.mp4$/);
    await expect(findAvailableSafeName('deck.pdf', devicesPath, storage))
      .resolves.toMatch(/^deck_[0-9a-f]{6}\.pdf$/);
  });
});
