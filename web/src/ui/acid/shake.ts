/**
 * Shake-to-enter detector for Acid Mode (FUG-106) — "vigorously shaking the
 * device from side to side" is one of the two ways in.
 *
 * The detection core (`ShakeDetector`) is pure and DOM-free so it's unit-tested:
 * feed it acceleration samples + timestamps and it reports the single sample
 * that completes a vigorous back-and-forth shake. A shake is modelled as several
 * strong "jolts" (per-sample acceleration deltas above a threshold) whose
 * dominant-axis DIRECTION reverses repeatedly within a short window — i.e. the
 * hand yanking the phone left-right-left-right, not one sharp bump or a smooth
 * tilt. A cooldown stops one shake from firing repeatedly.
 *
 * `installShakeToEnter` wires the core to `devicemotion`, handling the iOS 13+
 * motion-permission gate (request lazily on the first user gesture) and staying
 * a no-op where the sensor/API is absent (desktop) so nothing breaks.
 */

export interface Accel {
  x: number;
  y: number;
  z: number;
}

export interface ShakeOptions {
  /** Per-sample acceleration-delta magnitude (m/s²) that counts as a jolt. */
  joltThreshold?: number;
  /** Direction reversals (within the window) required to call it a shake. */
  minReversals?: number;
  /** Reversals must accrue within this rolling window (ms). */
  windowMs?: number;
  /** Suppress re-firing for this long after a detected shake (ms). */
  cooldownMs?: number;
}

const DEFAULTS: Required<ShakeOptions> = {
  joltThreshold: 14,
  minReversals: 4,
  windowMs: 1000,
  cooldownMs: 2500,
};

interface Jolt {
  t: number;
  sign: number; // +1 / -1 along the delta's dominant axis
}

/** Pure back-and-forth shake detector. Feed it samples in time order. */
export class ShakeDetector {
  private readonly opt: Required<ShakeOptions>;
  private prev: Accel | null = null;
  private jolts: Jolt[] = [];
  private lastFire = -Infinity;

  constructor(options: ShakeOptions = {}) {
    this.opt = { ...DEFAULTS, ...options };
  }

  reset(): void {
    this.prev = null;
    this.jolts = [];
    // Keep lastFire so cooldown survives a reset (e.g. sensor hiccup).
  }

  /**
   * Feed one acceleration sample. Returns true EXACTLY on the sample that
   * completes a vigorous shake (respecting the cooldown), false otherwise.
   */
  update(a: Accel, tMs: number): boolean {
    const prev = this.prev;
    this.prev = a;
    if (prev === null) return false;

    const dx = a.x - prev.x;
    const dy = a.y - prev.y;
    const dz = a.z - prev.z;
    const mag = Math.hypot(dx, dy, dz);
    if (mag < this.opt.joltThreshold) return false;

    // Dominant axis of this jolt → its sign. Side-to-side shaking flips this
    // sign every half-cycle; a single bump or a smooth tilt does not.
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const az = Math.abs(dz);
    const dom = ax >= ay && ax >= az ? dx : ay >= az ? dy : dz;
    const sign = dom >= 0 ? 1 : -1;

    // Drop jolts older than the window, then record this one.
    const cutoff = tMs - this.opt.windowMs;
    this.jolts = this.jolts.filter((j) => j.t >= cutoff);
    this.jolts.push({ t: tMs, sign });

    // Count direction reversals across the retained jolts.
    let reversals = 0;
    for (let i = 1; i < this.jolts.length; i++) {
      if (this.jolts[i]!.sign !== this.jolts[i - 1]!.sign) reversals++;
    }

    if (reversals >= this.opt.minReversals && tMs - this.lastFire >= this.opt.cooldownMs) {
      this.lastFire = tMs;
      this.jolts = [];
      return true;
    }
    return false;
  }
}

type MotionPermission = { requestPermission?: () => Promise<"granted" | "denied" | "default"> };

/**
 * Listen for a vigorous shake and invoke `onShake` when one is detected.
 * Returns an uninstaller. No-op (returns a no-op uninstaller) when DeviceMotion
 * is unavailable. On iOS 13+ the motion-permission prompt is requested lazily on
 * the first user gesture (the only place the browser allows it).
 */
export function installShakeToEnter(
  onShake: () => void,
  options: ShakeOptions = {},
): () => void {
  if (typeof window === "undefined" || typeof window.DeviceMotionEvent === "undefined") {
    return () => undefined;
  }

  const detector = new ShakeDetector(options);
  let disposed = false;

  const onMotion = (ev: DeviceMotionEvent): void => {
    // Prefer gravity-free acceleration; fall back to the with-gravity reading
    // (offset by a steady ~9.8 that our delta-based core cancels out anyway).
    const a = ev.acceleration ?? ev.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null) return;
    const t = typeof ev.timeStamp === "number" ? ev.timeStamp : performance.now();
    if (detector.update({ x: a.x, y: a.y, z: a.z }, t)) onShake();
  };

  const addListener = (): void => {
    if (!disposed) window.addEventListener("devicemotion", onMotion);
  };

  // iOS gates the sensor behind a permission that can only be requested from a
  // user gesture — hook the first interaction, ask, and attach on grant.
  const perm = window.DeviceMotionEvent as unknown as MotionPermission;
  if (typeof perm.requestPermission === "function") {
    const onFirstGesture = (): void => {
      window.removeEventListener("pointerdown", onFirstGesture);
      perm
        .requestPermission!()
        .then((res) => {
          if (res === "granted") addListener();
        })
        .catch(() => undefined);
    };
    window.addEventListener("pointerdown", onFirstGesture, { once: true });
    return () => {
      disposed = true;
      window.removeEventListener("pointerdown", onFirstGesture);
      window.removeEventListener("devicemotion", onMotion);
    };
  }

  addListener();
  return () => {
    disposed = true;
    window.removeEventListener("devicemotion", onMotion);
  };
}
