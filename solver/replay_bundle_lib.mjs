/**
 * Library half of solver/replay_bundle.mjs (the CLI) — loading the wasm solver,
 * recording a bundle from a bare problem, replaying one. See the CLI's docs.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The live-preview options (web/src/solver/liveSolve.ts LIVE_SOLVE_OPTIONS). */
export const LIVE_SOLVE_OPTIONS = { maxKeyframes: 120, maxNfev: 20, rejectOutliers: false };

/** Load the wasm solver from `dir` (default: the solver_web next to this file). */
export async function loadSolver(dir) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const base = dir ?? path.join(here, "solver_web");
  const mod = await import(pathToFileURL(path.join(base, "solver_wasm_pkg.js")).href);
  const bytes = readFileSync(path.join(base, "solver_wasm_pkg_bg.wasm"));
  mod.initSync({ module: bytes });
  return {
    version: mod.version(),
    wasmSha256: createHash("sha256").update(bytes).digest("hex"),
    /** Solve a problem object exactly as the worker does (JSON.stringify). */
    solve(problem) {
      try {
        const out = JSON.parse(mod.solve_json_diag(JSON.stringify(problem), undefined));
        return { map: out.map, diag: out.diag, error: null };
      } catch (e) {
        return { map: null, diag: null, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** web/src/solver/degeneracy.ts `better`. */
function better(a, b) {
  if (a.degenerate !== b.degenerate) return !a.degenerate;
  if (a.measured !== b.measured) return a.measured > b.measured;
  return a.rmsPx < b.rmsPx;
}

/** The problem an interim solve saw (the worker's live session). */
export function interimProblem(problem, it) {
  return {
    detections: problem.detections.slice(0, it.recordCount),
    imu: problem.imu.slice(0, it.imuCount),
    ledCount: it.ledCount ?? problem.ledCount,
    mapId: it.mapId ?? "live",
    createdAt: it.createdAt ?? problem.createdAt,
    ...(it.options ? { options: it.options } : {}),
  };
}

/** Bit-for-bit comparison of two OutputMaps (null-safe). */
export function identicalMaps(a, b) {
  return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}

function maxLedDelta(a, b) {
  if (!a || !b || a.leds.length !== b.leds.length) return null;
  let m = 0;
  a.leds.forEach((l, i) => {
    const r = b.leds[i];
    if (r.id !== l.id) m = Infinity;
    else for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(l.xyz[k] - r.xyz[k]));
  });
  return m;
}

/** Record a bundle from a bare problem, the way the app does. `at` = the
 * record counts the interim solves ran at (default: every eighth). */
export function recordBundle(solver, problem, at) {
  const dets = problem.detections;
  const counts = at ?? Array.from({ length: 8 }, (_, i) => Math.round(((i + 1) * dets.length) / 8));
  const interims = [];
  let best = null;
  for (const n of counts) {
    const tMax = dets[n - 1].tCaptureMs;
    const imuCount = problem.imu.filter((s) => s.t <= tMax).length;
    const it = {
      source: "phone",
      tMs: tMax - dets[0].tCaptureMs,
      recordCount: n,
      imuCount,
      ledCount: problem.ledCount,
      mapId: "live",
      createdAt: problem.createdAt,
      options: { ...LIVE_SOLVE_OPTIONS },
    };
    const r = solver.solve(interimProblem(problem, it));
    const rec = { ...it, map: r.map, diag: r.diag, error: r.error, assessment: r.diag?.assessment ?? null };
    interims.push(rec);
    if (rec.assessment && (best === null || better(rec.assessment, best.assessment))) best = rec;
  }
  for (const r of interims) r.best = r === best;
  const options = { ...(problem.options ?? {}) };
  delete options.warmStart;
  if (best?.diag) options.warmStart = best.diag.state;
  const finalProblem = { ...problem, options };
  delete finalProblem.truth;
  delete finalProblem.imuRaw;
  const r = solver.solve(finalProblem);
  return {
    format: "splanc-capture-bundle",
    version: 1,
    id: `recorded-${Date.now()}`,
    createdAt: new Date().toISOString(),
    outcome: r.error ? "failed" : r.diag.assessment.degenerate ? "degenerate" : "ok",
    summary: "recorded offline by solver/replay_bundle.mjs",
    solver: { version: solver.version, wasmSha256: solver.wasmSha256 },
    problem: finalProblem,
    interims,
    interimCount: interims.length,
    final: { map: r.map, diag: r.diag, error: r.error, assessment: r.diag?.assessment ?? null, timing: null },
    frames: [],
  };
}

/** Replay a parsed bundle; returns one case per solve. */
export function replayBundle(solver, bundle, { interims = true, cold = false } = {}) {
  if (bundle.format !== "splanc-capture-bundle") throw new Error("not a splanc capture bundle");
  if (!bundle.problem) throw new Error("bundle has no final problem");
  const cases = [];
  const run = (label, problem, recorded) => {
    const r = solver.solve(problem);
    const c = {
      label,
      records: problem.detections.length,
      error: r.error,
      recordedError: recorded?.error ?? null,
      assessment: r.diag?.assessment ?? null,
      start: r.diag?.start ?? null,
      identical: null,
      maxLedDeltaM: null,
    };
    if (recorded?.map) {
      c.identical = identicalMaps(r.map, recorded.map);
      c.maxLedDeltaM = maxLedDelta(r.map, recorded.map);
    } else if (recorded?.error) {
      c.identical = r.error === recorded.error;
    }
    cases.push(c);
  };
  if (interims) {
    (bundle.interims ?? []).forEach((it, i) => {
      if (it.source === "host") return;
      run(`interim-${i}${it.best ? " (best)" : ""}`, interimProblem(bundle.problem, it), it);
    });
  }
  if (cold) {
    const options = { ...(bundle.problem.options ?? {}) };
    delete options.warmStart;
    run("final (cold only)", { ...bundle.problem, options }, null);
  } else {
    run("final", bundle.problem, bundle.final);
  }
  return cases;
}

export function formatCases(cases) {
  return cases
    .map((c) => {
      const a = c.assessment;
      const verdict = c.error ? `ERROR ${c.error}` : a?.degenerate ? `DEGENERATE [${a.reasons.join(", ")}]` : "ok";
      const rep =
        c.identical === true
          ? "IDENTICAL"
          : c.identical === false
            ? `differs${c.maxLedDeltaM !== null ? ` (max |Δ| ${c.maxLedDeltaM.toExponential(3)} m)` : ""}`
            : "(no recording)";
      const leds = a ? `${a.measured}/${a.observable}` : "-";
      return `${c.label.padEnd(20)} records ${String(c.records).padStart(6)}  ${verdict.padEnd(40)} leds ${leds.padEnd(9)} start ${String(c.start ?? "-").padEnd(4)} replay ${rep}`;
    })
    .join("\n");
}
