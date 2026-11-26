/** Чтение логов сервиса: границы строк, UTF-8 и выбор свежего файла. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readLastLinesFromFile,
  readLinesFromOffset,
  resolveLatestServiceLogFilePath
} from '../../src/services/service-logs.js';

let logsDir;
let getLogsDir;

beforeEach(() => {
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmrc-logs-'));
  getLogsDir = () => logsDir;
});

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true });
});

const logFile = (name = 'combined-2026-01-01.log') => path.join(logsDir, name);

test('инкрементальное чтение начинается со следующей полной строки и учитывает лимит', () => {
  const file = logFile();
  const first = ['первая', 'вторая', 'третья', 'четвёртая'];
  fs.writeFileSync(file, `${first.join('\n')}\n`);

  const snapshot = readLastLinesFromFile(file, 2, getLogsDir);
  expect(snapshot.lines).toEqual(['третья', 'четвёртая']);

  fs.appendFileSync(file, 'пятая\nшестая\n');
  const chunk = readLinesFromOffset(file, snapshot.size, 1, getLogsDir);

  expect(chunk.lines).toEqual(['пятая']);
  expect(chunk.size).toBe(Buffer.byteLength(`${first.join('\n')}\nпятая\n`));
});

test('UTF-8 не ломается на границе куска при чтении последних строк', () => {
  const file = logFile();
  const longLine = 'я'.repeat(40000); // ~80 КБ: граница 64 КБ пройдёт внутри символа
  fs.writeFileSync(file, `${longLine}\nфинал\n`);

  const snapshot = readLastLinesFromFile(file, 1, getLogsDir);
  expect(snapshot.lines).toEqual(['финал']);
  expect(snapshot.lines.join('')).not.toContain('\uFFFD');
});

test('выбирается реально самый свежий файл, а не последний по имени', () => {
  const olderName = logFile('combined-2026-12-31.log');
  const newerName = logFile('combined-2026-01-01.log');
  fs.writeFileSync(olderName, 'старый\n');
  fs.writeFileSync(newerName, 'свежий\n');

  const now = Date.now() / 1000;
  fs.utimesSync(olderName, now - 100000, now - 100000);
  fs.utimesSync(newerName, now, now);

  expect(resolveLatestServiceLogFilePath('combined', getLogsDir)).toBe(newerName);
});
