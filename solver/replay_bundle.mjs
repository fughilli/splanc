/**
 * Capture-bundle replay through the WASM solver — the exact build the phone
 * runs, so a replay is bit-for-bit (docs/design/mapping-solve-paths.md).
 *
 *   bazel run //solver:replay_bundle -- <bundle.splanc-capture.json> [--final-only] [--cold] [--check]
 *   bazel run //solver:replay_bundle -- --record <problem.json> <out.splanc-capture.json> [--interims n1,n2,…]
 *
 * Replay re-runs every recorded phone interim (the capture's first
 * `recordCount` detections + `imuCount` IMU samples, its options) and the
 * final solve (the recorded problem verbatim, warm start included), and
 * reports each one's degeneracy verdict and whether it reproduced the
 * recorded map exactly. `--cold` re-runs the final without its warm start;
 * `--check` exits 1 unless every case reproduced. A bundle recorded by a
 * different wasm build (solver.wasmSha256) is replayed but flagged — its
 * numbers may legitimately differ.
 *
 * `--record` turns a bare problem (e.g. an iOS session-*.json log, or
 * `solver_cli --synth` output) into a bundle the way the app builds one:
 * interim solves on prefixes with the live-preview options, the best one's
 * state as the final's warm start.
 *
 * For stage-by-stage traces use the native CLI: `solver_cli --replay <file>`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { formatCases, loadSolver, recordBundle, replayBundle } from "./replay_bundle_lib.mjs";

async function main(argv) {
  const cwd = process.env.BUILD_WORKING_DIRECTORY ?? process.cwd();
  const abs = (p) => path.resolve(cwd, p);
  const solver = await loadSolver(process.env.SOLVER_WASM_DIR);
  const ri = argv.indexOf("--record");
  if (ri >= 0) {
    const [src, out] = [argv[ri + 1], argv[ri + 2]];
    if (!src || !out) throw new Error("--record <problem.json> <out.splanc-capture.json>");
    const ii = argv.indexOf("--interims");
    const at = ii >= 0 ? argv[ii + 1].split(",").map(Number) : undefined;
    const bundle = recordBundle(solver, JSON.parse(readFileSync(abs(src), "utf8")), at);
    writeFileSync(abs(out), JSON.stringify(bundle));
    console.log(`recorded ${bundle.interims.length} interims + final (${bundle.outcome}) → ${out}`);
    return 0;
  }
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("usage: replay_bundle <bundle.splanc-capture.json> [--final-only] [--cold] [--check]");
  const bundle = JSON.parse(readFileSync(abs(file), "utf8"));
  const recSha = bundle.solver?.wasmSha256 ?? null;
  console.log(`solver ${solver.version} wasm ${solver.wasmSha256.slice(0, 16)}…` + (recSha ? ` (bundle: ${recSha.slice(0, 16)}…)` : ""));
  if (recSha && recSha !== solver.wasmSha256) {
    console.log("NOTE: the bundle was recorded by a different solver build — differences may be legitimate.");
  }
  const cases = replayBundle(solver, bundle, { interims: !argv.includes("--final-only"), cold: argv.includes("--cold") });
  console.log(formatCases(cases));
  if (argv.includes("--check") && cases.some((c) => c.identical !== true)) return 1;
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`replay_bundle: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  },
);
