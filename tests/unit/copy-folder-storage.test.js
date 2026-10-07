/**
 * Регрессия: после перехода на S3-primary перенос папки между устройствами
 * возвращал 500.
 *
 * Причины были две: copyFolderPhysically делал fs.promises.cp по пути, которого
 * на диске уже нет (содержимое живёт префиксом ключей в бакете → ENOENT на
 * lstat), и в шаге сохранения метаданных вызывался необъявленный `storage`
 * (ReferenceError). Исправление — copyFolderEverywhere: объекты копируются по
 * одному через storage.copy(), локальная копия делается отдельно.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';

const { copyFolderEverywhere } = await import('../../src/storage/sync.js');
const { getDataRoot } = await import('../../src/config/settings-manager.js');

// toStorageKey() принимает только пути внутри data root (в тестах — data/ проекта),
// поэтому временные папки заводим там же, а не в системном /tmp.
const DATA_ROOT_PARENT = getDataRoot();
mkdirSync(DATA_ROOT_PARENT, { recursive: true });
const DATA_ROOT = mkdtempSync(path.join(DATA_ROOT_PARENT, 'copy-folder-'));

/** Ключ хранилища для абсолютного пути внутри тестового data root. */
function storageKey(absPath) {
  return path.relative(DATA_ROOT_PARENT, absPath).split(path.sep).join('/');
}

/** Фейковый S3: list/copy/write/exists/stat, isLocalStorage() считает его удалённым. */
function createFakeStorage(initial = {}) {
  const objects = new Map(Object.entries(initial));

  return {
    objects,
    isLocal: false,
    async list(prefix) {
      return [...objects.keys()].filter(key => key.startsWith(prefix));
    },
    async copy(from, to) {
      if (!objects.has(from)) throw new Error(`NoSuchKey: ${from}`);
      objects.set(to, objects.get(from));
    },
    async write(key, buffer) {
      // в S3 лежат байты — храним строку, чтобы сравнивать с исходным содержимым
      objects.set(key, Buffer.from(buffer).toString());
    },
    async exists(key) {
      return objects.has(key);
    },
    async stat(key) {
      const value = objects.get(key);
      return value ? { size: value.length } : null;
    }
  };
}

function writeTree(root, tree) {
  for (const [name, content] of Object.entries(tree)) {
    const full = path.join(root, name);
    if (content === null) {
      mkdirSync(full, { recursive: true });
    } else {
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
}

afterAll(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

describe('copyFolderEverywhere', () => {
  test('папка существует только в хранилище: объекты копируются на префикс цели', async () => {
    const sourcePath = path.join(DATA_ROOT, 'content', 'devA', 'deck');
    const targetPath = path.join(DATA_ROOT, 'content', 'devB', 'deckCopy');
    const source = `${storageKey(sourcePath)}/`;
    const target = `${storageKey(targetPath)}/`;
    const storage = createFakeStorage({
      [`${source}1.png`]: 'one',
      [`${source}sub/2.jpg`]: 'two',
      // чужой префикс с общим началом (deckOld) — копироваться не должен
      [`${storageKey(sourcePath)}Old/9.png`]: 'nine'
    });

    const result = await copyFolderEverywhere(sourcePath, targetPath, storage);

    expect(result).toEqual({ copiedInStorage: 2, copiedOnDisk: 0 });
    expect(storage.objects.get(`${target}1.png`)).toBe('one');
    expect(storage.objects.get(`${target}sub/2.jpg`)).toBe('two');
    expect(storage.objects.has(`${storageKey(targetPath)}Old/9.png`)).toBe(false);
    expect(storage.objects.get(`${source}1.png`)).toBe('one');
    // на диске ничего не появилось
    expect(existsSync(targetPath)).toBe(false);
  });

  test('папка только на диске: копия создаётся и заливается в хранилище', async () => {
    const storage = createFakeStorage();
    const sourcePath = path.join(DATA_ROOT, 'content', 'devC', 'slides');
    const targetPath = path.join(DATA_ROOT, 'content', 'devD', 'slidesCopy');
    writeTree(sourcePath, {
      'a.png': 'A',
      'nested/b.png': 'B'
    });

    const result = await copyFolderEverywhere(sourcePath, targetPath, storage);

    expect(result).toEqual({ copiedInStorage: 0, copiedOnDisk: 2 });
    expect(readFileSync(path.join(targetPath, 'a.png'), 'utf8')).toBe('A');
    expect(readdirSync(path.join(targetPath, 'nested')).sort()).toEqual(['b.png']);

    const target = `${storageKey(targetPath)}/`;
    expect(storage.objects.get(`${target}a.png`)).toBe('A');
    expect(storage.objects.get(`${target}nested/b.png`)).toBe('B');
  });

  test('без хранилища копия идёт только на диск', async () => {
    const sourcePath = path.join(DATA_ROOT, 'content', 'devE', 'plain');
    const targetPath = path.join(DATA_ROOT, 'content', 'devF', 'plainCopy');
    writeTree(sourcePath, { '1.png': '1' });

    const result = await copyFolderEverywhere(sourcePath, targetPath, null);

    expect(result).toEqual({ copiedInStorage: 0, copiedOnDisk: 1 });
    expect(readFileSync(path.join(targetPath, '1.png'), 'utf8')).toBe('1');
  });

  test('onProgress получает непрерывный счётчик по всем фазам', async () => {
    const sourcePath = path.join(DATA_ROOT, 'content', 'devI', 'pages');
    const targetPath = path.join(DATA_ROOT, 'content', 'devJ', 'pages');
    writeTree(sourcePath, { '1.png': '1', 'nested/2.png': '2', 'nested/deep/3.png': '3' });

    const events = [];
    await copyFolderEverywhere(sourcePath, targetPath, null, { onProgress: p => events.push(p) });

    expect(events[0]).toMatchObject({ phase: 'prepare', done: 0, total: 3 });
    const last = events[events.length - 1];
    expect(last.done).toBe(3);
    expect(last.total).toBe(3);

    // Счётчик обязан расти монотонно — иначе полоса в UI будет дёргаться назад
    const dones = events.map(event => event.done);
    expect([...dones].sort((a, b) => a - b)).toEqual(dones);
    expect(dones.filter(done => done === 3).length).toBeGreaterThan(0);
  });

  test('источника нет ни на диске, ни в хранилище — ошибка', async () => {
    const storage = createFakeStorage();
    const sourcePath = path.join(DATA_ROOT, 'content', 'devG', 'ghost');
    const targetPath = path.join(DATA_ROOT, 'content', 'devH', 'ghost');

    await expect(copyFolderEverywhere(sourcePath, targetPath, storage))
      .rejects.toThrow(/не найдена в хранилище/);
    await expect(copyFolderEverywhere(sourcePath, targetPath, null))
      .rejects.toThrow(/Исходная папка не найдена/);
  });
});
