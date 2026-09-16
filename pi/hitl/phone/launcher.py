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
import platform
import shutil
import socketserver
import subprocess
import sys
import threading
import time


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


# --- Android lane -----------------------------------------------------------
# Tools come from the Nix targets (no ad-hoc SDK install): adb from @android_tools
# (//pi/hitl/phone:adb), and the emulator + system image + cmdline-tools from the
# @android_emulator composed SDK (//pi/hitl/phone:android_emulator — macOS/linux-x86_64).
# On the station, point ANDROID_SDK_ROOT at that SDK's libexec/android-sdk tree; adb +
# emulator + avdmanager resolve from it (PATH is the fallback). See the station README.

AVD_NAME = os.environ.get("PHONE_AVD", "phone-hitl")
# Native-ABI guest for a fast emulator (matches the SDK's bundled system image, which
# android-emulator.nix picks by host arch): arm64-v8a on ARM (Apple Silicon Mac / arm64
# Linux), x86_64 on x86_64.
_ABI = "arm64-v8a" if platform.machine() in ("arm64", "aarch64") else "x86_64"
SYSTEM_IMAGE = os.environ.get("PHONE_SYSTEM_IMAGE", f"system-images;android-34;google_apis;{_ABI}")


def _sdk_root() -> str | None:
    return os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME")


def _sdk_tool(rel: str, name: str) -> str:
    """Resolve an SDK tool: $ANDROID_SDK_ROOT/<rel>/<name>, else $<NAME>, else PATH."""
    root = _sdk_root()
    if root:
        p = os.path.join(root, rel, name)
        if os.path.exists(p):
            return p
    env = os.environ.get(name.upper())
    if env and os.path.exists(env):
        return env
    found = shutil.which(name)
    if found:
        return found
    raise RuntimeError(
        f"{name!r} not found — set ANDROID_SDK_ROOT to the Nix Android SDK "
        "(bazel build //pi/hitl/phone:android_emulator, on macOS or a linux-x86_64 station)"
    )


def adb(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [_sdk_tool("platform-tools", "adb"), *args], capture_output=True, text=True, check=False
    )


def ensure_avd() -> None:
    """Create the station AVD from the bundled system image if it doesn't exist."""
    avdmanager = _sdk_tool("cmdline-tools/latest/bin", "avdmanager")
    listing = subprocess.run(
        [avdmanager, "list", "avd"], capture_output=True, text=True, check=False
    )
    if AVD_NAME in listing.stdout:
        return
    subprocess.run(
        [
            avdmanager,
            "create",
            "avd",
            "-n",
            AVD_NAME,
            "-k",
            SYSTEM_IMAGE,
            "--device",
            "pixel",
            "-f",
        ],
        input="no\n",
        capture_output=True,
        text=True,
        check=True,
    )


def boot_android_avd() -> subprocess.Popen:
    """Create (if needed) + boot the station AVD headless; wait for boot_completed."""
    ensure_avd()
    emulator = _sdk_tool("emulator", "emulator")
    proc = subprocess.Popen(
        [
            emulator,
            "-avd",
            AVD_NAME,
            "-no-window",
            "-no-audio",
            "-no-boot-anim",
            "-gpu",
            "swiftshader_indirect",
            "-accel",
            "auto",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    adb("wait-for-device")
    for _ in range(120):  # wait for a full boot (system server up)
        if adb("shell", "getprop", "sys.boot_completed").stdout.strip() == "1":
            break
        time.sleep(2)
    return proc


def launch_android_pwa(pwa_url: str, driver_port: int) -> None:
    """Open the PWA in the emulator's browser with ?driver= pointing at the station
    (reachable from the emulator as 10.0.2.2 — its host-loopback alias)."""
    url = f"{pwa_url}?driver=ws://10.0.2.2:{driver_port}/"
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url)
