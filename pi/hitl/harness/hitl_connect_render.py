"""HITL gate (desk D-460): a NEW client's TLS handshake never makes frames late.

Measured on the M6 bench (mesh_effect r7/r8): every new wss connection under a heavy effect
at 80 fps cost 20-24 late frames (16-25 ms intervals against 12.5 ms), because the server
handshake's ECDHE + ECDSA (~0.5-0.8 s of CPU) ran at render's priority and time-sliced with
frames. The handshake now runs strictly below render, and while it waits on render's sleeps
render holds a reserved slice (at most half the CPU): the effect drops AT ONCE to a lower
steady rung for the handshake's span and comes back after it. This drives that on one rig
C6, in one reservation:

1. setup (not gated): flash --erase-fs, wire-provision, then size swirlHeavy.fx's map so one
   frame's compute is ~9 ms (the 80 fps rung holds it with its default 20% share; at a
   50% reserve it needs a 50 fps rung);
2. steady: no client for --steady-s (the 80 fps baseline);
3. connect: --clients NEW clients one after another, each TCP + TLS + WS + hello (the way
   the app connects), --gap apart;
4. after: no client for --after-s (the rung comes back).

Verdict (connect_render_core): PASS = no late frame (`[late]`: an interval over 1.5 periods
of the live rung) in any phase, every client connected within 8 s, and the reserve engaged
(`[rsv]`) during the connects; FAIL otherwise (the DUT serial log is printed and saved);
SKIP on bench failures. `--baseline` grades an image without the reserve (the A/B: it
reports the late frames and never requires `[rsv]`).

    bazel run //pi/hitl/harness:connect_render_netstack -- --server http://hitl-rig-1:8087
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from urllib.parse import urlparse

import connect_render_core as core


def _log(msg: str) -> None:
    print(msg, flush=True)


def _runfile(rel: str | None) -> str | None:
    if not rel:
        return None
    try:
        from python.runfiles import runfiles

        got = runfiles.Create().Rlocation(rel)
        return got if got and os.path.exists(got) else None
    except Exception:
        return None


# One frame's compute as a share of the 25 fps floor's 40 ms period (the reachability
# calibration's unit): 9 ms. The 80 fps rung holds it (<= 80% of 12.5 ms); a 50% reserve
# needs an 18 ms period (the 50 fps rung, or 40 fps on a mesh grid).
CAL_DUTY = 9.0 / 40.0
CAL_BAND = (8.0 / 40.0, 9.8 / 40.0)


def run(args) -> int:
    import hitl_ws
    from hitl_client import Reservation, ReserveError
    from hitl_heavy_effect_reachability import _attempt, _calibrate
    from provision import HarnessError, ensure_booted, wire_provision_dut

    with open(args.fxb, "rb") as fh:
        fxb = fh.read()
    r = Reservation(server=args.server, owner=args.owner, device=args.unit, sku="esp32c6")
    try:
        r.acquire()
    except ReserveError as e:
        _log(f"[cnr] no DUT ({e}) — SKIP (bench)")
        return 0
    phases: dict[str, tuple[float, float]] = {}
    attempts: list[dict] = []
    cal: dict = {}
    reached = False
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            _log("[cnr] the rig serves no AP — SKIP")
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=320,
            )
            if fp.returncode != 0:
                _log(f"[cnr] flash failed rc={fp.returncode} — SKIP (bench)")
                return 0
            ensure_booted(r, (fp.stdout or "") + (fp.stderr or ""), 10.0)
        try:
            url = wire_provision_dut(r, ssid, pw, 90)
        except HarnessError as e:
            _log(f"[cnr] wired provisioning failed ({e}) — SKIP (bench)")
            return 0
        with r.forward(urlparse(url).hostname, 443) as lp:
            ws_url = f"wss://localhost:{lp}/ws"
            base = _attempt(ws_url, time.monotonic(), timeout=hitl_ws.OPEN_TIMEOUT)
            if base["cat"] != "ok":
                time.sleep(10)  # a freshly provisioned board may still be issuing its cert
                base = _attempt(ws_url, time.monotonic(), timeout=hitl_ws.OPEN_TIMEOUT)
            if base["cat"] != "ok":
                _log("[cnr] no baseline connection — SKIP (bench)")
                return 0
            t0 = time.time()
            cal = asyncio.run(_calibrate(ws_url, fxb, args, duty=CAL_DUTY, band=CAL_BAND))
            if not cal:
                _log("[cnr] calibration read no frame cost — SKIP (bench)")
                return 0
            # The autoscaler climbs one rung per clean 30-frame window from its 30 fps start.
            time.sleep(args.settle_s)
            phases["setup"] = (t0, time.time())
            reached = True

            t0 = time.time()
            time.sleep(args.steady_s)
            phases["steady"] = (t0, time.time())
            _log(f"[cnr] steady: {phases['steady'][1] - t0:.1f} s")

            t0 = time.time()
            m0 = time.monotonic()
            for _ in range(args.clients):
                a = _attempt(ws_url, m0, timeout=core.HANDSHAKE_S)
                attempts.append(
                    {
                        "ok": a["cat"] == "ok",
                        "s": round(a["s"], 3),
                        "cat": a["cat"],
                        "err": a.get("err"),
                    }
                )
                time.sleep(args.gap)
            phases["connect"] = (t0, time.time())
            _log(f"[cnr] connect: {len(attempts)} clients in {phases['connect'][1] - t0:.1f} s")

            t0 = time.time()
            time.sleep(args.after_s)
            phases["after"] = (t0, time.time())
    except Exception as e:  # noqa: BLE001
        _log(f"[cnr] driver: {type(e).__name__}: {e}" + ("" if reached else " — SKIP (bench)"))
    finally:
        r.release()  # fetches the DUT serial log
    if not reached:
        return 0
    text = "\n".join(r.serial_logs.values())
    rep = core.report(text, phases)
    verdict, why = core.verdict(rep, attempts, require_reserve=not args.baseline)
    summ = core.summary(rep, attempts)
    _log(f"[cnr] cal={json.dumps({k: cal.get(k) for k in ('leds', 'frame_cycles', 'duty')})}")
    _log(f"[cnr] {json.dumps(summ)}")
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump(
                {
                    "cal": cal,
                    "spans": phases,
                    "attempts": attempts,
                    "summary": summ,
                    "verdict": verdict,
                    "why": why,
                },
                f,
                indent=1,
            )
        with open(os.path.join(args.out, "serial.log"), "w") as f:
            f.write(text)
    if args.baseline:
        _log(f"[cnr] RESULT BASELINE (not gated) {why}")
        return 0
    _log(f"[cnr] RESULT {verdict} {why}")
    if verdict == "FAIL":
        _log(r.serial_tail())
    return 1 if verdict == "FAIL" else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "connect-render"))
    ap.add_argument("--unit", default=os.environ.get("HITL_DEVICE"), help="pin a DUT by name")
    ap.add_argument("--bundle", default=_runfile(os.environ.get("HITL_BUNDLE_RUNFILE")))
    ap.add_argument("--no-bundle", dest="bundle", action="store_const", const=None)
    ap.add_argument("--fxb", default=_runfile(os.environ.get("HEAVY_FXB_RUNFILE")))
    ap.add_argument("--probe-leds", type=int, default=64, help="calibration probe map size")
    ap.add_argument("--leds", type=int, default=0, help="skip calibration: use this map size")
    ap.add_argument("--settle", type=float, default=3.0, help="perf window before a cost read (s)")
    ap.add_argument("--settle-s", type=float, default=12.0, help="climb to the top rung (s)")
    ap.add_argument("--steady-s", type=float, default=10.0)
    ap.add_argument("--clients", type=int, default=8)
    ap.add_argument("--gap", type=float, default=3.0, help="pause after each client (s)")
    ap.add_argument("--after-s", type=float, default=8.0)
    ap.add_argument(
        "--baseline", action="store_true", help="an image without the reserve: report only"
    )
    ap.add_argument("--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR"))
    args = ap.parse_args()
    if not args.fxb:
        raise SystemExit("need --fxb (run via bazel)")
    return run(args)


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.exit(main())
