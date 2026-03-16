/* ═══════════════════════════════════════════════════════════
   Burger Company — IIM Sirmaur Canteen
   Service Worker v4

   Improvements over v3:
   - Poll interval: 8s (was 30s) — much faster notification delivery
   - Outlet mode persisted via Cache API — survives iOS SW kill/restart
   - fresh flag: on first outlet login, load existing as baseline (no spam)
   - Both customer + outlet can poll simultaneously
═══════════════════════════════════════════════════════════ */

const CACHE_NAME    = 'burger-co-v4';
const DB_URL        = 'https://burger-company-iim-default-rtdb.asia-southeast1.firebasedatabase.app';
const POLL_INTERVAL = 8000;   // 8 seconds — fast enough for real-time feel

// ── In-memory state (reset when SW is killed) ─────────────
let watchedUser   = null;   // customer: { uid, name }
let knownStatuses = {};     // customer: { fbKey: status }

let outletWatching  = false;
let outletKnownKeys = null; // outlet: null = not loaded yet, {} = loaded

let pollTimer = null;

// ── Restore outlet watch state after iOS SW kill ──────────
// We use the Cache API as persistent storage (localStorage not available in SW)
const STATE_CACHE = 'burger-sw-state';

async function saveOutletState(watching) {
  const c = await caches.open(STATE_CACHE);
  await c.put('outlet_active', new Response(watching ? '1' : '0'));
}

async function loadOutletState() {
  try {
    const c   = await caches.open(STATE_CACHE);
    const res = await c.match('outlet_active');
    if (!res) return false;
    const val = await res.text();
    return val === '1';
  } catch(e) { return false; }
}

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
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_NAME && k !== STATE_CACHE).map(k => caches.delete(k))
    );
    await self.clients.claim();

    // Restore outlet watching if it was active before SW was killed
    const wasActive = await loadOutletState();
    if (wasActive) {
      outletWatching  = true;
      outletKnownKeys = null; // will load on first poll
      startPolling();
    }
  })());
});

// ── Messages from app ─────────────────────────────────────
self.addEventListener('message', event => {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {

    case 'WATCH_ORDERS':
      // Customer watching their own orders
      watchedUser   = msg.user;
      knownStatuses = msg.statuses || {};
      startPolling();
      break;

    case 'UPDATE_STATUSES':
      // App is open — sync so we don't double-notify
      Object.assign(knownStatuses, msg.statuses || {});
      break;

    case 'STOP_WATCH':
      watchedUser = null;
      if (!outletWatching) stopPolling();
      break;

    case 'WATCH_OUTLET_ORDERS':
      outletWatching = true;
      saveOutletState(true);
      if (msg.fresh || outletKnownKeys === null) {
        // Fresh login or SW just restarted — load existing orders as baseline
        // Don't notify for anything we receive on first poll
        outletKnownKeys = null; // null = "load on next poll, don't notify"
      } else {
        // Ongoing sync — merge new keys we know about
        Object.assign(outletKnownKeys, msg.statuses || {});
      }
      startPolling();
      break;

    case 'STOP_OUTLET_WATCH':
      outletWatching  = false;
      outletKnownKeys = null;
      saveOutletState(false);
      if (!watchedUser) stopPolling();
      break;
  }
});

// ── Polling ───────────────────────────────────────────────
function startPolling() {
  stopPolling();
  pollAll();
  pollTimer = setInterval(pollAll, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollAll() {
  if (!watchedUser && !outletWatching) return;

  let data;
  try {
    const res = await fetch(`${DB_URL}/orders.json`, { cache: 'no-store' });
    if (!res.ok) return;
    data = await res.json();
  } catch(e) {
    console.warn('[SW] Poll failed:', e);
    return;
  }

  if (!data) {
    // No orders at all
    if (outletKnownKeys === null) outletKnownKeys = {};
    return;
  }

  const entries = Object.entries(data);

  // ── Customer notifications ────────────────────────────
  if (watchedUser) {
    entries.forEach(([fbKey, order]) => {
      if (!order?.customer) return;
      if (order.customer.uid !== watchedUser.uid) return;

      const prev = knownStatuses[fbKey];
      const curr = order.status;
      knownStatuses[fbKey] = curr;

      if (prev === curr || !prev) return; // no change or first time seeing

      if (curr === 'preparing' && prev === 'payment_uploaded') {
        notify(
          '\uD83D\uDCB8 Payment Verified \u2014 Burger Company',
          'Order #' + pad(order.queueNum) + ' confirmed! Being prepared now \uD83D\uDC68\u200D\uD83C\uDF73',
          'customer_prep_' + fbKey
        );
      } else if (curr === 'ready') {
        notify(
          '\u2705 Order Ready \u2014 Burger Company',
          'Order #' + pad(order.queueNum) + ' is ready! Head to the main desk \uD83C\uDFC3',
          'customer_ready_' + fbKey
        );
      } else if (curr === 'payment_rejected') {
        notify(
          '\u274C Payment Rejected \u2014 Burger Company',
          'Order #' + pad(order.queueNum) + ' \u2014 please re-upload your screenshot.',
          'customer_rejected_' + fbKey
        );
      }
    });
  }

  // ── Outlet notifications ──────────────────────────────
  if (outletWatching) {
    if (outletKnownKeys === null) {
      // First poll after login/restart — load all current as baseline, no notifications
      outletKnownKeys = {};
      entries.forEach(([fbKey, order]) => {
        if (order) outletKnownKeys[fbKey] = order.status;
      });
    } else {
      // Normal poll — check for brand new orders
      entries.forEach(([fbKey, order]) => {
        if (!order) return;
        const isNew = !(fbKey in outletKnownKeys);
        outletKnownKeys[fbKey] = order.status;

        if (isNew && order.status === 'payment_uploaded') {
          const num   = pad(order.queueNum);
          const name  = order.customer?.name || 'Customer';
          const total = order.total ? '\u20b9' + order.total : '';
          const items = order.items
            ? order.items.length + ' item' + (order.items.length !== 1 ? 's' : '')
            : '';
          notify(
            '\uD83D\uDED2 New Order #' + num + ' \u2014 Burger Company',
            name + ' \u00b7 ' + items + ' ' + total + '\nPayment uploaded \u2014 tap to verify.',
            'outlet_new_' + fbKey,
            true   // strong vibration for outlet
          );
        }
      });
    }
  }
}

function pad(n) { return String(n ?? '?').padStart(2, '0'); }

function notify(title, body, tag, strong = false) {
  self.registration.showNotification(title, {
    body,
    icon    : 'icon-192.png',
    badge   : 'icon-192.png',
    tag,
    renotify: true,
    vibrate : strong ? [300, 100, 300, 100, 300] : [200, 100, 200],
    requireInteraction: strong,   // outlet notifs stay on screen until dismissed
    data    : { url: self.location.origin }
  });
}

// ── Notification click: focus or open app ─────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || self.location.origin;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client)
          return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── Fetch: cache-first for app shell ─────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;
  if (event.request.url.includes('firebase')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response?.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
