/**
 * Единая проверка существования объекта в хранилище.
 *
 * Один и тот же tri-state (`present` / `missing` / `unknown`) нужен в
 * дедупликации, очистке метаданных, подтверждении загрузки, материализации
 * и оптимизаторе. Раньше каждая точка писала свою копию с `typeof checkExists`
 * и `catch`, из-за чего поведение при ошибке хранилища легко расходилось.
 *
 * Правило: всё, кроме доказанного `missing`, не даёт права удалять данные.
 *
 * @param {object|null} storage  экземпляр StorageProvider или совместимый объект
 * @param {string} key           ключ объекта
 * @returns {Promise<{state: 'present'|'missing'|'unknown', error?: Error, stat?: object}>}
 */
export async function probeStorageKey(storage, key) {
  if (!storage) {
    return { state: 'unknown', error: new Error('Storage provider is not configured') };
  }

  if (typeof storage.checkExists === 'function') {
    try {
      const probe = await storage.checkExists(key);
      // Провайдеры обязаны возвращать объект состояния; boolean поддерживаем
      // для старых/внешних реализаций, чтобы они не ломали вызывающий код.
      if (probe && typeof probe === 'object' && probe.state) {
        return probe;
      }
      return { state: probe ? 'present' : 'missing' };
    } catch (error) {
      return { state: 'unknown', error };
    }
  }

  try {
    return { state: (await storage.exists(key)) ? 'present' : 'missing' };
  } catch (error) {
    return { state: 'unknown', error };
  }
}

/**
 * Доказано ли, что объект существует.
 * @param {object|null} storage
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function storageKeyIsPresent(storage, key) {
  const probe = await probeStorageKey(storage, key);
  return probe.state === 'present';
}
