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

  /**
   * Проверка существования с тремя состояниями.
   *
   * `exists()` намеренно возвращает boolean и в спорных случаях (таймаут,
   * нет прав, обрыв сети) отвечает true, чтобы не выдать рабочий файл за
   * пропавший. Для решений, где ошибка «не знаю» недопустима (очистка
   * метаданных, дедупликация, подтверждение загрузки), нужен явный state.
   *
   * @returns {Promise<{state: 'present'|'missing'|'unknown', error?: Error}>}
   */
  async checkExists(key) {
    try {
      return { state: (await this.exists(key)) ? 'present' : 'missing' };
    } catch (error) {
      return { state: 'unknown', error };
    }
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
