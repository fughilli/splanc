"""HITL: a slow effect lags (never parked) and the board never reboots for WiFi.

Field regression (PixieLamp, netstack C6): a ~9 fps effect was PARKED by the
framerate autoscaler after ~6 s, and a stored network missing from the boot scan made
the board esp_restart() every 20 s to rescan — so the fixture showed a few seconds of
the effect, then nothing, then a reboot, forever. This gate proves the fixed firmware
on real hardware, inside ONE reservation:

  1. flash this tree's netstack bundle --erase-fs and wire-provision onto the rig AP;
  2. over wss: upload a 250-LED map and a deliberately slow effect (slowLag.fx), then
     for --slow-seconds capture the DUT console while sending a control command
     (set_fps -> fps_state) every few seconds: the effect's frame counter must keep
     advancing (never parked, every LED shaded), and every command must be answered
     within the latency budget;
  3. wire-PROV credentials for an SSID that does not exist and capture the console for
     --nonet-seconds: NO reset (no boot banner; the effect's frame counter and time keep
     climbing), the effect keeps running, the background rescan runs;
  4. wire-PROV the rig AP again: the board must lease (rejoin without a reboot).

The pass/fail policy is no_reboot_no_park_core (unit-tested in //pi/hitl/tests). The
Reservation's always-on serial capture is saved and its tail printed on failure.

    bazel run //pi/hitl/harness:no_reboot_no_park -- --server http://hitl-rig-1:8087

Prints `RESULT ... verdict=PASS|FAIL|SKIP`; exit 0 on PASS/SKIP, 1 on FAIL.
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
from contextlib import ExitStack
from urllib.parse import urlparse

import hitl_ws
import no_reboot_no_park_core as core


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


def _console_window(res, seconds: float, prov: tuple[str, str] | None = None) -> str:
    """Capture the DUT console for `seconds` (optionally writing a wired PROV line
    once the reader is attached). Same tty recipe as provision.wire_provision_dut: a
    write to the port wakes the C6's CDC TX, and the Reservation's background capture
    is paused around this command (ssh_serialized)."""
    if prov:
        line = "printf 'PROV %s %s\\n' {} {} > /dev/ttyACM0".format(
            shlex.quote(prov[0]), shlex.quote(prov[1])
        )
    else:
        line = "printf '\\n' > /dev/ttyACM0"  # unmatched console input is ignored
    cmd = (
        "stty -F /dev/ttyACM0 raw -echo 115200 2>/dev/null; "
        + f"timeout {seconds:g} cat /dev/ttyACM0 & sleep 0.5; "
        + line
        + "; wait"
    )
    proc = res.ssh_serialized(cmd, capture=True, timeout=seconds + 60)
    return (proc.stdout or "") + (proc.stderr or "")


async def _slow_phase(ws_url: str, fxb: bytes, args, out: dict) -> list[float | None]:
    """Map + slow effect, then control probes for args.slow_seconds. Returns RTTs."""
    from hitl_map_upload import _open_ws, _rpc, _submit_chunked
    from map_upload_core import synth_output_map

    sock = await _open_ws(ws_url, True, time.monotonic() + hitl_ws.CONNECT_SETTLE)
    rtts: list[float | None] = []
    try:
        got = await _submit_chunked(
            sock, synth_output_map(args.leds, "__noreboot"), "MAP", 1, "map"
        )
        _log(f"[slow] {args.leds}-LED map accepted ({got!r})")
        await _rpc(
            sock,
            {
                "type": "submit_effect",
                "effect_id": "__slowlag",
                "fxb": base64.b64encode(fxb).decode("ascii"),
                "activate": True,
            },
            "result_ready",
        )
        _log("[slow] slow effect active; probing control while it renders")
        out["started"] = True
        # The console capture runs in a thread for the same window (see run()).
        out["capture_go"].set()
        await asyncio.sleep(3.0)
        end = time.monotonic() + args.slow_seconds - 3.0
        last: dict = {}
        while time.monotonic() < end:
            # Drop anything already buffered (an unsolicited lag-change fps_state), so
            # the round trip below times THIS command's reply, not a queued push.
            while True:
                try:
                    await asyncio.wait_for(sock.recv(), timeout=0.05)
                except asyncio.TimeoutError:
                    break
            t0 = time.monotonic()
            try:
                last = await _rpc(
                    sock,
                    {"type": "set_fps", "target_fps": 0},
                    "fps_state",
                    timeout=core.CONTROL_MAX_S * 2,
                )
                rtts.append(time.monotonic() - t0)
            except (asyncio.TimeoutError, OSError, RuntimeError) as e:
                _log(f"[slow] control probe failed: {e!r}")
                rtts.append(None)
            await asyncio.sleep(args.probe_every)
        out["fps_state"] = {
            k: last.get(k)
            for k in ("currentFps", "achievedFps", "lagging", "minFps", "maxFps", "aborted")
        }
        _log(f"[slow] last fps_state {out['fps_state']}")
    finally:
        try:
            await sock.close()
        except OSError:
            pass
    return rtts


def run(args) -> int:
    from hitl_client import Reservation
    from provision import HarnessError, ensure_booted, wire_provision_dut

    with open(args.fxb, "rb") as fh:
        fxb = fh.read()
    res = Reservation(server=args.server, owner=args.owner, device=args.device, sku="esp32c6")
    res.acquire()
    provisioned = False
    slow = nonet = None
    rejoined: bool | None = None
    logs: dict[str, str] = {}
    extra: dict = {}
    try:
        creds = res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP")
        ssid, password = creds
        res.ssh("mkdir -p /tmp/nrnp")
        res.scp_to([args.bundle], "/tmp/nrnp/")
        remote = f"/tmp/nrnp/{os.path.basename(args.bundle)}"
        _log("[1/4] flash --erase-fs + wired PROV onto the rig AP")
        proc = res.ssh_serialized(
            f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds 10",
            capture=True,
            timeout=320,
        )
        if proc.returncode != 0:
            raise HarnessError(f"hitl-flash exited {proc.returncode}")
        ensure_booted(res, (proc.stdout or "") + (proc.stderr or ""), 10.0)
        try:
            url = wire_provision_dut(res, ssid, password, args.lease_timeout)
            provisioned = True
        except HarnessError as e:
            _log(f"  provisioning failed: {e}")
            url = ""

        if provisioned:
            ip = urlparse(url).hostname
            with ExitStack() as stack:
                port = stack.enter_context(res.forward(ip, 443))
                ws_url = f"wss://localhost:{port}/ws"
                _log(f"[2/4] slow effect for {args.slow_seconds:g}s ({ws_url})")
                state: dict = {"capture_go": threading.Event(), "started": False}
                cap: dict = {}

                def capture() -> None:
                    if state["capture_go"].wait(timeout=hitl_ws.CONNECT_SETTLE + 120):
                        cap["log"] = _console_window(res, args.slow_seconds)

                th = threading.Thread(target=capture, daemon=True)
                th.start()
                try:
                    rtts = asyncio.run(_slow_phase(ws_url, fxb, args, state))
                except (SystemExit, OSError, RuntimeError, asyncio.TimeoutError) as e:
                    _log(f"  slow phase could not run: {e!r}")
                    rtts = []
                th.join(timeout=args.slow_seconds + 90)
                if state["started"]:
                    logs["slow"] = cap.get("log", "")
                    slow = core.grade_slow(
                        logs["slow"], args.slow_seconds, rtts, fps_state=state.get("fps_state")
                    )
                    extra["fps_state"] = state.get("fps_state")
                    _log(f"  {json.dumps(slow)}")

            if slow is not None:
                bogus = f"hitl-no-such-ap-{uuid.uuid4().hex[:6]}"
                _log(f"[3/4] PROV {bogus!r} (no such AP); watching {args.nonet_seconds:g}s")
                logs["nonet"] = _console_window(res, args.nonet_seconds, (bogus, "not-a-real-pass"))
                nonet = core.grade_nonet(logs["nonet"], args.nonet_seconds)
                _log(f"  {json.dumps(nonet)}")

                _log(f"[4/4] PROV the rig AP {ssid!r} again: it must lease without a reboot")
                try:
                    url2 = wire_provision_dut(res, ssid, password, args.lease_timeout)
                    rejoined = True
                    _log(f"  rejoined: {url2}")
                except HarnessError as e:
                    rejoined = False
                    _log(f"  rejoin failed: {e}")
    finally:
        res.release()

    g = core.verdict(provisioned, slow, nonet, rejoined)
    if args.log_dir:
        os.makedirs(args.log_dir, exist_ok=True)
        for name, text in logs.items():
            with open(os.path.join(args.log_dir, f"no_reboot_no_park_{name}.log"), "w") as f:
                f.write(text)
    if g["verdict"] == "FAIL":
        for name, text in logs.items():
            _log(f"----- {name} console window -----")
            _log(text[-6000:])
        tail = res.serial_tail()
        if tail:
            _log(tail)
    _log(
        "NO_REBOOT_NO_PARK_JSON "
        + json.dumps(
            {"slow": slow, "nonet": nonet, "rejoined": rejoined, **extra, **g}, sort_keys=True
        )
    )
    _log(core.result_line(res._unit or "?", g, slow, nonet))
    for p in g["problems"]:
        _log(f"  PROBLEM: {p}")
    return 1 if g["verdict"] == "FAIL" else 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", default=os.environ.get("HITL_DEVICE") or None)
    ap.add_argument("--bundle", default=_runfile(os.environ.get("HITL_BUNDLE_RUNFILE")))
    ap.add_argument("--fxb", default=_runfile(os.environ.get("NO_PARK_FXB_RUNFILE")))
    ap.add_argument("--leds", type=int, default=250, help="map size (the PixieLamp's)")
    ap.add_argument("--slow-seconds", type=float, default=75.0)
    ap.add_argument("--nonet-seconds", type=float, default=100.0)
    ap.add_argument("--probe-every", type=float, default=3.0, help="control probe period (s)")
    ap.add_argument("--lease-timeout", type=float, default=90.0)
    ap.add_argument(
        "--log-dir",
        default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR"),
        help="save each console window here (default: the test outputs dir)",
    )
    args = ap.parse_args()
    if not args.bundle or not args.fxb:
        raise SystemExit("need --bundle and --fxb (run via bazel)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
