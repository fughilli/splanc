"""Phone-in-the-loop HITL runner: launch the app in a target, drive the three basic
user journeys over the app-driver channel, assert on the app's real replies.

MVP lanes:
  --browser   headless Chromium serving the built web app (Phase 0 walking skeleton)
  --android   the PWA in a booted Android emulator (Phase 1)

Device backend: pass --device-ws wss://host/ws to point the app's device connection
at an already-reachable ESP32-C6 (e.g. a rig-forwarded port) or a mock. The full
auto-reserve + provision + res.forward() path (reusing hitl_client.Reservation) is
the Phase-3 follow-up; keeping --device-ws makes the loop runnable today.

  bazel run //pi/hitl/phone:phone_e2e -- --browser --device-ws wss://127.0.0.1:8443/ws
"""

from __future__ import annotations

import argparse
import asyncio
import os
import socket
import sys

import journeys
import launcher
from driver_server import AppDriver


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _web_dist() -> str:
    """Locate the built web app (runfiles data dep, or $HITL_WEB_DIST)."""
    env = os.environ.get("HITL_WEB_DIST")
    if env and os.path.isdir(env):
        return env
    try:
        from python.runfiles import runfiles  # type: ignore

        p = runfiles.Create().Rlocation("_main/web/dist")
        if p and os.path.isdir(p):
            return p
    except Exception:  # noqa: BLE001
        pass
    raise SystemExit("web app not found: set $HITL_WEB_DIST or add //web:dist as a data dep")


async def run(args: argparse.Namespace) -> int:
    port = args.driver_port or _free_port()
    results: dict[str, object] = {}
    async with AppDriver.serve(port) as drv:
        # Bring the app up pointed at us.
        pw = browser = None
        if args.android:
            launcher.launch_android_pwa(args.pwa_url, port)
        else:
            base, _httpd = launcher.serve_dir(_web_dist())
            url = f"{base}?driver=ws://127.0.0.1:{port}/"
            print(f"[phone] launching browser at {url}", flush=True)
            pw, browser = await launcher.open_chromium(url)

        print("[phone] waiting for the app to connect back…", flush=True)
        await drv.wait_ready(timeout=args.ready_timeout)
        print("[phone] app ready — running journeys", flush=True)

        try:
            wanted = args.journeys.split(",") if args.journeys else ["connect", "mapping", "config"]
            for name in wanted:
                fn = journeys.ALL[name]
                if name == "connect":
                    results[name] = await fn(
                        drv, wss_url=args.device_ws, ssid=args.wifi_ssid, password=args.wifi_pass
                    )
                elif name == "mapping":
                    results[name] = await fn(drv, led_count=args.led_count)
                else:
                    results[name] = await fn(drv)
                print(f"[phone] PASS {name}", flush=True)
        finally:
            if browser is not None:
                await browser.close()
            if pw is not None:
                await pw.stop()

    print("[phone] ALL JOURNEYS PASSED", flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    lane = ap.add_mutually_exclusive_group()
    lane.add_argument("--browser", action="store_true", help="headless Chromium lane (default)")
    lane.add_argument("--android", action="store_true", help="Android emulator PWA lane")
    ap.add_argument(
        "--pwa-url",
        default=os.environ.get("PHONE_PWA_URL", ""),
        help="deployed PWA URL (android lane)",
    )
    ap.add_argument(
        "--device-ws",
        default=os.environ.get("PHONE_DEVICE_WS", ""),
        help="device wss URL (rig-forwarded C6 or mock)",
    )
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID", "FugLink"))
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    ap.add_argument(
        "--journeys",
        default="",
        help="comma list: smoke,connect,mapping,config (default all but smoke)",
    )
    ap.add_argument("--led-count", type=int, default=30)
    ap.add_argument("--driver-port", type=int, default=0)
    ap.add_argument("--ready-timeout", type=float, default=60.0)
    args = ap.parse_args()
    needs_device = any(
        j in (args.journeys or "connect,mapping,config") for j in ("connect", "mapping", "config")
    )
    if not args.device_ws and needs_device:
        print(
            "note: --device-ws not set; connect/mapping/config need a device backend "
            "(use --journeys smoke for a device-free check)",
            file=sys.stderr,
        )
    if not args.android:
        launcher.ensure_chromium()  # sync context, before the asyncio loop
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
