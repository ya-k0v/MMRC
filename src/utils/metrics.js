/**
 * Performance metrics collection
 * @module utils/metrics
 */

const metrics = {
  requests: {
    total: 0,
    errors: 0,
    byMethod: {},
    byRoute: {},
    responseTimes: []
  },
  database: {
    queries: 0,
    errors: 0,
    slowQueries: 0,
    queryTimes: []
  },
  socket: {
    connections: 0,
    disconnections: 0,
    messages: 0,
    errors: 0
  },
  startTime: Date.now()
};

/**
 * Записать метрику запроса
 * @param {string} method - HTTP метод
 * @param {string} route - Маршрут
 * @param {number} duration - Длительность в мс
 * @param {boolean} isError - Была ли ошибка
 */
export function recordRequest(method, route, duration, isError = false) {
  metrics.requests.total++;
  if (isError) {
    metrics.requests.errors++;
  }

  if (!metrics.requests.byMethod[method]) {
    metrics.requests.byMethod[method] = { total: 0, errors: 0 };
  }
  metrics.requests.byMethod[method].total++;
  if (isError) {
    metrics.requests.byMethod[method].errors++;
  }

  const normalizedRoute = route.replace(/\/\d+/g, '/:id').replace(/\/[^/]+$/g, '/:param');
  if (!metrics.requests.byRoute[normalizedRoute]) {
    metrics.requests.byRoute[normalizedRoute] = { total: 0, errors: 0, avgTime: 0 };
  }
  metrics.requests.byRoute[normalizedRoute].total++;
  if (isError) {
    metrics.requests.byRoute[normalizedRoute].errors++;
  }

  // Храним только последние 1000 времен ответа
  metrics.requests.responseTimes.push(duration);
  if (metrics.requests.responseTimes.length > 1000) {
    metrics.requests.responseTimes.shift();
  }

  // Обновляем среднее время для маршрута
  const routeMetrics = metrics.requests.byRoute[normalizedRoute];
  const totalTime = routeMetrics.avgTime * (routeMetrics.total - 1) + duration;
  routeMetrics.avgTime = totalTime / routeMetrics.total;
}

/**
 * Записать метрику запроса к БД
 * @param {number} duration - Длительность в мс
 * @param {boolean} isError - Была ли ошибка
 * @param {boolean} isSlow - Медленный запрос (>1000ms)
 */
export function recordDatabaseQuery(duration, isError = false, isSlow = false) {
  metrics.database.queries++;
  if (isError) {
    metrics.database.errors++;
  }
  if (isSlow) {
    metrics.database.slowQueries++;
  }

  // Храним только последние 1000 времен запросов
  metrics.database.queryTimes.push(duration);
  if (metrics.database.queryTimes.length > 1000) {
    metrics.database.queryTimes.shift();
  }
}

/**
 * Записать метрику Socket.IO
 * @param {string} event - Тип события (connect, disconnect, message, error)
 */
export function recordSocketEvent(event) {
  switch (event) {
    case 'connect':
      metrics.socket.connections++;
      break;
    case 'disconnect':
      metrics.socket.disconnections++;
      break;
    case 'message':
      metrics.socket.messages++;
      break;
    case 'error':
      metrics.socket.errors++;
      break;
  }
}

/**
 * Получить все метрики
 * @returns {Object}
 */
export function getMetrics() {
  const calculatePercentile = (arr, percentile) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  };

  const calculateAvg = (arr) => {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  };

  return {
    uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
    requests: {
      total: metrics.requests.total,
      errors: metrics.requests.errors,
      errorRate: metrics.requests.total > 0 
        ? (metrics.requests.errors / metrics.requests.total * 100).toFixed(2) + '%'
        : '0%',
      byMethod: metrics.requests.byMethod,
      byRoute: metrics.requests.byRoute,
      responseTime: {
        avg: Math.round(calculateAvg(metrics.requests.responseTimes)),
        p50: Math.round(calculatePercentile(metrics.requests.responseTimes, 50)),
        p95: Math.round(calculatePercentile(metrics.requests.responseTimes, 95)),
        p99: Math.round(calculatePercentile(metrics.requests.responseTimes, 99))
      }
    },
    database: {
      queries: metrics.database.queries,
      errors: metrics.database.errors,
      errorRate: metrics.database.queries > 0
        ? (metrics.database.errors / metrics.database.queries * 100).toFixed(2) + '%'
        : '0%',
      slowQueries: metrics.database.slowQueries,
      queryTime: {
        avg: Math.round(calculateAvg(metrics.database.queryTimes)),
        p50: Math.round(calculatePercentile(metrics.database.queryTimes, 50)),
        p95: Math.round(calculatePercentile(metrics.database.queryTimes, 95)),
        p99: Math.round(calculatePercentile(metrics.database.queryTimes, 99))
      }
    },
    socket: {
      connections: metrics.socket.connections,
      disconnections: metrics.socket.disconnections,
      activeConnections: metrics.socket.connections - metrics.socket.disconnections,
      messages: metrics.socket.messages,
      errors: metrics.socket.errors
    }
  };
}

/**
 * Сбросить метрики
 */
export function resetMetrics() {
  metrics.requests = {
    total: 0,
    errors: 0,
    byMethod: {},
    byRoute: {},
    responseTimes: []
  };
  metrics.database = {
    queries: 0,
    errors: 0,
    slowQueries: 0,
    queryTimes: []
  };
  metrics.socket = {
    connections: 0,
    disconnections: 0,
    messages: 0,
    errors: 0
  };
  metrics.startTime = Date.now();
}

