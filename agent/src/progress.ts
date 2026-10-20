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

/** "180 ms" / "2.4 s". */
export function ms(t0: number): string {
  const d = performance.now() - t0;
  return d < 1000 ? `${Math.round(d)} ms` : `${(d / 1000).toFixed(1)} s`;
}
