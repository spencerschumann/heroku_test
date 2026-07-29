// Service worker for the Pixelogic PCB PWA.
//
// Caching goal (per the app's priority): always load the LATEST version when
// online, while still working offline. So the fetch strategy is
// network-first — every navigation and same-origin GET tries the network
// first and only falls back to the cache when the network fails. The cache
// is refreshed from each successful network response, so an offline visit
// serves whatever the last online visit fetched, not a frozen snapshot.
//
// The versioned cache name lets `activate` purge everything from older
// versions. Bump CACHE_VERSION whenever you want to guarantee a clean sweep
// of old cached assets (network-first already keeps content fresh online, so
// this is mostly housekeeping).

const CACHE_VERSION = 'v5';
const CACHE_NAME = `pixelogic-pcb-${CACHE_VERSION}`;

const ASSETS = [
    './',
    './index.html',
    './pixelogic-pcb.css',
    './model.js',
    './view.js',
    './game.js',
    './ui.js',
    './pwa.js',
    './manifest.webmanifest',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
    // Precache the shell so the very first offline load works, but don't
    // skipWaiting automatically — the page decides when to activate an update
    // (see pwa.js) so it never swaps out mid-edit without warning.
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => { })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    if (new URL(req.url).origin !== self.location.origin) return;

    event.respondWith((async () => {
        try {
            const fresh = await fetch(req);
            // Cache a copy of every good response so offline has the latest.
            if (fresh && fresh.status === 200 && fresh.type === 'basic') {
                const cache = await caches.open(CACHE_NAME);
                cache.put(req, fresh.clone());
            }
            return fresh;
        } catch (err) {
            const cached = await caches.match(req);
            if (cached) return cached;
            if (req.mode === 'navigate') {
                const shell = await caches.match('./index.html');
                if (shell) return shell;
            }
            throw err;
        }
    })());
});
