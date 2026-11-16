#!/usr/bin/env node
/**
 * Capture-loop profile in a real browser, CPU-throttled like a phone (the
 * companion of web/tests/wallPerf.ts, which it runs unchanged). Serves the
 * compiled test tree (bazel build //web:web_tests_js -> bazel-bin/web/dist-test)
 * to headless Chromium through a tiny CommonJS loader, emulates a phone
 * viewport (412×915 CSS px at DPR 2.625), sets CDP Emulation.setCPUThrottlingRate,
 * and times, per frame, the production pipeline (tracker / decode / other)
 * plus the capture screen's own work around it:
 *
 *   labels   — LabelOverlay.draw over a full-viewport canvas, at the capture
 *              screen's 80 ms overlay cadence (every 3rd frame at 30 fps;
 *              the mean is amortised per frame, p95 ≈ the cost of one draw):
 *              command recording, the main-thread part on a GPU canvas
 *   labelsRaster — with --raster 1: a 1-px readback after the draw, forcing
 *              the (software, headless) raster: an upper bound
 *   monitor  — blobPopulation (the brightness servo's per-frame summary)
 *   page     — pipeline + labels + monitor
 *
 * Usage (no network: Chromium from the Playwright cache, or --chrome):
 *   node web/tests/wallPerf_browser.mjs --dist bazel-bin/web/dist-test \
 *     [--dist2 <baseline dist> ] [--leds 400,1000,2000] [--throttle 4] \
 *     [--duration 20000] [--sync stagger_pilot] [--reps 1]
 * Prints one JSON line per (dist, leds, rep). The dist dirs must be copies with
 * a package.json of {"type":"commonjs"} next to src/ (see
 * /workspace/.claude/phase2/perf2000.md); the loader does not care, node does.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, xs) => (a.startsWith("--") ? [...acc, [a.slice(2), xs[i + 1]]] : acc), []),
);
const dists = [args.dist, args.dist2].filter(Boolean).map((d) => path.resolve(d));
if (dists.length === 0) throw new Error("--dist <dist-test dir> required");
const leds = (args.leds ?? "400,1000,2000").split(",").map(Number);
const throttle = Number(args.throttle ?? 4);
const duration = Number(args.duration ?? 20000);
const sync = args.sync ?? "stagger_pilot";
const reps = Number(args.reps ?? 1);
const raster = args.raster === "1";

function findChrome() {
  if (args.chrome) return args.chrome;
  const root = path.join(homedir(), ".cache/ms-playwright");
  for (const d of readdirSync(root).sort().reverse()) {
    for (const rel of ["chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/chrome"]) {
      const p = path.join(root, d, rel);
      if (existsSync(p)) return p;
    }
  }
  throw new Error("no Chromium in ~/.cache/ms-playwright; pass --chrome");
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>html,body{margin:0;height:100%;background:#000}canvas{position:fixed;inset:0;width:100%;height:100%}</style>
<canvas id="labels"></canvas>
<script>
// Minimal synchronous CommonJS loader over the served dist tree.
const cache = new Map();
function resolve(from, rel) {
  const u = new URL(rel, location.origin + from);
  let p = u.pathname;
  if (!p.endsWith(".js")) p += ".js";
  return p;
}
function load(p) {
  if (cache.has(p)) return cache.get(p).exports;
  const x = new XMLHttpRequest();
  x.open("GET", p, false);
  x.send();
  if (x.status !== 200) throw new Error("load " + p + ": " + x.status);
  const module = { exports: {} };
  cache.set(p, module);
  const fn = new Function("exports", "require", "module", "__filename", "__dirname", x.responseText + "\\n//# sourceURL=" + p);
  fn(module.exports, (r) => load(resolve(p, r)), module, p, p.replace(/\\/[^/]*$/, "/"));
  return module.exports;
}
window.bench = (root, opts) => {
  const { runWallPerf } = load(root + "/tests/wallPerf.js");
  const { LabelOverlay } = load(root + "/src/ui/labels.js");
  const { blobPopulation } = load(root + "/src/cv/exposure.js");
  const labels = new LabelOverlay(document.getElementById("labels"));
  const r = runWallPerf({
    ledCount: opts.ledCount,
    durationMs: opts.durationMs,
    sync: opts.sync,
    extra: {
      labels: (pl, frame) => { if (frame % 3 === 0) labels.draw(pl.lastBlobStatus, 1280, 720); },
      // Forces the canvas to rasterise now (a 1-px readback): headless has no
      // GPU, so this is the software-raster upper bound of the same draw.
      labelsRaster: () => { if (opts.raster) document.getElementById("labels").getContext("2d").getImageData(0, 0, 1, 1); },
      monitor: (_pl, _f, blobs) => { blobPopulation(blobs); },
    },
  });
  return { ...r, params: undefined };
};
</script>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
    return;
  }
  const m = /^\/d(\d+)(\/.*)$/.exec(url.pathname);
  const file = m ? path.join(dists[Number(m[1])], path.normalize(m[2])) : null;
  if (file === null || !existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/javascript" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const profile = mkdtempSync(path.join(tmpdir(), "wallperf-"));
const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--js-flags=--max-old-space-size=4096",
    `http://127.0.0.1:${port}/`,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) resolve(m[1]);
  });
  chrome.on("exit", (c) => reject(new Error(`chrome exited ${c}: ${buf}`)));
});
const httpBase = wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
let target = null;
for (let i = 0; i < 50 && target === null; i++) {
  const list = await (await fetch(`${httpBase}/json/list`)).json();
  target = list.find((t) => t.type === "page" && t.url.startsWith(`http://127.0.0.1:${port}`)) ?? null;
  if (target === null) await new Promise((r) => setTimeout(r, 100));
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

await cdp("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
await cdp("Page.reload");
await new Promise((r) => setTimeout(r, 1000));
await cdp("Emulation.setCPUThrottlingRate", { rate: throttle });
for (const n of leds) {
  for (let rep = 0; rep < reps; rep++) {
    for (let d = 0; d < dists.length; d++) {
      const expr = `JSON.stringify(bench("/d${d}", ${JSON.stringify({ ledCount: n, durationMs: duration, sync, raster })}))`;
      const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      const res = JSON.parse(r.result.value);
      const st = Object.fromEntries(Object.entries(res.stages).map(([k, v]) => [k, { mean: +v.mean.toFixed(2), p95: +v.p95.toFixed(2) }]));
      console.log(
        JSON.stringify({
          dist: dists[d],
          leds: n,
          throttle,
          sync,
          stages: st,
          good: +res.goodPerLedPerS.toFixed(3),
          wrongPct: +res.wrongPct.toFixed(2),
          coverage: +res.coverage.toFixed(3),
          digest: res.digest,
        }),
      );
    }
  }
}
ws.close();
chrome.kill();
server.close();
