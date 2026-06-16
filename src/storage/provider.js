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

  createReadStream(key) {
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
