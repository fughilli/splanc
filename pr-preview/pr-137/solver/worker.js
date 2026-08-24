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
 *                                     {kind:"map", map} | {kind:"error"}
 */

let wasm = null;

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
      const out = wasm.solve_json(JSON.stringify(data.problem), (json) => {
        self.postMessage({ kind: "progress", snap: JSON.parse(json) });
      });
      self.postMessage({ kind: "map", map: JSON.parse(out) });
      return;
    }
    throw new Error(`unknown command ${data.cmd}`);
  } catch (e) {
    self.postMessage({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
