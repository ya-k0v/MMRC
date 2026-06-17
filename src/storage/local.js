import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StorageProvider } from './provider.js';

export class LocalStorage extends StorageProvider {
  #root;

  constructor(root) {
    super();
    if (!root) throw new Error('LocalStorage requires a root path');
    this.#root = path.resolve(root);
    try {
      this.#root = fs.realpathSync(this.#root);
    } catch {
      // root doesn't exist yet, use resolved path
    }
  }

  get root() {
    return this.#root;
  }

  _resolve(key) {
    const resolved = path.resolve(this.#root, String(key));
    if (!resolved.startsWith(this.#root)) {
      throw new Error(`Path traversal detected: ${key}`);
    }
    return resolved;
  }

  async read(key) {
    return fsp.readFile(this._resolve(key));
  }

  async write(key, data) {
    const fullPath = this._resolve(key);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, data);
  }

  async delete(key) {
    const fullPath = this._resolve(key);
    try {
      await fsp.unlink(fullPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async exists(key) {
    try {
      await fsp.access(this._resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix = '') {
    const dir = this._resolve(prefix);
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.map(e => path.join(prefix, e.name));
    } catch {
      return [];
    }
  }

  async copy(src, dest) {
    await fsp.cp(this._resolve(src), this._resolve(dest), { recursive: true });
  }

  async move(src, dest) {
    await fsp.rename(this._resolve(src), this._resolve(dest));
  }

  async stat(key) {
    const s = await fsp.stat(this._resolve(key));
    return {
      size: s.size,
      modifiedAt: s.mtime,
      createdAt: s.birthtime,
      isDirectory: s.isDirectory(),
      isFile: s.isFile()
    };
  }

  createReadStream(key) {
    return fs.createReadStream(this._resolve(key));
  }

  createWriteStream(key) {
    const fullPath = this._resolve(key);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    return fs.createWriteStream(fullPath);
  }

  async ensureDir(dir) {
    await fsp.mkdir(this._resolve(dir), { recursive: true });
  }

  async rm(key) {
    const fullPath = this._resolve(key);
    try {
      await fsp.rm(fullPath, { recursive: true, force: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  rmSync(key) {
    const fullPath = this._resolve(key);
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  resolve(key) {
    return this._resolve(key);
  }

  readSync(key) {
    return fs.readFileSync(this._resolve(key));
  }

  existsSync(key) {
    return fs.existsSync(this._resolve(key));
  }

  writeSync(key, data) {
    const fullPath = this._resolve(key);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, data);
  }

  deleteSync(key) {
    const fullPath = this._resolve(key);
    try {
      fs.unlinkSync(fullPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  mkdirSync(dir) {
    fs.mkdirSync(this._resolve(dir), { recursive: true });
  }

  statSync(key) {
    const s = fs.statSync(this._resolve(key));
    return {
      size: s.size,
      modifiedAt: s.mtime,
      createdAt: s.birthtime,
      isDirectory: s.isDirectory(),
      isFile: s.isFile()
    };
  }

  renameSync(src, dest) {
    fs.renameSync(this._resolve(src), this._resolve(dest));
  }

  copyFileSync(src, dest) {
    fs.copyFileSync(this._resolve(src), this._resolve(dest));
  }

  readdirSync(dir) {
    return fs.readdirSync(this._resolve(dir));
  }

  realpathSync(key) {
    return fs.realpathSync(this._resolve(key));
  }
}
