/**
 * Uniform keypoints, app side (docs/design/uniform-keypoints.md). A keypoint is
 * a named set of an effect's uniform values stored ON THE DEVICE; the device
 * blends between them in parameter space. This module is the pure part: feature
 * detection, fader → weight mapping, keypoint navigation and the fader-rate
 * throttle. The DOM lives in ui/screens/keypointStrip.ts.
 */

import type { KeypointInfoFlat, KeypointWeightFlat } from "../net/proto";

/** Whether a device's welcome advertises keypoints (and so decks/blend). */
export function supportsKeypoints(welcome: { features?: string[] } | null | undefined): boolean {
  return (welcome?.features ?? []).includes("keypoints");
}

/** Whether a device's welcome advertises the two FX decks + crossfade. */
export function supportsDecks(welcome: { features?: string[] } | null | undefined): boolean {
  const f = welcome?.features ?? [];
  return f.includes("decks") && f.includes("crossfade");
}

/**
 * A morph fader between keypoints `a` (position 0) and `b` (position 1) as
 * blend weights. The device ignores non-positive weights, so an endpoint sends
 * just that keypoint (exact recall, and toggles/dropdowns snap there).
 */
export function morphWeights(position: number, a: string, b: string): KeypointWeightFlat[] {
  const t = Math.min(1, Math.max(0, Number.isFinite(position) ? position : 0));
  if (a === b || t <= 0) return [{ name: a, weight: 1 }];
  if (t >= 1) return [{ name: b, weight: 1 }];
  return [
    { name: a, weight: 1 - t },
    { name: b, weight: t },
  ];
}

/** The keypoint `delta` steps from `current` in storage order (wrapping); the
 * first one when `current` isn't in the list. Null for an empty list. */
export function stepKeypoint(list: KeypointInfoFlat[], current: string | null, delta: number): string | null {
  if (list.length === 0) return null;
  const sorted = [...list].sort((x, y) => x.index - y.index);
  const i = sorted.findIndex((k) => k.name === current);
  if (i < 0) return sorted[0]!.name;
  const n = sorted.length;
  return sorted[(((i + delta) % n) + n) % n]!.name;
}

/** A valid new keypoint name: 1..32 bytes (UTF-8), trimmed. */
export function validKeypointName(name: string): string | null {
  const t = name.trim();
  if (t.length === 0) return null;
  return new TextEncoder().encode(t).length <= 32 ? t : null;
}

/** The next free default name ("Look 1", "Look 2", …). */
export function defaultKeypointName(list: KeypointInfoFlat[]): string {
  const taken = new Set(list.map((k) => k.name));
  for (let i = 1; ; i++) {
    const n = `Look ${i}`;
    if (!taken.has(n)) return n;
  }
}

type Timer = (fn: () => void, ms: number) => unknown;

/**
 * Coalesces a fast control (fader drag, MIDI CC at ~100 Hz) into at most one
 * send per `intervalMs`, ALWAYS delivering the final value: the first push goes
 * out at once, later pushes inside the window replace a pending one that is
 * flushed when the window closes. The device applies each blend in order, so
 * this only bounds the wire rate; nothing the user ended on is lost.
 */
export class Throttle<T> {
  private pending: T | null = null;
  private armed = false;

  constructor(
    private readonly send: (v: T) => void,
    private readonly intervalMs = 40,
    private readonly timer: Timer = (fn, ms) => setTimeout(fn, ms),
  ) {}

  push(v: T): void {
    if (this.armed) {
      this.pending = v;
      return;
    }
    this.send(v);
    this.arm();
  }

  private arm(): void {
    this.armed = true;
    this.timer(() => {
      this.armed = false;
      if (this.pending !== null) {
        const v = this.pending;
        this.pending = null;
        this.send(v);
        this.arm();
      }
    }, this.intervalMs);
  }
}
