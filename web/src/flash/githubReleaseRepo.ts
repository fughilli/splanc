/**
 * GitHub-releases firmware source — enumerates flashable firmware from EVERY
 * published release rather than just the images this build bundles.
 *
 * We fetch `GET /repos/<slug>/releases`, keep each release's firmware assets
 * (`esp32c6-<variant>-<version>.tar`, produced by .github/workflows/release.yaml
 * on a `firmware-v*` tag), and present them as ordinary `FirmwareEntry`s — one per
 * release × variant — that the existing picker + flasher consume unchanged. Each
 * entry carries the asset's `tarUrl`; firmwareRepo.loadFlashRequestFromTar fetches
 * and untars it in the browser at flash time. GitHub serves both the API listing
 * and release-asset downloads with permissive CORS, so this all runs client-side.
 *
 * The parser (releasesToFirmwareIndex) is pure/DOM-free for unit testing; the
 * fetch wrapper degrades to null (→ the caller falls back to the bundled index or
 * shows "offline") on any network/rate-limit/parse failure, never throwing.
 */

import { REPO_SLUG } from "../buildInfo";
import { getReleaseIndex, putReleaseIndex } from "./firmwareCache";
import type { ChipFamily } from "./usb";
import type { FirmwareEntry, FirmwareIndex } from "./manifest";

/** Firmware asset names we publish, e.g. `esp32c6-netstack-1.2.0.tar`. The chip +
 * family are fixed for now (only the ESP32-C6 player ships a web-flashable image);
 * the capture group is the variant shown in the picker. */
const ASSET_RE = /^esp32c6-(vendor|netstack)-.+\.tar$/i;
const VARIANT_LABEL: Record<string, string> = { vendor: "Vendor Wi-Fi", netstack: "Heapless netstack" };

// GitHub release-asset downloads send no CORS headers, so a browser fetch() of the
// asset URL is blocked ("Failed to fetch"). Route it through our Cloudflare Pages
// Function (web/functions/gh-asset.js), which re-serves the bytes with CORS. The
// base is absolute (not relative) so it also works when the app is served from
// GitHub Pages, which can't run the Function.
const ASSET_PROXY = "https://splanc.pages.dev/gh-asset";

/** Wrap a GitHub release-asset URL so the browser can fetch it cross-origin. */
export function proxiedAssetUrl(url: string): string {
  return `${ASSET_PROXY}?url=${encodeURIComponent(url)}`;
}

/** Build a firmware index from the GitHub `releases` API payload. Pure — no fetch.
 * Returns null (never throws) when nothing flashable is found or the shape is off. */
export function releasesToFirmwareIndex(json: unknown): FirmwareIndex | null {
  if (!Array.isArray(json)) return null;
  const entries: FirmwareEntry[] = [];
  for (const rel of json) {
    if (typeof rel !== "object" || rel === null) continue;
    const r = rel as Record<string, unknown>;
    if (r["draft"] === true) continue; // unpublished — not selectable
    const tag = typeof r["tag_name"] === "string" ? r["tag_name"] : null;
    if (!tag) continue;
    // Version is the tag without its component prefix ("firmware-v1.2.0" → "1.2.0");
    // the exact commit is the release's target when it recorded a full 40-hex SHA
    // (release.yaml pins target_commitish to the tagged commit), else omitted.
    const version = tag.replace(/^[a-z]+-v/i, "");
    const target = typeof r["target_commitish"] === "string" ? r["target_commitish"] : "";
    const commit = /^[0-9a-f]{40}$/i.test(target) ? target : undefined;
    const assets = Array.isArray(r["assets"]) ? r["assets"] : [];
    for (const a of assets) {
      if (typeof a !== "object" || a === null) continue;
      const asset = a as Record<string, unknown>;
      const name = typeof asset["name"] === "string" ? asset["name"] : "";
      const url = typeof asset["browser_download_url"] === "string" ? asset["browser_download_url"] : "";
      const m = ASSET_RE.exec(name);
      if (!m || !url) continue;
      const variant = m[1]!.toLowerCase();
      entries.push({
        id: `${tag}::${variant}`, // unique across releases + variants (picker <option> value)
        label: `${VARIANT_LABEL[variant] ?? variant} — ${tag}`,
        chip: "esp32c6",
        family: "esp" as ChipFamily,
        manifest: "flash.json", // lives inside the tar
        tarUrl: url,
        version,
        ...(commit ? { commit } : {}),
      });
    }
  }
  if (entries.length === 0) return null;
  // Releases come newest-first from the API; preserve that so the latest is first.
  return { revision: null, builtAt: null, entries };
}

/** Fetch + parse all releases into a firmware index. On success the index is persisted
 * to the offline cache (firmwareCache); when the network is unavailable (offline,
 * rate-limited, 5xx) we fall back to the LAST-cached index so the version list — and
 * any cached bundles — stay usable without a connection. Null only when there's no
 * live index AND nothing cached. */
export async function loadReleaseFirmwareIndex(): Promise<FirmwareIndex | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases?per_page=100`, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-cache",
    });
    if (!res.ok) return getReleaseIndex(); // rate-limited / 5xx — use the last-cached list
    const index = releasesToFirmwareIndex(await res.json());
    if (index) void putReleaseIndex(index); // persist for offline listing
    return index ?? (await getReleaseIndex());
  } catch {
    // Offline / DNS / CORS — fall back to the last release index we cached.
    return getReleaseIndex();
  }
}
