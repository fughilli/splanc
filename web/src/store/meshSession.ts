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

/** Unlock `client` now (quietly; nothing happens for a fixture outside our meshes), keep
 * checking the grant while `isCurrent()`, and collect its per-member results. */
export function unlockMeshOnConnect(client: MeshAdminClient & ResultClient & object, isCurrent: () => boolean): void {
  client.onMeshResult((r) => {
    if (!r.members?.length) return;
    lastResults.set(client, r);
    for (const fn of resultListeners) fn(client, r);
  });
  void meshStore.load().catch(() => undefined);
  const run = (): void => {
    if (!isCurrent()) return;
    void ensureUnlocked(client, meshSignerLookup)
      .catch(() => false)
      .finally(() => {
        if (isCurrent()) setTimeout(run, RENEW_CHECK_MS);
      });
  };
  run();
}
