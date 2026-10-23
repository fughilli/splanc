"""On-hardware long-run video LATENCY / jitter / burst test (netstack wss).

The 3 s :video_stream_netstack test only asserts a flood rate. This one streams
PACED frames (default 30 fps, 24x24 RGB565) for minutes over the device's wss -- the
same transport the app streams camera/canvas video over -- and measures what the eye
sees as lag:

  * per-frame send->applied latency (device-side apply timestamps: every frame is
    followed by a TimeSyncPing, answered in order right after the frame applied, with
    a min-RTT clock fit from idle ping bursts before/after the stream);
  * inter-frame jitter of the device-side apply instants;
  * bursts: stalls (> --stall-ms between applied frames) followed by a catch-up, each
    attributed from the sender's TCP_INFO (retransmission vs receive-window-limited
    vs device busy).

Flow (one reservation): reserve -> flash -> ImprovBLE-provision -> load a WxH texture
effect + a linear map over a tunnelled control socket -> run the stdlib probe
(wss_video_latency.py) INSIDE the reservation container, network-local to the DUT,
under the per-rig AP lock -> parse + judge with video_latency_core. --plan runs several
(sender mode, fps, seconds) configurations back to back in the same reservation, so an
A/B of the sender policy costs one flash + provision.

The raw probe rows (+ the DUT serial log) are written to --out-dir (default: the bazel
test's undeclared outputs) so a run can be re-analyzed offline.

  bazel run -c opt //pi/hitl/harness:video_latency_netstack -- --server http://hitl-rig-2:8087
  bazel run -c opt //pi/hitl/harness:video_latency_netstack -- --plan fifo:30:120,latest:30:120
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import tempfile
import time

import video_latency_core as core
from hitl_video_stream import (
    _setup_effect,
    compile_fx_src,
    default_flashbundle,
    default_fx_compile,
)
from video_bench_core import bars_effect_src

_PROBE_RUNFILE = "_main/pi/hitl/harness/wss_video_latency.py"


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _probe_path() -> str | None:
    try:
        from python.runfiles import runfiles

        p = runfiles.Create().Rlocation(_PROBE_RUNFILE)
        if p and os.path.exists(p):
            return p
    except Exception:  # noqa: BLE001 — fall back to the source tree
        pass
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wss_video_latency.py")
    return here if os.path.exists(here) else None


def parse_plan(plan: str) -> list[tuple[str, float, float]]:
    """'fifo:30:120,latest:30:60' -> [(mode, fps, seconds), ...]."""
    out = []
    for item in plan.split(","):
        item = item.strip()
        if not item:
            continue
        mode, fps, secs = (item.split(":") + ["", ""])[:3]
        if mode not in ("fifo", "latest"):
            raise SystemExit(f"--plan: unknown sender mode {mode!r} (fifo|latest)")
        out.append((mode, float(fps or 30), float(secs or 120)))
    if not out:
        raise SystemExit("--plan is empty")
    return out


def _out_dir(args) -> str:
    d = (
        args.out_dir
        or os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR")
        or tempfile.mkdtemp(prefix="video_latency_")
    )
    os.makedirs(d, exist_ok=True)
    return d


def run_probe(res, host: str, port: int, mode: str, fps: float, seconds: float, args) -> str:
    cmd = (
        f"python3 /tmp/wss_video_latency.py --host {host} --port {port} "
        f"--tex-index {args.tex_index} --width {args.width} --height {args.height} "
        f"--fps {fps:g} --seconds {seconds:g} --mode {mode} --calib {args.calib} "
        f"--noise-pps {args.noise_pps:g}"
    )
    _log(f"[probe] {cmd}")
    proc = res.ssh(cmd, capture=True, timeout=seconds + 4 * args.calib + 120)
    if proc.stderr:
        sys.stderr.write(proc.stderr[-4000:])
    return proc.stdout or ""


def judge(text: str, fps: float, args) -> tuple[str, str]:
    run = core.parse(text)
    stats = core.analyze(run, fps, stall_ms=args.stall_ms)
    status = core.run_status(
        stats,
        core.Policy(
            min_applied_ratio=args.min_applied_ratio,
            max_p99_ms=args.max_p99_ms,
            max_stalls_per_min=args.max_stalls_per_min,
        ),
    )
    line = core.result_line(stats, status)
    if stats:
        for st in sorted(stats.stalls, key=lambda s: -s.gap_ms)[:10]:
            _log(
                f"  stall @seq {st.at_seq}: gap {st.gap_ms:.0f} ms, catch-up {st.catchup} "
                f"frames, retrans {st.retrans}, rwnd-limited {st.rwnd_ms:.0f} ms, "
                f"sender backlog {st.kern_q} B -> {st.cause}"
            )
    return status[0], line


def run_on_hardware(args) -> int:
    from hitl_client import Reservation
    from provision import dut_target, provision_dut

    plan = parse_plan(args.plan)
    probe = _probe_path()
    if not probe:
        raise SystemExit("wss_video_latency.py not found (runfiles or source tree)")
    fxb = compile_fx_src(
        args.fx_compile, bars_effect_src(args.width, args.height, comp=args.tex_comp)
    )
    out_dir = _out_dir(args)
    verdicts: list[str] = []
    res = Reservation(server=args.server, owner=args.owner)
    res.acquire()
    try:
        ssid, password = args.wifi_ssid, args.wifi_pass
        if not ssid:
            creds = res.wifi()
            if creds:
                ssid, password = creds
        if not ssid:
            raise SystemExit("no WiFi: rig serves no AP; pass --wifi-ssid")
        # The main bundle, then any --ab-bundle: each is flashed + provisioned in turn and
        # runs the same plan, so an A/B compares firmwares on the SAME DUT and air.
        bundles = [args.bundle] + list(args.ab_bundle or [])
        for b, bundle in enumerate(bundles):
            prefix = f"b{b}_" if len(bundles) > 1 else ""
            if bundle:
                _log(f"[flash] {prefix}{os.path.basename(bundle)} -> {res.host}")
                remote = f"/tmp/vl{b}_{os.path.basename(bundle)}"
                res.scp_to([bundle], remote)
                res.ssh(
                    f"hitl-flash {remote} --erase-fs "
                    f"--monitor --monitor-seconds {args.monitor_seconds:g}",
                    capture=True,
                    timeout=args.monitor_seconds + 120,
                )
            redirect = provision_dut(res, ssid, password, args.improv_timeout, args.improv_attempts)
            host, port = dut_target(redirect, "wss")
            with res.forward(host, port) as local_port:
                asyncio.run(_setup_effect(f"wss://localhost:{local_port}/ws", args, fxb))
            res.scp_to([probe], "/tmp/")
            # The setup socket closed; give the single-slot server a moment to re-listen.
            time.sleep(1.0)
            for k, (mode, fps, seconds) in enumerate(plan):
                with res.ap_lock(f"video latency {mode} {fps:g}fps {seconds:g}s -> {host}"):
                    text = run_probe(res, host, port, mode, fps, seconds, args)
                raw_path = os.path.join(out_dir, f"{prefix}video_latency_{k}_{mode}_{fps:g}fps.txt")
                with open(raw_path, "w", encoding="utf-8") as f:
                    f.write(text)
                verdict, line = judge(text, fps, args)
                verdicts.append(verdict)
                print(f"[video-latency] {prefix}run {k} mode={mode} -> {raw_path}", flush=True)
                print(line, flush=True)
                time.sleep(2.0)
    finally:
        res.release()
        for name, text in res.serial_logs.items():
            try:
                with open(os.path.join(out_dir, f"serial_{name}.log"), "w", encoding="utf-8") as f:
                    f.write(text)
            except OSError:
                pass
    if any(v == "FAIL" for v in verdicts):
        return 1
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL long-run video latency/jitter/burst test")
    ap.add_argument(
        "--plan",
        default=os.environ.get("HITL_VIDEO_PLAN", "fifo:30:120"),
        help="comma list of sender_mode:fps:seconds runs in one reservation "
        "(mode fifo = queue every frame like the app today, latest = drop stale)",
    )
    ap.add_argument("--width", type=int, default=24)
    ap.add_argument("--height", type=int, default=24)
    ap.add_argument("--tex-index", type=int, default=0)
    ap.add_argument("--tex-comp", default="f32", choices=["f32", "fixed8", "fixed16"])
    ap.add_argument("--effect-id", dest="effect_id", default="__vidlat")
    ap.add_argument("--led-count", type=int, default=256)
    ap.add_argument("--calib", type=int, default=40, help="idle clock-sync pings before/after")
    ap.add_argument("--stall-ms", type=float, default=100.0)
    ap.add_argument(
        "--noise-pps",
        type=float,
        default=0.0,
        help="stress: background UDP datagrams/s at the DUT during the stream (RX-ring load)",
    )
    ap.add_argument("--min-applied-ratio", type=float, default=0.9)
    ap.add_argument("--max-p99-ms", type=float, default=2000.0)
    ap.add_argument("--max-stalls-per-min", type=float, default=1e9)
    ap.add_argument("--out-dir", default=os.environ.get("HITL_VIDEO_OUT"))
    ap.add_argument("--fx-compile", default=default_fx_compile())
    ap.add_argument("--server", help="pin a specific rig (else pool discovery)")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--bundle", default=default_flashbundle())
    ap.add_argument("--no-bundle", dest="bundle", action="store_const", const=None)
    ap.add_argument(
        "--ab-bundle",
        action="append",
        help="another flash-bundle to run the same plan against afterwards, in the same "
        "reservation (repeatable): a firmware A/B on one DUT",
    )
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID"))
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    ap.add_argument("--improv-timeout", type=float, default=75.0)
    ap.add_argument("--improv-attempts", type=int, default=4)
    ap.add_argument("--monitor-seconds", type=float, default=8.0)
    ap.add_argument("--ws-verify", action="store_true")
    args = ap.parse_args()
    sys.exit(run_on_hardware(args))


if __name__ == "__main__":
    main()
