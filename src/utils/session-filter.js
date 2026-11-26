/**
 * Фильтр «активных» сессий для админки.
 *
 * В refresh_tokens остаются записи с истёкшим сроком действия — они удаляются
 * лениво, при попытке обновить токен. Показывать их как активные некорректно.
 * Фильтрация в JS, а не в SQL: формат expires_at отличается между SQLite
 * (строка DATETIME) и PostgreSQL (TIMESTAMP).
 *
 * @param {Array<object>} rows строки из refresh_tokens JOIN users
 * @param {number} now текущее время в мс (для тестов)
 * @returns {Array<object>} только сессии с неистёкшим сроком
 */
export function filterActiveSessions(rows, now = Date.now()) {
  if (!Array.isArray(rows)) return [];

  return rows.filter((row) => {
    if (!row?.expires_at) return true;
    const expiresAt = new Date(row.expires_at).getTime();
    return !Number.isFinite(expiresAt) || expiresAt > now;
  });
}
