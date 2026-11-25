#!/usr/bin/env node
// Diffuse detector bench runner (see README.md). Builds page.ts with Vite, serves
// it next to the diffuse_rope suite frames, then either launches headless
// Chromium (SwiftShader WebGL) once per CPU-throttle tier, or attaches to an
// existing DevTools endpoint (a phone's Chrome over `adb forward`) and runs
// there. Prints a per-tier table and writes the full results as JSON.
//
//   node web/tests/tools/detect_bench/run.mjs [--tiers 1,2.5,5] [--frames 300]
//        [--out results.json] [--chrome /path/to/chrome] [--no-parity]
//        [--attach http://localhost:9222] [--port 8099] [--serve-only]
//
// Node 22+ (built-in WebSocket); Vite from web/node_modules.

import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "../../..");
const DATA = join(WEB, "tests/testdata/diffuse_rope");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
const tiers = String(opt("tiers", "1,2.5,5")).split(",").map(Number);
const frames = Number(opt("frames", 300));
const port = Number(opt("port", 0));
const attach = opt("attach", null);
const parity = !flag("no-parity");
const other = Number(opt("other", 0));
// A/B: extra web roots (e.g. a checkout of main's web/) benchmarked against this
// one, interleaved round by round so host load hits every variant alike.
const roots = [WEB, ...String(opt("compare", "")).split(",").filter(Boolean).map((p) => resolve(p))];
const rounds = Number(opt("rounds", roots.length > 1 ? 3 : 1));

function findChrome() {
  const env = opt("chrome", process.env.CHROME);
  if (env) return env;
  const base = join(homedir(), ".cache/ms-playwright");
  if (existsSync(base)) {
    for (const d of readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse()) {
      for (const sub of ["chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux64/headless_shell"]) {
        const p = join(base, d, sub);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) if (existsSync(p)) return p;
  throw new Error("no Chromium found: pass --chrome or set CHROME");
}
// No bundler: the server transpiles each .ts on request (TypeScript's
// transpileModule, from web/node_modules) and points extensionless relative
// imports at their .ts file, so the browser loads the sources as ES modules.
const ts = (await import(join(WEB, "node_modules/typescript/lib/typescript.js"))).default;
function transpile(file) {
  const src = readFileSync(file, "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false, isolatedModules: true },
    fileName: file,
  }).outputText;
  return js.replace(/((?:import|export)[^"']*?from\s*|import\s*\(\s*|import\s+)(["'])(\.{1,2}\/[^"']+)\2/g, (m, pre, qu, spec) => {
    if (/\.[cm]?[jt]s$/.test(spec)) return m;
    const base = resolve(dirname(file), spec);
    const ext = existsSync(base + ".ts") ? ".ts" : existsSync(join(base, "index.ts")) ? "/index.ts" : "";
    return `${pre}${qu}${spec}${ext}${qu}`;
  });
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".rgbz": "application/octet-stream" };
function serve() {
  const srv = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    if (p === "/") {
      res.writeHead(302, { location: `/w0/tests/tools/detect_bench/index.html${url.search}` }).end();
      return;
    }
    const m = p.match(/^\/w(\d+)\/(.*)$/);
    const root = m ? roots[Number(m[1])] : undefined;
    const file = p.startsWith("/data/") ? join(DATA, p.slice(6)) : root ? join(root, m[2]) : "";
    if (!file || !(file.startsWith(DATA) || (root && file.startsWith(root))) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    const headers = { "cache-control": "no-store" };
    if (extname(file) === ".ts") {
      try {
        res.writeHead(200, { ...headers, "content-type": "text/javascript" }).end(transpile(file));
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
      return;
    }
    res.writeHead(200, { ...headers, "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(port, "0.0.0.0", () => r(srv)));
}

/** Minimal CDP client over the built-in WebSocket. */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method === "Runtime.consoleAPICalled") {
      const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      if (flag("verbose")) console.error(`  [page] ${text}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function pageTarget(httpBase, url) {
  const r = await fetch(`${httpBase}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const j = await r.json();
  return { ws: j.webSocketDebuggerUrl, close: () => fetch(`${httpBase}/json/close/${j.id}`).catch(() => {}) };
}

async function runTier(httpBase, pageUrl, rate, doParity = parity) {
  const target = await pageTarget(httpBase, "about:blank");
  const c = await cdp(target.ws);
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setCPUThrottlingRate", { rate });
  await c.send("Page.navigate", { url: pageUrl });
  // Wait for the bundle to define runBench.
  for (let i = 0; i < 200; i++) {
    const r = await c.send("Runtime.evaluate", { expression: "typeof window.runBench", returnByValue: true });
    if (r.result.value === "function") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const expr = `window.runBench(${JSON.stringify({ frames, parity: doParity, otherWorkMs: other, data: "/data", passProfile: flag("passes"), sync: flag("sync"), downscale: Number(opt("ds", 2)), paceMs: Number(opt("pace", 1000 / 60)) })}).then(r => JSON.stringify(r))`;
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 30 * 60_000 });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 2000));
  const text = await c.send("Runtime.evaluate", { expression: "document.getElementById('out').textContent", returnByValue: true });
  c.close();
  await target.close();
  return { rate, result: JSON.parse(r.result.value), log: text.result.value };
}

const srv = await serve();
const sport = srv.address().port;
console.error(`[bench] serving on :${sport}`);
if (flag("serve-only")) {
  console.error(`[bench] open http://<host>:${sport}/?auto=1 on the device (adb reverse tcp:${sport} tcp:${sport} -> http://localhost:${sport}/?auto=1)`);
  await new Promise(() => {});
}

let chrome = null;
let httpBase = attach;
if (!attach) {
  const userDir = mkdtempSync(join(tmpdir(), "detect-bench-chrome-"));
  const bin = findChrome();
  chrome = spawn(
    bin,
    [
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDir}`,
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--no-first-run",
      "--no-sandbox",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  httpBase = await new Promise((res, rej) => {
    let buf = "";
    chrome.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on ws:\/\/([^/]+)\//);
      if (m) res(`http://${m[1]}`);
    });
    chrome.on("exit", (code) => rej(new Error(`chrome exited ${code}: ${buf.slice(-2000)}`)));
  });
}
const host = attach ? `http://localhost:${sport}` : `http://127.0.0.1:${sport}`;
const results = [];
try {
  for (let round = 0; round < rounds; round++) {
    for (const rate of attach ? [1] : tiers) {
      for (let v = 0; v < roots.length; v++) {
        console.error(`[bench] round ${round + 1}/${rounds} · CPU throttle ${rate}x · ${roots[v]}`);
        const r = await runTier(httpBase, `${host}/w${v}/tests/tools/detect_bench/index.html?`, rate, parity && round === 0);
        console.error(r.log);
        results.push({ ...r, variant: v, root: roots[v], round });
      }
    }
  }
} finally {
  chrome?.kill();
  srv.close();
}
const f2 = (x) => x.toFixed(2);
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};
// Per (variant, tier): the median over rounds of each statistic.
console.log("\n| variant | CPU throttle | total p50 | total p95 | submit p95 | read p95 | CCL p95 | over budget | dropped |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (let v = 0; v < roots.length; v++) {
  for (const rate of attach ? [1] : tiers) {
    const rs = results.filter((r) => r.variant === v && r.rate === rate).map((r) => r.result.timing);
    const g = (f) => med(rs.map(f));
    console.log(
      `| ${v === 0 ? "this" : roots[v]} | ${rate}x | ${f2(g((t) => t.total.p50))} | ${f2(g((t) => t.total.p95))} | ${f2(g((t) => t.submit.p95))} | ` +
        `${f2(g((t) => t.read.p95))} | ${f2(g((t) => t.ccl.p95))} | ${(g((t) => t.overBudget) * 100).toFixed(1)}% | ${(g((t) => t.dropFrac) * 100).toFixed(1)}% |`,
    );
  }
}
const outPath = opt("out", null);
if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 1));
