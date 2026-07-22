/**
 * Solver placement (design: Rust/wasm solver branch): where does the FINAL
 * joint solve run — on the phone (wasm) or on the Pi (native subprocess)?
 *
 * Both sides run the SAME canned benchmark solve at init time (identical
 * Rust code, identical problem — solver/src/synth.rs): the host advertises
 * its score in welcome.solverBenchMs; the phone times its wasm module here.
 * The decision is phone-first: the phone has the observations locally (no
 * upload/poll latency) and offloading ties up the Pi, so the host only wins
 * when the phone is decisively slower.
 */

export type SolvePlacement = "phone" | "host";

/**
 * The phone keeps the solve until it is this many times slower than the
 * host. Wasm typically runs within ~2x of native on the same silicon, and a
 * mid-range phone beats a Pi outright — the margin means only genuinely
 * slow phones (or a beefy host) offload.
 */
export const PHONE_SLOWDOWN_LIMIT = 4;

export function chooseSolvePlacement(
  phoneBenchMs: number | null,
  hostBenchMs: number | null,
): SolvePlacement {
  if (phoneBenchMs === null) return "host"; // wasm unavailable/failed
  if (hostBenchMs === null) return "phone"; // host still measuring: phone-first
  return phoneBenchMs <= PHONE_SLOWDOWN_LIMIT * hostBenchMs ? "phone" : "host";
}
