/**
 * The app's mesh session per connection (mesh M7/M8, M6):
 *
 *  - Unlock on connect: when the app connects to a fixture in a mesh it administers, it signs
 *    a grant for that fixture with the stored admin key and presents it, so mesh control and
 *    administration work at once; and renews it before it runs out while the connection is
 *    the app's.
 *  - Effect sharing: a relayed message too big for one mesh packet goes to every member
 *    through M6 effect sharing (net/meshEffect.ts); `client.submitEffect` takes the
 *    frame-aligned path itself when "Control the whole mesh" is on.
 *  - Per-member results: the last pushed `mesh.result` of the connection (which fixtures
 *    got a change, which didn't), for the Mesh section and a toast when some missed it.
 */

import type { MeshAdminSigner } from "../net/meshKeys";
import { ensureUnlocked, type MeshAdminClient } from "../net/meshAdmin";
import { setMeshLargeSender, type MeshResultInfo, type MeshStateInfo } from "../net/mesh";
import { meshLargeShare } from "../net/meshEffect";
import { meshStore } from "./meshStore";

setMeshLargeSender({
  share: (c, msg) => {
    void meshLargeShare(c, msg)?.catch(() => undefined);
  },
});

/** The admin key for `meshId`, if this app holds it. */
export async function meshSignerLookup(meshId: number): Promise<{ signer: MeshAdminSigner } | null> {
  try {
    if (!(await meshStore.get(meshId))) return null;
    return { signer: await meshStore.signer(meshId) };
  } catch {
    return null;
  }
}

const RENEW_CHECK_MS = 10 * 60 * 1000;

interface ResultClient {
  onMeshResult(fn: (r: MeshResultInfo) => void): () => void;
  readonly meshState: MeshStateInfo | null;
}

const lastResults = new WeakMap<object, MeshResultInfo>();
const resultListeners = new Set<(c: object, r: MeshResultInfo) => void>();

/** The last per-member result pushed on `client` (null: none yet). */
export function lastMeshResult(client: object): MeshResultInfo | null {
  return lastResults.get(client) ?? null;
}

/** Hear every per-member result (the client it came on, and the result). */
export function onMeshResults(fn: (c: object, r: MeshResultInfo) => void): () => void {
  resultListeners.add(fn);
  return () => resultListeners.delete(fn);
}

/** A member's name from this app's roster of the client's mesh. */
export function meshMemberName(client: { readonly meshState: MeshStateInfo | null }, node: number): string | null {
  const rec = meshStore.peek(client.meshState?.meshId);
  return rec?.members.find((m) => m.node === node)?.label ?? null;
}

const subscribed = new WeakSet<object>();
const renewing = new WeakSet<object>();

/** Unlock `client` now (quietly; nothing happens for a fixture outside our meshes), keep
 * checking the grant while `isCurrent()`, and collect its per-member results. Call it on
 * every (re)connect, the background ones included: an admin session belongs to one
 * connection, so a reconnected client must unlock again. Subscribing and the renewal loop
 * happen once per client. */
/** "Control the whole mesh", remembered per fixture (by its MAC) so a reconnect or a
 * new app session keeps sending effects and sliders to every member. Unset: on, once
 * the connection is unlocked as a mesh this app administers. */
const MESH_ALL_KEY = "ledmapper.meshAll";
function meshAllPrefs(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(MESH_ALL_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}
export function meshAllPref(mac: string | undefined): boolean {
  return mac ? meshAllPrefs()[mac.toUpperCase()] ?? true : true;
}
export function rememberMeshAll(mac: string | undefined, on: boolean): void {
  if (!mac) return;
  try {
    const p = meshAllPrefs();
    p[mac.toUpperCase()] = on;
    localStorage.setItem(MESH_ALL_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: the switch still works for this connection */
  }
}

interface MeshAllClient {
  readonly welcome?: { mac?: string } | null;
  readonly meshAll?: boolean;
  setMeshAll?(on: boolean): void;
}

export function unlockMeshOnConnect(client: MeshAdminClient & ResultClient & object, isCurrent: () => boolean): void {
  if (!subscribed.has(client)) {
    subscribed.add(client);
    client.onMeshResult((r) => {
      if (!r.members?.length) return;
      lastResults.set(client, r);
      for (const fn of resultListeners) fn(client, r);
    });
  }
  void meshStore.load().catch(() => undefined);
  const once = (): Promise<unknown> =>
    ensureUnlocked(client, meshSignerLookup)
      .then((ok) => {
        // Unlocked as the gateway of a mesh this app administers: route live control
        // the way this fixture was last used (whole mesh unless switched off).
        const c = client as MeshAllClient;
        if (ok && c.setMeshAll && !c.meshAll && meshAllPref(c.welcome?.mac)) c.setMeshAll(true);
        return ok;
      })
      .catch(() => false);
  if (renewing.has(client)) {
    if (isCurrent()) void once();
    return;
  }
  renewing.add(client);
  const run = (): void => {
    if (!isCurrent()) {
      renewing.delete(client);
      return;
    }
    void once().finally(() => {
      if (isCurrent()) setTimeout(run, RENEW_CHECK_MS);
      else renewing.delete(client);
    });
  };
  run();
}
