/** Разбивка хранилища по типам файлов: одинаково для SQLite и PostgreSQL. */

import { jest } from '@jest/globals';
import {
  classifyStorageType,
  buildStorageBreakdownQuery,
  fetchStorageBreakdown,
  STORAGE_TYPE_GROUPS
} from '../../src/database/storage-breakdown.js';

describe('classifyStorageType', () => {
  test('content_type имеет приоритет над MIME и расширением', () => {
    expect(classifyStorageType({ contentType: 'streaming', mimeType: 'text/plain', extension: 'pdf' })).toBe('video');
    expect(classifyStorageType({ contentType: 'audio' })).toBe('audio');
    expect(classifyStorageType({ contentType: 'image' })).toBe('image');
    expect(classifyStorageType({ contentType: 'pptx' })).toBe('documents');
    expect(classifyStorageType({ contentType: 'folder' })).toBe('documents');
  });

  test('mime_type определяет группу, когда тип контента не задан', () => {
    expect(classifyStorageType({ contentType: 'file', mimeType: 'video/mp4' })).toBe('video');
    expect(classifyStorageType({ mimeType: 'audio/mpeg' })).toBe('audio');
    expect(classifyStorageType({ mimeType: 'image/jpeg' })).toBe('image');
    expect(classifyStorageType({ mimeType: 'application/pdf' })).toBe('documents');
    expect(classifyStorageType({ mimeType: 'text/plain' })).toBe('documents');
    expect(classifyStorageType({ mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })).toBe('documents');
  });

  test('расширение из safe_name — последний источник, неизвестное уходит в other', () => {
    expect(classifyStorageType({ extension: 'MKV' })).toBe('video');
    expect(classifyStorageType({ extension: 'flac' })).toBe('audio');
    expect(classifyStorageType({ extension: 'webp' })).toBe('image');
    expect(classifyStorageType({ extension: 'zip' })).toBe('documents');
    expect(classifyStorageType({})).toBe('other');
    expect(classifyStorageType({ contentType: 'file', mimeType: 'application/octet-stream', extension: 'bin' })).toBe('other');
  });
});

describe('buildStorageBreakdownQuery', () => {
  test('SQLite использует INSTR и агрегирует без выборки имён', () => {
    const sql = buildStorageBreakdownQuery('sqlite');
    expect(sql).toContain("INSTR(safe_name, '.')");
    expect(sql).not.toContain('STRPOS');
    expect(sql).toContain('SUM(file_size) AS bytes');
    expect(sql).toContain('GROUP BY');
    expect(sql).not.toMatch(/SELECT[^\n]*original_name/);
  });

  test('PostgreSQL использует STRPOS, остальной SQL общий', () => {
    const sql = buildStorageBreakdownQuery('postgres');
    expect(sql).toContain("STRPOS(safe_name, '.')");
    expect(sql).not.toContain('INSTR');
    expect(sql.replace(/STRPOS/g, 'INSTR')).toBe(buildStorageBreakdownQuery('sqlite'));
  });
});

describe('fetchStorageBreakdown', () => {
  test('суммирует строки и нормализует строки чисел из PostgreSQL', async () => {
    const db = {
      query: jest.fn().mockResolvedValue([
        { content_type: 'video', mime_type: '', extension: 'mp4', bytes: '1500', files: '2' },
        { content_type: 'file', mime_type: 'video/mp4', extension: '', bytes: '500', files: 1 },
        { content_type: 'file', mime_type: '', extension: 'pdf', bytes: '250', files: 1 },
        { content_type: 'file', mime_type: '', extension: 'bin', bytes: '100', files: 1 }
      ])
    };

    const result = await fetchStorageBreakdown(db);
    expect(result).toEqual([
      { key: 'video', label: 'Видео', bytes: 2000, files: 3 },
      { key: 'documents', label: 'Документы', bytes: 250, files: 1 },
      { key: 'other', label: 'Другое', bytes: 100, files: 1 }
    ]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toContain('INSTR');
  });

  test('пустой результат не ломает карточку хранилища', async () => {
    expect(await fetchStorageBreakdown({ query: async () => [] })).toEqual([]);
  });

  test('ошибка БД не ломает карточку хранилища', async () => {
    const db = { query: async () => { throw new Error('db is down'); } };
    expect(await fetchStorageBreakdown(db)).toEqual([]);
  });

  test('порядок групп фиксирован', () => {
    expect(STORAGE_TYPE_GROUPS.map(group => group.key)).toEqual(['video', 'audio', 'image', 'documents', 'other']);
  });
});
