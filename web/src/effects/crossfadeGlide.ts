/**
 * Show Mode's timed crossfade ("Fade"): glide the A/B crossfade to the other
 * side over N seconds (docs/design/ramps.md). On firmware advertising "ramps"
 * the DEVICE runs it — one ramp_crossfade request, nothing on the wire while it
 * runs, and the local fader only animates the readout. On older firmware it
 * falls back to stepping set_crossfade at <= 25 Hz (the fader path). Either way
 * a fader / MIDI move takes over at once: the device cancels its ramp on the
 * next set_crossfade, and `stop()` ends the local animation.
 *
 * Pure (no DOM): the screen passes the client, a readout hook and the frame
 * scheduler, so it unit-tests under Node.
 */

import { rampEaseAt, rampEaseWire, type RampEase, type RampStateMessage } from "../net/proto";

export interface GlideClient {
  readonly isConnected: boolean;
  readonly welcome?: { features?: string[] } | null;
  rampCrossfade(
    position: number,
    durationMs: number,
    opts?: { mode?: number; ease?: number; startAtMs?: number; id?: number },
  ): Promise<RampStateMessage>;
  sendCrossfade(position: number, mode?: number): boolean;
}

export interface GlideHooks {
  /** Show the position (fader + readout); `final` on the last frame. */
  show(position: number, final: boolean): void;
  now?: () => number;
  frame?: (cb: () => void) => unknown;
  cancelFrame?: (h: unknown) => void;
  /** Min ms between fallback set_crossfade steps (default 40 = 25 Hz). */
  stepMs?: number;
}

/** Whether the device interpolates timed transitions itself. */
export function supportsRamps(welcome: { features?: string[] } | null | undefined): boolean {
  return (welcome?.features ?? []).includes("ramps");
}

export type GlidePath = "device" | "stepped";

export class CrossfadeGlide {
  private handle: unknown = null;
  private gen = 0;
  private readonly now: () => number;
  private readonly frame: (cb: () => void) => unknown;
  private readonly cancelFrame: (h: unknown) => void;

  constructor(private readonly hooks: GlideHooks) {
    this.now = hooks.now ?? (() => performance.now());
    this.frame = hooks.frame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = hooks.cancelFrame ?? ((h) => cancelAnimationFrame(h as number));
  }

  get running(): boolean {
    return this.handle !== null;
  }

  /** The user took over (fader / MIDI): stop animating. A device ramp is
   * cancelled by the set_crossfade the takeover sends. */
  stop(): void {
    this.gen++;
    if (this.handle !== null) this.cancelFrame(this.handle);
    this.handle = null;
  }

  /** Glide from `from` to `to` over `seconds`. Resolves with the path taken once
   * the transition is under way. */
  async start(
    client: GlideClient,
    from: number,
    to: number,
    seconds: number,
    opts: { mode?: number; ease?: RampEase } = {},
  ): Promise<GlidePath> {
    this.stop();
    const gen = this.gen;
    const ease = opts.ease ?? "ease";
    const mode = opts.mode ?? 0;
    const ms = Math.max(0, seconds * 1000);
    let path: GlidePath = "stepped";
    if (supportsRamps(client.welcome)) {
      try {
        await client.rampCrossfade(to, ms, { mode, ease: rampEaseWire(ease) });
        path = "device";
      } catch {
        path = "stepped"; // refused / timed out: step it from here instead
      }
    }
    if (gen !== this.gen) return path; // taken over while the request was out
    const t0 = this.now();
    let lastSend = -Infinity;
    const tick = (): void => {
      if (gen !== this.gen) return;
      const u = ms > 0 ? (this.now() - t0) / ms : 1;
      const done = u >= 1;
      const pos = done ? to : from + (to - from) * rampEaseAt(ease, u);
      this.hooks.show(pos, done);
      if (path === "stepped") {
        const t = this.now();
        if (done || t - lastSend >= (this.hooks.stepMs ?? 40)) {
          lastSend = t;
          client.sendCrossfade(pos, mode);
        }
      }
      this.handle = done ? null : this.frame(tick);
    };
    tick();
    return path;
  }
}
