const CACHE = 'ad-display-v1';
const ANALYTICS_URL = '/api/ad/analytics/report';
const COMPLETE_URL = '/api/ad/analytics/complete';
const LOG_URL = '/api/ad/analytics/log';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (url.pathname === ANALYTICS_URL && e.request.method === 'POST') {
    e.respondWith(handleAnalyticsPost(e.request));
    return;
  }
  if (url.pathname === COMPLETE_URL && e.request.method === 'POST') {
    e.respondWith(handleAnalyticsPost(e.request));
    return;
  }
  if (url.pathname === LOG_URL && e.request.method === 'POST') {
    e.respondWith(handleAnalyticsPost(e.request));
    return;
  }

  if (url.pathname.startsWith('/api/files/resolve/')) {
    e.respondWith(handleFileRequest(e.request));
    return;
  }

  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

async function handleAnalyticsPost(request) {
  try {
    const clone = request.clone();
    const body = await clone.json();
    const response = await fetch(request.clone());
    if (response.ok) {
      await flushQueue();
    }
    return response;
  } catch {
    const clone = request.clone();
    const body = await clone.json().catch(() => ({}));
    await addToQueue(request.url, body);
    return new Response(JSON.stringify({ ok: true, queued: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleFileRequest(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('', { status: 503 });
  }
}

async function addToQueue(url, body) {
  const cache = await caches.open(CACHE);
  const req = new Request('/offline-queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, body, ts: Date.now() })
  });
  const existing = await caches.match(req);
  const queue = existing ? await existing.json() : [];
  queue.push({ url, body, ts: Date.now() });
  const cache2 = await caches.open(CACHE);
  cache2.put(req, new Response(JSON.stringify(queue), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function flushQueue() {
  const cache = await caches.open(CACHE);
  const req = new Request('/offline-queue');
  const existing = await cache.match(req);
  if (!existing) return;
  const queue = await existing.json();
  if (!queue.length) return;
  const remaining = [];
  for (const item of queue) {
    try {
      await fetch(item.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.body)
      });
    } catch {
      remaining.push(item);
    }
  }
  if (remaining.length) {
    cache.put(req, new Response(JSON.stringify(remaining), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } else {
    cache.delete(req);
  }
}
