/**
 * Lighthouse tracking worker (plain ES module, served from /lh-wasm/ next to the
 * wasm-bindgen bundle it drives: //web/lh_wasm:lh_wasm_web). Like the solver's
 * worker.js, deliberately not part of the Vite bundle.
 *
 * The kernel's calibration solve can take a noticeable fraction of a second, so the
 * wasm runs here, off the page's thread. WebHID itself stays on the page
 * (web/src/p4demo/lh/webhid.ts): the page forwards input reports here and performs
 * the handshake steps this returns. A thin RPC over the wasm LhTracker:
 *
 *   in : {cmd:"init", baseUrl, hostClock, stream}   out: {kind:"ready"} | {kind:"error", id, msg}
 *   in : {id?, method, args}                          out: {kind:"result", id, result} (if id)
 *                                                          | {kind:"error", id, msg}
 *   out: {kind:"events", json}  after any call that produced events (JSON array, see
 *        web/lh_wasm/src/core.rs)
 *
 * Methods: those of LhTracker (wasm.rs): add_device, remove_device, handshake,
 * handshake_answer, report, reports, tick, station_prior, recalibrate, reset.
 */

let tracker = null;

function flush() {
  const json = tracker.drain();
  if (json !== "[]") self.postMessage({ kind: "events", json });
}

self.onmessage = async (ev) => {
  const data = ev.data;
  try {
    if (data.cmd === "init") {
      const base = data.baseUrl ?? "/lh-wasm";
      const mod = await import(`${base}/lh_wasm_pkg.js`);
      await mod.default({ module_or_path: `${base}/lh_wasm_pkg_bg.wasm` });
      tracker = new mod.LhTracker(!!data.hostClock, !!data.stream);
      self.postMessage({ kind: "ready" });
      return;
    }
    if (!tracker) throw new Error("lh worker: not initialised");
    const fn = tracker[data.method];
    if (typeof fn !== "function" || data.method === "drain" || data.method === "free") {
      throw new Error(`lh worker: no method ${data.method}`);
    }
    let result = fn.apply(tracker, data.args ?? []);
    if (result instanceof Uint32Array) result = Array.from(result);
    flush();
    if (data.id !== undefined) self.postMessage({ kind: "result", id: data.id, result });
  } catch (e) {
    self.postMessage({ kind: "error", id: data.id, msg: String(e && e.message ? e.message : e) });
  }
};
