/**
 * Единый tri-state helper: все точки принятия решений должны получать
 * одинаковый ответ и не превращать сбой проверки в «файла нет».
 */
const { probeStorageKey } = await import('../../src/storage/probe.js');

describe('probeStorageKey', () => {
  test('использует checkExists и возвращает его состояние как есть', async () => {
    const storage = {
      async checkExists() {
        return { state: 'missing', error: new Error('NoSuchKey') };
      }
    };

    await expect(probeStorageKey(storage, 'content/a.mp4')).resolves.toMatchObject({
      state: 'missing'
    });
  });

  test('исключение checkExists — unknown, а не missing', async () => {
    const storage = {
      async checkExists() {
        throw new Error('HEAD timeout');
      }
    };

    await expect(probeStorageKey(storage, 'content/a.mp4')).resolves.toMatchObject({
      state: 'unknown'
    });
  });

  test('поддерживает старый exists() без checkExists', async () => {
    await expect(probeStorageKey({ async exists() { return true; } }, 'a'))
      .resolves.toMatchObject({ state: 'present' });
    await expect(probeStorageKey({ async exists() { return false; } }, 'a'))
      .resolves.toMatchObject({ state: 'missing' });

    const broken = {
      async exists() {
        throw new Error('ECONNREFUSED');
      }
    };
    await expect(probeStorageKey(broken, 'a')).resolves.toMatchObject({ state: 'unknown' });
  });

  test('boolean от legacy checkExists не ломает вызывающий код', async () => {
    await expect(probeStorageKey({ async checkExists() { return true; } }, 'a'))
      .resolves.toMatchObject({ state: 'present' });
    await expect(probeStorageKey({ async checkExists() { return false; } }, 'a'))
      .resolves.toMatchObject({ state: 'missing' });
  });

  test('без хранилища — unknown', async () => {
    await expect(probeStorageKey(null, 'a')).resolves.toMatchObject({ state: 'unknown' });
  });
});
