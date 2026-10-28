"""HITL: does Wi-Fi scanning / joining / failing to join disturb the LED output?

The C6 is single-core: the render task, the netstack loop (scan sweeps, PBKDF2, the
join, DHCP), the vendor WiFi task (channel switches) and BLE all share it. This drives
every Wi-Fi recovery path on demand over the wired console while an effect plays, and
times the LED output across each one from two sides at once:

  * the rig's logic analyzer decodes the WS2812 wire (frame start intervals + damage),
    where the DUT is tapped (hitl-rig-2: c6-003f08 / c6-fa0324);
  * the firmware's 1 Hz "[ft]" cadence line (render-start and wire-out-start
    interval stats, largest effect time step), from a console capture of the phase.

Effects: a light one (plasmaHueFixed, runs at the wire ceiling) and a heavy one
(slowLag, ~5 fps, lagging). Phases, per effect:

  steady   nothing (the baseline)
  scan     WIFI SCAN: one 13-channel background sweep (+ the set_channel calls)
  dhcp     WIFI DHCP: drop the lease, re-DISCOVER
  wrongpsk PROV <rig ssid> <wrong pass>: PBKDF2 + auth/assoc + failing 4-ways
  missing  PROV <no such ssid>: background sweeps on the backoff
  rejoin   PROV <rig ssid> <pass>: PBKDF2 + join + DHCP
  giveup   WIFI GIVEUP: re-join through the random-MAC (stable-address) fallback

`--gate` grades with wifi_cadence_core.grade (FAIL on any wire excursion past the
steady phase's spread, or a damaged frame; device view where there is no analyzer).
Raw analyzer JSON + console logs land in --out.

    bazel run //pi/hitl/harness:wifi_cadence -- --server http://hitl-rig-2:8087 \\
        --device c6-003f08 --out /tmp/cadence
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import shlex
import sys
import threading
import time
import uuid
from urllib.parse import urlparse

import wifi_cadence_core as core

PHASES = ("steady", "scan", "dhcp", "wrongpsk", "missing", "rejoin", "giveup")
GATED = ("scan", "dhcp", "wrongpsk", "missing", "rejoin", "giveup")


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


# The console attaches LEAD_S before the command; the analyzer arms ARM_S after the
# attach. Attaching a reader makes the C6 flush its buffered log over USB (frames ran
# 2-3 ms late for ~0.5 s, inside the ungraded warm-up); and the analyzer itself
# decodes glitch bits for up to ~1.7 s from a capture's start (wifi_cadence_core
# WARMUP_US = 2 s, not graded), so the command comes LEAD_S - ARM_S = 2.5 s into the
# capture.
LEAD_S = 3.0
ARM_S = 0.5


def _console_window(res, seconds: float, line: str | None) -> str:
    """Capture the console for LEAD_S + `seconds`, writing `line` LEAD_S after the reader
    attached (the same tty recipe as provision.wire_provision_dut). The lead keeps the
    console attach itself (USB CDC line-state change + the buffered log flush) out of the
    analyzer window, which starts 1 s after the attach."""
    write = (
        "printf '%s\\n' {} > /dev/ttyACM0".format(shlex.quote(line))
        if line
        else "printf '\\n' > /dev/ttyACM0"
    )
    cmd = (
        "stty -F /dev/ttyACM0 raw -echo 115200 2>/dev/null; "
        + f"timeout {seconds + LEAD_S:g} cat /dev/ttyACM0 & sleep {LEAD_S:g}; "
        + write
        + "; wait"
    )
    proc = res.ssh_serialized(cmd, capture=True, timeout=seconds + 60)
    return (proc.stdout or "") + (proc.stderr or "")


def _la(server: str, unit: str, duration_ms: int) -> dict:
    import urllib.request

    body = {"op": "timing", "unit": unit, "duration_ms": duration_ms, "include_frames": True}
    req = urllib.request.Request(
        server.rstrip("/") + "/shared/logic-analyzer",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120 + duration_ms / 1000.0) as r:
        return json.loads(r.read())


def _phase(res, unit: str | None, seconds: float, line: str | None) -> tuple[str, dict | None]:
    """One phase: an analyzer capture (if any) and a console window run together."""
    la: dict = {}

    def capture() -> None:
        try:
            la["res"] = _la(res.server, unit, int((seconds + LEAD_S - ARM_S) * 1000))
        except Exception as e:  # noqa: BLE001 — no analyzer data is SKIP-worthy, not fatal
            la["err"] = repr(e)

    out: dict = {}

    def console() -> None:
        out["log"] = _console_window(res, seconds, line)

    cth = threading.Thread(target=console, daemon=True)
    cth.start()
    th = None
    if unit:
        time.sleep(ARM_S)  # the command comes 2.5 s into the capture (after the warm-up)
        th = threading.Thread(target=capture, daemon=True)
        th.start()
    cth.join(timeout=seconds + LEAD_S + 120)
    if th:
        th.join(timeout=seconds + 180)
    log = out.get("log", "")
    if la.get("err"):
        _log(f"  analyzer: {la['err']}")
    return log, la.get("res")


async def _load_effect(ws_url: str, fxb: bytes, leds: int) -> None:
    from hitl_led_timing import _setup

    await _setup(ws_url, base64.b64encode(fxb).decode("ascii"), leds, 0)


def _policy_round_trip(res, out_dir: str) -> list[str]:
    """Offline mode end to end on the playing board: go offline at runtime, reboot in
    offline mode (radio never started), then back to auto (leases again, no reboot)."""
    _log("[policy] WIFI MODE offline (runtime)")
    to_off = _console_window(res, 12.0, "WIFI MODE offline")
    _log("[policy] reset: an offline-mode boot")
    proc = res.ssh_serialized("hitl-monitor --reset --seconds 20", capture=True, timeout=90)
    boot = (proc.stdout or "") + (proc.stderr or "")
    _log("[policy] WIFI MODE auto: must lease again without a reboot")
    back = _console_window(res, 45.0, "WIFI MODE auto")
    problems = core.grade_policy(to_off, boot, back)
    for name, text in (("to_offline", to_off), ("offline_boot", boot), ("back_to_auto", back)):
        _log(f"  policy/{name}: {len(text.splitlines())} lines")
        with open(os.path.join(out_dir, f"policy_{name}.log"), "w") as f:
            f.write(text)
    return problems


def run(args) -> int:
    from hitl_client import Reservation
    from hitl_led_capture import _reserved_device
    from provision import HarnessError, ensure_booted, wire_provision_dut

    effects = []
    for name, path in (("light", args.light_fxb), ("heavy", args.heavy_fxb)):
        if path and name in args.effects.split(","):
            with open(path, "rb") as fh:
                effects.append((name, fh.read()))
    os.makedirs(args.out, exist_ok=True)
    res = Reservation(
        server=args.server, owner=args.owner, device=args.device, sku="esp32c6", require="analyzer"
    )
    res.acquire()
    results: dict = {}
    policy_problems: list[str] = []
    try:
        unit = args.device or _reserved_device(res.server, res.id) or None
        ssid, password = res.wifi() or (None, None)
        if not ssid:
            raise SystemExit("rig serves no AP")
        res.scp_to([args.bundle], "/tmp/")
        proc = res.ssh_serialized(
            f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 10",
            capture=True,
            timeout=320,
        )
        if proc.returncode != 0:
            raise HarnessError(f"hitl-flash exited {proc.returncode}")
        ensure_booted(res, (proc.stdout or "") + (proc.stderr or ""), 10.0)
        for name, fxb in effects:
            try:
                url = wire_provision_dut(res, ssid, password, args.lease_timeout)
            except HarnessError as e:
                _log(f"[{name}] provisioning failed: {e} — skipping this effect")
                continue
            with res.forward(urlparse(url).hostname, 443) as port:
                asyncio.run(_load_effect(f"wss://localhost:{port}/ws", fxb, args.leds))
            time.sleep(args.settle)
            bogus = f"hitl-no-such-ap-{uuid.uuid4().hex[:6]}"
            lines = {
                "steady": None,
                "scan": "WIFI SCAN",
                "dhcp": "WIFI DHCP",
                "wrongpsk": f"PROV {ssid} wrong-pass-{uuid.uuid4().hex[:6]}",
                "missing": f"PROV {bogus} not-a-real-pass",
                "rejoin": f"PROV {ssid} {password}",
                "giveup": "WIFI GIVEUP",
            }
            secs = {
                "steady": args.steady_seconds,
                "scan": 8.0,
                "dhcp": 10.0,
                "wrongpsk": 20.0,
                "missing": 22.0,
                "rejoin": 20.0,
                "giveup": 20.0,
            }
            raw: dict = {}
            for ph in args.phases.split(","):
                _log(f"[{name}/{ph}] {lines[ph] or '(no command)'} for {secs[ph]:g}s")
                log, la = _phase(res, unit, secs[ph], lines[ph])
                raw[ph] = (log, la)
                with open(os.path.join(args.out, f"{name}_{ph}.log"), "w") as f:
                    f.write(log)
                if la:
                    with open(os.path.join(args.out, f"{name}_{ph}_la.json"), "w") as f:
                        json.dump(la, f)
            steady_log, steady_la = raw.get("steady", ("", None))
            steady_frames = (steady_la or {}).get("frames") or []
            base = (
                core.baseline(core.wire_periods(steady_frames)) if len(steady_frames) > 2 else None
            )
            steady_dev = core.device_view(steady_log)
            results[name] = {"baseline": base}
            for ph, (log, la) in raw.items():
                frames = (la or {}).get("frames") or []
                w = (
                    core.phase_wire(core.wire_periods(frames), frames, base)
                    if base
                    else {"frames": 0}
                )
                d = core.phase_device(core.device_view(log), steady_dev)
                results[name][ph] = {"wire": w, "device": d}
                _log(f"  {name}/{ph}: wire={json.dumps(w)} device={json.dumps(d)}")
        if args.policy:
            policy_problems += _policy_round_trip(res, args.out)
    finally:
        res.release()

    g = core.grade(results, GATED)
    if policy_problems:
        g["problems"] = g["problems"] + policy_problems
        g["verdict"] = "FAIL"
    with open(os.path.join(args.out, "results.json"), "w") as f:
        json.dump({"results": results, **g}, f, indent=1)
    _log("WIFI_CADENCE_JSON " + json.dumps({"results": results, **g}, sort_keys=True))
    for p in g["problems"]:
        _log(f"  PROBLEM: {p}")
    _log(
        f"RESULT unit={res._unit} verdict={g['verdict']}"
        + (f" skip={g['skip']!r}" if g["skip"] else "")
    )
    if g["verdict"] == "FAIL":
        tail = res.serial_tail()
        if tail:
            _log(tail)
    return 1 if (args.gate and g["verdict"] == "FAIL") else 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", default=os.environ.get("HITL_DEVICE") or None)
    ap.add_argument("--bundle", default=_runfile(os.environ.get("HITL_BUNDLE_RUNFILE")))
    ap.add_argument("--light-fxb", default=_runfile(os.environ.get("CADENCE_LIGHT_FXB_RUNFILE")))
    ap.add_argument("--heavy-fxb", default=_runfile(os.environ.get("CADENCE_HEAVY_FXB_RUNFILE")))
    ap.add_argument("--effects", default="light,heavy")
    ap.add_argument("--phases", default=",".join(PHASES))
    ap.add_argument("--leds", type=int, default=250)
    ap.add_argument("--steady-seconds", type=float, default=12.0)
    ap.add_argument("--settle", type=float, default=4.0, help="after loading an effect (s)")
    ap.add_argument("--lease-timeout", type=float, default=90.0)
    ap.add_argument("--gate", action="store_true", help="exit 1 on FAIL")
    ap.add_argument(
        "--policy",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="also run the offline-mode round trip (runtime offline, offline boot, back to auto)",
    )
    ap.add_argument(
        "--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR") or "wifi_cadence_out"
    )
    args = ap.parse_args()
    if not args.bundle or not (args.light_fxb or args.heavy_fxb):
        raise SystemExit("need --bundle and an effect (run via bazel)")
    if "steady" not in args.phases.split(","):
        raise SystemExit("--phases must include steady (the baseline)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
