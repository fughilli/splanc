// Cloudflare Pages Function — CORS proxy for GitHub release-asset downloads.
//
// GitHub's release-asset CDN (release-assets.githubusercontent.com, reached via a
// redirect from github.com/.../releases/download/...) sends NO CORS headers, so the
// webapp's in-browser flasher cannot fetch a release `.tar` directly — the browser
// rejects it with "TypeError: Failed to fetch". This Function fetches the asset
// server-side (where CORS doesn't apply) and streams it straight back with
// Access-Control-Allow-Origin, so the flash path (firmwareRepo.loadFlashRequestFromTar,
// via githubReleaseRepo.proxiedAssetUrl) works from any origin the app is served on.
//
// It is NOT an open proxy: only this repo's release-download URLs are allowed.
//
// Served at /gh-asset on every Cloudflare Pages deploy (functions/ is compiled by
// `wrangler pages deploy`). GitHub Pages can't run Functions, so the client uses the
// absolute Cloudflare URL — hence the permissive CORS above.

const ALLOW_PREFIX = "https://github.com/fughilli/splanc/releases/download/";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
};

export function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet(context) {
  const target = new URL(context.request.url).searchParams.get("url");
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
    return new Response(`gh-asset: upstream returned ${upstream.status}`, {
      status: 502,
      headers: CORS,
    });
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
