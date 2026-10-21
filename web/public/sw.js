/* Service worker: makes the app installable and opens it instantly. It caches ONLY the app's own static files (page shell, hashed
   scripts/styles, icons). It never touches /api/ requests, so personal data is never stored in the cache and a stale answer can never
   be shown for live data. Navigations go to the network first and fall back to the offline page. */
const VERSION = 'rk-shell-v1';
const SHELL = ['/offline.html', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;             // other sites and every write: untouched
  if (url.pathname.startsWith('/api/')) return;                                           // live data and personal data: always the network, never cached
  if (req.mode === 'navigate') {                                                           // pages: network first, offline page if it fails
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {        // fingerprinted files never change: cache first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; })));
  }
});

self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });

/* Web push: show the notification the server sent, and open the right page when it is tapped. The payload is only a title, a short line and an in-app path. */
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { /* plain text */ }
  e.waitUntil(self.registration.showNotification(String(d.title || 'Robokalam'), { body: String(d.body || ''), icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: typeof d.url === 'string' && d.url.startsWith('/') ? d.url : '/' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close(); const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => { for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } } return self.clients.openWindow(url); }));
});
