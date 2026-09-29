// Minimal offline shell. The camera never goes through fetch (getUserMedia is a separate browser
// API), so there is nothing camera-related to exclude here — this only ever sees GET requests for
// the page, its hashed JS/CSS, and the vendored three/MediaPipe/model assets.
const CACHE = 'sigil-v3';

self.addEventListener('install', (e) => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // vendor/ (three, MediaPipe wasm, the model) is big, versioned by the pinned package, and the tracker's own
  // loading depends on getting exact bytes: never cache or answer it here, always straight to the network
  if (url.pathname.includes('/vendor/')) return;

  // index.html is unhashed and changes on every deploy — always prefer the network, cache as a
  // fallback for offline use. Everything else is content-hashed (or third-party-versioned) so a
  // hit can be served straight from cache with no revalidation.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        (await caches.open(CACHE)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req)) || (await caches.match('./index.html'));
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.status === 200) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  })());
});
