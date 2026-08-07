"""HITL reproduction: does renaming a device wedge its wss:443 server?

Repro for the field report (FUG-85 follow-up): after a rename the device
re-issues its self-signed cert (SAN tracks the hostname) and restarts the TLS
server; on the reporter's board every subsequent wss handshake then returns 0
bytes ("ERR_CONNECTION_RESET" / "No serial data received"), which looks like the
C6 failing to allocate the ~28 KB mbedTLS session (heap).

Flow: reserve -> flash -> Improv-provision onto the rig AP -> connect wss ->
read the welcome + heap -> set_device_name (rename) -> then, with the serial
monitor capturing the whole time, hammer wss reconnects for a window and see
whether TLS recovers or wedges. The serial log (the `[wss]` re-issue lines carry
free heap) is dumped at the end so we can read the allocation state directly.

Like the other on-hardware drivers this is `bazel run`, never `bazel test`.

    bazel run //pi/hitl/harness:rename_wss
    bazel run //pi/hitl/harness:rename_wss -- --device-ws wss://<ip>/ws --insecure
"""

from __future__ import annotations

import argparse
import asyncio
import os
import ssl
import threading
import time
from typing import Any

from python.runfiles import runfiles


def _log(msg: str) -> None:
    print(msg, flush=True)


def default_flashbundle() -> str | None:
    try:
        return runfiles.Create().Rlocation("_main/firmware/player_app/esp32c6_flashbundle.tar")
    except Exception:
        return None


async def _rpc(sock, flat: dict[str, Any], expect: str, timeout: float = 15.0) -> dict[str, Any]:
    from server import proto_wire

    await sock.send(proto_wire.encode_client(flat))
    while True:
        raw = await asyncio.wait_for(sock.recv(), timeout=timeout)
        msg = proto_wire.decode_server(raw)
        if msg.get("type") == expect:
            return msg
        if msg.get("type") == "error":
            raise RuntimeError(f"device error to {flat.get('type')}: {msg}")


def _ssl_ctx(ws_url: str, insecure: bool):
    if not ws_url.startswith("wss:"):
        return None
    ctx = ssl.create_default_context()
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def _connect_once(ws_url: str, insecure: bool):
    """One wss connect + hello/welcome. Returns (sock, welcome) or raises."""
    import websockets

    sock = await websockets.connect(
        ws_url, max_size=2**22, ssl=_ssl_ctx(ws_url, insecure), open_timeout=8
    )
    welcome = await _rpc(
        sock, {"type": "hello", "client": "rename_wss", "app_version": "1"}, "welcome"
    )
    return sock, welcome


async def _open_ws(ws_url: str, insecure: bool, settle_deadline: float):
    import websockets

    while True:
        try:
            return await _connect_once(ws_url, insecure)
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= settle_deadline:
                raise SystemExit(f"ws never came up at {ws_url}: {type(e).__name__}: {e}")
            _log(f"[ws] not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)


async def _reconnect_probe(ws_url: str, insecure: bool, window_s: float) -> dict[str, Any]:
    """After the rename, keep trying to reconnect wss for `window_s`. Report the
    time to first success (or that it never recovered), and a tally of the
    failure kinds seen (the 0-byte TLS abort shows as an SSL/EOF error)."""
    deadline = time.monotonic() + window_s
    attempts = 0
    fails: dict[str, int] = {}
    first_ok: float | None = None
    t0 = time.monotonic()
    while time.monotonic() < deadline:
        attempts += 1
        try:
            sock, welcome = await _connect_once(ws_url, insecure)
            first_ok = time.monotonic() - t0
            await sock.close()
            _log(
                f"[reconnect] wss RECOVERED after {first_ok:.1f}s ({attempts} attempts); "
                f"welcome name={welcome.get('deviceName')!r}"
            )
            break
        except BaseException as e:  # noqa: BLE001 — we want the exact failure taxonomy
            kind = type(e).__name__
            fails[kind] = fails.get(kind, 0) + 1
            if attempts <= 6 or attempts % 5 == 0:
                _log(f"[reconnect] attempt {attempts} failed: {kind}: {e}")
            await asyncio.sleep(1.0)
    return {"recovered_s": first_ok, "attempts": attempts, "fails": fails}


def _monitor_thread(res, seconds: float, out: dict[str, Any]) -> threading.Thread:
    """Capture the DUT serial console for `seconds` in the background so the
    firmware's best-effort logs (Serial tx-timeout=0 drops bytes when unread)
    actually flow while we rename + probe."""

    def _run():
        try:
            proc = res.ssh(
                f"hitl-monitor --seconds {seconds:g}", capture=True, timeout=seconds + 30
            )
            out["serial"] = (proc.stdout or "") + (proc.stderr or "")
        except Exception as e:  # noqa: BLE001
            out["serial_error"] = repr(e)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


async def _drive(
    ws_url: str, insecure: bool, new_name: str, probe_window_s: float, settle_s: float
) -> dict[str, Any]:
    # (0) First just get wss up at all on the fresh board — the reporter's reset
    # happens here too, so measure how long the initial handshake takes to work.
    _log(f"[ws] initial connect {ws_url} (settle up to {settle_s:g}s)")
    t0 = time.monotonic()
    try:
        sock, welcome = await _open_ws(ws_url, insecure, time.monotonic() + settle_s)
    except SystemExit as e:
        _log(f"[ws] NEVER came up in {settle_s:g}s: {e}")
        return {"initial_ok": False, "note": str(e)}
    up_s = time.monotonic() - t0
    old = welcome.get("deviceName")
    _log(f"[ws] welcome after {up_s:.1f}s: name={old!r} mac={welcome.get('mac')!r}")

    if not new_name:
        await sock.close()
        return {"initial_ok": True, "up_s": up_s, "renamed": False}

    _log(f"[rename] set_device_name -> {new_name!r}")
    try:
        nw = await _rpc(sock, {"type": "set_device_name", "name": new_name}, "welcome", timeout=20)
        _log(f"[rename] ack welcome: name={nw.get('deviceName')!r}")
    except Exception as e:  # noqa: BLE001 — the reply may be cut off by the wss restart
        _log(
            f"[rename] no clean welcome (socket likely dropped by the TLS restart): {type(e).__name__}: {e}"
        )
    try:
        await sock.close()
    except Exception:
        pass

    _log(f"[reconnect] probing wss for {probe_window_s:g}s to see if TLS recovers…")
    res = await _reconnect_probe(ws_url, insecure, probe_window_s)
    res["initial_ok"] = True
    res["up_s"] = up_s
    return res


def run_on_hardware(args) -> int:
    if args.device_ws:
        result = asyncio.run(
            _drive(args.device_ws, args.insecure, args.new_name, args.probe_window, args.settle)
        )
        _log(f"[result] {result}")
        return 0

    from hitl_client import Reservation
    from provision import dut_target, provision_dut

    res = Reservation(server=args.server, owner=args.owner)
    res.acquire()
    try:
        creds = res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP; pass --device-ws")
        ssid, password = creds
        _log(f"[improv] rig AP {ssid!r}")

        if args.bundle:
            _log(f"[flash] {os.path.basename(args.bundle)} -> {res.host}")
            res.scp_to([args.bundle], "/tmp/")
            res.ssh(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs "
                f"--monitor --monitor-seconds 6",
                capture=True,
                timeout=200,
            )

        redirect = provision_dut(res, ssid, password, args.improv_timeout, args.improv_attempts)
        host, port = dut_target(redirect, "wss")
        _log(f"[dut] {host}:{port}")

        # Rig-side reachability probe (no forward, no serial reset). The container
        # only has bash /dev/tcp — no curl/ping/grep. Checks routing to the shared
        # AP subnet + the DUT, to tell "container can't route to the DUT net" from
        # "DUT dropped WiFi" from "wss:443 wedged while :80/:81 work" (the bug).
        gw = host.rsplit(".", 1)[0] + ".1"
        diag = (
            "echo '--- /proc/net/arp'; cat /proc/net/arp 2>&1; "
            "echo '--- /proc/net/route (hex)'; cat /proc/net/route 2>&1 | head; "
            "echo '--- ifaces'; ls /sys/class/net 2>&1; "
            f'for tgt in {gw} {host}; do for p in 80 443; do echo "--- tcp $tgt:$p"; '
            f'timeout 4 bash -c "cat </dev/null >/dev/tcp/$tgt/$p" 2>&1 && echo open || echo closed; done; done'
        )
        _log("[diag] probing routing + DUT from the rig container…")
        dp = res.ssh(diag, capture=True, timeout=60)
        _log(dp.stdout or "")
        if dp.stderr:
            _log("[diag stderr] " + dp.stderr)
        if args.diag_only:
            return 0

        # The board tends to drop its STA right after an Improv session (BLE
        # coexistence). A clean reboot re-joins from the stored NVS creds with BLE
        # only advertising, which holds far better. Reset, then wait until the rig
        # can actually reach the DUT before we test wss.
        _log("[reset] rebooting DUT for a clean NVS-join (stable STA)…")
        res.ssh("hitl-monitor --reset --seconds 3", capture=True, timeout=30)
        iters = max(1, int(args.rejoin_wait // 5))
        poll = (
            f"for i in $(seq 1 {iters}); do "
            f'if timeout 2 bash -c "cat </dev/null >/dev/tcp/{host}/80" 2>/dev/null; '
            f'then echo "REACHABLE after $((i*5))s"; exit 0; fi; sleep 3; done; echo UNREACHABLE'
        )
        _log(f"[rejoin] polling rig -> {host}:80 for up to ~{iters * 5}s…")
        rp = res.ssh(poll, capture=True, timeout=iters * 5 + 40)
        _log("[rejoin] " + (rp.stdout or "").strip())
        if "UNREACHABLE" in (rp.stdout or ""):
            _log("[rejoin] DUT never came back on the network — cannot test wss on this run.")
            return 0

        # IMPORTANT: opening the C6's USB-CDC serial resets the chip (rst:0x15
        # USB_UART_HPSYS), which drops the just-provisioned WiFi join. So the
        # serial monitor is OFF by default — a clean run measures wss purely over
        # the network. With --monitor we accept ONE reset and monitor from here,
        # holding the port for the whole window (never re-opening it).
        mon_out: dict[str, Any] = {}
        mon = None
        if args.monitor:
            mon_seconds = args.settle + args.probe_window + 30
            mon = _monitor_thread(res, mon_seconds, mon_out)
            time.sleep(3)  # let the (resetting) monitor attach + board re-join

        result: dict[str, Any] = {}
        try:
            with res.forward(host, port) as local_port:
                ws_url = f"wss://localhost:{local_port}/ws"
                result = asyncio.run(
                    _drive(ws_url, True, args.new_name, args.probe_window, args.settle)
                )
        finally:
            _log(f"[result] {result}")
            if mon is not None:
                mon.join(timeout=args.settle + args.probe_window + 60)
                serial = mon_out.get("serial", "") or ""
                if mon_out.get("serial_error"):
                    _log(f"[monitor] error: {mon_out['serial_error']}")
                _log("=== SERIAL (wss / heap / cert lines) ===")
                for line in serial.splitlines():
                    if any(
                        k in line
                        for k in (
                            "[wss]",
                            "heap",
                            "re-issue",
                            "re-issued",
                            "httpd_ssl",
                            "0x7",
                            "PANIC",
                            "abort",
                            "rst:",
                            "cert",
                            "SAN",
                        )
                    ):
                        _log("  " + line)
        return 0
    finally:
        res.release()


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL rename -> wss wedge repro")
    ap.add_argument(
        "--device-ws", help="hit a reachable player wss directly (skip reserve/flash/provision)"
    )
    ap.add_argument("--server", help="pin a specific rig")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument(
        "--bundle", default=default_flashbundle(), help="flashbundle tar (default: runfiles)"
    )
    ap.add_argument("--no-bundle", dest="bundle", action="store_const", const=None)
    ap.add_argument("--new-name", default="lilbuddy-hitl", help="name to rename the device to")
    ap.add_argument(
        "--probe-window",
        type=float,
        default=45.0,
        help="seconds to probe wss reconnect after rename",
    )
    ap.add_argument(
        "--settle", type=float, default=90.0, help="seconds to wait for wss to first come up"
    )
    ap.add_argument("--insecure", action="store_true", default=True)
    ap.add_argument(
        "--monitor", action="store_true", help="capture serial (resets the C6 once on attach)"
    )
    ap.add_argument(
        "--diag-only", action="store_true", help="just run the rig-side routing/DUT probe and exit"
    )
    ap.add_argument(
        "--rejoin-wait",
        type=float,
        default=90.0,
        help="seconds to wait for the DUT to rejoin after reboot",
    )
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--improv-attempts", type=int, default=3)
    args = ap.parse_args()
    raise SystemExit(run_on_hardware(args))


if __name__ == "__main__":
    main()
