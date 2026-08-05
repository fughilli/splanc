"""Pure-logic tests for the HITL FX benchmark harness (FUG-11): the perf→sample
mapping and the device-measurement bundle schema, with no hardware. The bundle
shape is pinned to deviceProfile.ts `parseDeviceBundle` (fit/heldout arrays of
{label, fxbBase64, ledCount, measuredFrameCycles, measuredShowCycles})."""

import base64
import os
import tempfile

from fx_bench_core import (
    assemble_bundle,
    cpu_hz_of,
    intended_led_count,
    sample_from,
    stable_cycles,
)


def _write(text: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".fx")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    return path


def test_intended_led_count_parses_header():
    path = _write(
        "// FUG-11 calibration micro-program: Add x32 (isolates Add).\n"
        "// Intended LED count: 256.\n"
        "vec3 shade(Led led) { return vec3(0.0, 0.0, 0.0); }\n"
    )
    try:
        assert intended_led_count(path) == 256
    finally:
        os.unlink(path)


def test_intended_led_count_default_when_absent():
    path = _write("vec3 shade(Led led) { return vec3(0.0); }\n")
    try:
        assert intended_led_count(path) == 0
        assert intended_led_count(path, default=128) == 128
    finally:
        os.unlink(path)


def test_intended_led_count_missing_file_is_default():
    assert intended_led_count("/no/such/bench.fx", default=64) == 64


def test_stable_cycles_prefers_window_means():
    report = {
        "frame_cycles_mean": 5000,
        "show_cycles_mean": 2000,
        "ticks": [{"led_count": 128, "frame_cycles": 4900, "show_cycles": 1900}],
    }
    s = stable_cycles(report)
    assert s == {"frame": 5000, "show": 2000, "led": 128}


def test_stable_cycles_falls_back_to_last_tick():
    report = {"ticks": [{"led_count": 64, "frame_cycles": 4200, "show_cycles": 1500}]}
    s = stable_cycles(report)
    assert s == {"frame": 4200, "show": 1500, "led": 64}


def test_stable_cycles_empty_report_is_none():
    assert stable_cycles({}) is None
    assert stable_cycles({"ticks": []}) is None
    assert stable_cycles({"ticks": [{"led_count": 64}]}) is None  # no frame cycles


def test_sample_from_encodes_fxb_and_cycles():
    fxb = bytes([0x46, 0x58, 0x42, 0x31, 1, 2, 3])
    report = {
        "frame_cycles_mean": 8000,
        "show_cycles_mean": 3000,
        "ticks": [{"led_count": 256, "frame_cycles": 7900}],
    }
    s = sample_from("mul x16", fxb, 0, report)
    assert s["label"] == "mul x16"
    assert s["ledCount"] == 256  # from the report, not the 0 hint
    assert s["measuredFrameCycles"] == 8000
    assert s["measuredShowCycles"] == 3000
    assert base64.b64decode(s["fxbBase64"]) == fxb


def test_sample_from_none_when_no_window():
    assert sample_from("x", b"\x00", 128, {"ticks": []}) is None


def test_cpu_hz_default():
    assert cpu_hz_of({"cpu_hz": 240_000_000}) == 240_000_000
    assert cpu_hz_of({}) == 160_000_000


def test_assemble_bundle_schema():
    fit = [sample_from("a", b"\x01", 0, {"frame_cycles_mean": 10, "ticks": [{"led_count": 32}]})]
    held = [sample_from("h", b"\x02", 0, {"frame_cycles_mean": 20, "ticks": [{"led_count": 32}]})]
    bundle = assemble_bundle(
        soc="esp32c6",
        cpu_hz=160_000_000,
        fit=fit,
        heldout=held,
        device_key="AA:BB:CC:DD:EE:01",
        device_label="rig-01",
        firmware_build="fw1",
        timestamp="2026-08-04T00:00:00Z",
    )
    assert bundle["kind"] == "ledmapper-device-benchmark"
    assert bundle["version"] == 1
    assert bundle["soc"] == "esp32c6"
    assert bundle["cpuHz"] == 160_000_000
    assert bundle["deviceKey"] == "AA:BB:CC:DD:EE:01"
    assert len(bundle["fit"]) == 1 and len(bundle["heldout"]) == 1
    # required sample fields (match deviceProfile.ts parseDeviceBundle).
    for arr in ("fit", "heldout"):
        for s in bundle[arr]:
            assert set(s) >= {
                "label",
                "fxbBase64",
                "ledCount",
                "measuredFrameCycles",
                "measuredShowCycles",
            }


def test_assemble_bundle_omits_absent_optionals():
    bundle = assemble_bundle(soc="esp32c6", cpu_hz=160_000_000, fit=[], heldout=[])
    assert "deviceKey" not in bundle
    assert "firmwareBuild" not in bundle
