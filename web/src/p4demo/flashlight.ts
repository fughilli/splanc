/**
 * The stylus as a flashlight: a port of the desktop demo's flashlight.py (its
 * `Flashlight` class and the stylus gate of its `Driver`), for flashlight_pose.glsl.
 *
 * A cone of light leaves the stylus tip along the stylus axis. The stylus button
 * cycles five roll modes; rolling the stylus about its own axis then adjusts that
 * mode's setting, and only the roll counts (pointing the stylus around changes nothing
 * but where the beam goes):
 *   color        one turn = once round the hue wheel
 *   saturation   one turn = white to full colour
 *   width        one turn = x ROLL_FACTOR on the half-angle (2 to 60 degrees)
 *   persistence  one turn = x ROLL_FACTOR on the trail's time constant (off at the short end)
 *   fixed        rolling does nothing
 *
 * Stylus validity goes to the effect as /stylus_ok and a heartbeat, /stylus_seq, that
 * changes with every new pose: the effect drops the beam by itself when the heartbeat
 * stops for /stale_after seconds, so a dead page or network also drops it.
 */

import type { Vec3 } from "./lh/types";
import { add, matToQuat, mulMM, mulMV, norm, normalize, transpose, type Mat3, type Pose } from "./frames";

export const ROLL_MODES = ["color", "saturation", "width", "persistence", "fixed"] as const;
export type RollMode = (typeof ROLL_MODES)[number];
export const ROLL_MODE_LABELS: Record<RollMode, string> = {
  color: "Colour",
  saturation: "Saturation",
  width: "Width",
  persistence: "Trail",
  fixed: "Fixed",
};

export const WIDTH_MIN = (2 * Math.PI) / 180;
export const WIDTH_MAX = (60 * Math.PI) / 180;
/** s; at DECAY_OFF the trail is sent as 0 (none). */
export const DECAY_OFF = 0.05;
export const DECAY_MAX = 20;
/** One full turn multiplies (or divides) the width or the decay by this. */
export const ROLL_FACTOR = 3;
/** s: a stylus pose older than this is stale (beam off). */
export const STALE_S = 0.5;
/** /stylus_seq counts 1..SEQ_WRAP (exact in a float, never the effect's initial 0). */
export const SEQ_WRAP = 999;

export interface BeamState {
  hue: number; // 0..1
  sat: number; // 0..1
  /** half-angle, rad */
  width: number;
  /** trail time constant, s (DECAY_OFF = none) */
  decay: number;
  roll: RollMode;
  /** beam apex and axis, world */
  origin: Vec3;
  dir: Vec3;
  /** the stylus pose is fresh (/stylus_ok) */
  ok: boolean;
  seq: number;
}

export function initialBeam(): BeamState {
  return {
    hue: 0.1,
    sat: 1,
    width: (12 * Math.PI) / 180,
    decay: DECAY_OFF,
    roll: "color",
    origin: [0, 0, 2],
    dir: [0, 0, -1],
    ok: false,
    seq: 0,
  };
}

/** The button: on to the next roll mode. */
export function nextRollMode(m: RollMode): RollMode {
  return ROLL_MODES[(ROLL_MODES.indexOf(m) + 1) % ROLL_MODES.length]!;
}

export function hsvToRgb(h: number, s: number, v: number): Vec3 {
  const hh = (((h % 1) + 1) % 1) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const table: Vec3[] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ];
  return table[i % 6]!;
}

export function beamColor(b: BeamState): Vec3 {
  return hsvToRgb(b.hue, b.sat, 1);
}

/** The trail time constant for the effect: 0 (none) at the short end. */
export function decaySent(b: BeamState): number {
  return b.decay <= DECAY_OFF * 1.0001 ? 0 : b.decay;
}

/** The rotation angle of R about `axis` (unit, R's own frame): the twist of its
 * swing-twist decomposition, in (-pi, pi]. */
export function twistAbout(R: Mat3, axis: Vec3): number {
  const q = matToQuat(R); // w >= 0
  return 2 * Math.atan2(q[1] * axis[0] + q[2] * axis[1] + q[3] * axis[2], q[0]);
}

/** The stylus axis in its own frame: tracker origin -> tip (+Z without a tip yet). */
export function stylusAxis(tipS: Vec3 | null): Vec3 {
  return tipS && norm(tipS) > 1e-6 ? normalize(tipS) : [0, 0, 1];
}

/**
 * A new (fresh) stylus pose: applies the roll since `prevR` to the roll mode's
 * setting, moves the beam to the tip, and bumps the heartbeat. Returns the rotation
 * to pass as `prevR` next time; pass null after a gap, so a gap never counts as a roll.
 */
export function beamFromStylus(b: BeamState, prevR: Mat3 | null, stylus: Pose, tipS: Vec3 | null): Mat3 {
  const axis = stylusAxis(tipS);
  if (prevR) {
    const turns = twistAbout(mulMM(transpose(prevR), stylus.R), axis) / (2 * Math.PI);
    const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);
    if (b.roll === "color") b.hue = (((b.hue + turns) % 1) + 1) % 1;
    else if (b.roll === "saturation") b.sat = clamp(b.sat + turns, 0, 1);
    else if (b.roll === "width") b.width = clamp(b.width * ROLL_FACTOR ** turns, WIDTH_MIN, WIDTH_MAX);
    else if (b.roll === "persistence") b.decay = clamp(b.decay * ROLL_FACTOR ** turns, DECAY_OFF, DECAY_MAX);
  }
  b.origin = add(mulMV(stylus.R, tipS ?? [0, 0, 0]), stylus.t);
  b.dir = normalize(mulMV(stylus.R, axis));
  b.seq = (b.seq % SEQ_WRAP) + 1;
  b.ok = true;
  return [...stylus.R] as Mat3;
}
