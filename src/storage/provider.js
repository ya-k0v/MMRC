export class StorageProvider {
  async read(key) {
    throw new Error('not implemented');
  }

  async write(key, data) {
    throw new Error('not implemented');
  }

  async delete(key) {
    throw new Error('not implemented');
  }

  async exists(key) {
    throw new Error('not implemented');
  }

  async list(prefix = '') {
    throw new Error('not implemented');
  }

  async copy(src, dest) {
    throw new Error('not implemented');
  }

  async move(src, dest) {
    throw new Error('not implemented');
  }

  async rm(key) {
    throw new Error('not implemented');
  }

  async stat(key) {
    throw new Error('not implemented');
  }

  /**
   * Суммарный объём данных по префиксу (рекурсивно для локальных путей,
   * по всем объектам — для S3). Возвращает количество байт или null,
   * если содержимое недоступно для подсчёта.
   */
  async du(prefix = '') {
    throw new Error('not implemented');
  }

  createReadStream(key, range) {
    throw new Error('not implemented');
  }

  createWriteStream(key) {
    throw new Error('not implemented');
  }

  async ensureDir(dir) {
  }

  resolve(key) {
    throw new Error('StorageProvider does not support direct filesystem access');
  }

  get root() {
    throw new Error('not implemented');
  }
}
