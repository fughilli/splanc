"""HITL JIT-on soak (FUG-135): load a JIT-able effect, drive `set_perf FULL` for
~30 s, and assert the DUT never faults / reboots and stays healthy under load.

The shipped firmware runs the on-device JIT by default (PR #114), but `e2e` only
boots + onboards — it never loads a JIT-able effect or runs under sustained load,
so a JIT-enabled stability regression (a fault, a watchdog reboot, a W^X trap, a
runaway heap) slips through. We separately observed the DUT watchdog-rebooting
under FULL perf during fx_bench sweeps; this soak is the gate that would surface
whether that worsens.

Flow (mirrors the proven fx_bench / rename_wss path — reach the DUT the SAME way):

  1. reserve a free rig from the pool and flash the bundle (--erase-fs, clean FS);
  2. ImprovBLE-provision the DUT onto the rig's own AP (creds served by the daemon);
  3. start a background serial monitor. Opening the C6's USB-CDC serial resets the
     chip ONCE (rst:0x15 USB_UART_HPSYS); the board auto-rejoins WiFi from its
     stored NVS creds, so we wait until the rig can reach it again before testing;
  4. over the player WebSocket (tunneled through the rig): pin the JIT ON, submit a
     fixture map + strip length, submit_effect(lavalamp, activate) — a real
     JIT-heavy shade loop — then set_perf FULL and poll a PerfReport ~1/s for the
     soak window, collecting heap_min_free + instability counters and watching for
     the socket to drop (a reboot under load);
  5. stop, read back the captured serial, and run the pure verdict (jit_soak_core):
     no fault/watchdog markers, no extra boot banner, update=ok throughout, and a
     stable heap_min_free.

Like the other on-hardware drivers this is a manual+hitl py_test — it needs a rig
+ a board, so `bazel test //...` skips it and the hitl.yaml workflow runs it
against a real rig. The verdict logic (jit_soak_core) is unit-tested off hardware
in //pi/hitl/tests. Still `bazel run`-able for a local one-off; --device-ws hits an
already-reachable board directly (a WS-only soak, no rig serial).

    bazel run //pi/hitl/harness:jit_soak
    bazel run //pi/hitl/harness:jit_soak -- --device-ws wss://<ip>/ws --soak-seconds 30
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

import hitl_ws
from fx_bench_core import intended_led_count
from jit_soak_core import evaluate_soak, format_report


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# The JIT-able effect + the fx_compile CLI + the flash-bundle + the `hitl` CLI all
# ride in runfiles, so a real run is one command. lavalamp is a genuine shade loop
# (an 8-wave hash/sin/dot/smoothstep/mix over 200 LEDs) — the kind of program the
# on-device JIT actually accelerates, so a FULL-perf soak of it exercises the
# JIT-compiled hot path, not a trivial constant.
_FXC_RUNFILE = "_main/fx_compiler/fx_compile"
_EFFECT_RUNFILE = "_main/pi/hitl/harness/benchmarks/lavalamp.heldout.fx"
_BUNDLE_RUNFILE = "_main/firmware/player_app/esp32c6_flashbundle.tar"


def _rlocation(rloc: str) -> str | None:
    try:
        from python.runfiles import runfiles

        path = runfiles.Create().Rlocation(rloc)
    except Exception:
        return None
    return path if path and os.path.exists(path) else None


def default_fx_compile() -> str:
    return _rlocation(_FXC_RUNFILE) or "fx_compile"


def default_effect() -> str | None:
    return _rlocation(_EFFECT_RUNFILE)


def default_flashbundle() -> str | None:
    return _rlocation(_BUNDLE_RUNFILE)


def compile_fx(fx_compile: str, src_path: str) -> bytes:
    """Compile a `.fx` source to `.fxb` bytes via fx_compile. Ships the OPTIMIZED
    bytecode (no --no-opt) — the soak wants the program the app actually runs
    through the JIT, not the calibration corpus's canonical form."""
    fd, out = tempfile.mkstemp(suffix=".fxb")
    os.close(fd)
    try:
        subprocess.run([fx_compile, src_path, out], check=True)
        with open(out, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass


def _linear_map(n: int) -> dict[str, Any]:
    """A synthetic linear fixture map of `n` LEDs (x spread 0..1, y=z=0). The
    firmware's shade loop iterates the MAP, reading each LED's stored position; a
    fresh --erase-fs board has none, so without a map nothing renders and the soak
    would idle. Mirrors fx_bench._linear_map."""
    denom = max(1, n - 1)
    leds = [{"id": i, "xyz": [i / denom, 0.0, 0.0]} for i in range(n)]
    return {"type": "submit_map", "map": {"map_id": "__soak", "led_count": n, "leds": leds}}


async def _rpc(
    sock, flat: dict[str, Any], expect: str, timeout: float = hitl_ws.RPC_TIMEOUT
) -> dict[str, Any]:
    from server import proto_wire

    await sock.send(proto_wire.encode_client(flat))
    while True:
        raw = await asyncio.wait_for(sock.recv(), timeout=timeout)
        msg = proto_wire.decode_server(raw)
        if msg.get("type") == expect:
            return msg
        # ignore unsolicited frames (status/frame_tick) until the reply.


def _ssl_ctx(ws_url: str, insecure: bool):
    if not ws_url.startswith("wss:"):
        return None
    ctx = ssl.create_default_context()
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def _open_ws(ws_url: str, insecure: bool, settle_deadline: float):
    """Open the player socket + hello, retrying until settle_deadline (a fresh /
    just-rebooted board is still bringing its servers up)."""
    import websockets

    while True:
        try:
            sock = await websockets.connect(
                ws_url,
                max_size=2**22,
                ssl=_ssl_ctx(ws_url, insecure),
                open_timeout=hitl_ws.OPEN_TIMEOUT,
            )
            await _rpc(sock, {"type": "hello", "client": "jit_soak", "app_version": "1"}, "welcome")
            return sock
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= settle_deadline:
                raise SystemExit(f"ws never came up at {ws_url}: {type(e).__name__}: {e}")
            _log(f"[ws] not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)


async def _soak_over_ws(
    ws_url: str, insecure: bool, fxb: bytes, led_count: int, soak_s: float, jit: bool
) -> tuple[list[dict[str, Any]], bool]:
    """Load the effect, enable FULL perf, and poll a PerfReport ~1/s for `soak_s`.
    Returns (perf_samples, ws_dropped). ws_dropped is True if the socket closed
    mid-soak — a reboot/fault under load."""
    import websockets
    from server import proto_wire

    _log(f"[ws] connecting {ws_url}")
    sock = await _open_ws(ws_url, insecure, time.monotonic() + hitl_ws.CONNECT_SETTLE)

    # Pin the JIT state for this run BEFORE the submit_effect (it takes effect on
    # the next load). The shipped firmware defaults the JIT ON; we send it anyway
    # so the soak's JIT state is explicit and can't silently drift.
    await sock.send(proto_wire.encode_client({"type": "set_jit", "enabled": bool(jit)}))
    _log(f"[jit] pinned {'ON' if jit else 'OFF'} for this soak")

    if led_count > 0:
        await _rpc(sock, _linear_map(led_count), "result_ready", timeout=10.0)
        await _rpc(sock, {"type": "set_led_count", "led_count": led_count}, "led_count_state")
    await _rpc(
        sock,
        {
            "type": "submit_effect",
            "effect_id": "__soak_lavalamp",
            "fxb": base64.b64encode(fxb).decode("ascii"),
            "activate": True,
        },
        "result_ready",
    )
    # FULL perf, poll-only (interval_ms=0): the set_perf reply is an immediate
    # PerfReport; then we drive get_perf_report ~1/s so a settled window with the
    # rolling means + the latest heap figures rides back each second.
    await _rpc(sock, {"type": "set_perf", "mode": "FULL", "interval_ms": 0}, "perf_report")
    _log(f"[soak] FULL perf on {led_count} LEDs for {soak_s:g}s…")

    samples: list[dict[str, Any]] = []
    ws_dropped = False
    deadline = time.monotonic() + soak_s
    try:
        while time.monotonic() < deadline:
            await asyncio.sleep(1.0)
            report = await _rpc(sock, {"type": "get_perf_report"}, "perf_report")
            samples.append(report)
            hf = report.get("heapMinFree") or report.get("heap_min_free") or 0
            _log(
                f"[soak] +{len(samples):>2}s heap_min_free={hf}B ticks={len(report.get('ticks') or [])}"
            )
        # Clean shutdown of the perf tier (best-effort).
        await sock.send(
            proto_wire.encode_client({"type": "set_perf", "mode": "OFF", "interval_ms": 0})
        )
    except (
        websockets.exceptions.ConnectionClosed,
        OSError,
        TimeoutError,
        asyncio.IncompleteReadError,
    ) as e:
        ws_dropped = True
        _log(
            f"[soak] socket dropped after {len(samples)}s ({type(e).__name__}: {e}) — DUT rebooted?"
        )
    finally:
        try:
            await sock.close()
        except OSError:
            pass
    return samples, ws_dropped


def _monitor_thread(res, seconds: float, out: dict[str, Any]) -> threading.Thread:
    """Capture the DUT serial for `seconds` in the background. Opening the C6's
    USB-CDC serial resets the chip once; the caller waits for the WiFi rejoin
    before testing. (Same pattern as hitl_rename_wss._monitor_thread.)"""

    def _run():
        try:
            proc = res.ssh(
                f"hitl-monitor --seconds {seconds:g}", capture=True, timeout=seconds + 40
            )
            out["serial"] = (proc.stdout or "") + (proc.stderr or "")
        except Exception as e:  # noqa: BLE001 — best-effort; surfaced in the verdict
            out["serial_error"] = repr(e)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


def _wait_rejoin(res, host: str, rejoin_wait: float) -> bool:
    """After the monitor-attach reset, poll rig -> DUT:80 until it re-joins WiFi
    (the container only has bash /dev/tcp — no curl/ping). Returns True once
    reachable."""
    iters = max(1, int(rejoin_wait // 5))
    poll = (
        f"for i in $(seq 1 {iters}); do "
        f'if timeout 2 bash -c "cat </dev/null >/dev/tcp/{host}/80" 2>/dev/null; '
        f'then echo "REACHABLE after $((i*5))s"; exit 0; fi; sleep 3; done; echo UNREACHABLE'
    )
    _log(f"[rejoin] polling rig -> {host}:80 for up to ~{iters * 5}s…")
    rp = res.ssh(poll, capture=True, timeout=iters * 5 + 40)
    _log("[rejoin] " + (rp.stdout or "").strip())
    return "UNREACHABLE" not in (rp.stdout or "")


def _finish(verdict: dict[str, Any]) -> int:
    print(format_report(verdict), flush=True)
    if verdict["ok"]:
        print("\nPASS — JIT-on soak stayed healthy under FULL-perf load", flush=True)
        return 0
    print("\nFAIL — JIT-on soak surfaced a fault/instability", file=sys.stderr, flush=True)
    return 1


def run_on_hardware(args) -> int:
    fxb = compile_fx(args.fx_compile, args.effect)
    led_count = args.led_count or intended_led_count(args.effect, default=200)
    _log(f"[fx] compiled {os.path.basename(args.effect)} ({len(fxb)} B) @ {led_count} LEDs")

    # An already-reachable board (--device-ws): a WS-only soak, no rig serial. The
    # WS-drop + heap signals still gate; the serial-only checks are skipped.
    if args.device_ws:
        samples, ws_dropped = asyncio.run(
            _soak_over_ws(
                args.device_ws, not args.ws_verify, fxb, led_count, args.soak_seconds, args.jit
            )
        )
        verdict = evaluate_soak(
            "",
            samples,
            ws_dropped=ws_dropped,
            serial_captured=False,
            expected_boots=0,
            heap_floor_bytes=args.heap_floor,
            heap_drift_bytes=args.heap_drift,
        )
        return _finish(verdict)

    from hitl_client import Reservation
    from provision import dut_target, provision_dut

    res = Reservation(server=args.server, owner=args.owner, device=args.device or None)
    res.acquire()
    try:
        ssid, password = args.wifi_ssid, args.wifi_pass
        if not ssid:
            creds = res.wifi()
            if creds:
                ssid, password = creds
                _log(f"[improv] provisioning onto the rig AP {ssid!r}")

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
            raise SystemExit("no WiFi: rig serves no AP; pass --wifi-ssid or --device-ws")
        redirect = provision_dut(res, ssid, password, args.improv_timeout, args.improv_attempts)
        host, port = dut_target(redirect, args.ws_scheme)
        _log(f"[dut] {host}:{port}")

        # Start the serial monitor (resets the C6 once), then wait for the WiFi
        # rejoin before the WS soak. Size the capture to cover attach + rejoin +
        # ws-settle + the soak + slack, so the whole soak lands in one log.
        mon_seconds = 5 + args.rejoin_wait + 70 + args.soak_seconds + 20
        mon_out: dict[str, Any] = {}
        mon = _monitor_thread(res, mon_seconds, mon_out)
        time.sleep(4)  # let the (resetting) monitor attach + the board start rebooting
        if not _wait_rejoin(res, host, args.rejoin_wait):
            _log("[rejoin] DUT never came back after the serial-attach reset — cannot soak.")
            mon.join(timeout=mon_seconds + 20)
            return 1

        samples: list[dict[str, Any]] = []
        ws_dropped = False
        try:
            with res.forward(host, port) as local_port:
                ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
                samples, ws_dropped = asyncio.run(
                    _soak_over_ws(
                        ws_url, not args.ws_verify, fxb, led_count, args.soak_seconds, args.jit
                    )
                )
        finally:
            _log("[monitor] draining serial…")
            mon.join(timeout=mon_seconds + 20)
        serial = mon_out.get("serial", "") or ""
        if mon_out.get("serial_error"):
            _log(f"[monitor] error: {mon_out['serial_error']}")

        verdict = evaluate_soak(
            serial,
            samples,
            ws_dropped=ws_dropped,
            serial_captured=bool(serial),
            expected_boots=1,
            min_fx_lines=args.min_fx_lines,
            heap_floor_bytes=args.heap_floor,
            heap_drift_bytes=args.heap_drift,
        )
        return _finish(verdict)
    finally:
        res.release()


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL JIT-on soak (FUG-135)")
    ap.add_argument(
        "--device-ws",
        help="soak a reachable player WebSocket directly (skip reserve/flash/provision)",
    )
    ap.add_argument("--server", help="pin a specific rig (else pool discovery)")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"), help="reservation owner id")
    ap.add_argument("--device", default=os.environ.get("HITL_DEVICE"), help="pin a specific DUT")
    ap.add_argument(
        "--bundle",
        default=default_flashbundle(),
        help="firmware flash-bundle tar to flash first (default: the one in runfiles)",
    )
    ap.add_argument(
        "--no-bundle",
        dest="bundle",
        action="store_const",
        const=None,
        help="don't flash; soak whatever firmware is already on the board",
    )
    ap.add_argument(
        "--effect",
        default=default_effect(),
        help="JIT-able .fx to soak (default: benchmarks/lavalamp.heldout.fx in runfiles)",
    )
    ap.add_argument(
        "--fx-compile",
        default=default_fx_compile(),
        help="fx_compile CLI (default: the one bundled in runfiles)",
    )
    ap.add_argument(
        "--led-count",
        type=int,
        default=0,
        help="strip length to soak (default: the effect's Intended-LED-count header, else 200)",
    )
    ap.add_argument("--soak-seconds", type=float, default=30.0, help="FULL-perf soak duration")
    ap.add_argument(
        "--wifi-ssid",
        default=os.environ.get("HITL_WIFI_SSID"),
        help="WiFi SSID to provision the DUT onto (default: the rig's own AP)",
    )
    ap.add_argument(
        "--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""), help="WiFi password"
    )
    ap.add_argument("--improv-timeout", type=float, default=75.0, help="seconds to await the join")
    ap.add_argument(
        "--improv-attempts", type=int, default=4, help="ImprovBLE provisioning attempts"
    )
    ap.add_argument("--monitor-seconds", type=float, default=8.0, help="serial capture after flash")
    ap.add_argument(
        "--rejoin-wait",
        type=float,
        default=90.0,
        help="seconds to wait for the DUT to rejoin WiFi after the serial-attach reset",
    )
    ap.add_argument(
        "--ws-scheme",
        choices=["ws", "wss"],
        default="wss",
        help="tunnel to the DUT's TLS wss:443 (default) or plain ws:81 player socket",
    )
    ap.add_argument(
        "--ws-verify",
        action="store_true",
        help="verify the device's TLS cert (default: accept the self-signed cert)",
    )
    ap.add_argument(
        "--min-fx-lines",
        type=int,
        default=10,
        help="minimum `[fx]` render lines expected in serial over the soak",
    )
    ap.add_argument(
        "--heap-floor",
        type=int,
        default=0,
        help="fail if heap_min_free dips below this many bytes (0 = only check stability)",
    )
    ap.add_argument(
        "--heap-drift",
        type=int,
        default=4096,
        help="max heap_min_free decline (bytes) across the soak's back half before it's a leak",
    )
    ap.add_argument(
        "--no-jit",
        dest="jit",
        action="store_false",
        help="pin the JIT OFF for the soak (default: ON, matching shipped firmware)",
    )
    ap.set_defaults(jit=True)
    args = ap.parse_args()
    if not args.effect:
        ap.error("no --effect (and none in runfiles); pass a .fx to soak")
    raise SystemExit(run_on_hardware(args))


if __name__ == "__main__":
    main()
