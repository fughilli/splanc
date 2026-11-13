/**
 * Lighthouse (Vive) tracking in the page: the interface the P4 demo page builds
 * against. `createWebHidTracking()` (webhid.ts) implements it over WebHID and the
 * wasm build of @lighthouse's lh_device + lh_kernel (//web/lh_wasm).
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // w, x, y, z

export interface LhPose {
  serial: string;
  /** performance.now() ms: when the pose was true (its newest IMU sample, on the page's clock). */
  t: number;
  /** m, lhd world, +Z up. The tracker's head frame. */
  pos: Vec3;
  quat: Quat;
  /** Locked or coasting (a pose to follow). */
  ok: boolean;
}

/** world <- station */
export interface LhStation {
  id: number;
  pos: Vec3;
  quat: Quat;
}

export interface LhStatus {
  state: "disconnected" | "connecting" | "no-tracker" | "calibrating" | "tracking" | "lost";
  detail?: string;
}

export interface LhTracking {
  /** navigator.hid.requestDevice (Valve 0x28de: 0x2101/0x2102/0x2300/0x2022) under a user gesture, then handshake. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onPose(cb: (p: LhPose) => void): () => void;
  onStations(cb: (s: LhStation[]) => void): () => void;
  onStatus(cb: (s: LhStatus) => void): () => void;
  /** A device's held buttons changed: `mask` has one bit per held button (libsurvive's
   * ids: 0 trigger, 1 trackpad, 3 system, 6 menu, 7 grip); 0 = all released. */
  onButtons(cb: (serial: string, mask: number) => void): () => void;
  stations(): LhStation[];
  /** JSON compatible with lhd's calibration.json. */
  exportCalibration(): string;
  importCalibration(json: string): void;
  /** Forget stations, calibrate from still scenes again. */
  recalibrate(): void;
}
