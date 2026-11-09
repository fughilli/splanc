/**
 * Phase progress ("discovering…", "connecting Kitchen… ok 180 ms") for whoever is
 * waiting: the CLI prints it to stderr, the MCP server turns it into
 * notifications/progress for the tool call that caused it (and a log message).
 *
 * The sink is per call (AsyncLocalStorage), so concurrent MCP tool calls each see
 * their own progress; work outside any call (the server's background discovery)
 * goes to the process-wide fallback sink.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type ProgressSink = (message: string) => void;

const scope = new AsyncLocalStorage<ProgressSink>();
let fallback: ProgressSink | null = null;

/** The sink for progress reported outside any {@link withProgress} scope. */
export function setProgressSink(sink: ProgressSink | null): void {
  fallback = sink;
}

/** Report one phase message to the current call's sink. Never throws. */
export function progress(message: string): void {
  const sink = scope.getStore() ?? fallback;
  try {
    sink?.(message);
  } catch {
    // progress is best effort
  }
}

/** Run `fn` with progress going to `sink`. */
export function withProgress<T>(sink: ProgressSink, fn: () => T): T {
  return scope.run(sink, fn);
}

// The call's cancellation, scoped the same way: a tool call whose caller gave up
// (an MCP notifications/cancelled: a stopped or superseded request) must not
// reach a player later. DeviceSession.run checks it before each device request.
// Only while the call is still running: timers and sockets created during a call
// inherit its scope, and must not be cancelled with it once it has ended.
const cancelScope = new AsyncLocalStorage<{ signal: AbortSignal; running: boolean }>();

/** Run `fn` (a tool call) with `signal` as its cancellation. */
export function withCancel<T>(signal: AbortSignal | undefined, fn: () => T): T {
  if (!signal) return fn();
  const call = { signal, running: true };
  return cancelScope.run(call, () => {
    const r = fn();
    if (r instanceof Promise) {
      r.then(
        () => (call.running = false),
        () => (call.running = false),
      );
    } else call.running = false;
    return r;
  });
}

/** For work queued now and run later: a check that says whether the tool call it
 * belongs to has been cancelled meanwhile (while that call is still running). */
export function cancellation(): () => boolean {
  const c = cancelScope.getStore();
  return c ? () => c.running && c.signal.aborted : () => false;
}

/** "180 ms" / "2.4 s". */
export function ms(t0: number): string {
  const d = performance.now() - t0;
  return d < 1000 ? `${Math.round(d)} ms` : `${(d / 1000).toFixed(1)} s`;
}
