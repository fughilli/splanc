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
import contextlib
import os
import socket
import sys

import launcher
from driver_server import AppDriver
from journey_runner import load_journeys, run_journey
from mock_device import MockDeviceServer


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _journeys_dir() -> str:
    """Locate the JSON journey data dir (next to this file, or in runfiles)."""
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "journeys")
    if os.path.isdir(here):
        return here
    try:
        from python.runfiles import runfiles  # type: ignore

        p = runfiles.Create().Rlocation("_main/pi/hitl/phone/journeys")
        if p and os.path.isdir(p):
            return p
    except Exception:  # noqa: BLE001
        pass
    raise SystemExit("journeys/ dir not found")


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
    async with contextlib.AsyncExitStack() as stack:
        drv = await stack.enter_async_context(AppDriver.serve(port))
        # Optional self-contained device backend (no rig): a mock speaking the proto.
        if args.mock_device and not args.device_ws:
            mock = await stack.enter_async_context(MockDeviceServer())
            args.device_ws = mock.url
            print(f"[phone] mock device at {mock.url}", flush=True)
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

        registry = load_journeys(_journeys_dir())
        context = {
            "device_ws": args.device_ws,
            "ssid": args.wifi_ssid,
            "password": args.wifi_pass,
            "led_count": args.led_count,
        }
        try:
            wanted = args.journeys.split(",") if args.journeys else ["connect", "config"]
            for name in wanted:
                journey = registry.get(name)
                if journey is None:
                    raise SystemExit(f"no journey {name!r} in {_journeys_dir()}")
                results[name] = await run_journey(drv, journey, registry, context)
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
        help="device wss URL (rig-forwarded C6); overrides --mock-device",
    )
    ap.add_argument(
        "--mock-device",
        action="store_true",
        help="spin up a self-contained mock device backend (no rig) and point the app at it",
    )
    ap.add_argument(
        "--reservation",
        action="store_true",
        help="reserve + flash + provision a REAL ESP32-C6 on the rig and point the app at it",
    )
    ap.add_argument("--hitl-server", default=os.environ.get("HITL_SERVER"), help="pin a rig")
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
    if not args.device_ws and not args.mock_device and not args.reservation and needs_device:
        print(
            "note: no device backend; connect/mapping/config need one "
            "(pass --mock-device, --reservation, --device-ws <rig C6>, or run --journeys smoke)",
            file=sys.stderr,
        )
    with contextlib.ExitStack() as stack:
        # Real rig C6: reserve + flash + provision + forward BEFORE the async run; the
        # tunnel/heartbeat live in their own subprocess/thread, so they survive it.
        if args.reservation and not args.device_ws:
            from reservation_backend import ReservationBackend

            args.device_ws = stack.enter_context(ReservationBackend(server=args.hitl_server))
        if not args.android:
            launcher.ensure_chromium()  # sync context, before the asyncio loop
        return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
