/**
 * New-fixture watcher (D-259). On each fresh connection:
 *
 *  1. A name typed while flashing or setting up the fixture (store/newFixture.ts
 *     pendingName) is pushed to it, if this is that fixture (by MAC from the
 *     flasher, or the next fixture within the window).
 *  2. A fixture with no stored map that hasn't been offered setup yet opens the
 *     new-fixture flow (#/new-fixture: name, LED count, colour order), unless the
 *     user is busy somewhere that owns the screen.
 */

import { appState } from "./state";
import type { Router } from "./router";
import { deviceStore } from "../../store/deviceStore";
import { pendingMatches, pendingName, setupSeen, shouldOfferSetup } from "../../store/newFixture";
import type { LedMapperClient } from "../../net/client";

/** True when the fixture has no stored map; null when it can't tell. */
async function fixtureHasNoMap(c: LedMapperClient): Promise<boolean | null> {
  try {
    const r = await c.peekStoredMap(16, 6000);
    return r.totalLen <= 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    const text = e instanceof Error ? e.message : String(e);
    if (code === "no_map" || /no stored map|no_map/i.test(text)) return true;
    return null; // old firmware, timeout: don't guess
  }
}

export function installNewFixtureWatch(router: Router): () => void {
  let handled: unknown = null;
  return appState.subscribe(() => {
    const c = appState.client;
    if (!c || appState.status.state !== "connected" || !c.welcome || handled === c) return;
    handled = c;
    void (async () => {
      const devId = deviceStore.activeId();
      const w = c.welcome!;
      // 1. A name waiting for this fixture.
      const p = pendingName.get();
      if (devId && pendingMatches(p, w.mac, Date.now())) {
        pendingName.clear();
        if (p!.name !== w.deviceName) {
          deviceStore.rename(devId, p!.name);
          try {
            const nw = await c.setDeviceName(p!.name);
            deviceStore.applyWelcome(devId, { mac: nw.mac, deviceName: nw.deviceName });
            deviceStore.takePending(devId);
          } catch {
            // stays queued on the record: applied at the next connection
          }
        }
      }
      // 2. A brand-new fixture: offer setup once.
      if (!devId || setupSeen.has(devId)) return;
      const noMap = await fixtureHasNoMap(c);
      const route = location.hash.replace(/^#/, "");
      if (appState.client !== c) return;
      if (shouldOfferSetup({ deviceId: devId, hasMap: noMap === null ? null : !noMap, seen: setupSeen.has(devId), route })) {
        router.navigate("/new-fixture");
      }
    })();
  });
}
