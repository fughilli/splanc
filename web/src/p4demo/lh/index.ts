/**
 * THE one place the P4 demo page picks its tracking implementation.
 *
 * Today only the mock exists on this branch. The real one, lhd compiled to wasm and
 * driven over WebHID (the stylus through its Watchman dongle), is being built in this
 * directory on a separate branch and exports `createWebHidTracking(): LhTracking`.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────┐
 * │ TODO(webhid-tracking): wire the real tracking in HERE when it lands:             │
 * │   import { createWebHidTracking } from "./webhid";                               │
 * │   ...                                                                            │
 * │   if (!mock) return { tracking: createWebHidTracking(), mock: false };           │
 * │ and drop the "unavailable" stub below. Nothing else in the page needs to change. │
 * └──────────────────────────────────────────────────────────────────────────────────┘
 */

import { createMockTracking, type MockTracking } from "./mock";
import type { LhStatus, LhTracking } from "./types";

export type { LhPose, LhStation, LhStatus, LhTracking, Quat, Vec3 } from "./types";

export interface TrackingChoice {
  tracking: LhTracking;
  mock: MockTracking | null;
}

export function createTracking(opts: { mock: boolean }): TrackingChoice {
  if (opts.mock) {
    const m = createMockTracking();
    return { tracking: m, mock: m };
  }
  // TODO(webhid-tracking): return { tracking: createWebHidTracking(), mock: null };
  return { tracking: unavailableTracking(), mock: null };
}

/** Until the WebHID tracking lands: says so, and points at ?mock=1. */
function unavailableTracking(): LhTracking {
  const status: LhStatus = {
    state: "disconnected",
    detail: "Stylus tracking over USB (WebHID) isn't in this build yet. Add ?mock=1 to the URL for a simulated stylus.",
  };
  return {
    async connect() {
      throw new Error(status.detail);
    },
    async disconnect() {},
    onPose: () => () => {},
    onStations: () => () => {},
    onStatus(cb) {
      cb(status);
      return () => {};
    },
    stations: () => [],
    exportCalibration: () => "{}",
    importCalibration() {
      throw new Error(status.detail);
    },
    recalibrate() {},
  };
}
