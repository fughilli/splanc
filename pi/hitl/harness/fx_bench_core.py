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
    dict (proto_wire.decode_server output; proto3 omits zero fields). Prefers the
    rolling-window means (populated when perf is polled, interval_ms=0, so pushes
    don't drain the ring), falling back to the newest tick. Mirrors the browser
    calibration's stableCycles(). Returns None if the report looks empty."""
    ticks = report.get("ticks") or []
    last = ticks[-1] if ticks else {}
    led = _field(last, "ledCount", "led_count")
    frame_mean = _field(report, "frameCyclesMean", "frame_cycles_mean")
    show_mean = _field(report, "showCyclesMean", "show_cycles_mean")
    last_frame = _field(last, "frameCycles", "frame_cycles")
    last_show = _field(last, "showCycles", "show_cycles")
    if frame_mean == 0 and last_frame == 0:
        return None
    return {
        "frame": frame_mean or last_frame,
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


def bundle_to_golden(
    bundle: dict[str, Any],
    *,
    default_margin: float = 0.05,
    per_label_margin: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Reduce a measured bundle to a compact golden reference (per-label frame/
    show cycles + ledCount), for `fx_bench --emit-golden`. `per_label_margin`
    stamps a looser margin on specific labels (e.g. the tiny `empty` program)."""
    per_label_margin = per_label_margin or {}
    samples: dict[str, Any] = {}
    for s in (bundle.get("fit") or []) + (bundle.get("heldout") or []):
        entry: dict[str, Any] = {
            "ledCount": s["ledCount"],
            "frameCycles": s["measuredFrameCycles"],
            "showCycles": s["measuredShowCycles"],
        }
        if s["label"] in per_label_margin:
            entry["margin"] = per_label_margin[s["label"]]
        samples[s["label"]] = entry
    return {
        "kind": "ledmapper-fx-bench-golden",
        "soc": bundle.get("soc", "esp32c6"),
        "cpuHz": bundle.get("cpuHz"),
        "defaultMargin": default_margin,
        "samples": samples,
    }


def compare_to_golden(
    bundle: dict[str, Any], golden: dict[str, Any], margin: float | None = None
) -> dict[str, Any]:
    """Compare a measured bundle's per-effect FRAME cycles to a golden reference.
    Frame cycles are the FX-VM execution cost the device profile is fit from; show
    cycles (the transmit path) are noisier and NOT gated. Each label uses its
    golden `margin` if set, else the `margin` arg, else golden `defaultMargin`.
    Returns {ok, checked, missing, offenders:[{label, measured, golden, ratio,
    margin}], defaultMargin}."""
    default_margin = margin if margin is not None else float(golden.get("defaultMargin", 0.05))
    gsamples: dict[str, Any] = golden.get("samples", {})
    measured = {s["label"]: s for s in (bundle.get("fit") or []) + (bundle.get("heldout") or [])}
    offenders: list[dict[str, Any]] = []
    missing: list[str] = []
    checked = 0
    for label, g in gsamples.items():
        gv = int(g.get("frameCycles", 0))
        if gv <= 0:
            continue
        m = measured.get(label)
        if m is None:
            missing.append(label)
            continue
        mv = int(m.get("measuredFrameCycles", 0))
        eff = float(g.get("margin", default_margin))
        checked += 1
        ratio = mv / gv
        if abs(ratio - 1.0) > eff:
            offenders.append(
                {"label": label, "measured": mv, "golden": gv, "ratio": ratio, "margin": eff}
            )
    return {
        "ok": not offenders and not missing,
        "checked": checked,
        "missing": sorted(missing),
        "offenders": offenders,
        "defaultMargin": default_margin,
    }


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
) -> dict[str, Any]:
    """Assemble the device-measurement bundle (schema: deviceProfile.ts
    parseDeviceBundle). `fit` are the isolation benchmarks; `heldout` are the
    validation programs the fit never sees."""
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
    return bundle
