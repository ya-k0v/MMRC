/**
 * Регрессии стартовой миграции и подмены storage-провайдера.
 */
import path from 'node:path';

const {
  inferLegacyContentRoot,
  getDataRoot,
  updateContentRootPath
} = await import('../../src/config/settings-manager.js');
const { getCurrentStorage, setCurrentStorage } = await import('../../src/storage/current.js');

describe('inferLegacyContentRoot', () => {
  test('возвращает корень до маркера content', () => {
    expect(inferLegacyContentRoot('/mnt/data/content/dev/a.mp4')).toBe('/mnt/data');
  });

  test('понимает windows-разделители и другие подкаталоги данных', () => {
    expect(inferLegacyContentRoot('C:\\data\\converted\\slide.pdf')).toBe('C:/data');
    expect(inferLegacyContentRoot('/srv/mmrc/streams/chunk.ts')).toBe('/srv/mmrc');
  });

  test('без маркера не угадывает корень через dirname', () => {
    expect(inferLegacyContentRoot('/mnt/data/dev/a.mp4')).toBeNull();
    expect(inferLegacyContentRoot('')).toBeNull();
  });
});

describe('updateContentRootPath при том же корне', () => {
  test('пересоздаёт storage provider с актуальным бэкендом', async () => {
    const sentinel = { isLocal: true, marker: 'old-provider' };
    setCurrentStorage(sentinel);
    expect(getCurrentStorage()).toBe(sentinel);

    await updateContentRootPath(getDataRoot());

    const next = getCurrentStorage();
    expect(next).not.toBe(sentinel);
    expect(next.root).toBe(path.resolve(getDataRoot()));
  });
});
