/**
 * Общие функции форматирования для унификации отображения
 * @module shared/formatters
 */

/**
 * Форматирует секунды в формат mm:ss (с ведущим нулем)
 * @param {number} sec - Время в секундах
 * @returns {string} Отформатированное время в формате "mm:ss"
 */
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  // УНИФИЦИРОВАННЫЙ ФОРМАТ: всегда "mm:ss" с ведущим нулем
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

