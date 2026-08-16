#!/usr/bin/env python3
"""Capture real Splanc app screenshots for the user guide (FUG-103 review
follow-up), with Playwright + headless Chromium.

This is the screenshot half of the one-target guide rebuild. It reads the
manifest the TS generator emits (``docs/user-guide/shots.json`` — the single
source of truth, derived from the guide catalog), serves the built web app
(``//web:dist``) over a local HTTP server, drives headless Chromium to each
topic's route, and writes ``docs/user-guide/img/<id>.png``. The generator embeds
those PNGs into both the Markdown guide and the static site.

Design notes:
  * Modeled on FUG-104's ``//docs:gen_figures`` — a ``bazel run`` py_binary that
    reads the working tree live and writes outputs into it (via
    ``$BUILD_WORKSPACE_DIRECTORY``). It is NEVER part of ``bazel test //...`` (a
    ``py_binary`` is only *built*, never *run*, by the wildcard), so CI never
    needs a browser in its sandbox.
  * The PNGs are byte-varying binaries, so — unlike the Markdown/HTML/manifest —
    they are NOT freshness-gated; they're checked-in assets refreshed on demand.
  * The browser is provisioned by Playwright itself (``playwright install
    chromium``); if it's missing we install it once (network needed, same as any
    Playwright project). Nothing about the app build depends on it.

Usage:
    bazel run //docs:capture_user_guide            # writes docs/user-guide/img/
    bazel run //docs:build_user_guide              # regenerate guide + shots
"""

import argparse
import functools
import http.server
import json
import os
import socketserver
import subprocess
import sys
import threading
from pathlib import Path

# Phone-ish portrait viewport at 2x for crisp text, matching the guide's framing.
VIEWPORT = {"width": 390, "height": 844}
SCALE = 2

# Seed localStorage BEFORE the app boots so screens render clean and populated:
# suppress the first-run tutorial hint + the launch splash (which would otherwise
# overlay the shot), and let the app's own built-in sample maps/effects seed.
SEED_JS = """
localStorage.setItem('ledmapper.tour', JSON.stringify({dismissed:true, hintSeen:true, completed:[]}));
// Suppress the effects-library 'AI generation' hint bubble — it auto-opens and
// covers the first effect row (blocking the editor-open click) and the shot.
localStorage.setItem('ledmapper.aiHintDismissed', '1');
try {
  const a = JSON.parse(localStorage.getItem('ledmapper.appearance') || '{}');
  a.splash = false;
  localStorage.setItem('ledmapper.appearance', JSON.stringify(a));
} catch (e) {}
"""


def workspace_dir() -> Path:
    ws = os.environ.get("BUILD_WORKSPACE_DIRECTORY")
    if not ws:
        sys.exit("capture_user_guide must run via `bazel run` (needs BUILD_WORKSPACE_DIRECTORY)")
    return Path(ws)


def serve(root: Path) -> tuple[socketserver.TCPServer, int]:
    """Start a background static file server rooted at `root`. Returns (server,
    port). The app uses a relative base + hash routing, so plain static serving
    of the built bundle is enough (it runs fully offline)."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    handler.log_message = lambda *a, **k: None  # quiet
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def ensure_browser():
    """Make sure Chromium is available to Playwright; install it once if not.
    (Standard Playwright flow — needs network the first time, like `npm ci`.)"""
    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as p:
            p.chromium.launch(headless=True).close()
        return
    except Exception:
        pass
    print("Installing Chromium for Playwright (one-time)…", file=sys.stderr)
    # The toolchain python that runs `-m playwright` needs playwright on its
    # path — carry this process's sys.path through so it can import it.
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(x for x in sys.path if x))
    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True, env=env)


def capture(dist: Path, shots: list[dict], out_dir: Path) -> None:
    from playwright.sync_api import sync_playwright

    out_dir.mkdir(parents=True, exist_ok=True)
    httpd, port = serve(dist)
    base = f"http://127.0.0.1:{port}/"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for shot in shots:
                # A FRESH context per shot so nothing carries over — an opened
                # sheet/drawer, navigation, or seeded state from one screen can't
                # contaminate the next (Kevin's review). New context == clean
                # localStorage + a blank DOM.
                ctx = browser.new_context(viewport=VIEWPORT, device_scale_factor=SCALE)
                ctx.add_init_script(SEED_JS)
                page = ctx.new_page()
                sid, route = shot["id"], shot["route"]
                hashpart = route if route.startswith("#") else "#" + route.lstrip("/")
                # A `demo` scenario drives the app's ?demo= capture seam (mocked
                # hardware: connected device + RTT, camera frame, Bluetooth).
                demo = shot.get("demo")
                url = base + (f"?demo={demo}" if demo else "") + hashpart
                try:
                    page.goto(url, wait_until="networkidle", timeout=15000)
                except Exception:
                    page.goto(url, timeout=15000)
                # Let the SPA mount + seed its sample library and settle transitions.
                page.wait_for_timeout(1400)
                # Some screens open by interaction (a library row -> workspace/
                # editor, the Device tab -> device sheet). Tap the selector, then
                # let the target mount + render (3D / WebGL / sheet transitions).
                # A single `click` or an ordered `clicks` sequence (open the
                # editor row, then switch to a specific dock tab, …). Each accepts
                # a Playwright locator string (CSS, or `text=…`, or `a >> b`).
                clicks = shot.get("clicks") or ([shot["click"]] if shot.get("click") else [])
                for sel in clicks:
                    try:
                        page.locator(sel).first.click(timeout=8000)
                        page.wait_for_timeout(shot.get("waitMs", 1500))
                    except Exception as e:  # best-effort; fall back to what's shown
                        print(f"    (click {sel!r} failed: {e})", file=sys.stderr)
                dst = out_dir / f"{sid}.png"
                page.screenshot(path=str(dst))
                suffix = f" + {clicks}" if clicks else ""
                print(f"  captured {sid} <- {route}{suffix}", file=sys.stderr)
                ctx.close()
            browser.close()
    finally:
        httpd.shutdown()


def main() -> int:
    ws = workspace_dir()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--dist",
        default=str(ws / "bazel-bin" / "web" / "dist"),
        help="the built web app (default: bazel-bin/web/dist under the workspace)",
    )
    ap.add_argument("--shots", default=str(ws / "docs" / "user-guide" / "shots.json"))
    ap.add_argument("--out", default=str(ws / "docs" / "user-guide" / "img"))
    args = ap.parse_args()

    dist = Path(args.dist)
    if not (dist / "index.html").exists():
        sys.exit(f"built app not found at {dist} — build it first: bazel build //web:dist")
    shots = json.loads(Path(args.shots).read_text())
    if not shots:
        print("no screenshots requested (empty shots.json)", file=sys.stderr)
        return 0

    ensure_browser()
    print(f"capturing {len(shots)} screenshot(s) from {dist} …", file=sys.stderr)
    capture(dist, shots, Path(args.out))
    print(f"wrote {len(shots)} screenshot(s) to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
