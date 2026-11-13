/**
 * Grabbing the demo's virtual objects with the stylus: the plane, the sphere and the
 * hot spots. While an object is grabbed it moves rigidly with the stylus (it keeps
 * the place and tilt it had in the stylus's frame when it was grabbed), so it can be
 * carried, turned and set down anywhere in the room.
 *
 * The stylus button works two ways (ClickOrHold): a short click picks an object up and
 * the next click sets it down, or hold the button, move, and let go. Short clicks are
 * the safe default: a Vive tracker's own (system) button turns the tracker off when
 * it's held for a few seconds.
 */

import type { Vec3 } from "./lh/types";
import { add, dot, mulMV, norm, normalize, scale, sub, transpose, type Pose } from "./frames";
import type { DemoState } from "./demo";

/** m: how near the stylus tip has to be to an object to grab it. */
export const GRAB_REACH = 0.12;
/** ms: a press held at least this long is a hold (letting go drops); shorter is a click. */
export const HOLD_MS = 350;

export type GrabTarget = { kind: "plane" } | { kind: "sphere" } | { kind: "spot"; index: number };

export interface Grab {
  target: GrabTarget;
  /** The object's anchor point in the stylus frame. */
  pS: Vec3;
  /** The plane's normal in the stylus frame. */
  nS?: Vec3;
}

const toStylus = (P: Pose, x: Vec3): Vec3 => mulMV(transpose(P.R), sub(x, P.t));

/** The object the tip can grab now (the mode's shape, or the nearest placed spot),
 * with how far the tip is from it; null when nothing is within `reach`. */
export function reachable(s: DemoState, tip: Vec3, reach = GRAB_REACH): { target: GrabTarget; dist: number } | null {
  if (s.mode === "plane") {
    const dist = Math.abs(dot(s.plane.n, tip) - s.plane.d);
    return dist <= reach ? { target: { kind: "plane" }, dist } : null;
  }
  if (s.mode === "sphere") {
    // Anywhere inside the sphere counts, and a margin outside its surface.
    const dist = Math.max(0, norm(sub(tip, s.sphere.c)) - s.radius);
    return dist <= reach ? { target: { kind: "sphere" }, dist } : null;
  }
  if (s.mode === "spots") {
    let best: { target: GrabTarget; dist: number } | null = null;
    s.spots.forEach((sp, index) => {
      if (!sp.pos) return;
      const dist = norm(sub(tip, sp.pos));
      if (dist <= Math.max(reach, s.spotRadius) && (!best || dist < best.dist)) best = { target: { kind: "spot", index }, dist };
    });
    return best;
  }
  return null;
}

/** Grab what's in reach of the tip; null when nothing is. */
export function beginGrab(s: DemoState, stylus: Pose, tip: Vec3, reach = GRAB_REACH): Grab | null {
  const hit = reachable(s, tip, reach);
  if (!hit) return null;
  const t = hit.target;
  if (t.kind === "plane") {
    // Anchor: the plane's point nearest the tip.
    const n = normalize(s.plane.n);
    const p = sub(tip, scale(n, dot(n, tip) - s.plane.d));
    return { target: t, pS: toStylus(stylus, p), nS: mulMV(transpose(stylus.R), n) };
  }
  if (t.kind === "sphere") return { target: t, pS: toStylus(stylus, s.sphere.c) };
  return { target: t, pS: toStylus(stylus, s.spots[t.index]!.pos!) };
}

/** Carry the grabbed object to where the stylus is now. */
export function moveGrab(s: DemoState, g: Grab, stylus: Pose): void {
  const p = add(mulMV(stylus.R, g.pS), stylus.t);
  if (g.target.kind === "plane") {
    const n = normalize(mulMV(stylus.R, g.nS ?? [0, 0, 1]));
    s.plane = { n, d: dot(n, p) };
  } else if (g.target.kind === "sphere") {
    s.sphere = { c: p, r: s.radius };
  } else {
    const sp = s.spots[g.target.index];
    if (sp) sp.pos = p;
  }
}

export function grabLabel(t: GrabTarget): string {
  return t.kind === "spot" ? `spot ${t.index + 1}` : `the ${t.kind}`;
}

/**
 * One button, two gestures. `down(now, holding)` says what a press does: "drop" when
 * something is in hand, else "take". `up(now, holding)` says "drop" when this press
 * took something and was held for HOLD_MS or longer (a hold-and-carry); after a
 * short click the object stays in hand until the next press.
 */
export class ClickOrHold {
  private downAt: number | null = null;
  private took = false;

  down(now: number, holding: boolean): "take" | "drop" {
    this.downAt = now;
    this.took = !holding;
    return holding ? "drop" : "take";
  }

  up(now: number, holding: boolean): "drop" | null {
    const held = this.downAt !== null ? now - this.downAt : 0;
    const drop = this.took && holding && held >= HOLD_MS;
    this.downAt = null;
    this.took = false;
    return drop ? "drop" : null;
  }
}
