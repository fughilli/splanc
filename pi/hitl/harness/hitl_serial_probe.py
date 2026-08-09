"""HITL serial probe: capture the DUT console across the wss restart.

Diagnostic (not a pass/fail test) for the post-provision TLS wedge — the
ConnectionResetError storms map_upload/e2e hit right after a device joins WiFi.
It flashes (optionally), starts a background serial monitor on the rig, then
provisions over ImprovBLE and hammers the wss open the way map_upload/e2e do, so
the serial trace spans boot -> WiFi join -> LAN-cert reissue -> httpd_ssl
restart, which is exactly where the resets begin. Run it via the shim:

    curl -N 'http://<host>:8091/run?target=//pi/hitl/harness:serial_probe'

Provisions with a single improv attempt (no reset-retry) so the serial monitor
stays attached to the port the whole time.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import ssl
import subprocess
import threading
import time


def _log(msg: str) -> None:
    print(msg, flush=True)


def default_flashbundle() -> str | None:
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation("_main/firmware/player_app/esp32c6_flashbundle.tar")
    except Exception:
        return None


def _serial_stream(res, seconds: float, stop: threading.Event) -> None:
    """Stream `hitl-monitor --seconds N` line-by-line, prefixed, until it ends."""
    argv = [
        *res._hitl,
        "run",
        *res._attach(),
        "--",
        "sh",
        "-c",
        f"hitl-monitor --seconds {seconds:g}",
    ]
    try:
        proc = subprocess.Popen(
            argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
        )
    except OSError as e:
        _log(f"[serial] cannot start monitor: {e}")
        return
    assert proc.stdout is not None
    for line in proc.stdout:
        _log(f"[serial] {line.rstrip()}")
        if stop.is_set():
            break
    proc.wait()


async def _probe_ws(ws_url: str, insecure: bool, seconds: float) -> bool:
    """Retry the wss open for `seconds`, logging every attempt's outcome so the
    reset storm lines up against the serial trace."""
    import websockets

    ssl_ctx = None
    if ws_url.startswith("wss:"):
        ssl_ctx = ssl.create_default_context()
        if insecure:
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE
    deadline = time.monotonic() + seconds
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        try:
            sock = await websockets.connect(ws_url, ssl=ssl_ctx, open_timeout=8)
            _log(f"[ws] OPENED on attempt {attempt}")
            await sock.close()
            return True
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            _log(f"[ws] attempt {attempt}: {type(e).__name__}: {e}")
            await asyncio.sleep(1.5)
    _log(f"[ws] never opened in {seconds:g}s ({attempt} attempts)")
    return False


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL serial probe for the post-provision wss wedge")
    ap.add_argument("--server", help="pin a specific rig (else pool discovery)")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument(
        "--bundle", default=default_flashbundle(), help="flash-bundle tar (default: runfiles)"
    )
    ap.add_argument("--no-bundle", dest="bundle", action="store_const", const=None)
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID"))
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    ap.add_argument("--ws-scheme", choices=["ws", "wss"], default="wss")
    ap.add_argument(
        "--ws-verify", action="store_true", help="verify TLS (default: accept self-signed)"
    )
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--monitor-seconds", type=float, default=20.0, help="serial read during flash")
    ap.add_argument("--serial-seconds", type=float, default=150.0, help="background serial capture")
    ap.add_argument(
        "--connect-seconds", type=float, default=80.0, help="how long to hammer the wss open"
    )
    args = ap.parse_args()
    insecure = not args.ws_verify

    from hitl_client import Reservation
    from provision import dut_target, provision_dut, reserved_board_ble_mac

    res = Reservation(server=args.server, owner=args.owner)
    res.acquire()
    try:
        ssid, password = args.wifi_ssid, args.wifi_pass
        if not ssid:
            creds = res.wifi()
            if creds:
                ssid, password = creds
                _log(f"[probe] using rig AP {ssid!r}")

        if args.bundle:
            _log(f"[flash] {os.path.basename(args.bundle)} -> {res.host}")
            res.scp_to([args.bundle], "/tmp/")
            res.ssh(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs "
                f"--monitor --monitor-seconds {args.monitor_seconds:g}",
                capture=True,
                timeout=args.monitor_seconds + 120,
            )

        if not ssid:
            raise SystemExit("no WiFi: rig serves no AP; pass --wifi-ssid")

        # Read the reserved board's BLE MAC first (this resets + reads its
        # serial); then pin provisioning to it so we can't latch a stray board.
        mac = reserved_board_ble_mac(res)
        _log(f"[probe] reserved board BLE MAC: {mac}")

        # Start capturing serial BEFORE provisioning so the trace includes the
        # WiFi join, the LAN-cert reissue, and the httpd_ssl restart.
        stop = threading.Event()
        mon = threading.Thread(
            target=_serial_stream, args=(res, args.serial_seconds, stop), daemon=True
        )
        mon.start()
        time.sleep(2)  # let the monitor attach to the port

        _log("[probe] provisioning (1 improv attempt; no reset so serial stays attached)…")
        redirect = provision_dut(res, ssid, password, args.improv_timeout, attempts=1, address=mac)
        host, port = dut_target(redirect, args.ws_scheme)
        with res.forward(host, port) as local_port:
            ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
            _log(f"[probe] hammering {ws_url} for {args.connect_seconds:g}s while serial streams…")
            asyncio.run(_probe_ws(ws_url, insecure, args.connect_seconds))

        stop.set()
        mon.join(timeout=10)
    finally:
        res.release()


if __name__ == "__main__":
    main()
