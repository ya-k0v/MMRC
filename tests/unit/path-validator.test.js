/**
 * Регрессия: для ещё не существующего вложенного пути validatePath()
 * возвращал base/basename, теряя промежуточные каталоги. В S3-режиме это
 * превращало data/content/<device>/file в data/content/file и ломало
 * скачивание.
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { validatePath } = await import('../../src/utils/path-validator.js');

const root = mkdtempSync(path.join(os.tmpdir(), 'path-validator-root-'));
const outside = mkdtempSync(path.join(os.tmpdir(), 'path-validator-outside-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('validatePath', () => {
  test('сохраняет промежуточные каталоги для несуществующего пути', () => {
    const requested = path.join(root, 'content', 'device-1', 'movie.mp4');

    expect(validatePath(requested, root)).toBe(requested);
  });

  test('существующий файл возвращается как есть', () => {
    const file = path.join(root, 'existing.txt');
    writeFileSync(file, 'data');

    expect(validatePath(file, root)).toBe(file);
  });

  test('выход через .. отклоняется', () => {
    expect(() => validatePath(path.join(root, '..', 'evil.txt'), root))
      .toThrow(/Path traversal/);
  });

  test('выход через symlink отклоняется даже для несуществующего файла', () => {
    const sub = path.join(root, 'sub');
    mkdirSync(sub, { recursive: true });
    symlinkSync(outside, path.join(sub, 'escape'));

    expect(() => validatePath(path.join(sub, 'escape', 'evil.txt'), root))
      .toThrow(/Path traversal/);
  });

  test('symlink на файл вне корня отклоняется', () => {
    const target = path.join(outside, 'secret.txt');
    writeFileSync(target, 'secret');
    symlinkSync(target, path.join(root, 'secret-link.txt'));

    expect(() => validatePath(path.join(root, 'secret-link.txt'), root))
      .toThrow(/Path traversal/);
  });
});
