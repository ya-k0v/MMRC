/**
 * Базовая логика Socket.IO для Frontend
 * @module shared/socket-base
 */

/**
 * Debounce для обработчиков событий
 * @param {Function} fn - Функция
 * @param {number} delay - Задержка в мс
 * @returns {Function} Debounced функция
 */
export function debounce(fn, delay = 300) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

