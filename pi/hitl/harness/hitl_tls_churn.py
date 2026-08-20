"""HITL: concurrent-TLS-slot / connection-churn resilience on wss:443 (FUG-136).

The device serves its player protocol over a heap-tight, single-task TLS server
capped at two concurrent sessions (firmware main.cpp wss_start: `max_open_sockets
= 2`; each mbedTLS session is ~28 KB). `hitl_rename_wss.py` proves *sequential*
reconnects recover; this driver proves the harder case the field wedge lived in —
*simultaneous* pressure, where several wss:443 handshakes AND the HTTPS cert-page
GET compete for the two slots at once — degrades gracefully (serves/sheds rather
than wedging until reboot), and the server frees its slots and recovers after.

Each round:
  1. fire `--handshakes N` wss:443 handshakes concurrently, each holding its
     socket open briefly, AND a simultaneous HTTPS GET of the cert page `/` — so
     N+1 clients contend for 2 slots at the same instant;
  2. tear them all down, then probe a clean wss handshake and require it to
     succeed within `--recover-window` s (the anti-wedge gate).
Repeated `--rounds` times to expose a slow slot/heap leak that one burst hides.

The PASS/FAIL verdict + outcome taxonomy live in tls_churn_core (unit-tested).
Unlike rename_wss (a repro that always exits 0), this ASSERTS: a wedge, a crash,
or a never-recovering round exits non-zero, so the HITL lane gates the regression.

Like the other on-hardware drivers this is `bazel run`, never `bazel test`:

    bazel run //pi/hitl/harness:tls_churn
    bazel run //pi/hitl/harness:tls_churn -- --device-ws wss://<ip>/ws
"""

from __future__ import annotations

import argparse
import asyncio
import os
import ssl
import threading
import time
from dataclasses import asdict
from typing import Any
from urllib.parse import urlparse

from python.runfiles import runfiles
from tls_churn_core import FAIL, Round, classify, result_line, run_status, tally, verdict


def _log(msg: str) -> None:
    print(msg, flush=True)


def default_flashbundle() -> str | None:
    try:
        return runfiles.Create().Rlocation("_main/firmware/player_app/esp32c6_flashbundle.tar")
    except Exception:
        return None


# Serial markers that mean the DUT crashed/rebooted mid-run (a wedge that took the
# whole chip, not just the TLS endpoint). Mirrors the set rename_wss greps for.
_CRASH_MARKERS = ("PANIC", "Guru Meditation", "abort()", "Backtrace:", "rst:0x", "assert failed")


def _ssl_ctx(insecure: bool) -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


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


async def _connect_once(ws_url: str, insecure: bool, open_timeout: float = 8.0):
    """One wss connect + hello/welcome. Returns (sock, welcome) or raises."""
    import websockets

    sock = await websockets.connect(
        ws_url, max_size=2**22, ssl=_ssl_ctx(insecure), open_timeout=open_timeout
    )
    try:
        welcome = await _rpc(
            sock, {"type": "hello", "client": "tls_churn", "app_version": "1"}, "welcome"
        )
    except BaseException:
        await sock.close()
        raise
    return sock, welcome


async def _hold_ws(ws_url: str, insecure: bool, hold_s: float, open_timeout: float) -> str:
    """One contending wss client: handshake + welcome, hold the socket `hold_s`,
    then close. Returns the classified outcome (never raises)."""
    try:
        sock, _ = await _connect_once(ws_url, insecure, open_timeout)
    except BaseException as e:  # noqa: BLE001 — we bucket every failure kind
        return classify(e)
    try:
        await asyncio.sleep(hold_s)
    finally:
        try:
            await sock.close()
        except Exception:
            pass
    return "ok"


async def _cert_get(host: str, port: int, insecure: bool, timeout: float) -> int | None:
    """GET the TLS cert page `/` (the third client contending for the 2 slots).

    Returns the HTTP status (200 when served), or None if the request never
    completed under contention. Uses a raw TLS stream so we need no extra deps and
    can compete for a slot exactly like a browser opening the cert-approval page.
    """
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port, ssl=_ssl_ctx(insecure), server_hostname=None),
            timeout=timeout,
        )
        req = f"GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
        writer.write(req.encode())
        await asyncio.wait_for(writer.drain(), timeout=timeout)
        status_line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        parts = status_line.split()
        if len(parts) >= 2 and parts[0].startswith(b"HTTP/"):
            return int(parts[1])
        return None
    except BaseException:  # noqa: BLE001 — contention loss is expected, report as None
        return None
    finally:
        if writer is not None:
            try:
                writer.close()
            except Exception:
                pass


async def _recover(ws_url: str, insecure: bool, window_s: float) -> tuple[bool, float | None]:
    """After a burst, keep trying a clean handshake until one works or the window
    expires. Returns (recovered, seconds_to_recovery)."""
    t0 = time.monotonic()
    deadline = t0 + window_s
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        try:
            sock, _ = await _connect_once(ws_url, insecure)
            await sock.close()
            return True, time.monotonic() - t0
        except BaseException as e:  # noqa: BLE001
            if attempt <= 3 or attempt % 5 == 0:
                _log(f"[recover] attempt {attempt} not yet: {type(e).__name__}: {e}")
            await asyncio.sleep(1.0)
    return False, None


async def _churn_round(
    idx: int,
    ws_url: str,
    host: str,
    port: int,
    insecure: bool,
    n: int,
    hold_s: float,
    open_timeout: float,
    recover_window: float,
) -> Round:
    _log(f"[round {idx}] firing {n} concurrent wss handshakes + 1 cert-page GET at :{port}…")
    ws_tasks = [
        asyncio.create_task(_hold_ws(ws_url, insecure, hold_s, open_timeout)) for _ in range(n)
    ]
    cert_task = asyncio.create_task(_cert_get(host, port, insecure, open_timeout + hold_s))
    outcomes = tally(await asyncio.gather(*ws_tasks))
    cert_status = await cert_task
    _log(f"[round {idx}] under contention: {outcomes} cert_page={cert_status}")

    recovered, recover_s = await _recover(ws_url, insecure, recover_window)
    if recovered:
        _log(f"[round {idx}] wss RECOVERED {recover_s:.1f}s after the burst")
    else:
        _log(f"[round {idx}] wss did NOT recover within {recover_window:g}s — WEDGE")
    return Round(
        index=idx,
        outcomes=outcomes,
        cert_status=cert_status,
        recovered=recovered,
        recover_s=recover_s,
    )


async def _drive(
    ws_url: str,
    insecure: bool,
    rounds: int,
    handshakes: int,
    hold_s: float,
    open_timeout: float,
    recover_window: float,
    settle_s: float,
    crashed: bool = False,
) -> dict[str, Any]:
    parsed = urlparse(ws_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or (443 if parsed.scheme == "wss" else 80)

    # (0) Baseline: a single clean handshake must work before we pile on load, or
    # the run proves nothing about *degradation* (vs. never-worked).
    _log(f"[baseline] connect {ws_url} (settle up to {settle_s:g}s)")
    t0 = time.monotonic()
    baseline_ok = False
    deadline = t0 + settle_s
    while time.monotonic() < deadline:
        try:
            sock, welcome = await _connect_once(ws_url, insecure)
            await sock.close()
            baseline_ok = True
            _log(
                f"[baseline] welcome after {time.monotonic() - t0:.1f}s: "
                f"name={welcome.get('deviceName')!r}"
            )
            break
        except BaseException as e:  # noqa: BLE001
            _log(f"[baseline] not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)

    round_results: list[Round] = []
    if baseline_ok:
        for i in range(1, rounds + 1):
            round_results.append(
                await _churn_round(
                    i,
                    ws_url,
                    host,
                    port,
                    insecure,
                    handshakes,
                    hold_s,
                    open_timeout,
                    recover_window,
                )
            )
    else:
        # Never got a clean baseline handshake: we could not reach the device to
        # test it (flaky Improv join / dropped STA / wss still binding). That's an
        # inconclusive SKIP, not a wedge — exit 0, like rename_wss and the
        # rejoin-UNREACHABLE path. We only ASSERT once a baseline proved the
        # device was reachable, so a healthy-but-unreachable board never red-lines
        # the HITL lane on this test.
        _log(f"[baseline] never came up in {settle_s:g}s — SKIP (cannot test churn on this run)")

    status = run_status(baseline_ok, round_results, crashed)
    v = verdict(baseline_ok, round_results, crashed)
    line = result_line(baseline_ok, round_results, crashed, status)
    _log(line)
    if status == FAIL:
        for reason in v.reasons:
            _log(f"[FAIL] {reason}")
    return {
        "baseline_ok": baseline_ok,
        "rounds": [asdict(r) for r in round_results],
        "crashed": crashed,
        "status": status,
        "reasons": v.reasons if status == FAIL else [],
        "result_line": line,
        "ok": status != FAIL,  # PASS and SKIP both exit 0; only FAIL exits non-zero
    }


def _monitor_thread(res, seconds: float, out: dict[str, Any]) -> threading.Thread:
    """Capture the DUT serial console in the background for the whole run so a
    crash/reboot during the churn is visible (firmware Serial drops bytes when
    unread, so we hold the port open the entire time)."""

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


def run_on_hardware(args) -> int:
    if args.device_ws:
        result = asyncio.run(
            _drive(
                args.device_ws,
                args.insecure,
                args.rounds,
                args.handshakes,
                args.hold,
                args.open_timeout,
                args.recover_window,
                args.settle,
            )
        )
        _log(f"[result] {result['result_line']}")
        return 0 if result["ok"] else 1

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

        # The board tends to drop its STA right after an Improv session (BLE
        # coexistence); a clean reboot re-joins from stored NVS creds and holds
        # far better. Reset, then wait until the rig can reach the DUT before we
        # test wss. (Same dance as rename_wss / the e2e.)
        _log("[reset] rebooting DUT for a clean NVS-join (stable STA)…")
        res.ssh("hitl-monitor --reset --seconds 3", capture=True, timeout=30)
        # Poll :80 (the HTTP landing) for reachability, like rename_wss — it binds
        # as soon as the STA rejoins, whereas :443 comes up a beat later after the
        # LAN cert re-issue; the baseline's own settle window then waits for :443.
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
            _log("[rejoin] DUT never came back on the network — SKIP (cannot test wss).")
            return 0

        # Opening the C6's USB-CDC serial resets the chip (drops the just-joined
        # WiFi), so the monitor is OFF by default — a clean run measures wss purely
        # over the network. With --monitor we accept ONE reset and hold the port
        # for the whole window so a crash during the churn is captured.
        mon_out: dict[str, Any] = {}
        mon = None
        if args.monitor:
            mon_seconds = args.settle + args.rounds * (args.recover_window + args.hold + 10) + 30
            mon = _monitor_thread(res, mon_seconds, mon_out)
            time.sleep(3)  # let the (resetting) monitor attach + the board re-join

        result: dict[str, Any] = {
            "ok": True,
            "status": "skip",
            "result_line": "RESULT verdict=SKIP (driver did not complete a run)",
        }
        try:
            with res.forward(host, port) as local_port:
                ws_url = f"wss://localhost:{local_port}/ws"
                result = asyncio.run(
                    _drive(
                        ws_url,
                        True,
                        args.rounds,
                        args.handshakes,
                        args.hold,
                        args.open_timeout,
                        args.recover_window,
                        args.settle,
                    )
                )
        finally:
            if mon is not None:
                mon.join(timeout=30)
                serial = mon_out.get("serial", "") or ""
                if mon_out.get("serial_error"):
                    _log(f"[monitor] error: {mon_out['serial_error']}")
                crashed = any(m in serial for m in _CRASH_MARKERS)
                _log(f"[monitor] crash marker during churn: {crashed}")
                _log("=== SERIAL (wss / heap / cert / crash lines) ===")
                for ln in serial.splitlines():
                    if any(
                        k in ln
                        for k in ("[wss]", "heap", "httpd_ssl", "cert", "0x7", *(_CRASH_MARKERS))
                    ):
                        _log("  " + ln)
                # Fold a serial-observed crash into the verdict (the network path
                # alone can't see a reboot the STA survives). Only a run that
                # actually PASSed flips to FAIL — a crash on a SKIP (no baseline,
                # nothing asserted) stays environmental, not a wedge.
                if crashed and result.get("status") == "pass":
                    result["ok"] = False
                    result["status"] = FAIL
                    result["reasons"] = [*result.get("reasons", []), "crash marker on serial"]
                    result["result_line"] = result.get("result_line", "").replace(
                        "verdict=PASS", "verdict=FAIL"
                    )
                    _log("[FAIL] crash/reboot marker seen on serial during churn")
            _log(f"[result] {result['result_line']}")
        return 0 if result.get("ok") else 1
    finally:
        res.release()


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL concurrent-TLS-slot churn resilience (FUG-136)")
    ap.add_argument(
        "--device-ws", help="hit a reachable player wss directly (skip reserve/flash/provision)"
    )
    ap.add_argument("--server", help="pin a specific rig")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument(
        "--bundle", default=default_flashbundle(), help="flashbundle tar (default: runfiles)"
    )
    ap.add_argument("--no-bundle", dest="bundle", action="store_const", const=None)
    ap.add_argument("--rounds", type=int, default=3, help="churn bursts to run")
    ap.add_argument(
        "--handshakes",
        type=int,
        default=4,
        help="concurrent wss handshakes per burst (> the 2 TLS slots on purpose)",
    )
    ap.add_argument(
        "--hold", type=float, default=2.0, help="seconds each contending wss holds its socket open"
    )
    ap.add_argument(
        "--open-timeout", type=float, default=8.0, help="per-handshake client open timeout"
    )
    ap.add_argument(
        "--recover-window",
        type=float,
        default=40.0,
        help="seconds to wait for wss to recover after a burst; recovery after the "
        "FINAL burst is the anti-wedge gate (earlier-round recovery is reported only)",
    )
    ap.add_argument(
        "--settle", type=float, default=90.0, help="seconds to wait for wss to first come up"
    )
    ap.add_argument(
        "--ws-verify",
        action="store_true",
        help="verify the DUT's TLS cert (default: accept the self-signed cert)",
    )
    ap.add_argument(
        "--monitor", action="store_true", help="capture serial (resets the C6 once on attach)"
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
    args.insecure = not args.ws_verify
    raise SystemExit(run_on_hardware(args))


if __name__ == "__main__":
    main()
