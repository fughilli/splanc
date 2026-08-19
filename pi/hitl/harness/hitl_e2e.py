"""End-to-end HITL test: ImprovBLE setup + rename + time sync on a real board.

Runs against a pool of HITL rigs (the checkout mechanism, pi/hitl/DESIGN.md).
Given a firmware flash-bundle it:

  1. picks a free runner from the pool (via `hitl`) and reserves it;
  2. flashes the bundle and asserts the board boots the app and brings BLE up;
  3. ImprovBLE SETUP — provisions the board onto WiFi over the Improv GATT
     (the rig's Bluetooth adapter; the harness ships hitl_improv.py into the
     reservation and runs it there), capturing the device's redirect URL;
  4. checks TIME SYNC (sane offset/rtt) and RENAME (set_device_name -> welcome
     echoes the new name) over the player's WebSocket — tunneled through the
     reservation's ssh so the DUT is reached FROM the rig (which shares its WiFi
     LAN), not from the harness host;
  5. releases the reservation.

Usage:
    bazel run //pi/hitl/harness:e2e -- \
        --bundle bazel-bin/firmware/player_app/esp32c6_flashbundle.tar \
        --wifi-ssid BigVibes --wifi-pass SECRET

Selection is delegated to the `hitl` CLI: --server picks a specific rig; otherwise
`hitl` chooses the shortest-queue rig among the tailnet nodes tagged
tag:splanc-hitl (or an explicit $HITL_SERVERS list). WiFi defaults to the rig's own
provisioning AP (creds served by the daemon, `hitl wifi`), so no external network
is needed; --wifi-ssid / $HITL_WIFI_SSID override it.

The BLE + WebSocket phases run against the DUT FROM the rig — BLE over the rig's
Bluetooth adapter, the WebSocket over an ssh tunnel whose far end dials the DUT
from the rig's container — so the harness host only needs to reach the rig, not
the DUT's WiFi LAN. Each phase fails loudly with a diagnostic if it can't reach
the board; --skip-* narrows a run while iterating.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import ssl
import sys
import time

from hitl_client import Reservation, ReserveError
from provision import HarnessError as E2EFailure
from provision import dut_target, provision_dut
from sync import best_sample, is_sane, sync_sample

# Boot markers the firmware prints (see pi/hitl/AGENTS.md "A typical E2E test").
BOOT_MARKER = "SPI_FAST_FLASH_BOOT"  # ran the app (not USB download mode)
BLE_MARKER = "[ble] advertising"  # Improv service is up


# --- phases ----------------------------------------------------------------


def flash(res: Reservation, bundle: str, monitor_seconds: float) -> str:
    """scp the bundle, flash + monitor, return the serial log; assert boot + BLE."""
    remote = "/tmp/" + os.path.basename(bundle)
    print(f"[flash] copying {os.path.basename(bundle)} -> {res.host}:{remote}", flush=True)
    res.scp_to([bundle], "/tmp/")
    # --erase-fs: full chip erase so the DUT boots with no stored WiFi creds and
    # exercises the real first-provision path (no auto-join short-circuit) on a
    # clean littlefs. This is the HITL rig; live-device updates keep their state.
    cmd = f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds {monitor_seconds:g}"
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

    # A freshly-provisioned board is still settling its servers: right after it
    # reports PROVISIONED it drops the soft-AP, goes STA-only and re-signs the wss
    # cert, and the LAN/tunnel path is just coming up. After a cold --erase-fs
    # flash it also reformats littlefs first, so this can run well past the old
    # 25s window (that race reddened map_upload in CI). Retry the initial open
    # rather than fail the whole run on that transient; 60s is pure slack.
    print(f"[ws] connecting {ws_url}", flush=True)
    deadline = time.monotonic() + 60.0
    while True:
        try:
            sock = await websockets.connect(ws_url, max_size=2**22, ssl=ssl_ctx, open_timeout=8)
            break
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= deadline:
                raise E2EFailure(f"ws never opened at {ws_url}: {type(e).__name__}: {e}")
            print(f"[ws] not up yet ({type(e).__name__}); retrying…", flush=True)
            await asyncio.sleep(1.5)
    try:
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
    finally:
        await sock.close()


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
    # server=None lets `hitl` pick a free rig from the pool (tailnet tag discovery
    # or $HITL_SERVERS); --server pins a specific one.
    res = Reservation(server=args.server or None, owner=args.owner, device=args.device or None)
    try:
        res.acquire()
        # Default WiFi to the rig's own provisioning AP (creds served by the
        # daemon), so a run needs no external network. Explicit --wifi-ssid wins.
        if not args.wifi_ssid and not args.skip_improv:
            creds = res.wifi()
            if creds:
                args.wifi_ssid, args.wifi_pass = creds
                print(f"[improv] provisioning onto the rig AP {args.wifi_ssid!r}", flush=True)
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
            redirect = provision_dut(res, args.wifi_ssid, args.wifi_pass, args.improv_timeout)

        if not args.skip_ws:
            if args.device_ws:
                # Explicit override: connect straight to a reachable ws(s) URL.
                ws_checks(args.device_ws, args.rename_to, insecure=not args.ws_verify)
            else:
                if not redirect:
                    raise E2EFailure(
                        "no device URL: provision the DUT or pass --device-url/--device-ws"
                    )
                host, port = dut_target(redirect, args.ws_scheme)
                # The DUT is on the rig's WiFi LAN, not the harness host's network,
                # so reach it FROM the rig: tunnel the WS through the reservation's
                # ssh (the far end dials the DUT from the Pi's container).
                with res.forward(host, port) as local_port:
                    ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
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
    ap.add_argument(
        "--server", help="target a specific rig base URL (else `hitl` picks a free one)"
    )
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"), help="reservation owner id")
    ap.add_argument(
        "--device",
        default=os.environ.get("HITL_DEVICE"),
        help="pin a specific DUT by name (e.g. c6-003f08); default: any free DUT on the rig",
    )
    ap.add_argument(
        "--bundle", default=os.environ.get("HITL_BUNDLE"), help="firmware flash-bundle .tar"
    )
    ap.add_argument(
        "--monitor-seconds", type=float, default=12.0, help="serial capture after flashing"
    )
    ap.add_argument(
        "--wifi-ssid",
        default=os.environ.get("HITL_WIFI_SSID"),
        help="WiFi SSID to provision (default: the rig's own AP, via `hitl wifi`)",
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
        "--ws-scheme",
        choices=["ws", "wss"],
        default="wss",
        help="derive wss:443 (the device's real TLS player socket) or ws:81",
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
