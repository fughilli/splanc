/**
 * Play-mode session context: the fixture the visitor came for (QR `f=`), the
 * in-flight connect, and "are we in play mode" — so Acid Mode (`#/acid?play=1`)
 * and the back path keep the context, and the app skips the splash, the tour
 * hint and onboarding when it was opened straight into play mode.
 */

import { connectHalloweenFixture, isChooserCancel, type HalloweenConnection } from "../net/halloweenConnect";

export const PLAY_PATH = "/play";
const FIXTURE_KEY = "splanc.play.fixture";

/** `#/play` hash path for an optional fixture name. */
export function playRoute(name?: string): string {
  return name ? `${PLAY_PATH}?f=${encodeURIComponent(name)}` : PLAY_PATH;
}

/** True when a location hash is play mode or a route entered from it (`?play=1`). */
export function isPlayHash(hash: string): boolean {
  const raw = hash.replace(/^#/, "");
  const [path, query] = raw.split("?");
  if (path === PLAY_PATH) return true;
  return new URLSearchParams(query ?? "").get("play") === "1";
}

function session(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** Remember the fixture for this tab (survives #/acid and back, and a reload). */
export function rememberFixture(name: string | undefined): void {
  try {
    if (name) session()?.setItem(FIXTURE_KEY, name);
  } catch {
    // private mode: in-memory only
  }
}

export function rememberedFixture(): string | undefined {
  try {
    return session()?.getItem(FIXTURE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export type ConnectAttempt =
  | { state: "idle" }
  | { state: "picking" }
  | { state: "started"; conn: HalloweenConnection }
  | { state: "cancelled" }
  | { state: "failed"; message: string };

let attempt: ConnectAttempt = { state: "idle" };
const listeners = new Set<() => void>();

export function connectAttempt(): ConnectAttempt {
  return attempt;
}
export function onConnectAttempt(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function set(a: ConnectAttempt): void {
  attempt = a;
  for (const fn of listeners) fn();
}

/**
 * Start a fixture connect. Call SYNCHRONOUSLY from a click handler on the web
 * (the chooser needs the gesture): `connectHalloweenFixture` is the first await.
 */
export function startPlayConnect(name?: string): Promise<void> {
  rememberFixture(name);
  const p = connectHalloweenFixture(name ? { name } : {});
  set({ state: "picking" });
  return p.then(
    (conn) => set({ state: "started", conn }),
    (e: unknown) => {
      if (isChooserCancel(e)) set({ state: "cancelled" });
      else set({ state: "failed", message: e instanceof Error ? e.message : String(e) });
    },
  );
}
