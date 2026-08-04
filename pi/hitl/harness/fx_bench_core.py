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


def stable_cycles(report: dict[str, Any]) -> dict[str, int] | None:
    """Extract a stable (frame, show, led) cycle sample from a PerfReport flat
    dict (proto_wire.decode_server output; proto3 omits zero fields). Prefers the
    rolling-window means, falling back to the newest tick. Mirrors the browser
    calibration's stableCycles(). Returns None if the report looks empty."""
    ticks = report.get("ticks") or []
    last = ticks[-1] if ticks else {}
    led = int(last.get("led_count", 0) or 0)
    frame_mean = int(report.get("frame_cycles_mean", 0) or 0)
    show_mean = int(report.get("show_cycles_mean", 0) or 0)
    last_frame = int(last.get("frame_cycles", 0) or 0)
    last_show = int(last.get("show_cycles", 0) or 0)
    if frame_mean == 0 and last_frame == 0:
        return None
    return {
        "frame": frame_mean or last_frame,
        "show": show_mean or last_show,
        "led": led,
    }


def sample_from(label: str, fxb: bytes, led_count: int, report: dict[str, Any]) -> dict[str, Any] | None:
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
    hz = int(report.get("cpu_hz", 0) or 0)
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
