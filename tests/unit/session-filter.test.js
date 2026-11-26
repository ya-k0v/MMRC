/** Фильтр активных сессий должен быть одинаковым для SQLite и PostgreSQL. */
import { filterActiveSessions } from '../../src/utils/session-filter.js';

describe('filterActiveSessions', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  const rows = [
    { id: 1, expires_at: '2026-11-26T13:00:00Z' },
    { id: 2, expires_at: '2026-11-26T11:00:00Z' },
    { id: 3, expires_at: new Date('2026-11-27T00:00:00Z') },
    { id: 4, expires_at: null }
  ];

  test('отбрасывает истёкшие токены, сохраняет остальные', () => {
    expect(filterActiveSessions(rows, now).map(row => row.id)).toEqual([1, 3, 4]);
  });

  test('не падает на мусоре и неверном типе входа', () => {
    expect(filterActiveSessions(null, now)).toEqual([]);
    expect(filterActiveSessions([{ id: 5, expires_at: 'мусор' }], now).map(row => row.id)).toEqual([5]);
  });
});
