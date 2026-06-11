// public-ui/sw.js
// =====================================================
// Stratégie de cache :
//   • Assets statiques (HTML/CSS/JS/fonts) → Cache First
//   • API calls (/api/*) → Network First + fallback offline
//   • WebSocket → non intercepté (géré directement)
//
// Mise à jour automatique :
//   Quand une nouvelle version est déployée, le SW
//   prend le contrôle immédiatement (skipWaiting).
//
// Service Worker SkyAInet PWA + SkyAInet × Nikola T369
// =====================================================

"use strict";

const CACHE_VERSION  = 'skyainet-v1';
const CACHE_STATIC   = `${CACHE_VERSION}-static`;
const CACHE_API      = `${CACHE_VERSION}-api`;

// Assets à précacher au premier chargement
const PRECACHE_ASSETS = [
    '/skyainet.html',
    '/skycloud.html',
    '/offline.html',
];

// ─── Installation ─────────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_STATIC)
            .then(cache => cache.addAll(PRECACHE_ASSETS.filter(async url => {
                // Ne précacher que les assets qui existent
                try { await fetch(url, { method: 'HEAD' }); return true; }
                catch { return false; }
            })))
            .then(() => {
                console.info('[SW] Installation complète — skipWaiting');
                return self.skipWaiting(); // Prise de contrôle immédiate
            })
    );
});

// ─── Activation ───────────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(k => k.startsWith('skyainet-') && k !== CACHE_STATIC && k !== CACHE_API)
                    .map(k => {
                        console.info(`[SW] Cache obsolète supprimé : ${k}`);
                        return caches.delete(k);
                    })
            )
        ).then(() => {
            console.info('[SW] Activation — prise de contrôle de tous les clients');
            return self.clients.claim();
        })
    );
});

// ─── Fetch intercept ──────────────────────────────────────────
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    // WebSocket — ne pas intercepter
    if (request.url.startsWith('ws://') || request.url.startsWith('wss://')) return;

    // API calls — Network First avec fallback JSON offline
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirstAPI(request));
        return;
    }

    // Assets statiques — Cache First avec fallback réseau
    event.respondWith(cacheFirstStatic(request));
});

// ─── Stratégies ───────────────────────────────────────────────

/** Network First pour les appels API. */
async function networkFirstAPI(request) {
    try {
        const response = await fetch(request.clone());
        // Mettre en cache GET uniquement
        if (request.method === 'GET' && response.ok) {
            const cache = await caches.open(CACHE_API);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        // Hors ligne — tenter le cache
        const cached = await caches.match(request);
        if (cached) return cached;
        // Réponse offline générique
        return new Response(
            JSON.stringify({ ok: false, error: 'offline', message: 'Node offline — cached data unavailable' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

/** Cache First pour les assets statiques. */
async function cacheFirstStatic(request) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request.clone());
        if (response.ok) {
            const cache = await caches.open(CACHE_STATIC);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        // Fallback page offline si HTML
        if (request.destination === 'document') {
            const offline = await caches.match('/offline.html');
            if (offline) return offline;
        }
        return new Response('Offline', { status: 503 });
    }
}

// ─── Messages depuis la page ──────────────────────────────────
self.addEventListener('message', event => {
    // Forcer la mise à jour immédiate depuis la page
    if (event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    // Vider le cache sur demande (utile pour le dev)
    if (event.data?.type === 'CLEAR_CACHE') {
        caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
        event.ports[0]?.postMessage({ ok: true });
    }
});

// ─── Push notifications ───────────────────────────────────────
self.addEventListener('push', event => {
    const data = event.data?.json() ?? {};
    event.waitUntil(
        self.registration.showNotification(data.title ?? 'SkyAInet', {
            body : data.body  ?? 'New activity on your node',
            icon : data.icon  ?? '/icons/icon-192.png',
            badge: data.badge ?? '/icons/badge-72.png',
            tag  : data.tag   ?? 'skyainet-notification',
            data : data.url   ?? '/',
        })
    );
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(list => {
            const url = event.notification.data ?? '/';
            const existing = list.find(c => c.url.includes('skyainet'));
            if (existing) { existing.focus(); existing.navigate(url); }
            else clients.openWindow(url);
        })
    );
});
