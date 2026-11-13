/**
 * Main-thread task priorities for the capture loop.
 *
 * DeviceMotion events (the IMU) are only delivered on the main thread, and
 * the browser drops or coalesces them while the thread is busy: a capture whose
 * per-frame work ran as one long task got its IMU at a third of the sensor rate
 * with holes up to ~0.6 s, which starved the solver's only source of metric
 * scale. So the capture loop splits its work into short tasks in this order:
 *
 *  1. image capture + GPU detect: the frame callback itself (needs the live
 *     video frame);
 *  2. IMU: DeviceMotion events, dispatched between the tasks below;
 *  3. the CV pipeline (decode + track): an ordered queue at "user-visible"
 *     priority, one frame per task;
 *  4. the live solve's results and the overlays: coalesced "background"
 *     tasks that only ever draw the latest state.
 *
 * Uses the Prioritized Task Scheduling API where present (Chrome / Android),
 * falling back to a MessageChannel macrotask (Safari / iOS, Node): it still
 * yields to events, without setTimeout's 4 ms clamp on nested timers.
 */

type Priority = "user-blocking" | "user-visible" | "background";

interface TaskScheduler {
  postTask(cb: () => void, opts?: { priority?: Priority; delay?: number }): Promise<unknown>;
}

// MessageChannel fallback: one shared channel, FIFO.
const fallbackQueue: Array<() => void> = [];
let fallbackChannel: MessageChannel | null | undefined;

function macrotask(fn: () => void): void {
  if (fallbackChannel === undefined) {
    fallbackChannel = typeof MessageChannel === "function" ? new MessageChannel() : null;
    if (fallbackChannel) {
      fallbackChannel.port1.onmessage = () => fallbackQueue.shift()?.();
      // Node: an idle port must not keep the process alive.
      (fallbackChannel.port1 as unknown as { unref?: () => void }).unref?.();
    }
  }
  if (fallbackChannel) {
    fallbackQueue.push(fn);
    fallbackChannel.port2.postMessage(0);
  } else {
    setTimeout(fn, 0);
  }
}

function scheduler(): TaskScheduler | null {
  const s = (globalThis as { scheduler?: TaskScheduler }).scheduler;
  return s && typeof s.postTask === "function" ? s : null;
}

/** Run `fn` in a task of its own at `priority` (after pending events). */
export function postTask(fn: () => void, priority: Priority, delayMs = 0): void {
  const s = scheduler();
  const run = (): void => {
    try {
      fn();
    } catch (e) {
      // A task's failure must not stop the queue it belongs to.
      console.error(e);
    }
  };
  if (s) void s.postTask(run, { priority, delay: delayMs }).catch(() => {});
  else if (delayMs > 0) setTimeout(run, delayMs);
  else macrotask(run);
}

/**
 * An ordered queue of work items, drained one item per task at `priority`, so
 * events (the IMU) run between items. Items run in order and none is skipped.
 */
export class OrderedTaskQueue {
  private readonly items: Array<() => void> = [];
  private scheduled = false;
  /** Most items waiting at once (a backlog means the stage can't keep up). */
  maxBacklog = 0;

  constructor(private readonly priority: Priority = "user-visible") {}

  get backlog(): number {
    return this.items.length;
  }

  push(item: () => void): void {
    this.items.push(item);
    this.maxBacklog = Math.max(this.maxBacklog, this.items.length);
    this.kick();
  }

  /** Drop pending items (the capture was torn down). */
  clear(): void {
    this.items.length = 0;
  }

  /** Run every pending item now, in order (the capture is stopping and its
   * queued frames are still part of it). */
  drain(): void {
    while (this.items.length > 0) {
      const item = this.items.shift()!;
      try {
        item();
      } catch (e) {
        console.error(e);
      }
    }
  }

  private kick(): void {
    if (this.scheduled || this.items.length === 0) return;
    this.scheduled = true;
    postTask(() => {
      this.scheduled = false;
      const item = this.items.shift();
      item?.();
      this.kick();
    }, this.priority);
  }
}

/**
 * Latest-only work at a capped rate: `request(fn)` replaces any pending `fn`,
 * and at most one runs per `minIntervalMs`, at "background" priority. For
 * drawing state (an overlay shows the newest frame; intermediate ones are
 * worthless once a newer one exists).
 */
export class CoalescedTask {
  private pending: (() => void) | null = null;
  private scheduled = false;
  private lastRun = -Infinity;
  /** Duration of the last run (ms), for the perf HUD. */
  lastMs = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly priority: Priority = "background",
    private readonly now: () => number = () => performance.now(),
  ) {}

  request(fn: () => void): void {
    this.pending = fn;
    if (this.scheduled) return;
    this.scheduled = true;
    const wait = Math.max(0, this.lastRun + this.minIntervalMs - this.now());
    postTask(() => {
      this.scheduled = false;
      const f = this.pending;
      this.pending = null;
      if (!f) return;
      const t0 = this.now();
      this.lastRun = t0;
      f();
      this.lastMs = this.now() - t0;
    }, this.priority, wait);
  }

  cancel(): void {
    this.pending = null;
  }
}
