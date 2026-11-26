import path from 'node:path';

const { getDataRoot } = await import('../../src/config/settings-manager.js');
const { toStorageKey, toStoragePrefix } = await import('../../src/storage/sync.js');

describe('storage-префиксы для list()', () => {
  test('toStoragePrefix всегда добавляет завершающий /', () => {
    const dir = path.join(getDataRoot(), 'content', 'dev', 'deck');
    expect(toStoragePrefix(dir)).toBe('content/dev/deck/');
  });

  test('toStorageKey нормализует обратные слэши и не добавляет /', () => {
    const dir = path.join(getDataRoot(), 'content', 'dev');
    expect(toStorageKey(dir)).toBe('content/dev');
  });

  test('корень данных даёт пустой префикс', () => {
    expect(toStoragePrefix(getDataRoot())).toBe('');
  });
});
