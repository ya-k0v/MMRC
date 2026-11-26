/**
 * Политика этапа 2: короткоживущий тикет скачивания, потоковый frontend и
 * восстановление HLS-кэша из primary-хранилища.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const { generateAccessToken, generateDownloadTicket, verifyDownloadTicket } =
  await import('../../src/middleware/auth.js');
const { hydrateHlsFromStorage } = await import('../../src/middleware/express-config.js');
const { getStreamsOutputDir } = await import('../../src/config/settings-manager.js');
const { getCurrentStorage, setCurrentStorage } = await import('../../src/storage/current.js');

describe('download ticket', () => {
  test('тикет привязан к устройству и файлу и отклоняет access token', async () => {
    const ticket = generateDownloadTicket(7, 'admin', 'dev-1', 'movie.mp4');
    const decoded = await verifyDownloadTicket(ticket);

    expect(decoded).toMatchObject({
      type: 'download', userId: 7, role: 'admin', deviceId: 'dev-1', fileName: 'movie.mp4'
    });
    await expect(verifyDownloadTicket(generateAccessToken(7, 'admin', 'admin')))
      .rejects.toThrow('Invalid ticket type');
  });
});

describe('admin download frontend', () => {
  test('скачивание идёт через тикет, без blob() в памяти браузера', () => {
    const file = fileURLToPath(new URL('../../public/js/admin/files-manager.js', import.meta.url));
    const source = fs.readFileSync(file, 'utf8');

    expect(source).toContain('/download-url');
    expect(source).toContain('window.location.assign(url)');
    expect(source).not.toContain('response.blob()');
    expect(source).not.toContain('URL.createObjectURL');
  });
});

describe('HLS storage policy', () => {
  const previousStorage = getCurrentStorage();
  const folder = path.join(getStreamsOutputDir(), 'stage2-hls');
  const filePath = path.join(folder, 'index.m3u8');

  beforeEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(folder, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
    setCurrentStorage(previousStorage);
  });

  test('локальный backend не материализует из storage', async () => {
    setCurrentStorage({ isLocal: true });

    await expect(hydrateHlsFromStorage(filePath)).resolves.toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('при отсутствии локального файла плейлист восстанавливается из S3', async () => {
    const keys = [];
    setCurrentStorage({
      isLocal: false,
      async checkExists(key) {
        keys.push(key);
        return { state: 'present' };
      },
      async createReadStream() { return Readable.from(['#EXTM3U\n']); }
    });

    await expect(hydrateHlsFromStorage(filePath)).resolves.toBe(true);

    expect(keys).toContain('streams/stage2-hls/index.m3u8');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('#EXTM3U\n');
  });

  test('unknown из storage не создаёт пустой локальный файл', async () => {
    setCurrentStorage({
      isLocal: false,
      async checkExists() { return { state: 'unknown', error: new Error('timeout') }; },
      async createReadStream() { throw new Error('должен не вызываться'); }
    });

    await expect(hydrateHlsFromStorage(filePath)).resolves.toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
