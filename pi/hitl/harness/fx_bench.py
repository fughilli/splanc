"""HITL FX benchmark harness (FUG-11): measure the effects VM on the REAL C6 and
emit a device-measurement bundle that the web builder fits + validates into an
authoritative execution-cost profile.

Kevin's point: the host VM has too much compute to predict the C6 — the
authoritative measurement must come from the actual hardware. This drives it via
the HITL rig:

  1. reserve a free rig from the pool (hitl_client.Reservation),
  2. optionally flash the firmware flash-bundle,
  3. tunnel to the device's player WebSocket (wss) through the rig,
  4. for each calibration micro-program: compile it (fx_compile), submit_effect,
     set_perf(FULL), drain a stable PerfReport,
  5. write a device-measurement bundle (fx_bench_core.assemble_bundle) — base64
     `.fxb` + cycle-accurate measured cycles per program.

The bundle is then fed to web/src/effects/deviceProfile.ts `buildDeviceProfile`
(via the app's "Import measurement bundle" action), which reuses the calibration
fit and VALIDATES it on the held-out programs, stamping measuredError.

Requires a reachable rig + a provisioned board, so it is `bazel run`, never
`bazel test`. The pure logic (perf→sample, bundle schema) lives in
fx_bench_core.py and IS unit-tested (//pi/hitl/tests). A --replay path rebuilds a
bundle from a recorded session with no hardware.

The calibration `.fx` programs and the fx_compile CLI ride in the target's
runfiles, so a rig run needs only the device WebSocket (and a device key for a
per-device profile):

  bazel run //pi/hitl/harness:fx_bench -- \
    --device-ws wss://<dut-ip>:443/ws \
    --soc esp32c6 --device-key <mac> --out /tmp/device-bundle.json [--bundle <flash.tar>]

Override --benchmarks-dir / --fx-compile to point at a custom set.

Offline (rebuild a bundle from a recorded session, no rig):
  bazel run //pi/hitl/harness:fx_bench -- --replay session.json --out bundle.json
"""

from __future__ import annotations

import argparse
import asyncio
import glob
import json
import os
import ssl
import subprocess
import sys
import time
from typing import Any

from fx_bench_core import assemble_bundle, cpu_hz_of, sample_from


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# The calibration `.fx` programs and the fx_compile CLI are data deps of the
# fx_bench target, so `bazel run` ships them in runfiles — no workspace-relative
# path needed. These resolve the defaults so a rig run is just `--device-ws`.
_FXC_RUNFILE = "_main/fx_compiler/fx_compile"
_BENCH_RUNFILE = "_main/pi/hitl/harness/benchmarks/empty.fx"


def _rlocation(rloc: str) -> str | None:
    try:
        from python.runfiles import runfiles

        path = runfiles.Create().Rlocation(rloc)
    except Exception:
        return None
    return path if path and os.path.exists(path) else None


def default_fx_compile() -> str:
    """The fx_compile CLI from runfiles, falling back to $PATH's `fx_compile`."""
    return _rlocation(_FXC_RUNFILE) or "fx_compile"


def default_benchmarks_dir() -> str | None:
    """The bundled calibration `.fx` directory from runfiles, if present."""
    empty = _rlocation(_BENCH_RUNFILE)
    return os.path.dirname(empty) if empty else None


def compile_fx(fx_compile: str, src_path: str) -> bytes:
    """Compile a `.fx` source file to `.fxb` bytes via the fx_compile CLI."""
    out = src_path + ".fxb"
    subprocess.run([fx_compile, src_path, out], check=True)
    with open(out, "rb") as f:
        return f.read()


def discover_benchmarks(bench_dir: str) -> tuple[list[str], list[str]]:
    """Split a benchmark directory into (fit, held-out) `.fx` paths. Files named
    `*.heldout.fx` are the validation set; the rest are fit isolation programs."""
    fit, held = [], []
    for p in sorted(glob.glob(os.path.join(bench_dir, "*.fx"))):
        (held if p.endswith(".heldout.fx") else fit).append(p)
    return fit, held


async def _rpc(sock, flat: dict[str, Any], expect: str, timeout: float = 6.0) -> dict[str, Any]:
    from server import proto_wire

    await sock.send(proto_wire.encode_client(flat))
    while True:
        raw = await asyncio.wait_for(sock.recv(), timeout=timeout)
        msg = proto_wire.decode_server(raw)
        if msg.get("type") == expect:
            return msg
        # ignore unsolicited frames (e.g. status/frame_tick) until the reply.


async def measure_program(
    sock, label: str, fxb: bytes, settle_ms: int
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Submit a compiled program, enable FULL perf, settle, drain a PerfReport,
    and return (bundle sample or None if no usable window, raw report)."""
    from server import proto_wire

    await sock.send(
        proto_wire.encode_client(
            {"type": "submit_effect", "effect_id": f"__bench_{label}", "fxb": fxb, "activate": True}
        )
    )
    # set_perf(FULL) replies with an immediate perf_report; then drain a settled one.
    await _rpc(sock, {"type": "set_perf", "mode": "FULL", "interval_ms": 0}, "perf_report")
    await asyncio.sleep(settle_ms / 1000.0)
    report = await _rpc(sock, {"type": "get_perf_report"}, "perf_report")
    return sample_from(label, fxb, 0, report), report  # led_count comes from the report


async def run_on_hardware(args) -> dict[str, Any]:
    import websockets
    from hitl_client import Reservation

    fit_src, held_src = discover_benchmarks(args.benchmarks_dir)
    if not fit_src:
        raise SystemExit(f"no .fx benchmarks in {args.benchmarks_dir}")
    _log(f"benchmarks: {len(fit_src)} fit, {len(held_src)} held-out")

    ssl_ctx = ssl.create_default_context()
    if args.insecure:
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

    res = Reservation(server=args.server)
    res.acquire()
    try:
        if args.bundle:
            res.scp_to([args.bundle], "/tmp/")
            res.ssh(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --monitor --monitor-seconds 6",
                capture=True,
            )

        # The device WS is reached directly (already on the rig LAN) or via a
        # forward tunnel through the rig.
        ws_url = args.device_ws
        cpu_hz = 0
        fit_samples: list[dict[str, Any]] = []
        held_samples: list[dict[str, Any]] = []
        async with websockets.connect(ws_url, max_size=2**22, ssl=ssl_ctx, open_timeout=10) as sock:
            from server import proto_wire

            await _rpc(sock, {"type": "hello", "client": "fx_bench", "app_version": "1"}, "welcome")
            for kind, srcs, dest in (
                ("fit", fit_src, fit_samples),
                ("heldout", held_src, held_samples),
            ):
                for src in srcs:
                    label = os.path.basename(src).removesuffix(".heldout.fx").removesuffix(".fx")
                    fxb = compile_fx(args.fx_compile, src)
                    _log(f"measuring [{kind}] {label} ({len(fxb)} B)…")
                    sample, report = await measure_program(sock, label, fxb, args.settle_ms)
                    cpu_hz = cpu_hz or cpu_hz_of(report)
                    if sample is None:
                        _log(f"  skipped {label}: no perf window")
                        continue
                    dest.append(sample)
            await sock.send(
                proto_wire.encode_client({"type": "set_perf", "mode": "OFF", "interval_ms": 0})
            )

        return assemble_bundle(
            soc=args.soc,
            cpu_hz=cpu_hz or 160_000_000,
            fit=fit_samples,
            heldout=held_samples,
            device_key=args.device_key,
            device_label=args.device_label,
            firmware_build=args.firmware_build,
            timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )
    finally:
        res.release()


def run_replay(args) -> dict[str, Any]:
    """Rebuild a bundle from a recorded session JSON (no hardware): a list of
    {label, fxb_hex, kind, report} entries. Exercises the same pure mapping."""
    with open(args.replay) as f:
        session = json.load(f)
    fit, held = [], []
    cpu_hz = 0
    for entry in session.get("programs", []):
        fxb = bytes.fromhex(entry["fxb_hex"])
        report = entry["report"]
        cpu_hz = cpu_hz or cpu_hz_of(report)
        sample = sample_from(entry["label"], fxb, int(entry.get("led_count", 0)), report)
        if sample is None:
            continue
        (held if entry.get("kind") == "heldout" else fit).append(sample)
    return assemble_bundle(
        soc=session.get("soc", "esp32c6"),
        cpu_hz=cpu_hz or 160_000_000,
        fit=fit,
        heldout=held,
        device_key=session.get("device_key"),
        device_label=session.get("device_label"),
        firmware_build=session.get("firmware_build"),
        timestamp=session.get("timestamp"),
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL FX benchmark harness (FUG-11)")
    ap.add_argument("--out", required=True, help="output device-measurement bundle JSON")
    ap.add_argument("--replay", help="rebuild from a recorded session JSON (no hardware)")
    ap.add_argument(
        "--benchmarks-dir",
        default=default_benchmarks_dir(),
        help="directory of .fx programs (*.heldout.fx = validation); "
        "defaults to the bundled calibration set in runfiles",
    )
    ap.add_argument(
        "--fx-compile",
        default=default_fx_compile(),
        help="fx_compile CLI path; defaults to the one bundled in runfiles",
    )
    ap.add_argument("--device-ws", help="device player WebSocket URL (wss://ip:443/ws)")
    ap.add_argument("--server", help="pin a specific rig (else pool discovery)")
    ap.add_argument("--bundle", help="firmware flash-bundle tar to flash first")
    ap.add_argument("--soc", default="esp32c6")
    ap.add_argument("--device-key", help="stable device identity (MAC/id) for a per-device profile")
    ap.add_argument("--device-label", help="human label for the device")
    ap.add_argument("--firmware-build", help="firmware build id")
    ap.add_argument("--settle-ms", type=int, default=1200)
    ap.add_argument("--insecure", action="store_true", help="accept the device's self-signed cert")
    args = ap.parse_args()

    if args.replay:
        bundle = run_replay(args)
    else:
        if not (args.benchmarks_dir and args.device_ws):
            ap.error("hardware run needs --benchmarks-dir and --device-ws (or use --replay)")
        bundle = asyncio.run(run_on_hardware(args))

    with open(args.out, "w") as f:
        json.dump(bundle, f, indent=2)
    _log(f"wrote {args.out}: {len(bundle['fit'])} fit, {len(bundle['heldout'])} held-out samples")


if __name__ == "__main__":
    main()
