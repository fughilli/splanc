/**
 * The tracking seam of the P4 demo page: where the stylus (a Vive tracker behind a
 * Watchman dongle) and lhd's base stations come from.
 *
 * Two implementations: `createMockTracking()` (./mock.ts, a synthetic stylus and two
 * fake stations, `?mock=1`) and the real one, lhd compiled to wasm over WebHID
 * (`createWebHidTracking()`, built separately in this directory). The page only ever
 * talks to this interface; ./index.ts is the one place that picks an implementation.
 *
 * Frames: lhd's world, metres, +Z up (libsurvive's convention, the same world the
 * P4 tracks in once it has adopted the stations). Quaternions are (w, x, y, z).
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // w, x, y, z

export interface LhPose {
  serial: string;
  t: number /* performance.now() ms */;
  pos: Vec3 /* m, lhd world, +Z up */;
  quat: Quat;
  ok: boolean;
}

export interface LhStation {
  id: number;
  pos: Vec3;
  quat: Quat;
} // world <- station

export interface LhStatus {
  state: "disconnected" | "connecting" | "no-tracker" | "calibrating" | "tracking" | "lost";
  detail?: string;
}

export interface LhTracking {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onPose(cb: (p: LhPose) => void): () => void;
  onStations(cb: (s: LhStation[]) => void): () => void;
  onStatus(cb: (s: LhStatus) => void): () => void;
  stations(): LhStation[];
  exportCalibration(): string;
  importCalibration(json: string): void;
  recalibrate(): void;
}
