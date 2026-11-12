/**
 * THE one place the P4 demo page picks its tracking implementation: the stylus over
 * WebHID (lhd compiled to wasm, webhid.ts), or a synthetic stylus with `?mock=1`
 * (mock.ts). See types.ts for the interface.
 */

import { createMockTracking, type MockTracking } from "./mock";
import type { LhTracking } from "./types";
import { createWebHidTracking } from "./webhid";

export type { LhPose, LhStation, LhStatus, LhTracking, Quat, Vec3 } from "./types";
export { createWebHidTracking, webHidUnavailable } from "./webhid";

export interface TrackingChoice {
  tracking: LhTracking;
  mock: MockTracking | null;
}

export function createTracking(opts: { mock: boolean }): TrackingChoice {
  if (opts.mock) {
    const m = createMockTracking();
    return { tracking: m, mock: m };
  }
  return { tracking: createWebHidTracking(), mock: null };
}
