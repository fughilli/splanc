/**
 * PWA install controller — makes the app installable and drives the install UX:
 *   - registers the service worker (public/sw.js) on a secure origin;
 *   - captures the Chromium `beforeinstallprompt` so we can trigger the native
 *     install prompt on demand;
 *   - shows a dismissible install banner on first load, then (after dismissal or
 *     install) leaves the install action reachable from the app-bar ⋯ menu;
 *   - handles iOS Safari, which has no install prompt — there the action opens a
 *     short "Add to Home Screen" instruction sheet;
 *   - rescues home-screen icons installed from a retired address (see
 *     {@link launchMode}): a separate banner (own dismiss key, back after a day)
 *     and the ⋯ "Install app" item open the app in real Chrome via an Android
 *     intent URL, where it can be installed again.
 *
 * The shell's ⋯ menu reflects {@link canInstall} and calls {@link promptInstall}.
 */

import { Button, IconButton, Sheet, icon, toast } from "../kit";
import { isNativePlatform } from "../../net/native";

/** The non-standard (but widely shipped) Chromium install-prompt event. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "pwa.install.dismissed";
/** Holds the time (ms) the stale-icon banner was last dismissed. */
const STALE_DISMISS_KEY = "pwa.staleIcon.dismissed";
/** The stale-icon banner stays away this long after a dismissal: the old icon keeps
 * opening the app in a window that can't install, so it is worth raising again. */
export const STALE_SNOOZE_MS = 24 * 60 * 60 * 1000;
/** Added by the retired splanc.pages.dev redirect (web/_worker.js) to a
 * ?source=pwa launch. */
const RETIRED_PARAM = "retired";
/** Added to the URL that the stale-icon escape opens in Chrome. */
const REINSTALL_PARAM = "reinstall";

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage: the banner just comes back next launch */
  }
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

function isStandalone(): boolean {
  const mode = (m: string): boolean => window.matchMedia?.(`(display-mode: ${m})`).matches === true;
  return (
    mode("standalone") ||
    mode("fullscreen") ||
    mode("minimal-ui") ||
    // iOS Safari's legacy flag when launched from the home screen.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** iOS/iPadOS Safari — no beforeinstallprompt; install is manual (Share → A2HS). */
function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const iOS =
    /iP(hone|ad|od)/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS 13+
  const webkit = /WebKit/.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS)/.test(ua);
  return iOS && webkit;
}

function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

/**
 * How this page was opened, as far as installing goes:
 *   - "stale": from a home-screen icon installed at another address, such as the
 *     retired splanc.pages.dev, which now redirects here. Android then shows the page
 *     in a Custom Tab inside the old icon's window (X, title, ⋮), where Chrome's
 *     menu says "This app cannot be installed" — but the page still reports
 *     display-mode standalone, so the icon looks installed. Detected by the
 *     redirect's retired=1 tag, or by a ?source=pwa (start_url) launch that is not
 *     standalone; also by our own reinstall=1 URL still running standalone (the
 *     Chrome intent was kept in the old window).
 *   - "reinstall": in a normal browser tab opened by the stale-icon escape: offer
 *     the install even if the plain install banner was dismissed before.
 *   - "normal": everything else.
 */
export type LaunchMode = "normal" | "stale" | "reinstall";

export function launchMode(): LaunchMode {
  const q = new URLSearchParams(location.search ?? "");
  const standalone = isStandalone();
  if (q.get("source") === "pwa" && (q.has(RETIRED_PARAM) || !standalone)) return "stale";
  if (q.has(REINSTALL_PARAM)) return standalone ? "stale" : "reinstall";
  return "normal";
}

function launchedFromStaleIcon(): boolean {
  return launchMode() === "stale";
}

/**
 * The Android intent URL that opens this page in Chrome itself, out of whatever
 * window it is in now. It drops the launch tags (source, retired) and adds
 * reinstall=1; the hash route is dropped because the intent syntax owns the
 * fragment. Chrome missing → the fallback URL opens in the default browser.
 */
export function chromeIntentUrl(loc: Pick<Location, "protocol" | "host" | "pathname" | "search">): string {
  const q = new URLSearchParams(loc.search ?? "");
  q.delete("source");
  q.delete(RETIRED_PARAM);
  q.set(REINSTALL_PARAM, "1");
  const scheme = (loc.protocol || "https:").replace(/:$/, "");
  const rest = `${loc.host}${loc.pathname || "/"}?${q.toString()}`;
  const fallback = `${scheme}://${rest}`;
  return (
    `intent://${rest}#Intent;scheme=${scheme};package=com.android.chrome;` +
    `S.browser_fallback_url=${encodeURIComponent(fallback)};end`
  );
}

/** Leave the stale icon's window: open this page in Chrome, where it installs. */
function openInChrome(): void {
  location.href = chromeIntentUrl(location);
}

/** True when the app is already running as an installed PWA. */
export function isInstalled(): boolean {
  // The Capacitor native wrapper IS the installed app — treat it as installed so
  // no install UX is ever offered (canInstall/menu item/banner all gate on this).
  if (isNativePlatform()) return true;
  if (installed) return true;
  // A stale icon reports standalone, but it is the wrong install.
  if (launchedFromStaleIcon()) return false;
  return isStandalone();
}

/** True when there is an install action to offer (native prompt, iOS guide, or the
 * stale-icon / reinstall guidance). */
export function canInstall(): boolean {
  if (isInstalled()) return false;
  return deferred !== null || isIosSafari() || launchMode() !== "normal";
}

/** Subscribe to install-availability changes (for the ⋯ menu). */
export function onInstallChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Trigger installation: the native prompt where available, else an iOS guide. */
export async function promptInstall(): Promise<void> {
  if (deferred) {
    const evt = deferred;
    deferred = null; // a prompt can only be used once
    notify();
    dismissBanner();
    try {
      await evt.prompt();
      await evt.userChoice;
    } catch {
      /* user dismissed or the prompt was already consumed */
    }
    return;
  }
  if (isIosSafari()) {
    showIosSheet();
    return;
  }
  const mode = launchMode();
  if (mode === "stale") {
    if (isAndroid()) {
      openInChrome();
      return;
    }
    toast(`Open ${location.host}${location.pathname} in your browser and install it there. Then remove the old icon.`, { ms: 6000 });
    return;
  }
  if (mode === "reinstall") {
    toast("Tap ⋮ → “Install app” (or “Add to Home screen”), then remove the old Splanc icon.", { ms: 6000 });
    return;
  }
  toast("To install, use your browser's “Install app” / “Add to Home screen”.");
}

/** Wire up service worker + install events, and offer the first-load banner. */
export function initPwa(): void {
  // Inside the native wrapper there's nothing to install and no service worker to
  // register (assets are bundled in the app) — skip the entire PWA path. Without
  // this, isIosSafari() is true in the iOS WKWebView and the "Add to Home Screen"
  // banner would show inside the already-native app.
  if (isNativePlatform()) return;

  registerServiceWorker();

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep the default mini-infobar from showing
    deferred = e as BeforeInstallPromptEvent;
    notify();
    maybeShowBanner();
  });

  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    writeStore(DISMISS_KEY, "1");
    dismissBanner();
    notify();
    toast("Splanc installed");
  });

  // iOS never fires beforeinstallprompt, and neither does a stale icon's window —
  // offer the banner directly, after the first paint so it doesn't compete with
  // startup.
  if ((isIosSafari() || launchMode() !== "normal") && !isInstalled()) {
    setTimeout(maybeShowBanner, 1200);
  }
}

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:") return; // SW needs a secure context
  window.addEventListener("load", () => {
    // Resolve sw.js against the document so it registers at the deploy root and
    // its default scope covers exactly this deployment — whether served from an
    // origin root or a subpath (GitHub Pages project site + per-PR previews). A
    // leading "/sw.js" would try to control the whole origin, which on Pages is
    // shared across the main site and every preview.
    navigator.serviceWorker.register(new URL("sw.js", document.baseURI)).catch(() => {});
  });
}

// -- first-load banner --------------------------------------------------------

let bannerEl: HTMLElement | null = null;

function staleSnoozed(): boolean {
  const at = Number(readStore(STALE_DISMISS_KEY));
  return Number.isFinite(at) && at > 0 && Date.now() - at < STALE_SNOOZE_MS;
}

/** Show the install / stale-icon banner if it is due (initPwa calls this after
 * the first paint; exported for tests). */
export function maybeShowBanner(): void {
  if (bannerEl || isInstalled()) return;
  const mode = launchMode();
  // Each mode has its own gate: an old icon (or the tab opened to replace it) is
  // worth raising even after the plain install banner was dismissed for good.
  if (mode === "stale") {
    if (staleSnoozed()) return;
  } else if (mode === "normal") {
    if (readStore(DISMISS_KEY) === "1" || !canInstall()) return;
  }
  bannerEl = buildBanner(mode);
  document.body.appendChild(bannerEl);
  requestAnimationFrame(() => bannerEl?.classList.add("pwa-banner--in"));
}

function dismissBanner(persist = false): void {
  if (persist) {
    const mode = launchMode();
    // The reinstall tab's banner only closes; the URL tag ends with the tab.
    if (mode === "stale") writeStore(STALE_DISMISS_KEY, String(Date.now()));
    else if (mode === "normal") writeStore(DISMISS_KEY, "1");
  }
  const el = bannerEl;
  bannerEl = null;
  if (!el) return;
  el.classList.remove("pwa-banner--in");
  setTimeout(() => el.remove(), 200);
}

function buildBanner(mode: LaunchMode): HTMLElement {
  const stale = mode === "stale";
  const wrap = document.createElement("div");
  wrap.className = "pwa-banner";
  if (stale) wrap.classList.add("pwa-banner--stale");
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-label", "Install Splanc");

  const img = document.createElement("img");
  img.className = "pwa-banner-icon";
  // Relative so it resolves against the document at any deploy base (root or a
  // GitHub Pages subpath); a bare <img> src resolves against document.baseURI.
  img.src = "icons/app-icon.svg";
  img.alt = "";
  img.width = 40;
  img.height = 40;

  const text = document.createElement("div");
  text.className = "pwa-banner-text";
  const title = document.createElement("div");
  title.className = "pwa-banner-title";
  title.textContent = stale ? "This icon is out of date" : mode === "reinstall" ? "Install Splanc again" : "Install Splanc";
  const sub = document.createElement("div");
  sub.className = "pwa-banner-sub";
  const escape = stale && isAndroid() && deferred === null;
  sub.textContent = stale
    ? escape
      ? "It was installed from Splanc's old address, so Splanc opens under a browser bar and can't install here. " +
        "Open Splanc in Chrome and install it from there, then remove this old icon from your home screen. " +
        "If Chrome doesn't open, use ⋮ → “Open in Chrome”."
      : "It was installed from Splanc's old address, so Splanc opens under a browser bar. " +
        "Install it again from this address, then remove the old icon."
    : mode === "reinstall"
      ? "Install Splanc from this address (⋮ → “Install app”), then remove the old Splanc icon from your home screen."
      : isIosSafari()
        ? "Add to your home screen for a full-screen app."
        : "Add it to your home screen for quick, full-screen access.";
  text.append(title, sub);

  const actions = document.createElement("div");
  actions.className = "pwa-banner-actions";
  const installBtn = Button({
    label: escape ? "Open in Chrome" : isIosSafari() ? "How" : "Install",
    variant: "primary",
    onClick: () => {
      void promptInstall();
    },
  });
  const closeBtn = IconButton("close", {
    title: "Dismiss",
    onClick: () => dismissBanner(true),
  });
  actions.append(installBtn, closeBtn);

  wrap.append(img, text, actions);
  return wrap;
}

// -- iOS "Add to Home Screen" guide ------------------------------------------

function showIosSheet(): void {
  const sheet = Sheet("Install Splanc");
  const p = document.createElement("p");
  p.className = "pwa-ios-lead";
  p.textContent = "iOS installs web apps from Safari's Share menu:";
  const ol = document.createElement("ol");
  ol.className = "pwa-ios-steps";
  for (const step of [
    "Tap the Share button in Safari's toolbar.",
    "Choose “Add to Home Screen”.",
    "Tap “Add” — Splanc appears on your home screen.",
  ]) {
    const li = document.createElement("li");
    li.textContent = step;
    ol.appendChild(li);
  }
  const done = Button({
    label: "Got it",
    variant: "primary",
    block: true,
    onClick: () => sheet.close(),
  });
  sheet.body.append(p, ol, done);
}

/** Build the ⋯-menu "Install app" item. Returns null when nothing to offer. */
export function installMenuItem(onPick: () => void): HTMLButtonElement | null {
  if (!canInstall()) return null;
  const item = document.createElement("button");
  item.type = "button";
  item.className = "appbar-menu-item";
  item.append(icon("download"));
  const span = document.createElement("span");
  span.textContent = "Install app";
  item.appendChild(span);
  item.addEventListener("click", () => {
    onPick();
    void promptInstall();
  });
  return item;
}
