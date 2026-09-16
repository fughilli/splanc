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
import tempfile

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
        app_proc = None
        if args.android:
            launcher.launch_android_pwa(args.pwa_url, port)
        else:
            base, _httpd = launcher.serve_dir(_web_dist())
            url = f"{base}?driver=ws://127.0.0.1:{port}/"
            print(f"[phone] launching browser at {url}", flush=True)
            app_proc = launcher.launch_chromium(url, tempfile.mkdtemp(prefix="phone-hitl-"))

        print("[phone] waiting for the app to connect back…", flush=True)
        await drv.wait_ready(timeout=args.ready_timeout)
        print("[phone] app ready — running journeys", flush=True)

        try:
            wanted = args.journeys.split(",") if args.journeys else list(journeys.ALL)
            if "connect" in wanted:
                results["connect"] = await journeys.journey_connect(
                    drv, wss_url=args.device_ws, ssid=args.wifi_ssid, password=args.wifi_pass
                )
                print("[phone] PASS connect", flush=True)
            if "mapping" in wanted:
                results["mapping"] = await journeys.journey_mapping(drv, led_count=args.led_count)
                print("[phone] PASS mapping", flush=True)
            if "config" in wanted:
                results["config"] = await journeys.journey_config(drv)
                print("[phone] PASS config", flush=True)
        finally:
            if app_proc is not None:
                app_proc.terminate()

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
        "--journeys", default="", help="comma list: connect,mapping,config (default all)"
    )
    ap.add_argument("--led-count", type=int, default=30)
    ap.add_argument("--driver-port", type=int, default=0)
    ap.add_argument("--ready-timeout", type=float, default=60.0)
    args = ap.parse_args()
    if not args.device_ws and (not args.journeys or "connect" in args.journeys):
        print(
            "note: --device-ws not set; connect/mapping/config need a device backend",
            file=sys.stderr,
        )
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
