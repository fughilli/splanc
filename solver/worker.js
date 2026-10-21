/**
 * Solver web worker (plain ES module, served from /solver/ alongside the
 * wasm-bindgen bundle it drives — see //solver:solver_web + app.py's
 * --solver-dir mount).
 *
 * Deliberately NOT part of the vite bundle: the wasm solve is synchronous
 * (seconds of optimization), so it must run off the main thread, and a
 * plain worker file next to the wasm keeps the whole solver deployment in
 * one runfiles directory with zero bundler coupling. The main thread talks
 * to it through SolverAgent (web/src/solver/agent.ts), which owns the
 * message protocol types:
 *
 *   in : {cmd:"init", baseUrl}   out: {kind:"ready", version, wasmSha256} | {kind:"error"}
 *   in : {cmd:"benchmark"}       out: {kind:"bench", ms, rms} | {kind:"error"}
 *   in : {cmd:"solve", problem}  out: {kind:"progress", snap}* then
 *                                     {kind:"map", map, diag, timing} | {kind:"error"}
 *   in : {cmd:"solve", live}     the same, for an interim solve during capture
 *
 * A live solve keeps the capture's observations HERE between solves:
 * `live = {reset, detections, imu, ledCount, mapId, createdAt, options,
 * progress}` carries only the records gathered since the previous live solve,
 * so the main thread (which also runs the camera loop) structured-clones a
 * small delta per solve instead of the whole, ever-growing capture. A full
 * `problem` solve drops the live session. `progress: false` suppresses the
 * progress snapshots (each one is a clone onto the main thread).
 *
 * `timing` = {serializeMs, solveMs, parseMs}: the worker's own costs, for the
 * capture perf counters (web/src/cv/capturePerf.ts).
 *
 * `diag` = the solver's diagnostics (solver/src/diag.rs + pipeline.rs
 * SolveDiagnostics: stage trace, degeneracy assessment, final solver state —
 * a later solve's `options.warmStart`); null from a wasm build that predates
 * `solve_json_diag`. `wasmSha256` fingerprints the exact wasm build, so a
 * capture bundle names the solver that produced it (solver/replay_bundle.mjs
 * checks it before a bit-for-bit replay).
 */

let wasm = null;
let live = null;

self.onmessage = async (ev) => {
  const data = ev.data;
  try {
    if (data.cmd === "init") {
      const base = data.baseUrl ?? "/solver";
      const mod = await import(`${base}/solver_wasm_pkg.js`);
      const resp = await fetch(`${base}/solver_wasm_pkg_bg.wasm`);
      if (!resp.ok) throw new Error(`solver wasm: HTTP ${resp.status}`);
      const bytes = await resp.arrayBuffer();
      let wasmSha256 = null;
      try {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        wasmSha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      } catch {
        // crypto.subtle needs a secure context; the fingerprint is optional.
      }
      await mod.default({ module_or_path: bytes });
      wasm = mod;
      self.postMessage({ kind: "ready", version: mod.version(), wasmSha256 });
      return;
    }
    if (wasm === null) throw new Error("solver wasm not initialized");
    if (data.cmd === "benchmark") {
      const t0 = performance.now();
      const rms = wasm.benchmark();
      self.postMessage({ kind: "bench", ms: performance.now() - t0, rms });
      return;
    }
    if (data.cmd === "solve") {
      let problem = data.problem;
      let progress = true;
      if (data.live) {
        const l = data.live;
        if (l.reset || live === null) live = { detections: [], imu: [] };
        for (const d of l.detections) live.detections.push(d);
        for (const s of l.imu) live.imu.push(s);
        problem = {
          detections: live.detections,
          imu: live.imu,
          ledCount: l.ledCount,
          mapId: l.mapId,
          createdAt: l.createdAt,
          ...(l.options ? { options: l.options } : {}),
        };
        progress = l.progress !== false;
      } else {
        live = null;
      }
      const t0 = performance.now();
      const json = JSON.stringify(problem);
      const t1 = performance.now();
      const onSnap = (snap) => {
        if (progress) self.postMessage({ kind: "progress", snap: JSON.parse(snap) });
      };
      const withDiag = typeof wasm.solve_json_diag === "function";
      const out = withDiag ? wasm.solve_json_diag(json, onSnap) : wasm.solve_json(json, onSnap);
      const t2 = performance.now();
      const parsed = JSON.parse(out);
      const t3 = performance.now();
      self.postMessage({
        kind: "map",
        map: withDiag ? parsed.map : parsed,
        diag: withDiag ? parsed.diag : null,
        timing: { serializeMs: t1 - t0, solveMs: t2 - t1, parseMs: t3 - t2 },
      });
      return;
    }
    throw new Error(`unknown command ${data.cmd}`);
  } catch (e) {
    self.postMessage({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
