/* ═══════════════════════════════════════════════════════════
   Burger Company — IIM Sirmaur Canteen
   Service Worker v3 — Background Polling for Both Roles

   Customer: polls for order status changes (payment verified / ready)
   Outlet:   polls for new incoming orders (payment_uploaded)
═══════════════════════════════════════════════════════════ */

const CACHE_NAME    = 'burger-co-v3';
const DB_URL        = 'https://burger-company-iim-default-rtdb.asia-southeast1.firebasedatabase.app';
const POLL_INTERVAL = 30000; // 30 seconds

// ── Customer state ────────────────────────────────────────
let watchedUser   = null;   // { uid, name }
let knownStatuses = {};     // { fbKey: status }

// ── Outlet state ──────────────────────────────────────────
let outletWatching   = false;
let outletKnownKeys  = {};  // { fbKey: status } — all known orders

let pollTimer = null;

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

// ── Messages from app ─────────────────────────────────────
self.addEventListener('message', event => {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {

    // Customer watching their own orders
    case 'WATCH_ORDERS':
      watchedUser   = msg.user;
      knownStatuses = msg.statuses || {};
      startPolling();
      break;

    // Customer app is open — just sync statuses so we don't double-notify
    case 'UPDATE_STATUSES':
      knownStatuses = msg.statuses || {};
      break;

    // Customer logged out
    case 'STOP_WATCH':
      watchedUser = null;
      if (!outletWatching) stopPolling();
      break;

    // Outlet panel watching for new orders
    case 'WATCH_OUTLET_ORDERS':
      outletWatching  = true;
      outletKnownKeys = msg.statuses || {};
      startPolling();
      break;

    // Outlet logged out
    case 'STOP_OUTLET_WATCH':
      outletWatching  = false;
      outletKnownKeys = {};
      if (!watchedUser) stopPolling();
      break;
  }
});

// ── Polling control ───────────────────────────────────────
function startPolling() {
  stopPolling();
  pollAll();
  pollTimer = setInterval(pollAll, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Main poll function ────────────────────────────────────
async function pollAll() {
  if (!watchedUser && !outletWatching) return;

  try {
    const res  = await fetch(`${DB_URL}/orders.json`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data) return;

    const entries = Object.entries(data);

    // ── Customer: check for status changes on their orders ──
    if (watchedUser) {
      entries.forEach(([fbKey, order]) => {
        if (!order || !order.customer) return;
        if (order.customer.uid !== watchedUser.uid) return;

        const prev = knownStatuses[fbKey];
        const curr = order.status;
        if (prev === curr) return;

        knownStatuses[fbKey] = curr;

        if (curr === 'preparing' && prev === 'payment_uploaded') {
          notify(
            '\uD83D\uDCB8 Payment Verified \u2014 Burger Company',
            'Order #' + pad(order.queueNum) + ' confirmed! Being prepared now \uD83D\uDC68\u200D\uD83C\uDF73',
            'prep_' + fbKey
          );
        } else if (curr === 'ready') {
          notify(
            '\u2705 Order Ready \u2014 Burger Company',
            'Order #' + pad(order.queueNum) + ' is ready! Head to the main desk \uD83C\uDFC3',
            'ready_' + fbKey
          );
        } else if (curr === 'payment_rejected') {
          notify(
            '\u274C Payment Rejected \u2014 Burger Company',
            'Order #' + pad(order.queueNum) + ' \u2014 please re-upload your payment screenshot.',
            'rejected_' + fbKey
          );
        }
      });
    }

    // ── Outlet: detect brand new orders ──────────────────
    if (outletWatching) {
      entries.forEach(([fbKey, order]) => {
        if (!order) return;
        const isNew = !(fbKey in outletKnownKeys);
        outletKnownKeys[fbKey] = order.status;

        if (isNew && order.status === 'payment_uploaded') {
          const num   = pad(order.queueNum);
          const name  = (order.customer && order.customer.name) || 'Customer';
          const total = order.total ? '\u20b9' + order.total : '';
          const items = order.items ? order.items.length + ' item' + (order.items.length !== 1 ? 's' : '') : '';
          notify(
            '\uD83D\uDED2 New Order #' + num + ' \u2014 Burger Company',
            name + ' \u00b7 ' + items + ' ' + total + ' \u2014 Payment uploaded, verify now.',
            'outlet_order_' + fbKey
          );
        }
      });
    }

  } catch(e) {
    console.warn('[SW] Poll error:', e);
  }
}

function pad(n) { return String(n || '?').padStart(2, '0'); }

function notify(title, body, tag) {
  self.registration.showNotification(title, {
    body,
    icon    : 'icon-192.png',
    badge   : 'icon-192.png',
    tag,
    renotify: true,
    vibrate : [200, 100, 200],
    data    : { url: self.location.origin }
  });
}

// ── Notification click: open app ──────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || self.location.origin;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── Fetch: cache-first for app shell ─────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;
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
