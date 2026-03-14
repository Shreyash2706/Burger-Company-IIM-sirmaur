/* ═══════════════════════════════════════════════════════════
   Burger Company — IIM Sirmaur Canteen
   Service Worker — Push & Background Notification Handler
   
   This file MUST be placed in the same directory as
   burger-company-final.html on GitHub Pages.
   
   Rename it to sw.js in your GitHub repo.
═══════════════════════════════════════════════════════════ */

const CACHE_NAME = 'burger-co-v1';

// ── Install: cache the app shell ──────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache the main app file so it loads offline
      return cache.addAll([
        './',
        './index.html',
      ]).catch(() => {
        // Silently ignore cache errors (file names may differ)
      });
    })
  );
});

// ── Activate: clean old caches ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Push event: show notification from server (future FCM) ─
self.addEventListener('push', event => {
  let data = { title: 'Burger Company', body: 'You have an update on your order.' };
  try { data = event.data.json(); } catch(e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body      : data.body,
      icon      : 'icon-192.png',
      badge     : 'icon-192.png',
      tag       : data.tag || 'bc-update',
      renotify  : false,
      vibrate   : [200, 100, 200],
      data      : { url: data.url || self.location.origin }
    })
  );
});

// ── Notification click: bring app to foreground ───────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || self.location.origin;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If app is already open, focus it
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow(target);
      }
    })
  );
});

// ── Fetch: serve from cache when offline ─────────────────
self.addEventListener('fetch', event => {
  // Only handle same-origin GET requests
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful responses
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached); // fallback to cache on network fail
    })
  );
});
