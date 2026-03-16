/* ═══════════════════════════════════════════════════════════
   Burger Company — IIM Sirmaur Canteen
   Service Worker v2 — Background Firebase Polling
   
   How it works:
   1. App registers SW and sends user info + order statuses via postMessage
   2. SW stores them and polls Firebase REST API every 30 seconds
   3. When an order status changes to 'preparing' or 'ready', SW fires
      a push notification directly — even when app is closed/backgrounded
   4. Works on iOS 16.4+ (installed PWA) and Android Chrome
═══════════════════════════════════════════════════════════ */

const CACHE_NAME   = 'burger-co-v2';
const DB_URL       = 'https://burger-company-iim-default-rtdb.asia-southeast1.firebasedatabase.app';
const POLL_INTERVAL = 30000; // 30 seconds

// ── State stored in SW ────────────────────────────────────
let watchedUser    = null;  // { uid, name, phone }
let knownStatuses  = {};    // { fbKey: status }
let pollTimer      = null;

// ── Install ───────────────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['./', './index.html']).catch(() => {})
    )
  );
});

// ── Activate ──────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Message from app ──────────────────────────────────────
// App sends: { type: 'WATCH_ORDERS', user: {...}, statuses: {fbKey: status} }
// App sends: { type: 'STOP_WATCH' }
self.addEventListener('message', event => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'WATCH_ORDERS') {
    watchedUser   = msg.user;
    knownStatuses = msg.statuses || {};
    startPolling();
  } else if (msg.type === 'UPDATE_STATUSES') {
    // App is active — just update our known statuses so we don't re-notify
    knownStatuses = msg.statuses || {};
  } else if (msg.type === 'STOP_WATCH') {
    watchedUser = null;
    stopPolling();
  }
});

// ── Polling ───────────────────────────────────────────────
function startPolling() {
  stopPolling();
  pollFirebase(); // immediate first check
  pollTimer = setInterval(pollFirebase, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollFirebase() {
  if (!watchedUser) return;

  try {
    // Fetch all orders from Firebase REST API (no SDK needed)
    const res  = await fetch(`${DB_URL}/orders.json`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data) return;

    // Loop through orders belonging to this user
    Object.entries(data).forEach(([fbKey, order]) => {
      if (!order || !order.customer) return;
      if (order.customer.uid !== watchedUser.uid) return;

      const prevStatus = knownStatuses[fbKey];
      const newStatus  = order.status;

      // Only notify if status actually changed to something actionable
      if (prevStatus !== newStatus) {
        knownStatuses[fbKey] = newStatus;

        if (newStatus === 'preparing' && prevStatus === 'payment_uploaded') {
          fireNotification(
            '\uD83D\uDCB8 Payment Verified \u2014 Burger Company',
            `Order #${String(order.queueNum).padStart(2,'0')} confirmed! Being prepared now \uD83D\uDC68\u200D\uD83C\uDF73`,
            `prep_${fbKey}`
          );
        } else if (newStatus === 'ready') {
          fireNotification(
            '\u2705 Order Ready \u2014 Burger Company',
            `Order #${String(order.queueNum).padStart(2,'0')} is ready! Head to the main desk \uD83C\uDFC3`,
            `ready_${fbKey}`
          );
        } else if (newStatus === 'payment_rejected') {
          fireNotification(
            '\u274C Payment Rejected \u2014 Burger Company',
            `Order #${String(order.queueNum).padStart(2,'0')} \u2014 please re-upload your payment screenshot.`,
            `rejected_${fbKey}`
          );
        }
      }
    });
  } catch(e) {
    console.warn('[SW] Poll error:', e);
  }
}

function fireNotification(title, body, tag) {
  self.registration.showNotification(title, {
    body,
    icon      : 'icon-192.png',
    badge     : 'icon-192.png',
    tag,
    renotify  : false,
    vibrate   : [200, 100, 200],
    data      : { url: self.location.origin }
  });
}

// ── Notification click ────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || self.location.origin;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client)
          return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

// ── Fetch: cache-first for app shell ─────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;
  // Don't cache Firebase API calls
  if (event.request.url.includes('firebaseio.com') ||
      event.request.url.includes('firebase')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
