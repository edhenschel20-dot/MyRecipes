const CACHE = 'recipe-book-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  // Just pass through — we don't need offline caching, just PWA installability
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
