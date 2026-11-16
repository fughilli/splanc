/**
 * LED Mapper service worker — enables installability (a fetch handler is part of
 * the PWA install criteria) and gives the app an offline-capable shell.
 *
 * Strategy, same-origin GET only (everything else passes straight through, so
 * the wss control plane and any dynamic API are untouched):
 *   - navigations: network-first, falling back to the cached app shell offline;
 *   - the wasm bundles under /solver, /fx-vm, /fx-compiler, /pulse, and the
 *     bundled flash images under /firmware: network-first too. These have FIXED
 *     (non-content-hashed) filenames whose bytes change on every deploy, so
 *     stale-while-revalidate would serve last deploy's copy to the current
 *     session (e.g. an old fx_vm that doesn't know new opcodes, or — for
 *     /firmware — the "This build (dev)" source flashing a weeks-old image after
 *     the preview stopped bundling one) — keep them in lockstep with the app;
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
// v5: rebranded the raster icons (apple-touch-icon + icon-*.png) to the splash
// mark — they had been left as the old "tree" art. Bumping evicts the cached
// manifest + icons so updated clients re-fetch the new brand.
// v6: /firmware/ moved to network-first; evicts the stale-while-revalidate copies
// that kept serving an old "This build (dev)" image.
// v7: the SVG app icons were invalid XML (unbound inkscape: prefix), so Android
// Chrome refused to install the app; evicts the cached broken app-icon.svg.
const VERSION = "v7";
const CACHE = `ledmapper-${VERSION}`;
const SHELL = [BASE, BASE + "index.html", BASE + "manifest.webmanifest", BASE + "icons/app-icon.svg"];
// Precached on install (best effort, apart from the shell so a miss never blocks
// installing): the effect compiler + VM, so an installed app can author and
// preview effects offline, and a flaky first download in a session has a copy to
// fall back on. Still network-first at runtime (NETWORK_FIRST below).
const WARM = [
  BASE + "fx-compiler/fx_compiler_wasm_pkg.js",
  BASE + "fx-compiler/fx_compiler_wasm_pkg_bg.wasm",
  BASE + "fx-vm/fx_vm_wasm_pkg.js",
  BASE + "fx-vm/fx_vm_wasm_pkg_bg.wasm",
];

// Deploy-root-relative request path (BASE stripped, no leading slash), e.g.
// "maps/xyz" or "solver/worker.js" — what the regexes below match against.
function relPath(pathname) {
  return pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\//, "");
}

// Deploy-relative paths that are dynamic (server API) — never cache these.
const NO_CACHE = [/^maps(\/|$)/, /^healthz$/, /^ws(\/|$)/, /^api(\/|$)/];
// Fixed-name, version-coupled bundles: serve network-first (fresh online, cache
// only as the offline fallback) so a deploy's new wasm is never shadowed.
// whatsnew/index.json (the mirrored release notes) is fixed-name too and is
// re-mirrored on every deploy; its media/ files are content-hashed, so they take
// the stale-while-revalidate path below and stay readable offline.
const NETWORK_FIRST = [/^(fx-vm|fx-compiler|solver|pulse|firmware)\//, /^whatsnew\/index\.json$/];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL).then(() => Promise.all(WARM.map((u) => c.add(u).catch(() => {})))))
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
  // The app's loaders retry a failed download with a cache-busting `?retry=N`
  // (src/fx/wasmLoad.ts — a failed dynamic import() is cached as failed for the
  // page's lifetime); the cache keys on the clean URL so those retries refresh /
  // fall back to the same entry instead of piling up copies.
  if (NETWORK_FIRST.some((re) => re.test(rel))) {
    const key = withoutRetry(url);
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") cachePut(key, res.clone());
          return res;
        })
        .catch(() => caches.match(key)),
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

// `url` without the loaders' `retry` cache-buster (see the fetch handler).
function withoutRetry(url) {
  if (!url.searchParams.has("retry")) return url.href;
  const u = new URL(url.href);
  u.searchParams.delete("retry");
  return u.href;
}

function cachePut(req, res) {
  caches
    .open(CACHE)
    .then((c) => c.put(req, res))
    .catch(() => {});
}
