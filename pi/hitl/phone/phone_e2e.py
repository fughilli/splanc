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
import tempfile

import launcher
from driver_server import AppDriver
from journey_runner import load_journeys, run_journey
from mock_device import MockDeviceServer
from phone_target import StationPorts, make_target


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


def _solver_web() -> str | None:
    """Locate the phone-solver deployment (worker.js + wasm), served at /solver/."""
    env = os.environ.get("HITL_SOLVER_WEB")
    if env and os.path.isdir(env):
        return env
    try:
        from python.runfiles import runfiles  # type: ignore

        p = runfiles.Create().Rlocation("_main/solver/solver_web")
        if p and os.path.isdir(p):
            return p
    except Exception:  # noqa: BLE001
        pass
    return None


_MERGED_ROOT: str | None = None


def _serve_root() -> str:
    """A serve root that is the built web app with the solver bundle mounted at
    /solver/ — the way the real Pi server stages them side by side. The deep
    mapping journey's on-device solve loads /solver/worker.js + wasm from here;
    //web:dist alone doesn't carry them. Assembled once via symlinks."""
    global _MERGED_ROOT
    if _MERGED_ROOT is not None:
        return _MERGED_ROOT
    dist = _web_dist()
    solver = _solver_web()
    if solver is None:
        # No solver bundle available — serve the app as-is (the on-device solve
        # will 404 and the deep capture journey will fail; the RPC journeys run).
        _MERGED_ROOT = dist
        return dist
    root = tempfile.mkdtemp(prefix="phone-hitl-web-")
    for entry in os.listdir(dist):
        os.symlink(os.path.join(dist, entry), os.path.join(root, entry))
    os.symlink(solver, os.path.join(root, "solver"))
    _MERGED_ROOT = root
    return root


def _device_port(device_ws: str) -> int:
    """The local port of a 127.0.0.1 device wss, so the target can make it reachable
    from the phone (adb reverse / rewrite). 0 when there's no local device backend."""
    import urllib.parse

    try:
        u = urllib.parse.urlparse(device_ws)
        if u.hostname in ("127.0.0.1", "localhost") and u.port:
            return u.port
    except Exception:  # noqa: BLE001
        pass
    return 0


async def run(args: argparse.Namespace, target) -> int:
    port = args.driver_port or _free_port()
    results: dict[str, object] = {}
    async with contextlib.AsyncExitStack() as stack:
        drv = await stack.enter_async_context(AppDriver.serve(port))
        # Optional self-contained device backend (no rig): a mock speaking the proto.
        if args.mock_device and not args.device_ws:
            mock = await stack.enter_async_context(MockDeviceServer())
            args.device_ws = mock.url
            print(f"[phone] mock device at {mock.url}", flush=True)
        base, _httpd = launcher.serve_dir(_serve_root())
        http_port = int(base.rstrip("/").rsplit(":", 1)[1])
        ports = StationPorts(http=http_port, driver=port, device=_device_port(args.device_ws))
        # The target makes the station reachable from the phone's vantage point and
        # rewrites the device wss accordingly (loopback / 10.0.2.2 / LAN / adb reverse).
        target.setup(ports)
        device_ws = target.rewrite_device_ws(args.device_ws)
        print(
            f"[phone] target={target.name} ble={target.ble_mode} "
            f"app={target.app_url(ports)} device_ws={device_ws or '(none)'}",
            flush=True,
        )
        await target.launch(ports)
        try:
            print("[phone] waiting for the app to connect back…", flush=True)
            await drv.wait_ready(timeout=args.ready_timeout)
            print("[phone] app ready — running journeys", flush=True)

            registry = load_journeys(_journeys_dir())
            context = {
                "device_ws": device_ws,
                "ssid": args.wifi_ssid,
                "password": args.wifi_pass,
                "led_count": args.led_count,
            }
            wanted = args.journeys.split(",") if args.journeys else ["connect", "config"]
            for name in wanted:
                journey = registry.get(name)
                if journey is None:
                    raise SystemExit(f"no journey {name!r} in {_journeys_dir()}")
                results[name] = await run_journey(drv, journey, registry, context)
                print(f"[phone] PASS {name}", flush=True)
        finally:
            await target.close()

    print("[phone] ALL JOURNEYS PASSED", flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    lane = ap.add_mutually_exclusive_group()
    lane.add_argument("--browser", action="store_true", help="headless Chromium lane (default)")
    lane.add_argument("--android", action="store_true", help="Android emulator PWA lane")
    ap.add_argument(
        "--phone-target",
        default="",
        help="explicit target: browser|android-emu|android-phone|ios-sim|ios-phone "
        "(else $HITL_PHONE_TARGET, else browser). Overrides --browser/--android.",
    )
    ap.add_argument(
        "--ble-mode",
        default="",
        choices=["", "virtual", "real"],
        help="override the target's BLE mode (e.g. real BLE on the emulator lane)",
    )
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
    # Select the phone target: explicit flag wins, then --browser/--android, then env.
    spec = args.phone_target or (
        "android-emu" if args.android else "browser" if args.browser else None
    )
    target = make_target(spec, ble_mode=args.ble_mode or None)

    with contextlib.ExitStack() as stack:
        # Real rig C6: reserve + flash + provision + forward BEFORE the async run; the
        # tunnel/heartbeat live in their own subprocess/thread, so they survive it.
        if args.reservation and not args.device_ws:
            from reservation_backend import ReservationBackend

            args.device_ws = stack.enter_context(ReservationBackend(server=args.hitl_server))
        if target.name == "browser":
            launcher.ensure_chromium()  # sync context, before the asyncio loop
        return asyncio.run(run(args, target))


if __name__ == "__main__":
    sys.exit(main())
