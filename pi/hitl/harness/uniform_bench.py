"""HITL bench: uniform-update message drop rate vs bandwidth on a real device.

Motivation: slider drags in the effects editor push a rapid stream of
`set_uniforms` over the control socket, and the final value sometimes didn't
stick. This bench isolates the TRANSPORT: it blasts N `set_uniforms` at a device
as fast as the socket accepts them and measures (a) how many the device actually
processed — it replies `playback_state` once per message, so replies < sent is a
real drop — and (b) the achieved bandwidth. It also sends one trailing
`get_effect_uniforms` as an ORDERED BARRIER: its reply can only come back after
every prior frame was processed in order, independently proving nothing was lost.

On TCP the drop rate should be 0 (confirming the app-layer collapse the editor
fix addressed was NOT the wire). Like the other HITL harnesses it reserves a rig
from the pool, flashes + ImprovBLE-provisions the DUT, and tunnels to its player
socket — so it runs in the CI HITL lane:

    bazel test //pi/hitl/harness:uniform_bench --test_output=streamed

Overrides: --device-ws hits an already-reachable board directly (skip
reserve/flash/provision); --no-bundle measures whatever is already flashed;
--server pins one rig; --count sets the blast size.

    bazel run //pi/hitl/harness:uniform_bench -- --device-ws ws://<ip>:81/ws --count 2000
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import ssl
import subprocess
import sys
import tempfile
import time
from typing import Any

import uniform_bench_core as core


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _rlocation(path: str) -> str | None:
    try:
        from python.runfiles import runfiles  # type: ignore

        p = runfiles.Create().Rlocation(path)
    except Exception:
        return None
    return p if p and os.path.exists(p) else None


def default_fx_compile() -> str:
    return _rlocation("_main/fx_compiler/fx_compile") or "fx_compile"


def default_probe() -> str:
    return _rlocation("_main/pi/hitl/harness/uniform_bench_probe.fx") or "uniform_bench_probe.fx"


def default_flashbundle() -> str | None:
    return _rlocation("_main/firmware/player_app/esp32c6_flashbundle.tar")


def compile_fx(fx_compile: str, src_path: str) -> bytes:
    fd, out = tempfile.mkstemp(suffix=".fxb")
    import os

    os.close(fd)
    subprocess.run([fx_compile, src_path, out], check=True)
    with open(out, "rb") as f:
        return f.read()


async def _rpc(sock, flat: dict[str, Any], expect: str, timeout: float = 8.0) -> dict[str, Any]:
    from server import proto_wire

    await sock.send(proto_wire.encode_client(flat))
    while True:
        raw = await asyncio.wait_for(sock.recv(), timeout=timeout)
        msg = proto_wire.decode_server(raw)
        if msg.get("type") == expect:
            return msg
        # ignore unsolicited frames until the expected reply


async def _open_ws(ws_url: str, ws_verify: bool, settle_deadline: float):
    """Open the player socket + say hello, retrying until settle_deadline. A
    freshly-provisioned board is still settling its servers (soft-AP teardown, wss
    cert re-sign, listener rebind on GOT_IP), so the first connect(s) often drop
    with 1001 'going away' — retry rather than fail the run (matches fx_bench)."""
    import websockets

    ssl_ctx = None
    if ws_url.startswith("wss:"):
        ssl_ctx = ssl.create_default_context()
        if not ws_verify:  # device presents a self-signed cert (default: don't verify)
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE
    while True:
        try:
            sock = await websockets.connect(ws_url, max_size=2**22, ssl=ssl_ctx, open_timeout=8)
            await _rpc(
                sock, {"type": "hello", "client": "uniform_bench", "app_version": "1"}, "welcome"
            )
            return sock
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= settle_deadline:
                raise
            _log(f"[ws] not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)


async def blast(sock, slot: int, count: int, led_count: int, fxb: bytes) -> dict[str, Any]:
    from server import proto_wire

    # Load + activate the probe so `slot` is a valid uniform on the running effect.
    await _rpc(
        sock,
        {
            "type": "submit_effect",
            "effect_id": "__uniform_bench",
            "fxb": base64.b64encode(fxb).decode("ascii"),
            "activate": True,
        },
        "result_ready",
    )
    await _rpc(sock, {"type": "set_led_count", "led_count": led_count}, "led_count_state")

    replies = 0
    barrier_ok = False

    async def drain() -> None:
        nonlocal replies, barrier_ok
        while True:
            raw = await asyncio.wait_for(sock.recv(), timeout=15.0)
            msg = proto_wire.decode_server(raw)
            t = msg.get("type")
            if t == "playback_state":
                replies += 1
            elif t == "effect_uniforms":  # the trailing ordered barrier
                barrier_ok = True
                return
            # ignore anything else (status, frame ticks)

    drainer = asyncio.create_task(drain())

    # Blast: distinct value per message so a stuck/duplicated value would show; the
    # final message is value 1.0 (the "released" value the editor bug lost).
    t0 = time.monotonic()
    bytes_sent = 0
    for i in range(count):
        v = i / max(1, count - 1)
        payload = proto_wire.encode_client(
            {"type": "set_uniforms", "values": [{"slot": slot, "value": [v]}]}
        )
        bytes_sent += len(payload)
        await sock.send(payload)
    send_seconds = time.monotonic() - t0

    # Ordered barrier: its reply arrives only after all `count` set_uniforms were
    # processed in order — so seeing it (and counting replies up to it) is proof of
    # full, in-order delivery.
    await sock.send(proto_wire.encode_client({"type": "get_effect_uniforms"}))
    try:
        await asyncio.wait_for(drainer, timeout=30.0)
    except asyncio.TimeoutError:
        drainer.cancel()
    total_seconds = time.monotonic() - t0

    return core.summarize(
        label=f"blast-{count}",
        sent=count,
        replies=replies,
        bytes_sent=bytes_sent,
        send_seconds=send_seconds,
        total_seconds=total_seconds,
        barrier_ok=barrier_ok,
    )


async def measure(ws_url: str, args) -> dict[str, Any]:
    _log(f"[ws] connecting {ws_url}")
    # 60s slack: a just-provisioned DUT drops the first connect(s) while its
    # servers rebind; a warm board answers on the first attempt.
    sock = await _open_ws(ws_url, args.ws_verify, time.monotonic() + 60.0)
    try:
        fxb = compile_fx(args.fx_compile, args.probe)
        _log(f"[fx] probe compiled ({len(fxb)} B); blasting {args.count} set_uniforms…")
        result = await blast(sock, args.slot, args.count, args.led_count, fxb)
    finally:
        await sock.close()
    ok, why = core.verdict(result)
    result["pass"] = ok
    result["verdict"] = why
    return result


def run_rig(args) -> dict[str, Any]:
    """Reserve a rig from the pool, flash + ImprovBLE-provision the DUT, tunnel to
    its player socket via the rig, and run the blast. Mirrors fx_bench.py."""
    from hitl_client import Reservation
    from provision import dut_target, provision_dut

    res = Reservation(server=args.server, owner=args.owner)
    res.acquire()
    try:
        # Default onto the rig's own provisioning AP (no external net); --wifi-ssid
        # overrides.
        ssid, password = args.wifi_ssid, args.wifi_pass
        if not ssid:
            creds = res.wifi()
            if creds:
                ssid, password = creds
                _log(f"[improv] provisioning onto the rig AP {ssid!r}")
        if args.bundle:
            _log(f"[flash] {os.path.basename(args.bundle)} → {res.host}")
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
        with res.forward(host, port) as local_port:
            ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
            return asyncio.run(measure(ws_url, args))
    finally:
        res.release()


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL uniform-update drop-rate / bandwidth bench")
    # Measurement
    ap.add_argument("--count", type=int, default=1000, help="number of set_uniforms to blast")
    ap.add_argument(
        "--slot", type=int, default=0, help="uniform slot to drive (probe's `amount` = 0)"
    )
    ap.add_argument("--led-count", type=int, default=64, help="strip length to configure")
    ap.add_argument("--fx-compile", default=default_fx_compile(), help="fx_compile CLI path")
    ap.add_argument("--probe", default=default_probe(), help="probe .fx source path")
    ap.add_argument("--out", help="write the result JSON here too")
    ap.add_argument(
        "--ws-verify",
        action="store_true",
        help="verify the device TLS cert (default: off, self-signed)",
    )
    # Direct: skip the rig and hit an already-reachable board.
    ap.add_argument(
        "--device-ws",
        help="connect straight to a reachable player socket (skip reserve/flash/provision)",
    )
    # Rig path (default): reserve → flash → provision → tunnel.
    ap.add_argument("--server", help="pin a specific rig (else pool discovery)")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"), help="reservation owner id")
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
        help="don't flash; measure the firmware already on the board",
    )
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID"), help="WiFi SSID")
    ap.add_argument(
        "--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""), help="WiFi password"
    )
    ap.add_argument("--improv-timeout", type=float, default=75.0, help="seconds to await the join")
    ap.add_argument(
        "--improv-attempts", type=int, default=4, help="ImprovBLE provisioning attempts"
    )
    ap.add_argument(
        "--ws-scheme",
        choices=["ws", "wss"],
        default="ws",
        help="tunnel to the DUT's plain ws:81 (default) or TLS wss:443 player socket",
    )
    ap.add_argument("--monitor-seconds", type=float, default=8.0, help="serial capture after flash")
    args = ap.parse_args()

    if args.device_ws:
        result = asyncio.run(measure(args.device_ws, args))
    else:
        result = run_rig(args)

    print(json.dumps(result, indent=2))
    if args.out:
        with open(args.out, "w") as f:
            json.dump(result, f, indent=2)
        _log(f"[out] wrote {args.out}")
    ok = bool(result.get("pass"))
    _log(("PASS: " if ok else "FAIL: ") + str(result.get("verdict")))
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
