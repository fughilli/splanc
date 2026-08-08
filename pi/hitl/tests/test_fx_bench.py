"""Pure-logic tests for the HITL FX benchmark harness (FUG-11): the perf→sample
mapping and the device-measurement bundle schema, with no hardware. The bundle
shape is pinned to deviceProfile.ts `parseDeviceBundle` (fit/heldout arrays of
{label, fxbBase64, ledCount, measuredFrameCycles, measuredShowCycles})."""

import base64
import os
import tempfile

import pytest
from fx_bench_core import (
    assemble_bundle,
    bundle_to_golden,
    compare_to_golden,
    cpu_hz_of,
    intended_led_count,
    sample_from,
    stable_cycles,
)

# Traceability: PR(s) this suite verifies (see requirements/requirements.yaml).
pytestmark = pytest.mark.requirements("PR-7")


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


def test_stable_cycles_prefers_frame_window_min():
    # Frame uses the window MIN (interrupt-free frame); show uses the mean.
    report = {
        "frame_cycles_min": 4700,
        "frame_cycles_mean": 5000,
        "show_cycles_mean": 2000,
        "ticks": [{"led_count": 128, "frame_cycles": 4900, "show_cycles": 1900}],
    }
    s = stable_cycles(report)
    assert s == {"frame": 4700, "show": 2000, "led": 128}


def test_stable_cycles_frame_falls_back_to_mean_without_min():
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


# -- golden margin check ---------------------------------------------------- #


def _bundle(fit_samples, held_samples=()):
    """A minimal measured bundle from (label, frame, show) tuples."""

    def s(label, frame, show):
        return {
            "label": label,
            "fxbBase64": "",
            "ledCount": 128,
            "measuredFrameCycles": frame,
            "measuredShowCycles": show,
        }

    return {"fit": [s(*t) for t in fit_samples], "heldout": [s(*t) for t in held_samples]}


# The golden is a full device-measurement bundle + an fxBenchMargins block.
_GOLDEN = {
    "kind": "ledmapper-device-benchmark",
    "soc": "esp32c6",
    "fit": _bundle([("empty", 500_000, 1_000_000), ("big", 10_000_000, 1_000_000)])["fit"],
    "heldout": [],
    "fxBenchMargins": {"default": 0.05, "perLabel": {"empty": 0.10}},
}


def test_golden_within_margin_passes():
    # empty +8% (< its 0.10), big +4% (< default 0.05) -> ok.
    res = compare_to_golden(_bundle([("empty", 540_000, 1e6), ("big", 10_400_000, 1e6)]), _GOLDEN)
    assert res["ok"] and not res["offenders"] and not res["missing"]
    assert res["checked"] == 2


def test_golden_default_margin_offender():
    # big +7% exceeds the 0.05 default margin -> off.
    res = compare_to_golden(_bundle([("empty", 500_000, 1e6), ("big", 10_700_000, 1e6)]), _GOLDEN)
    assert not res["ok"]
    assert [o["label"] for o in res["offenders"]] == ["big"]


def test_golden_per_label_margin_is_looser_for_empty():
    # empty +8% would fail the 0.05 default but passes its own 0.10 margin.
    res = compare_to_golden(_bundle([("empty", 540_000, 1e6), ("big", 10_000_000, 1e6)]), _GOLDEN)
    assert res["ok"]


def test_golden_missing_label_fails():
    res = compare_to_golden(_bundle([("empty", 500_000, 1e6)]), _GOLDEN)
    assert not res["ok"]
    assert res["missing"] == ["big"]


def test_golden_margin_override():
    # A generous --margin override lets a +7% big through (per-label margins still
    # apply, but big has none so it uses the override).
    res = compare_to_golden(
        _bundle([("empty", 500_000, 1e6), ("big", 10_700_000, 1e6)]), _GOLDEN, margin=0.10
    )
    assert res["ok"]


def test_bundle_to_golden_roundtrips():
    bundle = assemble_bundle(
        soc="esp32c6",
        cpu_hz=160_000_000,
        fit=[sample_from("empty", b"\x00", 128, {"frame_cycles_mean": 5, "ticks": [{}]})],
        heldout=[],
    )
    golden = bundle_to_golden(bundle, default_margin=0.05, per_label_margin={"empty": 0.10})
    # The golden IS the bundle (fxbBase64 kept for the web estimator) + margins.
    assert golden["kind"] == "ledmapper-device-benchmark"
    assert golden["fxBenchMargins"] == {"default": 0.05, "perLabel": {"empty": 0.10}}
    assert golden["fit"][0]["fxbBase64"] == bundle["fit"][0]["fxbBase64"]
    # A bundle round-trips through its own golden with room to spare.
    assert compare_to_golden(bundle, golden)["ok"]


def test_assemble_bundle_omits_absent_optionals():
    bundle = assemble_bundle(soc="esp32c6", cpu_hz=160_000_000, fit=[], heldout=[])
    assert "deviceKey" not in bundle
    assert "firmwareBuild" not in bundle
