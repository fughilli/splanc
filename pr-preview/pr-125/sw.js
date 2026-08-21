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
 *   - other static assets (Vite content-hashed assets/*): stale-while-revalidate.
 * The dynamic API paths below are never cached.
 *
 * All paths are resolved relative to the registration SCOPE (the deploy root),
 * so the same worker serves the app whether it is hosted at an origin root (the
 * Pi M2 server, Cloudflare ledmapper.pages.dev) or a subpath (the GitHub Pages
 * project site + per-PR previews under /pr-preview/pr-N/). BASE is that scope's
 * path prefix (e.g. "/" or "/splanc/pr-5/"); request paths are compared with it
 * stripped, and cached SHELL urls are prefixed with it.
 */

// The deploy root: the worker's registration scope. Ends with "/".
const BASE = new URL(self.registration.scope).pathname;

// Bump on any change that must invalidate the old cache (esp. the fixed-name
// wasm bundles) — `activate` deletes every cache that isn't the current one.
const VERSION = "v4";
const CACHE = `ledmapper-${VERSION}`;
const SHELL = [BASE, BASE + "index.html", BASE + "manifest.webmanifest", BASE + "icons/app-icon.svg"];

// Deploy-root-relative request path (BASE stripped, no leading slash), e.g.
// "maps/xyz" or "solver/worker.js" — what the regexes below match against.
function relPath(pathname) {
  return pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\//, "");
}

// Deploy-relative paths that are dynamic (server API) — never cache these.
const NO_CACHE = [/^maps(\/|$)/, /^healthz$/, /^ws(\/|$)/, /^api(\/|$)/];
// Fixed-name, version-coupled bundles: serve network-first (fresh online, cache
// only as the offline fallback) so a deploy's new wasm is never shadowed.
const NETWORK_FIRST = [/^(fx-vm|fx-compiler|solver|pulse)\//];

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
  const rel = relPath(url.pathname);
  if (NO_CACHE.some((re) => re.test(rel))) return;

  // Navigations: network-first so a fresh bundle is picked up online, with the
  // cached shell as the offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          cachePut(req, res.clone());
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match(BASE + "index.html"))),
    );
    return;
  }

  // Fixed-name wasm/js bundles: network-first (see NETWORK_FIRST) so a fresh
  // deploy's bytes win over the last session's cached copy; fall back to cache
  // offline.
  if (NETWORK_FIRST.some((re) => re.test(rel))) {
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
