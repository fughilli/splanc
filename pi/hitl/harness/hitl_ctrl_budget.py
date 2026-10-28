"""On-LAN live-control latency budget (docs/design/live-control.md "Measuring the budget").

The live_latency gate measures from the harness host, through the tailnet and an ssh
tunnel, so its numbers are dominated by a 110-160 ms base RTT. This bench measures the
real budget on the LAN and attributes it to stages:

1. reserve a netstack C6; flash the LM_CTRL_TRACE measurement image
   (//firmware/player_app:esp32c6_netstack_ctrltrace_flashbundle: same player, plus
   per-stage timestamps for every control message and every effect frame);
2. per effect in the plan (``heavy``: the gate's 4-uniform shader, autoscaled to its
   25 fps floor; ``light``: the same uniforms, trivial shade, pinned at 60 fps), load a
   map + the effect over a tunnelled control socket;
3. per (transport, background load) run the stdlib probe (ctrl_budget_probe.py) INSIDE
   the reservation container, straight to the DUT over the rig AP, under the AP lock:
   a 4 knob x 100 Hz stream (wss: the app's live channel; osc: datagrams to udp/9000),
   optionally with +N pps of background UDP;
4. the probe pages the device trace out after each window; ctrl_budget_core maps the
   device clock onto the probe's and attributes every counter value's input-to-photon
   latency to pace / uplink / decode / mutex / frame wait / render / wire.

Prints a markdown budget table + one RESULT line per configuration. --gate turns the
optional thresholds on (p50/p99 of ``apply`` per effect); without it the bench only
reports (exit 0 unless nothing could be measured).

    bazel run -c opt //pi/hitl/harness:ctrl_budget_netstack -- --server http://hitl-rig-1:8087
    bazel run -c opt //pi/hitl/harness:ctrl_budget_netstack -- --plan heavy:wss:0,heavy:osc:0
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import ssl
import sys
import tempfile
import time

import ctrl_budget_core as core
from hitl_live_latency import HEAVY_FX, Conn, _rlocation, compile_fx_src, linear_map

_FXC_RUNFILE = "_main/fx_compiler/fx_compile"
_HERE = os.path.dirname(os.path.abspath(__file__))

# Same uniforms as HEAVY_FX (so the probe drives the same slots), almost free to shade:
# the frame is bounded by the wire + fixed overhead, so the autoscaler could run it at
# 80 fps; the bench pins 60.
LIGHT_FX = """\
// Live-control budget, light effect (pi/hitl/harness/hitl_ctrl_budget.py).
uniform float probe : 0.0 .. 16777216.0 = 0.0;
uniform float k1 : 0.0 .. 1.0 = 0.5;
uniform float k2 : 0.0 .. 1.0 = 0.5;
uniform float k3 : 0.0 .. 1.0 = 0.5;
void update() {}
vec3 shade(Led led) {
  return vec3(k1 + fract(probe * 0.001) * 0.02, k2, k3);
}
"""

EFFECTS = {"heavy": (HEAVY_FX, 0), "light": (LIGHT_FX, 60)}


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def parse_plan(
    plan: str, inflight: int = 1, ack_ms: float = 400.0
) -> list[tuple[str, str, float, int, float]]:
    """'heavy:wss:0,heavy:osc:400,light:wss:0:2:0' -> [(effect, transport, noise_pps,
    inflight, ack_timeout_ms), ...]; the 4th/5th fields (wss only) override --inflight /
    --ack-timeout-ms for that run (inflight 0 = as the app; ack 0 = adaptive)."""
    out = []
    for item in plan.split(","):
        item = item.strip()
        if not item:
            continue
        eff, tr, noise, infl, ack = (item.split(":") + ["", "", "", ""])[:5]
        if eff not in EFFECTS or tr not in ("wss", "osc"):
            raise SystemExit(f"--plan: bad item {item!r} (effect heavy|light, transport wss|osc)")
        out.append(
            (
                eff,
                tr,
                float(noise or 0),
                int(infl) if infl else inflight,
                float(ack) if ack else ack_ms,
            )
        )
    if not out:
        raise SystemExit("--plan is empty")
    return out


async def setup_effect(url: str, args, fxb: bytes, target_fps: int) -> float:
    """Map + effect + fps over the control socket; returns the device's settled fps."""
    from hitl_led_capture import _connect_ws

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    sock = await _connect_ws(url, ctx, settle_s=30.0)
    c = Conn(sock)
    try:
        welcome = await c.rpc(
            {"type": "hello", "client": "ctrl_budget", "app_version": "1"}, "welcome"
        )
        _log(f"[setup] fw={welcome.get('fwVersion') or welcome.get('fw_version')}")
        await c.rpc(linear_map(args.leds), "result_ready")
        await c.rpc({"type": "set_led_count", "led_count": args.leds}, "led_count_state")
        await c.rpc({"type": "set_fps", "target_fps": target_fps, "no_abort": True}, "fps_state")
        b64 = base64.b64encode(fxb).decode("ascii")
        await c.rpc(
            {"type": "submit_effect", "effect_id": "__ctrlbud", "fxb": b64, "activate": True},
            "result_ready",
        )
        await asyncio.sleep(args.settle_fx)
        await c.rpc({"type": "set_perf", "mode": "BASIC", "interval_ms": 0}, "perf_report")
        await asyncio.sleep(2.0)
        perf = await c.rpc({"type": "get_perf_report"}, "perf_report")
        await c.send({"type": "set_perf", "mode": "OFF", "interval_ms": 0})
        fps = float(perf.get("currentFps") or 0)
        cyc = perf.get("frameCyclesMean") or 0
        _log(f"[setup] render {fps:g} fps, frame {cyc / 160e3:.1f} ms")
        return fps
    finally:
        try:
            await asyncio.wait_for(sock.close(), 10)
        except Exception:  # noqa: BLE001
            pass


def run_probe(
    res,
    host: str,
    transport: str,
    noise: float,
    min_iv_ms: float,
    inflight: int,
    ack_ms: float,
    args,
) -> str:
    cmd = (
        f"python3 /tmp/ctrl_budget_probe.py --host {host} --transport {transport} "
        f"--windows {args.windows} --window-s {args.window_s:g} --noise-pps {noise:g} "
        f"--min-interval-ms {min_iv_ms:.1f} --inflight {inflight} "
        f"--ack-timeout-ms {ack_ms:g}" + (" --no-nodelay" if args.no_nodelay else "")
    )
    _log(f"[probe] {cmd}")
    budget_s = args.windows * (args.window_s + 8) + 60
    proc = res.ssh(cmd, capture=True, timeout=budget_s)
    if proc.stderr:
        sys.stderr.write(proc.stderr[-3000:])
    return proc.stdout or ""


def _out_dir(args) -> str:
    d = (
        args.out_dir
        or os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR")
        or tempfile.mkdtemp(prefix="ctrl_budget_")
    )
    os.makedirs(d, exist_ok=True)
    return d


def run_on_hardware(args) -> int:
    from hitl_client import Reservation, ReserveError
    from provision import HarnessError, dut_target, provision_dut, wire_provision_dut

    plan = parse_plan(args.plan, args.inflight, args.ack_timeout_ms)
    out_dir = _out_dir(args)
    fxbs = {e: compile_fx_src(args.fx_compile, EFFECTS[e][0]) for e in {p[0] for p in plan}}
    probe = os.path.join(_HERE, "ctrl_budget_probe.py")
    probe = _rlocation("_main/pi/hitl/harness/ctrl_budget_probe.py") or probe
    # The main bundle, then any --ab-bundle LABEL=PATH: each is flashed + provisioned in
    # turn and runs the same plan, so an A/B compares firmwares on the same DUT and air.
    bundles = [("", args.bundle)]
    for ab in args.ab_bundle or []:
        lab, _, path = ab.partition("=")
        bundles.append((lab, path))
    budgets: list[core.Budget] = []
    res = Reservation(server=args.server, owner=args.owner, device=args.unit, sku="esp32c6")
    try:
        res.acquire()
    except ReserveError as e:
        # Infra, not the firmware: a contended rig that never handed us a DUT. SKIP.
        _log(f"[budget] no DUT ({e}) — SKIP (bench)")
        return 0
    try:
        ssid, pw = res.wifi() or (None, None)
        if not ssid:
            _log("[budget] the rig serves no AP — SKIP")
            return 0
        res.scp_to([probe], "/tmp/")
        for b_label, bundle in bundles:
            if bundle:
                remote = f"/tmp/cb{len(budgets)}_{os.path.basename(bundle)}"
                res.scp_to([bundle], remote)
                fp = res.ssh_serialized(
                    f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds 8",
                    capture=True,
                    timeout=240,
                )
                if fp.returncode != 0:
                    _log(f"[budget] flash {b_label or 'main'} failed rc={fp.returncode} — skipped")
                    continue
            try:
                redirect = wire_provision_dut(res, ssid, pw, 60)
            except HarnessError as e:
                _log(f"[budget] wired provisioning failed ({e}); falling back to ImprovBLE")
                redirect = provision_dut(res, ssid, pw, 90)
            host, port = dut_target(redirect, "wss")
            loaded = None
            fps = 0.0
            for eff, transport, noise, inflight, ack_ms in plan:
                if eff != loaded:
                    with res.forward(host, port) as lp:
                        fps = asyncio.run(
                            setup_effect(
                                f"wss://localhost:{lp}/ws", args, fxbs[eff], EFFECTS[eff][1]
                            )
                        )
                    loaded = eff
                    time.sleep(1.5)  # the single-slot server re-listens after the setup socket
                min_iv = max(8.0, min(100.0, 1000.0 / fps)) if fps else 40.0
                label = (
                    (f"{b_label} " if b_label else "")
                    + f"{eff} {transport}"
                    + (f" x{inflight or 'app'}" if transport == "wss" and inflight != 1 else "")
                    + (
                        (" ack-adaptive" if ack_ms <= 0 else f" ack{ack_ms:g}")
                        if transport == "wss" and ack_ms != 400
                        else ""
                    )
                    + (f" +{noise:g}pps" if noise else "")
                )
                with res.ap_lock(f"ctrl budget {label} -> {host}"):
                    text = run_probe(res, host, transport, noise, min_iv, inflight, ack_ms, args)
                tag = label.replace(" ", "_").replace("+", "")
                with open(
                    os.path.join(out_dir, f"ctrl_budget_{tag}.txt"), "w", encoding="utf-8"
                ) as f:
                    f.write(text)
                b = core.budget(core.parse(text), label)
                budgets.append(b)
                print(core.result_line(b), flush=True)
                for n in b.notes[:6]:
                    _log(f"  note: {n}")
                time.sleep(1.0)
    finally:
        res.release()
        for name, text in res.serial_logs.items():
            try:
                with open(os.path.join(out_dir, f"serial_{name}.log"), "w", encoding="utf-8") as f:
                    f.write(text)
            except OSError:
                pass
    print(core.table(budgets), flush=True)
    if not any(b.n for b in budgets):
        return 1
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument(
        "--plan",
        default="heavy:wss:0,heavy:wss:400,heavy:osc:0,heavy:osc:400,"
        "light:wss:0,light:wss:400,light:osc:0,light:osc:400",
        help="comma list of effect:transport:noise_pps (effect heavy|light, transport wss|osc)",
    )
    ap.add_argument("--windows", type=int, default=3)
    ap.add_argument("--window-s", type=float, default=7.0)
    ap.add_argument("--inflight", type=int, default=1, help="wss: unacknowledged batches")
    ap.add_argument("--no-nodelay", action="store_true")
    ap.add_argument("--ack-timeout-ms", type=float, default=400.0, help="wss; 0 = adaptive")
    ap.add_argument("--leds", type=int, default=150)
    ap.add_argument("--settle-fx", type=float, default=4.0)
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "ctrl_budget"))
    ap.add_argument("--unit", default=os.environ.get("HITL_DEVICE"))
    ap.add_argument(
        "--bundle",
        default=_rlocation(
            os.environ.get(
                "HITL_BUNDLE_RUNFILE",
                "_main/firmware/player_app/esp32c6_netstack_ctrltrace_flashbundle.tar",
            )
        ),
    )
    ap.add_argument("--no-bundle", dest="bundle", action="store_const", const=None)
    ap.add_argument(
        "--ab-bundle",
        action="append",
        help="LABEL=PATH: another flash-bundle to run the same plan against afterwards, in "
        "the same reservation (repeatable): a firmware A/B on one DUT",
    )
    ap.add_argument("--fx-compile", default=_rlocation(_FXC_RUNFILE) or "fx_compile")
    ap.add_argument("--out-dir", default=os.environ.get("HITL_CTRL_BUDGET_OUT"))
    args = ap.parse_args()
    sys.exit(run_on_hardware(args))


if __name__ == "__main__":
    main()
