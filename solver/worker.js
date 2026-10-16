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
 *   in : {cmd:"init", baseUrl}   out: {kind:"ready", version} | {kind:"error"}
 *   in : {cmd:"benchmark"}       out: {kind:"bench", ms, rms} | {kind:"error"}
 *   in : {cmd:"solve", problem}  out: {kind:"progress", snap}* then
 *                                     {kind:"map", map, timing} | {kind:"error"}
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
 */

let wasm = null;
let live = null;

self.onmessage = async (ev) => {
  const data = ev.data;
  try {
    if (data.cmd === "init") {
      const base = data.baseUrl ?? "/solver";
      const mod = await import(`${base}/solver_wasm_pkg.js`);
      await mod.default(`${base}/solver_wasm_pkg_bg.wasm`);
      wasm = mod;
      self.postMessage({ kind: "ready", version: mod.version() });
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
      const out = wasm.solve_json(json, (snap) => {
        if (progress) self.postMessage({ kind: "progress", snap: JSON.parse(snap) });
      });
      const t2 = performance.now();
      const map = JSON.parse(out);
      const t3 = performance.now();
      self.postMessage({
        kind: "map",
        map,
        timing: { serializeMs: t1 - t0, solveMs: t2 - t1, parseMs: t3 - t2 },
      });
      return;
    }
    throw new Error(`unknown command ${data.cmd}`);
  } catch (e) {
    self.postMessage({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
