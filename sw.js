const CACHE = 'recipe-book-v2';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });
self.addEventListener('fetch', e => {
  // Network-first: always fetch fresh, fall back to cache only when offline.
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
