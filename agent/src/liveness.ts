/**
 * Is a player's /ws session still alive? A player that reboots (and, on firmware
 * that picks a random Wi-Fi MAC per boot, comes back on a NEW IP) never closes
 * its old socket: nothing answers at the old address, so the bridge's TCP
 * connection stays "open" and every request on it waits forever — the tool call
 * hangs until the cloud client gives up with a generic failure.
 *
 * So every session has a watchdog: anything received counts as a sign of life;
 * after `idleMs` of silence (or `busyMs` while a tool call is in flight) it sends
 * a time_sync_ping, and when `misses` pings in a row go unanswered — with nothing
 * else arriving meanwhile — the session is declared dead: in-flight calls fail
 * with the reason, and the hub drops the session and looks for the player again.
 */

import { ToolError } from "./session";

export interface LivenessOptions {
  /** Ping after this much silence while idle (ms). */
  idleMs?: number;
  /** Ping after this much silence while a tool call is waiting on the player (ms). */
  busyMs?: number;
  /** How long a ping may take (ms). */
  pingTimeoutMs?: number;
  /** Unanswered pings in a row (with no other traffic) that mean dead. */
  misses?: number;
  now?: () => number;
}

export const LIVENESS_DEFAULTS: Required<Omit<LivenessOptions, "now">> = {
  idleMs: 20_000,
  busyMs: 4_000,
  pingTimeoutMs: 5_000,
  misses: 2,
};

export class Liveness {
  /** When anything last arrived from the player (hub clock, ms). */
  lastRx: number;
  /** Why the session was declared dead (null: alive). */
  dead: string | null = null;
  private inflight = 0;
  private beating = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly o: Required<Omit<LivenessOptions, "now">>;
  private readonly now: () => number;
  private readonly onDeath = new Set<(why: string) => void>();

  constructor(
    private readonly ping: (timeoutMs: number) => Promise<unknown>,
    private readonly onDead: (why: string) => void,
    opts: LivenessOptions = {},
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.o = { ...LIVENESS_DEFAULTS, ...stripUndefined(opts) };
    this.lastRx = this.now();
    const tick = Math.max(50, Math.min(this.o.busyMs, this.o.idleMs) / 2);
    this.timer = setInterval(() => this.check(), tick);
    this.timer.unref?.();
  }

  /** Something arrived from the player. */
  rx(): void {
    this.lastRx = this.now();
  }

  /** Milliseconds since the player was last heard from. */
  get silentMs(): number {
    return this.now() - this.lastRx;
  }

  /** Run `p` (a call waiting on the player) under the busy watchdog: it rejects
   * with the reason as soon as the session is declared dead. */
  async watch<T>(p: Promise<T>): Promise<T> {
    if (this.dead) throw new ToolError(this.dead);
    this.inflight++;
    let off: (() => void) | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          const f = (why: string) => reject(new ToolError(why));
          this.onDeath.add(f);
          off = () => this.onDeath.delete(f);
        }),
      ]);
    } finally {
      off?.();
      this.inflight--;
    }
  }

  /** Ping now; true when the player answered (or anything else arrived meanwhile). */
  async beat(): Promise<boolean> {
    if (this.dead) return false;
    const before = this.lastRx;
    try {
      await this.ping(this.o.pingTimeoutMs);
      this.rx();
      return true;
    } catch {
      return this.lastRx !== before;
    }
  }

  /** The session ended some other way: stop watching (no death callback). */
  stop(): void {
    clearInterval(this.timer);
  }

  /** Declare the session dead (callers: a socket that stayed closed). */
  kill(why: string): void {
    if (this.dead) return;
    this.dead = why;
    clearInterval(this.timer);
    // In-flight calls fail with the reason first, then the owner tears down.
    for (const f of [...this.onDeath]) f(why);
    this.onDeath.clear();
    this.onDead(why);
  }

  private check(): void {
    if (this.dead || this.beating) return;
    if (this.silentMs < (this.inflight > 0 ? this.o.busyMs : this.o.idleMs)) return;
    this.beating = true;
    void (async () => {
      try {
        for (let miss = 0; miss < this.o.misses; miss++) {
          if (await this.beat()) return;
          if (this.dead) return;
        }
        const s = Math.round(this.silentMs / 100) / 10;
        this.kill(`no reply from the player for ${s} s (${this.o.misses} heartbeat pings unanswered): it rebooted, moved to another IP, or dropped off Wi-Fi`);
      } finally {
        this.beating = false;
      }
    })();
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
