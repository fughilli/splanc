"""mesh_apply_at_skew's analysis (mesh_apply_at_skew_core): AP-beacon reference, agreement,
apply-skew rounds and the verdict, on the line formats mesh_ffi.rs and main.cpp print."""

from mesh_apply_at_skew_core import (
    agreement,
    ap_pairs,
    applies,
    oracle_rms_us,
    parse_log,
    rounds,
    skew_summary,
    synced_at,
    to_ap_time,
    verdict,
)


def _log(
    clock_off: int, mesh_delta: int, ppm: float, applies_at: list[tuple[int, int]]
) -> list[str]:
    """A member whose clock is AP time * (1 + ppm) + clock_off and whose mesh time is AP time
    + 1000 s + mesh_delta; it logs one AP beacon per second and apply lines at the given AP
    times (with grid index k)."""
    out = ["#> MESH ON"]
    for s in range(1, 21):
        tsf = s * 1_000_000 + 2_400
        rx = int(tsf * (1 + ppm / 1e6)) + clock_off
        mesh = tsf + 1_000_000_000 + mesh_delta
        out.append(
            f"{1_000 + s * 1_000_000} [mt] ap tsf={tsf} rx={rx} hw=1 mesh={mesh} st=synced lag=40"
        )
    for tsf, k in applies_at:
        us = int(tsf * (1 + ppm / 1e6)) + clock_off
        out.append(f"{tsf + 3_000} [mt] apply us={us} k={k} ms={us // 1000}")
    out.append(f"{25_000_000} [mt] state synced off=1 joined=1 founded=0")
    return out


def test_agreement_and_apply_skew_through_the_ap_reference():
    # b's mesh time runs 150 µs ahead of a's; c's 80 µs behind; clocks are seconds apart.
    a = parse_log(_log(5_000_000, 0, 20, [(5_500_000, 440), (9_500_000, 760)]))
    b = parse_log(_log(-3_000_000, 150, -15, [(5_502_000, 440), (9_500_400, 760)]))
    c = parse_log(_log(70_000_000, -80, 5, [(5_499_000, 440), (9_513_000, 761)]))
    pairs = {"a": ap_pairs(a), "b": ap_pairs(b), "c": ap_pairs(c)}
    ag = agreement(pairs).summary()
    assert ag["beacons"] == 20
    assert abs(ag["b"]["median_us"] - 150) <= 1 and abs(ag["c"]["median_us"] + 80) <= 1
    assert ag["max_abs_us"] <= 151
    # The oracle maps each apply back to the AP's time (drift included).
    assert abs(to_ap_time(pairs["b"], applies(b)[0].us) - 5_502_000) < 2
    rs = rounds(
        [5_000_000, 9_000_000],
        2_000_000,
        {k: applies(v) for k, v in {"a": a, "b": b, "c": c}.items()},
        pairs,
    )
    s = skew_summary(rs)
    assert s["measured"] == 2 and s["same_frame"] == 1 and s["split_frame"] == 1
    assert abs(s["skew_max_us"] - 13_000) < 5
    assert abs(rs[0].skew_us() - 3_000) < 5
    assert oracle_rms_us(pairs["a"]) < 2
    ok, why = verdict({"apply": {"skew": s}})
    assert not ok and "13.00 ms" in why[0]
    ok, _ = verdict({"apply": {"skew": skew_summary(rs[:1])}})
    assert ok
    assert synced_at(a, 0) == 25_000_000


def test_unsynced_beacons_and_missing_applies_are_not_counted():
    lines = [
        "10 [mt] ap tsf=1000000 rx=5 hw=1 mesh=5 st=unsynced lag=1",
        "20 [mt] ap tsf=2000000 rx=6 hw=1 mesh=6 st=synced lag=1",
    ]
    pa = ap_pairs(parse_log(lines))
    pb = ap_pairs(parse_log([x.replace("rx=", "rx=1").replace("mesh=", "mesh=1") for x in lines]))
    assert agreement({"a": pa, "b": pb}).n == 1
    rs = rounds([0], 1_000, {"a": [], "b": []}, {"a": pa, "b": pb})
    s = skew_summary(rs)
    assert s["missing"] == 1 and s["measured"] == 0
    assert verdict({"apply": {"skew": s}})[0] is False
