import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const { migrateContentRoot } = await import('../../src/storage/relocate.js');

const parent = mkdtempSync(path.join(os.tmpdir(), 'content-root-migration-'));

afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

function writeTree(root, tree) {
  for (const [name, content] of Object.entries(tree)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function createFakeS3(initial = {}, bucket = 'bucket') {
  const objects = new Map(Object.entries(initial));
  return {
    bucket,
    objects,
    isLocal: false,
    async list(prefix) {
      return [...objects.keys()].filter(key => key.startsWith(prefix));
    },
    async stat(key) {
      if (!objects.has(key)) throw new Error(`NoSuchKey: ${key}`);
      return { size: objects.get(key).length };
    },
    async checkExists(key) {
      if (!objects.has(key)) return { state: 'missing' };
      return { state: 'present', stat: { size: objects.get(key).length } };
    },
    async read(key) {
      if (!objects.has(key)) throw new Error(`NoSuchKey: ${key}`);
      return objects.get(key);
    },
    async createReadStream(key) {
      if (!objects.has(key)) throw new Error(`NoSuchKey: ${key}`);
      return Readable.from([objects.get(key)]);
    }
  };
}

describe('migrateContentRoot: локальные каталоги', () => {
  test('копирует content/converted/streams и подтверждает размеры', async () => {
    const oldRoot = path.join(parent, 'local-old');
    const newRoot = path.join(parent, 'local-new');
    writeTree(oldRoot, {
      'content/devA/clip.mp4': 'video-data',
      'converted/devA/deck/page-1.png': 'png-data',
      'streams/live/segment.ts': 'ts-data'
    });

    const result = await migrateContentRoot({ oldRoot, newRoot });

    expect(result.local.copied).toBe(3);
    expect(result.local.bytes).toBe('video-data'.length + 'png-data'.length + 'ts-data'.length);
    expect(readFileSync(path.join(newRoot, 'content/devA/clip.mp4'), 'utf8')).toBe('video-data');
    expect(readFileSync(path.join(newRoot, 'converted/devA/deck/page-1.png'), 'utf8')).toBe('png-data');
    expect(readFileSync(path.join(newRoot, 'streams/live/segment.ts'), 'utf8')).toBe('ts-data');

    // Старый корень остаётся как резервная копия.
    expect(existsSync(path.join(oldRoot, 'content/devA/clip.mp4'))).toBe(true);
  });

  test('в новом корне уже лежит другой файл — миграция отменяется', async () => {
    const oldRoot = path.join(parent, 'conflict-old');
    const newRoot = path.join(parent, 'conflict-new');
    writeTree(oldRoot, { 'content/devA/a.txt': 'new-content' });
    writeTree(newRoot, { 'content/devA/a.txt': 'different-content' });

    await expect(migrateContentRoot({ oldRoot, newRoot }))
      .rejects.toThrow(/другой файл|перенос отменён/);

    expect(readFileSync(path.join(newRoot, 'content/devA/a.txt'), 'utf8')).toBe('different-content');
  });

  test('вложенный новый корень запрещён', async () => {
    const oldRoot = path.join(parent, 'nested-old');
    const newRoot = path.join(oldRoot, 'inside');
    mkdirSync(oldRoot, { recursive: true });

    await expect(migrateContentRoot({ oldRoot, newRoot }))
      .rejects.toThrow(/внутри старого/);
  });
});

describe('migrateContentRoot: S3-объекты', () => {
  test('копирует все объекты и проверяет их в новом хранилище', async () => {
    const source = createFakeS3({
      'content/devA/a.mp4': 'aaaa',
      'content/devA/deck/page.png': 'ppp'
    });
    const target = createFakeS3();

    target.copyFrom = async (src, from, to) => {
      if (!src.objects.has(from)) throw new Error(`NoSuchKey: ${from}`);
      target.objects.set(to, src.objects.get(from));
    };

    const oldRoot = path.join(parent, 's3-old');
    const newRoot = path.join(parent, 's3-new');

    const result = await migrateContentRoot({
      oldRoot,
      newRoot,
      sourceStorage: source,
      targetStorage: target
    });

    expect(result.remote.copied).toBe(2);
    expect(target.objects.get('content/devA/a.mp4')).toBe('aaaa');
    expect(target.objects.get('content/devA/deck/page.png')).toBe('ppp');
  });

  test('unknown при проверке в новом хранилище — ошибка, а не «успех»', async () => {
    const source = createFakeS3({ 'content/a.mp4': 'aaaa' });
    const target = createFakeS3();
    target.copyFrom = async () => {};
    target.checkExists = async () => ({ state: 'unknown', error: new Error('HEAD timeout') });

    await expect(migrateContentRoot({
      oldRoot: path.join(parent, 's3-unknown-old'),
      newRoot: path.join(parent, 's3-unknown-new'),
      sourceStorage: source,
      targetStorage: target
    })).rejects.toThrow(/Не удалось проверить объект/);
  });
});
