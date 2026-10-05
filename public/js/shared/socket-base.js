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

/**
 * Debounce для асинхронных обработчиков.
 *
 * Обычный debounce не мешает параллельным прогонам: если события приходят
 * чаще, чем отрабатывает обработчик, запускается несколько копий подряд.
 * Здесь новый вызов не стартует, пока предыдущий ещё выполняется, но факт
 * повторного изменения запоминается и обработка повторяется после завершения
 * текущей — итоговое состояние всегда актуально.
 *
 * @param {Function} fn - асинхронная функция
 * @param {number} delay - задержка в мс
 * @returns {Function} Debounced функция с методом cancel()
 */
export function debounceAsync(fn, delay = 300) {
  let timer = null;
  let running = false;
  let rerun = false;
  let latestArgs = [];

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (running) {
        rerun = true;
        return;
      }
      void invoke();
    }, delay);
  }

  async function invoke() {
    running = true;
    try {
      await fn(...latestArgs);
    } finally {
      running = false;
    }
    if (rerun) {
      rerun = false;
      schedule();
    }
  }

  const debounced = function(...args) {
    latestArgs = args;
    schedule();
  };

  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    rerun = false;
  };

  return debounced;
}

