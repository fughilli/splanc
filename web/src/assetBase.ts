/**
 * Deploy-root-relative asset base for the runtime-loaded, NON-Vite-managed
 * bundles (the wasm packages staged next to the app: solver/, pulse/, fx-vm/,
 * fx-compiler/, plus the service worker + PWA icons).
 *
 * Vite rewrites the URLs it owns (entry scripts, hashed /assets/*, and the
 * public-asset <link>/<img> refs in the HTML) relative to each page for us
 * (vite.config.ts `base: "./"`). But these bundles are referenced by hand-built
 * URL strings in TS — Vite never sees them — so we resolve them against the
 * current document here. That makes ONE built bundle work whether it is served
 * from an origin root (the Pi M2 server, Cloudflare ledmapper.pages.dev) or from
 * a subpath (the GitHub Pages project site https://fughilli.github.io/splanc/
 * and its per-PR previews under /pr-preview/pr-N/).
 *
 * The app is a multi-page app whose HTML entry points (index/wall/effects) all
 * sit at the deploy root, so the document's directory IS the deploy root.
 */

/**
 * Absolute URL for a top-level deploy directory or file, resolved against the
 * current document. Pass e.g. "solver" → ".../solver" (no trailing slash, to
 * match the existing `${base}/file` call sites) or "sw.js" → ".../sw.js".
 *
 * Falls back to a root-absolute path when there is no document (the CJS
 * unit-test build), where these browser-only loaders are never invoked.
 */
export function assetUrl(path: string): string {
  if (typeof document === "undefined" || !document.baseURI) return "/" + path;
  // Resolve against the document directory. document.baseURI is the page URL;
  // `new URL(path, base)` resolves `path` relative to the page's directory.
  return new URL(path, document.baseURI).href.replace(/\/+$/, "");
}
