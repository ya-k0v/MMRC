import { getStorageErrorStatus, storageErrorBody, isClientDisconnectError } from '../../src/storage/errors.js';

function error(name, extra = {}) {
  const e = new Error(name);
  e.name = name;
  Object.assign(e, extra);
  return e;
}

describe('getStorageErrorStatus', () => {
  test.each([
    [error('NoSuchKey'), 404],
    [error('NotFound'), 404],
    [error('ENOENT'), 404],
    [error('Any', { $metadata: { httpStatusCode: 404 } }), 404],
    [error('AccessDenied'), 403],
    [error('Forbidden'), 403],
    [error('EACCES'), 403],
    [error('AbortError'), 503],
    [error('TimeoutError'), 503],
    [error('ECONNRESET'), 503],
    [error('ETIMEDOUT'), 503],
    [error('Any', { $metadata: { httpStatusCode: 500 } }), 503],
    [error('Weird'), 500]
  ])('классифицирует %s как %i', (input, expected) => {
    expect(getStorageErrorStatus(input)).toBe(expected);
  });

  test('undefined → 500', () => {
    expect(getStorageErrorStatus(undefined)).toBe(500);
  });
});

describe('storageErrorBody', () => {
  test('не раскрывает внутренние детали', () => {
    expect(storageErrorBody(404).error).toMatch(/не найден/i);
    expect(storageErrorBody(403).error).toMatch(/запрещ/i);
    expect(storageErrorBody(503).error).toMatch(/недоступ/i);
    expect(storageErrorBody(500).error).toMatch(/ошибка/i);
  });
});

describe('isClientDisconnectError', () => {
  test('обрыв клиента распознаётся', () => {
    expect(isClientDisconnectError(error('ECONNRESET'))).toBe(true);
    expect(isClientDisconnectError(error('ERR_STREAM_PREMATURE_CLOSE'))).toBe(true);
    expect(isClientDisconnectError(error('Error', { message: 'request aborted' }))).toBe(true);
  });

  test('ошибка хранилища не считается обрывом клиента', () => {
    expect(isClientDisconnectError(error('NoSuchKey'))).toBe(false);
    expect(isClientDisconnectError(error('AccessDenied'))).toBe(false);
  });
});
