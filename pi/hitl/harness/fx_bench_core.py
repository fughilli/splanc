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
