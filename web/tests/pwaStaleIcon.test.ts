/**
 * Stale home-screen icons (src/ui/app/pwa.ts): an icon installed from the retired
 * splanc.pages.dev opens splanc.io/app inside its own window, which reports
 * display-mode standalone yet cannot install. These pin how the app tells that
 * launch apart from a real install, the Chrome intent escape, the stale banner's
 * own dismiss gate (back after a day), and the ⋯ "Install app" item.
 */

import "./moduleStubs";

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { fire, installFakeDom, type FakeElement } from "./fakeDom";

const dom = installFakeDom();

import {
  STALE_SNOOZE_MS,
  canInstall,
  chromeIntentUrl,
  installMenuItem,
  isInstalled,
  launchMode,
  maybeShowBanner,
} from "../src/ui/app/pwa";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

interface FakeLocation {
  protocol: string;
  host: string;
  pathname: string;
  search: string;
  hash: string;
  href: string;
}

let loc: FakeLocation;

/** Put the page at https://splanc.io/app/<search>, in a standalone window or not. */
function at(search: string, opts: { standalone?: boolean; ua?: string } = {}): void {
  loc = { protocol: "https:", host: "splanc.io", pathname: "/app/", search, hash: "", href: `https://splanc.io/app/${search}` };
  Object.defineProperty(globalThis, "location", { value: loc, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: opts.ua ?? ANDROID_UA, platform: "Linux armv8l", maxTouchPoints: 5 },
    configurable: true,
    writable: true,
  });
  dom.window.mediaMatcher = (q) => !!opts.standalone && q === "(display-mode: standalone)";
}

function banner(): FakeElement | null {
  return dom.document.body.querySelector(".pwa-banner") as FakeElement | null;
}

/** Close the banner with its X (as a user would). */
function closeBanner(): void {
  const b = banner();
  assert.ok(b, "a banner to close");
  fire(b.querySelector('[aria-label="Dismiss"]') as FakeElement, "click");
  b.remove();
}

beforeEach(() => {
  localStorage.clear();
  banner()?.remove();
});

test("launch mode: the retired-origin tag or a non-standalone start_url launch is a stale icon", () => {
  at("?source=pwa&retired=1", { standalone: true });
  assert.equal(launchMode(), "stale", "pages.dev icon window reports standalone");
  at("?source=pwa", { standalone: false });
  assert.equal(launchMode(), "stale", "start_url opened under a browser bar");
  at("?reinstall=1", { standalone: true });
  assert.equal(launchMode(), "stale", "the Chrome intent was kept in the old window");
  at("?reinstall=1", { standalone: false });
  assert.equal(launchMode(), "reinstall");
  at("?source=pwa", { standalone: true });
  assert.equal(launchMode(), "normal", "a real install of this address");
  at("", { standalone: false });
  assert.equal(launchMode(), "normal");
});

test("chromeIntentUrl opens this host/path in Chrome, drops the launch tags, falls back to https", () => {
  assert.equal(
    chromeIntentUrl({ protocol: "https:", host: "splanc.io", pathname: "/app/", search: "?source=pwa&retired=1" }),
    "intent://splanc.io/app/?reinstall=1#Intent;scheme=https;package=com.android.chrome;" +
      "S.browser_fallback_url=https%3A%2F%2Fsplanc.io%2Fapp%2F%3Freinstall%3D1;end",
  );
  // Built from the location: any host/path, other query params kept.
  assert.equal(
    chromeIntentUrl({ protocol: "https:", host: "preview.example:8443", pathname: "/pr-7/", search: "?source=pwa&url=wss%3A%2F%2F10.0.0.5%2Fws" }),
    "intent://preview.example:8443/pr-7/?url=wss%3A%2F%2F10.0.0.5%2Fws&reinstall=1#Intent;scheme=https;package=com.android.chrome;" +
      "S.browser_fallback_url=" +
      encodeURIComponent("https://preview.example:8443/pr-7/?url=wss%3A%2F%2F10.0.0.5%2Fws&reinstall=1") +
      ";end",
  );
});

test("stale icon on Android: not 'installed', ⋯ Install app opens the page in Chrome", () => {
  at("?source=pwa&retired=1", { standalone: true });
  assert.equal(isInstalled(), false, "standalone, but the wrong install");
  assert.equal(canInstall(), true, "no beforeinstallprompt here, still installable via Chrome");
  let picked = false;
  const item = installMenuItem(() => (picked = true));
  assert.ok(item, "the ⋯ menu offers Install app");
  fire(item, "click");
  assert.ok(picked);
  assert.equal(loc.href, chromeIntentUrl(loc));
  assert.match(loc.href, /^intent:\/\/splanc\.io\/app\/\?reinstall=1#Intent;/);
});

test("a real install of this address offers nothing", () => {
  at("?source=pwa", { standalone: true });
  assert.equal(isInstalled(), true);
  assert.equal(canInstall(), false);
  assert.equal(installMenuItem(() => {}), null);
  maybeShowBanner();
  assert.equal(banner(), null);
});

test("stale banner ignores the install banner's dismissal and escapes to Chrome", () => {
  localStorage.setItem("pwa.install.dismissed", "1");
  at("?source=pwa&retired=1", { standalone: true });
  maybeShowBanner();
  const b = banner();
  assert.ok(b, "the old dismissal must not hide the stale-icon banner");
  assert.ok(b.classList.contains("pwa-banner--stale"));
  assert.match(b.textContent ?? "", /old address/);
  assert.match(b.textContent ?? "", /remove this old icon/);
  const open = b.querySelector(".k-btn") as FakeElement;
  assert.equal(open.textContent, "Open in Chrome");
  fire(open, "click");
  assert.equal(loc.href, chromeIntentUrl(loc));
  closeBanner();
});

test("dismissing the stale banner snoozes it for a day, then it comes back", () => {
  at("?source=pwa&retired=1", { standalone: true });
  maybeShowBanner();
  closeBanner();
  assert.equal(localStorage.getItem("pwa.install.dismissed"), null, "own dismiss key");
  const at0 = Number(localStorage.getItem("pwa.staleIcon.dismissed"));
  assert.ok(Math.abs(Date.now() - at0) < 5000, "stores the dismissal time");

  maybeShowBanner();
  assert.equal(banner(), null, "snoozed on the next launch the same day");

  localStorage.setItem("pwa.staleIcon.dismissed", String(Date.now() - STALE_SNOOZE_MS - 1));
  maybeShowBanner();
  assert.ok(banner(), "back after a day");
  closeBanner();

  // A pre-timestamp value ("1") does not hide it for good.
  localStorage.setItem("pwa.staleIcon.dismissed", "1");
  maybeShowBanner();
  assert.ok(banner());
  closeBanner();
});

test("the reinstall tab in Chrome offers the install even after an old dismissal", () => {
  localStorage.setItem("pwa.install.dismissed", "1");
  at("?reinstall=1", { standalone: false });
  assert.equal(isInstalled(), false);
  assert.ok(installMenuItem(() => {}), "⋯ Install app is there before beforeinstallprompt");
  maybeShowBanner();
  const b = banner();
  assert.ok(b);
  assert.match(b.textContent ?? "", /remove the old Splanc icon/);
  closeBanner();
  assert.equal(localStorage.getItem("pwa.staleIcon.dismissed"), null);
});
