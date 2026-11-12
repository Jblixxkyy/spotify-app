'use strict';

const SHELL_CACHE = 'myspotify-shell-v41';
const AUDIO_CACHE = 'myspotify-audio-v1';
// Album art for YouTube songs lives on remote thumbnail hosts (i.ytimg.com).
// Cache those images so covers still show offline. Capped by count —
// thumbs are small, and the oldest go first when the cap is hit.
const THUMB_CACHE = 'myspotify-thumbs-v1';
const THUMB_CACHE_MAX = 400;
const SW_BASE = self.location.pathname.replace(/\/sw\.js$/, '').replace(/\/$/, '');
const AUDIO_PREFIX = SW_BASE + '/api/songs/';
// Stop a single device from filling the whole origin quota (iOS ~1 GB cap,
// evicts without warning under storage pressure).
const AUDIO_BUDGET_BYTES = 600 * 1024 * 1024;

const SHELL_URLS = [
  './',
  './index.html',
  './css/style.css',
  './js/audio-engine.js',
  './js/app.js',
  './manifest.json'
];

const abs = (p) => new URL(p, self.location.href).href;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.all(
        SHELL_URLS.map(async (url) => {
          try {
            // cache:'reload' bypasses the browser HTTP cache (server sends
            // max-age=3600 on css/js) so a deploy is never shadowed by a
            // stale copy at install time.
            const res = await fetch(abs(url), { cache: 'reload', credentials: 'same-origin' });
            if (res.ok) await cache.put(abs(url), res);
          } catch { /* skip */ }
        })
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, AUDIO_CACHE, THUMB_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function isAudioRequest(url) {
  return url.origin === self.location.origin &&
    url.pathname.startsWith(AUDIO_PREFIX) &&
    url.pathname.endsWith('/audio');
}

async function sliceCached(cached, rangeHeader) {
  const buffer = await cached.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader || '');
  if (!m) return cached;
  const size = buffer.byteLength;
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (start >= size) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` },
    });
  }
  end = Math.min(end, size - 1);
  const headers = new Headers(cached.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(buffer.slice(start, end + 1), { status: 206, headers });
}

async function stampAndCache(cache, url, response) {
  const body = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set('sw-cached-at', new Date().toISOString());
  await cache.put(url, new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}

async function handleAudio(request) {
  const range = request.headers.get('range');
  if (range) {
    const cached = await caches.match(request.url, { ignoreSearch: false });
    if (cached) return sliceCached(cached, range);
    return fetch(request);
  }
  const cached = await caches.match(request.url, { ignoreSearch: false });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok && response.status === 200) {
      const cache = await caches.open(AUDIO_CACHE);
      await stampAndCache(cache, request.url, response).catch(() => {});
      await evictAudioOverBudget();
      await broadcastAudioStats();
    }
    return response;
  } catch {
    return new Response(JSON.stringify({ error: 'Audio not available offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function audioCacheSize() {
  const cache = await caches.open(AUDIO_CACHE);
  let total = 0;
  for (const req of await cache.keys()) {
    const cached = await cache.match(req);
    total += parseInt(cached.headers.get('content-length') || '0', 10);
  }
  return total;
}

async function evictAudioOverBudget() {
  const cache = await caches.open(AUDIO_CACHE);
  const entries = [];
  for (const req of await cache.keys()) {
    const cached = await cache.match(req);
    entries.push({
      url: req.url,
      size: parseInt(cached.headers.get('content-length') || '0', 10),
      time: cached.headers.get('sw-cached-at') || '',
    });
  }
  entries.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  let total = entries.reduce((a, e) => a + e.size, 0);
  for (const e of entries) {
    if (total <= AUDIO_BUDGET_BYTES) break;
    await cache.delete(e.url).catch(() => false);
    total -= e.size;
  }
}

async function broadcastAudioStats() {
  try {
    const cache = await caches.open(AUDIO_CACHE);
    const keys = await cache.keys();
    let used = 0;
    for (const req of keys) {
      const c = await cache.match(req);
      used += parseInt(c.headers.get('content-length') || '0', 10);
    }
    const payload = { type: 'AUDIO_STATS', usedBytes: used, count: keys.length, budget: AUDIO_BUDGET_BYTES };
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach((client) => client.postMessage(payload));
  } catch { /* no clients */ }
}

async function trimThumbCache() {
  const cache = await caches.open(THUMB_CACHE);
  const keys = await cache.keys();
  if (keys.length <= THUMB_CACHE_MAX) return;
  // cache.keys() is in insertion order — oldest first.
  for (const key of keys.slice(0, keys.length - THUMB_CACHE_MAX)) {
    await cache.delete(key).catch(() => false);
  }
}

async function handleThumb(request) {
  const cache = await caches.open(THUMB_CACHE);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) return cached;
  const response = await fetch(request);
  // <img> fetches are no-cors: a good thumb comes back opaque (status 0).
  if (response.ok || response.type === 'opaque') {
    await cache.put(request, response.clone()).catch(() => {});
    await trimThumbCache().catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Remote album art (YouTube thumbnails): cache-first, so covers survive
  // offline. Everything else cross-origin is left alone.
  if (url.origin !== self.location.origin) {
    if (request.destination === 'image') {
      event.respondWith(handleThumb(request));
    }
    return;
  }

  if (isAudioRequest(url)) {
    event.respondWith(handleAudio(request));
    return;
  }

  if (url.pathname.startsWith(SW_BASE + '/api/') || url.pathname.startsWith(SW_BASE + '/auth/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone)).catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request, { ignoreSearch: true });
          return cached || caches.match(abs('./index.html')) || new Response('Offline', { status: 503 });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      // cache:'reload' bypasses the browser HTTP cache (max-age=3600 on
      // css/js) so deploys are never shadowed by a stale HTTP-cache copy.
      return fetch(request, { cache: 'reload' }).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone)).catch(() => {});
        }
        return response;
      });
    })
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'CACHE_AUDIO' && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(AUDIO_CACHE);
      await Promise.all(data.urls.map(async (u) => {
        try {
          const url = abs(u);
          if (await cache.match(url)) return;
          const res = await fetch(url, { credentials: 'same-origin' });
          if (res.ok && res.status === 200) {
            await stampAndCache(cache, url, res);
            await evictAudioOverBudget();
          }
        } catch { /* skip */ }
      }));
      await broadcastAudioStats();
    })());
  } else if (data.type === 'CACHE_ART' && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(THUMB_CACHE);
      await Promise.all(data.urls.map(async (u) => {
        try {
          if (await cache.match(u)) return;
          const res = await fetch(u, { mode: 'no-cors' });
          if (res.ok || res.type === 'opaque') {
            await cache.put(u, res.clone());
            await trimThumbCache();
          }
        } catch { /* skip */ }
      }));
    })());
  } else if (data.type === 'DELETE_AUDIO' && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(AUDIO_CACHE);
      await Promise.all(data.urls.map((u) => cache.delete(abs(u)).catch(() => false)));
      await broadcastAudioStats();
    })());
  } else if (data.type === 'CLEAR_AUDIO') {
    event.waitUntil(caches.delete(AUDIO_CACHE).then(broadcastAudioStats));
  }
});

async function notifyClientsToSync() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => client.postMessage({ type: 'SYNC_NOW' }));
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'flush-library' || event.tag === 'refresh-library') {
    event.waitUntil(notifyClientsToSync());
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'refresh-library') {
    event.waitUntil(notifyClientsToSync());
  }
});
