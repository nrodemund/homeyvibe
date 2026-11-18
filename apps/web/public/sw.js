// App-shell service worker: the UI opens offline, live data always comes from the network.
const CACHE = 'homeyvibe-shell-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || /^\/(?:api|mcp)(?:\/|$)/.test(url.pathname)) return;

  // Network first so updates show up immediately; fall back to cache when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match('/'))),
  );
});

self.addEventListener('push', (event) => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!payload || typeof payload.title !== 'string') return;
  event.waitUntil(self.registration.showNotification(payload.title, { body: payload.body, icon: '/icon.svg' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) =>
    clients.find((client) => new URL(client.url).origin === self.location.origin)?.focus() ?? self.clients.openWindow('/')));
});
