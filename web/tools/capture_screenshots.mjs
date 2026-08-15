/**
 * Capture real app screenshots for the user guide (FUG-103 review follow-up).
 *
 * Serves the built app (`web/dist`) over a throwaway static server, drives a
 * headless Chromium with Playwright, and for each entry in the guide's shots
 * manifest (`docs/user-guide/shots.json`, emitted by genUserGuide.ts from the
 * catalog's `screenshot` routes) navigates to the screen, seeds a deterministic
 * state (no splash / no first-run tour so nothing overlays the shot), and writes
 * a phone-viewport PNG to `docs/user-guide/img/<id>.png`.
 *
 * The PNGs are NOT freshness-gated (real screenshots can't be byte-reproduced in
 * CI) — only the manifest + `<img>` references are. Regenerate them on demand:
 *
 *   bazel run //web:capture_user_guide          # PNGs only
 *   bazel run //web:build_user_guide            # PNGs + regenerate the guide
 *
 * Chromium: Playwright-core does NOT download a browser, so point it at one via
 * `SPLANC_CHROMIUM` (an explicit executable) or `PLAYWRIGHT_BROWSERS_PATH` (a
 * Playwright browsers dir, e.g. from `playwright install chromium`, or the Nix
 * `playwright-driver.browsers` on x86_64). This keeps the browser out of the
 * hermetic build graph while the target stays `bazel run`-driven.
 *
 * Args (all optional; sensible defaults under $BUILD_WORKSPACE_DIRECTORY):
 *   --dist <dir>       the built app to serve      (default: web/dist)
 *   --manifest <file>  the shots manifest          (default: docs/user-guide/shots.json)
 *   --out <dir>        where to write PNGs          (default: docs/user-guide/img)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";

// Phone viewport (matches the app's mobile-first layout); 2x for crisp shots.
const VIEWPORT = { width: 390, height: 844 };
const DEVICE_SCALE = 2;
const DEFAULT_SETTLE_MS = 700;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function resolveUnder(ws, p, def) {
  if (p) return path.resolve(p);
  if (!ws) throw new Error(`no ${def} path and no BUILD_WORKSPACE_DIRECTORY`);
  return path.join(ws, def);
}

/** A minimal static file server rooted at `dir`; serves index.html at `/`. */
function serveStatic(dir) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || "/").split("?")[0]);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.join(dir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

/** Locate a Chromium executable for playwright-core. */
function chromiumExecutable() {
  const explicit = process.env["SPLANC_CHROMIUM"];
  if (explicit && fs.existsSync(explicit)) return explicit;
  // Search a PLAYWRIGHT_BROWSERS_PATH (or the default cache) for a chromium build.
  const roots = [
    process.env["PLAYWRIGHT_BROWSERS_PATH"],
    path.join(process.env["HOME"] || "/root", ".cache", "ms-playwright"),
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).sort().reverse()) {
      if (!name.startsWith("chromium")) continue;
      for (const cand of [
        path.join(root, name, "chrome-linux", "chrome"),
        path.join(root, name, "chrome-linux", "headless_shell"),
        path.join(root, name, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      ]) {
        if (fs.existsSync(cand)) return cand;
      }
    }
  }
  return null;
}

async function main() {
  const ws = process.env["BUILD_WORKSPACE_DIRECTORY"];
  const distDir = resolveUnder(ws, arg("--dist"), "web/dist");
  const manifestFile = resolveUnder(ws, arg("--manifest"), "docs/user-guide/shots.json");
  const outDir = resolveUnder(ws, arg("--out"), "docs/user-guide/img");

  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    throw new Error(`built app not found at ${distDir} — build //web:dist first`);
  }
  const shots = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  fs.mkdirSync(outDir, { recursive: true });

  const executablePath = chromiumExecutable();
  if (!executablePath) {
    throw new Error(
      "no Chromium found. Install one with `playwright install chromium` and/or set " +
        "SPLANC_CHROMIUM=<path-to-chrome> or PLAYWRIGHT_BROWSERS_PATH=<browsers-dir>.",
    );
  }

  const { chromium } = await import("playwright-core");
  const { server, port } = await serveStatic(distDir);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true, executablePath });

  // Seed a deterministic state BEFORE app JS runs: no launch splash, and the
  // first-run tutorial already dismissed, so neither overlays the screenshots.
  const seed = `
    try {
      localStorage.setItem('ledmapper.appearance', JSON.stringify({ splash: false }));
      localStorage.setItem('ledmapper.tour', JSON.stringify({ dismissed: true, hintSeen: true, completed: [] }));
      localStorage.setItem('ledmapper.aiHintDismissed', 'true');
    } catch (e) {}
  `;

  let ok = 0;
  const failed = [];
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE });
    try {
      await page.addInitScript(seed);
      const route = String(shot.route).replace(/^#/, "");
      await page.goto(`${base}/#${route}`, { waitUntil: "networkidle", timeout: 20000 });
      await page.waitForSelector(shot.waitFor || ".screen, .shell", { timeout: 10000 }).catch(() => {});
      if (shot.clickText) {
        await page
          .getByText(shot.clickText, { exact: true })
          .first()
          .click({ timeout: 5000 })
          .catch(() => {});
      }
      await page.waitForTimeout(shot.settleMs || DEFAULT_SETTLE_MS);
      const out = path.join(outDir, `${shot.id}.png`);
      await page.screenshot({ path: out });
      ok++;
      process.stderr.write(`captured ${shot.id} (#${route})\n`);
    } catch (e) {
      failed.push(shot.id);
      process.stderr.write(`FAILED ${shot.id}: ${e.message}\n`);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  server.close();
  process.stderr.write(`\n${ok}/${shots.length} screenshots written to ${outDir}\n`);
  if (failed.length) {
    process.stderr.write(`failed: ${failed.join(", ")}\n`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(String(err?.stack || err) + "\n");
    process.exit(2);
  },
);

// Silence "unused" for the ESM entry helper on some linters.
void fileURLToPath;
