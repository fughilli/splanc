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
import threading


def serve_dir(directory: str, port: int = 0) -> tuple[str, socketserver.TCPServer]:
    """Serve `directory` over HTTP on a background thread. Returns (base_url, server)."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{httpd.server_address[1]}/", httpd


def _find_chromium() -> str:
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
        p = shutil.which(name)
        if p:
            return p
    raise RuntimeError("no chromium/google-chrome on PATH for the browser lane")


def launch_chromium(url: str, user_data_dir: str) -> subprocess.Popen:
    """Launch headless Chromium at `url`. Flags allow the self-signed device cert
    and Web Bluetooth stubs the app never really touches under the driver guard."""
    argv = [
        _find_chromium(),
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        f"--user-data-dir={user_data_dir}",
        "--ignore-certificate-errors",
        "--autoplay-policy=no-user-gesture-required",
        url,
    ]
    return subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


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
