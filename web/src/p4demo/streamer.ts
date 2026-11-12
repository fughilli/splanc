/**
 * Latest-value-wins OSC sender with a rate cap and keep-alives: a port of the desktop
 * demo's osc.OscStreamer, driven by timers instead of a thread.
 *
 *  - A changed value goes out at most `maxHz` times a second (the latest value wins).
 *  - Every address is re-sent every `keepalive` seconds (default 1 / keepaliveHz), so a
 *    lost message or a lamp reboot (the effect's uniforms reset to their defaults) heals
 *    by itself. Settings that rarely change (/width, /halo, /glow, /pick, /shape) get a
 *    1 s keep-alive of their own (`set(addr, values, { keepalive: 1 })`).
 *  - Everything due at once goes out as one `#bundle`; slow keep-alives that are nearly
 *    due ride along with it rather than sending their own a moment later.
 *
 * `step(now)` does one round and is what the tests drive with a fake clock; `start()`
 * runs it on timers.
 */

import { bundle, message } from "./osc";

export const MAX_HZ = 120;
export const KEEPALIVE_HZ = 10;
export const PARAM_KEEPALIVE_S = 1;

export interface StreamerOptions {
  maxHz?: number;
  keepaliveHz?: number;
  /** Seconds (monotonic). Default performance.now() / 1000. */
  clock?: () => number;
  /** setTimeout-compatible; returns a handle for `cancel`. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class OscStreamer {
  readonly minDt: number;
  readonly keepDt: number;
  private readonly clock: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly values = new Map<string, number[]>();
  private readonly dirty = new Set<string>();
  private readonly keep = new Map<string, number>();
  private readonly lastKept = new Map<string, number>();
  private lastSend = -1e9;
  private timer: unknown = null;
  private running = false;
  /** Datagrams sent (bundles count once). */
  sent = 0;

  constructor(
    private readonly send: (packet: Uint8Array) => void,
    opts: StreamerOptions = {},
  ) {
    const maxHz = opts.maxHz ?? MAX_HZ;
    const keepaliveHz = opts.keepaliveHz ?? KEEPALIVE_HZ;
    if (!(maxHz > 0 && maxHz <= MAX_HZ + 1e-9)) throw new Error(`maxHz must be in (0, ${MAX_HZ}]`);
    if (!(keepaliveHz >= 1 - 1e-9)) throw new Error("keepaliveHz must be >= 1");
    this.minDt = 1 / maxHz;
    this.keepDt = 1 / keepaliveHz;
    this.clock = opts.clock ?? (() => performance.now() / 1000);
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Set an address's value. `keepalive`: its re-send period (s), e.g. 1 for settings
   * that rarely change; default the streamer's. */
  set(address: string, values: number[], opts: { keepalive?: number } = {}): void {
    if (opts.keepalive !== undefined) this.keep.set(address, opts.keepalive);
    const v = values.map(Number);
    const old = this.values.get(address);
    if (old && old.length === v.length && old.every((x, i) => Object.is(Math.fround(x), Math.fround(v[i]!)))) return;
    this.values.set(address, v);
    this.dirty.add(address);
    this.kick();
  }

  /** Stop sending (and keeping alive) these addresses. */
  clear(...addresses: string[]): void {
    for (const a of addresses) {
      this.values.delete(a);
      this.dirty.delete(a);
      this.lastKept.delete(a);
      this.keep.delete(a);
    }
  }

  /** Send every address again now, e.g. to a freshly deployed effect. */
  resend(): void {
    for (const a of this.values.keys()) this.dirty.add(a);
    this.kick();
  }

  has(address: string): boolean {
    return this.values.has(address);
  }

  get(address: string): number[] | undefined {
    return this.values.get(address);
  }

  /** Send whatever is due at `now` (s). Returns the number of datagrams sent (0 or 1). */
  step(now = this.clock()): number {
    if (now - this.lastSend < this.minDt) return 0;
    const addrs = [...this.values.keys()].filter((a) => this.dirty.has(a) || now >= this.due(a));
    if (addrs.length === 0) return 0;
    for (const a of this.values.keys()) {
      if (!addrs.includes(a) && now >= this.due(a) - this.keepDt) addrs.push(a);
    }
    for (const a of addrs) this.lastKept.set(a, now);
    this.dirty.clear();
    this.lastSend = now;
    const msgs = addrs.map((a) => message(a, ...this.values.get(a)!));
    this.send(msgs.length === 1 ? msgs[0]! : bundle(...msgs));
    this.sent++;
    return 1;
  }

  /** Seconds until the next send could be due (for the timer loop). */
  nextDelay(now = this.clock()): number {
    if (this.dirty.size > 0) return Math.max(0, this.minDt - (now - this.lastSend));
    let next = Infinity;
    for (const a of this.values.keys()) next = Math.min(next, this.due(a));
    if (next === Infinity) return this.keepDt;
    return Math.max(next - now, this.minDt - (now - this.lastSend), 0);
  }

  start(): this {
    this.running = true;
    this.kick();
    return this;
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  private due(a: string): number {
    return (this.lastKept.get(a) ?? -1e9) + (this.keep.get(a) ?? this.keepDt);
  }

  private kick(): void {
    if (!this.running) return;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule(() => this.loop(), Math.max(1, this.nextDelay() * 1000));
  }

  private loop(): void {
    this.timer = null;
    if (!this.running) return;
    try {
      this.step();
    } finally {
      if (this.running) this.timer = this.schedule(() => this.loop(), Math.max(1, this.nextDelay() * 1000));
    }
  }
}
