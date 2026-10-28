"""Pure-logic tests for the HITL FX benchmark harness (FUG-11): the perf→sample
mapping and the device-measurement bundle schema, with no hardware. The bundle
shape is pinned to deviceProfile.ts `parseDeviceBundle` (fit/heldout arrays of
{label, fxbBase64, ledCount, measuredFrameCycles, measuredShowCycles})."""

import base64
import os
import tempfile

import pytest
from fx_bench_core import (
    DEFAULT_FLOOR_CYCLES,
    assemble_bundle,
    bundle_to_golden,
    compare_to_golden,
    cpu_hz_of,
    frame_gate_rule,
    golden_report_lines,
    intended_led_count,
    run_health_failure,
    sample_from,
    stable_cycles,
)

# Traceability: PR(s) this suite verifies (see requirements/requirements.yaml).
pytestmark = pytest.mark.requirements("PR-17", "PR-27")


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


# -- absolute floor (fixed per-frame layout cost) ---------------------------- #

# The committed goldens' sweep16 values and margins (device-bench-esp32c6[-jit].json).
_SWEEP16_GOLDEN = {"interp": 34_496, "jit": 34_774}


def _sweep16_golden(build: str, extra=()):
    return {
        "fit": _bundle([("sweep16", _SWEEP16_GOLDEN[build], 0), *extra])["fit"],
        "heldout": [],
        "fxBenchMargins": {"default": 0.10, "perLabel": {"sweep16": 0.15}, "floorCycles": 8000},
    }


def test_floor_is_8000_cycles_50us_at_160mhz():
    assert DEFAULT_FLOOR_CYCLES == 8000
    assert DEFAULT_FLOOR_CYCLES / 160e6 == pytest.approx(50e-6)


def test_frame_gate_rule_prefers_margin_then_floor():
    assert frame_gate_rule(1_050, 1_000, 0.10, 8000) == "margin"
    assert frame_gate_rule(1_099, 1_000, 0.10, 0) == "margin"
    assert frame_gate_rule(1_101, 1_000, 0.10, 0) is None
    assert frame_gate_rule(40_000, 34_000, 0.15, 8000) == "floor"  # +17.6%, +6 K
    assert frame_gate_rule(42_000, 34_000, 0.15, 8000) == "floor"  # boundary inclusive
    assert frame_gate_rule(42_001, 34_000, 0.15, 8000) is None
    assert frame_gate_rule(26_000, 34_000, 0.15, 8000) == "floor"  # symmetric (faster)
    assert frame_gate_rule(25_999, 34_000, 0.15, 8000) is None
    assert frame_gate_rule(5, 0, 0.15, 8000) is None


@pytest.mark.parametrize("build", ["interp", "jit"])
@pytest.mark.parametrize("measured", [40_623, 40_800, 41_041])
def test_pr382_sweep16_layout_shift_passes_by_floor(build, measured):
    # #382 (lazy netstack rx / OTA buffers) measured sweep16 at 40,623-41,041
    # cycles: +16.8..+19.0% (failed the 15% margin 3/3) but only +5.8..+6.5 K
    # cycles, inside the 8 K layout floor.
    res = compare_to_golden(_bundle([("sweep16", measured, 0)]), _sweep16_golden(build))
    assert res["ok"], res
    assert res["byRule"] == {"margin": 0, "floor": 1}
    (p,) = res["passes"]
    assert p["rule"] == "floor" and abs(p["ratio"] - 1) > 0.15
    assert abs(measured - _SWEEP16_GOLDEN[build]) <= 8000


def test_pr382_sweep16_would_fail_without_floor():
    res = compare_to_golden(
        _bundle([("sweep16", 41_041, 0)]), _sweep16_golden("interp"), floor_cycles=0
    )
    assert not res["ok"] and [o["label"] for o in res["offenders"]] == ["sweep16"]


def test_real_regression_on_big_effect_still_fails():
    # A +20% regression on a 500-LED effect (~6 M cycles) is +1.2 M cycles:
    # 150x the floor, so the floor never rescues it.
    golden = _sweep16_golden("interp", extra=[("big500", 6_000_000, 0)])
    res = compare_to_golden(_bundle([("sweep16", 34_496, 0), ("big500", 7_200_000, 0)]), golden)
    assert not res["ok"]
    assert [o["label"] for o in res["offenders"]] == ["big500"]
    assert res["offenders"][0]["floor"] == 8000
    assert res["byRule"] == {"margin": 1, "floor": 0}


def test_sweep16_beyond_floor_still_fails():
    # sweep16 +9 K cycles (+26%): more than the layout band -> a real regression.
    res = compare_to_golden(_bundle([("sweep16", 43_500, 0)]), _sweep16_golden("interp"))
    assert not res["ok"]


def test_floor_defaults_when_golden_has_none():
    # Older goldens without floorCycles get the default floor; the arg overrides.
    golden = _sweep16_golden("interp")
    del golden["fxBenchMargins"]["floorCycles"]
    assert compare_to_golden(_bundle([("sweep16", 41_041, 0)]), golden)["floorCycles"] == 8000
    res = compare_to_golden(_bundle([("sweep16", 41_041, 0)]), golden, floor_cycles=5000)
    assert not res["ok"] and res["floorCycles"] == 5000


@pytest.mark.parametrize("name", ["device-bench-esp32c6.json", "device-bench-esp32c6-jit.json"])
def test_committed_goldens_carry_the_floor(name):
    # The ACTIVE gate is the golden's fxBenchMargins: it carries the floor, and the
    # percentage margins are unchanged (10% default, sweep16 15%).
    import json

    from python.runfiles import runfiles

    path = runfiles.Create().Rlocation(f"_main/web/tests/testdata/{name}")
    with open(path) as f:
        margins = json.load(f)["fxBenchMargins"]
    assert margins == {
        "default": 0.10,
        "perLabel": {"sweep16": 0.15},
        "floorCycles": DEFAULT_FLOOR_CYCLES,
    }


def test_report_lines_name_the_rule_and_stay_ingest_parseable():
    import re

    golden = _sweep16_golden("interp", extra=[("big500", 6_000_000, 0)])
    res = compare_to_golden(_bundle([("sweep16", 41_041, 0), ("big500", 7_200_000, 0)]), golden)
    lines = golden_report_lines("web/tests/testdata/device-bench-esp32c6.json", res)
    text = "\n".join(lines)
    # Ingest regexes (pi/hitl/observability/fxbench/ingest_fx_bench.py).
    golden_re = re.compile(
        r"device-bench-(?P<soc>[a-z0-9]+)(?P<jit>-jit)?\.json: checked (?P<n>\d+) effect"
    )
    off_re = re.compile(
        r"OFF\s+(?P<label>\S+)\s+frame=(?P<measured>\d+) vs golden (?P<golden>\d+) "
        r"\(([+-][\d.]+)%, margin ±(?P<margin>[\d.]+)%\)"
    )
    meas_re = re.compile(r"(?P<label>[A-Za-z0-9_.\-]+): frame=(?P<frame>\d+) show=")
    assert golden_re.search(lines[0]).group("n") == "2"
    assert "floor ±8000 cycles" in lines[0]
    floor_line = next(ln for ln in lines if "FLOOR" in ln)
    assert "sweep16" in floor_line and "+6545 cycles within ±8000" in floor_line
    assert not off_re.search(floor_line) and not meas_re.search(floor_line)
    offs = [m.groupdict() for m in map(off_re.search, lines) if m]
    assert [(o["label"], o["measured"], o["golden"], o["margin"]) for o in offs] == [
        ("big500", "7200000", "6000000", "10")
    ]
    assert "PASS" not in text

    ok = compare_to_golden(_bundle([("sweep16", 41_041, 0), ("big500", 6_000_000, 0)]), golden)
    assert golden_report_lines("g.json", ok)[-1] == (
        "PASS: profiling run matches the golden (1 by margin, 1 by floor)"
    )


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
    assert golden["fxBenchMargins"] == {
        "default": 0.05,
        "perLabel": {"empty": 0.10},
        "floorCycles": DEFAULT_FLOOR_CYCLES,
    }
    assert golden["fit"][0]["fxbBase64"] == bundle["fit"][0]["fxbBase64"]
    # A bundle round-trips through its own golden with room to spare.
    assert compare_to_golden(bundle, golden)["ok"]


def test_assemble_bundle_omits_absent_optionals():
    bundle = assemble_bundle(soc="esp32c6", cpu_hz=160_000_000, fit=[], heldout=[])
    assert "deviceKey" not in bundle
    assert "firmwareBuild" not in bundle
    assert "runHealth" not in bundle  # a clean run (no health passed) carries no block


# -- run health (FUG-137) --------------------------------------------------- #


def _health(drops=0, aborted=False, reprovisions=0, ip_changes=0, reboot_programs=()):
    return {
        "drops": drops,
        "reconnectFailures": 0,
        "reprovisions": reprovisions,
        "ipChanges": ip_changes,
        "rebootPrograms": list(reboot_programs),
        "aborted": aborted,
    }


def test_assemble_bundle_stamps_run_health():
    health = _health(drops=2, reprovisions=1, ip_changes=1, reboot_programs=["big"])
    bundle = assemble_bundle(
        soc="esp32c6", cpu_hz=160_000_000, fit=[], heldout=[], run_health=health
    )
    assert bundle["runHealth"] == health


def test_run_health_failure_clean_run_passes():
    assert run_health_failure(None, fail_on_reboot=False) is None
    assert run_health_failure(_health(), fail_on_reboot=True) is None


def test_run_health_failure_aborted_always_fails():
    # An incomplete (aborted) run fails loudly regardless of --fail-on-reboot.
    reason = run_health_failure(_health(drops=1, aborted=True), fail_on_reboot=False)
    assert reason and "incomplete" in reason


def test_run_health_failure_recovered_reboot_only_fails_when_strict():
    # A recovered reboot passes by default (bundle is complete) but fails --strict.
    recovered = _health(drops=1, reboot_programs=["big"])
    assert run_health_failure(recovered, fail_on_reboot=False) is None
    reason = run_health_failure(recovered, fail_on_reboot=True)
    assert reason and "big" in reason
