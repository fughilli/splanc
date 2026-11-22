/**
 * Unlock on connect (mesh M7/M8): when the app connects to a fixture in a mesh it
 * administers, it signs a grant for that fixture with the stored admin key and presents it,
 * so mesh control ("Control the whole mesh") and administration work at once; and renews it
 * before it runs out for as long as the connection is the app's.
 */

import type { MeshAdminSigner } from "../net/meshKeys";
import { ensureUnlocked, type MeshAdminClient } from "../net/meshAdmin";
import { meshStore } from "./meshStore";

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

/** Unlock `client` now (quietly; nothing happens for a fixture outside our meshes) and keep
 * checking the grant while `isCurrent()`. */
export function unlockMeshOnConnect(client: MeshAdminClient & object, isCurrent: () => boolean): void {
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
