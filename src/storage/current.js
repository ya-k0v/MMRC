/**
 * Текущий провайдер хранилища.
 *
 * Роутеры создаются один раз при старте, но contentRoot (а значит и корень
 * локального/S3-хранилища) может измениться через админку. Если передать им
 * конкретный экземпляр LocalStorage/S3Storage, после смены корня они будут
 * продолжать работать со старым. Поэтому наружу отдаётся стабильный handle,
 * который делегирует вызовы актуальному провайдеру.
 */

let storage = null;

function isStorageHandle(value) {
  return Boolean(value && typeof value === 'object' && typeof value.__setTarget === 'function');
}

export function createStorageHandle(initial) {
  let target = initial;

  return new Proxy({}, {
    get(_obj, prop) {
      if (prop === '__setTarget') {
        return (next) => {
          target = next;
        };
      }
      if (prop === '__target') {
        return target;
      }
      const value = target?.[prop];
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    },
    set(_obj, prop, value) {
      if (target) target[prop] = value;
      return true;
    },
    has(_obj, prop) {
      return Boolean(target && prop in target);
    }
  });
}

export function setCurrentStorage(next) {
  storage = next;
}

export function getCurrentStorage() {
  return storage;
}

/**
 * Заменить провайдер, сохранив стабильный handle для уже созданных роутеров.
 * Если handle не используется (например, в тестах), просто обновляем ссылку.
 */
export function replaceCurrentStorage(next) {
  if (isStorageHandle(storage)) {
    storage.__setTarget(next);
    return;
  }
  storage = next;
}
