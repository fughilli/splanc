"""End-to-end HITL test: ImprovBLE setup + rename + time sync on a real board.

Runs against a pool of HITL rigs (the checkout mechanism, pi/hitl/DESIGN.md).
Given a firmware flash-bundle it:

  1. picks a free runner from the pool (HITL_SERVERS) and reserves it;
  2. flashes the bundle and asserts the board boots the app and brings BLE up;
  3. ImprovBLE SETUP — provisions the board onto WiFi over the Improv GATT
     (the rig's Bluetooth adapter; the harness ships hitl_improv.py into the
     reservation and runs it there), capturing the device's redirect URL;
  4. connects to the player's WebSocket and checks TIME SYNC (sane offset/rtt)
     and RENAME (set_device_name -> welcome echoes the new name);
  5. releases the reservation.

Usage:
    bazel run //pi/hitl/harness:e2e -- \
        --bundle bazel-bin/firmware/player_app/esp32c6_flashbundle.tar \
        --wifi-ssid BigVibes --wifi-pass SECRET

Selection: --server picks a specific rig; otherwise HITL_SERVERS / HITL_SERVER
drive hitl_pool. WiFi creds default to $HITL_WIFI_SSID / $HITL_WIFI_PASS.

The BLE + WebSocket phases need real hardware and network reachability to the
DUT (the harness host must route to the device's WiFi address — e.g. the rig is
a tailnet subnet router, or CI joins the test LAN). Each phase fails loudly with
a diagnostic if it can't reach the board; --skip-* narrows a run while iterating.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import ssl
import sys
import time
from urllib.parse import urlparse

import hitl_pool
from hitl_client import Reservation, ReserveError
from sync import best_sample, is_sane, sync_sample

# Boot markers the firmware prints (see pi/hitl/AGENTS.md "A typical E2E test").
BOOT_MARKER = "SPI_FAST_FLASH_BOOT"  # ran the app (not USB download mode)
BLE_MARKER = "[ble] advertising"  # Improv service is up


class E2EFailure(RuntimeError):
    pass


def ws_url_from_redirect(redirect: str, scheme: str) -> str:
    """Device redirect (http://<ip>/) -> its player WS endpoint.

    Mirrors web/src/net/improv.ts wsUrlFromRedirect: the TLS app talks
    wss://<ip>/ws; the bench path is the plain ws://<ip>:81/ws socket.
    """
    host = urlparse(redirect).hostname
    if not host:
        raise E2EFailure(f"could not parse a host from redirect URL {redirect!r}")
    return f"wss://{host}/ws" if scheme == "wss" else f"ws://{host}:81/ws"


# --- phases ----------------------------------------------------------------


def flash(res: Reservation, bundle: str, monitor_seconds: float) -> str:
    """scp the bundle, flash + monitor, return the serial log; assert boot + BLE."""
    remote = "/tmp/" + os.path.basename(bundle)
    print(f"[flash] copying {os.path.basename(bundle)} -> {res.host}:{remote}", flush=True)
    res.scp_to([bundle], "/tmp/")
    cmd = f"hitl-flash {remote} --monitor --monitor-seconds {monitor_seconds:g}"
    print(f"[flash] {cmd}", flush=True)
    proc = res.ssh(cmd, capture=True, timeout=monitor_seconds + 120)
    log = (proc.stdout or "") + (proc.stderr or "")
    sys.stdout.write(log)
    if proc.returncode != 0:
        raise E2EFailure(f"hitl-flash exited {proc.returncode}")
    if BOOT_MARKER not in log:
        raise E2EFailure(f"board did not boot from flash (no {BOOT_MARKER!r} in serial)")
    if BLE_MARKER not in log:
        raise E2EFailure(f"BLE never came up (no {BLE_MARKER!r} in serial)")
    print("[flash] OK — booted the app and BLE is advertising", flush=True)
    return log


# The BLE provisioner + its wire codec run in the container (which has bleak and
# the host bluetoothd). We ship them per-reservation rather than baking a tool
# into the image, so the test doesn't depend on the rig image being redeployed
# in lockstep. Both live next to this file (harness srcs → e2e runfiles).
_HERE = os.path.dirname(os.path.abspath(__file__))
_PROVISIONER = os.path.join(_HERE, "hitl_improv.py")
_CODEC = os.path.join(_HERE, "improv.py")


def improv_provision(res: Reservation, ssid: str, password: str, timeout: float) -> str:
    """Provision the DUT onto WiFi over ImprovBLE; return its redirect URL."""
    print("[improv] shipping provisioner + provisioning DUT over BLE…", flush=True)
    res.scp_to([_PROVISIONER, _CODEC], "/tmp/")
    # Run with the container's python3 (has bleak); PYTHONPATH lets the shipped
    # hitl_improv import the shipped improv codec.
    cmd = (
        f"PYTHONPATH=/tmp python3 /tmp/hitl_improv.py provision "
        f"--ssid {json.dumps(ssid)} --pass {json.dumps(password)} --timeout {timeout:g}"
    )
    proc = res.ssh(cmd, capture=True, timeout=timeout + 60)
    out = (proc.stdout or "").strip()
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    if proc.returncode != 0:
        raise E2EFailure(f"provisioner exited {proc.returncode}: {out}")
    try:
        result = json.loads(out.splitlines()[-1])
    except (ValueError, IndexError) as e:
        raise E2EFailure(f"provisioner gave no JSON result: {out!r}") from e
    if not result.get("ok"):
        raise E2EFailure(f"ImprovBLE provisioning failed: {result.get('error')}")
    urls = result.get("urls") or []
    if not urls:
        raise E2EFailure(f"provisioning reported no redirect URL: {result}")
    print(f"[improv] OK — DUT joined WiFi, redirect={urls[0]}", flush=True)
    return urls[0]


async def _ws_checks(ws_url: str, new_name: str, insecure: bool) -> None:
    import websockets
    from server import proto_wire

    ssl_ctx = None
    if ws_url.startswith("wss:"):
        ssl_ctx = ssl.create_default_context()
        if insecure:  # the device presents a self-signed cert
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE

    async def rpc(sock, flat: dict, expect: str) -> dict:
        await sock.send(proto_wire.encode_client(flat))
        reply = proto_wire.decode_server(await asyncio.wait_for(sock.recv(), timeout=5.0))
        if reply.get("type") != expect:
            raise E2EFailure(f"{flat['type']}: expected {expect}, got {reply}")
        return reply

    print(f"[ws] connecting {ws_url}", flush=True)
    async with websockets.connect(ws_url, max_size=2**22, ssl=ssl_ctx) as sock:
        welcome = await rpc(
            sock, {"type": "hello", "client": "hitl-e2e", "appVersion": "0"}, "welcome"
        )
        print(f"[ws] welcome: device_name={welcome.get('deviceName')!r}", flush=True)

        # TIME SYNC — three pings, keep the min-RTT sample, assert it's sane.
        samples = []
        for _ in range(3):
            t0 = time.monotonic() * 1000.0
            pong = await rpc(sock, {"type": "time_sync_ping", "t0": t0}, "time_sync_pong")
            t3 = time.monotonic() * 1000.0
            samples.append(sync_sample(t0, pong["t1"], pong["t2"], t3))
        best = best_sample(samples)
        if not is_sane(best):
            raise E2EFailure(f"time sync produced an implausible sample: {best}")
        print(
            f"[ws] TIME SYNC OK — offset~{best.offset_ms:.1f}ms rtt={best.rtt_ms:.1f}ms", flush=True
        )

        # RENAME — set_device_name replies with a welcome echoing the new name.
        echo = await rpc(sock, {"type": "set_device_name", "name": new_name}, "welcome")
        got = echo.get("deviceName")
        if got != new_name:
            raise E2EFailure(f"rename not echoed: asked {new_name!r}, welcome says {got!r}")
        print(f"[ws] RENAME OK — device reports name={got!r}", flush=True)


def ws_checks(ws_url: str, new_name: str, insecure: bool) -> None:
    asyncio.run(_ws_checks(ws_url, new_name, insecure))


# --- driver ----------------------------------------------------------------

# The flash-bundle is a data dep of this target, so `bazel run` ships it in
# runfiles (no separate build / workspace-relative path needed).
_BUNDLE_RUNFILE = "_main/firmware/player_app/esp32c6_flashbundle.tar"


def default_bundle() -> str | None:
    """Locate the flash-bundle in this binary's runfiles, if present."""
    try:
        from python.runfiles import runfiles

        path = runfiles.Create().Rlocation(_BUNDLE_RUNFILE)
    except Exception:
        return None
    return path if path and os.path.exists(path) else None


def run(args: argparse.Namespace) -> int:
    base = args.server or hitl_pool.pick()
    res = Reservation(base, owner=args.owner)
    try:
        res.acquire()
        if not args.skip_flash:
            bundle = args.bundle or default_bundle()
            if not bundle:
                raise E2EFailure("no flash-bundle in runfiles; pass --bundle or --skip-flash")
            flash(res, bundle, args.monitor_seconds)

        redirect = args.device_url
        if not args.skip_improv:
            if not args.wifi_ssid:
                raise E2EFailure(
                    "--wifi-ssid (or $HITL_WIFI_SSID) is required unless --skip-improv"
                )
            redirect = improv_provision(res, args.wifi_ssid, args.wifi_pass, args.improv_timeout)

        if not args.skip_ws:
            if not redirect:
                raise E2EFailure("no device URL: provision the DUT or pass --device-url")
            ws_url = args.device_ws or ws_url_from_redirect(redirect, args.ws_scheme)
            ws_checks(ws_url, args.rename_to, insecure=not args.ws_verify)
    except (E2EFailure, ReserveError) as e:
        print(f"\nFAIL: {e}", file=sys.stderr)
        return 1
    finally:
        res.release()
    print("\nPASS — ImprovBLE setup, rename, and time sync all checked out", flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--server", help="target a specific rig base URL (else pick from HITL_SERVERS)")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"), help="reservation owner id")
    ap.add_argument(
        "--bundle", default=os.environ.get("HITL_BUNDLE"), help="firmware flash-bundle .tar"
    )
    ap.add_argument(
        "--monitor-seconds", type=float, default=12.0, help="serial capture after flashing"
    )
    ap.add_argument(
        "--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID"), help="WiFi SSID to provision"
    )
    ap.add_argument(
        "--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""), help="WiFi password"
    )
    ap.add_argument("--improv-timeout", type=float, default=60.0, help="seconds to await the join")
    ap.add_argument(
        "--device-url", help="skip provisioning; use this http://<ip>/ redirect directly"
    )
    ap.add_argument("--device-ws", help="override the derived WS URL entirely (e.g. ws://ip:81/ws)")
    ap.add_argument(
        "--ws-scheme", choices=["ws", "wss"], default="ws", help="derive ws:81 or wss:443"
    )
    ap.add_argument(
        "--ws-verify",
        action="store_true",
        help="verify the DUT's TLS cert (default: accept self-signed)",
    )
    ap.add_argument(
        "--rename-to", default=f"HITL Test {int(time.time()) % 100000}", help="name to set"
    )
    ap.add_argument("--skip-flash", action="store_true")
    ap.add_argument("--skip-improv", action="store_true")
    ap.add_argument("--skip-ws", action="store_true")
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
