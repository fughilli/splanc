"""The P4 board's C6 front end (the pure relay, relay_main.cpp) alone on a HITL C6.

The HITL rigs have no P4, so this checks the half that runs on the C6, and measures it:

  1. reserve a C6, flash //firmware/player_app:esp32c6_frontend_flashbundle (full erase),
     assert it boots and BLE advertises;
  2. provision it over BLE Improv onto the rig's AP;
  3. over wss:443 (tunnelled from the rig): get_tls_info and get_wifi_policy are answered
     by the front end itself; hello and set_device_name, which are the P4's, answer
     error{player_unavailable} (no P4 is attached);
  4. idle for --idle-seconds, joined, then read the front end's `[relay] heap=… min=…`
     status lines off its serial and gate the idle free heap on the 24 KB floor.

`--no-assert` only reports (the replies and the heap figures): what an A/B against an
older front-end image uses (its `[player-netstack] … heap=` lines are parsed too).

    bazel test //pi/hitl/harness:frontend_relay --test_output=streamed \\
        --test_arg=--server=http://hitl-rig-2:8087
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import ssl
import sys
import time

import hitl_ws
from frontend_relay_core import check_replies, heap_samples, verdict
from hitl_client import Reservation, ReserveError
from provision import HarnessError, ble_advertising, dut_target, ensure_booted, provision_dut


async def probe(ws_url: str) -> dict:
    import websockets
    from server import proto_wire

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    deadline = time.monotonic() + hitl_ws.CONNECT_SETTLE
    while True:
        try:
            sock = await websockets.connect(ws_url, ssl=ctx, open_timeout=hitl_ws.OPEN_TIMEOUT)
            break
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= deadline:
                raise HarnessError(f"wss never opened at {ws_url}: {type(e).__name__}: {e}")
            await asyncio.sleep(1.5)
    out = {}
    try:
        for name, msg in [
            ("get_tls_info", {"type": "get_tls_info"}),
            ("get_wifi_policy", {"type": "get_wifi_policy"}),
            ("hello", {"type": "hello", "client": "hitl-frontend-relay", "appVersion": "0"}),
            ("set_device_name", {"type": "set_device_name", "name": "Relay Probe"}),
        ]:
            t0 = time.monotonic()
            await sock.send(proto_wire.encode_client(msg))
            reply = proto_wire.decode_server(
                await asyncio.wait_for(sock.recv(), timeout=hitl_ws.RPC_TIMEOUT)
            )
            reply["_rtt_ms"] = round((time.monotonic() - t0) * 1000, 1)
            out[name] = reply
            print(f"[ws] {name} -> {json.dumps(reply)[:300]}", flush=True)
    finally:
        await sock.close()
    return out


async def concurrent(ws_url: str, n: int, hold_s: float) -> list[bool]:
    """Open `n` wss sessions at once, each answered (get_wifi_policy, the front end's own
    arm), and hold them all open for `hold_s` (the heap lines then report ws=n)."""
    import websockets
    from server import proto_wire

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    async def one(i: int):
        try:
            sock = await websockets.connect(ws_url, ssl=ctx, open_timeout=hitl_ws.OPEN_TIMEOUT)
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            print(f"[ws{i}] did not open: {type(e).__name__}: {e}", flush=True)
            return None
        try:
            await sock.send(proto_wire.encode_client({"type": "get_wifi_policy"}))
            reply = proto_wire.decode_server(
                await asyncio.wait_for(sock.recv(), timeout=hitl_ws.RPC_TIMEOUT)
            )
            print(f"[ws{i}] open, get_wifi_policy -> {reply.get('type')}", flush=True)
            return sock if reply.get("type") == "wifi_policy_state" else None
        except Exception as e:  # noqa: BLE001 — a failed session is the result
            print(f"[ws{i}] failed: {type(e).__name__}: {e}", flush=True)
            await sock.close()
            return None

    socks = await asyncio.gather(*(one(i) for i in range(n)))
    print(
        f"[ws] {sum(s is not None for s in socks)}/{n} sessions open; holding {hold_s:g} s",
        flush=True,
    )
    await asyncio.sleep(hold_s)
    ok = []
    for s in socks:
        if s is None:
            ok.append(False)
            continue
        try:  # still alive after the hold
            await s.send(proto_wire.encode_client({"type": "get_tls_info"}))
            r = proto_wire.decode_server(
                await asyncio.wait_for(s.recv(), timeout=hitl_ws.RPC_TIMEOUT)
            )
            ok.append(r.get("type") == "tls_info")
        except Exception:  # noqa: BLE001
            ok.append(False)
        await s.close()
    return ok


def flash(res: Reservation, bundle: str, monitor_seconds: float) -> str:
    remote = "/tmp/" + os.path.basename(bundle)
    res.scp_to([bundle], "/tmp/")
    cmd = f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds {monitor_seconds:g}"
    print(f"[flash] {cmd}", flush=True)
    proc = res.ssh_serialized(cmd, capture=True, timeout=monitor_seconds + 120)
    log = (proc.stdout or "") + (proc.stderr or "")
    sys.stdout.write(log)
    if proc.returncode != 0:
        raise HarnessError(f"hitl-flash exited {proc.returncode}")
    log = ensure_booted(res, log, monitor_seconds)
    if not ble_advertising(log):
        raise HarnessError("BLE never came up")
    return log


def _bundle(args) -> str:
    if args.bundle:
        return args.bundle
    from python.runfiles import runfiles

    r = runfiles.Create()
    path = r.Rlocation(os.environ["HITL_BUNDLE_RUNFILE"]) if r else None
    if not path or not os.path.isfile(path):
        raise HarnessError("no flash bundle: pass --bundle")
    return path


def run(args) -> int:
    res = Reservation(server=args.server, owner=args.owner, sku="esp32c6", device=args.device)
    result: dict = {}
    errs: list[str] = []
    try:
        bundle = _bundle(args)
        res.acquire()
        creds = res.wifi()
        if not creds:
            raise HarnessError("the rig serves no provisioning AP (`hitl wifi`)")
        flash(res, bundle, args.monitor_seconds)
        redirect = provision_dut(res, creds[0], creds[1], args.improv_timeout)
        host, port = dut_target(redirect, "wss")
        with res.forward(host, port) as local_port:
            url = f"wss://localhost:{local_port}/ws"
            result["replies"] = asyncio.run(probe(url))
            if args.sessions > 1:
                result["concurrent"] = asyncio.run(
                    concurrent(url, args.sessions, args.idle_seconds)
                )
        print(f"[idle] {args.idle_seconds:g} s joined and idle…", flush=True)
        time.sleep(args.idle_seconds)
    except (HarnessError, ReserveError) as e:
        print(f"\nFAIL: {e}", file=sys.stderr)
        errs.append(str(e))
    finally:
        res.release()
    log = "\n".join(res.serial_logs.values())
    samples = heap_samples(log)
    result["heap"] = samples
    ok, msg = verdict(samples)
    print(f"[heap] {msg}", flush=True)
    if "replies" in result:
        errs += check_replies(result["replies"])
    if args.sessions > 1 and not all(result.get("concurrent") or [False]):
        errs.append(
            f"concurrent sessions: {result.get('concurrent')} (wanted {args.sessions} answered)"
        )
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump({**result, "verdict": msg, "errors": errs}, f, indent=1)
    if args.no_assert:
        return 1 if "replies" not in result else 0
    if not ok:
        errs.append(f"idle heap under the floor: {msg}")
    for e in errs:
        print(f"FAIL: {e}", file=sys.stderr)
    if errs:
        print(res.serial_tail(), file=sys.stderr)
        return 1
    print("PASS", flush=True)
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--server", help="rig base URL (else `hitl` picks one)")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", default=os.environ.get("HITL_DEVICE"), help="pin a DUT by name")
    ap.add_argument(
        "--bundle", default=os.environ.get("HITL_BUNDLE"), help="front-end flash bundle .tar"
    )
    ap.add_argument("--monitor-seconds", type=float, default=12.0)
    ap.add_argument("--improv-timeout", type=float, default=60.0)
    ap.add_argument(
        "--idle-seconds", type=float, default=40.0, help="idle, joined, before reading the heap"
    )
    ap.add_argument(
        "--sessions",
        type=int,
        default=1,
        help="also hold this many wss sessions open at once through the idle window",
    )
    ap.add_argument("--json-out", help="write the replies and heap samples here")
    ap.add_argument(
        "--no-assert", action="store_true", help="report only (an A/B against another image)"
    )
    # hitl_test fan-out args (accepted, unused: this test is C6-only).
    ap.add_argument("--sku", help=argparse.SUPPRESS)
    ap.add_argument("--require-caps", help=argparse.SUPPRESS)
    return ap.parse_args(argv)


if __name__ == "__main__":
    sys.exit(run(parse_args()))
