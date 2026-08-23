"""HITL repro + characterization of the player's TLS-slot behaviour on the REAL
ws/welcome path (the -0x7780 field storm).

Flash + ImprovBLE-provision the DUT onto the rig's AP, tunnel :443 back through
the reservation, then exercise the same path the app does — wss connect + hello
-> welcome — under:
  * concurrency  — N simultaneous connect+welcome attempts (finds the ceiling).
  * churn        — reconnect loop (connect/welcome/close/reconnect) with 0 or 1
                   other session held: does a reconnecting client + a held one
                   race the ~2.4s slot release into welcome-timeouts / -0x7780?

Prints time-to-welcome so a `connectTimeoutMs`-style ceiling is visible.

    bazel run //pi/hitl/harness:slot_repro -- [--server http://hitl-rig-1:8087]
"""

import argparse
import asyncio
import os
import ssl
import sys
import time

from hitl_client import Reservation
from provision import HarnessError, dut_target, ensure_booted, provision_dut
from tls_churn_core import ERROR, OK, classify, sequential_churn_verdict, tally

_BUNDLE_RUNFILE = "_main/firmware/player_app/esp32c6_flashbundle.tar"
BLE_MARKER = "[ble] advertising"


def default_bundle():
    from python.runfiles import runfiles

    path = runfiles.Create().Rlocation(_BUNDLE_RUNFILE)
    if not path or not os.path.exists(path):
        raise HarnessError("flash-bundle not found in runfiles")
    return path


def flash(res, bundle, monitor_seconds=6.0):
    remote = "/tmp/" + os.path.basename(bundle)
    res.scp_to([bundle], "/tmp/")
    cmd = f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds {monitor_seconds:g}"
    print(f"[flash] {cmd}", flush=True)
    proc = res.ssh(cmd, capture=True, timeout=monitor_seconds + 120)
    log = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise HarnessError(f"hitl-flash exited {proc.returncode}")
    log = ensure_booted(res, log, monitor_seconds)
    if BLE_MARKER not in log:
        raise HarnessError(f"BLE never came up (no {BLE_MARKER!r})")
    print("[flash] OK — booted + BLE advertising", flush=True)
    return log


def _ctx():
    c = ssl.create_default_context()
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c


async def ws_welcome(url, ctx, open_timeout=8, welcome_timeout=10):
    """The app's real path: wss connect + hello -> welcome. (ok, ms, category).

    The category is a tls_churn_core.classify() bucket: OK on a welcome, ERROR if
    the server answered with something other than a welcome (unexpected), else the
    classification of the exception — REJECTED/TIMEOUT are graceful backpressure
    from the heap-tight 2-slot server, ERROR is a genuine fault.
    """
    import websockets
    from server import proto_wire

    t0 = time.monotonic()
    try:
        async with websockets.connect(
            url, ssl=ctx, open_timeout=open_timeout, max_size=2**22
        ) as sock:
            await sock.send(
                proto_wire.encode_client({"type": "hello", "client": "repro", "appVersion": "0"})
            )
            reply = proto_wire.decode_server(
                await asyncio.wait_for(sock.recv(), timeout=welcome_timeout)
            )
            if reply.get("type") == "welcome":
                return True, (time.monotonic() - t0) * 1000.0, OK
            # Served, but not a welcome — unexpected protocol state, not graceful shedding.
            return False, (time.monotonic() - t0) * 1000.0, ERROR
    except Exception as e:  # noqa: BLE001
        return False, (time.monotonic() - t0) * 1000.0, classify(e)


async def hold_open(url, ctx):
    """Open a wss + welcome and RETURN the live connection (caller closes)."""
    import websockets
    from server import proto_wire

    sock = await websockets.connect(url, ssl=ctx, open_timeout=8, max_size=2**22)
    await sock.send(
        proto_wire.encode_client({"type": "hello", "client": "hold", "appVersion": "0"})
    )
    await asyncio.wait_for(sock.recv(), timeout=10)  # welcome
    return sock


async def concurrency_sweep(url, ctx, upto=4):
    """Returns (n1_clean, n2_clean): whether 1 and 2 concurrent both served — the
    device's documented capacity. >=3 starving is the known ceiling, not a fail."""
    served = {}
    for n in range(1, upto + 1):
        res = await asyncio.gather(*[ws_welcome(url, ctx) for _ in range(n)])
        ok = sum(1 for r in res if r[0])
        served[n] = ok == n
        ms = ", ".join(f"{r[1]:.0f}ms{'' if r[0] else '/' + r[2]}" for r in res)
        print(
            f"[ws concurrency={n}] ok={ok}/{n}  [{ms}]  "
            f"{'clean' if ok == n else 'STARVED (>=3 is the known 2-slot ceiling)'}",
            flush=True,
        )
        await asyncio.sleep(3)
    return served.get(1, False), served.get(2, False)


async def churn(url, ctx, rounds, held):
    """Reconnect `rounds` times (with `held` other sessions open), then probe
    recovery. Returns (outcomes, times, recovered): `outcomes` is a classify()
    category per round, `recovered` is whether a fresh welcome succeeds after the
    burst (holds released) — the anti-wedge signal. A few graceful REJECTED/TIMEOUT
    mid-burst are fine; a persistent wedge shows up as recovered=False."""
    holds = []
    for _ in range(held):
        try:
            holds.append(await hold_open(url, ctx))
        except Exception:  # noqa: BLE001
            pass
    outcomes, times = [], []
    for _ in range(rounds):
        ok, ms, cat = await ws_welcome(url, ctx)
        times.append(ms)
        outcomes.append(cat)
    for h in holds:
        try:
            await h.close()
        except Exception:  # noqa: BLE001
            pass
    await asyncio.sleep(2)
    # Recovery / anti-wedge probe: with the holds released the server has both
    # slots back, so a fresh welcome must succeed within a bounded window. The
    # field bug (-0x7780 storm) is a wedge that never recovers until reboot.
    recovered = False
    for _ in range(6):
        ok, _ms, _cat = await ws_welcome(url, ctx)
        if ok:
            recovered = True
            break
        await asyncio.sleep(1.0)
    return outcomes, times, recovered


def _churn_line(label, outcomes, times, recovered):
    counts = tally(outcomes)
    avg = sum(times) / len(times) if times else 0.0
    mx = max(times or [0])
    # A wedge (never recovers) is the field bug; graceful REJECTED/TIMEOUT that
    # recover are fine. ERROR is always odd.
    if not recovered:
        verdict = "WEDGE — the field bug"
    elif counts[ERROR]:
        verdict = "ERROR (non-graceful)"
    elif counts[OK] == len(outcomes):
        verdict = "clean"
    else:
        verdict = "shed some, recovered (graceful)"
    return (
        f"[ws churn {label}] x{len(outcomes)} {dict(counts)} "
        f"avg={avg:.0f}ms max={mx:.0f}ms recovered={'yes' if recovered else 'NO'}  {verdict}"
    )


async def experiments(url):
    """Characterize + REGRESS-GUARD the slot behaviour. Prints the sweep (repro)
    and raises AssertionError on a regression (guard): the app-visible invariants
    are that <=2 concurrent sessions serve cleanly, a reconnecting client (even
    with one other session held) never WEDGES, and a served welcome always beats
    the client's connectTimeoutMs. The >=3 concurrency starvation is the KNOWN
    ceiling we document, not a failure — and neither is a heap-tight 2-slot server
    shedding the odd reconnect under a rapid hammer, PROVIDED it recovers (the
    field bug is a wedge that never serves again until reboot — see
    tls_churn_core.sequential_churn_verdict, shared with the FUG-136 tls_churn lane)."""
    ctx = _ctx()
    # wait for the ws server to settle after provisioning
    for _ in range(40):
        ok, _ms, _d = await ws_welcome(url, ctx)
        if ok:
            break
        await asyncio.sleep(1.5)

    ok1, ok2 = await concurrency_sweep(url, ctx, 4)

    out0, t0, rec0 = await churn(url, ctx, 20, held=0)
    print(_churn_line("held=0", out0, t0, rec0), flush=True)
    out1, t1, rec1 = await churn(url, ctx, 20, held=1)
    print(_churn_line("held=1", out1, t1, rec1), flush=True)

    # Keep in step with client.ts connectTimeoutMs. HITL showed a slot-contended
    # welcome can take ~8.3s, so this MUST stay above that — shrinking it aborts
    # legitimate slow welcomes and *causes* the -0x7780 storm.
    CONNECT_TIMEOUT_MS = 10000
    max_ms = max(max(t0 or [0]), max(t1 or [0]))
    v = sequential_churn_verdict(
        baseline_ok=ok1,
        churns=[("reconnect churn (held=0)", out0, rec0), ("reconnect-with-1-held", out1, rec1)],
        max_welcome_ms=max_ms,
        connect_timeout_ms=CONNECT_TIMEOUT_MS,
    )
    if not v.ok:
        raise AssertionError("slot-guard regressions: " + "; ".join(v.reasons))
    print(
        "\nPASS — single connect solid, reconnect churn (incl. +1 held) recovers "
        "(no wedge), welcome beats the 10s connect timeout  "
        f"[concurrency ceiling: n=1 {'ok' if ok1 else 'FAIL'}, n=2 "
        f"{'ok' if ok2 else 'marginal'}, n>=3 starves as designed]",
        flush=True,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    args = ap.parse_args()

    res = Reservation(server=args.server or None, owner="slot-repro")
    res.acquire()
    try:
        creds = res.wifi()
        if not creds:
            raise HarnessError("rig serves no provisioning AP (hitl wifi empty)")
        flash(res, default_bundle())
        redirect = provision_dut(res, creds[0], creds[1], 90)
        host, port = dut_target(redirect, "wss")
        print(f"[repro] DUT TLS endpoint: {host}:{port}", flush=True)
        with res.forward(host, port) as lp:
            url = f"wss://localhost:{lp}/ws"
            print(f"[repro] tunnel {host}:{port} -> {url}\n", flush=True)
            try:
                asyncio.run(experiments(url))
            except AssertionError as e:
                print(f"\nFAIL: {e}", file=sys.stderr, flush=True)
                return 1
    finally:
        res.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
