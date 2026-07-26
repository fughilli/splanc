/**
 * LED Mapper service worker — enables installability (a fetch handler is part of
 * the PWA install criteria) and gives the app an offline-capable shell.
 *
 * Strategy, same-origin GET only (everything else passes straight through, so
 * the wss control plane and any dynamic API are untouched):
 *   - navigations: network-first, falling back to the cached app shell offline;
 *   - the wasm bundles under /solver, /fx-vm, /fx-compiler, /pulse: network-first
 *     too. These have FIXED (non-content-hashed) filenames whose bytes change on
 *     every deploy, so stale-while-revalidate would serve last deploy's wasm to
 *     the current session (e.g. an old fx_vm that doesn't know new opcodes) —
 *     keep them in lockstep with the app that references them;
 *   - other static assets (Vite content-hashed /assets/*): stale-while-revalidate.
 * The dynamic API paths below are never cached.
 */

// Bump on any change that must invalidate the old cache (esp. the fixed-name
// wasm bundles) — `activate` deletes every cache that isn't the current one.
const VERSION = "v2";
const CACHE = `ledmapper-${VERSION}`;
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-192.png"];

// Same-origin paths that are dynamic (server API) — never cache these.
const NO_CACHE = [/^\/maps(\/|$)/, /^\/healthz$/, /^\/ws(\/|$)/, /^\/api(\/|$)/];
// Fixed-name, version-coupled bundles: serve network-first (fresh online, cache
// only as the offline fallback) so a deploy's new wasm is never shadowed.
const NETWORK_FIRST = [/^\/(fx-vm|fx-compiler|solver|pulse)\//];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {}),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let cross-origin pass through
  if (NO_CACHE.some((re) => re.test(url.pathname))) return;

  // Navigations: network-first so a fresh bundle is picked up online, with the
  // cached shell as the offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          cachePut(req, res.clone());
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/index.html"))),
    );
    return;
  }

  // Fixed-name wasm/js bundles: network-first (see NETWORK_FIRST) so a fresh
  // deploy's bytes win over the last session's cached copy; fall back to cache
  // offline.
  if (NETWORK_FIRST.some((re) => re.test(url.pathname))) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") cachePut(req, res.clone());
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") cachePut(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

function cachePut(req, res) {
  caches
    .open(CACHE)
    .then((c) => c.put(req, res))
    .catch(() => {});
}
