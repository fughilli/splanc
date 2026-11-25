/**
 * Universal links into the native app (docs/design/share-links.md). With the
 * `applinks:splanc.io` entitlement (web/ios-config/apply.sh) and splanc.io's
 * apple-app-site-association, iOS hands https://splanc.io/app/#/share?… to the app instead
 * of Safari. Capacitor's App plugin (@capacitor/app) reports it: getLaunchUrl() when the
 * link started the app, the `appUrlOpen` event when it was already running. The app
 * bundle is served from capacitor://localhost, so the link's fragment is applied to this
 * page's hash, which the router then opens.
 *
 * Bound through the injected Capacitor global like the other native bridges; a no-op in a
 * browser or the PWA, where the link already is the page's own URL.
 */

import { isNativePlatform, registerNativePlugin } from "./native";

interface AppPlugin {
  getLaunchUrl(): Promise<{ url: string } | undefined>;
  addListener(event: "appUrlOpen", fn: (e: { url: string }) => void): Promise<unknown>;
}

/** Hosts whose /app links the app opens (splanc.io's AASA names only splanc.io). */
const HOSTS = new Set(["splanc.io", "www.splanc.io"]);

/** The in-app hash a universal link opens, or null when it isn't one of ours. */
export function appLinkHash(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !HOSTS.has(u.hostname) || !u.pathname.startsWith("/app")) return null;
  return u.hash.length > 1 ? u.hash : null;
}

export function installAppLinks(go: (hash: string) => void = (h) => void (location.hash = h)): void {
  if (!isNativePlatform()) return;
  let app: AppPlugin;
  try {
    app = registerNativePlugin<AppPlugin>("App");
  } catch {
    return;
  }
  const open = (url: string | undefined): void => {
    const h = url ? appLinkHash(url) : null;
    if (h) go(h);
  };
  void app
    .getLaunchUrl()
    .then((r) => open(r?.url))
    .catch(() => {});
  void app.addListener("appUrlOpen", (e) => open(e.url)).catch(() => {});
}
