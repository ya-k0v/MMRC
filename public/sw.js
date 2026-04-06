// Service Worker для MMRC - Production Ready
// Версия 7.0 - File permissions fix, cache invalidation

const VERSION = 'v14';
const CACHE_NAME = `mmrc-static-${VERSION}`;
const PLACEHOLDER_CACHE_NAME = `mmrc-placeholder-${VERSION}`;
const CONTENT_CACHE_NAME = `mmrc-content-${VERSION}`;

// Лимиты кэша
const MAX_STATIC_ITEMS = 50;      // Максимум 50 статических файлов
const MAX_PLACEHOLDER_SIZE = 100; // 100MB для заглушек
const MAX_CONTENT_ITEMS = 100;    // До 100 видео/изображений (для предзагрузки)
const MAX_PRECACHE_FILE_SIZE = 500 * 1024 * 1024; // Кэшировать файлы до 500MB

// Критичные ресурсы для предзагрузки
const CRITICAL_RESOURCES = [
  '/player-videojs.html',
  '/speaker.html',
  '/admin.html',
  '/css/app.css',
  '/js/player-videojs.js',
  '/js/speaker.js',
  '/js/admin.js',
  '/js/theme.js',
  '/js/utils.js',
  '/vendor/videojs/video-js.css',
  '/vendor/videojs/video.min.js',
  '/manifest.json',
  '/manifest-speaker.json',
  '/manifest-admin.json'
];

// Установка Service Worker
self.addEventListener('install', (event) => {
  console.log('[SW] Installing Service Worker', VERSION);
  
  event.waitUntil(
    // Предзагружаем критичные ресурсы
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Precaching critical resources');
      return cache.addAll(CRITICAL_RESOURCES).catch(err => {
        console.warn('[SW] Some critical resources failed to cache:', err);
      });
    }).then(() => {
      // Принудительная активация новой версии
      return self.skipWaiting();
    })
  );
});

// Активация и очистка старых кэшей
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating Service Worker', VERSION);
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // Удаляем все кэши кроме текущей версии
          if (!cacheName.includes(VERSION)) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Активируем немедленно для всех клиентов
      return self.clients.claim();
    })
  );
});

// Ограничение размера кэша
async function limitCacheSize(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  
  if (keys.length > maxItems) {
    // Удаляем старые элементы (FIFO)
    const toDelete = keys.length - maxItems;
    for (let i = 0; i < toDelete; i++) {
      await cache.delete(keys[i]);
    }
    console.log(`[SW] Cache ${cacheName} limited: removed ${toDelete} old items`);
  }
}

// Проверка размера кэша в байтах
async function getCacheSize(cacheName) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  let totalSize = 0;
  
  for (const request of keys) {
    const response = await cache.match(request);
    if (response) {
      const blob = await response.blob();
      totalSize += blob.size;
    }
  }
  
  return totalSize;
}

// Ограничение по размеру
async function limitCacheSizeBytes(cacheName, maxBytes) {
  const size = await getCacheSize(cacheName);
  
  if (size > maxBytes) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    
    // Удаляем старые файлы пока не достигнем лимита
    for (const key of keys) {
      await cache.delete(key);
      const newSize = await getCacheSize(cacheName);
      if (newSize <= maxBytes) break;
    }
    
    console.log(`[SW] Cache ${cacheName} size limited: ${(size/1024/1024).toFixed(1)}MB → ${(await getCacheSize(cacheName)/1024/1024).toFixed(1)}MB`);
  }
}

// Перехват запросов
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // НЕ КЭШИРУЕМ заглушку (default.* файлы) - всегда Network-Only
  // Причина: Заглушка может меняться через админ панель, нужна всегда свежая версия
  // Без кэша плееры сразу видят новую заглушку после смены через админ панель
  if (url.pathname.match(/\/content\/[^\/]+\/default\.(mp4|webm|ogg|mkv|mov|avi|mp3|wav|m4a|png|jpg|jpeg|gif|webp)$/i)) {
    event.respondWith(
      fetch(event.request).catch(() => {
        // При ошибке сети - показываем fallback
        return new Response('Network error: default placeholder not available', { 
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      })
    );
    return;
  }

  // Иконки и логотипы - всегда берём свежие версии (без кэша)
  if (url.pathname.match(/\/(audio-logo\.svg|icon\.svg|favicon-\d+\.png|icon-\d+\.png|apple-touch-icon\.png)$/i)) {
    const noCacheRequest = new Request(event.request.url, { cache: 'reload' });
    event.respondWith(
      fetch(noCacheRequest).catch(() => caches.match(event.request))
    );
    return;
  }
  
  // Кэшируем статические ресурсы (JS, CSS, HTML) - Stale-While-Revalidate
  if (url.pathname.match(/\.(js|css|html|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i) ||
      url.pathname.match(/\/(player|speaker|admin)\.html$/)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        
        // Fetch в фоне для обновления
        const fetchPromise = fetch(event.request).then(async (response) => {
          if (response.ok) {
            cache.put(event.request, response.clone());
            
            // Ограничиваем количество статических файлов
            limitCacheSize(CACHE_NAME, MAX_STATIC_ITEMS).catch(err => {
              console.warn('[SW] Cache limit failed:', err);
            });
          }
          return response;
        }).catch(() => {
          // Offline - возвращаем из кэша или офлайн страницу
          if (cached) return cached;
          
          // Офлайн страница для HTML
          if (event.request.headers.get('accept')?.includes('text/html')) {
            return new Response(`
              <!DOCTYPE html>
              <html lang="ru">
              <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <title>Офлайн - MMRC</title>
                <style>
                  body {
                    margin:0; padding:0; height:100vh;
                    display:flex; align-items:center; justify-content:center;
                    background:#1a1a1a; color:#fff;
                    font-family:system-ui,-apple-system,sans-serif;
                    text-align:center;
                  }
                  h1 { font-size:2em; margin:0 0 1em; }
                  p { opacity:0.8; margin:0.5em 0; }
                  .status { margin-top:2em; font-size:0.9em; opacity:0.6; }
                </style>
              </head>
              <body>
                <div>
                  <h1>📡 Офлайн режим</h1>
                  <p>Сервер MMRC недоступен</p>
                  <p>Ожидание подключения...</p>
                  <div class="status">Service Worker v${VERSION}</div>
                </div>
              </body>
              </html>
            `, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
          }
          
          return new Response('Offline', { status: 503 });
        });
        
        // Stale-While-Revalidate: отдаем кэш сразу, обновляем в фоне
        if (cached) {
          return cached;
        }
        
        return fetchPromise;
      })
    );
    return;
  }
  
  // Контент (картинки кроме default.*) - кэшируем
  if (url.pathname.match(/\/content\/.*\.(png|jpg|jpeg|gif|webp)$/i) &&
      !url.pathname.match(/default\./i)) {
    event.respondWith(
      caches.open(CONTENT_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        
        const fetchPromise = fetch(event.request).then(async (response) => {
          if (response.ok) {
            cache.put(event.request, response.clone());
            limitCacheSize(CONTENT_CACHE_NAME, MAX_CONTENT_ITEMS).catch(err => {
              console.warn('[SW] Content cache limit failed:', err);
            });
          }
          return response;
        });
        
        // Cache-first для картинок
        return cached || fetchPromise;
      })
    );
    return;
  }
  
  // ВИДЕО (mp4, webm и т.д.) - НЕ перехватываем, пропускаем к серверу!
  // Nginx правильно обрабатывает Range requests для seek
  // SW не может корректно обработать Range requests из кэша
  if (url.pathname.match(/\/content\/.*\.(mp4|webm|ogg|mkv|mov|avi)$/i)) {
    // Пропускаем к серверу напрямую, без перехвата
    return;
  }
  
  // Для всех остальных запросов (API, WebSocket, и т.д.) - без кэширования
  // Пропускаем к серверу напрямую
});

// Предзагрузка контента в кэш (только картинки, видео не кэшируются из-за Range requests)
async function precacheContent(urls) {
  console.log(`[SW] Precaching ${urls.length} content files...`);
  const cache = await caches.open(CONTENT_CACHE_NAME);
  let cached = 0;
  let skipped = 0;
  
  for (const url of urls) {
    try {
      // Кэшируем только картинки, видео пропускаем (Range requests)
      if (/\.(mp4|webm|ogg|mkv|mov|avi)$/i.test(url)) {
        console.log(`[SW] Skipping video (no caching): ${url}`);
        skipped++;
        continue;
      }
      
      // Проверяем есть ли уже в кэше
      const existing = await cache.match(url);
      if (existing) {
        console.log(`[SW] Already cached: ${url}`);
        cached++;
        continue;
      }
      
      // Загружаем файл
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`[SW] Failed to fetch: ${url} (${response.status})`);
        skipped++;
        continue;
      }
      
      // Проверяем размер (только для картинок)
      const contentLength = response.headers.get('content-length');
      const size = contentLength ? parseInt(contentLength) : 0;
      
      if (size > MAX_PRECACHE_FILE_SIZE) {
        console.warn(`[SW] File too large, skipping: ${url} (${(size/1024/1024).toFixed(1)}MB)`);
        skipped++;
        continue;
      }
      
      // Кэшируем
      await cache.put(url, response);
      cached++;
      console.log(`[SW] Cached: ${url} (${(size/1024/1024).toFixed(1)}MB)`);
      
      // Ограничиваем количество файлов в кэше
      await limitCacheSize(CONTENT_CACHE_NAME, MAX_CONTENT_ITEMS);
      
    } catch (err) {
      console.error(`[SW] Error caching ${url}:`, err);
      skipped++;
    }
  }
  
  console.log(`[SW] Precaching complete: ${cached} cached, ${skipped} skipped (videos not cached - direct Nginx)`);
  return { cached, skipped, total: urls.length };
}

// Обработка сообщений от клиента
self.addEventListener('message', (event) => {
  // КРИТИЧНО: Для синхронных ответов НЕ возвращаем true
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return; // Синхронный ответ, не нужно возвращать true
  }
  
  // Команда очистки кэша
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => caches.delete(cacheName))
        );
      }).then(() => {
        console.log('[SW] All caches cleared');
        // Отправляем подтверждение если есть порт
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ success: true });
        }
      }).catch(err => {
        console.error('[SW] Error clearing cache:', err);
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ success: false, error: err.message });
        }
      })
    );
    // Асинхронный ответ - нужно вернуть true или использовать event.respondWith
    // Но для message событий просто не возвращаем ничего
    return;
  }
  
  // Команда предзагрузки контента
  if (event.data && event.data.type === 'PRECACHE_CONTENT') {
    const urls = event.data.urls || [];
    // КРИТИЧНО: Используем waitUntil для асинхронных операций, но НЕ возвращаем true
    // Это предотвратит ошибку "message channel closed"
    event.waitUntil(
      precacheContent(urls).then(result => {
        // Отправляем результат обратно клиенту только если порт еще открыт
        if (event.ports && event.ports[0]) {
          try {
            event.ports[0].postMessage(result);
          } catch (err) {
            console.warn('[SW] Failed to post message (port closed):', err);
          }
        }
      }).catch(err => {
        console.error('[SW] Error precaching content:', err);
        if (event.ports && event.ports[0]) {
          try {
            event.ports[0].postMessage({ cached: 0, skipped: 0, total: 0, error: err.message });
          } catch (e) {
            // Игнорируем если порт уже закрыт
          }
        }
      })
    );
    return; // Не возвращаем true для message событий
  }
  
  // Получить статистику кэша
  if (event.data && event.data.type === 'GET_CACHE_STATS') {
    event.waitUntil(
      (async () => {
        try {
          const cache = await caches.open(CONTENT_CACHE_NAME);
          const keys = await cache.keys();
          const urls = keys.map(req => req.url);
          const size = await getCacheSize(CONTENT_CACHE_NAME);
          
          if (event.ports && event.ports[0]) {
            try {
              event.ports[0].postMessage({
                count: keys.length,
                size: size,
                urls: urls
              });
            } catch (err) {
              console.warn('[SW] Failed to post cache stats (port closed):', err);
            }
          }
        } catch (err) {
          console.error('[SW] Error getting cache stats:', err);
          if (event.ports && event.ports[0]) {
            try {
              event.ports[0].postMessage({ count: 0, size: 0, urls: [], error: err.message });
            } catch (e) {
              // Игнорируем если порт уже закрыт
            }
          }
        }
      })()
    );
    return; // Не возвращаем true для message событий
  }
});
