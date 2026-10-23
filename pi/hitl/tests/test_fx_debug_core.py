"""The FX debugger HITL gate's pure logic (fx_debug_core): chunk reassembly, the
byte/locals diffs, and the verdict taxonomy — infra is SKIP, any mismatch or a
pause that doesn't lapse is FAIL."""

import base64
import struct

import pytest
from fx_debug_core import (
    FAIL,
    PASS,
    SKIP,
    EffectResult,
    ResumeCheck,
    diff_bytes,
    locals_from_device,
    locals_from_host,
    reassemble,
    result_line,
    run_status,
    same_f32_bits,
    to_f32,
    verdict,
)


def chunk(data: bytes, off: int, total: int) -> dict:
    return {"offset": off, "totalLen": total, "data": base64.b64encode(data).decode()}


def test_reassemble_tiles_windows_in_any_order():
    blob = bytes(range(250)) * 3
    parts = [chunk(blob[o : o + 100], o, len(blob)) for o in range(0, len(blob), 100)]
    assert reassemble(list(reversed(parts))) == blob
    with pytest.raises(ValueError):
        reassemble(parts[:2] + parts[3:])  # a gap
    with pytest.raises(ValueError):
        reassemble(parts[:-1])  # short of total_len
    # proto3 JSON omits offset 0 / an empty data field.
    assert reassemble([{"totalLen": 0}]) == b""


def test_diff_bytes_reports_records():
    a = bytes([1, 2, 3, 4, 5, 6, 7, 8, 9])
    b = bytes([1, 2, 3, 4, 0, 6, 7, 8, 9])
    assert diff_bytes(a, b, 3) == [1]
    assert diff_bytes(a, a[:6], 3) == [2]
    assert diff_bytes(a, a) == []


def test_locals_round_trip_and_nan():
    host = bytes([9, 9, 9]) + struct.pack("<3f", 1.5, -0.25, float("nan"))
    assert locals_from_host(host)[:2] == [
        struct.unpack("<I", struct.pack("<f", 1.5))[0],
        struct.unpack("<I", struct.pack("<f", -0.25))[0],
    ]
    dev = locals_from_device([1.5, -0.25, "NaN"])
    hl = locals_from_host(host)
    assert all(same_f32_bits(a, b) for a, b in zip(dev, hl))
    assert not same_f32_bits(dev[0], dev[1])


def test_to_f32_matches_the_device_arithmetic():
    assert to_f32(0.1) != 0.1
    assert to_f32(to_f32(0.1)) == to_f32(0.1)
    assert to_f32(1.0 + 0.5) == 1.5
    # The JSON wire prints an f32 as its shortest decimal; rounding it back to
    # f32 gives the exact value (what the gate's exact-step check relies on).
    t = to_f32(2.0440003871917725)
    assert float("2.0440004") != t and to_f32(float("2.0440004")) == t


def test_verdict_taxonomy():
    ok = EffectResult("a", leds=32, jit_blocks=2)
    bad = EffectResult("b", leds=32, output_mismatch=[4, 7])
    infra = EffectResult("c", error="timeout")
    res_ok = [
        ResumeCheck("timeout", True, "timeout", True),
        ResumeCheck("disconnect", True, "disconnect", True),
    ]

    assert verdict(False, [], [])[0] == SKIP
    assert verdict(True, [infra], res_ok)[0] == SKIP
    st, reasons = verdict(True, [ok, infra], res_ok)
    assert st == PASS and reasons == ["a: bit-exact (32 LEDs, jit_blocks=2)"]
    st, reasons = verdict(True, [ok, bad], res_ok)
    assert st == FAIL and "first 4" in reasons[0]
    assert run_status(st) == 1 and run_status(SKIP) == 0 and run_status(PASS) == 0

    # A pause that never lapsed fails; a probe that couldn't run doesn't.
    stuck = [ResumeCheck("disconnect", False, "", None)]
    assert verdict(True, [ok], stuck)[0] == FAIL
    assert verdict(True, [ok], [ResumeCheck("disconnect", None)])[0] == PASS
    wrong_reason = [ResumeCheck("timeout", True, "disconnect", True)]
    assert verdict(True, [ok], wrong_reason)[0] == FAIL
    frozen = [ResumeCheck("timeout", True, "timeout", False)]
    assert verdict(True, [ok], frozen)[0] == FAIL

    line = result_line(PASS, [ok, infra], res_ok)
    assert line == "RESULT fx_debug verdict=PASS bit_exact=1/1 auto_resume=timeout=ok,disconnect=ok"


def test_effect_result_flags_every_kind_of_divergence():
    for kw in (
        {"state_mismatch": [3]},
        {"arena_mismatch": 2},
        {"locals_mismatch": [0]},
        {"jit_disagrees": True},
        {"step_time_ok": False},
    ):
        r = EffectResult("x", **kw)
        assert not r.ok(), kw
        assert r.summary().startswith("x: ")
