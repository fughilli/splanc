"""HITL FX benchmark harness (FUG-11): measure the effects VM on the REAL C6 and
emit a device-measurement bundle that the web builder fits + validates into an
authoritative execution-cost profile.

Kevin's point: the host VM has too much compute to predict the C6 — the
authoritative measurement must come from the actual hardware. This is fully
self-contained: it reaches the board the same proven way the e2e does (reserve →
flash → ImprovBLE-provision → tunnel), so from a checkout it is ONE command:

  1. reserve a free rig from the pool (hitl_client.Reservation),
  2. flash the firmware flash-bundle with a clean FS (default: the one in runfiles),
  3. ImprovBLE-provision the DUT onto the rig's own AP (provision.provision_dut),
  4. forward-tunnel to the DUT's player WebSocket via the rig (the DUT is on the
     rig's WiFi LAN, not this host's network),
  5. for each calibration micro-program: compile it (fx_compile), set the strip
     length (set_led_count, from the program's Intended-LED-count header — the
     per-LED / transmit sweep), submit_effect, set_perf(FULL), drain a settled
     PerfReport,
  6. write a device-measurement bundle (fx_bench_core.assemble_bundle) — base64
     `.fxb` + cycle-accurate measured cycles per program.

The bundle is then fed to web/src/effects/deviceProfile.ts `buildDeviceProfile`
(via the app's "Import measurement bundle" action, or tools/fx_profile_fit.py),
which reuses the calibration fit and VALIDATES it on the held-out programs,
stamping measuredError.

Requires a reachable rig + a board wired to it, so it is `bazel run`, never
`bazel test`. The pure logic (perf→sample, bundle schema, LED-hint parse) lives
in fx_bench_core.py / this module and IS unit-tested (//pi/hitl/tests). A --replay
path rebuilds a bundle from a recorded session with no hardware.

The calibration `.fx` programs, the fx_compile CLI, the `hitl` CLI, and the
firmware flash-bundle all ride in runfiles, so a real run is just:

  bazel run //pi/hitl/harness:fx_bench -- \
    --device-key <mac> --device-label "C6 #1" --out /tmp/device-bundle.json

Useful overrides: --no-bundle (measure what's already flashed), --device-ws
wss://<ip>/ws (skip the rig, device already reachable), --wifi-ssid/--wifi-pass
(a real AP instead of the rig's), --ws-scheme wss, --benchmarks-dir.

Offline (rebuild a bundle from a recorded session, no rig):
  bazel run //pi/hitl/harness:fx_bench -- --replay session.json --out bundle.json
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import glob
import json
import os
import ssl
import subprocess
import sys
import tempfile
import time
from typing import Any

from fx_bench_core import (
    assemble_bundle,
    bundle_to_golden,
    compare_to_golden,
    cpu_hz_of,
    intended_led_count,
    sample_from,
)


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# The calibration `.fx` programs and the fx_compile CLI are data deps of the
# fx_bench target, so `bazel run` ships them in runfiles — no workspace-relative
# path needed. These resolve the defaults so a rig run is just `--device-ws`.
_FXC_RUNFILE = "_main/fx_compiler/fx_compile"
_BENCH_RUNFILE = "_main/pi/hitl/harness/benchmarks/empty.fx"
_BUNDLE_RUNFILE = "_main/firmware/player_app/esp32c6_flashbundle.tar"
# The unified golden — a full device-measurement bundle + fxBenchMargins, shared
# with the web estimator test (web/tests/testdata/device-bench-<soc>.json). One
# per SoC; regenerate with `fx_bench --emit-golden <that path>`.
_GOLDEN_RUNFILE = "_main/web/tests/testdata/device-bench-{soc}.json"
# Blanket 10% default margin for now — a deliberately safe band until we do a
# comprehensive run-to-run variance measurement per effect and tighten it back
# down (sweep256, e.g., swung +6.1% in CI under the old 5%). sweep16 keeps its
# even-looser 15%: the tiniest programs have higher RELATIVE measurement noise
# (a fixed absolute jitter is a big % of a ~100 K-cycle program).
_GOLDEN_PER_LABEL_MARGIN = {"sweep16": 0.15}
_GOLDEN_DEFAULT_MARGIN = 0.10


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


def default_flashbundle() -> str | None:
    """The firmware flash-bundle tar from runfiles, if present (so a run is one
    command); --bundle overrides it and --no-bundle skips flashing."""
    return _rlocation(_BUNDLE_RUNFILE)


def default_golden(soc: str) -> str | None:
    """The committed golden reference for this SoC from runfiles, if present."""
    return _rlocation(_GOLDEN_RUNFILE.format(soc=soc))


def resolve_out(explicit: str | None) -> str:
    """Where to write the bundle. An explicit --out goes to the user's path; with
    none, dump into the test sandbox ($TEST_UNDECLARED_OUTPUTS_DIR under `bazel
    test`, so it's captured as a test output) or a tempdir."""
    if explicit:
        return explicit
    outdir = os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR") or tempfile.gettempdir()
    return os.path.join(outdir, "fx_bench_bundle.json")


def compile_fx(fx_compile: str, src_path: str) -> bytes:
    """Compile a `.fx` source file to `.fxb` bytes via the fx_compile CLI. Writes
    the artifact to a temp file (not next to the source — the benchmarks ride in
    read-only-ish runfiles and we don't want to litter the tree)."""
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


def _linear_map(n: int) -> dict[str, Any]:
    """A synthetic linear fixture map of `n` LEDs (x spread 0..1, y=z=0). The
    firmware's shade loop iterates over the MAP (lm_map_len), reading each LED's
    stored position — a fresh --erase-fs board has none, so nothing renders and
    perf stays empty. A real user device already has a map; the bench must supply
    one. `led.pos.x` is what the calibration shaders read."""
    denom = max(1, n - 1)
    leds = [{"id": i, "xyz": [i / denom, 0.0, 0.0]} for i in range(n)]
    return {"type": "submit_map", "map": {"map_id": "__bench", "led_count": n, "leds": leds}}


async def measure_program(
    sock, label: str, fxb: bytes, led_count: int, settle_ms: int, debug: bool = False
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Load a map + strip length, submit a compiled program, enable FULL perf,
    settle, drain a PerfReport, and return (bundle sample or None if no usable
    window, raw report). The per-program `led_count` (from the benchmark's
    Intended-LED-count header) drives the per-LED / transmit sweep the same way
    the browser calibration does — the shade loop runs once per mapped LED, so the
    fit can only separate fixed overhead from per-LED cost if the count varies."""
    if led_count > 0:
        # Submit a fixture map of led_count LEDs (the shade loop's iteration
        # domain), then persist the matching strip length (the show path).
        await _rpc(sock, _linear_map(led_count), "result_ready", timeout=8.0)
        await _rpc(sock, {"type": "set_led_count", "led_count": led_count}, "led_count_state")
    # submit_effect validates + persists the .fxb and replies result_ready; wait
    # for it so the effect is actually loaded before we start timing it.
    await _rpc(
        sock,
        {
            "type": "submit_effect",
            "effect_id": f"__bench_{label}",
            # proto_wire encodes via protobuf json_format, which expects a `bytes`
            # field as a base64 string (not raw bytes).
            "fxb": base64.b64encode(fxb).decode("ascii"),
            "activate": True,
        },
        "result_ready",
    )
    # FULL perf, POLL-ONLY (interval_ms=0): with no periodic push draining the
    # tick ring, get_perf_report returns a settled window with the rolling means
    # populated (a single tick is noisy — a stray WiFi IRQ skews one frame). The
    # set_perf reply is an immediate perf_report; then settle and drain the window.
    await _rpc(sock, {"type": "set_perf", "mode": "FULL", "interval_ms": 0}, "perf_report")
    await asyncio.sleep(settle_ms / 1000.0)
    report = await _rpc(sock, {"type": "get_perf_report"}, "perf_report")
    if debug:
        keys = ("frameCyclesMean", "updateCyclesMean", "showCyclesMean", "cpuHz")
        summ = {k: report.get(k) for k in keys}
        summ["ticks"] = len(report.get("ticks") or [])
        summ["last_tick"] = (report.get("ticks") or [{}])[-1]
        _log(f"  [debug] report: {summ}")
    # Fall back to the requested count if the report omits it (proto3 drops zeros).
    return sample_from(label, fxb, led_count, report), report


class WsUnavailable(RuntimeError):
    """The player socket did not come up within the settle window."""


async def _open_ws(ws_url: str, args, settle_deadline: float):
    """Open the player socket + say hello, retrying until settle_deadline. A
    freshly-provisioned (or just-rebooted) board is still settling its servers
    (soft-AP teardown, wss cert re-sign, listener rebind on GOT_IP)."""
    import websockets

    ssl_ctx = None
    if ws_url.startswith("wss:"):
        ssl_ctx = ssl.create_default_context()
        if not args.ws_verify:  # the device presents a self-signed cert (default)
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE
    while True:
        try:
            sock = await websockets.connect(ws_url, max_size=2**22, ssl=ssl_ctx, open_timeout=8)
            await _rpc(sock, {"type": "hello", "client": "fx_bench", "app_version": "1"}, "welcome")
            return sock
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= settle_deadline:
                raise WsUnavailable(f"ws never came up at {ws_url}: {type(e).__name__}: {e}")
            _log(f"[ws] not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)


async def _measure(ws_url: str, fit_src, held_src, args) -> tuple[list, list, int]:
    """Drive the calibration programs over the player WebSocket; return
    (fit_samples, held_samples, cpu_hz). Resilient to the DUT dropping the socket
    mid-sweep (a heavy program under FULL perf can trip the watchdog and reboot):
    each program is retried on a fresh connection a bounded number of times, and a
    persistently-failing program is skipped rather than sinking the whole run."""
    import websockets

    _log(f"[ws] connecting {ws_url}")
    try:
        # 60s: a cold --erase-fs flash + LAN-cert reissue can be slow to bring
        # up the socket. Slack only — a warm DUT answers on the first attempt.
        sock = await _open_ws(ws_url, args, time.monotonic() + 60.0)
    except WsUnavailable as e:
        raise SystemExit(str(e))  # nothing measured yet — a hard failure

    # Measure the lightest programs first (empty / sweeps / single-op) so the fit's
    # fixed-overhead + per-LED anchors land even if a heavy program later wedges
    # the board.
    def order(src: str) -> int:
        return len(compile_fx(args.fx_compile, src))

    cpu_hz = 0
    fit_samples: list[dict[str, Any]] = []
    held_samples: list[dict[str, Any]] = []
    drops = 0
    aborted = False
    for kind, srcs, dest in (
        ("fit", sorted(fit_src, key=order), fit_samples),
        ("heldout", held_src, held_samples),
    ):
        if aborted:
            break
        for src in srcs:
            label = os.path.basename(src).removesuffix(".heldout.fx").removesuffix(".fx")
            fxb = compile_fx(args.fx_compile, src)
            leds = intended_led_count(src)
            _log(f"measuring [{kind}] {label} ({len(fxb)} B) @ {leds or '?'} LEDs…")
            for attempt in range(1, 4):
                try:
                    sample, report = await measure_program(
                        sock, label, fxb, leds, args.settle_ms, args.debug
                    )
                    cpu_hz = cpu_hz or cpu_hz_of(report)
                    if sample is None:
                        _log(f"  skipped {label}: no perf window")
                    else:
                        _log(
                            f"  {label}: frame={sample['measuredFrameCycles']} "
                            f"show={sample['measuredShowCycles']} @ {sample['ledCount']} LEDs"
                        )
                        dest.append(sample)
                    break
                except (
                    websockets.exceptions.ConnectionClosed,
                    OSError,
                    TimeoutError,
                    asyncio.IncompleteReadError,
                ) as e:
                    drops += 1
                    _log(f"  [ws] dropped during {label} ({type(e).__name__}); reconnecting…")
                    try:
                        await sock.close()
                    except OSError:
                        pass
                    # The board may be rebooting (auto-resuming the persisted
                    # effect); give it room and re-establish before retrying.
                    try:
                        sock = await _open_ws(ws_url, args, time.monotonic() + 45.0)
                    except WsUnavailable:
                        # Board isn't coming back (a program may be crash-looping
                        # via auto-resume). Keep what we measured rather than lose
                        # the whole sweep.
                        _log(f"  [ws] board unreachable after {label}; stopping with what we have")
                        aborted = True
                        break
                    if attempt == 3:
                        _log(f"  giving up on {label} after {attempt} drops")
            if aborted:
                break
    if aborted:
        return fit_samples, held_samples, cpu_hz
    try:
        from server import proto_wire

        await sock.send(
            proto_wire.encode_client({"type": "set_perf", "mode": "OFF", "interval_ms": 0})
        )
        await sock.close()
    except (OSError, websockets.exceptions.WebSocketException):
        pass
    if drops:
        _log(f"[ws] recovered from {drops} mid-sweep socket drop(s)")
    return fit_samples, held_samples, cpu_hz


def run_on_hardware(args) -> dict[str, Any]:
    """Reserve a rig, (optionally) flash + ImprovBLE-provision the DUT, tunnel to
    its player socket through the rig, and drive the calibration sweep on the real
    board. Mirrors the proven hitl_e2e path so the FX benchmark reaches the board
    the same way — the DUT lives on the rig's WiFi LAN, not this host's network."""
    from hitl_client import Reservation
    from provision import dut_target, provision_dut

    fit_src, held_src = discover_benchmarks(args.benchmarks_dir)
    if not fit_src:
        raise SystemExit(f"no .fx benchmarks in {args.benchmarks_dir}")
    _log(f"benchmarks: {len(fit_src)} fit, {len(held_src)} held-out")

    def bundle_from(fit_samples, held_samples, cpu_hz) -> dict[str, Any]:
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

    # An explicit --device-ws that's reachable from here skips the rig entirely.
    if args.device_ws:
        return bundle_from(*asyncio.run(_measure(args.device_ws, fit_src, held_src, args)))

    res = Reservation(server=args.server, owner=args.owner)
    res.acquire()
    try:
        # WiFi: default to the rig's own provisioning AP so no external net is
        # needed (the daemon serves the creds); explicit --wifi-ssid overrides.
        ssid, password = args.wifi_ssid, args.wifi_pass
        if not ssid:
            creds = res.wifi()
            if creds:
                ssid, password = creds
                _log(f"[improv] provisioning onto the rig AP {ssid!r}")

        if args.bundle:
            _log(f"[flash] {os.path.basename(args.bundle)} → {res.host}")
            res.scp_to([args.bundle], "/tmp/")
            # --erase-fs boots the DUT into a clean first-provision state (empty
            # NVS, no auto-join short-circuit) — the reliably-provisionable path.
            res.ssh(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs "
                f"--monitor --monitor-seconds {args.monitor_seconds:g}",
                capture=True,
                timeout=args.monitor_seconds + 120,
            )

        # ImprovBLE-provision the DUT onto WiFi, then tunnel to its player socket
        # via the rig (the rig shares the DUT's LAN; this host only reaches the rig).
        if not ssid:
            raise SystemExit("no WiFi: rig serves no AP; pass --wifi-ssid or --device-ws")
        redirect = provision_dut(res, ssid, password, args.improv_timeout, args.improv_attempts)
        host, port = dut_target(redirect, args.ws_scheme)
        with res.forward(host, port) as local_port:
            ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
            return bundle_from(*asyncio.run(_measure(ws_url, fit_src, held_src, args)))
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
    ap.add_argument(
        "--out",
        default=None,
        help="write the device-measurement bundle JSON here (default: the test "
        "sandbox — $TEST_UNDECLARED_OUTPUTS_DIR or a tempdir)",
    )
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
    ap.add_argument(
        "--device-ws",
        help="connect straight to a reachable player WebSocket (skip reserve/flash/provision)",
    )
    ap.add_argument("--server", help="pin a specific rig (else pool discovery)")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"), help="reservation owner id")
    ap.add_argument(
        "--bundle",
        default=default_flashbundle(),
        help="firmware flash-bundle tar to flash first (default: the one in runfiles); "
        "pass --no-bundle to measure whatever is already flashed",
    )
    ap.add_argument(
        "--no-bundle",
        dest="bundle",
        action="store_const",
        const=None,
        help="don't flash; measure the firmware already on the board",
    )
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
        "--improv-attempts",
        type=int,
        default=4,
        help="ImprovBLE provisioning attempts (WiFi join is flaky on the single-core C6)",
    )
    ap.add_argument(
        "--ws-scheme",
        choices=["ws", "wss"],
        default="ws",
        help="tunnel to the DUT's plain ws:81 (default) or TLS wss:443 player socket",
    )
    ap.add_argument("--monitor-seconds", type=float, default=8.0, help="serial capture after flash")
    ap.add_argument("--soc", default="esp32c6")
    ap.add_argument("--device-key", help="stable device identity (MAC/id) for a per-device profile")
    ap.add_argument("--device-label", help="human label for the device")
    ap.add_argument("--firmware-build", help="firmware build id")
    ap.add_argument("--settle-ms", type=int, default=1500)
    ap.add_argument(
        "--ws-verify",
        action="store_true",
        help="verify the device's TLS cert (default: accept the self-signed cert)",
    )
    ap.add_argument(
        "--golden",
        default=None,
        help="golden reference JSON for the pass/fail margin check "
        "(default: the committed goldens/fx_bench.<soc>.json in runfiles)",
    )
    ap.add_argument(
        "--margin",
        type=float,
        default=None,
        help="override the golden's default per-effect frame-cycle margin "
        "(per-label margins in the golden still win)",
    )
    ap.add_argument(
        "--no-golden-check",
        action="store_true",
        help="just measure + write the bundle; skip the golden margin check",
    )
    ap.add_argument(
        "--emit-golden",
        default=None,
        help="write a golden reference (from this run) to PATH instead of checking",
    )
    ap.add_argument("--debug", action="store_true", help="log each raw PerfReport summary")
    args = ap.parse_args()

    if args.replay:
        bundle = run_replay(args)
    else:
        if not args.benchmarks_dir:
            ap.error("no --benchmarks-dir (and none in runfiles); pass one or use --replay")
        bundle = run_on_hardware(args)

    out = resolve_out(args.out)
    with open(out, "w") as f:
        json.dump(bundle, f, indent=2)
    _log(f"wrote {out}: {len(bundle['fit'])} fit, {len(bundle['heldout'])} held-out samples")

    # Regenerate the golden from this run instead of checking against it.
    if args.emit_golden:
        golden = bundle_to_golden(
            bundle,
            default_margin=_GOLDEN_DEFAULT_MARGIN,
            per_label_margin=_GOLDEN_PER_LABEL_MARGIN,
        )
        with open(args.emit_golden, "w") as f:
            json.dump(golden, f, indent=2)
            f.write("\n")
        _log(f"wrote golden {args.emit_golden}: {len(golden['samples'])} samples")
        return

    # Pass/fail check: a profiling run on known hardware must match the golden
    # per-effect frame cycles within margin (else the FX VM / firmware perf, or
    # the run itself, regressed).
    if args.no_golden_check:
        return
    golden_path = args.golden or default_golden(args.soc)
    if not golden_path:
        _log(f"[golden] no golden for soc={args.soc!r}; skipping the margin check")
        return
    with open(golden_path) as f:
        golden = json.load(f)
    result = compare_to_golden(bundle, golden, args.margin)
    _log(
        f"[golden] {golden_path}: checked {result['checked']} effect(s), "
        f"default margin ±{result['defaultMargin'] * 100:g}%"
    )
    for o in result["offenders"]:
        _log(
            f"  OFF  {o['label']:<14} frame={o['measured']} vs golden {o['golden']} "
            f"({(o['ratio'] - 1) * 100:+.1f}%, margin ±{o['margin'] * 100:g}%)"
        )
    if result["missing"]:
        _log(f"  MISSING (not measured this run): {', '.join(result['missing'])}")
    if result["ok"]:
        _log("PASS: profiling run matches the golden within margin")
    else:
        raise SystemExit(
            f"FAIL: {len(result['offenders'])} effect(s) off-margin, "
            f"{len(result['missing'])} missing vs golden"
        )


if __name__ == "__main__":
    main()
