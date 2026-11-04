/**
 * PWA install controller — makes the app installable and drives the install UX:
 *   - registers the service worker (public/sw.js) on a secure origin;
 *   - captures the Chromium `beforeinstallprompt` so we can trigger the native
 *     install prompt on demand;
 *   - shows a dismissible install banner on first load, then (after dismissal or
 *     install) leaves the install action reachable from the app-bar ⋯ menu;
 *   - handles iOS Safari, which has no install prompt — there the action opens a
 *     short "Add to Home Screen" instruction sheet.
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
const STALE_DISMISS_KEY = "pwa.staleIcon.dismissed";

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

/**
 * Opened from a home-screen icon (the manifest's start_url carries ?source=pwa) but
 * not running as an installed app. The icon then belongs to an install made from
 * another address, such as the retired splanc.pages.dev, which now redirects here:
 * Android shows the page under a browser bar, and its X closes the app. The fix is
 * to install again from this address and remove the old icon.
 */
function launchedFromStaleIcon(): boolean {
  return new URLSearchParams(location.search).get("source") === "pwa" && !isStandalone();
}

/** True when the app is already running as an installed PWA. */
export function isInstalled(): boolean {
  // The Capacitor native wrapper IS the installed app — treat it as installed so
  // no install UX is ever offered (canInstall/menu item/banner all gate on this).
  if (isNativePlatform()) return true;
  return installed || isStandalone();
}

/** True when there is an install action to offer (native prompt or iOS guide). */
export function canInstall(): boolean {
  if (isInstalled()) return false;
  return deferred !== null || isIosSafari();
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
  if (launchedFromStaleIcon()) {
    toast("Open splanc.io/app in Chrome, then ⋮ → “Install app”. Then remove the old icon.");
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
    localStorage.setItem(DISMISS_KEY, "1");
    dismissBanner();
    notify();
    toast("Splanc installed");
  });

  // iOS never fires beforeinstallprompt — offer the banner directly, after the
  // first paint so it doesn't compete with startup.
  if ((isIosSafari() || launchedFromStaleIcon()) && !isInstalled()) {
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

function maybeShowBanner(): void {
  if (bannerEl || isInstalled()) return;
  const stale = launchedFromStaleIcon();
  // An old icon is worth raising even after the plain install banner was dismissed.
  if (localStorage.getItem(stale ? STALE_DISMISS_KEY : DISMISS_KEY) === "1") return;
  if (!stale && !canInstall()) return;
  bannerEl = buildBanner(stale);
  document.body.appendChild(bannerEl);
  requestAnimationFrame(() => bannerEl?.classList.add("pwa-banner--in"));
}

function dismissBanner(persist = false): void {
  if (persist) localStorage.setItem(launchedFromStaleIcon() ? STALE_DISMISS_KEY : DISMISS_KEY, "1");
  const el = bannerEl;
  bannerEl = null;
  if (!el) return;
  el.classList.remove("pwa-banner--in");
  setTimeout(() => el.remove(), 200);
}

function buildBanner(stale: boolean): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "pwa-banner";
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
  title.textContent = stale ? "Reinstall Splanc" : "Install Splanc";
  const sub = document.createElement("div");
  sub.className = "pwa-banner-sub";
  sub.textContent = stale
    ? "This icon is from Splanc's old address, so it opens with a browser bar. Install again, then remove the old icon."
    : isIosSafari()
      ? "Add to your home screen for a full-screen app."
      : "Add it to your home screen for quick, full-screen access.";
  text.append(title, sub);

  const actions = document.createElement("div");
  actions.className = "pwa-banner-actions";
  const installBtn = Button({
    label: isIosSafari() ? "How" : "Install",
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
