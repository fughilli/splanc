"""Bring the app up in a target (headless browser now; Android emulator next),
pointed at the app-driver control WS.

Browser lane: serve the built web app locally and launch headless Chromium at
`<app>/?driver=ws://127.0.0.1:<port>/`. Android lane: boot an AVD and `adb` an
intent to open the PWA URL with the same `?driver=` (the emulator reaches the
station host as 10.0.2.2). iOS lane (later) reuses tools/ios_build_server.py.
"""

from __future__ import annotations

import functools
import http.server
import os
import shutil
import socketserver
import subprocess
import sys
import threading


def serve_dir(directory: str, port: int = 0) -> tuple[str, socketserver.TCPServer]:
    """Serve `directory` over HTTP on a background thread. Returns (base_url, server)."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{httpd.server_address[1]}/", httpd


def ensure_chromium() -> None:
    """Make sure Playwright's Chromium is available; install it once if not (needs
    network the first time, like the docs capturer). Call from a SYNC context — not
    inside the asyncio loop — since it uses the sync Playwright API to probe."""
    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as p:
            p.chromium.launch(headless=True).close()
        return
    except Exception:  # noqa: BLE001 — not installed / launch failed → install below
        pass
    print("Installing Chromium for Playwright (one-time)…", file=sys.stderr)
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(x for x in sys.path if x))
    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True, env=env)


async def open_chromium(url: str):
    """Launch headless Chromium and navigate to `url` (the app connects back to the
    driver WS on load). Returns (playwright, browser); the caller closes both."""
    from playwright.async_api import async_playwright

    pw = await async_playwright().start()
    browser = await pw.chromium.launch(
        headless=True, args=["--no-sandbox", "--ignore-certificate-errors"]
    )
    page = await browser.new_page()
    await page.goto(url)
    return pw, browser


# --- Android lane (Phase 1) ------------------------------------------------


def adb(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["adb", *args], capture_output=True, text=True, check=False)


def launch_android_pwa(pwa_url: str, driver_port: int) -> None:
    """Open the PWA in the emulator's browser with ?driver= pointing at the station
    (reachable from the emulator as 10.0.2.2). Assumes an AVD is already booted and
    `adb` sees it (the e2e runner boots it)."""
    url = f"{pwa_url}?driver=ws://10.0.2.2:{driver_port}/"
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url)


def boot_android_avd(avd: str) -> subprocess.Popen:
    """Start an emulator for `avd` headless and wait for boot_completed."""
    emulator = shutil.which("emulator") or os.path.expanduser("~/Android/Sdk/emulator/emulator")
    proc = subprocess.Popen(
        [emulator, "-avd", avd, "-no-window", "-no-audio", "-gpu", "swiftshader_indirect"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    adb("wait-for-device")
    return proc
