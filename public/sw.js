// Clashly service worker — deliberately minimal. Network-first for everything so
// deploys are never stale; the SW exists mainly to make the app installable and
// to be the future home of push notifications.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
