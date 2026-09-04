// Cloudflare Pages advanced-mode Worker (deployed as <deploy-root>/_worker.js).
//
// Adds a single endpoint, GET /gh-asset, that CORS-proxies a GitHub release-asset
// download: GitHub's asset CDN (release-assets.githubusercontent.com, reached via a
// redirect from github.com/.../releases/download/...) sends NO CORS headers, so the
// webapp's in-browser flasher can't fetch a release firmware .tar directly. This
// fetches it server-side (no CORS there) and re-serves it with
// Access-Control-Allow-Origin. Locked to this repo's release URLs — not an open proxy.
//
// EVERY other request passes through to the static site via env.ASSETS, so the app,
// wasm bundles, and SPA fallback behave exactly as before.
//
// Advanced mode (one _worker.js) is used instead of a functions/ directory because
// `wrangler pages deploy <dir>` did not compile a nested functions/ dir on this
// project (it uploaded the source as a static asset and never routed it). Pages
// always executes _worker.js, so routing here is deterministic. GitHub Pages can't
// run it, so the client targets the absolute Cloudflare URL — hence the open CORS.

const ALLOW_PREFIX = "https://github.com/fughilli/splanc/releases/download/";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
};

async function ghAsset(request) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const target = new URL(request.url).searchParams.get("url");
  if (!target || !target.startsWith(ALLOW_PREFIX)) {
    return new Response("gh-asset: url must be a splanc release-download URL", {
      status: 400,
      headers: CORS,
    });
  }
  let upstream;
  try {
    upstream = await fetch(target, { redirect: "follow" });
  } catch (e) {
    return new Response(`gh-asset: upstream fetch failed (${e})`, { status: 502, headers: CORS });
  }
  if (!upstream.ok) {
    return new Response(`gh-asset: upstream returned ${upstream.status}`, { status: 502, headers: CORS });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...CORS,
      "content-type": "application/octet-stream",
      // Release assets are immutable per tag — let the browser cache the tar.
      "cache-control": "public, max-age=3600",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/gh-asset") return ghAsset(request);
    // Everything else is the static site (env.ASSETS honors the SPA not-found rule).
    return env.ASSETS.fetch(request);
  },
};
