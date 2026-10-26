"""Pure logic for the HITL FX benchmark (FUG-11): turn per-benchmark device
PerfReports into a device-measurement bundle that the web builder
(web/src/effects/deviceProfile.ts `buildDeviceProfile`) fits + validates into an
authoritative `device` execution profile.

No hardware, no network — split out from fx_bench.py so the perf→sample mapping,
the fit/held-out split, and the bundle schema are unit-tested without a rig (the
orchestrator supplies real PerfReports; the replay path supplies recorded ones).
The bundle JSON shape MUST match parseDeviceBundle in deviceProfile.ts.
"""

from __future__ import annotations

import base64
from typing import Any

# The calibration `.fx` sources carry their intended strip length in a header
# comment ("// Intended LED count: N."), generated from calibrationBenchmarks.ts.
# Parsing it drives set_led_count so the on-hardware per-LED / transmit sweep
# matches the browser calibration (the shade loop runs once per LED, so the fit
# can only separate fixed overhead from per-LED cost if the strip length varies).
_LED_HINT = "Intended LED count:"


def intended_led_count(src_path: str, default: int = 0) -> int:
    """The benchmark's intended strip length from its header comment, or default."""
    try:
        with open(src_path) as f:
            head = f.read(2048)
    except OSError:
        return default
    idx = head.find(_LED_HINT)
    if idx < 0:
        return default
    num = ""
    for ch in head[idx + len(_LED_HINT) :].strip():
        if ch.isdigit():
            num += ch
        else:
            break
    return int(num) if num else default


def _field(d: dict[str, Any], *names: str) -> int:
    """First present, nonzero int among `names`. proto_wire.decode_server emits
    camelCase JSON names (frameCyclesMean, frameCycles, cpuHz), but recorded/
    hand-authored replay sessions may use the proto snake_case names — accept
    both so the on-hardware path and the replay/tests agree."""
    for n in names:
        v = d.get(n)
        if v:
            return int(v)
    return 0


def stable_cycles(report: dict[str, Any]) -> dict[str, int] | None:
    """Extract a stable (frame, show, led) cycle sample from a PerfReport flat
    dict (proto_wire.decode_server output; proto3 omits zero fields). Uses the
    window MINIMUM for frame cycles, not the mean: the VM is deterministic, so
    interrupts (WiFi/BLE coexistence, the TLS task, timers on the single-core C6)
    only ADD cycles — the min frame is the interrupt-free one, i.e. the true
    compute cost, with far lower variance (a single ~0.2 ms IRQ was +32% on the
    tiny sweep16 mean — the flake this fixes). show/update report only a mean, so
    those keep it. Falls back to mean, then the newest tick. Mirrors the browser
    calibration's stableCycles(). Returns None if the report looks empty."""
    ticks = report.get("ticks") or []
    last = ticks[-1] if ticks else {}
    led = _field(last, "ledCount", "led_count")
    frame_min = _field(report, "frameCyclesMin", "frame_cycles_min")
    frame_mean = _field(report, "frameCyclesMean", "frame_cycles_mean")
    show_mean = _field(report, "showCyclesMean", "show_cycles_mean")
    last_frame = _field(last, "frameCycles", "frame_cycles")
    last_show = _field(last, "showCycles", "show_cycles")
    if frame_mean == 0 and last_frame == 0:
        return None
    # frame_cycles_min == u32::MAX means the window caught no frames — ignore it.
    frame_min = frame_min if 0 < frame_min < 0xFFFFFFFF else 0
    return {
        "frame": frame_min or frame_mean or last_frame,
        "show": show_mean or last_show,
        "led": led,
    }


def sample_from(
    label: str, fxb: bytes, led_count: int, report: dict[str, Any]
) -> dict[str, Any] | None:
    """Build one bundle sample from a benchmark's compiled `.fxb` + its
    PerfReport. Returns None if the report had no usable window."""
    stable = stable_cycles(report)
    if stable is None:
        return None
    led = stable["led"] or led_count
    return {
        "label": label,
        "fxbBase64": base64.b64encode(fxb).decode("ascii"),
        "ledCount": led,
        "measuredFrameCycles": stable["frame"],
        "measuredShowCycles": stable["show"],
    }


def cpu_hz_of(report: dict[str, Any], default: int = 160_000_000) -> int:
    hz = _field(report, "cpuHz", "cpu_hz")
    return hz if hz > 0 else default


# Absolute floor of the frame-cycle gate: an effect also passes when its frame is
# within this many cycles of the golden, whatever the percentage. Every frame pays
# a FIXED frame-start cost (flash-cache misses on the update/shade entry path after
# the netstack, BLE and log code have evicted it between frames), and that cost
# moves with code LAYOUT alone. Measured on c6-123170 (#371, fx_bench window-min):
# never-called padding moved sweep16 by +13..+18% (27.3 K -> 30.9..32.2 K) and the
# 128-LED `empty` by a similar absolute amount; the frame-start miss cost was
# ~2.7 K cycles on main and ~7.4 K on #371, and an untimed warm-up shade removed
# most of it. #382 (lazy rx/OTA buffers) moved sweep16 by +5.8..+6.5 K again.
# 8,000 cycles covers that ~7-8 K layout band and is 50 us at 160 MHz (under 1% of
# a 120 fps frame). Against the 10% default margin it only matters for goldens
# under 80 K cycles (today just sweep16, ~34.5 K); any effect of real size is
# still held to its percentage margin.
DEFAULT_FLOOR_CYCLES = 8_000


def frame_gate_rule(measured: int, golden: int, margin: float, floor_cycles: int) -> str | None:
    """Which rule lets a measured frame through against its golden: "margin" when
    it is within +-margin (relative), else "floor" when it is within +-floor_cycles
    (absolute), else None (an offender). The margin rule is checked first, so
    "floor" means the effect passed ONLY because of the absolute floor."""
    if golden <= 0:
        return None
    if abs(measured / golden - 1.0) <= margin:
        return "margin"
    if abs(measured - golden) <= floor_cycles:
        return "floor"
    return None


def bundle_to_golden(
    bundle: dict[str, Any],
    *,
    default_margin: float = 0.05,
    per_label_margin: dict[str, float] | None = None,
    floor_cycles: int = DEFAULT_FLOOR_CYCLES,
) -> dict[str, Any]:
    """Turn a measured bundle into the unified golden = the full device-measurement
    bundle (kept verbatim, incl. each sample's fxbBase64 so the web estimator can
    fit + validate on it) plus an `fxBenchMargins` block the HITL frame-cycle check
    reads. `per_label_margin` stamps a looser margin on specific labels (the tiny
    empty/sweep programs). For `fx_bench --emit-golden`."""
    golden = dict(bundle)
    golden["fxBenchMargins"] = {
        "default": default_margin,
        "perLabel": dict(per_label_margin or {}),
        "floorCycles": int(floor_cycles),
    }
    return golden


def compare_to_golden(
    bundle: dict[str, Any],
    golden: dict[str, Any],
    margin: float | None = None,
    floor_cycles: int | None = None,
) -> dict[str, Any]:
    """Compare a measured bundle's per-effect FRAME cycles to the golden bundle.
    Frame cycles are the FX-VM execution cost the device profile is fit from; show
    cycles (the transmit path) are noisier and NOT gated. The golden is a full
    device-measurement bundle; margins come from its `fxBenchMargins` block
    (per-label override, else the `margin` arg, else its `default`, else 5%).

    An effect passes if its frame is within its relative margin OR within an
    absolute floor of `floorCycles` of the golden (the `floor_cycles` arg, else
    the golden's `floorCycles`, else DEFAULT_FLOOR_CYCLES); see
    DEFAULT_FLOOR_CYCLES for why. Returns {ok, checked, missing, offenders:[{label,
    measured, golden, ratio, margin, floor}], passes:[{... rule}], byRule:{margin,
    floor}, defaultMargin, floorCycles}."""
    margins = golden.get("fxBenchMargins", {}) or {}
    default_margin = margin if margin is not None else float(margins.get("default", 0.05))
    per_label = margins.get("perLabel", {}) or {}
    floor = int(
        floor_cycles
        if floor_cycles is not None
        else margins.get("floorCycles", DEFAULT_FLOOR_CYCLES)
    )
    gmap = {s["label"]: s for s in (golden.get("fit") or []) + (golden.get("heldout") or [])}
    measured = {s["label"]: s for s in (bundle.get("fit") or []) + (bundle.get("heldout") or [])}
    offenders: list[dict[str, Any]] = []
    passes: list[dict[str, Any]] = []
    missing: list[str] = []
    by_rule = {"margin": 0, "floor": 0}
    checked = 0
    for label, g in gmap.items():
        gv = int(g.get("measuredFrameCycles", 0))
        if gv <= 0:
            continue
        m = measured.get(label)
        if m is None:
            missing.append(label)
            continue
        mv = int(m.get("measuredFrameCycles", 0))
        eff = float(per_label.get(label, default_margin))
        checked += 1
        row = {
            "label": label,
            "measured": mv,
            "golden": gv,
            "ratio": mv / gv,
            "margin": eff,
            "floor": floor,
        }
        rule = frame_gate_rule(mv, gv, eff, floor)
        if rule is None:
            offenders.append(row)
        else:
            by_rule[rule] += 1
            passes.append({**row, "rule": rule})
    return {
        "ok": not offenders and not missing,
        "checked": checked,
        "missing": sorted(missing),
        "offenders": offenders,
        "passes": passes,
        "byRule": by_rule,
        "defaultMargin": default_margin,
        "floorCycles": floor,
    }


def golden_report_lines(golden_path: str, result: dict[str, Any]) -> list[str]:
    """The fx_bench gate's log lines for a compare_to_golden result. Parsed by the Grafana fx_bench ingest
    (pi/hitl/observability/fxbench/ingest_fx_bench.py): keep the `[golden] <path>:
    checked N effect(s)` header and the `OFF <label> frame=M vs golden G (+P%,
    margin ±M%)` prefix stable. Effects that passed only through the absolute floor
    get a `FLOOR` line (never `OFF`, no `show=`, so neither ingest regex matches)."""
    floor = result["floorCycles"]
    lines = [
        f"[golden] {golden_path}: checked {result['checked']} effect(s), "
        f"default margin ±{result['defaultMargin'] * 100:g}%, floor ±{floor} cycles"
    ]
    for p in result["passes"]:
        if p["rule"] == "floor":
            lines.append(
                f"  FLOOR {p['label']:<14} frame={p['measured']} vs golden {p['golden']} "
                f"({(p['ratio'] - 1) * 100:+.1f}%, margin ±{p['margin'] * 100:g}%) "
                f"passed by floor: {p['measured'] - p['golden']:+d} cycles within ±{floor}"
            )
    for o in result["offenders"]:
        lines.append(
            f"  OFF  {o['label']:<14} frame={o['measured']} vs golden {o['golden']} "
            f"({(o['ratio'] - 1) * 100:+.1f}%, margin ±{o['margin'] * 100:g}%) "
            f"{o['measured'] - o['golden']:+d} cycles, outside floor ±{floor}"
        )
    if result["missing"]:
        lines.append(f"  MISSING (not measured this run): {', '.join(result['missing'])}")
    by_rule = result["byRule"]
    if result["ok"]:
        lines.append(
            "PASS: profiling run matches the golden "
            f"({by_rule['margin']} by margin, {by_rule['floor']} by floor)"
        )
    return lines


def assemble_bundle(
    *,
    soc: str,
    cpu_hz: int,
    fit: list[dict[str, Any]],
    heldout: list[dict[str, Any]],
    device_key: str | None = None,
    device_label: str | None = None,
    firmware_build: str | None = None,
    timestamp: str | None = None,
    run_health: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble the device-measurement bundle (schema: deviceProfile.ts
    parseDeviceBundle). `fit` are the isolation benchmarks; `heldout` are the
    validation programs the fit never sees. `run_health` (FUG-137) is an optional
    reliability record of the sweep — mid-run watchdog reboots, re-provisions, IP
    changes, whether the run aborted incomplete — stamped so a flaky run is a
    first-class, inspectable signal rather than a silently short bundle;
    parseDeviceBundle ignores the extra key."""
    bundle: dict[str, Any] = {
        "kind": "ledmapper-device-benchmark",
        "version": 1,
        "soc": soc,
        "cpuHz": cpu_hz,
        "fit": fit,
        "heldout": heldout,
    }
    if device_key:
        bundle["deviceKey"] = device_key
    if device_label:
        bundle["deviceLabel"] = device_label
    if firmware_build:
        bundle["firmwareBuild"] = firmware_build
    if timestamp:
        bundle["timestamp"] = timestamp
    if run_health:
        bundle["runHealth"] = run_health
    return bundle


def run_health_failure(run_health: dict[str, Any] | None, fail_on_reboot: bool) -> str | None:
    """Decide whether a run's reliability record should FAIL the run, returning a
    human-readable reason or None (FUG-137). Two levels:

    * An `aborted` run ALWAYS fails: the DUT went unreachable mid-sweep, so the
      bundle is incomplete — writing a short bundle and passing is exactly how a
      real regression used to hide in the flake. Fail loudly regardless of flags.
    * A run that dropped the socket but *recovered* (a watchdog reboot we
      reconnected/re-provisioned through) fails only under `fail_on_reboot`, the
      strict regression-gate mode: the bundle is complete, but the reboot itself
      is worth surfacing as a signal.
    """
    if not run_health:
        return None
    if run_health.get("aborted"):
        return "the DUT went unreachable mid-sweep — the bundle is incomplete"
    if fail_on_reboot and run_health.get("drops"):
        hit = ", ".join(run_health.get("rebootPrograms") or []) or "unknown program(s)"
        return f"{run_health['drops']} mid-sweep DUT socket drop(s) during {hit}"
    return None
